#!/usr/bin/env bash
# mux-pi: レーン枠 / 委譲 pane を閉じる（司令塔の tab/pane は閉じない・Herdr 専用）
# 用法:
#   close.sh --tab TAB_ID
#   close.sh --pane PANE_ID
set -euo pipefail

MUX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DETECT="$MUX_DIR/scripts/detect.sh"

tab=""
pane=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tab)     tab="$2"; shift 2 ;;
    --pane)    pane="$2"; shift 2 ;;
    *)         printf '{"ok":false,"error":"unknown_arg","arg":"%s"}\n' "$1" >&2; exit 1 ;;
  esac
done

if [[ -z "$tab" && -z "$pane" ]]; then
  printf '{"ok":false,"error":"missing_target","hint":"--tab TAB_ID / --pane PANE_ID"}\n' >&2
  exit 1
fi

detect_json="$("$DETECT")"
backend="$(printf '%s' "$detect_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["backend"])')"
if [[ "$backend" != "herdr" ]]; then
  printf '{"ok":false,"error":"no_mux_available","hint":"Herdr の外（HERDR_ENV=1 が無い）"}\n' >&2
  exit 1
fi

if [[ -n "$tab" ]]; then
  if [[ -n "${HERDR_TAB_ID:-}" && "$tab" == "$HERDR_TAB_ID" ]]; then
    printf '{"ok":false,"error":"refusing_close_commander_tab","tab_id":"%s"}\n' "$tab" >&2
    exit 1
  fi
  herdr tab close "$tab" >/dev/null
  python3 - "$tab" <<'PY'
import json, sys
print(json.dumps({"ok": True, "backend": "herdr", "closed_tab": sys.argv[1]}))
PY
  exit 0
fi

if [[ -n "${HERDR_PANE_ID:-}" && "$pane" == "$HERDR_PANE_ID" ]]; then
  printf '{"ok":false,"error":"refusing_close_commander_pane","pane_id":"%s"}\n' "$pane" >&2
  exit 1
fi
herdr pane close "$pane" >/dev/null
python3 - "$pane" <<'PY'
import json, sys
print(json.dumps({"ok": True, "backend": "herdr", "closed_pane": sys.argv[1]}))
PY
