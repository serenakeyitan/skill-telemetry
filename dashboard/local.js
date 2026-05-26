#!/usr/bin/env node
// dashboard/local.js — zero-deploy local dashboard.
//
// Run: `node dashboard/local.js` (or `npm run dashboard` if you alias it)
// Opens http://localhost:8787 with the same UI as the deployed Cloudflare
// Worker. Skips GitHub auth — localhost requests are the owner by
// definition. Reads your Supabase service-role key from
// supabase/config.sh OR from env vars.
//
// Why this exists: the production dashboard requires Cloudflare account
// signup + wrangler deploy. That's friction. For 90% of skill authors
// the local-only flow is enough: see your numbers, no DNS, no secrets in
// some else's cloud.
//
// Required (one of):
//   - supabase/config.sh in your skill's telemetry/ directory with
//     SKILL_TELEMETRY_SUPABASE_URL + SKILL_TELEMETRY_SERVICE_ROLE_KEY
//   - SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env vars
//
// Optional env:
//   PORT=8787                — port to bind (default 8787)
//   SKILL_TELEMETRY_DEMO=1   — use synthetic data, skip Supabase entirely

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { dashboardHtml, sbView, demoData } from './worker.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Load Supabase config ─────────────────────────────────────
// Resolution order:
//   1. SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env vars (explicit)
//   2. ./supabase/config.sh next to this script (skill author dev case)
//   3. ~/.claude/skills/*/telemetry/supabase/config.sh (installed skills)
// Note: config.sh ships only the anon key for telemetry-log; the
// service-role key has to come from env or a separate local-only file
// the user creates. We accept either name to be friendly.
function loadConfig() {
  const env = process.env;
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    return {
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
    };
  }

  // Try config.sh in several common locations
  const candidates = [
    resolve(__dirname, '../supabase/config.sh'),
    resolve(__dirname, '../supabase/config.local.sh'),
    ...(process.env.HOME
      ? [
          `${process.env.HOME}/.claude/skills/skill-telemetry/telemetry/supabase/config.sh`,
        ]
      : []),
  ];

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const txt = readFileSync(path, 'utf8');
    const url = matchShVar(txt, 'SKILL_TELEMETRY_SUPABASE_URL') || matchShVar(txt, 'SUPABASE_URL');
    const sr =
      matchShVar(txt, 'SKILL_TELEMETRY_SERVICE_ROLE_KEY') ||
      matchShVar(txt, 'SUPABASE_SERVICE_ROLE_KEY');
    if (url && sr) {
      console.error(`✓ loaded Supabase config from ${path}`);
      return { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: sr };
    }
    // URL but no service-role: tell the user *which* file they need to edit
    if (url && !sr) {
      console.error(`✓ found ${path} but no service-role key in it`);
      console.error(`  add a line:   export SKILL_TELEMETRY_SERVICE_ROLE_KEY="<your service_role key>"`);
      console.error(`  ⚠️  this file should NOT be committed — add to .gitignore`);
    }
  }
  return null;
}

