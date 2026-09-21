// Ammar (عَمار) — Server
// Node.js 20 + Express 4 (ESM) + better-sqlite3 + JWT/bcrypt + Multer + S3 + node-cron

import express from 'express';
import cookieParser from 'cookie-parser';
import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import cron from 'node-cron';
import AdmZip from 'adm-zip';
import { nanoid } from 'nanoid';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectCommand
} from '@aws-sdk/client-s3';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || '/data';
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'ammar.db');
const PUBLIC_DIR = path.join(process.cwd(), 'public');
const TRUST_PROXY = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';

// Never run with a missing or well-known placeholder JWT secret — that would
// let anyone forge a valid login token for any account. If the deployer
// hasn't set a real JWT_SECRET, generate a strong random one on first boot
// and persist it under DATA_DIR so it survives restarts.
const JWT_SECRET_PLACEHOLDER = 'please-change-this-to-a-long-random-string';
const JWT_SECRET_FILE = path.join(DATA_DIR, '.jwt_secret');
function resolveJwtSecret() {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv && fromEnv !== JWT_SECRET_PLACEHOLDER && fromEnv.length >= 16) {
    return fromEnv;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(JWT_SECRET_FILE)) {
    return fs.readFileSync(JWT_SECRET_FILE, 'utf-8').trim();
  }
  const generated = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(JWT_SECRET_FILE, generated, { mode: 0o600 });
  console.warn(
    '[أمان] لم يتم ضبط JWT_SECRET بشكل آمن في .env — تم توليد سر عشوائي وحفظه في',
    JWT_SECRET_FILE,
    '(للتوصية: عدّل JWT_SECRET بملف .env لتتحكم به بنفسك)'
  );
  return generated;
}
const JWT_SECRET = resolveJwtSecret();

const S3_CONFIG = {
  endpoint: process.env.S3_ENDPOINT || '',
  region: process.env.S3_REGION || '',
  bucket: process.env.S3_BUCKET || '',
  accessKey: process.env.S3_ACCESS_KEY || '',
  secretKey: process.env.S3_SECRET_KEY || '',
  prefix: process.env.S3_PREFIX || 'ammar/',
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === '1'
};

function s3Configured() {
  return !!(S3_CONFIG.endpoint && S3_CONFIG.region && S3_CONFIG.bucket && S3_CONFIG.accessKey && S3_CONFIG.secretKey);
}

function getS3Client() {
  return new S3Client({
    endpoint: S3_CONFIG.endpoint,
    region: S3_CONFIG.region,
    forcePathStyle: S3_CONFIG.forcePathStyle,
    credentials: {
      accessKeyId: S3_CONFIG.accessKey,
      secretAccessKey: S3_CONFIG.secretKey
    }
  });
}

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  currency TEXT NOT NULL DEFAULT 'KWD',
  theme TEXT NOT NULL DEFAULT 'system',
  backup_time TEXT DEFAULT '03:00',
  backup_enabled INTEGER NOT NULL DEFAULT 0,
  backup_keep_unlimited INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  currency TEXT NOT NULL DEFAULT 'KWD',
  position INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  agreed REAL NOT NULL DEFAULT 0,
  has_agreed INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  date TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  original_name TEXT,
  mime TEXT,
  size INTEGER,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_items_category ON items(category_id);
