#!/usr/bin/env bash
# mux-pi: pi-session-tail.sh の簡易テスト（fixture jsonl で末尾 assistant を検証）
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$DIR/scripts/pi-session-tail.sh"
FIXDIR="$DIR/fixtures"

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

out="$("$SCRIPT" --session-dir "$FIXDIR" --assistant-blocks 2 --max-chars 2000)"
[[ "$out" == *"second assistant text"* ]] || fail "second block missing"
[[ "$out" == *"third assistant text"* ]] || fail "third block missing"
[[ "$out" != *"first assistant text"* ]] || fail "first block should be excluded"
[[ "$out" != *"first thinking"* ]] || fail "thinking should be hidden by default"

out1="$("$SCRIPT" --session-dir "$FIXDIR" --assistant-blocks 3 --max-chars 2000)"
[[ "$out1" == *"[tool: timer_start]"* ]] || fail "toolCall name missing"

out2="$("$SCRIPT" --session-dir "$FIXDIR" --assistant-blocks 3 --include-thinking)"
[[ "$out2" == *"first thinking"* ]] || fail "thinking missing with --include-thinking"

out3="$("$SCRIPT" --session-dir "$FIXDIR" --assistant-blocks 3 --max-chars 30)"
[[ "$out3" == *"truncated"* ]] || fail "truncation marker missing"

printf 'PASS: pi-session-tail.sh\n'
