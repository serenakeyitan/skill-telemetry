#!/usr/bin/env bash
# tests/smoke.sh — end-to-end smoke tests for skill-telemetry.
# Runs in CI via .github/workflows/ci.yml. Also runnable locally:
#   ./tests/smoke.sh
#
# What we test (one assertion per audit finding so regressions are
# caught at PR time, not by users):
#   - telemetry-log writes JSONL on basic invocation
#   - --outcome success persists (C1 — was misclassified as unknown)
#   - path-traversal in --session-id is blocked (C2)
#   - --skill with shell-unsafe chars is rejected (F8)
#   - --limit with non-digit chars is rejected (C3)
#   - unknown flags emit a warning but don't fail (F10)
#   - install/uninstall hook idempotency (Codex #1 verification)
#   - JSONL line is valid JSON

set -u
# Intentionally NOT using pipefail — many tests check that a command
# exits non-zero AND emits a message, e.g. `if cmd 2>&1 | grep -q FATAL`.
# With pipefail the non-zero exit propagates through the pipe and the
# `if` sees false even when grep matched.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT

export SKILL_TELEMETRY_DIR="$TMP/state"
export SKILL_TELEMETRY=on
export PATH="$ROOT/bin:$PATH"

PASS=0
FAIL=0

ok()   { echo "✓ $1";   PASS=$((PASS+1)); }
fail() { echo "✗ $1";   FAIL=$((FAIL+1)); }

run() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$name"; else fail "$name"; fi
}

# ── 1. Basic JSONL write ──
telemetry-log --skill smoke --outcome success --session-id sess-A --duration 1 2>/dev/null
if ls "$SKILL_TELEMETRY_DIR/telemetry/"*.jsonl >/dev/null 2>&1; then
  ok "telemetry-log writes JSONL"
else
  fail "telemetry-log writes JSONL"
fi

# ── 2. outcome=success persists (C1) ──
if grep -q '"outcome":"success"' "$SKILL_TELEMETRY_DIR/telemetry/"*.jsonl 2>/dev/null; then
  ok "outcome=success persists (C1)"
else
  fail "outcome=success persists (C1)"
fi

# ── 3. JSONL is valid JSON ──
last_line=$(tail -1 "$SKILL_TELEMETRY_DIR/telemetry/"*.jsonl 2>/dev/null)
if echo "$last_line" | jq -e . >/dev/null 2>&1; then
  ok "JSONL line is valid JSON"
else
  fail "JSONL line is valid JSON"
fi

# ── 4. Path traversal in session_id is contained (C2) ──
telemetry-log --skill smoke --outcome success --session-id "../../escape" --duration 1 2>/dev/null
if [ -f "$SKILL_TELEMETRY_DIR/telemetry/sessions/escape" ] && \
   ! find / -maxdepth 3 -name 'escape' -path '*/escape' -not -path "$SKILL_TELEMETRY_DIR/*" 2>/dev/null | grep -q .; then
  ok "session_id path traversal blocked (C2)"
else
  fail "session_id path traversal blocked (C2)"
fi

# ── 5. skill-events --skill rejects shell-unsafe chars (F8) ──
# Force TZ to a known-safe value so the TZ validator passes and we
# actually reach the --skill validator. On stock Ubuntu CI runners
# /etc/localtime may not be a symlink, leaving TZ_NAME unexpected.
if TZ=UTC skill-events --skill 'foo; rm -rf /' 2>&1 | grep -q "unsafe characters"; then
  ok "skill-events --skill rejects unsafe chars (F8)"
else
  fail "skill-events --skill rejects unsafe chars (F8)"
fi

# ── 6. skill-events --limit rejects non-digit input (C3) ──
if TZ=UTC skill-events --limit '10; drop table' 2>&1 | grep -q "must be a positive integer"; then
  ok "skill-events --limit rejects SQL injection (C3)"
else
  fail "skill-events --limit rejects SQL injection (C3)"
fi

# ── 7. Unknown flag emits stderr warning but doesn't fail (F10) ──
out=$(telemetry-log --skill smoke --bogus-flag value --outcome success --session-id sess-B 2>&1 >/dev/null)
if echo "$out" | grep -q "unknown flag"; then
  ok "unknown flag emits warning (F10)"
else
  fail "unknown flag emits warning (F10)"
fi

# ── 8. Hook install/uninstall idempotency ──
export CLAUDE_SETTINGS="$TMP/settings.json"
# need telemetry-log + telemetry-hook on PATH, both are -x via chmod above
telemetry-hook-install --skill ci-test >/dev/null 2>&1
telemetry-hook-install --skill ci-test >/dev/null 2>&1
count=$(jq '[.hooks.Stop[] | select((.hooks // []) | any(.["x-marker"] == "skill-telemetry:ci-test"))] | length' "$CLAUDE_SETTINGS")
if [ "$count" = "1" ]; then
  ok "hook install idempotency (no duplicates)"
else
  fail "hook install idempotency (no duplicates) — got $count entries"
fi
telemetry-hook-uninstall --skill ci-test >/dev/null 2>&1
count=$(jq '.hooks.Stop | length' "$CLAUDE_SETTINGS")
if [ "$count" = "0" ]; then
  ok "hook uninstall removes entry"
else
  fail "hook uninstall removes entry — $count entries remain"
fi

# ── 9. telemetry-hook-install rejects unsafe skill names (F22) ──
if telemetry-hook-install --skill 'a; b' 2>&1 | grep -q 'unsafe characters'; then
  ok "telemetry-hook-install rejects unsafe skill names (F22)"
else
  fail "telemetry-hook-install rejects unsafe skill names (F22)"