CREATE INDEX IF NOT EXISTS idx_payments_item ON payments(item_id);
CREATE INDEX IF NOT EXISTS idx_images_payment ON images(payment_id);
CREATE INDEX IF NOT EXISTS idx_categories_project ON categories(project_id);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
`);

const VALID_CURRENCIES = new Set([
  'KWD', 'SAR', 'AED', 'QAR', 'BHD', 'OMR', 'USD', 'EUR', 'GBP',
  'EGP', 'JOD', 'IQD', 'LYD', 'MAD', 'TND', 'DZD', 'LBP', 'SYP'
]);
function sanitizeCurrency(value, fallback) {
  return typeof value === 'string' && VALID_CURRENCIES.has(value) ? value : fallback;
}

// lightweight migration: add has_agreed to items if upgrading from an older DB
const itemColumns = db.prepare('PRAGMA table_info(items)').all().map((c) => c.name);
if (!itemColumns.includes('has_agreed')) {
  db.exec('ALTER TABLE items ADD COLUMN has_agreed INTEGER NOT NULL DEFAULT 1');
}

// lightweight migration: add per-project currency if upgrading from an older
// DB. Backfill existing projects with each owner's current settings
// currency, so switching to per-project currency doesn't silently change
// what people already see on their existing projects.
const projectColumns = db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
if (!projectColumns.includes('currency')) {
  db.exec("ALTER TABLE projects ADD COLUMN currency TEXT NOT NULL DEFAULT 'KWD'");
  const ownerCurrencies = db.prepare(`
    SELECT projects.id AS project_id, user_settings.currency AS currency
    FROM projects
    JOIN user_settings ON user_settings.user_id = projects.user_id
  `).all();
  const updateProjectCurrency = db.prepare('UPDATE projects SET currency = ? WHERE id = ?');
  const backfill = db.transaction((rows) => {
    for (const row of rows) updateProjectCurrency.run(sanitizeCurrency(row.currency, 'KWD'), row.project_id);
  });
  backfill(ownerCurrencies);
}

function now() {
  return new Date().toISOString();
}

function getAppSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setAppSetting(key, value) {
  db.prepare(
    'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}
if (getAppSetting('registration_open', null) === null) {
  setAppSetting('registration_open', '1');
}

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------
const app = express();
// Only trust X-Forwarded-* headers (client IP, protocol) when the deployer
// explicitly confirms there's a real reverse proxy in front of this
// container (TRUST_PROXY=1 in .env). Trusting them by default let anyone
// spoof their IP over the internet and bypass the login rate limiter below.
if (TRUST_PROXY) {
  app.set('trust proxy', 1);
}
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
const COOKIE_NAME = 'ammar_token';

function signToken(user, remember) {
  const payload = { id: user.id };
  // Always bound the JWT's own lifetime, even for non-"remember me" sessions,
  // so a leaked/copied token can't be replayed indefinitely. The session
  // cookie itself still disappears when the browser closes if !remember.
  const opts = { expiresIn: remember ? '30d' : '1d' };
  return jwt.sign(payload, JWT_SECRET, opts);
}

function setAuthCookie(res, token, remember) {
  // req.secure already accounts for TRUST_PROXY correctly; checking the
  // forwarded-proto header manually here would let it be spoofed when no
  // proxy is actually trusted.
  const cookieOpts = {
    httpOnly: true,
    sameSite: 'lax',
    secure: res.req.secure
  };
  if (remember) cookieOpts.maxAge = 30 * 24 * 60 * 60 * 1000;
  res.cookie(COOKIE_NAME, token, cookieOpts);
}

function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'غير مصرح' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
    if (!user || !user.is_active) return res.status(401).json({ error: 'غير مصرح' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'غير مصرح' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user.is_admin) return res.status(403).json({ error: 'ممنوع' });
  next();
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    is_admin: !!u.is_admin,
    is_active: !!u.is_active,
    created_at: u.created_at
  };
}

function getSettings(userId) {
  let row = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId);
  if (!row) {
    db.prepare('INSERT INTO user_settings (user_id) VALUES (?)').run(userId);
    row = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId);
  }
  return row;
}

// simple in-memory rate limiter for login: 10 attempts / 15 min / IP
const loginAttempts = new Map();
function checkRateLimit(ip, bucket = 'login') {
  const key = `${bucket}:${ip}`;
  const windowMs = 15 * 60 * 1000;
  const nowTs = Date.now();
  const entry = loginAttempts.get(key) || { count: 0, start: nowTs };
  if (nowTs - entry.start > windowMs) {
    entry.count = 0;
    entry.start = nowTs;
  }
  entry.count += 1;
  loginAttempts.set(key, entry);
  return entry.count <= 10;
}

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------
app.get('/api/auth/status', (req, res) => {
  const hasUsers = !!db.prepare('SELECT id FROM users LIMIT 1').get();
  const registrationOpen = getAppSetting('registration_open', '1') === '1';
  res.json({ hasUsers, registrationOpen });
});

app.post('/api/auth/setup', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  if (!checkRateLimit(ip, 'setup')) {
    return res.status(429).json({ error: 'محاولات كثيرة جدًا، حاول لاحقًا' });
  }
  const hasUsers = !!db.prepare('SELECT id FROM users LIMIT 1').get();
  const { username, password, display_name } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'اسم المستخدم وكلمة المرور مطلوبان' });
  if (String(password).length < 6) return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });

  // The very first account always becomes admin and is always allowed
  // (bootstrapping). Any account after that is only allowed while public
  // registration is explicitly open, and is created as a regular user.
  if (hasUsers) {
    const registrationOpen = getAppSetting('registration_open', '0') === '1';
    if (!registrationOpen) return res.status(403).json({ error: 'التسجيل العام مغلق حاليًا' });
  }

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.status(400).json({ error: 'اسم المستخدم مستخدم مسبقًا' });

  const id = nanoid();
  const hash = bcrypt.hashSync(password, 10);
  const isFirstUser = !hasUsers;
  db.prepare(
    'INSERT INTO users (id, username, password_hash, display_name, is_admin, is_active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)'
  ).run(id, username, hash, display_name || username, isFirstUser ? 1 : 0, now());
  db.prepare('INSERT INTO user_settings (user_id) VALUES (?)').run(id);
  if (isFirstUser) setAppSetting('registration_open', '0');

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const token = signToken(user, true);
  setAuthCookie(res, token, true);
  res.json({ user: publicUser(user), settings: getSettings(user.id) });
});

app.post('/api/auth/login', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'محاولات كثيرة جدًا، حاول لاحقًا' });
  }
  const { username, password, remember } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username || '');
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
  }
  if (!user.is_active) return res.status(403).json({ error: 'الحساب معطل' });
  const token = signToken(user, !!remember);
  setAuthCookie(res, token, !!remember);
  res.json({ user: publicUser(user), settings: getSettings(user.id) });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user), settings: getSettings(req.user.id) });
});

// ---------------------------------------------------------------------------
// Users (admin only) & admin settings
// ---------------------------------------------------------------------------
app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY created_at ASC').all();
  res.json({ users: rows.map(publicUser) });
});

app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
  const { username, password, display_name } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'اسم المستخدم وكلمة المرور مطلوبان' });
  if (String(password).length < 6) return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.status(400).json({ error: 'اسم المستخدم مستخدم مسبقًا' });
  const id = nanoid();
  const hash = bcrypt.hashSync(password, 10);
  db.prepare(
    'INSERT INTO users (id, username, password_hash, display_name, is_admin, is_active, created_at) VALUES (?, ?, ?, ?, 0, 1, ?)'
  ).run(id, username, hash, display_name || username, now());
  db.prepare('INSERT INTO user_settings (user_id) VALUES (?)').run(id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  res.json({ user: publicUser(user) });
});

app.patch('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'غير موجود' });
  const { display_name, is_active } = req.body || {};
  if (typeof is_active === 'boolean' && !is_active && target.is_admin) {
    const adminCount = db.prepare('SELECT COUNT(*) c FROM users WHERE is_admin = 1 AND is_active = 1').get().c;
    if (adminCount <= 1) return res.status(400).json({ error: 'لا يمكن تعطيل آخر أدمن' });
  }
  db.prepare('UPDATE users SET display_name = COALESCE(?, display_name), is_active = COALESCE(?, is_active) WHERE id = ?')
    .run(display_name ?? null, typeof is_active === 'boolean' ? (is_active ? 1 : 0) : null, req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  res.json({ user: publicUser(user) });
});

function deleteUserCascade(userId) {
  const imgs = db.prepare(`
    SELECT images.filename FROM images
    JOIN payments ON payments.id = images.payment_id
    JOIN items ON items.id = payments.item_id
    JOIN categories ON categories.id = items.category_id
    JOIN projects ON projects.id = categories.project_id
    WHERE projects.user_id = ?
  `).all(userId);
  db.prepare('DELETE FROM users WHERE id = ?').run(userId); // cascades projects->categories->items->payments->images, and user_settings
  for (const img of imgs) {
    const p = path.join(UPLOADS_DIR, img.filename);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

app.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'غير موجود' });
  if (target.is_admin) {
    const adminCount = db.prepare('SELECT COUNT(*) c FROM users WHERE is_admin = 1').get().c;
    if (adminCount <= 1) return res.status(400).json({ error: 'لا يمكن حذف آخر أدمن' });
  }
  deleteUserCascade(target.id);
  res.json({ ok: true });
});

app.post('/api/users/:id/reset-password', requireAuth, requireAdmin, (req, res) => {
  const { new_password } = req.body || {};
  if (!new_password || String(new_password).length < 6) {
    return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
  }
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'غير موجود' });
  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, target.id);
  res.json({ ok: true });
});

app.get('/api/admin/settings', requireAuth, requireAdmin, (req, res) => {
  res.json({ registration_open: getAppSetting('registration_open', '1') === '1' });
});

app.patch('/api/admin/settings', requireAuth, requireAdmin, (req, res) => {
  const { registration_open } = req.body || {};
  if (typeof registration_open === 'boolean') {
    setAppSetting('registration_open', registration_open ? '1' : '0');
  }
  res.json({ registration_open: getAppSetting('registration_open', '1') === '1' });
});

// ---------------------------------------------------------------------------
// Personal settings
// ---------------------------------------------------------------------------
app.get('/api/settings', requireAuth, (req, res) => {
  res.json({ settings: getSettings(req.user.id) });
});

app.patch('/api/settings', requireAuth, (req, res) => {
  const current = getSettings(req.user.id);
  const { currency, theme, backup_time, backup_enabled, backup_keep_unlimited } = req.body || {};
  db.prepare(`
    UPDATE user_settings SET
      currency = COALESCE(?, currency),
      theme = COALESCE(?, theme),
      backup_time = COALESCE(?, backup_time),
      backup_enabled = COALESCE(?, backup_enabled),
      backup_keep_unlimited = COALESCE(?, backup_keep_unlimited)
    WHERE user_id = ?
  `).run(
    currency ?? null,
    theme ?? null,
    backup_time ?? null,
    typeof backup_enabled === 'boolean' ? (backup_enabled ? 1 : 0) : null,
    typeof backup_keep_unlimited === 'boolean' ? (backup_keep_unlimited ? 1 : 0) : null,
    req.user.id
  );
  const updated = getSettings(req.user.id);
  scheduleUserBackup(req.user.id, updated.backup_enabled, updated.backup_time);
  res.json({ settings: updated });
});

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------
function projectTotals(projectId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(payments.amount), 0) AS paid, COUNT(DISTINCT items.id) AS item_count
    FROM categories
    LEFT JOIN items ON items.category_id = categories.id
    LEFT JOIN payments ON payments.item_id = items.id
    WHERE categories.project_id = ?
  `).get(projectId);
  return { paid: row.paid || 0, item_count: row.item_count || 0 };
}

