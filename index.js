require('dotenv').config();
const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const cors = require('cors');
const { stringify } = require('csv-stringify/sync');

const PORT = process.env.PORT || 4000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'change_this_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));

// file upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + (file.originalname || 'upload'))
});
const upload = multer({ storage });

app.use('/uploads', express.static(path.resolve(UPLOAD_DIR)));

// helpers
async function requireLogin(req, res, next){
  if (req.session && req.session.user) return next();
  return res.status(401).json({ error: 'not authenticated' });
}
async function requireAdmin(req, res, next){
  if (req.session && req.session.user && req.session.user.role === 'admin') return next();
  return res.status(403).json({ error: 'admin only' });
}

// create default admin if none
(async () => {
  const client = await pool.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT \'agent\', full_name TEXT)');
    const r = await client.query('SELECT count(*)::int AS c FROM users');
    if (r.rows[0].c === 0) {
      const pw = 'admin123';
      const hash = await bcrypt.hash(pw, 10);
      await client.query('INSERT INTO users (username, password_hash, role, full_name) VALUES ($1,$2,$3,$4)', ['admin', hash, 'admin', 'Administrator']);
      console.log('Created default admin: username=admin password=' + pw);
    }
  } finally {
    client.release();
  }
})().catch(console.error);

// auth
app.post('/api/login', async (req,res) => {
  const { username, password } = req.body;
  const r = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
  if (!r.rows[0]) return res.status(401).json({ error: 'invalid credentials' });
  const user = r.rows[0];
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });
  req.session.user = { id: user.id, username: user.username, role: user.role, full_name: user.full_name };
  res.json({ ok: true, user: req.session.user });
});

app.post('/api/logout', (req,res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// users (admin)
app.get('/api/users', requireLogin, requireAdmin, async (req,res) => {
  const r = await pool.query('SELECT id, username, role, full_name FROM users ORDER BY id');
  res.json(r.rows);
});
app.post('/api/users', requireLogin, requireAdmin, async (req,res) => {
  const { username, password, role='agent', full_name='' } = req.body;
  const hash = await bcrypt.hash(password, 10);
  try {
    const r = await pool.query('INSERT INTO users (username, password_hash, role, full_name) VALUES ($1,$2,$3,$4) RETURNING id, username, role, full_name', [username, hash, role, full_name]);
    res.json(r.rows[0]);
  } catch(e){
    res.status(400).json({ error: e.message });
  }
});

// products
app.get('/api/products', requireLogin, async (req,res) => {
  const r = await pool.query('SELECT * FROM products ORDER BY id');
  res.json(r.rows);
});
app.post('/api/products', requireLogin, requireAdmin, async (req,res) => {
  const { name, sku, price } = req.body;
  const r = await pool.query('INSERT INTO products (name, sku, price) VALUES ($1,$2,$3) RETURNING *', [name, sku, price]);
  res.json(r.rows[0]);
});

// sales (with photo and GPS)
app.post('/api/sales', requireLogin, upload.single('photo'), async (req,res) => {
  const { user_id, product_id=null, quantity=1, amount, notes='', gps_lat=null, gps_lng=null } = req.body;
  const uid = user_id || req.session.user.id;
  const photo_path = req.file ? ('/uploads/' + path.basename(req.file.path)) : null;
  try {
    const r = await pool.query(
      'INSERT INTO sales (user_id, product_id, quantity, amount, notes, photo_path, gps_lat, gps_lng) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [uid, product_id, quantity, amount, notes, photo_path, gps_lat, gps_lng]
    );
    res.json({ id: r.rows[0].id });
  } catch(e){
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/sales', requireLogin, async (req,res) => {
  const { from, to, user_id, product_id } = req.query;
  const clauses = [], vals = [];
  if (from) { clauses.push("date(created_at) >= $"+(vals.length+1)); vals.push(from); }
  if (to) { clauses.push("date(created_at) <= $"+(vals.length+1)); vals.push(to); }
  if (user_id) { clauses.push("user_id = $"+(vals.length+1)); vals.push(user_id); }
  if (product_id) { clauses.push("product_id = $"+(vals.length+1)); vals.push(product_id); }
  let sql = 'SELECT s.*, u.username, p.name as product_name FROM sales s LEFT JOIN users u ON s.user_id=u.id LEFT JOIN products p ON s.product_id=p.id';
  if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');
  sql += ' ORDER BY created_at DESC LIMIT 1000';
  const r = await pool.query(sql, vals);
  res.json(r.rows);
});

// reports
app.get('/api/reports/summary', requireLogin, async (req,res) => {
  const { from, to } = req.query;
  const vals = [];
  let where = ' WHERE 1=1 ';
  if (from) { vals.push(from); where += ' AND date(created_at) >= $' + vals.length; }
  if (to) { vals.push(to); where += ' AND date(created_at) <= $' + vals.length; }
  const totalQ = 'SELECT COALESCE(SUM(amount),0)::numeric AS total FROM sales' + where;
  const byUserQ = 'SELECT u.id, u.username, u.full_name, COALESCE(SUM(s.amount),0)::numeric AS total FROM sales s JOIN users u ON s.user_id=u.id' + where + ' GROUP BY u.id ORDER BY total DESC';
  const byProductQ = 'SELECT p.id, p.name, COALESCE(SUM(s.amount),0)::numeric AS total FROM sales s JOIN products p ON s.product_id=p.id' + where + ' GROUP BY p.id ORDER BY total DESC';
  const client = await pool.connect();
  try {
    const total = (await client.query(totalQ, vals)).rows[0].total;
    const byUser = (await client.query(byUserQ, vals)).rows;
    const byProduct = (await client.query(byProductQ, vals)).rows;
    res.json({ total, byUser, byProduct });
  } finally { client.release(); }
});

// export CSV
app.get('/api/reports/export', requireLogin, async (req,res) => {
  const { from, to } = req.query;
  let sql = 'SELECT s.id, s.created_at, u.username, p.name as product, s.quantity, s.amount, s.notes, s.photo_path FROM sales s LEFT JOIN users u ON s.user_id=u.id LEFT JOIN products p ON s.product_id=p.id WHERE 1=1';
  const vals = [];
  if (from) { sql += ' AND date(s.created_at) >= $' + (vals.length+1); vals.push(from); }
  if (to) { sql += ' AND date(s.created_at) <= $' + (vals.length+1); vals.push(to); }
  const r = await pool.query(sql, vals);
  const csv = stringify(r.rows, { header: true });
  res.setHeader('Content-disposition', 'attachment; filename=sales_export.csv');
  res.setHeader('Content-Type', 'text/csv');
  res.send(csv);
});

// notifications (simple)
app.get('/api/notifications', requireLogin, requireAdmin, async (req,res) => {
  const r = await pool.query("SELECT value FROM settings WHERE key='target_total'");
  const target = r.rows[0] ? parseFloat(r.rows[0].value) : null;
  if (!target) return res.json([]);
  const tot = (await pool.query('SELECT COALESCE(SUM(amount),0)::numeric as total FROM sales')).rows[0].total;
  const msgs = [];
  if (parseFloat(tot) >= target) msgs.push({ level:'info', message:`Target reached: ${tot} / ${target}` });
  res.json(msgs);
});

app.listen(PORT, () => console.log('Server listening on', PORT));
