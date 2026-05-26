# Changelog

All notable changes to skill-telemetry.

## v1.1.0 — local dashboard + visual polish

Headline: **the dashboard now runs locally with one command.** No
Cloudflare account needed, no deploy step, no DNS. Same UI either way.

### Added

- **`dashboard/local.js`** — plain Node ESM HTTP server. `npm start`
  binds `127.0.0.1:8787` and serves the same dashboard against your
  own Supabase. Skips GitHub Device Flow because localhost = owner.
- **`dashboard/?demo=1`** — synthetic-data mode for screenshots and
  evaluating the project before you commit. Renders a fake `first-tree`
  skill with 30 days of realistic multi-line activity.
- **Multi-line chart** — daily activity now plots one line per
  sub-skill with a legend, gradient fills, and crossover. Looks like
  a real product, not a single boring curve.
- **DNS rebinding defense** — `local.js` validates the `Host` header
  against an allowlist (`localhost:PORT`, `127.0.0.1:PORT`, `[::1]:PORT`)
  and returns HTTP 421 for anything else. A malicious site cannot
  rebind to your localhost server even if it tricks the browser into
  connecting.
- **`--source` flag on `telemetry-log`** — `live` / `hook` / `replay`.
  The Stop hook now emits `source=hook` so dashboards can distinguish
  hook-captured events from SKILL.md self-reports.
- **`README.md`** — new "See it instantly (no setup)" section near the
  top, and "Where the telemetry call lives — SKILL.md vs Stop hook"
  dogfooded scorecard before Install.
- **`CONTRIBUTING.md`** — how to run the test suite, where to file
  issues, what we care about in PRs.
- **`supabase/config.local.sh.example`** — template users copy. Already
  gitignored along with the new `dashboard/node_modules/`.

### Changed

- **Dashboard visual polish** — dark mode (zinc-900), Inter for headers,
  JetBrains Mono for nums, hairline borders, hover lift, outcome pills
  with leading status dots, real SVG sparkline (not a table).
- **Stat cards shrunk** for density — 32px → 22px numbers, 20×22 → 12×14
  padding. Whole dashboard fits one viewport.
- **`bin/skill-events` validators hoisted** above config lookup so an
  injection payload is rejected before any file is read.
- **`bin/telemetry-log`**: improved portable hasher chain
  (`sha256sum → sha1sum → shasum -a 256 → od`); now works on minimal
  Alpine/musl images.
- **`bin/telemetry-sync`**: prefers `jq` over `sed` when parsing JSON
  (more robust against `error_message` containing `"ts":"..."`).
- **README.md**: source column doc + apologetic config.sh paragraph
  rewritten in security-positive voice.

### Fixed

- `parseInt(windowDays, 10)` — explicit radix on all 3 sites in
  `worker.js`.
- `skill-telemetry-update` clamps exit code to 0/1 (no mod-256 wrap).
- Removed dead `sb()` function in `dashboard/worker.js`.
- Consistent timestamp parsing between `telemetry-hook` and
  `telemetry-sync` (shared `ts_to_epoch` helper).
- `--outcome completed` default in the hook was being rewritten to
  `unknown` by `telemetry-log`'s validator → now defaults to `success`.

## v1.0.0 — production-ready

First stable release. Pipeline is feature-complete and survived two
forensic audits (one internal, one Codex second-opinion) plus a
polish-pass cleanup of all remaining sev-2 items.

### Hardening (v1.0.0)

- **CI**: `.github/workflows/ci.yml` runs `bash -n`, shellcheck, smoke
  tests, Node `--check` on the dashboard worker, and `deno check` on the
  edge function on every push and PR.
- **Smoke tests**: `tests/smoke.sh` covers 10 invariants — JSONL write,
  outcome persistence, path-traversal containment, SQL-injection
  rejection, unknown-flag warnings, hook idempotency. Runs in CI.
- **F18+F21 — portable hasher**: `telemetry-log` now tries `sha256sum`
  → `sha1sum` → `shasum -a 256` → `od` for the installation-id fallback,
  so it works on minimal Alpine/musl images without Perl.
- **F19 — dead code**: removed unused `sb()` function in
  `dashboard/worker.js`. All Supabase reads go through `sbView` (only
  pre-defined PostgREST views, no arbitrary SQL).
- **F23 — `parseInt` radix**: all three `parseInt(windowDays)` calls in
  `worker.js` now pass `10` explicitly. Defensive against an octal
  re-interpretation of e.g. `"08"`.
- **F24 — `jq` over `sed` on JSON**: `telemetry-sync` now uses `jq` to
  read `ts` and rewrite `source = "replay"` when jq is available
  (which is the common case — we already require it for the cleaning
  step above). The sed branch survives as a portability fallback.
- **F16 — exit-code wrap**: `skill-telemetry-update` clamps `$FAILED`
  to 0/1 instead of `exit "$FAILED"` (which would mod-256 wrap to 0 if
  somehow ≥256 skills failed).
- **Precedence-safe checks**: replaced `[ -x "$TEL_BIN" ] && : || exit`
  in `telemetry-hook` with explicit `if … then`.
