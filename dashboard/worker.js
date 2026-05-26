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
// Exported for reuse by the local Node server (`dashboard/local.js`).
// Both runtimes have global `fetch` (Workers natively, Node 18+ natively),
// so the same function works in both places.
export async function sbView(env, viewName, params = {}) {
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
export function dashboardHtml(owner) {
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
  header { padding: 10px 20px; display: flex; align-items: center; justify-content: space-between;
           border-bottom: 1px solid var(--border); background: rgba(9,9,11,0.7);
           backdrop-filter: blur(8px); position: sticky; top: 0; z-index: 10; }
  .brand { display: flex; align-items: center; gap: 8px; font-size: 13px;
           font-weight: 500; letter-spacing: -0.01em; }
  .brand-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--success);
               box-shadow: 0 0 8px rgba(34,197,94,0.6); }
  .brand-sep { color: var(--text-mute); margin: 0 3px; }
  .brand-owner { color: var(--text-dim); font-family: 'JetBrains Mono', monospace;
                 font-size: 12px; font-weight: 400; }
  .header-right { display: flex; align-items: center; gap: 10px; font-size: 12px;
                  color: var(--text-faint); }
  button.logout { background: transparent; color: var(--text-dim); border: 1px solid var(--border-strong);
                  padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 12px;
                  font-family: inherit; transition: all 0.15s ease; }
  button.logout:hover { background: var(--bg-card-hover); color: var(--text); border-color: var(--text-mute); }

  /* ── Layout ────────────────────────────────────────────── */
  main { max-width: 1200px; margin: 0 auto; padding: 20px 20px 32px; }

  /* ── Page title ────────────────────────────────────────── */
  .page-title { display: flex; justify-content: space-between; align-items: baseline;
                margin-bottom: 14px; }
  .page-title h1 { margin: 0; font-size: 18px; font-weight: 600; letter-spacing: -0.02em; }
  .page-title .meta { font-size: 11px; color: var(--text-faint);
                      font-family: 'JetBrains Mono', monospace; }

  /* ── Filters ────────────────────────────────────────────── */
  .filters { display: flex; gap: 6px; flex-wrap: wrap; align-items: center;
             margin-bottom: 14px; }
  .filter-pill { position: relative; display: inline-flex; align-items: center; }
  .filter-pill label { position: absolute; left: 11px; top: 50%; transform: translateY(-50%);
                       font-size: 11px; color: var(--text-faint); pointer-events: none;
                       z-index: 1; }
  .filter-pill select { padding: 5px 26px 5px 66px; background: var(--bg-card);
                        border: 1px solid var(--border); border-radius: 6px;
                        color: var(--text); font: inherit; font-size: 12px;
                        appearance: none; cursor: pointer; transition: all 0.15s ease;
                        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23a1a1aa' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E");
                        background-repeat: no-repeat; background-position: right 10px center; }
  .filter-pill select:hover { border-color: var(--border-strong); background-color: var(--bg-card-hover); }
  .filter-pill select:focus { outline: none; border-color: var(--text-mute);
                              box-shadow: 0 0 0 3px rgba(255,255,255,0.04); }

  /* ── Stat grid ─────────────────────────────────────────── */
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
               gap: 1px; background: var(--border); border: 1px solid var(--border);
               border-radius: 10px; overflow: hidden; margin-bottom: 14px; }
  .stat { background: var(--bg-card); padding: 12px 14px;
          transition: background 0.15s ease; }
  .stat:hover { background: var(--bg-card-hover); }
  .stat .label { font-size: 10px; color: var(--text-faint); text-transform: uppercase;
                 letter-spacing: 0.07em; font-weight: 500; }
  .stat .value { font-size: 22px; font-weight: 600; margin-top: 2px;
                 letter-spacing: -0.02em; font-feature-settings: 'tnum'; line-height: 1.15; }
  .stat .sub { font-size: 11px; color: var(--text-faint); margin-top: 2px; }
  .stat .sub.up { color: var(--success); }
  .stat .sub.down { color: var(--danger); }

  /* ── Sections ──────────────────────────────────────────── */
  section { background: var(--bg-card); border: 1px solid var(--border);
            border-radius: 10px; padding: 16px 18px; margin-bottom: 12px; }
  .section-head { display: flex; justify-content: space-between; align-items: baseline;
                  margin-bottom: 12px; }
  .section-head h2 { margin: 0; font-size: 13px; font-weight: 600; letter-spacing: -0.01em; }
  .section-head .desc { font-size: 11px; color: var(--text-faint); }

  /* ── DAU chart (SVG) ───────────────────────────────────── */
  #dau-chart { width: 100%; }
  .chart-svg { width: 100%; height: 220px; display: block; }
  .chart-grid line { stroke: var(--border); stroke-dasharray: 2 4; }
  .chart-label { fill: var(--text-faint); font-size: 10px;
                 font-family: 'JetBrains Mono', monospace; }
  .chart-empty { padding: 40px 20px; text-align: center; color: var(--text-faint);
                 font-size: 12px; }

  /* legend (per-line) */
  .chart-legend { display: flex; flex-wrap: wrap; gap: 12px;
                  margin-bottom: 10px; padding: 0 2px;
                  font-size: 11px; color: var(--text-dim); }
  .legend-item { display: inline-flex; align-items: center; gap: 5px;
                 font-family: 'Inter', sans-serif; }
  .legend-swatch { width: 7px; height: 7px; border-radius: 2px;
                   display: inline-block; }
  .legend-num { color: var(--text); font-family: 'JetBrains Mono', monospace;
                font-feature-settings: 'tnum'; font-size: 11px;
                margin-left: 2px; }

  /* ── Tables ────────────────────────────────────────────── */
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  thead tr { border-bottom: 1px solid var(--border); }
  th { text-align: left; padding: 7px 10px; color: var(--text-faint);
       font-weight: 500; font-size: 10px; text-transform: uppercase;
       letter-spacing: 0.06em; }
  tbody tr { border-bottom: 1px solid var(--border); transition: background 0.1s ease; }
  tbody tr:last-child { border-bottom: none; }
  tbody tr:hover { background: rgba(255,255,255,0.02); }
  td { padding: 7px 10px; color: var(--text); }
  td.mono { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 11px;
            color: var(--text-dim); }
  td.num { font-family: 'JetBrains Mono', monospace; font-feature-settings: 'tnum';
           color: var(--text-dim); text-align: right; }
  td.dim { color: var(--text-faint); }

  /* outcome pills */
  .pill { display: inline-flex; align-items: center; gap: 3px;
          padding: 1px 6px; border-radius: 4px; font-size: 10px;
          font-weight: 500; font-family: 'JetBrains Mono', monospace; }
  .pill::before { content: ''; width: 4px; height: 4px; border-radius: 50%; }
  .pill.success { background: var(--success-bg); color: var(--success); }
  .pill.success::before { background: var(--success); }
  .pill.error { background: var(--danger-bg); color: var(--danger); }
  .pill.error::before { background: var(--danger); }
  .pill.abandoned { background: var(--warning-bg); color: var(--warning); }
  .pill.abandoned::before { background: var(--warning); }
  .pill.unknown { background: rgba(161,161,170,0.1); color: var(--text-faint); }
  .pill.unknown::before { background: var(--text-faint); }

  .loading { padding: 30px; text-align: center; color: var(--text-faint); font-size: 12px; }
  .loading::after { content: '…'; animation: dots 1.4s steps(4, end) infinite; }
  @keyframes dots { 0%, 20% { content: ''; } 40% { content: '.'; } 60% { content: '..'; } 80%, 100% { content: '…'; } }
  .empty { padding: 30px 20px; text-align: center; color: var(--text-faint);
           font-size: 12px; font-style: italic; }
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
    <button class="logout" id="logout-btn" onclick="logout()">Sign out</button>
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

