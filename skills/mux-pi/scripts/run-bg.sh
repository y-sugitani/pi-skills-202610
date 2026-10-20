#!/usr/bin/env bash
# mux-pi: 長時間プロセスを Herdr 側の pane で起動する
# 用法: run-bg.sh [--direction right|down] [--title NAME] -- <command...>
# stdout に JSON 1 行。ensure が必要なら ensure まで行い、作った側で実行する。
set -euo pipefail

MUX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DETECT="$MUX_DIR/scripts/detect.sh"
ENSURE="$MUX_DIR/scripts/ensure.sh"

direction="right"
title=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --direction) direction="$2"; shift 2 ;;
    --title)     title="$2"; shift 2 ;;
    --)          shift; break ;;
    *)           break ;;
  esac
done
if [[ $# -eq 0 ]]; then
  printf '{"ok":false,"error":"no_command","hint":"run-bg.sh [--direction right|down] [--title NAME] -- <command...>"}\n' >&2
  exit 1
fi
cmd="$*"

detect_json="$("$DETECT")"
backend="$(printf '%s' "$detect_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["backend"])')"

if [[ "$backend" == "herdr" ]]; then
  split_json="$(herdr pane split --current --direction "$direction" --cwd "$PWD" --no-focus 2>/dev/null || true)"
  pane_id="$(printf '%s' "$split_json" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(1)
def find_pane(d):
    if isinstance(d, dict):
        for k in ("pane", "result"):
            v = d.get(k)
            if isinstance(v, dict):
                for key in ("pane_id", "id"):
                    if key in v:
                        return v[key]
                r = find_pane(v)
                if r:
                    return r
    return None
print(find_pane(data) or "")
' 2>/dev/null || true)"
  if [[ -z "$pane_id" ]]; then
    printf '{"ok":false,"error":"herdr_split_failed","hint":"herdr pane split の結果を確認"}\n' >&2
    exit 1
  fi
  herdr pane run "$pane_id" "$cmd" >/dev/null 2>&1 || true
  python3 - "$pane_id" "$cmd" <<'PY'
import json, sys
pane, cmd = sys.argv[1:]
print(json.dumps({"ok": True, "backend": "herdr", "pane_id": pane, "command": cmd}))
PY
  exit 0
fi

# backend=none → ensure して作った側で実行
ensure_json="$("$ENSURE" 2>/dev/null || true)"
action="$(printf '%s' "$ensure_json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("action",""))' 2>/dev/null || true)"
if [[ "$action" == "created_herdr_tab" ]]; then
  pane_id="$(printf '%s' "$ensure_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["pane_id"])')"
  herdr pane run "$pane_id" "$cmd" >/dev/null 2>&1 || true
  python3 - "$pane_id" "$cmd" <<'PY'
import json, sys
pane, cmd = sys.argv[1:]
print(json.dumps({"ok": True, "backend": "herdr", "pane_id": pane, "command": cmd, "ensured": True}))
PY
  exit 0
fi
printf '{"ok":false,"error":"no_mux_available","hint":"Herdr が無い（ensure.sh: %s）。Herdr 外は subagent（async: true）で委譲する"}\n' "$ensure_json" >&2
exit 1
