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

# ── Report ──
echo ""
echo "===================================="
echo "Passed: $PASS   Failed: $FAIL"
echo "===================================="
[ "$FAIL" -eq 0 ]
