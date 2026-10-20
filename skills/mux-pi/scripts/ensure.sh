#!/usr/bin/env bash
# mux-pi: backend=none のとき Herdr 側にシェルを用意する
# - backend が既にある → detect JSON をそのまま出して exit 0
# - herdr で tab を作った → action=created_herdr_tab で exit 2
# - preferred=none → error JSON で exit 1
# 破壊的操作はしない（server stop / 既存 pane close はしない）。
set -euo pipefail

MUX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DETECT="$MUX_DIR/scripts/detect.sh"

detect_json="$("$DETECT")"
backend="$(printf '%s' "$detect_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["backend"])')"
preferred="$(printf '%s' "$detect_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["preferred"])')"

if [[ "$backend" != "none" ]]; then
  printf '%s\n' "$detect_json"
  exit 0
fi

if [[ "$preferred" == "herdr" ]]; then
  # workspace を取得（最初の workspace、無ければ create）
  ws_json="$(herdr workspace list 2>/dev/null || true)"
  ws_id="$(printf '%s' "$ws_json" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(1)
def find_ws(d):
    if isinstance(d, list):
        return d[0]["workspace_id"] if d and isinstance(d[0], dict) and "workspace_id" in d[0] else None
    if isinstance(d, dict):
        for k in ("workspaces", "result"):
            v = d.get(k)
            if isinstance(v, list) and v and isinstance(v[0], dict):
                for key in ("workspace_id", "id"):
                    if key in v[0]:
                        return v[0][key]
            if isinstance(v, dict):
                r = find_ws(v)
                if r:
                    return r
    return None
print(find_ws(data) or "")
' 2>/dev/null || true)"
  if [[ -z "$ws_id" ]]; then
    ws_json="$(herdr workspace create 2>/dev/null || true)"
    ws_id="$(printf '%s' "$ws_json" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(1)
def find_ws(d):
    if isinstance(d, dict):
        for k in ("workspace", "result"):
            v = d.get(k)
            if isinstance(v, dict):
                for key in ("workspace_id", "id"):
                    if key in v:
                        return v[key]
                r = find_ws(v)
                if r:
                    return r
    return None
print(find_ws(data) or "")
' 2>/dev/null || true)"
  fi
  if [[ -z "$ws_id" ]]; then
    printf '{"ok":false,"error":"herdr_workspace_unavailable","hint":"herdr workspace list/create に失敗"}\n' >&2
    exit 1
  fi

  # 新 tab を作る（--no-focus でユーザーのフォーカスを奪わない）
  tab_json="$(herdr tab create --workspace "$ws_id" --no-focus 2>/dev/null || true)"
  tab_id="$(printf '%s' "$tab_json" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(1)
def find_tab(d):
    if isinstance(d, dict):
        for k in ("tab", "result"):
            v = d.get(k)
            if isinstance(v, dict):
                for key in ("tab_id", "id"):
                    if key in v:
                        return v[key]
                r = find_tab(v)
                if r:
                    return r
    return None
print(find_tab(data) or "")
' 2>/dev/null || true)"
  pane_id="$(printf '%s' "$tab_json" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(1)
def find_pane(d):
    if isinstance(d, dict):
        for k in ("root_pane", "pane", "result"):
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
  if [[ -z "$tab_id" || -z "$pane_id" ]]; then
    printf '{"ok":false,"error":"herdr_tab_create_failed","hint":"herdr tab create の結果を確認"}\n' >&2
    exit 1
  fi

  # 新 tab の root pane で現在ディレクトリのログインシェルを起動
  herdr pane run "$pane_id" "cd $(printf '%q' "$PWD") && exec $SHELL -l" >/dev/null 2>&1 || true

  python3 - "$ws_id" "$tab_id" "$pane_id" "$PWD" <<'PY'
import json, sys
ws, tab, pane, pwd = sys.argv[1:]
print(json.dumps({
    "ok": True,
    "action": "created_herdr_tab",
    "backend": "herdr",
    "workspace_id": ws,
    "tab_id": tab,
    "pane_id": pane,
    "cwd": pwd,
    "hint": f"herdr の tab {tab} を用意した。ユーザーに attach を案内する（現セッションは殺さない）",
}))
PY
  exit 2
fi

printf '{"ok":false,"error":"no_mux_available","hint":"Herdr が無い。Herdr 外では spawn_cheap ではなく subagent（async: true）で委譲する"}\n' >&2
exit 1
