const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());

// ── CORS ──────────────────────────────────────────────────
app.use(function(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── POSTGRES ──────────────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ── CONFIG ────────────────────────────────────────────────
const JWT_SECRET      = process.env.JWT_SECRET || 'superbiller-secret-change-me';
const N8N_WEBHOOK     = process.env.N8N_WEBHOOK_URL;
const AIRTABLE_BASE   = 'appwGBvGSWNq8BLfh';
const AIRTABLE_TABLE  = 'tbliHRJwRfrQckb55';  // n8n_video
const AIRTABLE_SCENES = 'tblbtxQHxqIlsMrSd';  // video_production
const AIRTABLE_SCRIPT = 'tblj00M8en7pmuwOn';
const AIRTABLE_PAT    = process.env.AIRTABLE_PAT;

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
    const { industry, search_focus, pipeline, status = 'Start', user_email } = req.body;
    const data = await atFetch(`/${AIRTABLE_TABLE}`, {
      method: 'POST',
      body: JSON.stringify({ fields: {
        'Industry ( **required** )': industry,
        'search_focus ( **required** )': search_focus,
        'pipeline ( **required** )': pipeline,
        'status ( **required** )': status,
        'user': user_email || req.user.email || ''
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
    const data = await atFetch(`/${AIRTABLE_TABLE}/${record_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields })
    });
    res.json({ success: true, record: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════
// SCENE ROUTES
// ══════════════════════════════════════════════════════════

// DEBUG — see raw fields from video_production (remove after debugging)
app.get('/airtable/scenes/debug', authMiddleware, async (req, res) => {
  try {
    const data = await atFetch(`/${AIRTABLE_SCENES}?maxRecords=3`);
    res.json({ success: true, records: data.records });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET scenes
app.get('/airtable/scenes', authMiddleware, async (req, res) => {
  try {
    const jobNo = req.query.job_no;
    if (!jobNo)
      return res.status(400).json({ success: false, error: 'job_no query param required' });

    const fields = [
      'scene_number', 'scene_type', 'pacing',
      'estimated_duration_secs', 'scene_purpose',
      'voiceover_sync_EN', 'voiceover_sync_TH',
      'image_prompt', 'negative_prompt', 'Approval'
    ];
    const fieldParams = fields.map(f => `fields[]=${encodeURIComponent(f)}`).join('&');
    const filter = encodeURIComponent(`{n8n_video_row}=${jobNo}`);

    const data = await atFetch(
      `/${AIRTABLE_SCENES}?maxRecords=200&filterByFormula=${filter}&sort[0][field]=scene_number&sort[0][direction]=asc&${fieldParams}`
    );
    res.json({ success: true, records: data.records || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// UPDATE scene
app.post('/airtable/scene/update', authMiddleware, async (req, res) => {
  try {
    const { record_id, fields } = req.body;
    if (!record_id || !fields)
      return res.status(400).json({ success: false, error: 'record_id and fields required' });
    const allowed = ['image_prompt', 'negative_prompt', 'Approval'];
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

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
