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
async function sb(env, sql) {
  const url = `${env.SUPABASE_URL}/rest/v1/rpc/exec_sql`;
  // Supabase REST doesn't expose arbitrary SQL by default. Use the
  // Postgres protocol via pg-meta endpoint if available, otherwise
  // use the documented Management API style query.
  // Actually, use direct PostgREST querying via specific endpoints:
  // /rest/v1/<view>?select=*&...
  // This is safer (no SQL injection risk) and uses RLS.
  // For our needs, we just hit pre-defined views.
  throw new Error('Use sbView directly');
}

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
<title>skill-telemetry dashboard</title>
<style>
  body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
         max-width: 480px; margin: 80px auto; padding: 0 24px; color: #222; }
  h1 { margin-bottom: 8px; }
  .sub { color: #666; margin-top: 0; }
  button { padding: 10px 18px; font-size: 15px; border: 1px solid #222; background: #111; color: #fff;
           border-radius: 6px; cursor: pointer; margin-top: 16px; }
  button:hover { background: #333; }
  .codebox { background: #f4f4f4; padding: 16px; border-radius: 6px; margin: 16px 0;
             font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 18px;
             letter-spacing: 0.1em; text-align: center; }
  .small { font-size: 13px; color: #666; }
  a { color: #2952cc; }
  .err { color: #b00020; background: #fff0f0; padding: 12px; border-radius: 4px; margin: 12px 0; }
</style>
</head><body>
<h1>skill-telemetry dashboard</h1>
<p class="sub">Private. Only the configured owner can sign in.</p>

<div id="step-start">
  <p>This dashboard is for the owner of this skill's telemetry data — usually
  the skill creator. ${owner ? `Configured owner: <code>${owner}</code>` : `<span class="err">No owner configured. Set <code>SKILL_TELEMETRY_OWNER</code> in wrangler.toml.</span>`}</p>
  <button onclick="startAuth()">Sign in with GitHub</button>
</div>

<div id="step-code" style="display:none;">
  <p>Go to <a id="ghurl" href="" target="_blank">github.com/login/device</a> and enter this code:</p>
  <div class="codebox" id="usercode">—</div>
  <p class="small">Waiting for GitHub approval… <span id="status"></span></p>
</div>

<div id="error" class="err" style="display:none;"></div>

<p class="small" style="margin-top: 40px;">
Open source · <a href="https://github.com/serenakeyitan/skill-telemetry">github.com/serenakeyitan/skill-telemetry</a>
</p>

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
<title>skill-telemetry — ${owner}'s dashboard</title>
<style>
  body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
         margin: 0; padding: 0; color: #222; background: #fafafa; }
  header { background: #111; color: #fff; padding: 14px 24px; display: flex;
           align-items: center; justify-content: space-between; }
  header h1 { margin: 0; font-size: 16px; font-weight: 500; }
  header .right { font-size: 13px; opacity: 0.8; }
  header a { color: #fff; }
  main { max-width: 1200px; margin: 24px auto; padding: 0 24px; }
  .filters { background: #fff; padding: 16px; border-radius: 6px; margin-bottom: 16px;
             border: 1px solid #e5e5e7; display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
  .filters label { font-size: 13px; color: #666; }
  .filters select, .filters input { padding: 6px 10px; border: 1px solid #d0d0d2; border-radius: 4px;
                                    font: inherit; font-size: 13px; background: #fff; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
          gap: 12px; margin-bottom: 24px; }
  .stat { background: #fff; padding: 16px; border-radius: 6px; border: 1px solid #e5e5e7; }
  .stat .label { font-size: 12px; color: #666; text-transform: uppercase; letter-spacing: 0.05em; }
  .stat .value { font-size: 28px; font-weight: 600; margin-top: 4px; }
  .stat .sub { font-size: 12px; color: #888; margin-top: 4px; }
  section { background: #fff; padding: 16px 20px; border-radius: 6px; margin-bottom: 16px;
            border: 1px solid #e5e5e7; }
  section h2 { margin-top: 0; font-size: 15px; font-weight: 600; color: #444; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 8px; background: #fafafa; border-bottom: 1px solid #e5e5e7;
       color: #555; font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
  td { padding: 8px; border-bottom: 1px solid #f0f0f0; }
  td.outcome-success { color: #16803c; }
  td.outcome-error { color: #b00020; }
  td.outcome-abandoned { color: #a05a00; }
  td.outcome-unknown { color: #777; }
  td.mono { font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 12px; color: #666; }
  .loading { padding: 40px; text-align: center; color: #888; }
  .empty { padding: 24px; text-align: center; color: #888; font-style: italic; }
  button.logout { background: transparent; color: #fff; border: 1px solid #555; padding: 4px 10px;
                  border-radius: 4px; cursor: pointer; font-size: 12px; }
  button.logout:hover { background: #333; }
</style>
</head><body>

<header>
  <h1>📊 skill-telemetry — <span id="owner-name">${owner}</span></h1>
  <div class="right">
    Signed in · <button class="logout" onclick="logout()">Sign out</button>
  </div>
</header>

<main>
  <div class="filters">
    <label>Skill:
      <select id="filter-skill" onchange="loadAll()">
        <option value="">All</option>
      </select>
    </label>
    <label>Time:
      <select id="filter-window" onchange="loadAll()">
        <option value="1">Last 24h</option>
        <option value="7" selected>Last 7 days</option>
        <option value="30">Last 30 days</option>
        <option value="">All time</option>
      </select>
    </label>
    <span style="margin-left: auto; font-size: 12px; color: #888;" id="updated-at"></span>
  </div>

  <div class="grid" id="stats"></div>

  <section>
    <h2>Daily activity</h2>
    <div id="dau-table" class="loading">Loading…</div>
  </section>

  <section>
    <h2>Step breakdown</h2>
    <div id="step-table" class="loading">Loading…</div>
  </section>

  <section>
    <h2>Recent events</h2>
    <div id="events-table" class="loading">Loading…</div>
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

  const successRate = data.length > 0 ?
    (data.reduce((s, r) => s + (r.successes || 0), 0) /
     Math.max(totals.events, 1) * 100).toFixed(1) : '0';

  document.getElementById('stats').innerHTML = \`
    <div class="stat"><div class="label">Total events</div><div class="value">\${totals.events}</div></div>
    <div class="stat"><div class="label">Distinct users</div><div class="value">\${totals.users}</div></div>
    <div class="stat"><div class="label">Sessions</div><div class="value">\${totals.sessions}</div></div>
    <div class="stat"><div class="label">Success rate</div><div class="value">\${successRate}%</div></div>
  \`;
}

async function loadDau() {
  const data = await fetchData('dau');
  if (!data) return;
  const el = document.getElementById('dau-table');
  if (!data || data.length === 0) { el.className = 'empty'; el.textContent = 'No data in this window.'; return; }
  el.className = '';
  el.innerHTML = \`
    <table>
      <thead><tr><th>Day</th><th>Skill</th><th>DAU</th><th>Sessions</th><th>Events</th></tr></thead>
      <tbody>
        \${data.map(r => \`
          <tr>
            <td class="mono">\${esc(r.day)}</td>
            <td>\${esc(r.skill)}</td>
            <td>\${esc(r.dau)}</td>
            <td>\${esc(r.sessions)}</td>
            <td>\${esc(r.events)}</td>
          </tr>
        \`).join('')}
      </tbody>
    </table>
  \`;
}

async function loadSteps() {
  const data = await fetchData('steps');
  if (!data) return;
  const el = document.getElementById('step-table');
  if (!data || data.length === 0) { el.className = 'empty'; el.textContent = 'No step data.'; return; }
  el.className = '';
  el.innerHTML = \`
    <table>
      <thead><tr><th>Step</th><th>Skill</th><th>Runs</th><th>Success</th><th>Error</th><th>Abandoned</th><th>Success %</th></tr></thead>
      <tbody>
        \${data.map(r => \`
          <tr>
            <td>\${esc(r.step || '-')}</td>
            <td>\${esc(r.skill)}</td>
            <td>\${esc(r.runs)}</td>
            <td class="outcome-success">\${esc(r.ok)}</td>
            <td class="outcome-error">\${esc(r.err)}</td>
            <td class="outcome-abandoned">\${esc(r.bail)}</td>
            <td>\${esc(r.success_pct)}%</td>
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
      <thead><tr><th>Time</th><th>Skill</th><th>Event</th><th>Outcome</th><th>Step</th><th>Duration</th><th>Error</th></tr></thead>
      <tbody>
        \${data.map(r => \`
          <tr>
            <td class="mono">\${esc(r.t)}</td>
            <td>\${esc(r.skill)}</td>
            <td>\${esc(r.event_type || 'skill_run')}</td>
            <td class="outcome-\${esc(r.outcome || 'unknown')}">\${esc(r.outcome || '-')}</td>
            <td>\${esc(r.step || '-')}</td>
            <td>\${r.duration_s != null ? esc(r.duration_s + 's') : '-'}</td>
            <td class="outcome-error">\${esc(r.error_class || '')}</td>
          </tr>
        \`).join('')}
      </tbody>
    </table>
  \`;
}

async function loadAll() {
  document.getElementById('updated-at').textContent = 'Updating…';
  try {
    await Promise.all([loadStats(), loadDau(), loadSteps(), loadEvents()]);
    const now = new Date();
    document.getElementById('updated-at').textContent = 'Updated ' + now.toLocaleTimeString();
  } catch (e) {
    document.getElementById('updated-at').textContent = 'Error: ' + e.message;
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
            const since = new Date(Date.now() - parseInt(windowDays) * 86400000).toISOString().slice(0, 10);
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
            const since = new Date(Date.now() - parseInt(windowDays) * 86400000).toISOString();
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
            const since = new Date(Date.now() - parseInt(windowDays) * 86400000).toISOString();
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