// Demo mode flag — preserved across all API calls so the rest of the
// dashboard talks to the synthetic data path. Set when the page is
// loaded with ?demo=1.
const IS_DEMO = new URLSearchParams(location.search).get('demo') === '1';

async function fetchData(endpoint) {
  const skill = document.getElementById('filter-skill').value;
  const win = document.getElementById('filter-window').value;
  const params = new URLSearchParams();
  if (skill) params.set('skill', skill);
  if (win) params.set('window_days', win);
  if (IS_DEMO) params.set('demo', '1');
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

// Render the DAU chart as inline SVG so it screenshots crisply.
// One line per sub-skill — colors come either from the row's "color"
// field (demo mode) or are assigned from a default palette (real data).
// Daily series are pivoted to skill→[{day, sessions}] and rendered as
// overlaid line+area paths with a legend above the chart.
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

  const PALETTE = ['#818cf8', '#22d3ee', '#c084fc', '#f472b6', '#34d399', '#fb923c', '#facc15', '#94a3b8'];

  // Pivot: skill -> { day -> sessions }
  const bySkill = {};
  for (const r of data) {
    const sk = r.skill || 'unknown';
    if (!bySkill[sk]) bySkill[sk] = { color: r.color || null, daily: {} };
    bySkill[sk].daily[r.day] = (bySkill[sk].daily[r.day] || 0) + Number(r.sessions || 0);
  }

  // Determine the contiguous date axis (min day → max day across all skills)
  const allDays = new Set();
  for (const sk of Object.values(bySkill)) {
    for (const d of Object.keys(sk.daily)) allDays.add(d);
  }
  const sortedDays = [...allDays].sort();
  if (sortedDays.length === 0) { el.className = 'chart-empty'; el.textContent = 'No activity.'; return; }
  const start = new Date(sortedDays[0] + 'T00:00:00Z');
  const end = new Date(sortedDays[sortedDays.length - 1] + 'T00:00:00Z');
  const axis = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    axis.push(d.toISOString().slice(0, 10));
  }

  // Build per-skill series aligned to axis, assign colors. Sort by total
  // sessions desc so the dominant skill renders last (on top).
  const skillEntries = Object.entries(bySkill)
    .map(([name, info]) => {
      const series = axis.map(day => ({ day, sessions: info.daily[day] || 0 }));
      const total = series.reduce((s, p) => s + p.sessions, 0);
      return { name, color: info.color, series, total };
    })
    .sort((a, b) => a.total - b.total); // smallest first so largest paints on top
  skillEntries.forEach((sk, i) => {
    if (!sk.color) sk.color = PALETTE[i % PALETTE.length];
  });

  // Chart dimensions — bumped height a bit to give legend room
  const W = 1000, H = 240, padL = 44, padR = 16, padT = 32, padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const maxY = Math.max(1, ...skillEntries.flatMap(sk => sk.series.map(p => p.sessions)));
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

  const xStep = axis.length > 1 ? innerW / (axis.length - 1) : 0;
  const xFor = i => padL + i * xStep;
  const yFor = v => padT + innerH - (v / niceMax) * innerH;

  const yTicks = [0, niceMax * 0.25, niceMax * 0.5, niceMax * 0.75, niceMax];
  const xLabels = axis.length <= 3
    ? axis.map((d, i) => ({ i, label: d.slice(5) }))
    : [
        { i: 0, label: axis[0].slice(5) },
        { i: Math.floor(axis.length / 2), label: axis[Math.floor(axis.length / 2)].slice(5) },
        { i: axis.length - 1, label: axis[axis.length - 1].slice(5) }
      ];

  // Build SVG line + area paths per skill. Gradient defs are also per-skill
  // so each line gets its own subtle fill underneath.
  const defs = skillEntries.map((sk, i) => \`
    <linearGradient id="grad-\${i}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="\${sk.color}" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="\${sk.color}" stop-opacity="0"/>
    </linearGradient>
  \`).join('');

  const lineGroups = skillEntries.map((sk, i) => {
    const linePath = sk.series.map((p, idx) => \`\${idx === 0 ? 'M' : 'L'} \${xFor(idx).toFixed(2)} \${yFor(p.sessions).toFixed(2)}\`).join(' ');
    const areaPath = \`\${linePath} L \${xFor(sk.series.length - 1).toFixed(2)} \${padT + innerH} L \${padL} \${padT + innerH} Z\`;
    return \`
      <path d="\${areaPath}" fill="url(#grad-\${i})" />
      <path d="\${linePath}" fill="none" stroke="\${sk.color}" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round"/>
    \`;
  }).join('');

  // Legend: render as inline-block badges above the chart. Sort largest first
  // so the top contributor is leftmost in the legend.
  const legendItems = [...skillEntries].sort((a, b) => b.total - a.total);
  el.innerHTML = \`
    <div class="chart-legend">
      \${legendItems.map(sk => \`
        <span class="legend-item">
          <span class="legend-swatch" style="background:\${sk.color}"></span>
          \${esc(sk.name)}
          <span class="legend-num">\${fmtNum(sk.total)}</span>
        </span>
      \`).join('')}
    </div>
    <svg class="chart-svg" viewBox="0 0 \${W} \${H}" preserveAspectRatio="none">
      <defs>\${defs}</defs>
      <g class="chart-grid">
        \${yTicks.map(t => \`<line x1="\${padL}" x2="\${W - padR}" y1="\${yFor(t)}" y2="\${yFor(t)}"/>\`).join('')}
      </g>
      <g class="chart-axis">
        \${yTicks.map(t => \`<text class="chart-label" x="\${padL - 8}" y="\${yFor(t) + 3}" text-anchor="end">\${fmtNum(t)}</text>\`).join('')}
        \${xLabels.map(x => \`<text class="chart-label" x="\${xFor(x.i)}" y="\${H - 8}" text-anchor="middle">\${esc(x.label)}</text>\`).join('')}
      </g>
      \${lineGroups}
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

// In demo mode hide the sign-out button (no real session to end).
if (IS_DEMO) {
  const btn = document.getElementById('logout-btn');
  if (btn) btn.style.display = 'none';
}

loadAll();
if (!IS_DEMO) setInterval(loadAll, 60000);  // refresh every 60s (skip in demo)
</script>
</body></html>`;
}