function findOwnedProject(projectId, userId) {
  return db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(projectId, userId);
}

app.get('/api/projects', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM projects WHERE user_id = ? ORDER BY position ASC, created_at ASC').all(req.user.id);
  const projects = rows.map((p) => ({ ...p, ...projectTotals(p.id) }));
  res.json({ projects });
});

app.post('/api/projects', requireAuth, (req, res) => {
  const { name, description, currency } = req.body || {};
  if (!name) return res.status(400).json({ error: 'اسم المشروع مطلوب' });
  const id = nanoid();
  const defaultCurrency = sanitizeCurrency(currency, sanitizeCurrency(getSettings(req.user.id).currency, 'KWD'));
  const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) m FROM projects WHERE user_id = ?').get(req.user.id).m;
  db.prepare('INSERT INTO projects (id, user_id, name, description, currency, position, archived, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
    .run(id, req.user.id, name, description || null, defaultCurrency, maxPos + 1, now());
  const defaultCats = ['المواد', 'المصنعيات', 'بنود أخرى'];
  defaultCats.forEach((catName, idx) => {
    db.prepare('INSERT INTO categories (id, project_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(nanoid(), id, catName, idx, now());
  });
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  res.json({ project: { ...project, ...projectTotals(id) } });
});

app.get('/api/projects/:id', requireAuth, (req, res) => {
  const project = findOwnedProject(req.params.id, req.user.id);
  if (!project) return res.status(404).json({ error: 'غير موجود' });
  res.json({ project: { ...project, ...projectTotals(project.id) } });
});

app.patch('/api/projects/:id', requireAuth, (req, res) => {
  const project = findOwnedProject(req.params.id, req.user.id);
  if (!project) return res.status(404).json({ error: 'غير موجود' });
  const { name, description, archived, currency } = req.body || {};
  const safeCurrency = currency !== undefined ? sanitizeCurrency(currency, null) : null;
  db.prepare(`
    UPDATE projects SET
      name = COALESCE(?, name),
      description = COALESCE(?, description),
      archived = COALESCE(?, archived),
      currency = COALESCE(?, currency)
    WHERE id = ?
  `).run(name ?? null, description ?? null, typeof archived === 'boolean' ? (archived ? 1 : 0) : null, safeCurrency, project.id);
  const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id);
  res.json({ project: { ...updated, ...projectTotals(project.id) } });
});

