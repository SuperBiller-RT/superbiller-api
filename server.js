<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;0,9..40,800&display=swap" rel="stylesheet"/>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #f4f4f6; font-family: 'DM Sans', sans-serif; font-size: 14px; color: #111; }

.wrap { max-width: 660px; width: 100%; margin: 0 auto; padding: 40px 24px 60px; animation: fadeUp 0.3s ease both; }

.page-header { margin-bottom: 28px; display: flex; align-items: flex-start; justify-content: space-between; }
.page-title { font-size: 22px; font-weight: 800; color: #111; letter-spacing: -0.4px; margin-bottom: 4px; }
.page-sub { font-size: 13px; color: #888; }
.user-pill {
  display: flex; align-items: center; gap: 8px;
  background: #fff; border: 1px solid rgba(0,0,0,0.08);
  border-radius: 100px; padding: 6px 14px 6px 8px;
  font-size: 12px; font-weight: 500; color: #555;
  box-shadow: 0 1px 4px rgba(0,0,0,0.05);
}
.user-avatar {
  width: 24px; height: 24px; border-radius: 50%;
  background: #E8363D; color: #fff;
  display: flex; align-items: center; justify-content: center;
  font-size: 10px; font-weight: 800;
}
.signout-link { font-size: 11px; color: #E8363D; cursor: pointer; margin-left: 4px; }

.card { background: #fff; border: 1px solid rgba(0,0,0,0.08); border-radius: 16px; padding: 28px; box-shadow: 0 2px 8px rgba(0,0,0,0.04); margin-bottom: 16px; }
.card-title { font-size: 15px; font-weight: 700; color: #111; margin-bottom: 3px; }
.card-sub { font-size: 12px; color: #999; margin-bottom: 24px; }

.field { margin-bottom: 16px; }
.field label { display: block; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #aaa; margin-bottom: 6px; }
.field input, .field select, .field textarea {
  width: 100%; padding: 12px 14px;
  background: #fafafa; border: 1px solid rgba(0,0,0,0.11);
  border-radius: 9px; color: #111;
  font-family: 'DM Sans', sans-serif; font-size: 14px; outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.field input:focus, .field select:focus, .field textarea:focus {
  border-color: #E8363D; background: #fff;
  box-shadow: 0 0 0 3px rgba(232,54,61,0.08);
}
.field textarea { resize: vertical; min-height: 80px; line-height: 1.55; }
.hint { font-size: 11px; color: #bbb; margin-top: 4px; }

.pipeline-row { display: flex; gap: 10px; margin-bottom: 16px; }
.pipeline-opt { flex: 1; padding: 14px 12px; text-align: center; background: #fafafa; border: 1.5px solid rgba(0,0,0,0.1); border-radius: 10px; cursor: pointer; transition: all 0.15s; }
.pipeline-opt:hover { border-color: #E8363D; }
.pipeline-opt.selected { border-color: #E8363D; background: rgba(232,54,61,0.05); }
.pipeline-opt .pi { font-size: 22px; margin-bottom: 5px; }
.pipeline-opt .pl { font-size: 12px; font-weight: 600; color: #555; }
.pipeline-opt.selected .pl { color: #E8363D; }

.submit-row { display: flex; align-items: center; gap: 14px; margin-top: 20px; flex-wrap: wrap; }
.btn-submit { padding: 13px 28px; border-radius: 9px; background: #E8363D; border: none; color: #fff; font-family: 'DM Sans', sans-serif; font-size: 14px; font-weight: 700; cursor: pointer; display: flex; align-items: center; gap: 8px; box-shadow: 0 4px 12px rgba(232,54,61,0.28); transition: opacity 0.15s, transform 0.15s; }
.btn-submit:hover { opacity: 0.88; transform: translateY(-1px); }
.btn-submit:disabled { opacity: 0.5; cursor: not-allowed; transform: none; box-shadow: none; }
.submit-note { font-size: 12px; color: #bbb; }

.success-banner { display: none; margin-top: 16px; background: rgba(22,163,74,0.07); border: 1px solid rgba(22,163,74,0.2); border-radius: 9px; padding: 12px 16px; font-size: 13px; color: #16a34a; font-weight: 500; align-items: center; gap: 8px; }
.success-banner.show { display: flex; }
.err-banner { display: none; margin-top: 16px; background: rgba(232,54,61,0.06); border: 1px solid rgba(232,54,61,0.2); border-radius: 9px; padding: 12px 16px; font-size: 13px; color: #E8363D; font-weight: 500; }
.err-banner.show { display: block; }

.queue-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.queue-header span { font-size: 13px; font-weight: 700; color: #111; }
.btn-refresh { font-size: 12px; color: #E8363D; background: none; border: none; cursor: pointer; font-family: 'DM Sans', sans-serif; }
.queue-list { display: flex; flex-direction: column; gap: 8px; }
.queue-item { background: #fafafa; border: 1px solid rgba(0,0,0,0.07); border-radius: 10px; padding: 13px 16px; display: flex; align-items: center; gap: 12px; }
.qi-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.qd-start { background: #2563eb; }
.qd-running {
  background: #d97706;
  animation: blink 1.4s infinite;
}
.qi-working {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.qi-working-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #d97706;
  position: relative;
}
.qi-working-dot::after {
  content: '';
  position: absolute;
  inset: -3px;
  border-radius: 50%;
  background: rgba(217,119,6,0.3);
  animation: ping 1.2s cubic-bezier(0,0,0.2,1) infinite;
}
@keyframes ping {
  0% { transform: scale(0.8); opacity: 1; }
  100% { transform: scale(2); opacity: 0; }
}
.qd-done { background: #16a34a; }
.qd-error { background: #dc2626; }
@keyframes blink { 0%,100%{opacity:1}50%{opacity:0.35} }
.qi-info { flex: 1; }
.qi-title { font-size: 13px; font-weight: 600; color: #111; }
.qi-meta { font-size: 11px; color: #aaa; margin-top: 2px; }
.qi-badge { font-size: 10px; font-weight: 700; padding: 3px 9px; border-radius: 100px; white-space: nowrap; }
.qb-start { background: rgba(37,99,235,0.08); color: #2563eb; }
.qb-running { background: rgba(217,119,6,0.08); color: #d97706; }
.qb-done { background: rgba(22,163,74,0.08); color: #16a34a; }
.qb-error { background: rgba(220,38,38,0.08); color: #dc2626; }

@keyframes fadeUp { from{opacity:0;transform:translateY(10px)} to{opacity:1;transform:translateY(0)} }
.vp-toasts { position: fixed; bottom: 24px; right: 24px; display: flex; flex-direction: column; gap: 8px; z-index: 9999; }
.vp-toast { background: #111; color: #fff; border-radius: 10px; padding: 11px 18px; font-size: 13px; font-weight: 500; min-width: 220px; box-shadow: 0 4px 20px rgba(0,0,0,0.15); animation: fadeUp 0.25s ease; }

@media (max-width: 600px) {
  .wrap { padding: 24px 16px 48px; }
  .pipeline-row { flex-direction: column; }
}
</style>

<div class="wrap">
  <div class="page-header">
    <div>
      <div class="page-title">🎬 Start a New Video</div>
      <div class="page-sub">Fill in the details — N8N picks it up within 10 seconds.</div>
    </div>
    <div class="user-pill">
      <div class="user-avatar" id="user-avatar">?</div>
      <span id="user-name">Loading...</span>
      <span class="signout-link" onclick="signOut()">Sign out</span>
    </div>
  </div>

  <div class="card">
    <div class="card-title">Video Details</div>
    <div class="card-sub">Triggers N8N pipeline automatically via Airtable</div>

    <div class="field">
      <label>Industry / Topic Keyword</label>
      <input type="text" id="f-industry" placeholder="e.g. Golf Investment Thailand, Crypto Regulation SEA"/>
      <div class="hint">Main research topic that drives the entire pipeline</div>
    </div>

    <div class="field">
      <label>Search Focus</label>
      <select id="f-focus">
        <option value="">— Select a focus —</option>
        <option value="⚖️ Regulation & Compliance">⚖️ Regulation & Compliance</option>
        <option value="⚙️ Technology & Systems">⚙️ Technology & Systems</option>
        <option value="🏪 Market & Vendors">🏪 Market & Vendors</option>
        <option value="💰 Business Impact & ROI">💰 Business Impact & ROI</option>
        <option value="🔒 Data & Privacy">🔒 Data & Privacy</option>
        <option value="🔭 Full Coverage">🔭 Full Coverage</option>
      </select>
    </div>

    <div class="field" style="margin-bottom:10px"><label>Pipeline</label></div>
    <div class="pipeline-row">
      <div class="pipeline-opt selected" onclick="selectPipeline(' 🌐 Web', this)">
        <div class="pi">🌐</div><div class="pl">Web</div>
      </div>
      <div class="pipeline-opt" onclick="selectPipeline('🎓 Academic ', this)">
        <div class="pi">🎓</div><div class="pl">Academic</div>
      </div>
    </div>

    <div class="field" style="margin-bottom:0">
      <label>Notes <span style="font-weight:400;color:#ccc;text-transform:none;letter-spacing:0">(optional)</span></label>
      <textarea id="f-notes" placeholder="Specific angles, sources, or instructions for the AI agents..."></textarea>
    </div>

    <div class="submit-row">
      <button class="btn-submit" id="submit-btn" onclick="submitJob()">
        <svg style="width:14px;height:14px;stroke:#fff;fill:none;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        Run N8N Workflow
      </button>
      <span class="submit-note">Polls every 10s · status updates below</span>
    </div>

    <div class="success-banner" id="success-banner">✅ <span id="success-msg">Job queued.</span></div>
    <div class="err-banner" id="err-banner"></div>
  </div>

  <div class="card">
    <div class="queue-header">
      <span>Recent Jobs</span>
      <button class="btn-refresh" onclick="loadQueue()">↺ Refresh</button>
    </div>
    <div class="queue-list" id="queue-list">
      <div style="font-size:13px;color:#aaa;text-align:center;padding:16px">Loading jobs...</div>
    </div>
  </div>
</div>

<div class="vp-toasts" id="vp-toasts"></div>

<script>
var API = 'https://superbiller-api-production.up.railway.app';
var selectedPipeline = ' 🌐 Web';
var token = sessionStorage.getItem('sb_token');

// ── AUTH CHECK ────────────────────────────────────────────
(function() {
  if (!token) {
    window.location.href = 'https://internal.superbiller.com/home';
    return;
  }
  var name = sessionStorage.getItem('sb_name') || 'User';
  var email = sessionStorage.getItem('sb_email') || '';
  document.getElementById('user-name').textContent = name;
  document.getElementById('user-avatar').textContent = name.charAt(0).toUpperCase();
  loadQueue();
})();

function signOut() {
  sessionStorage.clear();
  window.location.href = 'https://internal.superbiller.com/home';
}

function selectPipeline(val, el) {
  selectedPipeline = val;
  document.querySelectorAll('.pipeline-opt').forEach(function(o){ o.classList.remove('selected'); });
  el.classList.add('selected');
}

function submitJob() {
  var industry = document.getElementById('f-industry').value.trim();
  var focus    = document.getElementById('f-focus').value;
  var err      = document.getElementById('err-banner');

  err.classList.remove('show');
  if (!industry) { err.textContent = 'Please enter a topic or keyword.'; err.classList.add('show'); return; }
  if (!focus)    { err.textContent = 'Please select a search focus.'; err.classList.add('show'); return; }

  var btn = document.getElementById('submit-btn');
  btn.disabled = true; btn.textContent = '⏳ Submitting...';

  fetch(API + '/video', {
    method: 'POST', mode: 'cors',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token
    },
    body: JSON.stringify({ type: 'job', industry: industry, search_focus: focus, pipeline: selectedPipeline, status: 'Start', user_name: sessionStorage.getItem('sb_name') || '', user_email: sessionStorage.getItem('sb_email') || '' })
  })
  .then(function(r) { return r.json(); })
  .then(function(d) {
    resetBtn(btn);
    document.getElementById('success-msg').textContent = '"' + industry + '" sent to N8N. Pipeline starts in ~10 seconds.';
    document.getElementById('success-banner').classList.add('show');
    addToQueue(industry, focus);
    document.getElementById('f-industry').value = '';
    document.getElementById('f-focus').value = '';
    document.getElementById('f-notes').value = '';
    setTimeout(function(){ document.getElementById('success-banner').classList.remove('show'); }, 5000);
  })
  .catch(function(e) {
    resetBtn(btn);
    err.textContent = 'Could not reach server. Please try again.';
    err.classList.add('show');
  });
}

function resetBtn(btn) {
  btn.disabled = false;
  btn.innerHTML = '<svg style="width:14px;height:14px;stroke:#fff;fill:none;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg> Run N8N Workflow';
}

function loadQueue() {
  fetch(API + '/airtable/videos', {
    headers: { 'Authorization': 'Bearer ' + token }
  })
  .then(function(r) { return r.json(); })
  .then(function(d) {
    var list = document.getElementById('queue-list');
    if (!d.success || !d.records || d.records.length === 0) {
      list.innerHTML = '<div style="font-size:13px;color:#aaa;text-align:center;padding:16px">No jobs yet</div>';
      return;
    }
    list.innerHTML = '';
    d.records.slice(0, 10).forEach(function(r) {
      var f = r.fields;
      var status = f['status ( **required** )'] || 'Start';
      var dotClass = status === 'Completed' ? 'qd-done' : status === 'In Progress' ? 'qd-running' : status === 'Error' ? 'qd-error' : 'qd-start';
      var badgeClass = status === 'Completed' ? 'qb-done' : status === 'In Progress' ? 'qb-running' : status === 'Error' ? 'qb-error' : 'qb-start';
      var stage = f['stage : agent_name'] || status;
      var displayStage = stage === 'Completed' ? 'Completed' : 
                         status === 'Error' ? 'Error' :
                         status === 'Start' ? 'Queued' :
                         stage.replace('Stage ', 'S').replace(' — ', ' · ') || status;
      var el = document.createElement('div');
      el.className = 'queue-item';
      // Timer
      var createdAt = f['created_at'] ? new Date(f['created_at']).getTime() : null;
      var elapsed = createdAt ? Math.floor((Date.now() - createdAt) / 60000) : null;
      var isStuck = elapsed !== null && elapsed > 10 && status !== 'Completed' && status !== 'Error';
      var timerTag = '';
      if (elapsed !== null && status !== 'Completed') {
        var timerColor = isStuck ? '#dc2626' : '#888';
        var timerText = elapsed < 1 ? 'just now' : elapsed + 'm ago';
        timerTag = '<span style="font-size:10px;color:' + timerColor + ';margin-left:4px">' + (isStuck ? '⚠️ stuck · ' : '⏱ ') + timerText + '</span>';
      }
      var dotClassFinal = isStuck ? 'qd-error' : dotClass;
      var badgeClassFinal = isStuck ? 'qb-error' : badgeClass;
      var displayStageFinal = isStuck ? '⚠️ Stuck >' + elapsed + 'm' : displayStage;

      var dotHtml = (status === 'In Progress' && !isStuck)
        ? '<div class="qi-working"><div class="qi-working-dot"></div></div>'
        : '<div class="qi-dot ' + dotClassFinal + '"></div>';
      var userName = f['user'] ? f['user'].split('@')[0] : null;
      var userTag = userName ? '<span style="display:inline-flex;align-items:center;gap:4px;background:rgba(232,54,61,0.08);border-radius:100px;padding:2px 8px 2px 4px;margin-left:6px"><span style="width:16px;height:16px;border-radius:50%;background:#E8363D;color:#fff;font-size:9px;font-weight:800;display:inline-flex;align-items:center;justify-content:center">' + userName.charAt(0).toUpperCase() + '</span><span style="font-size:10px;font-weight:600;color:#E8363D">' + userName + '</span></span>' : '';
      el.innerHTML = dotHtml + '<div class="qi-info"><div class="qi-title">' + (f['Industry ( **required** )'] || '—') + '</div><div class="qi-meta" style="display:flex;align-items:center;flex-wrap:wrap;gap:2px">' + (f['search_focus ( **required** )'] || '') + ' · ' + (f['pipeline ( **required** )'] || '') + userTag + timerTag + '</div></div><span class="qi-badge ' + badgeClassFinal + '">' + displayStageFinal + '</span>';
      list.appendChild(el);
    });
  })
  .catch(function() {
    document.getElementById('queue-list').innerHTML = '<div style="font-size:13px;color:#aaa;text-align:center;padding:16px">Could not load jobs</div>';
  });
}

function addToQueue(industry, focus) {
  loadQueue(); // reload from Airtable immediately
}

// Auto-refresh queue every 10 seconds
setInterval(function() { loadQueue(); }, 5000);

function showToast(msg) {
  var w = document.getElementById('vp-toasts');
  var t = document.createElement('div');
  t.className = 'vp-toast'; t.textContent = msg; w.appendChild(t);
  setTimeout(function(){ t.style.transition='opacity .3s'; t.style.opacity='0'; setTimeout(function(){t.remove();},300); }, 3000);
}
</script>