- **Consistent timestamp parsing**: `telemetry-hook` and
  `telemetry-sync` now use the same GNU/BSD `date` fallback chain via
  a shared helper.

## v0.10.2 — Codex second-opinion audit

Independent forensic pass surfaced six real findings beyond the first
auditor's list. All fixed; v0.10.0 + v0.10.1 fixes (F1-F22) verified
to still hold.

- **C1**: Hook emitted `outcome=completed`, but `telemetry-log` validates
  against `{success,error,abandoned,unknown}` — every successful
  hook-captured run was silently misclassified as `unknown`. Default
  changed to `success`.
- **C2**: Raw `session_id` from JSON payload flowed into filesystem
  paths. A crafted `"../../x"` id would escape the analytics dir. Now
  derives `SESSION_ID_SAFE` via `tr -cd 'A-Za-z0-9_-'` everywhere the
  value becomes a path segment; raw value still used only in the JSON
  payload (where it's properly quoted).
- **C3**: `skill-events --limit` was interpolated raw into SQL sent with
  a management PAT. Now requires digits-only, clamps to [1, 1000].
- **C4**: Dashboard `/api/summary` ignored `window_days` but UI implied
  global filter. Filter relabelled to scope only the lower sections;
  stat cards explicitly marked "All-time totals".
- **C5**: README contradicted `.gitignore` on whether to commit
  `supabase/config.sh`. Clarified: upstream excludes its own; skill
  authors copying `telemetry/` into their skill repo DO want to commit
  theirs. `ARCHITECTURE.md` "no global hooks" claim updated to mention
  the opt-in per-skill hook.
- **C6**: Hardcoded `serenakeyitan/skill-telemetry` URL in update check.
  `telemetry-update-check` now auto-derives from local git origin, with
  env override; meta-skill clone honors `$SKILL_TELEMETRY_CLONE_URL`.

Codex's finding #1 (broken hook entry shape) verified as a false
positive — the Claude Code Stop schema IS `Stop: [{ hooks: [...] }]`,
end-to-end install/uninstall idempotency test passes.

## v0.10.1 — remaining sev-3 audit fixes

- **F10**: `telemetry-log` warns on unknown flags via stderr so typos
  like `--erro-class` don't silently swallow values.
- **F12**: `telemetry-sync` quarantines jq-parse failures into
  `.quarantine.jsonl` instead of silent drop.
- **F13**: `telemetry-log is_version_snoozed()` validates `until_epoch`
  is numeric before comparison.
- **F15**: meta-skill `SKILL.md` reads VERSION from
  `$ST_ROOT/VERSION` (single source of truth after dedup).
- **F9**: multi-day sync race verified to NOT be a bug. `wc -l` and
  bash `read` both consistently ignore partial trailing lines.

## v0.10.0 — codebase audit fixes

First forensic audit (24 issues, smell-scale 5/10). Shipped 11 fixes
covering 6 critical security + 5 important sev-3 + doc drift.

- **F1**: `.gitignore` covers `**/supabase/config.sh`,
  `dashboard/wrangler.toml`, `dashboard/.wrangler/`.
- **F2**: dashboard `esc()` helper HTML-escapes all user-derived
  telemetry fields (XSS via crafted skill name / error message).
- **F3**: `telemetry-hook` removed `ERROR_TEXT` extraction from
  transcript tail. The privacy promise (no prompts, no replies) is now
  enforced — only low-cardinality error class tags ship.
- **F4**: `telemetry-hook` duration uses `tail -1` for the most recent
  Skill call (was `head -1`, which over-reported when a single
  transcript was re-used across sessions).
- **F5**: meta-skill `SKILL.md` Step 6 bash conditional restructured
  into a well-formed `if/else/fi` inside the code fence.
- **F6**: dashboard `OPTIONS` returns 405 (no CORS pre-flight leak).
- **F7**: edge function rejects invalid `ts` gracefully — sanitized to
  `new Date().toISOString()` instead of failing the whole batch.
- **F8**: `skill-events` validates `TZ` and `--skill` for shell-safe
  chars before string-interpolating them into SQL.
- **F11**: `telemetry-hook` bash `||` precedence fix.
- **F14**: edge function `safeTs` validation (`Date.parse` → fallback
  to `now()`).
- **F22**: `telemetry-hook-install` validates `--skill` against
  `^[A-Za-z0-9_-]+$` before embedding it in the shell command.

## Pre-v0.10.0

See git log. Highlights:
- v0.9.0 — owner-only dashboard worker (GitHub Device Flow).
- v0.8.0 — `supabase/dashboard.sql` with 12 ready-to-paste queries.
- v0.5.0 — gstack-style auto-upgrade with first-run prompt.
- v0.3.0 — full gstack-parity event schema (author pool + 4 fields).
- v0.2.0 — `schema_version`, `os`/`arch`, `error_class`/`error_message`
  split, `skill_version`.
- v0.1.0 — first release; per-skill explicit `bin/telemetry-log` calls,
  Supabase ingest edge function, local-first JSONL + background sync.
