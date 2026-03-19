const express = require('express');
const { Pool } = require('pg');

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
const N8N_WEBHOOK     = 'https://primary-production-ab4a6.up.railway.app/webhook/video';
const AIRTABLE_BASE   = 'appwGBvGSWNq8BLfh';
const AIRTABLE_TABLE  = 'tbliHRJwRfrQckb55';
const AIRTABLE_PAT    = process.env.AIRTABLE_PAT;

// ── HEALTH ────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date() }));

// ── PROXY → N8N ───────────────────────────────────────────
app.post('/video', async (req, res) => {
  try {
    const r = await fetch(N8N_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    res.json({ success: true, n8n: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── AIRTABLE — create video ───────────────────────────────
app.post('/airtable/video', async (req, res) => {
  try {
    const { industry, search_focus, pipeline, status = 'Start' } = req.body;
    const r = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${AIRTABLE_PAT}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: {
        'Industry ( **required** )': industry,
        'search_focus ( **required** )': search_focus,
        'pipeline ( **required** )': pipeline,
        'status ( **required** )': status
      }})
    });
    const data = await r.json();
    res.json({ success: true, record: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── AIRTABLE — get videos ─────────────────────────────────
app.get('/airtable/videos', async (req, res) => {
  try {
    const r = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}?maxRecords=100&sort[0][field]=created_at&sort[0][direction]=desc`,
      { headers: { 'Authorization': `Bearer ${AIRTABLE_PAT}` } }
    );
    const data = await r.json();
    res.json({ success: true, records: data.records });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── AIRTABLE — update record ──────────────────────────────
app.post('/airtable/update', async (req, res) => {
  try {
    const { record_id, fields } = req.body;
    const r = await fetch(
      `https://api.airtable.com/v0/${AIRTABLE_BASE}/${AIRTABLE_TABLE}/${record_id}`,
      {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${AIRTABLE_PAT}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields })
      }
    );
    const data = await r.json();
    res.json({ success: true, record: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── AUTH — login via Postgres ─────────────────────────────
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await db.query(
      'SELECT id, name, email, role FROM users WHERE email = $1 AND password = $2 LIMIT 1',
      [email, password]
    );
    if (result.rows.length === 0) {
      return res.json({ success: false, message: 'Invalid credentials' });
    }
    const user = result.rows[0];
    res.json({ success: true, name: user.name, email: user.email, role: user.role });
  } catch (err) {
    // Users table not set up yet — pass through
    console.error('Auth error:', err.message);
    res.json({ success: true, name: req.body.email.split('@')[0], email: req.body.email, role: 'user' });
  }
});

// ── POSTGRES — raw query ──────────────────────────────────
app.post('/db/query', async (req, res) => {
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
