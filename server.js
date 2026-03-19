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
const N8N_WEBHOOK     = process.env.N8N_WEBHOOK_URL;
const AIRTABLE_BASE   = 'appwGBvGSWNq8BLfh';
const AIRTABLE_TABLE  = 'tbliHRJwRfrQckb55';         // n8n_video
const AIRTABLE_SCRIPT = 'tblj00M8en7pmuwOn';         // Script Refiner Agent
const AIRTABLE_PROD   = process.env.AIRTABLE_PROD_TABLE || 'video_production';
const AIRTABLE_PAT    = process.env.AIRTABLE_PAT;

// ── AIRTABLE HELPER ───────────────────────────────────────
async function atFetch(path, opts = {}) {
  const r = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}${path}`, {
    ...opts,
    headers: { 'Authorization': `Bearer ${AIRTABLE_PAT}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  return r.json();
}

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
    const data = await atFetch(`/${AIRTABLE_TABLE}`, {
      method: 'POST',
      body: JSON.stringify({ fields: {
        'Industry ( **required** )': industry,
        'search_focus ( **required** )': search_focus,
        'pipeline ( **required** )': pipeline,
        'status ( **required** )': status
      }})
    });
    res.json({ success: true, record: data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── AIRTABLE — get videos ─────────────────────────────────
app.get('/airtable/videos', async (req, res) => {
  try {
    const data = await atFetch(`/${AIRTABLE_TABLE}?maxRecords=100&sort[0][field]=created_at&sort[0][direction]=desc`);
    res.json({ success: true, records: data.records });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── AIRTABLE — update record ──────────────────────────────
app.post('/airtable/update', async (req, res) => {
  try {
    const { record_id, fields } = req.body;
    const data = await atFetch(`/${AIRTABLE_TABLE}/${record_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields })
    });
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

// ── DASHBOARD — pipeline overview ────────────────────────
// Returns all videos grouped by stage with counts + stuck flags
app.get('/dashboard/pipeline', async (req, res) => {
  try {
    const data = await atFetch(`/${AIRTABLE_TABLE}?maxRecords=200&sort[0][field]=created_at&sort[0][direction]=desc`);
    const records = data.records || [];

    const stages = {
      'Start': [],
      'In Progress': [],
      'Completed': [],
      'Error': [],
      'Retry': []
    };

    let pendingReview = 0, approved = 0, rejected = 0;
    const now = Date.now();

    records.forEach(r => {
      const f = r.fields;
      const status = f['status ( **required** )'] || 'Start';
      const scriptStatus = f['script_status'] || '';
      const stage = f['stage : agent_name'] || '—';
      const createdAt = f['created_at'] ? new Date(f['created_at']).getTime() : now;
      const hoursOld = (now - createdAt) / 1000 / 3600;

      const item = {
        id: r.id,
        industry: f['Industry ( **required** )'] || '—',
        title: f['title'] || null,
        status,
        stage,
        script_status: scriptStatus,
        pipeline: f['pipeline ( **required** )'] || '—',
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
      success: true,
      total: records.length,
      counts: {
        start: stages['Start'].length,
        in_progress: stages['In Progress'].length,
        completed: stages['Completed'].length,
        error: stages['Error'].length,
        retry: stages['Retry'].length
      },
      script_counts: { pending_review: pendingReview, approved, rejected },
      stuck: records.filter(r => {
        const f = r.fields;
        const hoursOld = f['created_at'] ? (now - new Date(f['created_at']).getTime()) / 3600000 : 0;
        return hoursOld > 24 && f['status ( **required** )'] === 'In Progress';
      }).map(r => ({ id: r.id, industry: r.fields['Industry ( **required** )'], hours_old: Math.round((now - new Date(r.fields['created_at']).getTime()) / 3600000) })),
      stages,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── DASHBOARD — metrics summary ───────────────────────────
// Key numbers the director sees at top: velocity, pass rate, etc.
app.get('/dashboard/metrics', async (req, res) => {
  try {
    const data = await atFetch(`/${AIRTABLE_TABLE}?maxRecords=200&sort[0][field]=created_at&sort[0][direction]=desc`);
    const records = data.records || [];
    const now = Date.now();

    // Videos completed in last 7 days
    const last7d = records.filter(r => {
      const f = r.fields;
      const created = f['created_at'] ? new Date(f['created_at']).getTime() : 0;
      return (now - created) < 7 * 24 * 3600000 && f['status ( **required** )'] === 'Completed';
    });

    // Videos completed today
    const today = records.filter(r => {
      const f = r.fields;
      const created = f['created_at'] ? new Date(f['created_at']).getTime() : 0;
      return (now - created) < 24 * 3600000 && f['status ( **required** )'] === 'Completed';
    });

    const completed = records.filter(r => r.fields['status ( **required** )'] === 'Completed');
    const approvedScripts = records.filter(r => r.fields['script_status'] === 'Approved');
    const qualityPassRate = completed.length > 0 ? Math.round((approvedScripts.length / completed.length) * 100) : 0;
    const avgPerDay = last7d.length > 0 ? Math.round((last7d.length / 7) * 10) / 10 : 0;

    res.json({
      success: true,
      total_videos: records.length,
      completed_total: completed.length,
      completed_last_7d: last7d.length,
      completed_today: today.length,
      avg_per_day: avgPerDay,
      quality_pass_rate: qualityPassRate,
      pending_review: records.filter(r => r.fields['script_status'] === 'Pending Review').length,
      errors: records.filter(r => r.fields['status ( **required** )'] === 'Error').length,
      in_progress: records.filter(r => r.fields['status ( **required** )'] === 'In Progress').length
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── DASHBOARD — scripts (Script Refiner table) ────────────
// All scripts with professional/casual EN/TH + approval status
app.get('/dashboard/scripts', async (req, res) => {
  try {
    const data = await atFetch(`/${AIRTABLE_SCRIPT}?maxRecords=100&sort[0][field]=id&sort[0][direction]=desc`);
    res.json({ success: true, records: data.records || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── DASHBOARD — approve / reject script ──────────────────
app.post('/dashboard/script/approve', async (req, res) => {
  try {
    const { record_id, action } = req.body; // action: 'Approved' | 'Rejected'
    // Update Script Refiner table
    const scriptUpdate = await atFetch(`/${AIRTABLE_SCRIPT}/${record_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields: { status: action } })
    });
    // Also update n8n_video table if linked
    const scriptRecord = scriptUpdate;
    const n8nVideoId = scriptRecord.fields?.n8n_video?.[0];
    if (n8nVideoId) {
      await atFetch(`/${AIRTABLE_TABLE}/${n8nVideoId}`, {
        method: 'PATCH',
        body: JSON.stringify({ fields: { 'script_status': action } })
      });
    }
    res.json({ success: true, record: scriptUpdate });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── DASHBOARD — retry errored videos ─────────────────────
app.post('/dashboard/retry', async (req, res) => {
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

// ── DASHBOARD — weekly output chart data ─────────────────
app.get('/dashboard/weekly', async (req, res) => {
  try {
    const data = await atFetch(`/${AIRTABLE_TABLE}?maxRecords=500&sort[0][field]=created_at&sort[0][direction]=desc`);
    const records = data.records || [];
    const now = Date.now();
    const weeks = [];

    for (let i = 7; i >= 0; i--) {
      const weekStart = now - (i + 1) * 7 * 24 * 3600000;
      const weekEnd   = now - i * 7 * 24 * 3600000;
      const count = records.filter(r => {
        const created = r.fields['created_at'] ? new Date(r.fields['created_at']).getTime() : 0;
        return created >= weekStart && created < weekEnd && r.fields['status ( **required** )'] === 'Completed';
      }).length;
      weeks.push({ week: `W${8 - i}`, count });
    }

    res.json({ success: true, weeks });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