app.delete('/api/projects/:id', requireAuth, (req, res) => {
  const project = findOwnedProject(req.params.id, req.user.id);
  if (!project) return res.status(404).json({ error: 'غير موجود' });
  const imgs = db.prepare(`
    SELECT images.filename FROM images
    JOIN payments ON payments.id = images.payment_id
    JOIN items ON items.id = payments.item_id
    JOIN categories ON categories.id = items.category_id
    WHERE categories.project_id = ?
  `).all(project.id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
  for (const img of imgs) {
    const p = path.join(UPLOADS_DIR, img.filename);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  res.json({ ok: true });
});

app.get('/api/projects/:pid/summary', requireAuth, (req, res) => {
  const project = findOwnedProject(req.params.pid, req.user.id);
  if (!project) return res.status(404).json({ error: 'غير موجود' });
  const cats = db.prepare('SELECT * FROM categories WHERE project_id = ? ORDER BY position ASC, created_at ASC').all(project.id);
  const summary = cats.map((cat) => {
    const items = db.prepare('SELECT * FROM items WHERE category_id = ? ORDER BY position ASC, created_at ASC').all(cat.id);
    const itemsWithTotals = items.map((it) => {
      const payments = db.prepare('SELECT * FROM payments WHERE item_id = ? ORDER BY date ASC, created_at ASC').all(it.id);
      const paid = payments.reduce((s, p) => s + p.amount, 0);
      return { ...it, has_agreed: !!it.has_agreed, paid, remaining: (it.agreed || 0) - paid, payments };
    });
    const catPaid = itemsWithTotals.reduce((sum, it) => sum + it.paid, 0);
    return { ...cat, total: catPaid, items: itemsWithTotals };
  });
  res.json({ project: { ...project, ...projectTotals(project.id) }, categories: summary });
});

// ---------------------------------------------------------------------------
// Ownership lookup helpers (scoped through project -> user)
// ---------------------------------------------------------------------------
function findOwnedCategory(categoryId, userId) {
  return db.prepare(`
    SELECT categories.* FROM categories
    JOIN projects ON projects.id = categories.project_id
    WHERE categories.id = ? AND projects.user_id = ?
  `).get(categoryId, userId);
}

function findOwnedItem(itemId, userId) {
  return db.prepare(`
    SELECT items.* FROM items
    JOIN categories ON categories.id = items.category_id
    JOIN projects ON projects.id = categories.project_id
    WHERE items.id = ? AND projects.user_id = ?
  `).get(itemId, userId);
}

function findOwnedPayment(paymentId, userId) {
  return db.prepare(`
    SELECT payments.* FROM payments
    JOIN items ON items.id = payments.item_id
    JOIN categories ON categories.id = items.category_id
    JOIN projects ON projects.id = categories.project_id
    WHERE payments.id = ? AND projects.user_id = ?
  `).get(paymentId, userId);
}

function findOwnedImage(imageId, userId) {
  return db.prepare(`
    SELECT images.* FROM images
    JOIN payments ON payments.id = images.payment_id
    JOIN items ON items.id = payments.item_id
    JOIN categories ON categories.id = items.category_id
    JOIN projects ON projects.id = categories.project_id
    WHERE images.id = ? AND projects.user_id = ?
  `).get(imageId, userId);
}

function itemPaid(itemId) {
  return db.prepare('SELECT COALESCE(SUM(amount), 0) s FROM payments WHERE item_id = ?').get(itemId).s;
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------
app.post('/api/projects/:pid/categories', requireAuth, (req, res) => {
  const project = findOwnedProject(req.params.pid, req.user.id);
  if (!project) return res.status(404).json({ error: 'غير موجود' });
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'اسم القسم مطلوب' });
  const id = nanoid();
  const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) m FROM categories WHERE project_id = ?').get(project.id).m;
  db.prepare('INSERT INTO categories (id, project_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, project.id, name, maxPos + 1, now());
  const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  res.json({ category: cat });
});

app.patch('/api/categories/:id', requireAuth, (req, res) => {
  const cat = findOwnedCategory(req.params.id, req.user.id);
  if (!cat) return res.status(404).json({ error: 'غير موجود' });
  const { name } = req.body || {};
  db.prepare('UPDATE categories SET name = COALESCE(?, name) WHERE id = ?').run(name ?? null, cat.id);
  res.json({ category: db.prepare('SELECT * FROM categories WHERE id = ?').get(cat.id) });
});

app.delete('/api/categories/:id', requireAuth, (req, res) => {
  const cat = findOwnedCategory(req.params.id, req.user.id);
  if (!cat) return res.status(404).json({ error: 'غير موجود' });
  const imgs = db.prepare(`
    SELECT images.filename FROM images
    JOIN payments ON payments.id = images.payment_id
    JOIN items ON items.id = payments.item_id
    WHERE items.category_id = ?
  `).all(cat.id);
  db.prepare('DELETE FROM categories WHERE id = ?').run(cat.id);
  for (const img of imgs) {
    const p = path.join(UPLOADS_DIR, img.filename);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------
app.get('/api/items/:id', requireAuth, (req, res) => {
  const item = findOwnedItem(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'غير موجود' });
  const projectCurrency = db.prepare(`
    SELECT projects.currency FROM projects
    JOIN categories ON categories.project_id = projects.id
    WHERE categories.id = ?
  `).get(item.category_id).currency;
  const payments = db.prepare('SELECT * FROM payments WHERE item_id = ? ORDER BY date ASC, created_at ASC').all(item.id);
  const paymentsWithImages = payments.map((p) => ({
    ...p,
    images: db.prepare('SELECT * FROM images WHERE payment_id = ? ORDER BY position ASC').all(p.id)
  }));
  const paid = paymentsWithImages.reduce((sum, p) => sum + p.amount, 0);
  res.json({
    item: { ...item, has_agreed: !!item.has_agreed, paid, remaining: (item.agreed || 0) - paid, currency: projectCurrency },
    payments: paymentsWithImages
  });
});

app.post('/api/items', requireAuth, (req, res) => {
  const { category_id, name, agreed, has_agreed } = req.body || {};
  if (!category_id || !name) return res.status(400).json({ error: 'القسم والاسم مطلوبان' });
  const cat = findOwnedCategory(category_id, req.user.id);
  if (!cat) return res.status(404).json({ error: 'غير موجود' });
  const id = nanoid();
  const trackAgreed = has_agreed === false ? 0 : 1;
  const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) m FROM items WHERE category_id = ?').get(cat.id).m;
  db.prepare('INSERT INTO items (id, category_id, name, agreed, has_agreed, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, cat.id, name, trackAgreed ? (agreed || 0) : 0, trackAgreed, maxPos + 1, now());
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  res.json({ item: { ...item, has_agreed: !!item.has_agreed, paid: 0, remaining: item.agreed || 0 } });
});

app.patch('/api/items/:id', requireAuth, (req, res) => {
  const item = findOwnedItem(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'غير موجود' });
  const { name, agreed, category_id, has_agreed } = req.body || {};
  if (category_id) {
    const cat = findOwnedCategory(category_id, req.user.id);
    if (!cat) return res.status(404).json({ error: 'غير موجود' });
  }
  const trackAgreed = typeof has_agreed === 'boolean' ? (has_agreed ? 1 : 0) : null;
  db.prepare(`
    UPDATE items SET
      name = COALESCE(?, name),
      agreed = COALESCE(?, agreed),
      category_id = COALESCE(?, category_id),
      has_agreed = COALESCE(?, has_agreed)
    WHERE id = ?
  `).run(name ?? null, agreed ?? null, category_id ?? null, trackAgreed, item.id);
  const updated = db.prepare('SELECT * FROM items WHERE id = ?').get(item.id);
  const paid = itemPaid(item.id);
  res.json({ item: { ...updated, has_agreed: !!updated.has_agreed, paid, remaining: (updated.agreed || 0) - paid } });
});

app.delete('/api/items/:id', requireAuth, (req, res) => {
  const item = findOwnedItem(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'غير موجود' });
  const imgs = db.prepare(`
    SELECT images.filename FROM images
    JOIN payments ON payments.id = images.payment_id
    WHERE payments.item_id = ?
  `).all(item.id);
  db.prepare('DELETE FROM items WHERE id = ?').run(item.id);
  for (const img of imgs) {
    const p = path.join(UPLOADS_DIR, img.filename);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------
app.post('/api/payments', requireAuth, (req, res) => {
  const { item_id, name, amount, date, note } = req.body || {};
  if (!item_id || !name || !date) return res.status(400).json({ error: 'البند والاسم والتاريخ مطلوبة' });
  const item = findOwnedItem(item_id, req.user.id);
  if (!item) return res.status(404).json({ error: 'غير موجود' });
  const id = nanoid();
  db.prepare('INSERT INTO payments (id, item_id, name, amount, date, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, item.id, name, amount || 0, date, note || null, now());
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
  res.json({ payment: { ...payment, images: [] } });
});

app.patch('/api/payments/:id', requireAuth, (req, res) => {
  const payment = findOwnedPayment(req.params.id, req.user.id);
  if (!payment) return res.status(404).json({ error: 'غير موجود' });
  const { name, amount, date, note } = req.body || {};
  db.prepare(`
    UPDATE payments SET
      name = COALESCE(?, name),
      amount = COALESCE(?, amount),
      date = COALESCE(?, date),
      note = COALESCE(?, note)
    WHERE id = ?
  `).run(name ?? null, amount ?? null, date ?? null, note ?? null, payment.id);
  const updated = db.prepare('SELECT * FROM payments WHERE id = ?').get(payment.id);
  const images = db.prepare('SELECT * FROM images WHERE payment_id = ? ORDER BY position ASC').all(payment.id);
  res.json({ payment: { ...updated, images } });
});

app.delete('/api/payments/:id', requireAuth, (req, res) => {
  const payment = findOwnedPayment(req.params.id, req.user.id);
  if (!payment) return res.status(404).json({ error: 'غير موجود' });
  const imgs = db.prepare('SELECT filename FROM images WHERE payment_id = ?').all(payment.id);
  db.prepare('DELETE FROM payments WHERE id = ?').run(payment.id);
  for (const img of imgs) {
    const p = path.join(UPLOADS_DIR, img.filename);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '') || '';
      cb(null, `${nanoid()}${ext}`);
    }
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return cb(new Error('يُسمح برفع صور فقط'));
    }
    cb(null, true);
  }
});

// Detects the real image format from its magic bytes, ignoring whatever
// Content-Type the client claimed. Returns { mime, ext } or null.
function detectImageType(buffer) {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { mime: 'image/png', ext: '.png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: 'image/jpeg', ext: '.jpg' };
  }
  if (buffer.length >= 6 && buffer.toString('ascii', 0, 3) === 'GIF') {
    return { mime: 'image/gif', ext: '.gif' };
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { mime: 'image/webp', ext: '.webp' };
  }
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return { mime: 'image/bmp', ext: '.bmp' };
  }
  return null;
}

function requireOwnedPayment(req, res, next) {
  const payment = findOwnedPayment(req.params.id, req.user.id);
  if (!payment) return res.status(404).json({ error: 'غير موجود' });
  req.ownedPayment = payment;
  next();
}

app.post('/api/payments/:id/images', requireAuth, requireOwnedPayment, upload.array('files', 10), (req, res) => {
  const payment = req.ownedPayment;
  const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) m FROM images WHERE payment_id = ?').get(payment.id).m;
  const files = req.files || [];
  const created = [];
  let rejectedCount = 0;
  let nextPos = maxPos + 1;

  for (const file of files) {
    const savedPath = path.join(UPLOADS_DIR, file.filename);
    let detected = null;
    try {
      const fd = fs.openSync(savedPath, 'r');
      const head = Buffer.alloc(16);
      fs.readSync(fd, head, 0, 16, 0);
      fs.closeSync(fd);
      detected = detectImageType(head);
    } catch (e) {
      detected = null;
    }

    if (!detected) {
      // not a genuine image (real content doesn't match its claimed type) — discard it
      fs.unlink(savedPath, () => {});
      rejectedCount += 1;
      continue;
    }

    // normalize the stored file's extension to match its REAL detected type,
    // ignoring whatever extension the client's filename claimed
    let finalFilename = file.filename;
    if (path.extname(file.filename).toLowerCase() !== detected.ext) {
      const renamed = `${path.basename(file.filename, path.extname(file.filename))}${detected.ext}`;
      const renamedPath = path.join(UPLOADS_DIR, renamed);
      try {
        fs.renameSync(savedPath, renamedPath);
        finalFilename = renamed;
      } catch (e) {
        finalFilename = file.filename; // fall back to original path if rename fails
      }
    }

    const id = nanoid();
    db.prepare('INSERT INTO images (id, payment_id, filename, original_name, mime, size, position) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, payment.id, finalFilename, file.originalname, detected.mime, file.size, nextPos);
    nextPos += 1;
    created.push(db.prepare('SELECT * FROM images WHERE id = ?').get(id));
  }

  if (created.length === 0 && rejectedCount > 0) {
    return res.status(400).json({ error: 'الملفات المرفوعة ليست صورًا صالحة' });
  }
  res.json({ images: created, rejected: rejectedCount || undefined });
});

app.get('/api/uploads/:id', requireAuth, (req, res) => {
  const img = findOwnedImage(req.params.id, req.user.id);
  if (!img) return res.status(404).end();
  const filePath = path.join(UPLOADS_DIR, img.filename);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  // serve the mime we detected at upload time (never a client-supplied value)
  res.setHeader('Content-Type', img.mime || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  fs.createReadStream(filePath).pipe(res);
});

app.delete('/api/images/:id', requireAuth, (req, res) => {
  const img = findOwnedImage(req.params.id, req.user.id);
  if (!img) return res.status(404).json({ error: 'غير موجود' });
  db.prepare('DELETE FROM images WHERE id = ?').run(img.id);
  const filePath = path.join(UPLOADS_DIR, img.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Export / import user data (used by local + cloud backup)
// ---------------------------------------------------------------------------
function exportUserData(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const settings = getSettings(userId);
  const projects = db.prepare('SELECT * FROM projects WHERE user_id = ?').all(userId);
  const categories = db.prepare(`
    SELECT categories.* FROM categories JOIN projects ON projects.id = categories.project_id WHERE projects.user_id = ?
  `).all(userId);
  const items = db.prepare(`
    SELECT items.* FROM items
    JOIN categories ON categories.id = items.category_id
    JOIN projects ON projects.id = categories.project_id
    WHERE projects.user_id = ?
  `).all(userId);
  const payments = db.prepare(`
    SELECT payments.* FROM payments
    JOIN items ON items.id = payments.item_id
    JOIN categories ON categories.id = items.category_id
    JOIN projects ON projects.id = categories.project_id
    WHERE projects.user_id = ?
  `).all(userId);
  const images = db.prepare(`
    SELECT images.* FROM images
    JOIN payments ON payments.id = images.payment_id
    JOIN items ON items.id = payments.item_id
    JOIN categories ON categories.id = items.category_id
    JOIN projects ON projects.id = categories.project_id
    WHERE projects.user_id = ?
  `).all(userId);
  return {
    version: 2,
    exported_at: now(),
    user: { username: user.username, display_name: user.display_name },
    settings: { currency: settings.currency, theme: settings.theme },
    projects,
    categories,
    items,
    payments,
    images
  };
}

function buildBackupZip(userId) {
  const data = exportUserData(userId);
  const zip = new AdmZip();
  zip.addFile('data.json', Buffer.from(JSON.stringify(data, null, 2), 'utf-8'));
  for (const img of data.images) {
    const filePath = path.join(UPLOADS_DIR, img.filename);
    if (fs.existsSync(filePath)) {
      zip.addLocalFile(filePath, 'uploads');
    }
  }
  return zip;
}

function importUserData(userId, data) {
  // wipe current data for the user, then restore from backup
  db.prepare('DELETE FROM projects WHERE user_id = ?').run(userId); // cascades categories/items/payments/images

  if (data.settings) {
    db.prepare(`
      UPDATE user_settings SET
        currency = COALESCE(?, currency),
        theme = COALESCE(?, theme)
      WHERE user_id = ?
    `).run(data.settings.currency ?? null, data.settings.theme ?? null, userId);
  }

  const insertProject = db.prepare(
    'INSERT INTO projects (id, user_id, name, description, currency, position, archived, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insertCategory = db.prepare(
    'INSERT INTO categories (id, project_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  const insertItem = db.prepare(
    'INSERT INTO items (id, category_id, name, agreed, has_agreed, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const insertPayment = db.prepare(
    'INSERT INTO payments (id, item_id, name, amount, date, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const insertImage = db.prepare(
    'INSERT INTO images (id, payment_id, filename, original_name, mime, size, position) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );

  const tx = db.transaction((data) => {
    for (const p of data.projects || []) {
      insertProject.run(
        p.id, userId, p.name, p.description, sanitizeCurrency(p.currency, 'KWD'),
        p.position || 0, p.archived ? 1 : 0, p.created_at || now()
      );
    }
    for (const c of data.categories || []) {
      insertCategory.run(c.id, c.project_id, c.name, c.position || 0, c.created_at || now());
    }
    for (const it of data.items || []) {
      const hasAgreed = it.has_agreed === false || it.has_agreed === 0 ? 0 : 1;
      insertItem.run(it.id, it.category_id, it.name, it.agreed || 0, hasAgreed, it.position || 0, it.created_at || now());
    }
    for (const pay of data.payments || []) {
      insertPayment.run(pay.id, pay.item_id, pay.name, pay.amount || 0, pay.date, pay.note || null, pay.created_at || now());
    }
    for (const img of data.images || []) {
      insertImage.run(img.id, img.payment_id, img.filename, img.original_name, img.mime, img.size, img.position || 0);
    }
  });
  tx(data);
}

// ---------------------------------------------------------------------------
// Local backup (ZIP)
// ---------------------------------------------------------------------------
app.get('/api/backup', requireAuth, (req, res) => {
  const zip = buildBackupZip(req.user.id);
  const buffer = zip.toBuffer();
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', contentDisposition(`ammar-backup-${req.user.username}-${Date.now()}.zip`));
  res.send(buffer);
});

const RESTORE_TMP_DIR = path.join(DATA_DIR, 'tmp');
fs.mkdirSync(RESTORE_TMP_DIR, { recursive: true });
// clear any leftover temp files from a previous crash/restart — this
// directory only ever holds short-lived restore uploads
for (const f of fs.readdirSync(RESTORE_TMP_DIR)) {
  fs.unlink(path.join(RESTORE_TMP_DIR, f), () => {});
}
const restoreUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, RESTORE_TMP_DIR),
    filename: (req, file, cb) => cb(null, `restore-${nanoid()}.zip`)
  }),
  limits: { fileSize: 500 * 1024 * 1024 }
});

app.post('/api/restore', requireAuth, restoreUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'الملف مطلوب' });
  try {
    const zip = new AdmZip(req.file.path);
    const dataEntry = zip.getEntry('data.json');
    if (!dataEntry) return res.status(400).json({ error: 'ملف النسخة الاحتياطية غير صالح' });
    const data = JSON.parse(zip.readAsText(dataEntry));
    // extract uploaded images belonging to this backup
    const uploadEntries = zip.getEntries().filter((e) => e.entryName.startsWith('uploads/') && !e.isDirectory);
    for (const entry of uploadEntries) {
      const targetPath = safeUploadTargetPath(entry.entryName);
      if (!targetPath) continue; // reject any entry attempting path traversal
      fs.writeFileSync(targetPath, entry.getData());
    }
    importUserData(req.user.id, data);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: 'تعذر استعادة النسخة الاحتياطية' });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

