const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();

// ── CORS ──────────────────────────────────────────────────
app.use(function(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── RAW BODY for multipart uploads (must come before express.json) ──
app.use((req, res, next) => {
  if (req.headers['content-type'] && req.headers['content-type'].includes('multipart/form-data')) {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => { req.rawBody = Buffer.concat(chunks); next(); });
  } else {
    next();
  }
});

app.use(express.json());

// ── POSTGRES ──────────────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ── CONFIG ────────────────────────────────────────────────
const JWT_SECRET        = process.env.JWT_SECRET || 'superbiller-secret-change-me';
const N8N_WEBHOOK       = process.env.N8N_WEBHOOK_URL;
const AIRTABLE_BASE     = 'appwGBvGSWNq8BLfh';
const AIRTABLE_TABLE    = 'tbliHRJwRfrQckb55';  // n8n_video
const AIRTABLE_SCENES   = 'tblbtxQHxqllsMrSd';  // video_production
const AIRTABLE_SCRIPT   = 'tblj00M8en7pmuwOn';
const AIRTABLE_PROPERTY = 'tbltqZuJcIfwit1JQ';  // 28property
const AIRTABLE_PAT      = process.env.AIRTABLE_PAT;
const API_BASE_URL      = process.env.API_BASE_URL || 'https://superbiller-api-production.up.railway.app';
const WEBHOOK_28PROP    = 'https://primary-production-ab4a6.up.railway.app/webhook/28property';
const WEBHOOK_REC       = 'https://primary-production-ab4a6.up.railway.app/webhook/ai-recruitment';

// ── IMAGE JOB STORE ───────────────────────────────────────
const _imageJobs = new Map();
function _storeImageJob(session_id, property_image_url, action) {
  const key = (session_id || '') + ':' + property_image_url;
  _imageJobs.set(key, { session_id, property_image_url, action, ts: Date.now() });
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [k, v] of _imageJobs) { if (v.ts < cutoff) _imageJobs.delete(k); }
}
function _findImageJob(session_id) {
  let best = null;
  for (const [k, v] of _imageJobs) {
    if (k.startsWith((session_id || '') + ':')) {
      if (!best || v.ts > best.ts) best = { ...v, key: k };
    }
  }
  if (best) { _imageJobs.delete(best.key); return best; }
  return null;
}

// ── MULTIPART PARSER ──────────────────────────────────────
function parseMultipart(req) {
  const body = req.rawBody;
  if (!body) return null;
  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=(.+)$/);
  if (!boundaryMatch) return null;
  const boundary = boundaryMatch[1].trim();
  const parts = body.toString('binary').split('--' + boundary);
  const result = { fields: {}, file: null };
  for (const part of parts) {
    if (!part.includes('Content-Disposition')) continue;
    const nameMatch     = part.match(/name="([^"]+)"/);
    const filenameMatch = part.match(/filename="([^"]+)"/);
    const ctMatch       = part.match(/Content-Type: ([^\r\n]+)/);
    const name          = nameMatch ? nameMatch[1] : '';
    const headerEnd     = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const value = part.slice(headerEnd + 4, part.lastIndexOf('\r\n'));
    if (filenameMatch) {
      result.file = {
        fileName: filenameMatch[1],
        mimeType: ctMatch ? ctMatch[1].trim() : 'application/octet-stream',
        buffer:   Buffer.from(value, 'binary')
      };
    } else if (name) {
      result.fields[name] = value.trim();
    }
  }
  return result;
}

