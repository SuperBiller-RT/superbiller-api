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
    req.on('end', () => {
      req.rawBody = Buffer.concat(chunks);
      next();
    });
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
const WEBHOOK           = 'https://primary-production-ab4a6.up.railway.app/webhook/28property';

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
  // Non-destructive migration — add avatar_prompt if not exists
  await db.query(`ALTER TABLE property_agent_images ADD COLUMN IF NOT EXISTS avatar_prompt TEXT`).catch(() => {});

  // FIX 2: Added property_data and topics_data JSONB columns
  // These store the full payload so the frontend can recover missed SSE events
  await db.query(`
    CREATE TABLE IF NOT EXISTS research_sessions (
      id SERIAL PRIMARY KEY,
      session_id VARCHAR(64) UNIQUE NOT NULL,
      user_email VARCHAR(200),
      funnel VARCHAR(50),
      image_id INTEGER,
      status VARCHAR(20) DEFAULT 'pending',
      topic1_title TEXT,
      topic1_desc TEXT,
      topic2_title TEXT,
      topic2_desc TEXT,
      topic3_title TEXT,
      topic3_desc TEXT,
      chosen_topic TEXT,
      property_data JSONB,
      topics_data JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // Non-destructive migration for existing tables
  await db.query(`ALTER TABLE research_sessions ADD COLUMN IF NOT EXISTS property_data JSONB`).catch(() => {});
  await db.query(`ALTER TABLE research_sessions ADD COLUMN IF NOT EXISTS topics_data JSONB`).catch(() => {});

  // User sessions table — persists frontend session state to Postgres
  await db.query(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      id SERIAL PRIMARY KEY,
      user_email VARCHAR(200) NOT NULL,
      funnel VARCHAR(50) NOT NULL,
      session_data JSONB NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_email, funnel)
    )
  `).catch(err => console.warn('user_sessions table warning:', err.message));

  // Regen line results — store so frontend can poll if SSE missed
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
setupDB().catch(err => console.error('setupDB failed (non-fatal):', err.message));

// ── JWT MIDDLEWARE ────────────────────────────────────────
function authMiddleware(req, res, next) {
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
    headers: {
      'Authorization': `Bearer ${AIRTABLE_PAT}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  return r.json();
}

// ── SSE HELPER — flushes after write (fixes Railway nginx buffering) ──────
// FIX 1: Always call res.flush() after writing to SSE stream
function sseWrite(clientRes, payload) {
  try {
    const ok = clientRes.write(`data: ${payload}\n\n`);
    if (clientRes.flush) clientRes.flush();
    return ok !== false;
  } catch(e) {
    return false; // dead connection
  }
}

// Broadcast to ALL connected clients — removes dead connections
function sseBroadcast(payload) {
  clients.forEach(function(conns, userId) {
    const dead = [];
    conns.forEach(function(res) {
      const ok = sseWrite(res, payload);
      if (!ok) dead.push(res);
    });
    dead.forEach(function(res) { conns.delete(res); });
    if (conns.size === 0) clients.delete(userId);
  });
}

// ── HEALTH ────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date() }));

// ══════════════════════════════════════════════════════════
// AUTH ROUTES
// ══════════════════════════════════════════════════════════

app.post('/auth/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password)
      return res.json({ success: false, message: 'Name, email and password are required' });
    if (password.length < 6)
      return res.json({ success: false, message: 'Password must be at least 6 characters' });
    const allowedRoles = ['28property_editor', 'recruitment_editor', 'admin', 'management'];
    const assignedRole = allowedRoles.includes(role) ? role : '28property_editor';
    const allowedDomains = ['@superbiller.com', '@recruitmenttraining'];
    if (!allowedDomains.some(d => email.endsWith(d)))
      return res.json({ success: false, message: 'Invalid business email.' });
    const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0)
      return res.json({ success: false, message: 'Email already registered' });
    const hash = await bcrypt.hash(password, 10);
    const result = await db.query(
      'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, name, email, role',
      [name, email, hash, assignedRole]
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ success: true, token, name: user.name, email: user.email, role: user.role });
  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.json({ success: false, message: 'Email and password are required' });
    const result = await db.query('SELECT * FROM users WHERE email = $1 LIMIT 1', [email]);
    if (result.rows.length === 0)
      return res.json({ success: false, message: 'Invalid email or password' });
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match)
      return res.json({ success: false, message: 'Invalid email or password' });
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ success: true, token, name: user.name, email: user.email, role: user.role });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/auth/verify', authMiddleware, (req, res) => {
  res.json({ success: true, user: req.user });
});

// ══════════════════════════════════════════════════════════
// VIDEO ROUTES
// ══════════════════════════════════════════════════════════

app.post('/video', authMiddleware, async (req, res) => {
  try {
    const email = req.user.email || '';
    const allowedDomains = ['@superbiller.com', '@recruitmenttraining'];
    if (!allowedDomains.some(d => email.endsWith(d)))
      return res.status(403).json({ success: false, message: 'Access denied.' });
    const r = await fetch(N8N_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...req.body, user_email: email, user_name: req.user.name })
    });
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
      body: JSON.stringify({ fields: {
        'Industry ( **required** )': industry,
        'search_focus ( **required** )': search_focus,
        'pipeline ( **required** )': pipeline,
        'status ( **required** )': status,
        'user': user_email || req.user.email || '',
        ...(notes ? { 'notes': notes } : {})
      }})
    });
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
    if (!record_id || !fields)
      return res.status(400).json({ success: false, error: 'record_id and fields required' });
    const ALLOWED_VIDEO_FIELDS = ['status ( **required** )', 'title', 'title_th', 'script_en', 'script_th', 'voice_id', 'avatar_name'];
    const filtered = Object.keys(fields).reduce((acc, k) => {
      if (ALLOWED_VIDEO_FIELDS.includes(k)) acc[k] = fields[k];
      return acc;
    }, {});
    if (Object.keys(filtered).length === 0)
      return res.status(400).json({ success: false, error: 'No valid fields to update' });
    const data = await atFetch(`/${AIRTABLE_TABLE}/${record_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields: filtered })
    });
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

// ── SSE — connected clients ───────────────────────────────
const clients = new Map(); // userId -> Set of response objects // userId -> Set of response objects