// ---------------------------------------------------------------------------
// Cloud backup (S3-compatible)
// ---------------------------------------------------------------------------
const cronJobs = new Map(); // userId -> cron task

async function listCloudBackups(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const client = getS3Client();
  const prefix = `${S3_CONFIG.prefix}${user.username}/`;
  const out = await client.send(new ListObjectsV2Command({ Bucket: S3_CONFIG.bucket, Prefix: prefix }));
  const items = (out.Contents || [])
    .map((o) => ({ key: o.Key, size: o.Size, last_modified: o.LastModified }))
    .sort((a, b) => new Date(b.last_modified) - new Date(a.last_modified));
  return items;
}

async function runCloudBackup(userId) {
  if (!s3Configured()) throw new Error('التخزين السحابي غير مهيأ');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const zip = buildBackupZip(userId);
  const buffer = zip.toBuffer();
  const key = `${S3_CONFIG.prefix}${user.username}/ammar-${user.username}-${new Date().toISOString()}.zip`;
  const client = getS3Client();
  await client.send(new PutObjectCommand({ Bucket: S3_CONFIG.bucket, Key: key, Body: buffer, ContentType: 'application/zip' }));

  const settings = getSettings(userId);
  if (!settings.backup_keep_unlimited) {
    const backups = await listCloudBackups(userId);
    const toDelete = backups.slice(30);
    for (const b of toDelete) {
      await client.send(new DeleteObjectCommand({ Bucket: S3_CONFIG.bucket, Key: b.key }));
    }
  }
  return key;
}

