// skill-telemetry dashboard — owner-only dashboard for skill creators.
//
// Architecture: single Cloudflare Worker that serves an HTML dashboard +
// proxies queries to your Supabase project. Only YOU (the configured
// GitHub owner) can see the data. The Supabase service_role key never
// leaves the worker.
//
// Bindings required (wrangler.toml + secrets):
//
//   vars:
//     GITHUB_CLIENT_ID         — OAuth app client id (we reuse tdoc's: "Ov23liZ1UAGOchvKPmlS")
//     SKILL_TELEMETRY_OWNER    — your GitHub username (only you can sign in)
//     SUPABASE_URL             — your Supabase project URL
//
//   secrets (set via `wrangler secret put`):
//     SUPABASE_SERVICE_ROLE_KEY — never put this in code or env vars
//
//   KV namespace:
//     SESSIONS — stores signed-in session cookies (30d TTL)
//
// Auth flow (GitHub Device Flow, borrowed from tdoc):
//   1. User opens dashboard URL
//   2. Worker checks tdoc_sid cookie → if valid + login matches owner → show dashboard
//   3. Otherwise → show landing page with "Sign in with GitHub" button
//   4. Click → POST /api/auth/device/start → GitHub returns device_code + user_code
//   5. User opens github.com/login/device, types user_code, approves
//   6. Worker polls /api/auth/device/poll → GitHub returns access_token
//   7. Worker fetches /user → checks login === SKILL_TELEMETRY_OWNER
//   8. Sets session cookie, redirects to dashboard

// No CORS — this is a single-origin dashboard. Owner-only data should
// not be readable from any external origin. The session cookie is
// SameSite=Lax + HttpOnly, but we tighten the perimeter further by
// rejecting cross-origin reads entirely. Auth + data endpoints all
// return same-origin only. F6 from audit.

const json = (data, init = {}) => new Response(JSON.stringify(data), {
  ...init,
  headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
});
const html = (body, init = {}) => new Response(body, {
  ...init,
  headers: { 'Content-Type': 'text/html; charset=utf-8', ...(init.headers || {}) },
});
const text = (body, init = {}) => new Response(body, {
  ...init,
  headers: { 'Content-Type': 'text/plain; charset=utf-8', ...(init.headers || {}) },
});

function rand(n = 24) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── GitHub OAuth helpers (copied from tdoc worker) ────────
async function ghPost(path, formObj) {
  const body = new URLSearchParams(formObj).toString();
  const r = await fetch(`https://github.com${path}`, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'skill-telemetry-dashboard',
    },
    body,
  });
  const ct = r.headers.get('content-type') || '';
  const raw = await r.text();
  if (ct.includes('application/json')) {
    try { return JSON.parse(raw); } catch { return { error: 'gh_parse', error_description: raw.slice(0, 200) }; }
  }
  const params = new URLSearchParams(raw);
  const out = {};
  for (const [k, v] of params) out[k] = v;
  if (!Object.keys(out).length) return { error: 'gh_empty', error_description: `status=${r.status}` };
  return out;
}

async function ghUser(token) {
  const r = await fetch('https://api.github.com/user', {
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'skill-telemetry-dashboard',
    },
  });
  return r.json();
}