app.get('/events', (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(401).end();
  let user;
  try { user = jwt.verify(token, JWT_SECRET); } catch { return res.status(401).end(); }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // FIX 1: Disable nginx buffering explicitly
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const userId = user.id;
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);

  // FIX 1: flush the ping so Railway proxy doesn't buffer it
  const ping = setInterval(() => {
    res.write(':\n\n');
    if (res.flush) res.flush();
  }, 15000);

  req.on('close', () => {
    clearInterval(ping);
    const userConns = clients.get(userId);
    if (userConns) {
      userConns.delete(res);
      if (userConns.size === 0) clients.delete(userId);
    }
  });
});

// ── NOTIFY SCENE — called by n8n when scene status changes ─
app.post('/notify/scene', async (req, res) => {
  try {
    const { record_id, status, task } = req.body;
    if (!record_id || !status)
      return res.status(400).json({ success: false, error: 'record_id and status required' });
    const payload = JSON.stringify({ record_id, status, task: task || '' });
    // FIX 1: use sseWrite helper which calls flush()
    sseBroadcast(payload);
    var total = 0; clients.forEach(function(s){ total += s.size; }); res.json({ success: true, notified: total });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/airtable/scenes/single', authMiddleware, async (req, res) => {
  try {
    const recordId = req.query.record_id;
    if (!recordId)
      return res.status(400).json({ success: false, error: 'record_id required' });
    const r = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_SCENES}/${recordId}`, {
      headers: { 'Authorization': `Bearer ${AIRTABLE_PAT}` }
    });
    const data = await r.json();
    if (data.error) {
      console.error('Airtable single record error:', data);
      return res.status(500).json({ success: false, error: data.error });
    }
    const f = data.fields || {};
    res.json({
      success: true,
      fields: {
        status:         f.status         || null,
        image:          f.image          || null,
        audio_EN:       f.audio_EN       || null,
        audio_TH:       f.audio_TH       || null,
        video_EN:       f.video_EN       || null,
        full_audio_EN:  f.full_audio_EN  || null,
        full_audio_TH:  f.full_audio_TH  || null,
        full_script_EN: f.full_script_EN || null,
        full_script_TH: f.full_script_TH || null,
      }
    });
  } catch (err) {
    console.error('scenes/single error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/airtable/scenes', authMiddleware, async (req, res) => {
  try {
    const jobRecordId = req.query.job_record_id;
    if (!jobRecordId)
      return res.status(400).json({ success: false, error: 'job_record_id query param required' });

    const fields = [
      'no', 'scene_number', 'scene_type', 'pacing',
      'estimated_duration_secs', 'total_scenes', 'total_duration',
      'voiceover_sync_EN', 'voiceover_sync_TH',
      'full_script_EN', 'full_script_TH',
      'image_prompt', 'negative_prompt',
      'Generate', 'image', 'status', 'task',
      'audio_EN', 'audio_TH', 'video_EN', 'full_audio_EN', 'full_audio_TH',
      'voice_id'
    ];
    const fieldParams = fields.map(f => `fields[]=${encodeURIComponent(f)}`).join('&');
    const filter = encodeURIComponent(`{job_id}="${jobRecordId}"`);

    const data = await atFetch(
      `/${AIRTABLE_SCENES}?maxRecords=200&filterByFormula=${filter}&sort[0][field]=no&sort[0][direction]=asc&${fieldParams}`
    );

    const sceneMap = new Map();
    (data.records || []).forEach(r => {
      const sn = r.fields.scene_number;
      const existing = sceneMap.get(sn);
      if (!existing || r.fields.no > existing.fields.no) sceneMap.set(sn, r);
    });
    const unique = Array.from(sceneMap.values())
      .sort((a, b) => a.fields.scene_number - b.fields.scene_number);

    res.json({ success: true, records: unique });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/airtable/scene/update', authMiddleware, async (req, res) => {
  try {
    const { record_id, fields } = req.body;
    if (!record_id || !fields)
      return res.status(400).json({ success: false, error: 'record_id and fields required' });

    const allowed = [
      'image_prompt', 'negative_prompt',
      'voiceover_sync_EN', 'voiceover_sync_TH',
      'full_script_EN', 'full_script_TH',
      'Generate', 'status', 'task',
      'scene_number', 'scene_type', 'pacing', 'estimated_duration_secs',
      'image', 'audio_EN', 'audio_TH', 'video_EN', 'full_audio_EN', 'full_audio_TH',
      'voice_id'
    ];

    const filtered = Object.keys(fields).reduce((acc, k) => {
      if (allowed.includes(k)) acc[k] = fields[k];
      return acc;
    }, {});

    if (Object.keys(filtered).length === 0)
      return res.status(400).json({ success: false, error: 'No valid fields to update' });

    const data = await atFetch(`/${AIRTABLE_SCENES}/${record_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields: filtered })
    });
    res.json({ success: true, record: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/airtable/scenes/batch-update', authMiddleware, async (req, res) => {
  try {
    const { updates } = req.body;
    if (!updates || !Array.isArray(updates) || updates.length === 0)
      return res.status(400).json({ success: false, error: 'updates array required' });

    const allowed = [
      'scene_number', 'scene_type', 'pacing', 'estimated_duration_secs',
      'image_prompt', 'negative_prompt', 'voiceover_sync_EN', 'voiceover_sync_TH',
      'full_script_EN', 'full_script_TH',
      'Generate', 'status', 'task',
      'avatar_name', 'voice_id'
    ];

    const records = updates.map(u => ({
      id: u.record_id,
      fields: Object.keys(u.fields).reduce((acc, k) => {
        if (allowed.includes(k)) acc[k] = u.fields[k];
        return acc;
      }, {})
    })).filter(r => Object.keys(r.fields).length > 0);

    if (records.length === 0)
      return res.status(400).json({ success: false, error: 'No valid fields to update' });

    const chunks = [];
    for (let i = 0; i < records.length; i += 10) chunks.push(records.slice(i, i + 10));

    for (const chunk of chunks) {
      const data = await atFetch(`/${AIRTABLE_SCENES}`, {
        method: 'PATCH',
        body: JSON.stringify({ records: chunk })
      });
      if (data.error) return res.status(500).json({ success: false, error: data.error });
    }

    res.json({ success: true, updated: records.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/airtable/scene/upload', authMiddleware, async (req, res) => {
  try {
    const body = req.rawBody;
    if (!body) return res.status(400).json({ success: false, error: 'No body received' });

    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)$/);
    if (!boundaryMatch) return res.status(400).json({ success: false, error: 'No boundary in content-type' });
    const boundary = boundaryMatch[1].trim();

    const parts = body.toString('binary').split('--' + boundary);
    let fileBuffer = null, fileName = 'upload', mimeType = 'application/octet-stream';
    let recordId = null, field = null;

    for (const part of parts) {
      if (!part.includes('Content-Disposition')) continue;
      const nameMatch = part.match(/name="([^"]+)"/);
      const filenameMatch = part.match(/filename="([^"]+)"/);
      const ctMatch = part.match(/Content-Type: ([^\r\n]+)/);
      const name = nameMatch ? nameMatch[1] : '';
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd === -1) continue;
      const value = part.slice(headerEnd + 4, part.lastIndexOf('\r\n'));

      if (name === 'record_id') { recordId = value.trim(); }
      else if (name === 'field') { field = value.trim(); }
      else if (filenameMatch) {
        fileName = filenameMatch[1];
        mimeType = ctMatch ? ctMatch[1].trim() : 'application/octet-stream';
        fileBuffer = Buffer.from(value, 'binary');
      }
    }

    if (!recordId || !field || !fileBuffer)
      return res.status(400).json({ success: false, error: 'Missing record_id, field, or file' });

    const allowedFields = ['image', 'video_EN'];
    if (!allowedFields.includes(field))
      return res.status(400).json({ success: false, error: 'Field not allowed: ' + field });

    const uploadRes = await fetch(
      `https://content.airtable.com/v0/${AIRTABLE_BASE}/${recordId}/${field}/uploadAttachment`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${AIRTABLE_PAT}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentType: mimeType, filename: fileName, file: fileBuffer.toString('base64') })
      }
    );

    const uploadData = await uploadRes.json();
    if (uploadData.error || !uploadData.id) {
      console.error('Airtable upload error:', uploadData);
      return res.status(500).json({ success: false, error: uploadData.error || 'Airtable upload failed' });
    }

    res.json({ success: true, attachment: uploadData });
  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/airtable/scene/create', authMiddleware, async (req, res) => {
  try {
    const { job_record_id, after_scene_number } = req.body;
    if (!job_record_id)
      return res.status(400).json({ success: false, error: 'job_record_id required' });
    const fields = {
      job_id: job_record_id,
      scene_number: after_scene_number || 1,
      status: 'IDLE'
    };
    const data = await atFetch(`/${AIRTABLE_SCENES}`, {
      method: 'POST',
      body: JSON.stringify({ fields })
    });
    if (data.error) {
      const errMsg = typeof data.error === 'object' ? JSON.stringify(data.error) : data.error;
      return res.status(500).json({ success: false, error: errMsg });
    }
    res.json({ success: true, record: data });
  } catch (err) {
    console.error('Scene create error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/airtable/scene/delete', authMiddleware, async (req, res) => {
  try {
    const { record_id } = req.body;
    if (!record_id)
      return res.status(400).json({ success: false, error: 'record_id required' });
    const r = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_SCENES}/${record_id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${AIRTABLE_PAT}` }
    });
    const data = await r.json();
    if (data.error) return res.status(500).json({ success: false, error: data.error });
    res.json({ success: true, deleted: data.deleted });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════
// DASHBOARD ROUTES
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
      const item = {
        id: r.id, industry: f['Industry ( **required** )'] || '—',
        title: f['title'] || null, status, stage: f['stage : agent_name'] || '—',
        script_status: scriptStatus, pipeline: f['pipeline ( **required** )'] || '—',
        created_at: f['created_at'] || null,
        hours_old: Math.round(hoursOld * 10) / 10,
        stuck: hoursOld > 24 && status === 'In Progress',
        delayed: hoursOld > 2 && status === 'In Progress'
      };
      if (stages[status]) stages[status].push(item);
      if (scriptStatus === 'Pending Review') pendingReview++;
      if (scriptStatus === 'Approved') approved++;
      if (scriptStatus === 'Rejected') rejected++;
    });
    res.json({
      success: true, total: records.length,
      counts: { start: stages['Start'].length, in_progress: stages['In Progress'].length, completed: stages['Completed'].length, error: stages['Error'].length, retry: stages['Retry'].length },
      script_counts: { pending_review: pendingReview, approved, rejected },
      stages
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/dashboard/metrics', authMiddleware, async (req, res) => {
  try {
    const data = await atFetch(`/${AIRTABLE_TABLE}?maxRecords=200`);
    const records = data.records || [];
    const now = Date.now();
    const last7d = records.filter(r => {
      const c = r.fields['created_at'] ? new Date(r.fields['created_at']).getTime() : 0;
      return (now - c) < 7 * 24 * 3600000 && r.fields['status ( **required** )'] === 'Completed';
    });
    const completed = records.filter(r => r.fields['status ( **required** )'] === 'Completed');
    const approvedScripts = records.filter(r => r.fields['script_status'] === 'Approved');
    res.json({
      success: true,
      total_videos: records.length,
      completed_total: completed.length,
      completed_last_7d: last7d.length,
      avg_per_day: last7d.length > 0 ? Math.round((last7d.length / 7) * 10) / 10 : 0,
      quality_pass_rate: completed.length > 0 ? Math.round((approvedScripts.length / completed.length) * 100) : 0,
      pending_review: records.filter(r => r.fields['script_status'] === 'Pending Review').length,
      errors: records.filter(r => r.fields['status ( **required** )'] === 'Error').length,
      in_progress: records.filter(r => r.fields['status ( **required** )'] === 'In Progress').length
    });
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
    const data = await atFetch(`/${AIRTABLE_SCRIPT}/${record_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields: { status: action } })
    });
    res.json({ success: true, record: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/dashboard/retry', authMiddleware, async (req, res) => {
  try {
    const { record_id } = req.body;
    const data = await atFetch(`/${AIRTABLE_TABLE}/${record_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields: { 'status ( **required** )': 'Retry' } })
    });
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
      const count = records.filter(r => {
        const c = r.fields['created_at'] ? new Date(r.fields['created_at']).getTime() : 0;
        return c >= s && c < e && r.fields['status ( **required** )'] === 'Completed';
      }).length;
      weeks.push({ week: `W${8 - i}`, count });
    }
    res.json({ success: true, weeks });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POSTGRES — raw query ──────────────────────────────────
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
// 28PROPERTY ROUTES
// ══════════════════════════════════════════════════════════

app.post('/28property/upload', authMiddleware, async (req, res) => {
  try {
    const body = req.rawBody;
    if (!body) return res.status(400).json({ success: false, error: 'No body received' });

    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)$/);
    if (!boundaryMatch) return res.status(400).json({ success: false, error: 'No boundary in content-type' });
    const boundary = boundaryMatch[1].trim();

    const parts = body.toString('binary').split('--' + boundary);
    let fileBuffer = null, fileName = 'agent-photo', mimeType = 'image/jpeg', agentName = '';

    for (const part of parts) {
      if (!part.includes('Content-Disposition')) continue;
      const nameMatch     = part.match(/name="([^"]+)"/);
      const filenameMatch = part.match(/filename="([^"]+)"/);
      const ctMatch       = part.match(/Content-Type: ([^\r\n]+)/);
      const name          = nameMatch ? nameMatch[1] : '';
      const headerEnd     = part.indexOf('\r\n\r\n');
      if (headerEnd === -1) continue;
      const value = part.slice(headerEnd + 4, part.lastIndexOf('\r\n'));

      if (name === 'agent_name') { agentName = value.trim(); }
      else if (filenameMatch) {
        fileName   = filenameMatch[1];
        mimeType   = ctMatch ? ctMatch[1].trim() : 'image/jpeg';
        fileBuffer = Buffer.from(value, 'binary');
      }
    }

    if (!fileBuffer)
      return res.status(400).json({ success: false, error: 'No image file received' });

    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(mimeType))
      return res.status(400).json({ success: false, error: 'Only JPG, PNG or WebP images allowed' });

    if (fileBuffer.length > 5 * 1024 * 1024)
      return res.status(400).json({ success: false, error: 'Image must be under 5MB' });

    const result = await db.query(
      `INSERT INTO property_agent_images (filename, mime_type, data, agent_name, user_email)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [fileName, mimeType, fileBuffer, agentName, req.user.email || '']
    );

    const imageId  = result.rows[0].id;
    const imageUrl = `${API_BASE_URL}/28property/image/${imageId}`;
    res.json({ success: true, image_id: imageId, image_url: imageUrl });
  } catch (err) {
    console.error('28property upload error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/28property/image/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id || isNaN(id))
      return res.status(400).json({ error: 'Invalid image ID' });

    const result = await db.query(
      'SELECT data, mime_type, filename FROM property_agent_images WHERE id = $1', [id]
    );

    if (result.rows.length === 0)
      return res.status(404).json({ error: 'Image not found' });

    const { data, mime_type, filename } = result.rows[0];

    // Always serve resized — default 1024px max, override with ?w=
    const targetWidth = req.query.w ? parseInt(req.query.w) : 1024;
    try {
      const sharp = require('sharp');
      const resized = await sharp(data)
        .resize({ width: targetWidth, withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      res.setHeader('ETag', `"img-${id}-${targetWidth}"`);
      if (req.headers['if-none-match'] === `"img-${id}-${targetWidth}"`) return res.status(304).end();
      return res.send(resized);
    } catch(e) {
      // sharp not available — serve original
      res.setHeader('Content-Type', mime_type);
      res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
      res.setHeader('ETag', `"img-${id}"`);
      if (req.headers['if-none-match'] === `"img-${id}"`) return res.status(304).end();
      return res.send(data);
    }
  } catch (err) {
    console.error('28property image serve error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/28property/start', authMiddleware, async (req, res) => {
  try {
    const { property_url, image_id, agent_name } = req.body;

    if (!property_url)
      return res.status(400).json({ success: false, error: 'property_url is required' });
    if (!image_id)
      return res.status(400).json({ success: false, error: 'image_id is required — upload photo first' });

    const imgCheck = await db.query(
      'SELECT id FROM property_agent_images WHERE id = $1', [parseInt(image_id)]
    );
    if (imgCheck.rows.length === 0)
      return res.status(400).json({ success: false, error: 'Image not found — please re-upload' });

    const agent_image_url = `${API_BASE_URL}/28property/image/${image_id}`;
    const payload = {
      action:       'get_details',
      property_url,
      agent_image_url,
      agent_name:   agent_name || '',
      agent_prompt: agent_prompt || '',
      user_email:   req.user.email || '',
      user_name:    req.user.name  || '',
      triggered_at: new Date().toISOString()
    };

    const r = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    res.json({ success: true, n8n: data });
  } catch (err) {
    console.error('28property start error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update agent name on an existing avatar record
app.patch('/28property/avatar/:id/name', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { agent_name } = req.body;
    if (!agent_name || !agent_name.trim())
      return res.status(400).json({ success: false, error: 'agent_name required' });
    await db.query(
      'UPDATE property_agent_images SET agent_name = $1 WHERE id = $2',
      [agent_name.trim(), id]
    );
    res.json({ success: true, id, agent_name: agent_name.trim() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});



// Internal — n8n checks if avatar already has a saved prompt
// No auth required — only accessible from n8n server-side
app.get('/28property/avatar/:id/prompt', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id || isNaN(id))
      return res.status(400).json({ success: false, error: 'Invalid id' });
    const result = await db.query(
      'SELECT id, agent_name, avatar_prompt FROM property_agent_images WHERE id = $1',
      [id]
    );
    if (result.rows.length === 0)
      return res.json({ success: true, has_prompt: false, avatar_prompt: null });
    const row = result.rows[0];
    res.json({
      success: true,
      has_prompt: !!(row.avatar_prompt && row.avatar_prompt.trim()),
      avatar_prompt: row.avatar_prompt || null,
      agent_name: row.agent_name || ''
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Save avatar prompt permanently to agent record
app.patch('/28property/avatar/:id/prompt', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { avatar_prompt } = req.body;
    if (!avatar_prompt || !avatar_prompt.trim())
      return res.status(400).json({ success: false, error: 'avatar_prompt required' });
    await db.query(
      'UPDATE property_agent_images SET avatar_prompt = $1 WHERE id = $2',
      [avatar_prompt.trim(), id]
    );
    res.json({ success: true, id, avatar_prompt: avatar_prompt.trim() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/28property/avatar/:id', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await db.query('DELETE FROM property_agent_images WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/28property/avatars', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, filename, agent_name, avatar_prompt, user_email, created_at
       FROM property_agent_images
       ORDER BY created_at DESC
       LIMIT 50`
    );
    const avatars = result.rows.map(r => ({
      id: r.id,
      filename: r.filename,
      agent_name: r.agent_name || '',
      avatar_prompt: r.avatar_prompt || '',
      user_email: r.user_email || '',
      created_at: r.created_at,
      image_url: `${API_BASE_URL}/28property/image/${r.id}`
    }));
    res.json({ success: true, avatars });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/28property/jobs', authMiddleware, async (req, res) => {
  try {
    const data = await atFetch(
      `/${AIRTABLE_PROPERTY}?maxRecords=50&sort[0][field]=no&sort[0][direction]=desc`
    );
    res.json({ success: true, records: data.records || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════
// RESEARCH ROUTES
// ══════════════════════════════════════════════════════════

app.post('/research/start', authMiddleware, async (req, res) => {
  try {
    const { funnel, image_id, agent_name, property_url } = req.body;
    const sessionId = require('crypto').randomBytes(24).toString('hex');

    await db.query(
      `INSERT INTO research_sessions (session_id, user_email, funnel, image_id, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [sessionId, req.user.email || '', funnel || '', image_id || null]
    );

    const payload = {
      action:          'get_details',
      session_id:      sessionId,
      funnel:          funnel || '',
      image_id:        image_id || null,
      agent_name:      agent_name || '',
      property_url:    property_url || '',
      agent_image_url: image_id ? `${API_BASE_URL}/28property/image/${image_id}` : '',
      user_email:      req.user.email || '',
      user_name:       req.user.name  || '',
      callback_url:    `${API_BASE_URL}/notify/research`,
      triggered_at:    new Date().toISOString()
    };

    const webhookPayload = JSON.stringify(payload);
    console.log('Firing webhook:', WEBHOOK);

    res.json({ success: true, session_id: sessionId });

    fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: webhookPayload
    })
    .then(async (webhookRes) => {
      const text = await webhookRes.text();
      console.log('n8n research webhook status:', webhookRes.status, text);
    })
    .catch(err => console.error('n8n research webhook FAILED:', err.message));
  } catch (err) {
    console.error('research/start error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// FIX 2: Store property_data in DB so frontend can recover missed SSE events
app.post('/notify/research', async (req, res) => {
  try {
    const { session_id, property } = req.body;
    if (!session_id || !property)
      return res.status(400).json({ success: false, error: 'session_id and property required' });

    // Store property JSON in DB for session recovery
    await db.query(
      `UPDATE research_sessions SET status = 'property_ready', property_data = $2 WHERE session_id = $1`,
      [session_id, JSON.stringify(property)]
    );

    const payload = JSON.stringify({
      type:       'research_property',
      session_id,
      property
    });

    // FIX 1: use sseWrite which calls flush()
    sseBroadcast(payload);
    var total = 0; clients.forEach(function(s){ total += s.size; }); res.json({ success: true, notified: total });
  } catch (err) {
    console.error('notify/research error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/research/select', authMiddleware, async (req, res) => {
  try {
    const { session_id, chosen_topic, chosen_index } = req.body;
    if (!session_id || !chosen_topic)
      return res.status(400).json({ success: false, error: 'session_id and chosen_topic required' });

    await db.query(
      `UPDATE research_sessions SET status = 'topic_selected', chosen_topic = $2
       WHERE session_id = $1`,
      [session_id, chosen_topic]
    );

    res.json({ success: true, session_id, chosen_topic });
  } catch (err) {
    console.error('research/select error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// FIX 3: Enhanced session endpoint returns parsed property + topics for frontend recovery
app.get('/research/session/:session_id', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM research_sessions WHERE session_id = $1',
      [req.params.session_id]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ success: false, error: 'Session not found' });

    const row = result.rows[0];

    // Parse JSONB fields — Postgres driver may return them already parsed or as strings
    const parseJsonField = (val) => {
      if (!val) return null;
      if (typeof val === 'object') return val;
      try { return JSON.parse(val); } catch { return null; }
    };

    res.json({
      success:  true,
      session:  row,
      property: parseJsonField(row.property_data),
      topics:   parseJsonField(row.topics_data),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/research/topics', authMiddleware, async (req, res) => {
  try {
    const { session_id, property, agent_name, agent_prompt } = req.body;
    if (!session_id) return res.status(400).json({ success: false, error: 'session_id required' });

    // Clear old topics_data so poll doesn't return stale data
    await db.query(
      `UPDATE research_sessions SET topics_data = NULL, status = 'topics_pending' WHERE session_id = $1`,
      [session_id]
    ).catch(err => console.error('topics clear error:', err.message));

    res.json({ success: true, session_id });

    const payload = JSON.stringify({
      action:       'get_topics',
      session_id,
      property,
      agent_name:   agent_name || '',
      agent_prompt: agent_prompt || '',
      callback_url: `${API_BASE_URL}/notify/topics`,
      user_email:   req.user.email || '',
      triggered_at: new Date().toISOString()
    });

    fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    })
    .then(async (r) => { const t = await r.text(); console.log('topics webhook:', r.status, t); })
    .catch(err => console.error('topics webhook FAILED:', err.message));

  } catch (err) {
    console.error('research/topics error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// FIX 2: Store topics_data in DB so frontend can recover missed SSE events
app.post('/notify/topics', async (req, res) => {
  try {
    const { session_id, topics } = req.body;
    if (!session_id || !topics || !Array.isArray(topics))
      return res.status(400).json({ success: false, error: 'session_id and topics array required' });

    // Store topics in DB for session recovery
    await db.query(
      `UPDATE research_sessions SET status = 'topics_ready', topics_data = $2 WHERE session_id = $1`,
      [session_id, JSON.stringify(topics)]
    ).catch(err => console.error('topics_data store error:', err.message));

    const payload = JSON.stringify({
      type: 'research_topics',
      session_id,
      topics
    });

    // FIX 1: use sseWrite which calls flush()
    sseBroadcast(payload);
    var total = 0; clients.forEach(function(s){ total += s.size; }); res.json({ success: true, notified: total });
  } catch (err) {
    console.error('notify/topics error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── AVATAR PROMPT — fires n8n webhook to analyse avatar + generate agent intro ──
app.post('/research/avatar-prompt', authMiddleware, async (req, res) => {
  try {
    const { avatar_url, agent_name, session_id, agent_prompt } = req.body;
    if (!avatar_url)
      return res.status(400).json({ success: false, error: 'avatar_url required' });

    res.json({ success: true, session_id });

    const payload = JSON.stringify({
      action:       'avatar_prompt',
      session_id:   session_id || '',
      avatar_url,
      agent_name:   agent_name || '',
      agent_prompt: agent_prompt || '',
      callback_url: `${API_BASE_URL}/notify/avatar-prompt`,
      user_email:   req.user.email || '',
      triggered_at: new Date().toISOString()
    });

    fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    })
    .then(async r => { const t = await r.text(); console.log('avatar_prompt webhook:', r.status, t); })
    .catch(err => console.error('avatar_prompt webhook FAILED:', err.message));

  } catch (err) {
    console.error('research/avatar-prompt error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/research/image-prompt', authMiddleware, async (req, res) => {
  try {
    const { session_id, property_image_url, avatar_url, prompt, action_type } = req.body;
    if (!session_id) return res.status(400).json({ success: false, error: 'session_id required' });

    const ALLOWED_ACTIONS = ['add_avatar', 'regen_prompt'];
    const action = ALLOWED_ACTIONS.includes(action_type) ? action_type : 'add_avatar';

    const callback_url = action === 'regen_prompt'
      ? `${API_BASE_URL}/notify/regen-prompt`
      : `${API_BASE_URL}/notify/result-image`;

    res.json({ success: true, session_id, action });

    const payload = JSON.stringify({
      action,
      session_id,
      property_image_url,
      avatar_url,
      prompt,
      callback_url,
      user_email:   req.user.email || '',
      triggered_at: new Date().toISOString()
    });

    fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    })
    .then(async r => { const t = await r.text(); console.log(`${action} webhook:`, r.status, t); })
    .catch(err => console.error(`${action} webhook FAILED:`, err.message));

  } catch (err) {
    console.error('research/image-prompt error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── NOTIFY AVATAR PROMPT — called by n8n after generating agent intro prompt ─
app.post('/notify/avatar-prompt', async (req, res) => {
  try {
    const { session_id, prompt } = req.body;
    if (!prompt)
      return res.status(400).json({ success: false, error: 'prompt required' });
    const payload = JSON.stringify({ type: 'avatar_prompt', session_id: session_id || '', prompt });
    sseBroadcast(payload);
    var total = 0; clients.forEach(function(s){ total += s.size; }); res.json({ success: true, notified: total });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/notify/regen-prompt', async (req, res) => {
  try {
    const { session_id, prompt } = req.body;
    if (!session_id || !prompt)
      return res.status(400).json({ success: false, error: 'session_id and prompt required' });

    const payload = JSON.stringify({ type: 'regen_prompt', session_id, prompt });
    // FIX 1: use sseWrite which calls flush()
    sseBroadcast(payload);
    var total = 0; clients.forEach(function(s){ total += s.size; }); res.json({ success: true, notified: total });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/notify/result-image', async (req, res) => {
  try {
    const { session_id, image_url } = req.body;
    if (!session_id || !image_url)
      return res.status(400).json({ success: false, error: 'session_id and image_url required' });

    const payload = JSON.stringify({ type: 'result_image', session_id, image_url });
    // FIX 1: use sseWrite which calls flush()
    sseBroadcast(payload);
    var total = 0; clients.forEach(function(s){ total += s.size; }); res.json({ success: true, notified: total });
  } catch (err) {
    console.error('notify/result-image error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/compose-image', authMiddleware, async (req, res) => {
  try {
    const { property_image_url, avatar_image_url, avatar_x_pct = 0.03, avatar_y_pct = 0.75 } = req.body;
    if (!property_image_url || !avatar_image_url)
      return res.status(400).json({ success: false, error: 'Both image URLs required' });

    const sharp = require('sharp');

    const [propRes, avRes] = await Promise.all([
      fetch(property_image_url),
      fetch(avatar_image_url)
    ]);
    const propBuf = Buffer.from(await propRes.arrayBuffer());
    const avBuf   = Buffer.from(await avRes.arrayBuffer());

    const propMeta = await sharp(propBuf).metadata();
    const W = propMeta.width;
    const H = propMeta.height;

    const avSize = Math.round(W * 0.18);
    const x      = Math.round(avatar_x_pct * W);
    const y      = Math.round(avatar_y_pct * H);

    const borderW   = 4;
    const totalSize = avSize + borderW * 2;
    const circleMask = Buffer.from(
      `<svg width="${avSize}" height="${avSize}"><circle cx="${avSize/2}" cy="${avSize/2}" r="${avSize/2}" fill="white"/></svg>`
    );

    const avCircle = await sharp(avBuf)
      .resize(avSize, avSize, { fit: 'cover', position: 'top' })
      .composite([{ input: circleMask, blend: 'dest-in' }])
      .png()
      .toBuffer();

    const borderCircle = Buffer.from(
      `<svg width="${totalSize}" height="${totalSize}"><circle cx="${totalSize/2}" cy="${totalSize/2}" r="${totalSize/2}" fill="white"/></svg>`
    );

    const result = await sharp(propBuf)
      .composite([
        { input: borderCircle, left: x - borderW, top: y - borderW, blend: 'over' },
        { input: avCircle,     left: x,            top: y,           blend: 'over' }
      ])
      .jpeg({ quality: 92 })
      .toBuffer();

    const dataUrl = 'data:image/jpeg;base64,' + result.toString('base64');
    res.json({ success: true, image_url: dataUrl });

  } catch (err) {
    console.error('compose-image error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ══════════════════════════════════════════════════════════
// AI RECRUITMENT ROUTES
// ══════════════════════════════════════════════════════════

const REC_WEBHOOK = 'https://primary-production-ab4a6.up.railway.app/webhook/ai-recruitment';

// Fire any action to the ai-recruitment n8n webhook
app.post('/recruitment/fire', authMiddleware, async (req, res) => {
  try {
    const payload = req.body;
    if (!payload.action) return res.status(400).json({ success: false, error: 'action required' });
    res.json({ success: true, action: payload.action });
    fetch(REC_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    .then(async r => { const t = await r.text(); console.log('[rec webhook]', payload.action, r.status, t.slice(0,120)); })
    .catch(err => console.error('[rec webhook] FAILED:', err.message));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// n8n callback — topics ready
app.post('/notify/rec-topics', async (req, res) => {
  try {
    const { session_id, topics } = req.body;
    if (!topics || !Array.isArray(topics))
      return res.status(400).json({ success: false, error: 'topics array required' });
    const payload = JSON.stringify({ type: 'rec_topics', session_id: session_id || '', topics });
    sseBroadcast(payload);
    // Persist topics to DB if session exists
    if (session_id) {
      await db.query(
        `UPDATE research_sessions SET topics_data = $2, status = 'topics_ready' WHERE session_id = $1`,
        [session_id, JSON.stringify(topics)]
      ).catch(() => {});
    }
    var total = 0; clients.forEach(function(s){ total += s.size; }); res.json({ success: true, notified: total });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// n8n callback — script/scenes ready
app.post('/notify/rec-script', async (req, res) => {
  try {
    const { session_id, scenes } = req.body;
    if (!scenes || !Array.isArray(scenes))
      return res.status(400).json({ success: false, error: 'scenes array required' });
    const payload = JSON.stringify({ type: 'rec_script', session_id: session_id || '', scenes });
    sseBroadcast(payload);
    var total = 0; clients.forEach(function(s){ total += s.size; }); res.json({ success: true, notified: total });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// ══════════════════════════════════════════════════════════
// HOME FEED — role-filtered job status
// ══════════════════════════════════════════════════════════

app.get('/home/feed', authMiddleware, async (req, res) => {
  try {
    const role = req.user.role || '28property_editor';

    // Admin → redirect to dashboard (frontend handles this, but also return signal)
    if (role === 'admin') {
      return res.json({ success: true, role, redirect: '/dashboard' });
    }

    // Management → gets both pipelines summary
    // 28property_editor → only 28property Airtable jobs
    // recruitment_editor → only recruitment sessions from Postgres

    const feed = { role, sections: [] };

    // ── 28PROPERTY jobs (Airtable) ──────────────────────────
    if (role === '28property_editor' || role === 'management') {
      const data = await atFetch(
        `/${AIRTABLE_PROPERTY}?maxRecords=50&sort[0][field]=no&sort[0][direction]=desc`
      );
      const records = data.records || [];
      const jobs = records.map(r => ({
        id:         r.id,
        no:         r.fields.no         || '',
        title:      r.fields.title       || r.fields.property_url || '—',
        status:     r.fields.status      || 'Unknown',
        agent:      r.fields.agent_name  || '',
        created_at: r.fields.created_at  || r.createdTime || '',
        url:        r.fields.property_url || ''
      }));
      const running   = jobs.filter(j => j.status === 'In Progress');
      const errors    = jobs.filter(j => j.status === 'Error');
      const completed = jobs.filter(j => j.status === 'Completed').slice(0, 10);

      feed.sections.push({
        pipeline: '28property',
        label:    '28Property',
        running,
        errors,
        completed
      });
    }

    // ── RECRUITMENT sessions (Postgres) ─────────────────────
    if (role === 'recruitment_editor' || role === 'management') {
      const result = await db.query(
        `SELECT session_id, user_email, status, chosen_topic, property_data, topics_data, created_at
         FROM research_sessions
         WHERE funnel = 'ai-recruitment'
         ORDER BY created_at DESC
         LIMIT 50`
      );
      const sessions = result.rows.map(r => {
        const prop = r.property_data ? (typeof r.property_data === 'string' ? JSON.parse(r.property_data) : r.property_data) : null;
        return {
          id:           r.session_id,
          title:        (prop && prop.title) || r.chosen_topic || r.session_id.slice(0,12) + '…',
          status:       r.status || 'pending',
          user_email:   r.user_email || '',
          created_at:   r.created_at || ''
        };
      });
      const running   = sessions.filter(s => ['pending','property_ready','topics_ready','topic_selected'].includes(s.status));
      const completed = sessions.filter(s => s.status === 'completed').slice(0, 10);
      const errors    = sessions.filter(s => s.status === 'error');

      feed.sections.push({
        pipeline:  'recruitment',
        label:     'AI Recruitment',
        running,
        errors,
        completed
      });
    }

    res.json({ success: true, ...feed });
  } catch (err) {
    console.error('home/feed error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ══════════════════════════════════════════════════════════
// USER SESSION ROUTES — persist frontend session to Postgres
// ══════════════════════════════════════════════════════════

// Save session — upsert by user_email + funnel
app.post('/session/save', authMiddleware, async (req, res) => {
  try {
    const { funnel, session_data } = req.body;
    if (!funnel || !session_data)
      return res.status(400).json({ success: false, error: 'funnel and session_data required' });

    await db.query(`
      INSERT INTO user_sessions (user_email, funnel, session_data, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (user_email, funnel)
      DO UPDATE SET session_data = $3, updated_at = NOW()
    `, [req.user.email, funnel, JSON.stringify(session_data)]);

    res.json({ success: true });
  } catch (err) {
    console.error('session/save error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Load session — get latest by user_email + funnel
app.get('/session/load', authMiddleware, async (req, res) => {
  try {
    const { funnel } = req.query;
    if (!funnel)
      return res.status(400).json({ success: false, error: 'funnel query param required' });

    const result = await db.query(
      'SELECT session_data, updated_at FROM user_sessions WHERE user_email = $1 AND funnel = $2',
      [req.user.email, funnel]
    );

    if (result.rows.length === 0)
      return res.json({ success: true, session: null });

    const row = result.rows[0];
    const data = typeof row.session_data === 'string'
      ? JSON.parse(row.session_data)
      : row.session_data;

    res.json({ success: true, session: data, updated_at: row.updated_at });
  } catch (err) {
    console.error('session/load error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Clear session — delete by user_email + funnel
app.delete('/session/clear', authMiddleware, async (req, res) => {
  try {
    const { funnel } = req.body;
    if (!funnel)
      return res.status(400).json({ success: false, error: 'funnel required' });

    await db.query(
      'DELETE FROM user_sessions WHERE user_email = $1 AND funnel = $2',
      [req.user.email, funnel]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// ══════════════════════════════════════════════════════════
// 28PROPERTY JOB DETAILS — receives pipeline payload from
// frontend and forwards to n8n /webhook/28property-job-details
// ══════════════════════════════════════════════════════════

const JOB_DETAILS_WEBHOOK = 'https://primary-production-ab4a6.up.railway.app/webhook/28property';

app.post('/28property/start-pipeline', authMiddleware, async (req, res) => {
  try {
    const payload = {
      ...req.body,
      action:      'start_pipeline',
      user_email:  req.user.email || '',
      user_name:   req.user.name  || '',
      user_role:   req.user.role  || '',
      triggered_at: new Date().toISOString()
    };

    // Respond immediately so frontend doesn't wait
    res.json({ success: true, message: 'Pipeline triggered' });

    fetch(JOB_DETAILS_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    .then(async r => { const t = await r.text(); console.log('[job-details webhook]', r.status, t.slice(0, 120)); })
    .catch(err => console.error('[job-details webhook] FAILED:', err.message));

  } catch (err) {
    console.error('28property/start-pipeline error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});


// n8n callback — pipeline ready (scenes + script generated)
app.post('/notify/pipeline-ready', async (req, res) => {
  try {
    const { session_id, scenes, property, images, topic, agent_name, avatar_url, user_email, scene_count } = req.body;
    if (!scenes || !Array.isArray(scenes))
      return res.status(400).json({ success: false, error: 'scenes array required' });

    const payload = JSON.stringify({
      type: 'pipeline_ready',
      session_id: session_id || '',
      scenes,
      scene_count: scene_count || scenes.length,
      property,
      images,
      topic,
      agent_name,
      avatar_url,
      user_email
    });

    sseBroadcast(payload);
    var total = 0; clients.forEach(function(s){ total += s.size; }); res.json({ success: true, notified: total });
  } catch (err) {
    console.error('notify/pipeline-ready error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ── AI REGEN LINE — fires n8n, result comes back via SSE ──────────────────────
app.post('/28property/regen-line', authMiddleware, async (req, res) => {
  try {
    const { lang, scene_number, current_line, full_script, instruction, job_title, scene_id, col } = req.body;

    // Respond immediately — result will come back via SSE /notify/regen-line
    res.json({ success: true, message: 'Regenerating...' });

    fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action:       'regen_line',
        lang:          lang || 'EN',
        scene_number,
        current_line,
        full_script,
        instruction:  instruction || '',
        job_title:    job_title || '',
        scene_id:     scene_id || '',
        col:          col || '',
        user_email:   req.user.email || '',
        triggered_at: new Date().toISOString()
      })
    })
    .then(async r => { const t = await r.text(); console.log('[regen-line webhook]', r.status, t.slice(0,100)); })
    .catch(err => console.error('[regen-line webhook] FAILED:', err.message));

  } catch (err) {
    console.error('regen-line error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// n8n callback — regenned line ready, push via SSE + store in DB for polling
app.post('/notify/regen-line', async (req, res) => {
  try {
    const { session_id, scene_id, col, new_line } = req.body;
    if (!new_line) return res.status(400).json({ success: false, error: 'new_line required' });

    // Store in DB so frontend can poll if SSE missed
    await db.query(
      `INSERT INTO regen_results (scene_id, col, new_line) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [scene_id || '', col || '', new_line]
    ).catch(() => {});

    // Broadcast via SSE
    const payload = JSON.stringify({ type: 'regen_line', session_id: session_id || '', scene_id, col, new_line });
    sseBroadcast(payload);
    var _total = 0; clients.forEach(function(s){ _total += s.size; }); res.json({ success: true, notified: _total });
  } catch (err) {
    console.error('notify/regen-line error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Poll for regen result — frontend calls this if SSE missed
app.get('/regen-result/:scene_id/:col', authMiddleware, async (req, res) => {
  try {
    const { scene_id, col } = req.params;
    const result = await db.query(
      `SELECT new_line FROM regen_results WHERE scene_id = $1 AND col = $2
       ORDER BY created_at DESC LIMIT 1`,
      [scene_id, col]
    );
    if (result.rows.length === 0) return res.json({ success: true, ready: false });
    // Delete after reading so it's one-shot
    await db.query('DELETE FROM regen_results WHERE scene_id = $1 AND col = $2', [scene_id, col]);
    res.json({ success: true, ready: true, new_line: result.rows[0].new_line });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// ── REGEN TOPIC PART — rewrites title or body using GPT directly ─────────────
app.post('/28property/regen-topic', authMiddleware, async (req, res) => {
  try {
    const { part, current_title, current_body, property_title, property_desc, agent_name } = req.body;

    const context = `Property: ${property_title || ''}
Agent: ${agent_name || ''}
Description: ${property_desc || ''}

Current Title: ${current_title || ''}
Current Body: ${current_body || ''}`;

    const prompt = part === 'title'
      ? `You are a real estate content writer. Rewrite ONLY the title below to be more engaging and SEO-friendly. Keep it concise (under 80 characters). Return ONLY the new title, nothing else.

Context:
${context}

Rewrite the title only:`
      : `You are a real estate content writer. Rewrite ONLY the body text below to be more engaging, persuasive and well-structured. Keep the same key facts. Return ONLY the new body text, nothing else.

Context:
${context}

Rewrite the body only:`;

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer \${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: part === 'title' ? 100 : 800,
        temperature: 0.8
      })
    });

    const data = await r.json();
    const result = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!result) return res.json({ success: false, error: 'No result from GPT' });
    res.json({ success: true, result: result.trim() });
  } catch (err) {
    console.error('regen-topic error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