// Match `export FOO="bar"` or `FOO=bar` in a shell config file.
function matchShVar(txt, name) {
  const re = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?${name}=("[^"]*"|'[^']*'|\\S+)`, 'm');
  const m = txt.match(re);
  if (!m) return null;
  return m[1].replace(/^["']|["']$/g, '');
}

const cfg = loadConfig();
const isDemo = process.env.SKILL_TELEMETRY_DEMO === '1';

if (!cfg && !isDemo) {
  console.error('\n✗ no Supabase config found.');
  console.error('\nYou need one of:');
  console.error('  1. Run with env vars:');
  console.error('     SUPABASE_URL=https://xxx.supabase.co \\');
  console.error('     SUPABASE_SERVICE_ROLE_KEY=eyJ... \\');
  console.error('     node dashboard/local.js');
  console.error('\n  2. Create supabase/config.local.sh next to this script with:');
  console.error('     export SKILL_TELEMETRY_SUPABASE_URL="https://xxx.supabase.co"');
  console.error('     export SKILL_TELEMETRY_SERVICE_ROLE_KEY="eyJ..."');
  console.error('\n  3. Run in demo mode (synthetic data, no Supabase):');
  console.error('     SKILL_TELEMETRY_DEMO=1 node dashboard/local.js');
  console.error('\nFind your service-role key at:');
  console.error('  Supabase Dashboard → Settings → API → service_role  (the secret one)');
  process.exit(1);
}

// ─── Build a fake "env" object that mirrors the Worker contract ──
// sbView() reads env.SUPABASE_URL + env.SUPABASE_SERVICE_ROLE_KEY.
const env = cfg || {};

// ─── HTTP server ──────────────────────────────────────────────
const PORT = parseInt(process.env.PORT, 10) || 8787;

// DNS-rebinding defense. Binding to 127.0.0.1 alone is not enough:
// an attacker site (`evil.com`) can use DNS rebinding (TTL=0 returns
// 127.0.0.1 after first request) so the browser thinks evil.com IS
// localhost — and our service-role-key proxy happily returns data.
// We pin Host to known-safe local-loopback values; any other value
// is rejected with 421 (Misdirected Request).
const ALLOWED_HOSTS = new Set([
  `localhost:${PORT}`,
  `127.0.0.1:${PORT}`,
  `[::1]:${PORT}`,
]);

const server = createServer(async (req, res) => {
  // 1) Host-header allowlist (DNS-rebinding defense)
  const hostHeader = (req.headers.host || '').toLowerCase();
  if (!ALLOWED_HOSTS.has(hostHeader)) {
    res.writeHead(421, { 'Content-Type': 'text/plain' });
    res.end('misdirected request — this dashboard only serves localhost:' + PORT);
    return;
  }

  const url = new URL(req.url, `http://${hostHeader}`);
  const p = url.pathname;
  const method = req.method;

  // 2) Local-only: skip auth. 127.0.0.1 == owner. Bind below to localhost.
  const requestIsDemo = isDemo || url.searchParams.get('demo') === '1';

  // Render landing → just redirect into the dashboard, no sign-in.
  if (p === '/' && method === 'GET') {
    const owner = requestIsDemo ? 'first-tree' : 'local';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(dashboardHtml(owner));
    return;
  }

  // Data endpoints — same shape as the Worker
  const dataEndpoints = ['/api/summary', '/api/dau', '/api/steps', '/api/events'];
  if (dataEndpoints.includes(p) && method === 'GET') {
    if (requestIsDemo) {
      const kind = p.replace('/api/', '');
      return sendJson(res, 200, demoData(kind));
    }
    const skill = url.searchParams.get('skill');
    const windowDays = url.searchParams.get('window_days');
    try {
      const data = await runApi(p, { skill, windowDays });
      return sendJson(res, 200, data);
    } catch (e) {
      console.error(`✗ ${p} failed:`, e.message);
      return sendJson(res, 500, { error: 'supabase_failed', message: e.message });
    }
  }

  // Auth stubs — the dashboard's logout button hits this. No-op locally.
  if (p === '/api/auth/logout' && method === 'POST') {
    return sendJson(res, 200, { ok: true });
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// ─── Data fetchers — mirror the Worker's /api/* logic ─────────
// We re-implement the four endpoints here using sbView. Kept verbatim
// from worker.js so behaviour matches; if you change one place change
// both. (Worth a future refactor into shared helpers.)
async function runApi(path, { skill, windowDays }) {
  if (path === '/api/summary') {
    const filter = {};
    if (skill) filter.skill = `eq.${skill}`;
    return await sbView(env, 'skill_usage_summary', {
      order: 'total_events.desc',
      filter,
    });
  }
  if (path === '/api/dau') {
    const filter = {};
    if (skill) filter.skill = `eq.${skill}`;
    if (windowDays) {
      const since = new Date(Date.now() - parseInt(windowDays, 10) * 86400000)
        .toISOString()
        .slice(0, 10);
      filter.day = `gte.${since}`;
    }
    return await sbView(env, 'skill_dau', {
      order: 'day.desc',
      filter,
      limit: 30,
    });
  }
  if (path === '/api/steps') {
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
    const agg = {};
    for (const e of events) {
      if (!e.step) continue;
      const key = `${e.skill}|${e.step}`;
      if (!agg[key])
        agg[key] = { skill: e.skill, step: e.step, runs: 0, ok: 0, err: 0, bail: 0 };
      agg[key].runs++;
      if (e.outcome === 'success') agg[key].ok++;
      else if (e.outcome === 'error') agg[key].err++;
      else if (e.outcome === 'abandoned') agg[key].bail++;
    }
    return Object.values(agg)
      .map(r => ({ ...r, success_pct: r.runs ? Math.round((r.ok / r.runs) * 1000) / 10 : 0 }))
      .sort((a, b) => b.runs - a.runs);
  }
  if (path === '/api/events') {
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
    return events.map(e => ({
      ...e,
      t: new Date(e.ts).toLocaleString('en-CA', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).replace(',', ''),
    }));
  }
  throw new Error(`unknown endpoint: ${path}`);
}

// Bind to localhost ONLY so we never accidentally expose service-role
// data on a LAN or public interface.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n✗ port ${PORT} is already in use.`);
    console.error('  Either close whatever is using it, or set a different port:');
    console.error(`     PORT=8801 npm start`);
    console.error(`     PORT=8801 npm run demo`);
    process.exit(1);
  }
  if (err.code === 'EACCES') {
    console.error(`\n✗ permission denied binding port ${PORT}.`);
    console.error('  Pick a port > 1024:   PORT=8801 npm start');
    process.exit(1);
  }
  console.error('\n✗ server error:', err.message);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}${isDemo ? '/?demo=1' : ''}`;
  console.error('\n📊 skill-telemetry dashboard');
  console.error(`   ${isDemo ? 'demo mode (synthetic data)' : 'connected to ' + cfg.SUPABASE_URL}`);
  console.error(`   → ${url}\n`);
  console.error('   press Ctrl+C to stop');
});
