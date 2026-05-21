---
name: add-telemetry
description: Adds skill-telemetry (per-invocation event logging with success/error/abandoned outcomes pushed to the author's own Supabase) to a Claude Code skill. Use this when a skill author wants to know how their skill is actually being used. Path A is fully automated — you give us a Supabase login, we create the project, deploy the schema and edge function, install telemetry into your skill, and run a smoke test. Total user interactions: ~3 (one browser auth + two acknowledgments).
---

# add-telemetry

You will add telemetry to a Claude Code skill so its author can see real
usage data in their own Supabase database.

There are **two paths**. Pick the one matching the user's situation, then
follow it linearly. Do not mix.

- **Path A — Fully automated** (recommended). The user has (or will get)
  Supabase auth on this machine. We do everything via Supabase Management
  API + CLI: create project, deploy schema, deploy edge function, install
  telemetry, smoke test. **3 user interactions total**: one browser
  login + accepting two safety confirmations along the way.
- **Path B — Manual fallback**. The user already has a Supabase project
  and just wants to hand us URL+key. We skip CLI entirely, only ask for
  the two values, write config, install telemetry, smoke test.

If the user didn't say, ask once: "Do you want me to create a new
Supabase project for you (Path A), or use an existing one (Path B)?"
Default to Path A — it's faster and matches the design intent.

---

## Source files

This meta-skill lives in the `skill-telemetry` repo. Template files
(bin/, supabase/, SKILL.md.snippet, PRIVACY.md) are at the repo root.

```bash
# Discover the source dir. Try known paths first, fall back to fresh clone.
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

## Step 0 — Mark install start time + self-telemetry preamble

```bash
TARGET="${TARGET:-$PWD}"
SENTINEL="$TARGET/.add-telemetry-start"
date +%s > "$SENTINEL"

# Self-telemetry: record this add-telemetry run if instrumented.
# This block fires regardless of what skill we're installing into —
# it tracks usage of THIS meta-skill (add-telemetry) itself.
META_SKILL_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
[ -z "$META_SKILL_DIR" ] && META_SKILL_DIR="$HOME/code/skill-telemetry/skills/add-telemetry"
META_TEL_BIN="$META_SKILL_DIR/telemetry/bin/telemetry-log"
META_TEL_HOME="$HOME/.add-telemetry"
META_TEL_SESSION_ID="${CLAUDE_SESSION_ID:-shell-$$-$(date +%s)}"
if [ -x "$META_TEL_BIN" ]; then
  mkdir -p "$META_TEL_HOME/sentinels"
  date +%s > "$META_TEL_HOME/sentinels/$META_TEL_SESSION_ID"
  find "$META_TEL_HOME/sentinels" -type f -mtime +1 -delete 2>/dev/null || true
fi
```

## Step 1 — Locate target skill + detect skill name

```bash
TARGET="${TARGET:-$PWD}"

if [ ! -f "$TARGET/SKILL.md" ] && [ ! -f "$TARGET/.claude-plugin/plugin.json" ]; then
  echo "ERROR: $TARGET doesn't look like a Claude Code skill directory."
  echo "It needs SKILL.md or .claude-plugin/plugin.json."
  echo "cd into your skill repo and re-run /add-telemetry."
  exit 1
fi

SKILL_NAME=""
[ -f "$TARGET/SKILL.md" ] && \
  SKILL_NAME="$(awk '/^name:/ { print $2; exit }' "$TARGET/SKILL.md")"
[ -z "$SKILL_NAME" ] && [ -f "$TARGET/.claude-plugin/plugin.json" ] && \
  SKILL_NAME="$(grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' "$TARGET/.claude-plugin/plugin.json" | head -1 | cut -d'"' -f4)"
[ -z "$SKILL_NAME" ] && \
  SKILL_NAME="$(basename "$TARGET" | tr '[:upper:] ' '[:lower:]-')"

echo "Target: $TARGET"
echo "Skill name: $SKILL_NAME"
```

## Step 2 — Idempotency + author-suite-pool detection

```bash
ALREADY_INSTALLED=0
[ -d "$TARGET/telemetry" ] && [ -f "$TARGET/telemetry/bin/telemetry-log" ] && ALREADY_INSTALLED=1
grep -q "telemetry-log" "$TARGET/SKILL.md" 2>/dev/null && SKILL_MD_WIRED=1 || SKILL_MD_WIRED=0
echo "ALREADY_INSTALLED=$ALREADY_INSTALLED, SKILL_MD_WIRED=$SKILL_MD_WIRED"

# Author-suite-pool detection (gstack-style):
# Look for an existing telemetry config from any other skill the user
# already instrumented. If found, reuse it — author's data goes to ONE
# pool, not one-pool-per-skill.
EXISTING_AUTHOR_CONFIG=""
for cand in $HOME/.claude/skills/*/telemetry/supabase/config.sh; do
  if [ -f "$cand" ] && [ "$cand" != "$TARGET/telemetry/supabase/config.sh" ]; then
    EXISTING_AUTHOR_CONFIG="$cand"
    break
  fi
done

if [ -n "$EXISTING_AUTHOR_CONFIG" ]; then
  echo "FOUND_AUTHOR_POOL: $EXISTING_AUTHOR_CONFIG"
  # Source it to peek at the URL
  AUTHOR_URL=$(grep -oE 'https://[a-z0-9]+\.supabase\.co' "$EXISTING_AUTHOR_CONFIG" | head -1)
  echo "AUTHOR_POOL_URL: $AUTHOR_URL"
fi
```

**Decision tree** (the meta-skill applies silently):

- Fresh install + no author pool → Path A creates new Supabase project
- Fresh install + author pool exists → **default: reuse the pool**
  (ask user only if you want to override; the gstack model is one pool
  per author, not one per skill)
- Re-install → re-validate config, skip Step 7 (copy already done)

Decisions (apply silently):
- Both 0 → fresh install, proceed normally
- Files yes, SKILL.md no → skip Step 7 (copy), continue at Step 11 (append SKILL.md)
- SKILL.md yes, files no → re-copy in Step 7, skip Step 11
- Both yes → "re-validate" mode: only re-run Step 12 (smoke test)

---

# Path A — Fully automated install

Use this when the user wants us to create the Supabase project. Skip
to Path B if they want to use an existing project.

## Step 3 — Detect + install Supabase CLI

```bash
if command -v supabase >/dev/null 2>&1; then
  echo "✅ supabase CLI present: $(supabase --version 2>&1 | head -1)"
else
  echo "Installing supabase CLI..."
  case "$(uname -s)" in
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        brew tap supabase/tap 2>&1 | tail -3
        brew install supabase/tap/supabase 2>&1 | tail -5
      else
        echo "FATAL: Homebrew required on macOS. Install from https://brew.sh"
        exit 1
      fi
      ;;
    Linux)
      # Try official install script
      curl -fsSL https://github.com/supabase/cli/releases/latest/download/supabase_linux_amd64.tar.gz \
        -o /tmp/supabase-cli.tar.gz
      tar -xzf /tmp/supabase-cli.tar.gz -C /tmp
      sudo mv /tmp/supabase /usr/local/bin/
      rm -f /tmp/supabase-cli.tar.gz
      ;;
    *)
      echo "FATAL: Unsupported platform. Install supabase CLI manually:"
      echo "  https://supabase.com/docs/guides/cli/getting-started"
      exit 1
      ;;
  esac

  if ! command -v supabase >/dev/null 2>&1; then
    echo "FATAL: supabase CLI install failed."
    exit 1
  fi
  echo "✅ Installed: $(supabase --version 2>&1 | head -1)"
fi
```

## Step 4 — Read Supabase access token

The supabase CLI stores its access token differently per platform.
**This was a friction point during dogfood — don't trust the docs that
say `~/.supabase/access-token`.**

```bash
ACCESS_TOKEN=""

case "$(uname -s)" in
  Darwin)
    # On macOS the token is stored in keychain, base64-encoded with a
    # "go-keyring-base64:" prefix.
    RAW=$(security find-generic-password -s "Supabase CLI" -w 2>/dev/null || true)
    if [ -n "$RAW" ]; then
      B64=${RAW#go-keyring-base64:}
      ACCESS_TOKEN=$(echo "$B64" | base64 -D 2>/dev/null || echo "$B64" | base64 --decode 2>/dev/null || echo "")
    fi
    ;;
  Linux)
    # Check known locations
    for tokfile in \
      "$HOME/.supabase/access-token" \
      "$XDG_CONFIG_HOME/supabase/access-token" \
      "$HOME/.config/supabase/access-token"; do
      if [ -f "$tokfile" ]; then
        ACCESS_TOKEN="$(cat "$tokfile")"
        break
      fi
    done
    ;;
esac

if [ -z "$ACCESS_TOKEN" ]; then
  echo "Not logged in to Supabase. Running 'supabase login' (opens browser)..."
  supabase login
  # Re-read token after login
  case "$(uname -s)" in
    Darwin)
      RAW=$(security find-generic-password -s "Supabase CLI" -w 2>/dev/null || true)
      B64=${RAW#go-keyring-base64:}
      ACCESS_TOKEN=$(echo "$B64" | base64 -D 2>/dev/null || echo "$B64" | base64 --decode 2>/dev/null || echo "")
      ;;
    Linux)
      for tokfile in \
        "$HOME/.supabase/access-token" \
        "$XDG_CONFIG_HOME/supabase/access-token" \
        "$HOME/.config/supabase/access-token"; do
        [ -f "$tokfile" ] && ACCESS_TOKEN="$(cat "$tokfile")" && break
      done
      ;;
  esac
fi

[ -z "$ACCESS_TOKEN" ] && { echo "FATAL: could not obtain access token after login"; exit 1; }
echo "✅ Access token obtained (length: ${#ACCESS_TOKEN})"
```

## Step 5 — Pick organization

```bash
ORGS_JSON=$(curl -s -H "Authorization: Bearer $ACCESS_TOKEN" "https://api.supabase.com/v1/organizations")
ORG_COUNT=$(echo "$ORGS_JSON" | jq 'length')
echo "Found $ORG_COUNT organization(s):"
echo "$ORGS_JSON" | jq -r '.[] | "  - \(.id)  (\(.name))"'
```

If `ORG_COUNT` is 1 → auto-select that one. If multiple → ask the user
which one (use `AskUserQuestion` listing org names as options). **Do not
ask twice.**

```bash
# Set ORG_ID based on selection
ORG_ID="<selected-id>"
```

## Step 6 — Create the project (or reuse author's existing pool)

**Author-suite-pool short-circuit**: if Step 2 found an existing author
pool, **copy the config** instead of creating a new project. Author
sees all their skills' data in one Supabase, exactly like gstack.

```bash
if [ -n "$EXISTING_AUTHOR_CONFIG" ]; then
  mkdir -p "$TARGET/telemetry/supabase"
  cp "$EXISTING_AUTHOR_CONFIG" "$TARGET/telemetry/supabase/config.sh"
  # Extract project ref from URL for downstream steps
  PROJECT_URL=$(grep -oE 'https://[a-z0-9]+\.supabase\.co' "$TARGET/telemetry/supabase/config.sh" | head -1)
  PROJECT_REF=$(echo "$PROJECT_URL" | sed -n 's|https://\([a-z0-9]*\)\.supabase\.co.*|\1|p')
  ANON_KEY=$(grep -oE 'sb_publishable_[A-Za-z0-9_]+|eyJ[A-Za-z0-9._-]+' "$TARGET/telemetry/supabase/config.sh" | head -1)
  echo "✅ Reusing author pool: $PROJECT_URL"
  echo "   (skipping project create, schema deploy, edge function deploy — already done)"
  # Skip directly to Step 8 (copy template files)
else
  # Original Step 6: create new project
PROJECT_NAME="${SKILL_NAME}-telemetry"
DB_PASS=$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-24)

# Save password for `supabase link` later. NOT committed.
mkdir -p "$TARGET/telemetry"
echo "$DB_PASS" > "$TARGET/telemetry/.db-password"
chmod 600 "$TARGET/telemetry/.db-password"

# Create. DON'T specify --size — that flag only works on paid plans
# (dogfood confirmed: free tier returns "Instance size cannot be
# specified for free plan organizations").
echo "Creating project '$PROJECT_NAME' in org $ORG_ID..."
supabase projects create "$PROJECT_NAME" \
  --org-id "$ORG_ID" \
  --db-password "$DB_PASS" \
  --region us-east-1 2>&1 | tee /tmp/.add-tel-create-out

PROJECT_REF=$(grep -oE 'project/[a-z]{20}' /tmp/.add-tel-create-out | head -1 | cut -d/ -f2)
rm -f /tmp/.add-tel-create-out

if [ -z "$PROJECT_REF" ]; then
  echo "FATAL: couldn't parse project ref from create output"
  exit 1
fi
echo "✅ Project created: $PROJECT_REF"
```

If the user's free tier is full (2-project cap), tell them:
"Your Supabase free tier has 2 projects already. Either delete one at
https://supabase.com/dashboard or upgrade to Pro." Then exit. Do not
auto-delete anything.

fi   # end "no existing author pool" branch

## Step 7 — Wait for project to be ready + fetch API keys

```bash
echo "Waiting for project to provision..."
for i in 1 2 3 4 5 6 7 8; do
  KEYS_JSON=$(supabase projects api-keys --project-ref "$PROJECT_REF" --output json 2>/dev/null || echo "[]")
  if echo "$KEYS_JSON" | jq -e '.[0].api_key' >/dev/null 2>&1; then
    echo "✅ Project ready after $((i*15))s"
    break
  fi
  sleep 15
done

# Extract the publishable (anon) key — prefer the new sb_publishable_ format
ANON_KEY=$(echo "$KEYS_JSON" | jq -r '.[] | select(.name == "default" and (.api_key | startswith("sb_publishable"))) | .api_key' | head -1)
# Fallback to JWT-format anon key if no sb_publishable_
[ -z "$ANON_KEY" ] && ANON_KEY=$(echo "$KEYS_JSON" | jq -r '.[] | select(.name == "anon") | .api_key' | head -1)

if [ -z "$ANON_KEY" ]; then
  echo "FATAL: couldn't extract anon key"
  echo "$KEYS_JSON" | jq -r '.[] | "  \(.name): \(.api_key)"'
  exit 1
fi

PROJECT_URL="https://${PROJECT_REF}.supabase.co"
echo "✅ URL: $PROJECT_URL"
echo "✅ Anon key: ${ANON_KEY:0:20}..."
```

## Step 8 — Copy template files

```bash
mkdir -p "$TARGET/telemetry"
cp -r  "$SRC/bin"                 "$TARGET/telemetry/"
cp -r  "$SRC/supabase"            "$TARGET/telemetry/"
cp     "$SRC/SKILL.md.snippet"    "$TARGET/telemetry/"
cp     "$SRC/PRIVACY.md"          "$TARGET/telemetry/"
chmod +x "$TARGET/telemetry/bin/"*

[ -x "$TARGET/telemetry/bin/telemetry-log" ] || { echo "FATAL: copy failed"; exit 1; }
echo "✅ Copied template files to $TARGET/telemetry/"
```

## Step 9 — Write config.sh + run schema via Management API

**Don't use `supabase db push` or SQL Editor copy-paste.** Use the
Management API `database/query` endpoint — it's one POST and does the
whole thing.

```bash
cat > "$TARGET/telemetry/supabase/config.sh" <<EOF
export SKILL_TELEMETRY_SUPABASE_URL="$PROJECT_URL"
export SKILL_TELEMETRY_ANON_KEY="$ANON_KEY"
EOF
echo "✅ Wrote config.sh"

SCHEMA=$(cat "$TARGET/telemetry/supabase/schema.sql")
QUERY_JSON=$(jq -n --arg q "$SCHEMA" '{query: $q}')

HTTP=$(curl -s -w '%{http_code}' \
  -X POST "https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -o /tmp/.add-tel-schema-resp \
  -d "$QUERY_JSON")

if [ "$HTTP" = "201" ] || [ "$HTTP" = "200" ]; then
  echo "✅ Schema deployed (HTTP $HTTP)"
else
  echo "FATAL: schema deploy failed (HTTP $HTTP)"
  cat /tmp/.add-tel-schema-resp
  exit 1
fi
rm -f /tmp/.add-tel-schema-resp
```

## Step 10 — Deploy edge function via Management API

**Don't use `supabase functions deploy`.** Dogfood confirmed it hangs on
"Bundling Function" indefinitely. Use the Management API multipart
endpoint — much more reliable.

```bash
FN_PATH="$TARGET/telemetry/supabase/functions/skill-telemetry-ingest/index.ts"

HTTP=$(curl -s -w '%{http_code}' \
  -X POST "https://api.supabase.com/v1/projects/${PROJECT_REF}/functions/deploy?slug=skill-telemetry-ingest" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -F 'metadata={"name":"skill-telemetry-ingest","verify_jwt":false,"entrypoint_path":"index.ts"};type=application/json' \
  -F "file=@${FN_PATH};type=application/typescript" \
  -o /tmp/.add-tel-fn-resp)

if [ "$HTTP" = "201" ] || [ "$HTTP" = "200" ]; then
  echo "✅ Edge function deployed (HTTP $HTTP)"
else
  echo "FATAL: function deploy failed (HTTP $HTTP)"
  cat /tmp/.add-tel-fn-resp
  exit 1
fi
rm -f /tmp/.add-tel-fn-resp
```

## Step 11 — Build customized snippet + append to user's SKILL.md

The snippet has placeholders `{{SKILL_NAME}}` and `{{TELEMETRY_BIN}}`.
Substitute them but **also strip the leading HTML comment block** —
that comment describes the placeholders themselves and gets corrupted
by the sed substitution (dogfood found this).

```bash
TELEMETRY_BIN="$TARGET/telemetry/bin/telemetry-log"

# Strip leading HTML comment then substitute placeholders
CUSTOMIZED=$(sed -e '/^<!--/,/^-->/d' "$TARGET/telemetry/SKILL.md.snippet" | \
  sed -e "s|{{SKILL_NAME}}|$SKILL_NAME|g" \
      -e "s|{{TELEMETRY_BIN}}|$TELEMETRY_BIN|g")

# Preview the last 5 lines of what we're about to append
echo "Appending telemetry block (last 5 lines preview):"
echo "$CUSTOMIZED" | tail -5
echo ""

# Default-yes append (action is reversible — `git diff` shows what changed)
echo "" >> "$TARGET/SKILL.md"
echo "$CUSTOMIZED" >> "$TARGET/SKILL.md"
echo "✅ Appended telemetry block to $TARGET/SKILL.md"
```

## Step 12 — Smoke test the full pipeline

**Single Bash call. HTTP_CODE / RESPONSE_BODY are also persisted to
files so the failure-recovery block below can read them.**

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
echo "$HTTP_CODE" > "$TARGET/.add-telemetry-last-http"
cp "$RESP_FILE" "$TARGET/.add-telemetry-last-body" 2>/dev/null || true
rm -f "$RESP_FILE"

echo "HTTP $HTTP_CODE"
echo "Response: $RESPONSE_BODY"
```

| HTTP | Meaning | What to tell user |
|---|---|---|
| `200`/`201` with "inserted" | ✅ Pipeline works | Proceed to Step 13 |
| `200` with "no valid rows" | Schema mismatch | Re-check Step 9 |
| `401`/`403` | Auth failed | Anon key wrong, re-run Step 7 |
| `404` | Function missing | Re-run Step 10 |
| `500` | Server error | Check Supabase edge function logs |
| `000` / timeout | Network/DNS | Wrong URL, transient — retry once |

**On Step 8 failure path** (move sentinel cleanup here too):

```bash
SENTINEL="$TARGET/.add-telemetry-start"
START=$(cat "$SENTINEL" 2>/dev/null || echo "$(date +%s)")
END=$(date +%s)
ELAPSED=$(( END - START ))
HTTP_CODE="${HTTP_CODE:-$(cat "$TARGET/.add-telemetry-last-http" 2>/dev/null)}"
RESPONSE_BODY="${RESPONSE_BODY:-$(cat "$TARGET/.add-telemetry-last-body" 2>/dev/null)}"

cat >> "$TARGET/telemetry/.install-failure-log" <<EOF
$(date -u +%Y-%m-%dT%H:%M:%SZ) step=12 http=${HTTP_CODE:-unknown} body=${RESPONSE_BODY:-empty} elapsed=$ELAPSED
EOF

rm -f "$SENTINEL" "$TARGET/.add-telemetry-last-http" "$TARGET/.add-telemetry-last-body"
echo "Install paused after ${ELAPSED}s. Re-run /add-telemetry after fixing the upstream issue."
echo "Failure log: $TARGET/telemetry/.install-failure-log"
```

## Step 13 — Final report (Path A)

```bash
SENTINEL="$TARGET/.add-telemetry-start"
START=$(cat "$SENTINEL" 2>/dev/null || echo "$(date +%s)")
END=$(date +%s)
ELAPSED=$(( END - START ))
rm -f "$SENTINEL" "$TARGET/.add-telemetry-last-http" "$TARGET/.add-telemetry-last-body" \
      "$TARGET/telemetry/.db-password"
```

Tell the user:

```
✅ Telemetry installed for $SKILL_NAME in $ELAPSED seconds.

Project: $PROJECT_URL
Files: $TARGET/telemetry/
SKILL.md: telemetry block appended at end
Smoke test: HTTP $HTTP_CODE — one row in skill_events

See your data:
  https://supabase.com/dashboard/project/$PROJECT_REF/editor
  Useful views: skill_usage_summary, skill_failure_modes, skill_daily_usage

Users opt out via: export SKILL_TELEMETRY=off

Privacy text for your README:
  $TARGET/telemetry/PRIVACY.md  (paste into your README's privacy section)
```

## Step 14 — Self-telemetry (fire add-telemetry's own event)

**This block records that add-telemetry itself ran.** Lets the
maintainer of add-telemetry see how many people install telemetry,
which skills they install it on, and what fails. Recursive
dogfooding — meta-skill instruments itself.

```bash
# Compute duration from the meta-sentinel written in Step 0
META_TEL_BIN_PATH="$META_TEL_BIN"  # set in Step 0
META_TEL_HOME_PATH="$META_TEL_HOME"
META_END=$(date +%s)
META_START=$(cat "$META_TEL_HOME_PATH/sentinels/$META_TEL_SESSION_ID" 2>/dev/null || echo "$META_END")
META_DURATION=$(( META_END - META_START ))
rm -f "$META_TEL_HOME_PATH/sentinels/$META_TEL_SESSION_ID"

# Fire event. --step records which target skill we instrumented.
# --error-class will be empty on success.
if [ -x "$META_TEL_BIN_PATH" ]; then
  "$META_TEL_BIN_PATH" \
    --skill add-telemetry \
    --outcome success \
    --duration "$META_DURATION" \
    --step "installed_to:$SKILL_NAME" \
    --skill-version "$(cat "$META_SKILL_DIR/VERSION" 2>/dev/null || echo unknown)" \
    --session-id "$META_TEL_SESSION_ID"
fi
```

If install failed (Step 12 smoke test fail), do the equivalent with
`--outcome error --error-class <code> --error-message <body>`. Do
not silently fail to record errors — the maintainer needs to know
which installs broke.

---

# Path B — Manual install (existing Supabase project)

Use this when the user already has a Supabase project + keys and just
wants to wire it up. Skip Path A entirely; this path doesn't need the
Supabase CLI or any API calls beyond the smoke test.

## Step 3-B — Get Supabase credentials (one question)

Tell the user:

```
I need your Supabase Project URL and anon public key. Paste both —
any format works (one line, two lines, "url=... key=..."). I'll
figure it out.

To find them: dashboard → Settings → API → Project URL + anon public.
```

Parse with permissive regex (see Path A Step 4 for patterns). Resolve
into:

```bash
URL="<extracted url>"
ANON_KEY="<extracted key>"
PROJECT_REF="$(echo "$URL" | sed -n 's|https://\([a-z0-9]*\)\.supabase\.co.*|\1|p')"
```

Then write config and copy template:

```bash
mkdir -p "$TARGET/telemetry"
cp -r  "$SRC/bin"              "$TARGET/telemetry/"
cp -r  "$SRC/supabase"         "$TARGET/telemetry/"
cp     "$SRC/SKILL.md.snippet" "$TARGET/telemetry/"
cp     "$SRC/PRIVACY.md"       "$TARGET/telemetry/"
chmod +x "$TARGET/telemetry/bin/"*

cat > "$TARGET/telemetry/supabase/config.sh" <<EOF
export SKILL_TELEMETRY_SUPABASE_URL="$URL"
export SKILL_TELEMETRY_ANON_KEY="$ANON_KEY"
EOF
```

## Step 4-B — User runs schema + deploys edge function manually

Output to user:

```
Two manual steps in your dashboard:

1. SQL Editor → New query, paste this:
$(cat "$TARGET/telemetry/supabase/schema.sql")

2. After SQL succeeds, deploy the edge function:
   cd $TARGET/telemetry
   supabase login                          # if not done
   supabase link --project-ref $PROJECT_REF
   supabase functions deploy skill-telemetry-ingest --no-verify-jwt

Type 'ok' when both are done.
```

Wait for ack.

## Step 5-B onwards

Continue at Step 11 (append SKILL.md) and Step 12 (smoke test) above.
Both paths converge here.

---

## What you should NEVER do

- **Never ask a question you could answer by reading a file.** Skill
  name from frontmatter; org from `orgs list`; CLI presence from
  `command -v`.
- **Never split one piece of info into multiple questions.** URL+key
  together. Path A or B together.
- **Never overwrite SKILL.md without showing a preview** of what's
  being appended.
- **Never claim done without Step 12 passing.** Green smoke test is
  the only honest success signal.
- **Never block forever on "yes/no" prompts.** Default to yes when
  reversible (file append, config write). Default to stop only on
  destructive actions (none here).
- **Never use `supabase functions deploy` CLI.** It hangs at "Bundling
  Function" indefinitely. Use Management API multipart instead.
- **Never use `--size` flag on `supabase projects create`.** Free tier
  rejects it.

## On failure

1. Log error context to `$TARGET/telemetry/.install-failure-log` with
   timestamp + step number + observed output.
2. Tell the user **exactly** which step failed and what to fix.
3. Tell them re-running `/add-telemetry` is safe — Step 2 detects
   partial installs and resumes from the right place.
4. Don't leave inconsistent state. If Step 11 (SKILL.md append) fails,
   the files in `telemetry/` are inert (no SKILL.md references them),
   so the partial install does nothing — safe to leave or
   `rm -rf telemetry/`.
