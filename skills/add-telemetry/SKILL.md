---
name: add-telemetry
description: Adds skill-telemetry (per-invocation event logging with success/error/abandoned outcomes pushed to the author's own Supabase) to a Claude Code skill. Use this when a skill author wants to know how their skill is actually being used. Sets up everything end-to-end with at most 2 questions to the user.
---

# add-telemetry

You will add telemetry to a Claude Code skill so its author can see real
usage data in their own Supabase database. Follow this script exactly. Your
goal: complete the install with the **fewest possible interactions with
the user**. Combine the Supabase URL+key into ONE question, and otherwise
proceed automatically.

## Source files

This meta-skill lives inside the `skill-telemetry` repo. The template
files you'll copy live at `<repo-root>/bin/`, `<repo-root>/supabase/`,
etc.

**Finding the source directory** (this is the part most likely to break):

```bash
# You know where this SKILL.md is because you're reading it. Try in order:
# 1. If you can determine the absolute path to this SKILL.md, use:
#    SRC="$(cd "$(dirname "$THIS_SKILL_PATH")/../.." && pwd)"
# 2. Otherwise: clone fresh as a fallback.
SRC=""
for candidate in \
  "$HOME/code/skill-telemetry" \
  "$HOME/.claude/skills/skill-telemetry" \
  "$HOME/skill-telemetry"; do
  if [ -f "$candidate/bin/telemetry-log" ]; then
    SRC="$candidate"
    break
  fi
done

if [ -z "$SRC" ]; then
  rm -rf /tmp/skill-telemetry-src
  git clone --depth 1 -q https://github.com/serenakeyitan/skill-telemetry /tmp/skill-telemetry-src
  SRC=/tmp/skill-telemetry-src
fi

echo "Source directory: $SRC"
[ -f "$SRC/bin/telemetry-log" ] || { echo "FATAL: source files missing"; exit 1; }
```

---

## Step 0 — Mark install start time

```bash
# Use a deterministic name, not $$ — each Bash tool call is a fresh shell
# with a different PID, so $$-suffixed files won't be findable in later
# steps. Scope by TARGET path instead.
TARGET="${TARGET:-$PWD}"
SENTINEL="$TARGET/.add-telemetry-start"
date +%s > "$SENTINEL"
```

This lets Step 9 report how long the install took.

## Step 1 — Locate the target skill

The user invoked you from a working directory. Determine what skill they
want to instrument:

```bash
# Default to cwd. If the user said "add telemetry to /path/to/skill",
# use that instead.
TARGET="${TARGET:-$PWD}"

# Verify it's a skill directory
if [ ! -f "$TARGET/SKILL.md" ] && [ ! -f "$TARGET/.claude-plugin/plugin.json" ]; then
  echo "ERROR: $TARGET doesn't look like a Claude Code skill directory."
  echo "It needs SKILL.md or .claude-plugin/plugin.json."
  echo "cd into your skill repo and re-run /add-telemetry, or pass the path."
  exit 1
fi

# Detect skill name (no question if possible):
SKILL_NAME=""
# Try 1: SKILL.md frontmatter
if [ -f "$TARGET/SKILL.md" ]; then
  SKILL_NAME="$(awk '/^name:/ { print $2; exit }' "$TARGET/SKILL.md")"
fi
# Try 2: plugin.json
if [ -z "$SKILL_NAME" ] && [ -f "$TARGET/.claude-plugin/plugin.json" ]; then
  SKILL_NAME="$(grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' "$TARGET/.claude-plugin/plugin.json" | head -1 | cut -d'"' -f4)"
fi
# Try 3: basename
if [ -z "$SKILL_NAME" ]; then
  SKILL_NAME="$(basename "$TARGET" | tr '[:upper:] ' '[:lower:]-')"
fi

echo "Target: $TARGET"
echo "Skill name: $SKILL_NAME"
```

Only ask the user to confirm the name IF the detection used the basename
fallback AND the basename looks non-skill-like (has dots, starts with
underscore, etc.). Otherwise, proceed — do not ask for confirmation.

## Step 2 — Idempotency check

```bash
ALREADY_INSTALLED=0
[ -d "$TARGET/telemetry" ] && [ -f "$TARGET/telemetry/bin/telemetry-log" ] && ALREADY_INSTALLED=1
grep -q "telemetry-log" "$TARGET/SKILL.md" 2>/dev/null && SKILL_MD_WIRED=1 || SKILL_MD_WIRED=0
```

Decision logic — **do not ask the user**, apply rules:

- If neither: proceed normally.
- If files installed but SKILL.md not wired: proceed, skip Step 3 (copy),
  do Step 7 (append).
- If SKILL.md wired but files missing: re-copy in Step 3, skip Step 7.
- If both: report "already installed" and only re-run Step 4 (config) +
  Step 8 (smoke test). This is the "re-validate" mode.

## Step 3 — Copy template files (skip if already done in Step 2)

```bash
mkdir -p "$TARGET/telemetry"
cp -r  "$SRC/bin"                 "$TARGET/telemetry/"
cp -r  "$SRC/supabase"            "$TARGET/telemetry/"
cp     "$SRC/SKILL.md.snippet"    "$TARGET/telemetry/"
cp     "$SRC/PRIVACY.md"          "$TARGET/telemetry/"
chmod +x "$TARGET/telemetry/bin/"*

# Verify
[ -x "$TARGET/telemetry/bin/telemetry-log" ] || { echo "FATAL: copy failed"; exit 1; }
echo "Copied template to $TARGET/telemetry/"
```

## Step 4 — Get Supabase credentials (THE single question)

Output **exactly this** to the user, then wait for one response:

```
I need your Supabase Project URL and anon public key. Paste both — any
format works (one line, two lines, "url=... key=..."). I'll figure it out.

Don't have a project yet? Create one (30 seconds, free tier):
  https://supabase.com/dashboard → New project

To find the values: Settings → API → Project URL + anon public key.
```

When the user responds, parse with **permissive regex**. Accept any of:

- `https://([a-z0-9]+)\.supabase\.co` for URL
- A bare token starting with `sb_publishable_` or `sb_` for the new format
- A long token starting with `eyJ` for the legacy JWT format
- Order doesn't matter; whitespace and `=` separators are fine

If you find exactly one URL and one key → proceed. If ambiguous → ask
ONE focused clarification (which token is the anon key?). Never split
into multiple questions.

Write the config file:

```bash
URL="<extracted url>"
KEY="<extracted key>"
PROJECT_REF="$(echo "$URL" | sed -n 's|https://\([a-z0-9]*\)\.supabase\.co.*|\1|p')"

cat > "$TARGET/telemetry/supabase/config.sh" <<EOF
export SKILL_TELEMETRY_SUPABASE_URL="$URL"
export SKILL_TELEMETRY_ANON_KEY="$KEY"
EOF

echo "Wrote $TARGET/telemetry/supabase/config.sh (project: $PROJECT_REF)"
```

## Step 5 — Make the user run the SQL schema

This requires the user to open Supabase dashboard and click. You can't do
this for them, but you can make it one copy-paste.

Read the schema and embed it directly in your message:

```bash
SCHEMA_CONTENT="$(cat "$TARGET/telemetry/supabase/schema.sql")"
```

Output to user:

```
Open this URL → SQL Editor → New query, paste the SQL, click Run:

  https://supabase.com/dashboard/project/<PROJECT_REF>/sql/new

SQL to paste:
─────────────────────────────────────────────────
<SCHEMA_CONTENT>
─────────────────────────────────────────────────

When done, type 'ok' (or 'done' / 'next'). If it errored, paste the error.
```

Wait for their response. If they paste an error → diagnose, fix the SQL
if possible, ask them to re-run. If they say ok → proceed.

**Don't validate the SQL ran successfully here** — Step 8's smoke test
will tell us definitively. Just trust the user for now.

## Step 6 — Make the user deploy the edge function

Check supabase CLI first:

```bash
if ! command -v supabase >/dev/null 2>&1; then
  echo "supabase CLI not installed. Run:"
  echo "  brew install supabase/tap/supabase     # macOS"
  echo "  # or see: https://supabase.com/docs/guides/cli"
  echo "then retry."
  exit 1
fi
```

If installed, output to user:

```
Now run these 3 commands from $TARGET/telemetry/:

  cd $TARGET/telemetry
  supabase login                                              # one-time, opens browser
  supabase link --project-ref <PROJECT_REF>
  supabase functions deploy skill-telemetry-ingest --no-verify-jwt

Type 'ok' when the last command says "Deployed function skill-telemetry-ingest".
```

`<PROJECT_REF>` was extracted in Step 4.

Wait for confirmation. If they paste an error → diagnose. Common ones:
- "no organization" → user needs to create org in Supabase dashboard first
- "function already exists" → harmless, proceed
- "permission denied" → check `supabase login` actually ran

## Step 7 — Append telemetry block to user's SKILL.md (with diff + auto-yes)

Build the customized snippet by reading the template and substituting:

```bash
TELEMETRY_BIN="$TARGET/telemetry/bin/telemetry-log"

CUSTOMIZED=$(sed \
  -e "s|{{SKILL_NAME}}|$SKILL_NAME|g" \
  -e "s|{{TELEMETRY_BIN}}|$TELEMETRY_BIN|g" \
  "$TARGET/telemetry/SKILL.md.snippet")
```

Show the user a preview (last 10 lines of customized snippet) so they
know what's being added:

```
About to append this to $TARGET/SKILL.md:

  <last 10 lines of CUSTOMIZED>

(Full content is at $TARGET/telemetry/SKILL.md.snippet, customized.)
```

**Default to yes and proceed** — do not block waiting for "yes". The
agent execution model can't reliably pause. The action is reversible
(`git diff` or `tail -100 SKILL.md`), so safe to default-yes.

```bash
echo "" >> "$TARGET/SKILL.md"
echo "$CUSTOMIZED" >> "$TARGET/SKILL.md"
echo "Appended telemetry block to $TARGET/SKILL.md"
```

## Step 8 — Smoke test the full pipeline

This is the source of truth. Don't claim done until this passes.

**Run this entire block as ONE Bash call.** The variables `$HTTP_CODE` and
`$RESPONSE_BODY` are set here AND consumed in this same block — they
won't survive a fresh shell. If you must split, write them to files first
(see the persistence note at the end of this step).

```bash
. "$TARGET/telemetry/supabase/config.sh"

TEST_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
TEST_SESSION="add-telemetry-install-$(date +%s)"

RESP_FILE="$TARGET/.add-telemetry-smoke-resp"
HTTP_CODE=$(curl -s -w '%{http_code}' --max-time 15 \
  -X POST "$SKILL_TELEMETRY_SUPABASE_URL/functions/v1/skill-telemetry-ingest" \
  -H "Content-Type: application/json" \
  -H "apikey: $SKILL_TELEMETRY_ANON_KEY" \
  -H "Authorization: Bearer $SKILL_TELEMETRY_ANON_KEY" \
  -o "$RESP_FILE" \
  -d "[{\"skill\":\"$SKILL_NAME\",\"outcome\":\"success\",\"ts\":\"$TEST_TS\",\"session_id\":\"$TEST_SESSION\"}]")

RESPONSE_BODY="$(cat "$RESP_FILE" 2>/dev/null)"

# Persist for downstream steps (failure path or Step 9)
echo "$HTTP_CODE" > "$TARGET/.add-telemetry-last-http"
cp "$RESP_FILE" "$TARGET/.add-telemetry-last-body" 2>/dev/null || true
rm -f "$RESP_FILE"

echo "HTTP $HTTP_CODE"
echo "Response: $RESPONSE_BODY"
```

**If you must read these in a later Bash call:**

```bash
HTTP_CODE="$(cat "$TARGET/.add-telemetry-last-http" 2>/dev/null)"
RESPONSE_BODY="$(cat "$TARGET/.add-telemetry-last-body" 2>/dev/null)"
```

**Interpret the result** and tell the user clearly:

| HTTP | Meaning | What to tell user |
|---|---|---|
| `200`/`201` with `inserted` in body | ✅ Full pipeline works | Proceed to Step 9 success report |
| `200` but body says "no valid rows" | ⚠️ Edge function received it but rejected the row | Probably a schema mismatch. Re-check Step 5 — did they actually run the SQL? |
| `401`/`403` | Auth failed | The anon key in `config.sh` is wrong. Re-do Step 4 |
| `404` | Edge function missing | They didn't deploy. Re-do Step 6 |
| `500` | Server error | Most likely: schema not run (Step 5) or wrong service role configuration. Check Supabase edge function logs |
| `000` / timeout | Network/DNS | Wrong URL. Re-check Step 4. May also be transient — retry once |

If smoke test fails: **tell the user the install is paused, NOT done**.
The files are in place at `$TARGET/telemetry/`. They can fix the upstream
issue and re-run `/add-telemetry` to retry just Step 8 (the meta-skill
will detect the existing install and only re-validate).

**Compute elapsed time + clean up sentinel BEFORE exiting on failure:**

```bash
SENTINEL="$TARGET/.add-telemetry-start"
START=$(cat "$SENTINEL" 2>/dev/null || echo "$(date +%s)")
END=$(date +%s)
ELAPSED=$(( END - START ))

# Capture HTTP code/body even if we're in a fresh shell
HTTP_CODE="${HTTP_CODE:-$(cat "$TARGET/.add-telemetry-last-http" 2>/dev/null)}"
RESPONSE_BODY="${RESPONSE_BODY:-$(cat "$TARGET/.add-telemetry-last-body" 2>/dev/null)}"

# Write a structured failure log for diagnostics
cat >> "$TARGET/telemetry/.install-failure-log" <<EOF
$(date -u +%Y-%m-%dT%H:%M:%SZ) step=8 http=${HTTP_CODE:-unknown} body=${RESPONSE_BODY:-empty} elapsed=$ELAPSED
EOF

# Clean up all install-time scratch files
rm -f "$SENTINEL" "$TARGET/.add-telemetry-last-http" "$TARGET/.add-telemetry-last-body"

echo "Install paused after ${ELAPSED}s. Re-run /add-telemetry after fixing the upstream issue."
echo "Failure log: $TARGET/telemetry/.install-failure-log"
```

The sentinel cleanup MUST happen in both the success path (Step 9) and
this failure path. Don't leak it.

## Step 9 — Final report

Only reach this if Step 8 returned 200.

Compute install duration:

```bash
SENTINEL="$TARGET/.add-telemetry-start"
START=$(cat "$SENTINEL" 2>/dev/null || echo "$(date +%s)")
END=$(date +%s)
ELAPSED=$(( END - START ))

# Clean up all install-time scratch files (mirror the failure path)
rm -f "$SENTINEL" "$TARGET/.add-telemetry-last-http" "$TARGET/.add-telemetry-last-body"
```

Output to user:

```
✅ Telemetry installed for {{SKILL_NAME}} in $ELAPSED seconds.

What just happened:
  - Files: $TARGET/telemetry/  (bin, supabase config, snippet)
  - SKILL.md: telemetry block appended at end
  - Smoke test: HTTP 200, one row in skill_events
  - Test row session_id: $TEST_SESSION (delete if you want to clean up)

Where to see your data:
  https://supabase.com/dashboard/project/$PROJECT_REF/editor
  Table: skill_events
  Useful views: skill_usage_summary, skill_failure_modes, skill_daily_usage

How users disable telemetry:
  export SKILL_TELEMETRY=off

Privacy text for your README:
  $TARGET/telemetry/PRIVACY.md  (paste into your README's privacy section)

Next time you use your skill normally, a real event will land in
skill_events. Open the dashboard in a minute and see.
```

Then record your own telemetry event (if add-telemetry has been
instrumented on itself — see Step 10).

## Step 10 — Self-telemetry (only if you've been instrumented)

This is a no-op until add-telemetry has been instrumented on itself.
Once /add-telemetry runs on its own directory, the snippet appended to
THIS SKILL.md will substitute the absolute path here.

For now, this is just a placeholder section. After self-instrumentation,
a real "Telemetry (do not skip)" block will live below this comment.

## What you should NEVER do

- **Never ask a question you could answer by reading a file.** If you
  catch yourself about to ask "what's the skill name", check SKILL.md
  frontmatter first.
- **Never split one piece of information into multiple questions.** URL
  and key go together; ask for both at once.
- **Never overwrite SKILL.md without first showing a preview** of what
  you're appending.
- **Never claim done without Step 8 passing.** A green Step 8 is the
  only honest success signal.
- **Never block forever on "yes/no" prompts.** Default to yes when the
  action is reversible (file append, config write). Default to stop
  only on destructive actions (none in this skill).

## On failure

Whatever step fails:

1. Log the error context to `$TARGET/telemetry/.install-failure-log`
   with timestamp + step number + observed output.
2. Tell the user **exactly** which step failed and what to fix.
3. Tell them re-running `/add-telemetry` is safe (idempotent) — Step 2
   detects partial installs and resumes from the right place.
4. Do NOT leave inconsistent state: if Step 7 (SKILL.md append) is the
   one that fails, the files in `telemetry/` are inert (no SKILL.md
   references them), so the partial install does nothing — safe to
   leave or `rm -rf telemetry/`.