// ─── Demo data generator ─────────────────────────────────────
// Used by `?demo=1` to populate the dashboard with a believable rising
// curve for the screenshot we use in launch comms. Generates 30 days of
// activity across 4 sub-skills of first-tree, each with its own ramp
// timing and weight — so the multi-line chart looks busy and product-
// shaped (not a single boring curve).
export function demoData(kind) {
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today); d.setUTCDate(d.getUTCDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }

  // Four sub-skills with distinct trajectories. Each has its own
  // start/end size, ramp shape, and spike timing — so the chart shows
  // them crossing over and interleaving rather than being parallel.
  // (Reads like a real product: some features dominate early, others
  // catch up after a release.)
  const subSkills = [
    // skill        color       start  end    spikeDay spikeBoost  noisePhase
    { name: 'plan',    color: '#818cf8', start:  220, end: 6800,  spikeDay: 14, spikeBoost: 0.55, phase: 0.0 },
    { name: 'design',  color: '#22d3ee', start:  120, end: 5400,  spikeDay: 22, spikeBoost: 0.40, phase: 1.1 },
    { name: 'publish', color: '#c084fc', start:   80, end: 4300,  spikeDay: 18, spikeBoost: 0.65, phase: 2.3 },
    { name: 'review',  color: '#f472b6', start:   45, end: 3100,  spikeDay: 25, spikeBoost: 0.50, phase: 3.7 },
  ];

  const dauSeries = [];
  for (const sk of subSkills) {
    for (let i = 0; i < days.length; i++) {
      const day = days[i];
      const ratio = sk.end / sk.start;
      const base = sk.start * Math.pow(ratio, i / 29);
      const dow = new Date(day + 'T00:00:00Z').getUTCDay();
      const dipFactor = (dow === 0 || dow === 6) ? 0.78 : 1.0;
      const spike = 1 + sk.spikeBoost * Math.exp(-Math.pow((i - sk.spikeDay) / 2.2, 2));
      const noise = 0.78 + 0.42 * Math.abs(Math.sin(i * 1.7 + sk.phase));
      const sessions = Math.round(base * dipFactor * spike * noise);
      const events = Math.round(sessions * (1.6 + 0.2 * Math.sin(i + sk.phase)));
      const dau = Math.round(sessions * (0.55 + 0.08 * Math.cos(i + sk.phase)));
      dauSeries.push({ day, skill: sk.name, color: sk.color, dau, sessions, events });
    }
  }

  if (kind === 'dau') return dauSeries;

  if (kind === 'summary') {
    // One row per sub-skill — the dashboard's loadStats aggregates
    // them into the top stat cards. Per-skill success rates differ
    // slightly so they look like real product breakdowns.
    const successPctBySkill = { plan: 96.4, design: 94.1, publish: 92.8, review: 95.7 };
    const out = [];
    for (const sk of subSkills) {
      const rows = dauSeries.filter(r => r.skill === sk.name);
      const totalEvents = rows.reduce((s, r) => s + r.events, 0);
      const totalSessions = rows.reduce((s, r) => s + r.sessions, 0);
      const maxDau = Math.max(...rows.map(r => r.dau));
      const successRate = successPctBySkill[sk.name];
      const successes = Math.round(totalEvents * (successRate / 100));
      const errors = Math.round(totalEvents * 0.035);
      const abandoned = totalEvents - successes - errors;
      out.push({
        skill: sk.name,
        total_events: totalEvents,
        users: maxDau,
        sessions: totalSessions,
        successes,
        errors,
        abandoned,
        success_rate_pct: successRate,
        avg_duration_s: 40 + Math.round(Math.abs(Math.sin(sk.phase)) * 30),
        last_seen: new Date().toISOString(),
      });
    }
    return out;
  }

  if (kind === 'steps') {
    // Step breakdown across the 4 sub-skills. Roughly match the volumes
    // in the dau series so the math feels coherent.
    return [
      { skill: 'plan',    step: 'outline',  runs: 5821, ok: 5612, err:  91, bail: 118, success_pct: 96.4 },
      { skill: 'plan',    step: 'expand',   runs: 4602, ok: 4451, err:  82, bail:  69, success_pct: 96.7 },
      { skill: 'design',  step: 'wireframe',runs: 4485, ok: 4222, err: 197, bail:  66, success_pct: 94.1 },
      { skill: 'design',  step: 'palette',  runs: 3192, ok: 3041, err:  98, bail:  53, success_pct: 95.3 },
      { skill: 'publish', step: 'build',    runs: 3787, ok: 3499, err: 234, bail:  54, success_pct: 92.4 },
      { skill: 'publish', step: 'deploy',   runs: 3756, ok: 3501, err: 215, bail:  40, success_pct: 93.2 },
      { skill: 'review',  step: 'lint',     runs: 2756, ok: 2691, err:  41, bail:  24, success_pct: 97.6 },
      { skill: 'review',  step: 'critique', runs: 2102, ok: 2003, err:  62, bail:  37, success_pct: 95.3 },
    ];
  }

  if (kind === 'events') {
    const events = [
      // skill, step, success-rate-weight
      ['plan',    'outline'],
      ['plan',    'expand'],
      ['design',  'wireframe'],
      ['design',  'palette'],
      ['publish', 'build'],
      ['publish', 'deploy'],
      ['review',  'lint'],
      ['review',  'critique'],
    ];
    const errClasses = ['cloudflare_timeout', 'supabase_429', 'git_push_rejected', 'lint_failed'];
    const out = [];
    const now = new Date();
    for (let i = 0; i < 50; i++) {
      const ts = new Date(now.getTime() - i * 1000 * (45 + Math.floor(Math.abs(Math.sin(i*1.7))*180)));
      const seed = Math.abs(Math.sin(i * 2.7)) * 100;
      let outcome = 'success', err = null;
      if (seed > 96) { outcome = 'error'; err = errClasses[i % errClasses.length]; }
      else if (seed > 92) outcome = 'abandoned';
      const [skill, step] = events[i % events.length];
      const dur = Math.round(20 + Math.abs(Math.cos(i * 1.3)) * 140);
      out.push({
        t: ts.toISOString().slice(0, 19).replace('T', ' '),
        skill,
        event_type: 'skill_run',
        outcome,
        step,
        duration_s: dur,
        error_class: err,
      });
    }
    return out;
  }

  return [];
}

// ─── Worker entrypoint ────────────────────────────────────────
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    const method = req.method;
    const isDemo = url.searchParams.get('demo') === '1';

    // No CORS preflight needed — same-origin only.
    if (method === 'OPTIONS') return new Response(null, { status: 405 });

    // ─── Landing / dashboard ─────────────────────────────────
    if (p === '/' && method === 'GET') {
      // Demo mode: render the dashboard unauthenticated with a fake
      // owner slug. Used for launch screenshots; no Supabase data is
      // touched (the API endpoints below short-circuit on ?demo=1).
      if (isDemo) {
        return html(dashboardHtml('first-tree'));
      }
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
      // Demo mode short-circuit. Returns synthetic data without
      // touching Supabase or requiring a session. Only `?demo=1`
      // triggers this; real data still requires owner sign-in.
      if (isDemo) {
        const kind = p.replace('/api/', '');
        return json(demoData(kind));
      }
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
