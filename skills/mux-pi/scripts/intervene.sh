#!/usr/bin/env bash
# mux-pi: 走行中レーンへ割り込み（force+ack 正本）
# 用法:
#   intervene.sh --agent NAME --message TEXT
#   intervene.sh --agent NAME --message-file PATH
#   --force     working 中は esc してから prompt（default ON）
#   --no-force  esc しない
# Herdr 専用。
set -euo pipefail

MUX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DETECT="$MUX_DIR/scripts/detect.sh"

agent=""
message=""
message_file=""
force=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent)        agent="$2"; shift 2 ;;
    --message)      message="$2"; shift 2 ;;
    --message-file) message_file="$2"; shift 2 ;;
    --force)        force=1; shift ;;
    --no-force)     force=0; shift ;;
    *)              printf '{"ok":false,"error":"unknown_arg","arg":"%s"}\n' "$1" >&2; exit 1 ;;
  esac
done

# message 解決: --message 優先、無ければ --message-file の中身
if [[ -z "$message" && -n "$message_file" ]]; then
  if [[ ! -f "$message_file" ]]; then
    printf '{"ok":false,"error":"message_file_missing","file":"%s"}\n' "$message_file" >&2
    exit 1
  fi
  message="$(cat "$message_file")"
fi
if [[ -z "$message" ]]; then
  printf '{"ok":false,"error":"missing_message","hint":"--message TEXT または --message-file PATH"}\n' >&2
  exit 1
fi

detect_json="$("$DETECT")"
backend="$(printf '%s' "$detect_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["backend"])')"

# herdr agent get → agent_status（失敗時空。spawn-agent.sh と同じ抽出）
herdr_agent_status() {
  local name="$1"
  herdr agent get "$name" 2>/dev/null | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
def walk(d):
    if isinstance(d, dict):
        if "agent_status" in d and isinstance(d["agent_status"], str):
            print(d["agent_status"])
            return True
        for v in d.values():
            if walk(v):
                return True
    elif isinstance(d, list):
        for x in d:
            if walk(x):
                return True
    return False
walk(data)
' 2>/dev/null || true
}

if [[ "$backend" != "herdr" ]]; then
  printf '{"ok":false,"error":"no_mux_available","hint":"Herdr の外（HERDR_ENV=1 が無い）"}\n' >&2
  exit 1
fi

if [[ -n "$agent" ]]; then
  ACK_SEC="${MUX_INTERVENE_ACK_SEC:-8}"
  MAX_ATTEMPTS=2
  before_status="$(herdr_agent_status "$agent")"
  forced=0
  attempts=0
  last_err=""

  while [[ "$attempts" -lt "$MAX_ATTEMPTS" ]]; do
    attempts=$((attempts + 1))

    # working かつ force → esc（blocked は esc しない。ダイアログを壊さない）
    st="$(herdr_agent_status "$agent")"
    if [[ "$st" == "working" && "$force" -eq 1 ]]; then
      forced=1
      herdr agent send-keys "$agent" esc >/dev/null 2>&1 || true
      # 最大 3s ほど non-working を待つ（1s ポーリング）
      i=0
      while [[ "$i" -lt 3 ]]; do
        sleep 1
        st="$(herdr_agent_status "$agent")"
        [[ "$st" != "working" ]] && break
        i=$((i + 1))
      done
      # まだ working なら esc をもう 1 回
      if [[ "$st" == "working" ]]; then
        herdr agent send-keys "$agent" esc >/dev/null 2>&1 || true
        sleep 1
        st="$(herdr_agent_status "$agent")"
      fi
    fi

    # prompt（--wait は付けない。settled 待ちでハングさせない）
    set +e
    prompt_out="$(herdr agent prompt "$agent" "$message" 2>&1)"
    rc=$?
    set -e
    if [[ "$rc" -ne 0 ]]; then
      last_err="prompt_exit_$rc: $prompt_out"
      sleep 1
      continue
    fi

    # 受理 ack: working|blocked を最大 ACK_SEC 待つ
    acked=""
    j=0
    while [[ "$j" -lt "$ACK_SEC" ]]; do
      st="$(herdr_agent_status "$agent")"
      if [[ "$st" == "working" || "$st" == "blocked" ]]; then
        acked="$st"
        break
      fi
      sleep 1
      j=$((j + 1))
    done

    if [[ -n "$acked" ]]; then
      # 送る前が working で --no-force: prompt 直後に working のままは「キューに積んだだけ」と区別できない
      if [[ "$before_status" == "working" && "$force" -eq 0 && "$acked" == "working" ]]; then
        python3 - "$agent" <<'PY' >&2
import json, sys
print(json.dumps({
    "ok": False,
    "error": "already_working_no_force",
    "agent": sys.argv[1],
    "hint": "--no-force で working 中に送ると受理と区別できない。--force を使うか idle/done を待ってから送る",
}, ensure_ascii=False))
PY
        exit 1
      fi
      python3 - "$agent" "$forced" "$attempts" "$acked" "$before_status" <<'PY'
import json, sys
agent, forced, attempts, acked, before = sys.argv[1:]
print(json.dumps({
    "ok": True,
    "backend": "herdr",
    "agent": agent,
    "intervened": True,
    "forced": forced == "1",
    "attempts": int(attempts),
    "agent_status": acked,
    "before_status": before,
}, ensure_ascii=False))
PY
      exit 0
    fi

    last_err="no_ack_status=${st:-unknown}"
    # ack 失敗時: force なら esc 1 回 + prompt を合計 2 試行まで
    if [[ "$force" -eq 1 && "$attempts" -lt "$MAX_ATTEMPTS" ]]; then
      herdr agent send-keys "$agent" esc >/dev/null 2>&1 || true
      sleep 1
    fi
  done

  python3 - "$agent" "$attempts" "$last_err" <<'PY' >&2
import json, sys
agent, attempts, detail = sys.argv[1:]
print(json.dumps({
    "ok": False,
    "error": "herdr_prompt_not_acked",
    "agent": agent,
    "attempts": int(attempts),
    "detail": detail.strip(),
    "hint": "prompt が working|blocked にならなかった。herdr agent get / herdr integration install pi を確認",
}, ensure_ascii=False))
PY
  exit 1
fi

printf '{"ok":false,"error":"missing_agent","hint":"--agent NAME が必要"}\n' >&2
exit 1