// ── SETUP DB ──────────────────────────────────────────────
async function setupDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(200) UNIQUE NOT NULL,
      password_hash VARCHAR(200) NOT NULL,
      role VARCHAR(50) DEFAULT 'editor',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS property_agent_images (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255),
      mime_type VARCHAR(100),
      data BYTEA NOT NULL,
      agent_name VARCHAR(200),
      avatar_prompt TEXT,
      user_email VARCHAR(200),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await db.query(`ALTER TABLE property_agent_images ADD COLUMN IF NOT EXISTS avatar_prompt TEXT`).catch(() => {});

  // Separate table for AI recruitment media (images + videos)
  await db.query(`
    CREATE TABLE IF NOT EXISTS recruitment_media (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255),
      mime_type VARCHAR(100),
      data BYTEA NOT NULL,
      media_type VARCHAR(50),
      label VARCHAR(200),
      session_id VARCHAR(255),
      user_email VARCHAR(200),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `).catch(() => {});

  await db.query(`
    CREATE TABLE IF NOT EXISTS named_sessions (
      id            SERIAL PRIMARY KEY,
      user_email    VARCHAR(255),
      funnel        VARCHAR(100),
      session_id    VARCHAR(255),
      title         TEXT,
      property_url  TEXT,
      agent_name    VARCHAR(255),
      session_data  JSONB,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_named_sessions_user ON named_sessions(user_email, funnel)`).catch(() => {});
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_named_sessions_sid ON named_sessions(session_id)`).catch(() => {});

  await db.query(`
    CREATE TABLE IF NOT EXISTS api_billing (
      id            SERIAL PRIMARY KEY,
      user_email    VARCHAR(255),
      label         TEXT,
      cost          NUMERIC(10,4),
      session_id    VARCHAR(255),
      image_url     TEXT,
      agent_name    VARCHAR(255),
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `).catch(() => {});

  await db.query(`
    CREATE TABLE IF NOT EXISTS research_sessions (
      id SERIAL PRIMARY KEY,
      session_id VARCHAR(64) UNIQUE NOT NULL,
      user_email VARCHAR(200),
      funnel VARCHAR(50),
      image_id INTEGER,
      status VARCHAR(20) DEFAULT 'pending',
      chosen_topic TEXT,
      property_data JSONB,
      topics_data JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await db.query(`ALTER TABLE research_sessions ADD COLUMN IF NOT EXISTS property_data JSONB`).catch(() => {});
  await db.query(`ALTER TABLE research_sessions ADD COLUMN IF NOT EXISTS topics_data JSONB`).catch(() => {});

  await db.query(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      id SERIAL PRIMARY KEY,
      user_email VARCHAR(200) NOT NULL,
      funnel VARCHAR(50) NOT NULL,
      session_data JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_email, funnel)
    )
  `).catch(() => {});

  await db.query(`
    CREATE TABLE IF NOT EXISTS regen_results (
      id SERIAL PRIMARY KEY,
      scene_id VARCHAR(64) NOT NULL,
      col VARCHAR(64) NOT NULL,
      new_line TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `).catch(() => {});

  console.log('DB ready');
}
setupDB().catch(err => console.error('setupDB failed:', err.message));

// ── JWT MIDDLEWARE ────────────────────────────────────────
function authMiddleware(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');
  const header = req.headers['authorization'];
  if (!header) return res.status(401).json({ success: false, message: 'No token' });
  const token = header.replace('Bearer ', '');
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}

// ── AIRTABLE HELPER ───────────────────────────────────────
async function atFetch(path, opts = {}) {
  const r = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}${path}`, {
    ...opts,
    headers: { 'Authorization': `Bearer ${AIRTABLE_PAT}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  return r.json();
}

// ── SSE ───────────────────────────────────────────────────
const clients = new Map();

function sseWrite(clientRes, payload) {
  try {
    const ok = clientRes.write(`data: ${payload}\n\n`);
    if (clientRes.flush) clientRes.flush();
    return ok !== false;
  } catch(e) { return false; }
}

function sseBroadcast(payload) {
  clients.forEach(function(conns, userId) {
    const dead = [];
    conns.forEach(function(res) { if (!sseWrite(res, payload)) dead.push(res); });
    dead.forEach(function(res) { conns.delete(res); });
    if (conns.size === 0) clients.delete(userId);
  });
}

// ══════════════════════════════════════════════════════════
// HEALTH
// ══════════════════════════════════════════════════════════

app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date() }));

// ══════════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════════

app.post('/auth/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) return res.json({ success: false, message: 'Name, email and password are required' });
    if (password.length < 6) return res.json({ success: false, message: 'Password must be at least 6 characters' });
    const allowedRoles = ['28property_editor', 'recruitment_editor', 'admin', 'management'];
    const assignedRole = allowedRoles.includes(role) ? role : '28property_editor';
    const allowedDomains = ['@superbiller.com', '@recruitmenttraining'];
    if (!allowedDomains.some(d => email.endsWith(d))) return res.json({ success: false, message: 'Invalid business email.' });
    const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) return res.json({ success: false, message: 'Email already registered' });
    const hash = await bcrypt.hash(password, 10);
    const result = await db.query(
      'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, name, email, role',
      [name, email, hash, assignedRole]
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '100y' });
    res.json({ success: true, token, name: user.name, email: user.email, role: user.role });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.json({ success: false, message: 'Email and password are required' });
    const result = await db.query('SELECT * FROM users WHERE email = $1 LIMIT 1', [email]);
    if (result.rows.length === 0) return res.json({ success: false, message: 'Invalid email or password' });
    const user = result.rows[0];
    if (!await bcrypt.compare(password, user.password_hash)) return res.json({ success: false, message: 'Invalid email or password' });
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '100y' });
    res.json({ success: true, token, name: user.name, email: user.email, role: user.role });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/auth/verify', authMiddleware, (req, res) => res.json({ success: true, user: req.user }));

// ══════════════════════════════════════════════════════════
// SSE — EVENT STREAM
// ══════════════════════════════════════════════════════════

app.get('/events', (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(401).end();
  let user;
  try { user = jwt.verify(token, JWT_SECRET); } catch { return res.status(401).end(); }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const userId = user.id;
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);
  const ping = setInterval(() => { res.write(':\n\n'); if (res.flush) res.flush(); }, 15000);
  req.on('close', () => {
    clearInterval(ping);
    const userConns = clients.get(userId);
    if (userConns) { userConns.delete(res); if (userConns.size === 0) clients.delete(userId); }
  });
});

// ══════════════════════════════════════════════════════════
// VIDEO ROUTES (n8n_video / Airtable)
// ══════════════════════════════════════════════════════════

app.post('/video', authMiddleware, async (req, res) => {
  try {
    const email = req.user.email || '';
    const allowedDomains = ['@superbiller.com', '@recruitmenttraining'];
    if (!allowedDomains.some(d => email.endsWith(d))) return res.status(403).json({ success: false, message: 'Access denied.' });
    const r = await fetch(N8N_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...req.body, user_email: email, user_name: req.user.name }) });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    res.json({ success: true, n8n: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/airtable/video', authMiddleware, async (req, res) => {
  try {
    const { industry, search_focus, pipeline, status = 'Start', user_email, notes } = req.body;
    const data = await atFetch(`/${AIRTABLE_TABLE}`, {
      method: 'POST',
      body: JSON.stringify({ fields: { 'Industry ( **required** )': industry, 'search_focus ( **required** )': search_focus, 'pipeline ( **required** )': pipeline, 'status ( **required** )': status, 'user': user_email || req.user.email || '', ...(notes ? { 'notes': notes } : {}) } })
    });
    res.json({ success: true, record: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/airtable/job', authMiddleware, async (req, res) => {
  try {
    const { record_id } = req.query;
    if (!record_id) return res.status(400).json({ success: false, error: 'record_id required' });
    const data = await atFetch(`/${AIRTABLE_TABLE}/${record_id}`);
    res.json({ success: true, record: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/airtable/videos', authMiddleware, async (req, res) => {
  try {
    const data = await atFetch(`/${AIRTABLE_TABLE}?maxRecords=100&sort[0][field]=created_at&sort[0][direction]=desc`);
    res.json({ success: true, records: data.records });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/airtable/video/update', authMiddleware, async (req, res) => {
  try {
    const { record_id, fields } = req.body;
    if (!record_id || !fields) return res.status(400).json({ success: false, error: 'record_id and fields required' });
    const ALLOWED = ['status ( **required** )', 'title', 'title_th', 'script_en', 'script_th', 'voice_id', 'avatar_name'];
    const filtered = Object.keys(fields).reduce((acc, k) => { if (ALLOWED.includes(k)) acc[k] = fields[k]; return acc; }, {});
    if (Object.keys(filtered).length === 0) return res.status(400).json({ success: false, error: 'No valid fields to update' });
    const data = await atFetch(`/${AIRTABLE_TABLE}/${record_id}`, { method: 'PATCH', body: JSON.stringify({ fields: filtered }) });
    res.json({ success: true, record: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════
// SCENE ROUTES
// ══════════════════════════════════════════════════════════

app.get('/airtable/scenes/debug', authMiddleware, async (req, res) => {
  try {
    const data = await atFetch(`/${AIRTABLE_SCENES}?maxRecords=3`);
    res.json({ success: true, raw: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/airtable/scenes/single', authMiddleware, async (req, res) => {
  try {
    const recordId = req.query.record_id;
    if (!recordId) return res.status(400).json({ success: false, error: 'record_id required' });
    const r = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_SCENES}/${recordId}`, { headers: { 'Authorization': `Bearer ${AIRTABLE_PAT}` } });
    const data = await r.json();
    if (data.error) return res.status(500).json({ success: false, error: data.error });
    const f = data.fields || {};
    res.json({ success: true, fields: { status: f.status || null, image: f.image || null, audio_EN: f.audio_EN || null, audio_TH: f.audio_TH || null, video_EN: f.video_EN || null, full_audio_EN: f.full_audio_EN || null, full_audio_TH: f.full_audio_TH || null, full_script_EN: f.full_script_EN || null, full_script_TH: f.full_script_TH || null } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/airtable/scenes', authMiddleware, async (req, res) => {
  try {
    const jobRecordId = req.query.job_record_id;
    if (!jobRecordId) return res.status(400).json({ success: false, error: 'job_record_id query param required' });
    const fields = ['no', 'scene_number', 'scene_type', 'pacing', 'estimated_duration_secs', 'total_scenes', 'total_duration', 'voiceover_sync_EN', 'voiceover_sync_TH', 'full_script_EN', 'full_script_TH', 'image_prompt', 'negative_prompt', 'Generate', 'image', 'status', 'task', 'audio_EN', 'audio_TH', 'video_EN', 'full_audio_EN', 'full_audio_TH', 'voice_id'];
    const fieldParams = fields.map(f => `fields[]=${encodeURIComponent(f)}`).join('&');
    const filter = encodeURIComponent(`{job_id}="${jobRecordId}"`);
    const data = await atFetch(`/${AIRTABLE_SCENES}?maxRecords=200&filterByFormula=${filter}&sort[0][field]=no&sort[0][direction]=asc&${fieldParams}`);
    const sceneMap = new Map();
    (data.records || []).forEach(r => {
      const sn = r.fields.scene_number;
      const existing = sceneMap.get(sn);
      if (!existing || r.fields.no > existing.fields.no) sceneMap.set(sn, r);
    });
    res.json({ success: true, records: Array.from(sceneMap.values()).sort((a, b) => a.fields.scene_number - b.fields.scene_number) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/airtable/scene/update', authMiddleware, async (req, res) => {
  try {
    const { record_id, fields } = req.body;
    if (!record_id || !fields) return res.status(400).json({ success: false, error: 'record_id and fields required' });
    const allowed = ['image_prompt', 'negative_prompt', 'voiceover_sync_EN', 'voiceover_sync_TH', 'full_script_EN', 'full_script_TH', 'Generate', 'status', 'task', 'scene_number', 'scene_type', 'pacing', 'estimated_duration_secs', 'image', 'audio_EN', 'audio_TH', 'video_EN', 'full_audio_EN', 'full_audio_TH', 'voice_id'];
    const filtered = Object.keys(fields).reduce((acc, k) => { if (allowed.includes(k)) acc[k] = fields[k]; return acc; }, {});
    if (Object.keys(filtered).length === 0) return res.status(400).json({ success: false, error: 'No valid fields to update' });
    const data = await atFetch(`/${AIRTABLE_SCENES}/${record_id}`, { method: 'PATCH', body: JSON.stringify({ fields: filtered }) });
    res.json({ success: true, record: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/airtable/scenes/batch-update', authMiddleware, async (req, res) => {
  try {
    const { updates } = req.body;
    if (!updates || !Array.isArray(updates) || updates.length === 0) return res.status(400).json({ success: false, error: 'updates array required' });
    const allowed = ['scene_number', 'scene_type', 'pacing', 'estimated_duration_secs', 'image_prompt', 'negative_prompt', 'voiceover_sync_EN', 'voiceover_sync_TH', 'full_script_EN', 'full_script_TH', 'Generate', 'status', 'task', 'avatar_name', 'voice_id', 'full_audio_EN', 'full_audio_TH'];
    const records = updates.map(u => ({ id: u.record_id, fields: Object.keys(u.fields).reduce((acc, k) => { if (allowed.includes(k)) acc[k] = u.fields[k]; return acc; }, {}) })).filter(r => Object.keys(r.fields).length > 0);
    if (records.length === 0) return res.status(400).json({ success: false, error: 'No valid fields to update' });
    const chunks = [];
    for (let i = 0; i < records.length; i += 10) chunks.push(records.slice(i, i + 10));
    for (const chunk of chunks) {
      const data = await atFetch(`/${AIRTABLE_SCENES}`, { method: 'PATCH', body: JSON.stringify({ records: chunk }) });
      if (data.error) return res.status(500).json({ success: false, error: data.error });
    }
    res.json({ success: true, updated: records.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/airtable/scene/upload', authMiddleware, async (req, res) => {
  try {
    const parsed = parseMultipart(req);
    if (!parsed || !parsed.file) return res.status(400).json({ success: false, error: 'Missing file' });
    const recordId = parsed.fields.record_id;
    const field    = parsed.fields.field;
    if (!recordId || !field) return res.status(400).json({ success: false, error: 'Missing record_id or field' });
    if (!['image', 'video_EN'].includes(field)) return res.status(400).json({ success: false, error: 'Field not allowed: ' + field });
    const uploadRes = await fetch(`https://content.airtable.com/v0/${AIRTABLE_BASE}/${recordId}/${field}/uploadAttachment`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${AIRTABLE_PAT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contentType: parsed.file.mimeType, filename: parsed.file.fileName, file: parsed.file.buffer.toString('base64') })
    });
    const uploadData = await uploadRes.json();
    if (uploadData.error || !uploadData.id) return res.status(500).json({ success: false, error: uploadData.error || 'Airtable upload failed' });
    res.json({ success: true, attachment: uploadData });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/airtable/scene/create', authMiddleware, async (req, res) => {
  try {
    const { job_record_id, after_scene_number } = req.body;
    if (!job_record_id) return res.status(400).json({ success: false, error: 'job_record_id required' });
    const data = await atFetch(`/${AIRTABLE_SCENES}`, { method: 'POST', body: JSON.stringify({ fields: { job_id: job_record_id, scene_number: after_scene_number || 1, status: 'IDLE' } }) });
    if (data.error) return res.status(500).json({ success: false, error: typeof data.error === 'object' ? JSON.stringify(data.error) : data.error });
    res.json({ success: true, record: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/airtable/scene/delete', authMiddleware, async (req, res) => {
  try {
    const { record_id } = req.body;
    if (!record_id) return res.status(400).json({ success: false, error: 'record_id required' });
    const r = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_SCENES}/${record_id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${AIRTABLE_PAT}` } });
    const data = await r.json();
    if (data.error) return res.status(500).json({ success: false, error: data.error });
    res.json({ success: true, deleted: data.deleted });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════
// NOTIFY — n8n callbacks (no auth — called server-to-server)
// ══════════════════════════════════════════════════════════

app.post('/notify/full-audio', async (req, res) => {
  try {
    const { record_id, task, execution_id } = req.body;
    if (!record_id || !task) return res.status(400).json({ success: false, error: 'record_id and task required' });
    const col = task === 'full_audio_EN' ? 'full_audio_EN' : task === 'full_audio_TH' ? 'full_audio_TH' : null;
    if (!col) return res.status(400).json({ success: false, error: 'task must be full_audio_EN or full_audio_TH' });
    const srcScene = await atFetch(`/${AIRTABLE_SCENES}/${record_id}`);
    const audioUrl = srcScene.fields?.[col];
    if (!audioUrl) return res.status(400).json({ success: false, error: 'No audio URL found' });
    const jobId = srcScene.fields?.job_id;
    if (!jobId) return res.status(400).json({ success: false, error: 'No job_id on source scene' });
    const scenesData = await atFetch(`/${AIRTABLE_SCENES}?filterByFormula=${encodeURIComponent(`{job_id}='${jobId}'`)}&maxRecords=100`);
    const records = (scenesData.records || []).map(s => ({ id: s.id, fields: { [col]: audioUrl } }));
    const chunks = [];
    for (let i = 0; i < records.length; i += 10) chunks.push(records.slice(i, i + 10));
    for (const chunk of chunks) await atFetch(`/${AIRTABLE_SCENES}`, { method: 'PATCH', body: JSON.stringify({ records: chunk }) });
    sseBroadcast(JSON.stringify({ type: 'scene_complete', record_id, status: 'Complete', task, execution_id: execution_id || '' }));
    res.json({ success: true, updated: records.length, url: audioUrl });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/notify/scene', async (req, res) => {
  try {
    const { record_id, status, task } = req.body;
    if (!record_id || !status) return res.status(400).json({ success: false, error: 'record_id and status required' });
    sseBroadcast(JSON.stringify({ ...req.body, record_id, status, task: task || '' }));
    var total = 0; clients.forEach(s => { total += s.size; });
    res.json({ success: true, notified: total });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/notify/regen-line', async (req, res) => {
  try {
    const { session_id, scene_id, col, new_line } = req.body;
    if (!new_line) return res.status(400).json({ success: false, error: 'new_line required' });
    await db.query(`INSERT INTO regen_results (scene_id, col, new_line) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [scene_id || '', col || '', new_line]).catch(() => {});
    sseBroadcast(JSON.stringify({ ...req.body, type: 'regen_line', session_id: session_id || '', scene_id, col, new_line }));
    var total = 0; clients.forEach(s => { total += s.size; });
    res.json({ success: true, notified: total });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/notify/pipeline-ready', async (req, res) => {
  try {
    const { session_id, scenes, property, images, topic, agent_name, avatar_url, user_email, scene_count } = req.body;
    if (!scenes || !Array.isArray(scenes)) return res.status(400).json({ success: false, error: 'scenes array required' });
    sseBroadcast(JSON.stringify({ type: 'pipeline_ready', session_id: session_id || '', scenes, scene_count: scene_count || scenes.length, property, images, topic, agent_name, avatar_url, user_email }));
    var total = 0; clients.forEach(s => { total += s.size; });
    res.json({ success: true, notified: total });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/notify/research', async (req, res) => {
  try {
    const { session_id, property } = req.body;
    if (!session_id || !property) return res.status(400).json({ success: false, error: 'session_id and property required' });
    await db.query(`UPDATE research_sessions SET status = 'property_ready', property_data = $2 WHERE session_id = $1`, [session_id, JSON.stringify(property)]);
    sseBroadcast(JSON.stringify({ ...req.body, type: 'research_property', session_id, property }));
    var total = 0; clients.forEach(s => { total += s.size; });
    res.json({ success: true, notified: total });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/notify/topics', async (req, res) => {
  try {
    const { session_id, topics } = req.body;
    if (!session_id || !topics || !Array.isArray(topics)) return res.status(400).json({ success: false, error: 'session_id and topics array required' });
    await db.query(`UPDATE research_sessions SET status = 'topics_ready', topics_data = $2 WHERE session_id = $1`, [session_id, JSON.stringify(topics)]).catch(() => {});
    sseBroadcast(JSON.stringify({ ...req.body, type: 'research_topics', session_id, topics }));
    var total = 0; clients.forEach(s => { total += s.size; });
    res.json({ success: true, notified: total });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/notify/avatar-prompt', async (req, res) => {
  try {
    const { session_id, prompt } = req.body;
    if (!prompt) return res.status(400).json({ success: false, error: 'prompt required' });
    sseBroadcast(JSON.stringify({ ...req.body, type: 'avatar_prompt', session_id: session_id || '', prompt }));
    var total = 0; clients.forEach(s => { total += s.size; });
    res.json({ success: true, notified: total });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/notify/regen-prompt', async (req, res) => {
  try {
    const { session_id, prompt } = req.body;
    if (!session_id || !prompt) return res.status(400).json({ success: false, error: 'session_id and prompt required' });
    let property_image_url = req.body.property_image_url || req.body.input_image_url || '';
    if (!property_image_url) {
      const job = _findImageJob(session_id);
      if (job) property_image_url = job.property_image_url;
    } else {
      _imageJobs.delete((session_id || '') + ':' + property_image_url);
    }
    sseBroadcast(JSON.stringify({ ...req.body, type: 'regen_prompt', session_id, prompt, property_image_url }));
    var total = 0; clients.forEach(s => { total += s.size; });
    res.json({ success: true, notified: total, property_image_url });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/notify/result-image', async (req, res) => {
  try {
    const { session_id, image_url } = req.body;
    if (!session_id || !image_url) return res.status(400).json({ success: false, error: 'session_id and image_url required' });
    let property_image_url = req.body.property_image_url || req.body.input_image_url || '';
    if (!property_image_url) {
      const job = _findImageJob(session_id);
      if (job) property_image_url = job.property_image_url;
    } else {
      _imageJobs.delete((session_id || '') + ':' + property_image_url);
    }
    sseBroadcast(JSON.stringify({ ...req.body, type: 'result_image', session_id, image_url, property_image_url }));
    var total = 0; clients.forEach(s => { total += s.size; });
    res.json({ success: true, notified: total, property_image_url });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/notify/rec-topics', async (req, res) => {
  try {
    const { session_id, topics } = req.body;
    if (!topics || !Array.isArray(topics)) return res.status(400).json({ success: false, error: 'topics array required' });
    sseBroadcast(JSON.stringify({ type: 'rec_topics', session_id: session_id || '', topics }));
    if (session_id) await db.query(`UPDATE research_sessions SET topics_data = $2, status = 'topics_ready' WHERE session_id = $1`, [session_id, JSON.stringify(topics)]).catch(() => {});
    var total = 0; clients.forEach(s => { total += s.size; });
    res.json({ success: true, notified: total });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/notify/rec-script', async (req, res) => {
  try {
    const { session_id, scenes } = req.body;
    if (!scenes || !Array.isArray(scenes)) return res.status(400).json({ success: false, error: 'scenes array required' });
    sseBroadcast(JSON.stringify({ type: 'rec_script', session_id: session_id || '', scenes }));
    var total = 0; clients.forEach(s => { total += s.size; });
    res.json({ success: true, notified: total });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════

app.get('/dashboard/pipeline', authMiddleware, async (req, res) => {
  try {
    const data = await atFetch(`/${AIRTABLE_TABLE}?maxRecords=200&sort[0][field]=created_at&sort[0][direction]=desc`);
    const records = data.records || [];
    const now = Date.now();
    const stages = { 'Start': [], 'In Progress': [], 'Completed': [], 'Error': [], 'Retry': [] };
    let pendingReview = 0, approved = 0, rejected = 0;
    records.forEach(r => {
      const f = r.fields;
      const status = f['status ( **required** )'] || 'Start';
      const scriptStatus = f['script_status'] || '';
      const hoursOld = f['created_at'] ? (now - new Date(f['created_at']).getTime()) / 3600000 : 0;
      const item = { id: r.id, industry: f['Industry ( **required** )'] || '—', title: f['title'] || null, status, stage: f['stage : agent_name'] || '—', script_status: scriptStatus, pipeline: f['pipeline ( **required** )'] || '—', created_at: f['created_at'] || null, hours_old: Math.round(hoursOld * 10) / 10, stuck: hoursOld > 24 && status === 'In Progress', delayed: hoursOld > 2 && status === 'In Progress' };
      if (stages[status]) stages[status].push(item);
      if (scriptStatus === 'Pending Review') pendingReview++;
      if (scriptStatus === 'Approved') approved++;
      if (scriptStatus === 'Rejected') rejected++;
    });
    res.json({ success: true, total: records.length, counts: { start: stages['Start'].length, in_progress: stages['In Progress'].length, completed: stages['Completed'].length, error: stages['Error'].length, retry: stages['Retry'].length }, script_counts: { pending_review: pendingReview, approved, rejected }, stages });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/dashboard/metrics', authMiddleware, async (req, res) => {
  try {
    const data = await atFetch(`/${AIRTABLE_TABLE}?maxRecords=200`);
    const records = data.records || [];
    const now = Date.now();
    const last7d = records.filter(r => { const c = r.fields['created_at'] ? new Date(r.fields['created_at']).getTime() : 0; return (now - c) < 7 * 24 * 3600000 && r.fields['status ( **required** )'] === 'Completed'; });
    const completed = records.filter(r => r.fields['status ( **required** )'] === 'Completed');
    const approvedScripts = records.filter(r => r.fields['script_status'] === 'Approved');
    res.json({ success: true, total_videos: records.length, completed_total: completed.length, completed_last_7d: last7d.length, avg_per_day: last7d.length > 0 ? Math.round((last7d.length / 7) * 10) / 10 : 0, quality_pass_rate: completed.length > 0 ? Math.round((approvedScripts.length / completed.length) * 100) : 0, pending_review: records.filter(r => r.fields['script_status'] === 'Pending Review').length, errors: records.filter(r => r.fields['status ( **required** )'] === 'Error').length, in_progress: records.filter(r => r.fields['status ( **required** )'] === 'In Progress').length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/dashboard/scripts', authMiddleware, async (req, res) => {
  try {
    const data = await atFetch(`/${AIRTABLE_SCRIPT}?maxRecords=100`);
    res.json({ success: true, records: data.records || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/dashboard/script/approve', authMiddleware, async (req, res) => {
  try {
    const { record_id, action } = req.body;
    const data = await atFetch(`/${AIRTABLE_SCRIPT}/${record_id}`, { method: 'PATCH', body: JSON.stringify({ fields: { status: action } }) });
    res.json({ success: true, record: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/dashboard/retry', authMiddleware, async (req, res) => {
  try {
    const { record_id } = req.body;
    const data = await atFetch(`/${AIRTABLE_TABLE}/${record_id}`, { method: 'PATCH', body: JSON.stringify({ fields: { 'status ( **required** )': 'Retry' } }) });
    res.json({ success: true, record: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/dashboard/weekly', authMiddleware, async (req, res) => {
  try {
    const data = await atFetch(`/${AIRTABLE_TABLE}?maxRecords=500`);
    const records = data.records || [];
    const now = Date.now();
    const weeks = [];
    for (let i = 7; i >= 0; i--) {
      const s = now - (i + 1) * 7 * 24 * 3600000;
      const e = now - i * 7 * 24 * 3600000;
      weeks.push({ week: `W${8 - i}`, count: records.filter(r => { const c = r.fields['created_at'] ? new Date(r.fields['created_at']).getTime() : 0; return c >= s && c < e && r.fields['status ( **required** )'] === 'Completed'; }).length });
    }
    res.json({ success: true, weeks });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/db/query', authMiddleware, async (req, res) => {
  try {
    const { sql, params = [] } = req.body;
    const result = await db.query(sql, params);
    res.json({ success: true, rows: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════
// 28PROPERTY — UPLOADS & IMAGE SERVING
// ══════════════════════════════════════════════════════════

// Frontend upload — agent photo with auth
app.post('/28property/upload', authMiddleware, async (req, res) => {
  try {
    const parsed = parseMultipart(req);
    if (!parsed || !parsed.file) return res.status(400).json({ success: false, error: 'No image file received' });
    const { file, fields } = parsed;
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(file.mimeType)) return res.status(400).json({ success: false, error: 'Only JPG, PNG or WebP images allowed' });
    if (file.buffer.length > 5 * 1024 * 1024) return res.status(400).json({ success: false, error: 'Image must be under 5MB' });
    const result = await db.query(
      `INSERT INTO property_agent_images (filename, mime_type, data, agent_name, user_email) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [file.fileName, file.mimeType, file.buffer, fields.agent_name || '', req.user.email || '']
    );
    const imageId = result.rows[0].id;
    res.json({ success: true, image_id: imageId, image_url: `${API_BASE_URL}/28property/image/${imageId}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Internal n8n upload — no auth, 28property scene images only
app.post('/internal/upload-image', async (req, res) => {
  try {
    const parsed = parseMultipart(req);
    if (!parsed || !parsed.file) return res.status(400).json({ success: false, error: 'No image file received' });
    const { file, fields } = parsed;
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(file.mimeType)) return res.status(400).json({ success: false, error: 'Only JPG, PNG or WebP images allowed' });
    const result = await db.query(
      `INSERT INTO property_agent_images (filename, mime_type, data, agent_name, user_email) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [file.fileName, file.mimeType, file.buffer, fields.agent_name || 'n8n', 'n8n@internal']
    );
    const imageId = result.rows[0].id;
    res.json({ success: true, image_id: imageId, image_url: `${API_BASE_URL}/28property/image/${imageId}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Serve 28property image from Postgres
app.get('/28property/image/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid image ID' });
    const result = await db.query('SELECT data, mime_type FROM property_agent_images WHERE id = $1', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Image not found' });
    const { data, mime_type } = result.rows[0];
    const targetWidth = req.query.w ? parseInt(req.query.w) : 1024;
    try {
      const sharp = require('sharp');
      const resized = await sharp(data).resize({ width: targetWidth, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      res.setHeader('ETag', `"img-${id}-${targetWidth}"`);
      if (req.headers['if-none-match'] === `"img-${id}-${targetWidth}"`) return res.status(304).end();
      return res.send(resized);
    } catch(e) {
      res.setHeader('Content-Type', mime_type);
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      return res.send(data);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════
// 28PROPERTY — AVATAR MANAGEMENT
// ══════════════════════════════════════════════════════════

app.get('/28property/avatars', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(`SELECT id, filename, agent_name, avatar_prompt, user_email, created_at FROM property_agent_images ORDER BY created_at DESC LIMIT 50`);
    res.json({ success: true, avatars: result.rows.map(r => ({ id: r.id, filename: r.filename, agent_name: r.agent_name || '', avatar_prompt: r.avatar_prompt || '', user_email: r.user_email || '', created_at: r.created_at, image_url: `${API_BASE_URL}/28property/image/${r.id}` })) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.patch('/28property/avatar/:id/name', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { agent_name } = req.body;
    if (!agent_name?.trim()) return res.status(400).json({ success: false, error: 'agent_name required' });
    await db.query('UPDATE property_agent_images SET agent_name = $1 WHERE id = $2', [agent_name.trim(), id]);
    res.json({ success: true, id, agent_name: agent_name.trim() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/28property/avatar/:id/prompt', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid id' });
    const result = await db.query('SELECT id, agent_name, avatar_prompt FROM property_agent_images WHERE id = $1', [id]);
    if (result.rows.length === 0) return res.json({ success: true, has_prompt: false, avatar_prompt: null });
    const row = result.rows[0];
    res.json({ success: true, has_prompt: !!(row.avatar_prompt?.trim()), avatar_prompt: row.avatar_prompt || null, agent_name: row.agent_name || '' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.patch('/28property/avatar/:id/prompt', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { avatar_prompt } = req.body;
    if (!avatar_prompt?.trim()) return res.status(400).json({ success: false, error: 'avatar_prompt required' });
    await db.query('UPDATE property_agent_images SET avatar_prompt = $1 WHERE id = $2', [avatar_prompt.trim(), id]);
    res.json({ success: true, id, avatar_prompt: avatar_prompt.trim() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/28property/avatar/:id', authMiddleware, async (req, res) => {
  try {
    await db.query('DELETE FROM property_agent_images WHERE id = $1', [parseInt(req.params.id)]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════
// 28PROPERTY — JOBS & PIPELINE
// ══════════════════════════════════════════════════════════

app.get('/28property/jobs', authMiddleware, async (req, res) => {
  try {
    const data = await atFetch(`/${AIRTABLE_PROPERTY}?maxRecords=50&sort[0][field]=no&sort[0][direction]=desc`);
    res.json({ success: true, records: data.records || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/28property/start', authMiddleware, async (req, res) => {
  try {
    const { property_url, image_id, agent_name } = req.body;
    if (!property_url) return res.status(400).json({ success: false, error: 'property_url is required' });
    if (!image_id) return res.status(400).json({ success: false, error: 'image_id is required — upload photo first' });
    const imgCheck = await db.query('SELECT id FROM property_agent_images WHERE id = $1', [parseInt(image_id)]);
    if (imgCheck.rows.length === 0) return res.status(400).json({ success: false, error: 'Image not found — please re-upload' });
    const r = await fetch(WEBHOOK_28PROP, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'get_details', property_url, agent_image_url: `${API_BASE_URL}/28property/image/${image_id}`, agent_name: agent_name || '', user_email: req.user.email || '', user_name: req.user.name || '', triggered_at: new Date().toISOString() })
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    res.json({ success: true, n8n: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Triggered by frontend Generate button — enriches with full Airtable data before firing n8n
app.post('/28property/start-pipeline', authMiddleware, async (req, res) => {
  try {
    const { record_id } = req.body;
    res.json({ success: true, message: 'Pipeline triggered' });

    let sceneFields = {}, jobFields = {};
    if (record_id) {
      try {
        const sceneData = await atFetch(`/${AIRTABLE_SCENES}/${record_id}`);
        sceneFields = sceneData.fields || {};
        if (sceneFields.job_id) {
          const jobData = await atFetch(`/${AIRTABLE_TABLE}/${sceneFields.job_id}`);
          jobFields = jobData.fields || {};
        }
      } catch (e) {
        console.warn('[start-pipeline] Airtable fetch failed:', e.message);
      }
    }

    fetch(WEBHOOK_28PROP, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...req.body,
        scene_number:            sceneFields.scene_number            || null,
        scene_type:              sceneFields.scene_type              || req.body.scene_type || '',
        pacing:                  sceneFields.pacing                  || null,
        image_prompt:            sceneFields.image_prompt            || '',
        negative_prompt:         sceneFields.negative_prompt         || '',
        voiceover_sync_EN:       sceneFields.voiceover_sync_EN       || '',
        voiceover_sync_TH:       sceneFields.voiceover_sync_TH       || '',
        full_script_EN:          sceneFields.full_script_EN          || '',
        full_script_TH:          sceneFields.full_script_TH          || '',
        voice_id:                sceneFields.voice_id                || req.body.voice_id || '',
        image:                   sceneFields.image                   || null,
        audio_EN:                sceneFields.audio_EN                || null,
        audio_TH:                sceneFields.audio_TH                || null,
        estimated_duration_secs: sceneFields.estimated_duration_secs || null,
        job_id:                  sceneFields.job_id                  || '',
        industry:                jobFields['Industry ( **required** )'] || '',
        pipeline:                jobFields['pipeline ( **required** )'] || '',
        search_focus:            jobFields['search_focus ( **required** )'] || '',
        job_title:               jobFields['title']                  || '',
        action:                  'start_pipeline',
        user_email:              req.user.email || '',
        user_name:               req.user.name  || '',
        user_role:               req.user.role  || '',
        triggered_at:            new Date().toISOString()
      })
    })
    .then(async r => { const t = await r.text(); console.log('[start-pipeline]', r.status, t.slice(0, 120)); })
    .catch(err => console.error('[start-pipeline] FAILED:', err.message));
  } catch (err) {
    console.error('28property/start-pipeline error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/28property/regen-line', authMiddleware, async (req, res) => {
  try {
    res.json({ success: true, message: 'Regenerating...' });
    fetch(WEBHOOK_28PROP, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...req.body, action: 'regen_line', user_email: req.user.email || '', triggered_at: new Date().toISOString() })
    })
    .then(async r => { const t = await r.text(); console.log('[regen-line]', r.status, t.slice(0,100)); })
    .catch(err => console.error('[regen-line] FAILED:', err.message));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/regen-result/:scene_id/:col', authMiddleware, async (req, res) => {
  try {
    const { scene_id, col } = req.params;
    const result = await db.query(`SELECT new_line FROM regen_results WHERE scene_id = $1 AND col = $2 ORDER BY created_at DESC LIMIT 1`, [scene_id, col]);
    if (result.rows.length === 0) return res.json({ success: true, ready: false });
    await db.query('DELETE FROM regen_results WHERE scene_id = $1 AND col = $2', [scene_id, col]);
    res.json({ success: true, ready: true, new_line: result.rows[0].new_line });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/28property/regen-topic', authMiddleware, async (req, res) => {
  try {
    const { part, current_title, current_body, property_title, property_desc, agent_name } = req.body;
    const context = `Property: ${property_title || ''}\nAgent: ${agent_name || ''}\nDescription: ${property_desc || ''}\n\nCurrent Title: ${current_title || ''}\nCurrent Body: ${current_body || ''}`;
    const prompt = part === 'title'
      ? `You are a real estate content writer. Rewrite ONLY the title below to be more engaging and SEO-friendly. Keep it concise (under 80 characters). Return ONLY the new title, nothing else.\n\nContext:\n${context}\n\nRewrite the title only:`
      : `You are a real estate content writer. Rewrite ONLY the body text below to be more engaging, persuasive and well-structured. Keep the same key facts. Return ONLY the new body text, nothing else.\n\nContext:\n${context}\n\nRewrite the body only:`;
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: prompt }], max_tokens: part === 'title' ? 100 : 800, temperature: 0.8 })
    });
    const data = await r.json();
    const result = data.choices?.[0]?.message?.content;
    if (!result) return res.json({ success: false, error: 'No result from GPT' });
    res.json({ success: true, result: result.trim() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════
// 28PROPERTY — RESEARCH (image prompting, avatar)
// ══════════════════════════════════════════════════════════

app.post('/research/start', authMiddleware, async (req, res) => {
  try {
    const { funnel, image_id, agent_name, property_url } = req.body;
    const sessionId = require('crypto').randomBytes(24).toString('hex');
    await db.query(`INSERT INTO research_sessions (session_id, user_email, funnel, image_id, status) VALUES ($1, $2, $3, $4, 'pending')`, [sessionId, req.user.email || '', funnel || '', image_id || null]);
    res.json({ success: true, session_id: sessionId });
    fetch(WEBHOOK_28PROP, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'get_details', session_id: sessionId, funnel: funnel || '', image_id: image_id || null, agent_name: agent_name || '', property_url: property_url || '', agent_image_url: image_id ? `${API_BASE_URL}/28property/image/${image_id}` : '', user_email: req.user.email || '', user_name: req.user.name || '', callback_url: `${API_BASE_URL}/notify/research`, triggered_at: new Date().toISOString() })
    }).catch(err => console.error('[research/start] FAILED:', err.message));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/research/select', authMiddleware, async (req, res) => {
  try {
    const { session_id, chosen_topic } = req.body;
    if (!session_id || !chosen_topic) return res.status(400).json({ success: false, error: 'session_id and chosen_topic required' });
    await db.query(`UPDATE research_sessions SET status = 'topic_selected', chosen_topic = $2 WHERE session_id = $1`, [session_id, chosen_topic]);
    res.json({ success: true, session_id, chosen_topic });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/research/session/:session_id', authMiddleware, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM research_sessions WHERE session_id = $1', [req.params.session_id]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Session not found' });
    const row = result.rows[0];
    const parse = (val) => { if (!val) return null; if (typeof val === 'object') return val; try { return JSON.parse(val); } catch { return null; } };
    res.json({ success: true, session: row, property: parse(row.property_data), topics: parse(row.topics_data) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/research/topics', authMiddleware, async (req, res) => {
  try {
    const { session_id, property, agent_name, agent_prompt } = req.body;
    if (!session_id) return res.status(400).json({ success: false, error: 'session_id required' });
    await db.query(`UPDATE research_sessions SET topics_data = NULL, status = 'topics_pending' WHERE session_id = $1`, [session_id]).catch(() => {});
    res.json({ success: true, session_id });
    fetch(WEBHOOK_28PROP, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...req.body, action: 'get_topics', session_id, property, agent_name: agent_name || '', agent_prompt: agent_prompt || '', callback_url: `${API_BASE_URL}/notify/topics`, user_email: req.user.email || '', triggered_at: new Date().toISOString() })
    }).catch(err => console.error('[research/topics] FAILED:', err.message));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/research/avatar-prompt', authMiddleware, async (req, res) => {
  try {
    const { avatar_url, agent_name, session_id, agent_prompt } = req.body;
    if (!avatar_url) return res.status(400).json({ success: false, error: 'avatar_url required' });
    res.json({ success: true, session_id });
    let property = {}, topics = [];
    try {
      const asr = await db.query(`SELECT property_data, topics_data FROM research_sessions WHERE session_id = $1`, [session_id || '']);
      if (asr.rows.length) {
        const row = asr.rows[0];
        if (row.property_data) property = typeof row.property_data === 'object' ? row.property_data : JSON.parse(row.property_data);
        if (row.topics_data)   topics   = typeof row.topics_data   === 'object' ? row.topics_data   : JSON.parse(row.topics_data);
      }
    } catch(e) {}
    fetch(WEBHOOK_28PROP, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...req.body, action: 'avatar_prompt', session_id: session_id || '', avatar_url, agent_name: agent_name || '', agent_prompt: agent_prompt || '', callback_url: `${API_BASE_URL}/notify/avatar-prompt`, user_email: req.user.email || '', triggered_at: new Date().toISOString(), property, topics })
    }).catch(err => console.error('[research/avatar-prompt] FAILED:', err.message));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/research/image-prompt', authMiddleware, async (req, res) => {
  try {
    const { session_id, property_image_url, avatar_url, prompt, action_type, agent_name, agent_prompt } = req.body;
    const ALLOWED_ACTIONS = ['add_avatar', 'regen_prompt'];
    const action = ALLOWED_ACTIONS.includes(action_type) ? action_type : 'add_avatar';
    const callback_url = action === 'regen_prompt' ? `${API_BASE_URL}/notify/regen-prompt` : `${API_BASE_URL}/notify/result-image`;
    let property = {}, topics = [];
    try {
      const sr = await db.query(`SELECT property_data, topics_data FROM research_sessions WHERE session_id = $1`, [session_id || '']);
      if (sr.rows.length) {
        const row = sr.rows[0];
        if (row.property_data) property = typeof row.property_data === 'object' ? row.property_data : JSON.parse(row.property_data);
        if (row.topics_data)   topics   = typeof row.topics_data   === 'object' ? row.topics_data   : JSON.parse(row.topics_data);
      }
    } catch(e) {}
    _storeImageJob(session_id, property_image_url, action);
    fetch(WEBHOOK_28PROP, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, session_id: session_id || '', property_image_url, avatar_url, prompt, callback_url, user_email: req.user.email || '', triggered_at: new Date().toISOString(), property, topics, agent_name: agent_name || '', agent_prompt: agent_prompt || '' })
    }).catch(err => console.error('[image-prompt] FAILED:', err.message));
    res.json({ success: true, session_id, action });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/compose-image', authMiddleware, async (req, res) => {
  try {
    const { property_image_url, avatar_image_url, avatar_x_pct = 0.03, avatar_y_pct = 0.75 } = req.body;
    if (!property_image_url || !avatar_image_url) return res.status(400).json({ success: false, error: 'Both image URLs required' });
    const sharp = require('sharp');
    const [propRes, avRes] = await Promise.all([fetch(property_image_url), fetch(avatar_image_url)]);
    const propBuf = Buffer.from(await propRes.arrayBuffer());
    const avBuf   = Buffer.from(await avRes.arrayBuffer());
    const propMeta = await sharp(propBuf).metadata();
    const W = propMeta.width, H = propMeta.height;
    const avSize = Math.round(W * 0.18);
    const x = Math.round(avatar_x_pct * W), y = Math.round(avatar_y_pct * H);
    const borderW = 4, totalSize = avSize + borderW * 2;
    const circleMask = Buffer.from(`<svg width="${avSize}" height="${avSize}"><circle cx="${avSize/2}" cy="${avSize/2}" r="${avSize/2}" fill="white"/></svg>`);
    const avCircle = await sharp(avBuf).resize(avSize, avSize, { fit: 'cover', position: 'top' }).composite([{ input: circleMask, blend: 'dest-in' }]).png().toBuffer();
    const borderCircle = Buffer.from(`<svg width="${totalSize}" height="${totalSize}"><circle cx="${totalSize/2}" cy="${totalSize/2}" r="${totalSize/2}" fill="white"/></svg>`);
    const result = await sharp(propBuf).composite([{ input: borderCircle, left: x - borderW, top: y - borderW, blend: 'over' }, { input: avCircle, left: x, top: y, blend: 'over' }]).jpeg({ quality: 92 }).toBuffer();
    res.json({ success: true, image_url: 'data:image/jpeg;base64,' + result.toString('base64') });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════
// AI RECRUITMENT — fully separate from 28property
// ══════════════════════════════════════════════════════════

// Frontend image upload (avatar, property photo etc)
app.post('/recruitment/upload-image', authMiddleware, async (req, res) => {
  try {
    const parsed = parseMultipart(req);
    if (!parsed || !parsed.file) return res.status(400).json({ success: false, error: 'No image file received' });
    const { file, fields } = parsed;
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(file.mimeType)) return res.status(400).json({ success: false, error: 'Only JPG, PNG or WebP images allowed' });
    if (file.buffer.length > 10 * 1024 * 1024) return res.status(400).json({ success: false, error: 'Image must be under 10MB' });
    const result = await db.query(
      `INSERT INTO recruitment_media (filename, mime_type, data, media_type, label, session_id, user_email) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [file.fileName, file.mimeType, file.buffer, 'image', fields.label || '', fields.session_id || '', req.user.email || '']
    );
    const mediaId = result.rows[0].id;
    res.json({ success: true, media_id: mediaId, media_url: `${API_BASE_URL}/recruitment/media/${mediaId}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Frontend video upload
app.post('/recruitment/upload-video', authMiddleware, async (req, res) => {
  try {
    const parsed = parseMultipart(req);
    if (!parsed || !parsed.file) return res.status(400).json({ success: false, error: 'No video file received' });
    const { file, fields } = parsed;
    const allowedTypes = ['video/mp4', 'video/webm', 'video/quicktime'];
    if (!allowedTypes.includes(file.mimeType)) return res.status(400).json({ success: false, error: 'Only MP4, WebM or MOV videos allowed' });
    if (file.buffer.length > 100 * 1024 * 1024) return res.status(400).json({ success: false, error: 'Video must be under 100MB' });
    const result = await db.query(
      `INSERT INTO recruitment_media (filename, mime_type, data, media_type, label, session_id, user_email) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [file.fileName, file.mimeType, file.buffer, 'video', fields.label || '', fields.session_id || '', req.user.email || '']
    );
    const mediaId = result.rows[0].id;
    res.json({ success: true, media_id: mediaId, media_url: `${API_BASE_URL}/recruitment/media/${mediaId}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Internal n8n upload — no auth, recruitment media only
app.post('/internal/recruitment/upload', async (req, res) => {
  try {
    const parsed = parseMultipart(req);
    if (!parsed || !parsed.file) return res.status(400).json({ success: false, error: 'No file received' });
    const { file, fields } = parsed;
    const result = await db.query(
      `INSERT INTO recruitment_media (filename, mime_type, data, media_type, label, session_id, user_email) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [file.fileName, file.mimeType, file.buffer, fields.media_type || 'video', fields.label || 'n8n', fields.session_id || '', 'n8n@internal']
    );
    const mediaId = result.rows[0].id;
    res.json({ success: true, media_id: mediaId, media_url: `${API_BASE_URL}/recruitment/media/${mediaId}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Serve recruitment media (image or video)
app.get('/recruitment/media/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid media ID' });
    const result = await db.query('SELECT data, mime_type, filename FROM recruitment_media WHERE id = $1', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Media not found' });
    const { data, mime_type, filename } = result.rows[0];
    res.setHeader('Content-Type', mime_type);
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    return res.send(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fire any action to recruitment n8n webhook
app.post('/recruitment/fire', authMiddleware, async (req, res) => {
  try {
    const payload = req.body;
    if (!payload.action) return res.status(400).json({ success: false, error: 'action required' });
    res.json({ success: true, action: payload.action });
    fetch(WEBHOOK_REC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    .then(async r => { const t = await r.text(); console.log('[rec/fire]', payload.action, r.status, t.slice(0,120)); })
    .catch(err => console.error('[rec/fire] FAILED:', err.message));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════
// HOME FEED
// ══════════════════════════════════════════════════════════

app.get('/home/feed', authMiddleware, async (req, res) => {
  try {
    const role = req.user.role || '28property_editor';
    if (role === 'admin') return res.json({ success: true, role, redirect: '/dashboard' });
    const feed = { role, sections: [] };
    if (role === '28property_editor' || role === 'management') {
      const data = await atFetch(`/${AIRTABLE_PROPERTY}?maxRecords=50&sort[0][field]=no&sort[0][direction]=desc`);
      const jobs = (data.records || []).map(r => ({ id: r.id, no: r.fields.no || '', title: r.fields.title || r.fields.property_url || '—', status: r.fields.status || 'Unknown', agent: r.fields.agent_name || '', created_at: r.fields.created_at || r.createdTime || '', url: r.fields.property_url || '' }));
      feed.sections.push({ pipeline: '28property', label: '28Property', running: jobs.filter(j => j.status === 'In Progress'), errors: jobs.filter(j => j.status === 'Error'), completed: jobs.filter(j => j.status === 'Completed').slice(0, 10) });
    }
    if (role === 'recruitment_editor' || role === 'management') {
      const result = await db.query(`SELECT session_id, user_email, status, chosen_topic, property_data, created_at FROM research_sessions WHERE funnel = 'ai-recruitment' ORDER BY created_at DESC LIMIT 50`);
      const sessions = result.rows.map(r => {
        const prop = r.property_data ? (typeof r.property_data === 'string' ? JSON.parse(r.property_data) : r.property_data) : null;
        return { id: r.session_id, title: (prop?.title) || r.chosen_topic || r.session_id.slice(0,12) + '…', status: r.status || 'pending', user_email: r.user_email || '', created_at: r.created_at || '' };
      });
      feed.sections.push({ pipeline: 'recruitment', label: 'AI Recruitment', running: sessions.filter(s => ['pending','property_ready','topics_ready','topic_selected'].includes(s.status)), errors: sessions.filter(s => s.status === 'error'), completed: sessions.filter(s => s.status === 'completed').slice(0, 10) });
    }
    res.json({ success: true, ...feed });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════
// SESSION MANAGEMENT
// ══════════════════════════════════════════════════════════

app.post('/session/save', authMiddleware, async (req, res) => {
  try {
    const { funnel, session_data } = req.body;
    if (!funnel || !session_data) return res.status(400).json({ success: false, error: 'funnel and session_data required' });
    await db.query(`INSERT INTO user_sessions (user_email, funnel, session_data, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (user_email, funnel) DO UPDATE SET session_data = $3, updated_at = NOW()`, [req.user.email, funnel, JSON.stringify(session_data)]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/session/load', authMiddleware, async (req, res) => {
  try {
    const { funnel } = req.query;
    if (!funnel) return res.status(400).json({ success: false, error: 'funnel query param required' });
    const result = await db.query('SELECT session_data, updated_at FROM user_sessions WHERE user_email = $1 AND funnel = $2', [req.user.email, funnel]);
    if (result.rows.length === 0) return res.json({ success: true, session: null });
    const row = result.rows[0];
    res.json({ success: true, session: typeof row.session_data === 'string' ? JSON.parse(row.session_data) : row.session_data, updated_at: row.updated_at });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/session/clear', authMiddleware, async (req, res) => {
  try {
    const { funnel, session_id } = req.body;
    if (!funnel) return res.status(400).json({ success: false, error: 'funnel required' });
    await db.query('DELETE FROM user_sessions WHERE user_email = $1 AND funnel = $2', [req.user.email, funnel]);
    if (session_id) await db.query('DELETE FROM named_sessions WHERE user_email = $1 AND session_id = $2', [req.user.email, session_id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/session/save-named', authMiddleware, async (req, res) => {
  try {
    const { funnel, session_id, title, property_url, agent_name, session_data } = req.body;
    if (!funnel || !session_id) return res.status(400).json({ success: false, error: 'funnel and session_id required' });
    await db.query(
      `INSERT INTO named_sessions (user_email, funnel, session_id, title, property_url, agent_name, session_data, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW()) ON CONFLICT (session_id) DO UPDATE SET title=EXCLUDED.title, property_url=EXCLUDED.property_url, agent_name=EXCLUDED.agent_name, session_data=EXCLUDED.session_data, updated_at=NOW()`,
      [req.user.email, funnel, session_id, title||'', property_url||'', agent_name||'', JSON.stringify(session_data||{})]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/session/list', authMiddleware, async (req, res) => {
  try {
    const { funnel } = req.query;
    const result = await db.query(`
      SELECT ns.id, ns.session_id, ns.title, ns.property_url, ns.agent_name, ns.created_at, ns.updated_at,
             COALESCE(SUM(b.cost), 0) as billing_total, COUNT(b.id) as billing_count
      FROM named_sessions ns
      LEFT JOIN api_billing b ON b.session_id = ns.session_id AND b.user_email = ns.user_email AND b.session_id != ''
      WHERE ns.user_email = $1 ${funnel ? 'AND ns.funnel = $2' : ''}
      GROUP BY ns.id, ns.session_id, ns.title, ns.property_url, ns.agent_name, ns.created_at, ns.updated_at
      ORDER BY ns.updated_at DESC LIMIT 20
    `, funnel ? [req.user.email, funnel] : [req.user.email]);
    res.json({ success: true, sessions: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/session/load-named/:session_id', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(`SELECT * FROM named_sessions WHERE session_id = $1 AND user_email = $2`, [req.params.session_id, req.user.email]);
    if (!result.rows.length) return res.status(404).json({ success: false, error: 'Session not found' });
    res.json({ success: true, session: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/session/delete-named/:session_id', authMiddleware, async (req, res) => {
  try {
    await db.query(`DELETE FROM named_sessions WHERE session_id = $1 AND user_email = $2`, [req.params.session_id, req.user.email]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════
// BILLING
// ══════════════════════════════════════════════════════════

app.post('/billing/add', authMiddleware, async (req, res) => {
  try {
    const { label, cost, session_id, image_url, agent_name } = req.body;
    if (!cost) return res.status(400).json({ success: false, error: 'cost required' });
    await db.query(`INSERT INTO api_billing (user_email, label, cost, session_id, image_url, agent_name) VALUES ($1, $2, $3, $4, $5, $6)`, [req.user.email || '', label || '', parseFloat(cost), session_id || '', image_url || '', agent_name || '']);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/billing/session-detail/:session_id', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(`SELECT label, cost, image_url, agent_name, created_at FROM api_billing WHERE session_id = $1 AND user_email = $2 ORDER BY created_at ASC`, [req.params.session_id, req.user.email]);
    const total = result.rows.reduce((s, r) => s + parseFloat(r.cost), 0);
    res.json({ success: true, entries: result.rows, total: total.toFixed(4), count: result.rows.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/billing/session/:session_id', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(`SELECT * FROM api_billing WHERE session_id = $1 ORDER BY created_at ASC`, [req.params.session_id]);
    const total = result.rows.reduce((s, r) => s + parseFloat(r.cost), 0);
    res.json({ success: true, entries: result.rows, total: total.toFixed(4) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/billing/history', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(`SELECT * FROM api_billing WHERE user_email = $1 ORDER BY created_at DESC LIMIT 100`, [req.user.email || '']);
    const total = result.rows.reduce((s, r) => s + parseFloat(r.cost), 0);
    res.json({ success: true, entries: result.rows, total: total.toFixed(4) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
