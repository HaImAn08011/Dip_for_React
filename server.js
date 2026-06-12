const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- БАЗА ДАННЫХ ----------
const dbPath = path.join(__dirname, 'data', 'database.db');
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    email TEXT UNIQUE,
    password TEXT,
    is_admin INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT, author TEXT, price REAL, img TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, date TEXT, total REAL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER, book_title TEXT, price REAL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, book_id INTEGER,
    book_title TEXT, book_author TEXT, book_price REAL,
    status TEXT DEFAULT 'active', created_at TEXT, pickup_code TEXT
  )`);

  // Админ
  db.get("SELECT * FROM users WHERE username = 'admin'", (err, row) => {
    if (!row) {
      const hashed = bcrypt.hashSync('admin123', 10);
      db.run("INSERT INTO users (username, email, password, is_admin) VALUES (?, ?, ?, ?)",
        ['admin', 'admin@localhost', hashed, 1]);
    }
  });

  // Начальные книги
  db.get("SELECT COUNT(*) as cnt FROM books", (err, row) => {
    if (row.cnt === 0) {
      const books = [
        ['Мастер и Маргарита', 'Михаил Булгаков', 850, ''],
        ['1984', 'Джордж Оруэлл', 600, ''],
        ['Ведьмак. Последнее желание', 'Анджей Сапковский', 950, ''],
        ['Три товарища', 'Эрих Мария Ремарк', 720, '']
      ];
      const stmt = db.prepare("INSERT INTO books (title, author, price, img) VALUES (?, ?, ?, ?)");
      books.forEach(b => stmt.run(b));
      stmt.finalize();
    }
  });
});

// ---------- HELPER ФУНКЦИИ ----------
function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => { if (err) reject(err); else resolve(rows); });
  });
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => { if (err) reject(err); else resolve(row); });
  });
}
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) { if (err) reject(err); else resolve(this); });
  });
}

// ---------- НАСТРОЙКИ EXPRESS ----------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  const user = await get("SELECT * FROM users WHERE id = ?", [id]);
  done(null, user);
});

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL || '/auth/google/callback'
  },
  async (accessToken, refreshToken, profile, done) => {
    const email = profile.emails[0].value;
    let user = await get("SELECT * FROM users WHERE email = ?", [email]);
    if (!user) {
      const username = profile.displayName || email.split('@')[0];
      const result = await run("INSERT INTO users (username, email, password, is_admin) VALUES (?, ?, '', 0)", [username, email]);
      user = await get("SELECT * FROM users WHERE id = ?", [result.lastID]);
    }
    done(null, user);
  }
));

// Middleware для flash и locals
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.cartCount = req.session.cart ? req.session.cart.length : 0;
  res.locals.flash = req.session.flash || [];
  delete req.session.flash;
  next();
});
function flash(req, msg) {
  if (!req.session.flash) req.session.flash = [];
  req.session.flash.push(msg);
}

// Рендер с layout
async function renderFull(res, view, data = {}) {
  const body = await new Promise((resolve, reject) => {
    app.render(view, data, (err, html) => { if (err) reject(err); else resolve(html); });
  });
  res.render('layout', { ...data, body });
}

// ---------- МАРШРУТЫ ----------
app.get('/', async (req, res) => {
  const search = req.query.search || '';
  const sort = req.query.sort || 'default';
  let sql = "SELECT * FROM books WHERE title LIKE ? OR author LIKE ?";
  let params = [`%${search}%`, `%${search}%`];
  if (sort === 'price_asc') sql += " ORDER BY price ASC";
  else if (sort === 'price_desc') sql += " ORDER BY price DESC";
  else if (sort === 'title_asc') sql += " ORDER BY title ASC";
  else sql += " ORDER BY id";
  let books = await query(sql, params);
  for (let b of books) {
    const reserved = await get("SELECT id FROM reservations WHERE book_id = ? AND status = 'active'", [b.id]);
    b.is_reserved = !!reserved;
  }
  await renderFull(res, 'index', { books, search, sort });
});

// Регистрация
app.get('/register', (req, res) => renderFull(res, 'register'));
app.post('/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) { flash(req, 'Все поля обязательны'); return res.redirect('/register'); }
  const hashed = bcrypt.hashSync(password, 10);
  try {
    await run("INSERT INTO users (username, email, password, is_admin) VALUES (?, ?, ?, 0)", [username, email, hashed]);
    flash(req, 'Регистрация успешна! Войдите.');
    res.redirect('/login');
  } catch (e) {
    flash(req, 'Пользователь уже существует');
    res.redirect('/register');
  }
});

// Логин
app.get('/login', (req, res) => renderFull(res, 'login'));
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await get("SELECT * FROM users WHERE username = ?", [username]);
  if (user && user.password && bcrypt.compareSync(password, user.password)) {
    req.session.user = { id: user.id, username: user.username, is_admin: user.is_admin === 1 };
    flash(req, `Добро пожаловать, ${user.username}!`);
    res.redirect('/');
  } else {
    flash(req, 'Неверный логин или пароль');
    res.redirect('/login');
  }
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/'); });

// Google OAuth
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', passport.authenticate('google', { failureRedirect: '/login' }), (req, res) => {
  req.session.user = { id: req.user.id, username: req.user.username, is_admin: req.user.is_admin === 1 };
  flash(req, `Добро пожаловать, ${req.user.username}!`);
  res.redirect('/');
});

// Корзина
app.get('/add_to_cart/:id', (req, res) => {
  if (!req.session.cart) req.session.cart = [];
  req.session.cart.push(parseInt(req.params.id));
  flash(req, 'Книга добавлена в корзину');
  res.redirect('back');
});
app.get('/cart', async (req, res) => {
  const cartIds = req.session.cart || [];
  const items = [];
  for (let id of cartIds) {
    const book = await get("SELECT * FROM books WHERE id = ?", [id]);
    if (book) items.push(book);
  }
  const total = items.reduce((s, i) => s + i.price, 0);
  await renderFull(res, 'cart', { items, total });
});
app.get('/cart/remove/:index', (req, res) => {
  const idx = parseInt(req.params.index);
  if (req.session.cart && idx >= 0 && idx < req.session.cart.length) {
    req.session.cart.splice(idx, 1);
    flash(req, 'Товар удалён');
  }
  res.redirect('/cart');
});

// Оформление заказа
app.post('/checkout', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.redirect('/payment');
});
app.get('/payment', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const cartIds = req.session.cart || [];
  const items = [];
  for (let id of cartIds) {
    const book = await get("SELECT * FROM books WHERE id = ?", [id]);
    if (book) items.push(book);
  }
  const total = items.reduce((s, i) => s + i.price, 0);
  await renderFull(res, 'payment', { items, total });
});
app.post('/payment', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const cartIds = req.session.cart || [];
  if (cartIds.length === 0) return res.redirect('/');
  let total = 0;
  const items = [];
  for (let id of cartIds) {
    const book = await get("SELECT * FROM books WHERE id = ?", [id]);
    if (book) { items.push(book); total += book.price; }
  }
  const date = new Date().toLocaleString('ru-RU', { hour12: false });
  const orderResult = await run("INSERT INTO orders (user_id, date, total) VALUES (?, ?, ?)", [req.session.user.id, date, total]);
  const orderId = orderResult.lastID;
  for (let item of items) {
    await run("INSERT INTO order_items (order_id, book_title, price) VALUES (?, ?, ?)", [orderId, item.title, item.price]);
  }
  req.session.cart = [];
  flash(req, 'Оплата прошла успешно (демо). Заказ оформлен!');
  res.redirect('/profile');
});

// Профиль
app.get('/profile', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const orders = await query("SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC", [req.session.user.id]);
  const history = [];
  for (let order of orders) {
    const items = await query("SELECT * FROM order_items WHERE order_id = ?", [order.id]);
    history.push({ info: order, items });
  }
  await renderFull(res, 'profile', { history });
});

// Бронирования
app.get('/reserve/:id', async (req, res) => {
  if (!req.session.user) { flash(req, 'Войдите, чтобы бронировать'); return res.redirect('/login'); }
  const bookId = parseInt(req.params.id);
  const book = await get("SELECT * FROM books WHERE id = ?", [bookId]);
  if (!book) { flash(req, 'Книга не найдена'); return res.redirect('/'); }
  const reserved = await get("SELECT id FROM reservations WHERE book_id = ? AND status = 'active'", [bookId]);
  if (reserved) { flash(req, `Книга "${book.title}" уже забронирована`); return res.redirect('/'); }
  const cntRes = await get("SELECT COUNT(*) as cnt FROM reservations WHERE user_id = ? AND status = 'active'", [req.session.user.id]);
  if (cntRes.cnt >= 3) { flash(req, 'Не более 3 броней одновременно'); return res.redirect('/'); }
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (await get("SELECT id FROM reservations WHERE pickup_code = ? AND status = 'active'", [code]));
  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  await run("INSERT INTO reservations (user_id, book_id, book_title, book_author, book_price, status, created_at, pickup_code) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)",
    [req.session.user.id, bookId, book.title, book.author, book.price, now, code]);
  flash(req, `Книга "${book.title}" забронирована! Код: ${code}`);
  res.redirect('/my-reservations');
});
app.get('/my-reservations', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  const reservations = await query("SELECT * FROM reservations WHERE user_id = ? AND status = 'active' ORDER BY created_at DESC", [req.session.user.id]);
  await renderFull(res, 'my-reservations', { reservations });
});
app.get('/cancel-reservation/:id', async (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  await run("UPDATE reservations SET status = 'cancelled' WHERE id = ? AND user_id = ? AND status = 'active'", [req.params.id, req.session.user.id]);
  flash(req, 'Бронь отменена');
  res.redirect('/my-reservations');
});

// Админка
app.get('/admin', async (req, res) => {
  if (!req.session.user || !req.session.user.is_admin) return res.status(403).send('Доступ запрещён');
  const books = await query("SELECT * FROM books ORDER BY id");
  await renderFull(res, 'admin', { books });
});
app.post('/admin', async (req, res) => {
  if (!req.session.user || !req.session.user.is_admin) return res.status(403).send('Доступ запрещён');
  const { title, author, price, img } = req.body;
  await run("INSERT INTO books (title, author, price, img) VALUES (?, ?, ?, ?)", [title, author, parseFloat(price), img || '']);
  flash(req, 'Книга добавлена');
  res.redirect('/admin');
});
app.get('/admin/delete/:id', async (req, res) => {
  if (!req.session.user || !req.session.user.is_admin) return res.status(403).send('Доступ запрещён');
  await run("DELETE FROM books WHERE id = ?", [req.params.id]);
  flash(req, 'Книга удалена');
  res.redirect('/admin');
});
app.get('/admin/reservations', async (req, res) => {
  if (!req.session.user || !req.session.user.is_admin) return res.status(403).send('Доступ запрещён');
  const reservations = await query("SELECT r.*, u.username FROM reservations r JOIN users u ON r.user_id = u.id ORDER BY r.created_at DESC");
  await renderFull(res, 'admin-reservations', { reservations });
});
app.get('/admin/reservations/delete/:id', async (req, res) => {
  if (!req.session.user || !req.session.user.is_admin) return res.status(403).send('Доступ запрещён');
  await run("DELETE FROM reservations WHERE id = ?", [req.params.id]);
  flash(req, 'Бронь удалена');
  res.redirect('/admin/reservations');
});
app.get('/admin/pickup', (req, res) => {
  if (!req.session.user || !req.session.user.is_admin) return res.status(403).send('Доступ запрещён');
  renderFull(res, 'admin-pickup');
});
app.post('/admin/pickup', async (req, res) => {
  if (!req.session.user || !req.session.user.is_admin) return res.status(403).send('Доступ запрещён');
  const code = req.body.code?.trim().toUpperCase();
  if (!code) { flash(req, 'Введите код'); return res.redirect('/admin/pickup'); }
  const reservation = await get("SELECT r.*, u.username FROM reservations r JOIN users u ON r.user_id = u.id WHERE r.pickup_code = ?", [code]);
  if (reservation && reservation.status === 'active') {
    await run("UPDATE reservations SET status = 'completed' WHERE id = ?", [reservation.id]);
    flash(req, `Книга "${reservation.book_title}" выдана пользователю ${reservation.username}`);
  } else {
    flash(req, 'Неверный код или бронь уже неактивна');
  }
  res.redirect('/admin/pickup');
});

app.get('/rights', (req, res) => renderFull(res, 'rights'));

app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));