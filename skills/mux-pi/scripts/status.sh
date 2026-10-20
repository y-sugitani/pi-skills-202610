#!/usr/bin/env bash
# mux-pi: レーンの状態を JSON 1 行で出す（Herdr 専用）
# 用法:
#   status.sh --agent NAME
#   status.sh                 # backend 全体の一覧
set -euo pipefail

MUX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DETECT="$MUX_DIR/scripts/detect.sh"

agent=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent)   agent="$2"; shift 2 ;;
    *)         printf '{"ok":false,"error":"unknown_arg","arg":"%s"}\n' "$1" >&2; exit 1 ;;
  esac
done

detect_json="$("$DETECT")"
backend="$(printf '%s' "$detect_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["backend"])')"

if [[ "$backend" == "herdr" ]]; then
  if [[ -n "$agent" ]]; then
    out="$(herdr agent get "$agent" 2>&1)" || {
      printf '{"ok":false,"error":"herdr_agent_get_failed","agent":"%s","detail":%s}\n' \
        "$agent" "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$out")" >&2
      exit 1
    }
    printf '%s' "$out" | python3 -c '
import json, sys
data = json.load(sys.stdin)
status = None
def walk(d):
    global status
    if isinstance(d, dict):
        if isinstance(d.get("agent_status"), str) and status is None:
            status = d["agent_status"]
        for v in d.values():
            walk(v)
    elif isinstance(d, list):
        for x in d:
            walk(x)
walk(data)
print(json.dumps({"ok": True, "backend": "herdr", "agent_status": status, "raw": data}, default=str))
'
    exit 0
  fi
  out="$(herdr agent list 2>&1)" || {
    printf '{"ok":false,"error":"herdr_agent_list_failed"}\n' >&2
    exit 1
  }
  printf '%s' "$out" | python3 -c '
import json, sys
data = json.load(sys.stdin)
print(json.dumps({"ok": True, "backend": "herdr", "agents": data}, default=str))
'
  exit 0
fi

printf '{"ok":false,"error":"no_mux_available","hint":"Herdr の外（HERDR_ENV=1 が無い）。Herdr 外は subagent（async: true）で委譲する"}\n' >&2
exit 1