function scheduleUserBackup(userId, enabled, backupTime) {
  const existing = cronJobs.get(userId);
  if (existing) {
    existing.stop();
    cronJobs.delete(userId);
  }
  if (!enabled || !s3Configured()) return;
  const [hour, minute] = String(backupTime || '03:00').split(':').map((n) => parseInt(n, 10));
  if (isNaN(hour) || isNaN(minute)) return;
  const cronExpr = `${minute} ${hour} * * *`;
  const task = cron.schedule(cronExpr, () => {
    runCloudBackup(userId).catch((err) => console.error(`[backup] فشل النسخ التلقائي للمستخدم ${userId}:`, err.message));
  });
  cronJobs.set(userId, task);
}

function scheduleAllBackups() {
  const rows = db.prepare('SELECT user_id, backup_enabled, backup_time FROM user_settings WHERE backup_enabled = 1').all();
  for (const row of rows) {
    scheduleUserBackup(row.user_id, row.backup_enabled, row.backup_time);
  }
}

app.get('/api/cloud/status', requireAuth, async (req, res) => {
  const configured = s3Configured();
  if (!configured) {
    return res.json({
      configured: false,
      required_env: ['S3_ENDPOINT', 'S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_PREFIX', 'S3_FORCE_PATH_STYLE'],
      backups: []
    });
  }
  try {
    const backups = await listCloudBackups(req.user.id);
    const settings = getSettings(req.user.id);
    res.json({
      configured: true,
      bucket: S3_CONFIG.bucket,
      prefix: S3_CONFIG.prefix,
      schedule: settings.backup_time,
      backup_enabled: !!settings.backup_enabled,
      backup_keep_unlimited: !!settings.backup_keep_unlimited,
      backups
    });
  } catch (e) {
    res.status(500).json({ error: 'تعذر الاتصال بالتخزين السحابي' });
  }
});

