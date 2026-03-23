const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();

// ── CORS ──────────────────────────────────────────────────
app.use(function(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
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
const AIRTABLE_PAT      = process.env.AIRTABLE_PAT;
const API_BASE_URL      = process.env.API_BASE_URL || 'https://superbiller-api-production.up.railway.app';
const PROPERTY_WEBHOOK  = 'https://primary-production-ab4a6.up.railway.app/webhook/28property';

// ── SETUP DB ──────────────────────────────────────────────
async function setupDB() {
  // Users table
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

  // 28Property agent images table
  await db.query(`
    CREATE TABLE IF NOT EXISTS property_agent_images (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255),
      mime_type VARCHAR(100),
      data BYTEA NOT NULL,
      agent_name VARCHAR(200),
      user_email VARCHAR(200),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  console.log('DB ready');
}
setupDB().catch(console.error);

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

// ── HEALTH ────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date() }));

// ══════════════════════════════════════════════════════════
// AUTH ROUTES
// ══════════════════════════════════════════════════════════

app.post('/auth/register', async (req, res) => {
  try {
    const { name, email, password, role = 'editor' } = req.body;
    if (!name || !email || !password)
      return res.json({ success: false, message: 'Name, email and password are required' });
    if (password.length < 6)
      return res.json({ success: false, message: 'Password must be at least 6 characters' });
    const allowedDomains = ['@superbiller.com', '@recruitmenttraining'];
    if (!allowedDomains.some(d => email.endsWith(d)))
      return res.json({ success: false, message: 'Invalid business email.' });
    const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0)
      return res.json({ success: false, message: 'Email already registered' });
    const hash = await bcrypt.hash(password, 10);
    const result = await db.query(
      'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, name, email, role',
      [name, email, hash, role]
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
const clients = new Map();

app.get('/events', (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(401).end();
  let user;
  try { user = jwt.verify(token, JWT_SECRET); } catch { return res.status(401).end(); }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const userId = user.id;
  clients.set(userId, res);

  const ping = setInterval(() => res.write(':\n\n'), 30000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(userId);
  });
});

// ── NOTIFY — called by N8N when scene status changes ─────
app.post('/notify/scene', async (req, res) => {
  try {
    const { record_id, status, task } = req.body;
    if (!record_id || !status)
      return res.status(400).json({ success: false, error: 'record_id and status required' });
    const payload = JSON.stringify({ record_id, status, task: task || '' });
    clients.forEach((clientRes) => { clientRes.write(`data: ${payload}\n\n`); });
    res.json({ success: true, notified: clients.size });
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
        status: f.status || null,
        image: f.image || null,
        audio_EN: f.audio_EN || null,
        audio_TH: f.audio_TH || null,
        video_EN: f.video_EN || null,
        full_audio_EN: f.full_audio_EN || null,
        full_audio_TH: f.full_audio_TH || null,
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
      'image_prompt', 'negative_prompt',
      'Generate', 'image', 'status', 'task',
      'audio_EN', 'audio_TH', 'video_EN', 'full_audio_EN', 'full_audio_TH'
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

// ── UPLOAD AGENT PHOTO ───────────────────────────────────
// POST /28property/upload  (multipart: file, agent_name?)
// Stores image as BYTEA in Postgres, returns image_id + public URL
app.post('/28property/upload', authMiddleware, async (req, res) => {
  try {
    const body = req.rawBody;
    if (!body) return res.status(400).json({ success: false, error: 'No body received' });

    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)$/);
    if (!boundaryMatch) return res.status(400).json({ success: false, error: 'No boundary in content-type' });
    const boundary = boundaryMatch[1].trim();

    const parts = body.toString('binary').split('--' + boundary);
    let fileBuffer = null;
    let fileName    = 'agent-photo';
    let mimeType    = 'image/jpeg';
    let agentName   = '';

    for (const part of parts) {
      if (!part.includes('Content-Disposition')) continue;
      const nameMatch     = part.match(/name="([^"]+)"/);
      const filenameMatch = part.match(/filename="([^"]+)"/);
      const ctMatch       = part.match(/Content-Type: ([^\r\n]+)/);
      const name          = nameMatch ? nameMatch[1] : '';
      const headerEnd     = part.indexOf('\r\n\r\n');
      if (headerEnd === -1) continue;
      const value = part.slice(headerEnd + 4, part.lastIndexOf('\r\n'));

      if (name === 'agent_name') {
        agentName = value.trim();
      } else if (filenameMatch) {
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
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
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

// ── SERVE AGENT PHOTO ────────────────────────────────────
// GET /28property/image/:id  (public — no auth, so n8n can fetch it)
app.get('/28property/image/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id || isNaN(id))
      return res.status(400).json({ error: 'Invalid image ID' });

    const result = await db.query(
      'SELECT data, mime_type, filename FROM property_agent_images WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0)
      return res.status(404).json({ error: 'Image not found' });

    const { data, mime_type, filename } = result.rows[0];
    res.setHeader('Content-Type', mime_type);
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(data);
  } catch (err) {
    console.error('28property image serve error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── START VIDEO PRODUCTION ───────────────────────────────
// POST /28property/start
// Body: { property_url, image_id, agent_name }
// Fires n8n webhook with all data including the public image URL
app.post('/28property/start', authMiddleware, async (req, res) => {
  try {
    const { property_url, image_id, agent_name } = req.body;

    if (!property_url)
      return res.status(400).json({ success: false, error: 'property_url is required' });
    if (!image_id)
      return res.status(400).json({ success: false, error: 'image_id is required — upload photo first' });

    const imgCheck = await db.query(
      'SELECT id FROM property_agent_images WHERE id = $1',
      [parseInt(image_id)]
    );
    if (imgCheck.rows.length === 0)
      return res.status(400).json({ success: false, error: 'Image not found — please re-upload' });

    const agent_image_url = `${API_BASE_URL}/28property/image/${image_id}`;

    const payload = {
      property_url,
      agent_image_url,
      agent_name:   agent_name  || '',
      user_email:   req.user.email || '',
      user_name:    req.user.name  || '',
      triggered_at: new Date().toISOString()
    };

    const r = await fetch(PROPERTY_WEBHOOK, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload)
    });

    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    res.json({ success: true, n8n: data, payload_sent: payload });
  } catch (err) {
    console.error('28property start error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── LIST RECENT JOBS (per user) ───────────────────────────
// GET /28property/jobs
app.get('/28property/jobs', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, filename, mime_type, agent_name, user_email, created_at
       FROM property_agent_images
       WHERE user_email = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [req.user.email]
    );
    res.json({ success: true, records: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