// ─── Session management ──────────────────────────────────────
async function getSession(env, req) {
  const cookie = req.headers.get('cookie') || '';
  const m = cookie.match(/skill_telemetry_sid=([a-f0-9]+)/);
  if (!m) return null;
  const sid = m[1];
  const raw = await env.SESSIONS.get(`session:${sid}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function isOwner(env, session) {
  if (!session || !env.SKILL_TELEMETRY_OWNER) return false;
  return session.login?.toLowerCase() === env.SKILL_TELEMETRY_OWNER.toLowerCase();
}

// ─── Supabase REST query helper ──────────────────────────────
// Uses service_role to bypass RLS. ONLY called from worker, never
// exposed to client. The client only sees the resulting JSON.
// All queries go through PostgREST view endpoints (sbView below) —
// safer than arbitrary SQL because the only thing the client can
// influence is the WHERE/order/limit params, not the columns/joins.
async function sbView(env, viewName, params = {}) {
  const qs = new URLSearchParams();
  qs.set('select', params.select || '*');
  if (params.order) qs.set('order', params.order);
  if (params.limit) qs.set('limit', params.limit);
  // Filters: params.filter = { skill: 'eq.tdoc', ts: 'gt.2026-05-01' }
  if (params.filter) {
    for (const [k, v] of Object.entries(params.filter)) {
      qs.append(k, v);
    }
  }
  const url = `${env.SUPABASE_URL}/rest/v1/${viewName}?${qs}`;
  const r = await fetch(url, {
    headers: {
      'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Accept': 'application/json',
    },
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`Supabase ${r.status}: ${errText.slice(0, 200)}`);
  }
  return r.json();
}

// ─── HTML: landing (not signed in) ───────────────────────────
function landingHtml(owner) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>skill-telemetry · sign in</title>
<style>
  :root {
    --bg: #09090b;
    --bg-card: #111114;
    --border: #1f1f23;
    --text: #fafafa;
    --text-dim: #a1a1aa;
    --text-faint: #71717a;
    --accent: #fafafa;
    --danger: #f87171;
    --danger-bg: rgba(248,113,113,0.08);
    --radius: 10px;
  }
  * { box-sizing: border-box; }
  body { font-family: 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
         margin: 0; padding: 0; color: var(--text); background: var(--bg);
         min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font-feature-settings: 'cv11', 'ss01'; -webkit-font-smoothing: antialiased;
         background-image: radial-gradient(ellipse 80% 50% at 50% -20%, rgba(120,119,198,0.12), transparent);
  }
  .container { max-width: 440px; width: 100%; padding: 32px 24px; }
  .logo { display: flex; align-items: center; gap: 8px; margin-bottom: 24px;
          font-size: 14px; font-weight: 500; color: var(--text-dim); }
  .logo-dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e;
              box-shadow: 0 0 8px rgba(34,197,94,0.6); }
  h1 { margin: 0 0 8px; font-size: 28px; font-weight: 600; letter-spacing: -0.02em; }
  .sub { color: var(--text-dim); margin: 0 0 32px; font-size: 15px; line-height: 1.5; }
  .card { background: var(--bg-card); border: 1px solid var(--border);
          border-radius: var(--radius); padding: 24px; margin-bottom: 16px; }
  p { color: var(--text-dim); font-size: 14px; line-height: 1.6; margin: 0 0 16px; }
  p:last-child { margin-bottom: 0; }
  code { background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px;
         font-family: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace;
         font-size: 13px; color: var(--text); }
  button { padding: 11px 18px; font-size: 14px; font-weight: 500;
           border: 1px solid var(--border); background: #fafafa; color: #09090b;
           border-radius: 8px; cursor: pointer; transition: all 0.15s ease;
           font-family: inherit; }
  button:hover { background: #e4e4e7; transform: translateY(-1px); }
  .codebox { background: rgba(255,255,255,0.04); padding: 20px; border: 1px solid var(--border);
             border-radius: 8px; margin: 16px 0;
             font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 24px;
             letter-spacing: 0.15em; text-align: center; color: var(--text);
             font-weight: 500; }
  .small { font-size: 13px; color: var(--text-faint); }
  a { color: var(--text); text-decoration: none; border-bottom: 1px solid var(--border); }
  a:hover { border-bottom-color: var(--text-dim); }
  .err { color: var(--danger); background: var(--danger-bg);
         border: 1px solid rgba(248,113,113,0.2);
         padding: 12px 14px; border-radius: 8px; margin: 12px 0; font-size: 13px; }
  .footer { margin-top: 24px; text-align: center; font-size: 12px; color: var(--text-faint); }
  .footer a { font-family: 'JetBrains Mono', monospace; font-size: 11px; }
</style>
</head><body>
<div class="container">
  <div class="logo"><span class="logo-dot"></span> skill-telemetry</div>
  <h1>Welcome back</h1>
  <p class="sub">Sign in to view your skill's analytics. Only the configured owner of this Cloudflare Worker can access this dashboard.</p>

  <div class="card">
    <div id="step-start">
      <p>${owner ? `Configured owner: <code>${owner}</code>` : `<span class="err" style="display:block;">No owner configured. Set <code>SKILL_TELEMETRY_OWNER</code> in wrangler.toml.</span>`}</p>
      <button onclick="startAuth()">Continue with GitHub →</button>
    </div>

    <div id="step-code" style="display:none;">
      <p>Open <a id="ghurl" href="" target="_blank">github.com/login/device</a> and enter this code:</p>
      <div class="codebox" id="usercode">—</div>
      <p class="small">Waiting for GitHub approval<span id="status"></span></p>
    </div>

    <div id="error" class="err" style="display:none;"></div>
  </div>

  <div class="footer">
    Open source · <a href="https://github.com/serenakeyitan/skill-telemetry">github.com/serenakeyitan/skill-telemetry</a>
  </div>
</div>

<script>
let deviceCode = null;
let pollInterval = 5000;

async function startAuth() {
  document.getElementById('error').style.display = 'none';
  document.getElementById('step-start').style.display = 'none';
  document.getElementById('step-code').style.display = 'block';

  try {
    const r = await fetch('/api/auth/device/start', { method: 'POST' });
    const data = await r.json();
    if (data.error) {
      showError(data.message || data.error);
      return;
    }
    deviceCode = data.device_code;
    pollInterval = (data.interval || 5) * 1000;
    document.getElementById('usercode').textContent = data.user_code;
    document.getElementById('ghurl').href = data.verification_uri;
    document.getElementById('ghurl').textContent = data.verification_uri;
    setTimeout(poll, pollInterval);
  } catch (e) {
    showError(e.message);
  }
}

async function poll() {
  try {
    const r = await fetch('/api/auth/device/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: deviceCode }),
    });
    const data = await r.json();
    if (data.ok) {
      window.location.href = '/';
      return;
    }
    if (data.pending) {
      document.getElementById('status').textContent = '· still waiting';
      if (data.interval) pollInterval = data.interval * 1000;
      setTimeout(poll, pollInterval);
      return;
    }
    if (data.error === 'not_owner') {
      showError(\`You signed in as \${data.signed_in_as}, but this dashboard's owner is \${data.expected_owner}. Sign out of GitHub and try again with the right account.\`);
      return;
    }
    showError(data.message || data.error || 'Unknown error');
  } catch (e) {
    showError(e.message);
  }
}

function showError(msg) {
  document.getElementById('step-start').style.display = 'block';
  document.getElementById('step-code').style.display = 'none';
  const el = document.getElementById('error');
  el.textContent = msg;
  el.style.display = 'block';
}
</script>
</body></html>`;
}

// ─── HTML: dashboard (signed in as owner) ────────────────────
function dashboardHtml(owner) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>skill-telemetry · ${owner}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #09090b;
    --bg-card: #111114;
    --bg-card-hover: #161619;
    --bg-subtle: #18181b;
    --border: #1f1f23;
    --border-strong: #27272a;
    --text: #fafafa;
    --text-dim: #a1a1aa;
    --text-faint: #71717a;
    --text-mute: #52525b;
    --success: #22c55e;
    --success-bg: rgba(34,197,94,0.1);
    --danger: #f87171;
    --danger-bg: rgba(248,113,113,0.1);
    --warning: #fbbf24;
    --warning-bg: rgba(251,191,36,0.1);
    --accent: #818cf8;
    --accent-2: #c084fc;
    --radius: 12px;
    --radius-sm: 8px;
  }
  * { box-sizing: border-box; }
  body { font-family: 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
         margin: 0; padding: 0; color: var(--text); background: var(--bg);
         font-feature-settings: 'cv11', 'ss01'; -webkit-font-smoothing: antialiased;
         -moz-osx-font-smoothing: grayscale; font-size: 14px; line-height: 1.5;
         background-image:
           radial-gradient(ellipse 80% 50% at 50% -20%, rgba(120,119,198,0.08), transparent),
           radial-gradient(ellipse 50% 30% at 100% 0%, rgba(192,132,252,0.05), transparent); }

  /* ── Header ────────────────────────────────────────────── */
  header { padding: 16px 32px; display: flex; align-items: center; justify-content: space-between;
           border-bottom: 1px solid var(--border); background: rgba(9,9,11,0.7);
           backdrop-filter: blur(8px); position: sticky; top: 0; z-index: 10; }
  .brand { display: flex; align-items: center; gap: 10px; font-size: 14px;
           font-weight: 500; letter-spacing: -0.01em; }
  .brand-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--success);
               box-shadow: 0 0 10px rgba(34,197,94,0.6); }
  .brand-sep { color: var(--text-mute); margin: 0 4px; }
  .brand-owner { color: var(--text-dim); font-family: 'JetBrains Mono', monospace;
                 font-size: 13px; font-weight: 400; }
  .header-right { display: flex; align-items: center; gap: 12px; font-size: 13px;
                  color: var(--text-faint); }
  button.logout { background: transparent; color: var(--text-dim); border: 1px solid var(--border-strong);
                  padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px;
                  font-family: inherit; transition: all 0.15s ease; }
  button.logout:hover { background: var(--bg-card-hover); color: var(--text); border-color: var(--text-mute); }

  /* ── Layout ────────────────────────────────────────────── */
  main { max-width: 1280px; margin: 0 auto; padding: 32px; }

  /* ── Page title ────────────────────────────────────────── */
  .page-title { display: flex; justify-content: space-between; align-items: baseline;
                margin-bottom: 24px; }
  .page-title h1 { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -0.02em; }
  .page-title .meta { font-size: 12px; color: var(--text-faint);
                      font-family: 'JetBrains Mono', monospace; }

  /* ── Filters ────────────────────────────────────────────── */
  .filters { display: flex; gap: 8px; flex-wrap: wrap; align-items: center;
             margin-bottom: 28px; }
  .filter-pill { position: relative; display: inline-flex; align-items: center; }
  .filter-pill label { position: absolute; left: 14px; top: 50%; transform: translateY(-50%);
                       font-size: 12px; color: var(--text-faint); pointer-events: none;
                       z-index: 1; }
  .filter-pill select { padding: 8px 32px 8px 80px; background: var(--bg-card);
                        border: 1px solid var(--border); border-radius: 8px;
                        color: var(--text); font: inherit; font-size: 13px;
                        appearance: none; cursor: pointer; transition: all 0.15s ease;
                        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23a1a1aa' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E");
                        background-repeat: no-repeat; background-position: right 12px center; }
  .filter-pill select:hover { border-color: var(--border-strong); background-color: var(--bg-card-hover); }
  .filter-pill select:focus { outline: none; border-color: var(--text-mute);
                              box-shadow: 0 0 0 3px rgba(255,255,255,0.04); }

  /* ── Stat grid ─────────────────────────────────────────── */
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
               gap: 1px; background: var(--border); border: 1px solid var(--border);
               border-radius: var(--radius); overflow: hidden; margin-bottom: 32px; }
  .stat { background: var(--bg-card); padding: 20px 22px;
          transition: background 0.15s ease; }
  .stat:hover { background: var(--bg-card-hover); }
  .stat .label { font-size: 11px; color: var(--text-faint); text-transform: uppercase;
                 letter-spacing: 0.08em; font-weight: 500; }
  .stat .value { font-size: 32px; font-weight: 600; margin-top: 6px;
                 letter-spacing: -0.03em; font-feature-settings: 'tnum'; }
  .stat .sub { font-size: 12px; color: var(--text-faint); margin-top: 4px; }
  .stat .sub.up { color: var(--success); }
  .stat .sub.down { color: var(--danger); }

  /* ── Sections ──────────────────────────────────────────── */
  section { background: var(--bg-card); border: 1px solid var(--border);
            border-radius: var(--radius); padding: 24px; margin-bottom: 16px; }
  .section-head { display: flex; justify-content: space-between; align-items: baseline;
                  margin-bottom: 20px; }
  .section-head h2 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
  .section-head .desc { font-size: 12px; color: var(--text-faint); }

  /* ── DAU chart (SVG) ───────────────────────────────────── */
  #dau-chart { width: 100%; }
  .chart-svg { width: 100%; height: 200px; display: block; }
  .chart-grid line { stroke: var(--border); stroke-dasharray: 2 4; }
  .chart-area { fill: url(#chart-gradient); }
  .chart-line { fill: none; stroke: #818cf8; stroke-width: 1.75; stroke-linejoin: round;
                stroke-linecap: round; }
  .chart-dot { fill: #818cf8; }
  .chart-label { fill: var(--text-faint); font-size: 10px;
                 font-family: 'JetBrains Mono', monospace; }
  .chart-tooltip { pointer-events: none; }
  .chart-empty { padding: 60px 24px; text-align: center; color: var(--text-faint);
                 font-size: 13px; }

  /* ── Tables ────────────────────────────────────────────── */
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  thead tr { border-bottom: 1px solid var(--border); }
  th { text-align: left; padding: 10px 12px; color: var(--text-faint);
       font-weight: 500; font-size: 11px; text-transform: uppercase;
       letter-spacing: 0.06em; }
  tbody tr { border-bottom: 1px solid var(--border); transition: background 0.1s ease; }
  tbody tr:last-child { border-bottom: none; }
  tbody tr:hover { background: rgba(255,255,255,0.02); }
  td { padding: 11px 12px; color: var(--text); }
  td.mono { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 12px;
            color: var(--text-dim); }
  td.num { font-family: 'JetBrains Mono', monospace; font-feature-settings: 'tnum';
           color: var(--text-dim); text-align: right; }
  td.dim { color: var(--text-faint); }

  /* outcome pills */
  .pill { display: inline-flex; align-items: center; gap: 4px;
          padding: 2px 8px; border-radius: 4px; font-size: 11px;
          font-weight: 500; font-family: 'JetBrains Mono', monospace; }
  .pill::before { content: ''; width: 5px; height: 5px; border-radius: 50%; }
  .pill.success { background: var(--success-bg); color: var(--success); }
  .pill.success::before { background: var(--success); }
  .pill.error { background: var(--danger-bg); color: var(--danger); }
  .pill.error::before { background: var(--danger); }
  .pill.abandoned { background: var(--warning-bg); color: var(--warning); }
  .pill.abandoned::before { background: var(--warning); }
  .pill.unknown { background: rgba(161,161,170,0.1); color: var(--text-faint); }
  .pill.unknown::before { background: var(--text-faint); }

  .loading { padding: 40px; text-align: center; color: var(--text-faint); font-size: 13px; }
  .loading::after { content: '…'; animation: dots 1.4s steps(4, end) infinite; }
  @keyframes dots { 0%, 20% { content: ''; } 40% { content: '.'; } 60% { content: '..'; } 80%, 100% { content: '…'; } }
  .empty { padding: 40px 24px; text-align: center; color: var(--text-faint);
           font-size: 13px; font-style: italic; }
</style>
</head><body>

<header>
  <div class="brand">
    <span class="brand-dot"></span>
    skill-telemetry
    <span class="brand-sep">/</span>
    <span class="brand-owner">${owner}</span>
  </div>
  <div class="header-right">
    <span id="updated-at"></span>
    <button class="logout" onclick="logout()">Sign out</button>
  </div>
</header>

<main>
  <div class="page-title">
    <h1>Overview</h1>
    <span class="meta">v1.0.0</span>
  </div>

  <div class="filters">
    <div class="filter-pill">
      <label>Skill</label>
      <select id="filter-skill" onchange="loadAll()">
        <option value="">All</option>
      </select>
    </div>
    <div class="filter-pill">
      <label>Period</label>
      <select id="filter-window" onchange="loadAll()">
        <option value="1">Last 24h</option>
        <option value="7" selected>Last 7d</option>
        <option value="30">Last 30d</option>
        <option value="">All time</option>
      </select>
    </div>
  </div>

  <div class="stat-grid" id="stats"></div>

  <section>
    <div class="section-head">
      <h2>Daily activity</h2>
      <span class="desc">Sessions per day · selected window</span>
    </div>
    <div id="dau-chart" class="loading">Loading</div>
  </section>

  <section>
    <div class="section-head">
      <h2>Step breakdown</h2>
      <span class="desc">Success rate per step</span>
    </div>
    <div id="step-table" class="loading">Loading</div>
  </section>

  <section>
    <div class="section-head">
      <h2>Recent events</h2>
      <span class="desc">Latest 50</span>
    </div>
    <div id="events-table" class="loading">Loading</div>
  </section>
</main>

<script>
// HTML-escape all interpolated values. Critical: skill/step/error_class/
// error_message all flow from untrusted client telemetry — any user of a
// skill could craft a payload like skill='<img src=x onerror=...>' that
// would XSS the dashboard if we interpolated raw. F2 from audit.
function esc(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

async function fetchData(endpoint) {
  const skill = document.getElementById('filter-skill').value;
  const window = document.getElementById('filter-window').value;
  const params = new URLSearchParams();
  if (skill) params.set('skill', skill);
  if (window) params.set('window_days', window);
  const r = await fetch(\`/api/\${endpoint}?\${params}\`);
  if (!r.ok) {
    if (r.status === 401) { window.location.href = '/'; return null; }
    throw new Error(\`\${endpoint}: \${r.status}\`);
  }
  return r.json();
}

// Format big numbers — 1234 -> "1.2k", 1_500_000 -> "1.5M"
function fmtNum(n) {
  if (n == null) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

async function loadStats() {
  const data = await fetchData('summary');
  if (!data) return;

  // Populate skill filter (only first time)
  // Uses .value/.textContent which auto-escapes — safe.
  const skillFilter = document.getElementById('filter-skill');
  if (skillFilter.options.length === 1) {
    for (const row of data) {
      const opt = document.createElement('option');
      opt.value = row.skill;
      opt.textContent = row.skill;
      skillFilter.appendChild(opt);
    }
  }

  // Render stat cards: aggregate across all rows in the filter
  const totals = data.reduce((acc, r) => ({
    events: acc.events + (r.total_events || 0),
    users: Math.max(acc.users, r.users || 0),   // can't sum users (might overlap), take max
    sessions: acc.sessions + (r.sessions || 0),
    errors: acc.errors + (r.errors || 0),
  }), { events: 0, users: 0, sessions: 0, errors: 0 });

  const successCount = data.reduce((s, r) => s + (r.successes || 0), 0);
  const successRate = totals.events > 0 ? (successCount / totals.events * 100).toFixed(1) : '—';

  document.getElementById('stats').innerHTML = \`
    <div class="stat"><div class="label">Total events</div><div class="value">\${fmtNum(totals.events)}</div><div class="sub">all-time</div></div>
    <div class="stat"><div class="label">Distinct users</div><div class="value">\${fmtNum(totals.users)}</div><div class="sub">unique installations</div></div>
    <div class="stat"><div class="label">Sessions</div><div class="value">\${fmtNum(totals.sessions)}</div><div class="sub">across all skills</div></div>
    <div class="stat"><div class="label">Success rate</div><div class="value">\${successRate}%</div><div class="sub \${successRate >= 95 ? 'up' : successRate >= 85 ? '' : 'down'}">\${successCount} / \${totals.events}</div></div>
  \`;
}

// Render the DAU sparkline chart as inline SVG so it screenshots crisply.
// Aggregates rows by day across all skills (sessions count). Pads missing
// days as zeros so the X axis is contiguous.
async function loadDau() {
  const data = await fetchData('dau');
  if (!data) return;
  const el = document.getElementById('dau-chart');
  if (!data || data.length === 0) {
    el.className = 'chart-empty';
    el.textContent = 'No activity in this window yet.';
    return;
  }
  el.className = '';

  // Aggregate by day (sum sessions across all skills)
  const byDay = {};
  for (const r of data) {
    const d = r.day;
    if (!byDay[d]) byDay[d] = 0;
    byDay[d] += Number(r.sessions || 0);
  }
  const days = Object.keys(byDay).sort();
  if (days.length === 0) { el.className = 'chart-empty'; el.textContent = 'No activity.'; return; }

  // Fill in missing dates between min and max so the chart x-axis is contiguous.
  const start = new Date(days[0] + 'T00:00:00Z');
  const end = new Date(days[days.length - 1] + 'T00:00:00Z');
  const series = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    series.push({ day: key, sessions: byDay[key] || 0 });
  }

  // Chart dimensions
  const W = 1000, H = 200, padL = 40, padR = 16, padT = 16, padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const maxY = Math.max(1, ...series.map(s => s.sessions));
  // Round maxY up to a nice tick (e.g. 1, 2, 5, 10, 20, 50, ...)
  const niceMax = (() => {
    const exp = Math.pow(10, Math.floor(Math.log10(maxY)));
    const frac = maxY / exp;
    let nice;
    if (frac <= 1) nice = 1;
    else if (frac <= 2) nice = 2;
    else if (frac <= 5) nice = 5;
    else nice = 10;
    return nice * exp;
  })();

  const xStep = series.length > 1 ? innerW / (series.length - 1) : 0;
  const xFor = i => padL + i * xStep;
  const yFor = v => padT + innerH - (v / niceMax) * innerH;

  // Build path strings
  const linePath = series.map((s, i) => \`\${i === 0 ? 'M' : 'L'} \${xFor(i).toFixed(2)} \${yFor(s.sessions).toFixed(2)}\`).join(' ');
  const areaPath = \`\${linePath} L \${xFor(series.length - 1).toFixed(2)} \${padT + innerH} L \${padL} \${padT + innerH} Z\`;

  // Y-axis ticks (4)
  const yTicks = [0, niceMax * 0.25, niceMax * 0.5, niceMax * 0.75, niceMax];

  // X-axis labels (first, mid, last)
  const xLabels = series.length <= 3 ? series.map((s, i) => ({ i, label: s.day.slice(5) }))
    : [
        { i: 0, label: series[0].day.slice(5) },
        { i: Math.floor(series.length / 2), label: series[Math.floor(series.length / 2)].day.slice(5) },
        { i: series.length - 1, label: series[series.length - 1].day.slice(5) }
      ];

  el.innerHTML = \`
    <svg class="chart-svg" viewBox="0 0 \${W} \${H}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="chart-gradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#818cf8" stop-opacity="0.35"/>
          <stop offset="100%" stop-color="#818cf8" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <g class="chart-grid">
        \${yTicks.map(t => \`<line x1="\${padL}" x2="\${W - padR}" y1="\${yFor(t)}" y2="\${yFor(t)}"/>\`).join('')}
      </g>
      <g class="chart-axis">
        \${yTicks.map(t => \`<text class="chart-label" x="\${padL - 8}" y="\${yFor(t) + 3}" text-anchor="end">\${t}</text>\`).join('')}
        \${xLabels.map(x => \`<text class="chart-label" x="\${xFor(x.i)}" y="\${H - 8}" text-anchor="middle">\${esc(x.label)}</text>\`).join('')}
      </g>
      <path class="chart-area" d="\${areaPath}"/>
      <path class="chart-line" d="\${linePath}"/>
      \${series.map((s, i) => s.sessions > 0 ? \`<circle class="chart-dot" cx="\${xFor(i)}" cy="\${yFor(s.sessions)}" r="2.5"><title>\${esc(s.day)} · \${s.sessions} sessions</title></circle>\` : '').join('')}
    </svg>
  \`;
}

async function loadSteps() {
  const data = await fetchData('steps');
  if (!data) return;
  const el = document.getElementById('step-table');
  if (!data || data.length === 0) { el.className = 'empty'; el.textContent = 'No step data in this window.'; return; }
  el.className = '';
  el.innerHTML = \`
    <table>
      <thead><tr><th>Step</th><th>Skill</th><th>Runs</th><th>Success</th><th>Error</th><th>Bail</th><th style="text-align:right">Rate</th></tr></thead>
      <tbody>
        \${data.map(r => \`
          <tr>
            <td class="mono">\${esc(r.step || '—')}</td>
            <td class="dim">\${esc(r.skill)}</td>
            <td class="num">\${esc(r.runs)}</td>
            <td><span class="pill success">\${esc(r.ok)}</span></td>
            <td>\${r.err > 0 ? \`<span class="pill error">\${esc(r.err)}</span>\` : '<span class="dim">—</span>'}</td>
            <td>\${r.bail > 0 ? \`<span class="pill abandoned">\${esc(r.bail)}</span>\` : '<span class="dim">—</span>'}</td>
            <td class="num">\${esc(r.success_pct)}%</td>
          </tr>
        \`).join('')}
      </tbody>
    </table>
  \`;
}

async function loadEvents() {
  const data = await fetchData('events');
  if (!data) return;
  const el = document.getElementById('events-table');
  if (!data || data.length === 0) { el.className = 'empty'; el.textContent = 'No recent events.'; return; }
  el.className = '';
  el.innerHTML = \`
    <table>
      <thead><tr><th>Time</th><th>Skill</th><th>Event</th><th>Outcome</th><th>Step</th><th style="text-align:right">Dur</th><th>Error</th></tr></thead>
      <tbody>
        \${data.map(r => {
          const outcome = r.outcome || 'unknown';
          return \`
          <tr>
            <td class="mono">\${esc(r.t)}</td>
            <td>\${esc(r.skill)}</td>
            <td class="dim">\${esc(r.event_type || 'skill_run')}</td>
            <td><span class="pill \${esc(outcome)}">\${esc(outcome)}</span></td>
            <td class="mono">\${esc(r.step || '—')}</td>
            <td class="num">\${r.duration_s != null ? esc(r.duration_s) + 's' : '—'}</td>
            <td class="mono"><span class="dim">\${esc(r.error_class || '—')}</span></td>
          </tr>
        \`;}).join('')}
      </tbody>
    </table>
  \`;
}

async function loadAll() {
  const updEl = document.getElementById('updated-at');
  updEl.textContent = 'syncing…';
  try {
    await Promise.all([loadStats(), loadDau(), loadSteps(), loadEvents()]);
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    updEl.textContent = \`live · \${hh}:\${mm}\`;
  } catch (e) {
    updEl.textContent = 'error · ' + e.message;
  }
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/';
}

loadAll();
setInterval(loadAll, 60000);  // refresh every 60s
</script>
</body></html>`;
}

// ─── Worker entrypoint ────────────────────────────────────────
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    const method = req.method;

    // No CORS preflight needed — same-origin only.
    if (method === 'OPTIONS') return new Response(null, { status: 405 });

    // ─── Landing / dashboard ─────────────────────────────────
    if (p === '/' && method === 'GET') {
      const s = await getSession(env, req);
      if (isOwner(env, s)) {
        return html(dashboardHtml(s.login));
      }
      return html(landingHtml(env.SKILL_TELEMETRY_OWNER));
    }

    // ─── Auth: device flow start ─────────────────────────────
    if (p === '/api/auth/device/start' && method === 'POST') {
      if (!env.GITHUB_CLIENT_ID) {
        return json({ error: 'misconfigured', message: 'GITHUB_CLIENT_ID not set in wrangler.toml' }, { status: 500 });
      }
      try {
        const r = await ghPost('/login/device/code', {
          client_id: env.GITHUB_CLIENT_ID,
          scope: 'read:user',
        });
        if (r.error) return json({ error: r.error, message: r.error_description }, { status: 400 });
        return json({
          device_code: r.device_code,
          user_code: r.user_code,
          verification_uri: r.verification_uri,
          expires_in: r.expires_in,
          interval: r.interval,
        });
      } catch (e) {
        return json({ error: 'github_unreachable', message: e.message }, { status: 500 });
      }
    }

    // ─── Auth: device flow poll ──────────────────────────────
    if (p === '/api/auth/device/poll' && method === 'POST') {
      let body = {};
      try { body = await req.json(); } catch {}
      if (!body.device_code) return json({ error: 'device_code required' }, { status: 400 });
      try {
        const r = await ghPost('/login/oauth/access_token', {
          client_id: env.GITHUB_CLIENT_ID,
          device_code: body.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        });
        if (r.error === 'authorization_pending' || r.error === 'slow_down') {
          return json({ pending: true, error: r.error, interval: Number(r.interval) || null });
        }
        if (r.error) return json({ error: r.error, message: r.error_description || r.error }, { status: 400 });
        if (!r.access_token) return json({ pending: true });

        const user = await ghUser(r.access_token);
        if (!user.login) {
          return json({ error: 'no_user', message: user.message || 'GitHub /user returned no login' }, { status: 500 });
        }

        // ── Owner check ──
        if (env.SKILL_TELEMETRY_OWNER &&
            user.login.toLowerCase() !== env.SKILL_TELEMETRY_OWNER.toLowerCase()) {
          return json({
            error: 'not_owner',
            signed_in_as: user.login,
            expected_owner: env.SKILL_TELEMETRY_OWNER,
          }, { status: 403 });
        }

        const sid = rand(24);
        const session = {
          login: user.login,
          avatar_url: user.avatar_url,
          name: user.name || user.login,
          created: new Date().toISOString(),
        };
        await env.SESSIONS.put(`session:${sid}`, JSON.stringify(session),
          { expirationTtl: 60 * 60 * 24 * 30 });

        return json(
          { ok: true, identity: { login: user.login, avatar_url: user.avatar_url } },
          { headers: { 'Set-Cookie': `skill_telemetry_sid=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}` } }
        );
      } catch (e) {
        return json({ error: 'github_unreachable', message: e.message }, { status: 500 });
      }
    }

    // ─── Auth: logout ────────────────────────────────────────
    if (p === '/api/auth/logout' && method === 'POST') {
      const cookie = req.headers.get('cookie') || '';
      const m = cookie.match(/skill_telemetry_sid=([a-f0-9]+)/);
      if (m) {
        await env.SESSIONS.delete(`session:${m[1]}`);
      }
      return json({ ok: true }, {
        headers: { 'Set-Cookie': 'skill_telemetry_sid=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' }
      });
    }

    // ─── Data endpoints — owner-only ─────────────────────────
    // All return 401 if not signed in as owner
    const dataEndpoints = ['/api/summary', '/api/dau', '/api/steps', '/api/events'];
    if (dataEndpoints.includes(p) && method === 'GET') {
      const s = await getSession(env, req);
      if (!isOwner(env, s)) return json({ error: 'unauthorized' }, { status: 401 });

      const skill = url.searchParams.get('skill');
      const windowDays = url.searchParams.get('window_days');

      try {
        if (p === '/api/summary') {
          const filter = {};
          if (skill) filter.skill = `eq.${skill}`;
          const rows = await sbView(env, 'skill_usage_summary', {
            order: 'total_events.desc',
            filter,
          });
          return json(rows);
        }

        if (p === '/api/dau') {
          const filter = {};
          if (skill) filter.skill = `eq.${skill}`;
          if (windowDays) {
            const since = new Date(Date.now() - parseInt(windowDays, 10) * 86400000).toISOString().slice(0, 10);
            filter.day = `gte.${since}`;
          }
          const rows = await sbView(env, 'skill_dau', {
            order: 'day.desc',
            filter,
            limit: 30,
          });
          return json(rows);
        }

        if (p === '/api/steps') {
          // Custom SQL via PostgREST view doesn't exist for "step breakdown"
          // Use the existing skill_events table directly with grouping done client-side
          // For simplicity, query raw events filtered by skill and aggregate in worker
          const filter = { event_type: 'eq.skill_run' };
          if (skill) filter.skill = `eq.${skill}`;
          if (windowDays) {
            const since = new Date(Date.now() - parseInt(windowDays, 10) * 86400000).toISOString();
            filter.ts = `gte.${since}`;
          }
          const events = await sbView(env, 'skill_events', {
            select: 'skill,step,outcome',
            filter,
            limit: 1000,
          });
          // Aggregate by skill+step
          const agg = {};
          for (const e of events) {
            if (!e.step) continue;
            const key = `${e.skill}|${e.step}`;
            if (!agg[key]) agg[key] = { skill: e.skill, step: e.step, runs: 0, ok: 0, err: 0, bail: 0 };
            agg[key].runs++;
            if (e.outcome === 'success') agg[key].ok++;
            else if (e.outcome === 'error') agg[key].err++;
            else if (e.outcome === 'abandoned') agg[key].bail++;
          }
          const rows = Object.values(agg)
            .map(r => ({ ...r, success_pct: r.runs ? Math.round(r.ok / r.runs * 1000) / 10 : 0 }))
            .sort((a, b) => b.runs - a.runs);
          return json(rows);
        }

        if (p === '/api/events') {
          const filter = {};
          if (skill) filter.skill = `eq.${skill}`;
          if (windowDays) {
            const since = new Date(Date.now() - parseInt(windowDays, 10) * 86400000).toISOString();
            filter.ts = `gte.${since}`;
          }
          const events = await sbView(env, 'skill_events', {
            select: 'ts,skill,event_type,outcome,step,duration_s,error_class,error_message',
            order: 'ts.desc',
            filter,
            limit: 50,
          });
          // Format ts for display
          const rows = events.map(e => ({
            ...e,
            t: new Date(e.ts).toLocaleString('en-CA', {
              year: 'numeric', month: '2-digit', day: '2-digit',
              hour: '2-digit', minute: '2-digit', second: '2-digit',
              hour12: false,
              timeZone: 'America/Los_Angeles',
            }).replace(',', ''),
          }));
          return json(rows);
        }
      } catch (e) {
        return json({ error: 'query_failed', message: e.message }, { status: 500 });
      }
    }

    return text(`Not found: ${p}`, { status: 404 });
  },
};
