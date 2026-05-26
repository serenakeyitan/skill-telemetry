# skill-telemetry dashboard

Owner-only private dashboard for skill creators to view their own
telemetry data. **Two ways to run it — same UI, same charts.**

## Three ways to run it

**TL;DR:** Local for yourself (zero deploy), Cloudflare for sharing.

### 1. Demo mode (30 seconds, synthetic data)

```bash
npm run demo
# → http://localhost:8787/?demo=1
```

The fastest way to see if you want this. Renders a fake `first-tree`
skill with 30 days of synthetic data. No Supabase needed.

### 2. Local with your real data (~3 minutes)

You'll need:
- Node 18+
- Your skill-telemetry Supabase already set up (see [main README](../README.md))
- Your project's **`service_role`** key from Supabase Dashboard → Settings → API

```bash
cp ../supabase/config.local.sh.example ../supabase/config.local.sh
# Edit config.local.sh — paste your project URL + service_role key
npm start
# → http://localhost:8787
```

Security:
- Server binds to `127.0.0.1` only (never LAN/public)
- Host header allowlist defeats DNS rebinding from a malicious site
- `config.local.sh` is gitignored — the service_role key never leaves
  your machine

### 3. Hosted on Cloudflare Workers (~10 minutes, for sharing)

Runs on Cloudflare Workers' free tier, authenticates via GitHub Device
Flow, queries Supabase via service_role (server-side only — the key
never leaves the worker). [See setup steps below.](#hosted-setup-one-time-10-minutes)

If you don't need to share the dashboard, stop here — local mode above
is enough.

## Architecture

```
You → workers.dev URL → Worker
                          ↓
            Cookie? owner? → Show dashboard
                          ↓
            queries via service_role → Supabase
                          ↓
            JSON back to browser
```

**Privacy properties:**

- The dashboard URL is public, but only the configured GitHub owner
  can sign in and see data.
- The Supabase `service_role` key (which has full read access) lives
  only in Cloudflare worker secrets — never in client JavaScript,
  never in git.
- Each fork deploys its own worker with its own secrets. Two
  authors who fork this code can NEVER see each other's data.

## Hosted setup (one-time, ~10 minutes)

### Prereqs

- A Cloudflare account (free)
- `wrangler` CLI: `npm install -g wrangler`
- Your skill-telemetry Supabase already up (see [main README](../README.md))

### 1. Get your Supabase `service_role` key

1. Supabase Dashboard → Settings → API
2. Find **`service_role`** under "Project API Keys"
3. Copy it. **Never share, never commit.**

### 2. Configure the worker

```bash
cd dashboard/
cp wrangler.toml.template wrangler.toml
```

Edit `wrangler.toml`:

- `SKILL_TELEMETRY_OWNER` — your GitHub username (e.g., `serenakeyitan`)
- `SUPABASE_URL` — your Supabase project URL (e.g., `https://abc123.supabase.co`)
- `KV_ID` — fill after the next step

### 3. Create KV namespace for sessions

```bash
wrangler kv namespace create SESSIONS
```

Copy the printed `id = "..."` into `wrangler.toml` under `[[kv_namespaces]]`.

### 4. Store the Supabase service_role key as a secret

```bash
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
# Paste the key when prompted, press Enter
```

### 5. Deploy

```bash
wrangler deploy
```

Output gives you a URL like `https://skill-telemetry-dashboard.yourname.workers.dev`. Open it.

### 6. Sign in

- Click "Sign in with GitHub"
- A device code appears on screen
- Open `github.com/login/device` in another tab, paste the code, approve
- Worker checks your GitHub username matches `SKILL_TELEMETRY_OWNER` — if yes, sets a 30-day cookie and lets you in

If you see "you signed in as X but the configured owner is Y", you signed into the wrong GitHub account. Sign out at github.com, then try again.

## What the dashboard shows

| Panel | Data |
|---|---|
| **Stat cards** | Total events, distinct users, sessions, success rate |
| **Daily activity** | DAU / sessions / events per day |
| **Step breakdown** | Which sub-commands of your skill are used most + their success rates |
| **Recent events** | Last 50 events with outcome / step / error |

Filters at the top: by skill, by time window (24h / 7d / 30d / all).
Refresh button reloads every 60s automatically.

## Re-deploy after changes

```bash
wrangler deploy
```

Changes to `worker.js` are live in ~10 seconds.

## Costs

Cloudflare Workers free tier covers:
- 100,000 requests/day
- 1,000 KV reads/day

A solo skill creator checking their dashboard a few times a week
will use far less than 1% of this.

## Security model — what's protected, what's not

| Property | Status |
|---|---|
| Supabase service_role key | ✅ In worker secret only |
| Worker URL is public | ⚠️ Yes — but visitors only get a sign-in page |
| Only configured owner can see data | ✅ Enforced via `SKILL_TELEMETRY_OWNER` check |
| Cookies | ✅ HttpOnly, Secure, SameSite=Lax, 30-day TTL |
| RLS on Supabase table | ✅ Yes — anon key can't read, only edge function (with service_role) can write |
| Fork safety | ✅ Each fork has its own secrets — no cross-contamination |

## Troubleshooting

**"GITHUB_CLIENT_ID not set"** — check `wrangler.toml` has the `[vars]` block with the right values.

**"You signed in as X, but configured owner is Y"** — sign out of github.com and back in with the right account, then retry.

**Dashboard loads but says "Loading…" forever** — open browser DevTools → Network tab → look for failing `/api/*` requests. Most likely your `SUPABASE_SERVICE_ROLE_KEY` is missing or wrong. Re-run `wrangler secret put SUPABASE_SERVICE_ROLE_KEY`.

**"unauthorized" on data endpoints** — your session cookie expired. Refresh page → sign in again.

## License

MIT. Same as the parent skill-telemetry project.