app.post('/api/cloud/backup-now', requireAuth, async (req, res) => {
  try {
    const key = await runCloudBackup(req.user.id);
    res.json({ ok: true, key });
  } catch (e) {
    res.status(500).json({ error: e.message || 'فشل رفع النسخة الاحتياطية' });
  }
});

app.post('/api/cloud/restore/:key', requireAuth, async (req, res) => {
  if (!s3Configured()) return res.status(400).json({ error: 'التخزين السحابي غير مهيأ' });
  try {
    const key = decodeURIComponent(req.params.key);
    if (!key.startsWith(`${S3_CONFIG.prefix}${req.user.username}/`)) {
      return res.status(404).json({ error: 'غير موجود' });
    }
    const client = getS3Client();
    const obj = await client.send(new GetObjectCommand({ Bucket: S3_CONFIG.bucket, Key: key }));
    const chunks = [];
    for await (const chunk of obj.Body) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    const zip = new AdmZip(buffer);
    const dataEntry = zip.getEntry('data.json');
    if (!dataEntry) return res.status(400).json({ error: 'ملف النسخة الاحتياطية غير صالح' });
    const data = JSON.parse(zip.readAsText(dataEntry));
    const uploadEntries = zip.getEntries().filter((e) => e.entryName.startsWith('uploads/') && !e.isDirectory);
    for (const entry of uploadEntries) {
      const targetPath = safeUploadTargetPath(entry.entryName);
      if (!targetPath) continue; // reject any entry attempting path traversal
      fs.writeFileSync(targetPath, entry.getData());
    }
    importUserData(req.user.id, data);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'تعذر استعادة النسخة من السحابة' });
  }
});