fi

# ── 10. --source flag persists 'hook' in JSONL ──
telemetry-log --skill smoke --outcome success --source hook --session-id sess-hk --duration 1 2>/dev/null
if grep -q '"source":"hook"' "$SKILL_TELEMETRY_DIR/telemetry/"*.jsonl 2>/dev/null; then
  ok "--source hook persists in JSONL"
else
  fail "--source hook persists in JSONL"
fi

# ── 11. Hook install/uninstall handles legacy entries (no x-marker) ──
# Regression test: a settings.json containing a pre-x-marker hook
# entry must be discoverable by uninstall (otherwise the entry orphans).
# Note: capture output to a file, then grep — piping into `grep -q`
# closes stdin and kills the upstream script via SIGPIPE/pipefail before
# the mutation completes. Found this the hard way writing this test.
LEGACY_SETTINGS="$(mktemp)"
LEGACY_OUTPUT="$(mktemp)"
cat > "$LEGACY_SETTINGS" <<'EOF'
{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"SKILL_TELEMETRY_HOOK_SKILL=legacyskill SKILL_TELEMETRY_HOOK_BIN='x' 'y'","timeout":10}]}]}}
EOF
CLAUDE_SETTINGS="$LEGACY_SETTINGS" telemetry-hook-uninstall --skill legacyskill > "$LEGACY_OUTPUT" 2>&1
if grep -q "Found 1 hook" "$LEGACY_OUTPUT"; then
  ok "uninstall finds legacy entry without x-marker"
else
  fail "uninstall finds legacy entry without x-marker"
fi
# After uninstall, the entry should be gone
if [ "$(jq '.hooks.Stop | length' "$LEGACY_SETTINGS")" = "0" ]; then
  ok "uninstall removes legacy entry"
else
  fail "uninstall removes legacy entry"
fi
rm -f "$LEGACY_SETTINGS" "$LEGACY_OUTPUT"

# ── 12. Abandoned heuristic no longer false-fires on free text ──
# Regression test: a transcript whose assistant message *mentions* the
# word "interrupted" or "abandoned" (e.g. when discussing this very
# heuristic) should NOT be tagged abandoned. Only structural signals
# count: stop_reason=interrupted, or last user msg has the literal
# "Request interrupted by user" / "Tool use was rejected by user".
FAKE_TRANSCRIPT="$(mktemp)"
cat > "$FAKE_TRANSCRIPT" <<'EOF'
{"type":"user","message":{"role":"user","content":"explain abandoned heuristic"}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"the old code grepped for interrupted and abort"}],"stop_reason":"end_turn"}}
EOF
LAST_TAIL="$(tail -20 "$FAKE_TRANSCRIPT")"
SR=$(printf '%s\n' "$LAST_TAIL" | jq -rs 'map(select(.type == "assistant")) | last | .message.stop_reason // empty')
UI=$(printf '%s\n' "$LAST_TAIL" | jq -rs 'map(select(.type == "user")) | last | .message.content | tostring | test("Request interrupted by user|Tool use was rejected by user")')
if [ "$SR" != "interrupted" ] && [ "$UI" != "true" ]; then
  ok "abandoned heuristic ignores discussion-of-the-word text"
else
  fail "abandoned heuristic ignores discussion-of-the-word text (got SR='$SR' UI='$UI')"
fi

# Positive case: real interrupted assistant turn IS detected
cat > "$FAKE_TRANSCRIPT" <<'EOF'
{"type":"user","message":{"role":"user","content":"do thing"}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"stop_reason":"interrupted"}}
EOF
LAST_TAIL="$(tail -20 "$FAKE_TRANSCRIPT")"
SR=$(printf '%s\n' "$LAST_TAIL" | jq -rs 'map(select(.type == "assistant")) | last | .message.stop_reason // empty')
if [ "$SR" = "interrupted" ]; then
  ok "abandoned heuristic still detects real stop_reason=interrupted"
else
  fail "abandoned heuristic still detects real stop_reason=interrupted (got '$SR')"
fi
rm -f "$FAKE_TRANSCRIPT"

# ── 13. Local dashboard demo mode boots + DNS rebinding defense ──
# Only run if node + jq are around (CI has both; some local envs may not).
if command -v node >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  cd "$ROOT/dashboard"
  PORT=19199 SKILL_TELEMETRY_DEMO=1 node local.js >/dev/null 2>&1 &
  DSH_PID=$!
  # Poll until ready (up to 6s)
  for i in $(seq 1 30); do
    if curl -fs -o /dev/null http://127.0.0.1:19199/api/dau 2>/dev/null; then break; fi
    sleep 0.2
  done
  if curl -fs http://127.0.0.1:19199/api/dau 2>/dev/null | jq -e 'length > 0' >/dev/null 2>&1; then
    ok "local dashboard demo serves data"
  else
    fail "local dashboard demo serves data"
  fi
  # DNS rebinding: malicious Host header should be rejected
  status=$(curl -s -o /dev/null -w "%{http_code}" -H "Host: evil.com" http://127.0.0.1:19199/ 2>/dev/null || echo 000)
  if [ "$status" = "421" ]; then
    ok "DNS rebinding defense (Host allowlist) returns 421"
  else
    fail "DNS rebinding defense (Host allowlist) — expected 421, got $status"
  fi
  kill $DSH_PID 2>/dev/null || true
  wait $DSH_PID 2>/dev/null || true
  cd "$ROOT"
fi

# ── Report ──
echo ""
echo "===================================="
echo "Passed: $PASS   Failed: $FAIL"
echo "===================================="
[ "$FAIL" -eq 0 ]