app.delete('/api/cloud/:key', requireAuth, async (req, res) => {
  if (!s3Configured()) return res.status(400).json({ error: 'التخزين السحابي غير مهيأ' });
  const key = decodeURIComponent(req.params.key);
  if (!key.startsWith(`${S3_CONFIG.prefix}${req.user.username}/`)) {
    return res.status(404).json({ error: 'غير موجود' });
  }
  try {
    const client = getS3Client();
    await client.send(new DeleteObjectCommand({ Bucket: S3_CONFIG.bucket, Key: key }));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'فشل حذف النسخة الاحتياطية' });
  }
});

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------
// Resolves a ZIP entry to a safe path strictly inside UPLOADS_DIR, stripping
// any directory traversal ("../", absolute paths, etc.) the entry name may
// contain. Returns null if the entry should be rejected.
function safeUploadTargetPath(entryName) {
  const base = path.basename(entryName); // discard any path components entirely
  if (!base || base === '.' || base === '..') return null;
  const resolved = path.resolve(UPLOADS_DIR, base);
  const withSep = UPLOADS_DIR.endsWith(path.sep) ? UPLOADS_DIR : UPLOADS_DIR + path.sep;
  if (resolved !== UPLOADS_DIR && !resolved.startsWith(withSep)) return null;
  return resolved;
}

function contentDisposition(filename) {
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="download"; filename*=UTF-8''${encoded}`;
}

function csvEscape(val) {
  if (val === null || val === undefined) return '';
  let s = String(val);
  // neutralize CSV/formula injection: a cell starting with = + - @ (or tab/CR)
  // can be interpreted as a formula by Excel/LibreOffice when opened
  if (/^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

app.get('/api/projects/:pid/export/csv', requireAuth, (req, res) => {
  const project = findOwnedProject(req.params.pid, req.user.id);
  if (!project) return res.status(404).json({ error: 'غير موجود' });
  const { scope = 'all', id } = req.query;

  let categories = db.prepare('SELECT * FROM categories WHERE project_id = ? ORDER BY position ASC').all(project.id);
  if (scope === 'cat' && id) categories = categories.filter((c) => c.id === id);

  const rows = [];
  const header = ['نوع السطر', 'القسم', 'البند', 'اسم الدفعة', 'التاريخ', 'المبلغ', 'ملاحظة', 'المتفق عليه', 'المدفوع', 'المتبقي'];
  rows.push(header);

  let grandTotal = 0;

  for (const cat of categories) {
    let items = db.prepare('SELECT * FROM items WHERE category_id = ? ORDER BY position ASC').all(cat.id);
    if (scope === 'item' && id) items = items.filter((it) => it.id === id);
    if (items.length === 0) continue;

    let catPaid = 0;
    const itemRows = [];

    for (const it of items) {
      const payments = db.prepare('SELECT * FROM payments WHERE item_id = ? ORDER BY date ASC').all(it.id);
      const paid = payments.reduce((s, p) => s + p.amount, 0);
      const agreedVal = it.has_agreed ? (it.agreed || 0) : '';
      const remaining = it.has_agreed ? (it.agreed || 0) - paid : '';
      catPaid += paid;

      itemRows.push(['بند', cat.name, it.name, '', '', '', '', agreedVal, paid, remaining]);
      for (const p of payments) {
        itemRows.push(['دفعة', cat.name, it.name, p.name, p.date, p.amount, p.note || '', '', '', '']);
      }
    }

    rows.push(['قسم', cat.name, '', '', '', '', '', '', catPaid, '']);
    rows.push(...itemRows);
    rows.push([]); // blank separator row between categories
    grandTotal += catPaid;
  }

  if (scope === 'all') {
    rows.push(['الإجمالي العام', '', '', '', '', '', '', '', grandTotal, '']);
  }

  const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
  const bom = '\ufeff';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', contentDisposition(`${project.name}-export.csv`));
  res.send(bom + csv);
});

// ---------------------------------------------------------------------------
// Account deletion
// ---------------------------------------------------------------------------
app.delete('/api/account', requireAuth, (req, res) => {
  const { password } = req.body || {};
  if (!password || !bcrypt.compareSync(password, req.user.password_hash)) {
    return res.status(401).json({ error: 'كلمة المرور غير صحيحة' });
  }
  if (req.user.is_admin) {
    const adminCount = db.prepare('SELECT COUNT(*) c FROM users WHERE is_admin = 1').get().c;
    if (adminCount <= 1) return res.status(400).json({ error: 'لا يمكن حذف آخر أدمن' });
  }
  deleteUserCascade(req.user.id);
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Static frontend (SPA)
// ---------------------------------------------------------------------------
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });
}

// ---------------------------------------------------------------------------
// Centralized error handler — must be last. Prevents leaking stack traces,
// file paths, or library details to the client (e.g. Multer upload errors).
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'حجم الملف أكبر من الحد المسموح (15 ميجابايت)' });
    }
    return res.status(400).json({ error: 'تعذر رفع الملف' });
  }
  if (err && err.message === 'يُسمح برفع صور فقط') {
    return res.status(400).json({ error: err.message });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'حدث خطأ غير متوقع بالسيرفر' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
scheduleAllBackups();
app.listen(PORT, () => {
  console.log(`Ammar server running on port ${PORT}`);
});
