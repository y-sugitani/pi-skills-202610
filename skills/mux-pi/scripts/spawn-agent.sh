#!/usr/bin/env bash
# mux-pi: 子 pi を Herdr 側で起動する
# 用法: spawn-agent.sh --task-file PATH [--workdir DIR] [--title NAME] [--model M] [--wait]
# - herdr: tab create → agent start --kind pi → prompt（受理=working|blocked を確認。失敗時 1 回リトライ）
#          安委譲（--layout pane）は --wait せず主が監督。--wait は timer 未ロード時の劣化 1 本
#          --layout pane + --wait は result 回収後に自分で split した下ペインを閉じる
#          （レーン用 --layout tab は閉じない。MUX_SPAWN_KEEP_PANE=1 で残す）
# - none:  ensure してから作った側で起動
# Herdr 外は spawn できない（委譲は subagent の async で代用する）。
set -euo pipefail

MUX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DETECT="$MUX_DIR/scripts/detect.sh"
ENSURE="$MUX_DIR/scripts/ensure.sh"

# prompt 後に working|blocked を待つ秒（初回未着対策）
PROMPT_ACK_SEC="${MUX_SPAWN_PROMPT_ACK_SEC:-10}"
# 失敗時の追加 prompt 回数（合計試行 = 1 + この値）
PROMPT_RETRIES="${MUX_SPAWN_PROMPT_RETRIES:-1}"

task_file=""
workdir="$PWD"
title=""
model=""
agent_name=""
layout="tab"
wait_flag=0
spawned_via_split=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --task-file) task_file="$2"; shift 2 ;;
    --workdir)   workdir="$2"; shift 2 ;;
    --title)     title="$2"; shift 2 ;;
    --model)     model="$2"; shift 2 ;;
    --agent)     agent_name="$2"; shift 2 ;;
    --layout)    layout="$2"; shift 2 ;;
    --wait)      wait_flag=1; shift ;;
    *)           printf '{"ok":false,"error":"unknown_arg","arg":"%s"}\n' "$1" >&2; exit 1 ;;
  esac
done
if [[ -z "$task_file" || ! -f "$task_file" ]]; then
  printf '{"ok":false,"error":"bad_task_file","hint":"--task-file PATH に実在ファイルを指定"}\n' >&2
  exit 1
fi
if ! command -v pi >/dev/null 2>&1; then
  printf '{"ok":false,"error":"pi_not_in_path","hint":"pi を PATH に入れてから spawn する"}\n' >&2
  exit 1
fi

# --agent 指定時: agent 定義を読み pi 起動引数を構築
# （executor/explore と同じ thinking/excludeTools/systemPrompt を再現。モデルは --model → cheap-model.json → 定義の model:）
agent_exclude_tools=""
agent_skills_arg=""
agent_skill_args=()
agent_prompt_flag=""
agent_prompt_file=""
if [[ -n "$agent_name" ]]; then
  # 探索順: MUX_AGENT_DIR → パッケージの agents/ → pi の agent dir（~/.pi/agent/agents）
  PKG_ROOT="$(cd "$MUX_DIR/../.." && pwd)"
  agent_def_file=""
  for cand in "${MUX_AGENT_DIR:+$MUX_AGENT_DIR/${agent_name}.md}" \
              "$PKG_ROOT/agents/${agent_name}.md" \
              "$HOME/.pi/agent/agents/${agent_name}.md"; do
    if [[ -n "$cand" && -f "$cand" ]]; then
      agent_def_file="$cand"
      break
    fi
  done
  if [[ -z "$agent_def_file" ]]; then
    printf '{"ok":false,"error":"agent_def_not_found","agent":"%s","searched":["MUX_AGENT_DIR","<package>/agents","~/.pi/agent/agents"]}\n' "$agent_name" >&2
    exit 1
  fi
  awk_val() { awk -F': ' "/^$1:/{print \$2; exit}" "$agent_def_file"; }
  a_model="$(awk_val model)"
  a_thinking="$(awk_val thinking)"
  a_exclude_tools="$(awk_val excludeTools)"
  a_inherit_skills="$(awk_val inheritSkills)"
  a_skills="$(awk_val skills)"
  a_spm="$(awk_val systemPromptMode)"
  # --agent の model は --model 未指定時のみ（--model が上書き優先）。
  # agent 定義は model: を持たない前提（/cheap-model で選ぶ）。
  if [[ -z "$model" && -n "$a_model" ]]; then
    model="$a_model"
    [[ -n "$a_thinking" && "$a_thinking" != "false" ]] && model="${a_model}:${a_thinking}"
  fi
  agent_exclude_tools="$(echo "$a_exclude_tools" | tr -d ' ')"
  # スキル探索 base（macOS bash 3.2 互換: 連想配列は使わない）
  skill_bases=("$workdir/.agents/skills" "$workdir/.pi/skills" "$PKG_ROOT/skills" "$HOME/.pi/agent/skills" "$HOME/.agents/skills")
  pinned_skill_names=""
  # 指定名の SKILL.md を bases から探して --skill で pin（重複は 1 回だけ）
  pin_skill() {
    local sn="$1" base
    for base in "${skill_bases[@]}"; do
      if [[ -f "$base/$sn/SKILL.md" ]]; then
        case " $pinned_skill_names " in
          *" $sn "*) return 0 ;;
        esac
        pinned_skill_names="$pinned_skill_names $sn"
        agent_skill_args+=(--skill "$(cd "$base/$sn" && pwd)/SKILL.md")
        return 0
      fi
    done
    return 1
  }
  # スキル方針:
  # - inheritSkills: false → --no-skills + skills: を --skill で pin（explore 用）
  # - inheritSkills: true → 継承のまま。全 pin は起動失敗の主因なのでやらない。
  #   除外スキルは system prompt に名前を書いて読ませない。
  if [[ "$a_inherit_skills" == "false" ]]; then
    agent_skills_arg="--no-skills"
    if [[ -n "$a_skills" ]]; then
      IFS=',' read -ra skill_names <<< "$a_skills"
      for sn in "${skill_names[@]}"; do
        sn="$(printf '%s' "$sn" | xargs)"
        [[ -z "$sn" ]] && continue
        pin_skill "$sn" || true
      done
    fi
  fi
  agent_prompt_flag="--system-prompt"
  [[ "$a_spm" == "append" ]] && agent_prompt_flag="--append-system-prompt"
  agent_prompt_file="$(mktemp "/tmp/${agent_name}-prompt.XXXXXX")"
  awk 'NR==1 && /^---/{fm=1; next} fm && /^---/{fm=0; next} !fm' "$agent_def_file" > "$agent_prompt_file"
  {
    printf '\n使わないスキル: advisor, delegate-execute, lane-control, mux-pi, pi-subagents, skill-manage\n'
    printf '再委譲するな。\n'
  } >> "$agent_prompt_file"
fi

# モデル未指定: /cheap-model が書く cheap-model.json（provider/model[:thinking]）を使う。
# 無ければ --model を渡さない（pi の既定モデル）。
if [[ -z "$model" ]]; then
  cheap_cfg="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/cheap-model.json"
  if [[ -f "$cheap_cfg" ]]; then
    model="$(python3 - "$cheap_cfg" <<'CFG'
import json, sys
try:
    c = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    sys.exit(0)
p, m, t = c.get("provider"), c.get("model"), c.get("thinking")
if isinstance(p, str) and p and isinstance(m, str) and m:
    print(f"{p}/{m}:{t}" if isinstance(t, str) and t else f"{p}/{m}")
CFG
)"
  fi
fi

# agent 名: [a-z][a-z0-9_-]{0,31}。不可文字は _、先頭数字は a 前置
sanitize_name() {
  local raw="$1"
  local s
  s="$(printf '%s' "$raw" | tr -cs 'a-zA-Z0-9_-' '_' | tr 'A-Z' 'a-z' | cut -c1-31)"
  [[ -z "$s" ]] && s="agent"
  [[ "$s" =~ ^[0-9] ]] && s="a$s"
  printf '%s' "$s"
}

# herdr agent get → agent_status（失敗時空）
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

# 自分で pane split した下ペインだけ閉じる。司令塔 pane / tab レイアウト / KEEP は対象外。
herdr_close_own_split_pane() {
  local pane_id="$1"
  [[ -n "$pane_id" ]] || return 1
  [[ "$spawned_via_split" -eq 1 ]] || return 1
  [[ -n "${MUX_SPAWN_KEEP_PANE:-}" ]] && return 1
  if [[ -n "${HERDR_PANE_ID:-}" && "$pane_id" == "$HERDR_PANE_ID" ]]; then
    return 1
  fi
  herdr pane close "$pane_id" >/dev/null 2>&1
}

herdr_start_pi() {
  local name="$1"
  local pane_id="$2"
  local -a extra=()
  extra+=(--approve --name "$name")
  [[ -n "$model" ]] && extra+=(--model "$model")
  [[ -n "$agent_exclude_tools" ]] && extra+=(--exclude-tools "$agent_exclude_tools")
  [[ -n "$agent_skills_arg" ]] && extra+=("$agent_skills_arg")
  [[ ${#agent_skill_args[@]} -gt 0 ]] && extra+=("${agent_skill_args[@]}")
  [[ -n "$agent_prompt_flag" && -n "$agent_prompt_file" ]] && extra+=("$agent_prompt_flag" "$agent_prompt_file")
  # pane split 直後は shell 起動中で agent_pane_busy になり得る → available までリトライ
  local try=0 start_out start_rc
  while [[ "$try" -lt 6 ]]; do
    set +e
    start_out="$(herdr agent start "$name" --kind pi --pane "$pane_id" --timeout "${MUX_SPAWN_START_TIMEOUT_MS:-120000}" -- "${extra[@]}" 2>&1)"
    start_rc=$?
    set -e
    if [[ "$start_rc" -eq 0 ]]; then
      printf '%s' "$start_out"
      return 0
    fi
    if [[ "$start_out" == *"agent_pane_busy"* && "$try" -lt 5 ]]; then
      sleep 1
      try=$((try + 1))
      continue
    fi
    printf '%s' "$start_out" >&2
    return 1
  done
  return 1
}

# prompt 送信 → working|blocked になるまで短待ち。未着なら最大 PROMPT_RETRIES 回再送。
# 成功時: 標準出力に attempts|status
# 失敗時: return 1（呼び出し側で ok:false）
herdr_prompt_until_ack() {
  local name="$1"
  local text="$2"
  local max_attempts=$((1 + PROMPT_RETRIES))
  local attempt=1
  local last_err=""
  local st=""

  while [[ "$attempt" -le "$max_attempts" ]]; do
    # 送信直前が working のままなら、前ジョブ消化を短く待つ（最大 5s）
    st="$(herdr_agent_status "$name")"
    if [[ "$st" == "working" ]]; then
      local i=0
      while [[ "$i" -lt 5 && "$st" == "working" ]]; do
        sleep 1
        st="$(herdr_agent_status "$name")"
        i=$((i + 1))
      done
    fi

    local prompt_out rc
    set +e
    prompt_out="$(herdr agent prompt "$name" "$text" 2>&1)"
    rc=$?
    set -e
    if [[ "$rc" -ne 0 ]]; then
      last_err="prompt_exit_$rc: $prompt_out"
      sleep 1
      attempt=$((attempt + 1))
      continue
    fi

    # 受理: working or blocked（質問 UI）
    local j=0
    while [[ "$j" -lt "$PROMPT_ACK_SEC" ]]; do
      st="$(herdr_agent_status "$name")"
      if [[ "$st" == "working" || "$st" == "blocked" ]]; then
        printf '%s\n' "$attempt|$st"
        return 0
      fi
      sleep 1
      j=$((j + 1))
    done

    last_err="no_ack_status=${st:-unknown}"
    attempt=$((attempt + 1))
    sleep 1
  done

  printf '%s\n' "$last_err" >&2
  return 1
}

herdr_spawn_prompt_flow() {
  # args: name tab_id pane_id [ensured=0|1]
  local name="$1"
  local tab_id="${2:-}"
  local pane_id="$3"
  local ensured="${4:-0}"
  local task_text
  task_text="$(cat "$task_file")"

  local ack_line ack_rc=0
  set +e
  ack_line="$(herdr_prompt_until_ack "$name" "$task_text" 2>/tmp/mux-pi-spawn-ack-err.$$)"
  ack_rc=$?
  set -e
  if [[ "$ack_rc" -ne 0 ]]; then
    local detail
    detail="$(tr '\n' ' ' </tmp/mux-pi-spawn-ack-err.$$ 2>/dev/null || true)"
    rm -f /tmp/mux-pi-spawn-ack-err.$$
    python3 - "$name" "$task_file" "$detail" <<'PY' >&2
import json, sys
name, task, detail = sys.argv[1:]
print(json.dumps({
    "ok": False,
    "error": "herdr_prompt_not_acked",
    "agent": name,
    "task_file": task,
    "detail": detail.strip(),
    "hint": "初回 prompt が working|blocked にならなかった。task-file と herdr agent get を確認。herdr integration install pi も確認",
}, ensure_ascii=False))
PY
    exit 1
  fi
  rm -f /tmp/mux-pi-spawn-ack-err.$$

  local attempts status
  attempts="${ack_line%%|*}"
  status="${ack_line#*|}"

  local settled=0
  local result_file=""
  if [[ "$wait_flag" -eq 1 ]]; then
    set +e
    herdr agent wait "$name" --timeout 1800000 >/dev/null 2>&1
    local wrc=$?
    set -e
    if [[ "$wrc" -ne 0 ]]; then
      printf '{"ok":false,"error":"herdr_wait_failed","agent":"%s","prompt_attempts":%s,"last_status":"%s"}\n' \
        "$name" "$attempts" "$status" >&2
      exit 1
    fi
    settled=1
    status="$(herdr_agent_status "$name")"
    status="${status:-idle}"
    # 結果テキストを回収（agent read → 一時ファイル。主が結果を受け取る用）
    result_file="/tmp/${name}-result-$$.md"
    herdr agent read "$name" --source recent-unwrapped --lines 200 2>/dev/null > "$result_file" || true
    [[ -s "$result_file" ]] || result_file=""
  fi

  local closed_pane=0
  if [[ "$wait_flag" -eq 1 && "$settled" -eq 1 ]]; then
    if herdr_close_own_split_pane "$pane_id"; then
      closed_pane=1
    fi
  fi

  python3 - "$name" "$tab_id" "$pane_id" "$task_file" "$wait_flag" "$attempts" "$status" "$ensured" "$settled" "$result_file" "$closed_pane" <<'PY'
import json, sys
name, tab, pane, task, wait, attempts, status, ensured, settled, result_file, closed_pane = sys.argv[1:]
out = {
    "ok": True,
    "backend": "herdr",
    "agent": name,
    "pane_id": pane,
    "task_file": task,
    "waited": wait == "1",
    "settled": settled == "1",
    "closed_pane": closed_pane == "1",
    "prompt_attempts": int(attempts),
    "agent_status": status,
}
if result_file:
    out["result_file"] = result_file
if tab:
    out["tab_id"] = tab
if ensured == "1":
    out["ensured"] = True
print(json.dumps(out))
PY
}

detect_json="$("$DETECT")"
backend="$(printf '%s' "$detect_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["backend"])')"

# --- herdr ---
if [[ "$backend" == "herdr" ]]; then
  # workspace: 環境変数があればそれ、無ければ workspace list の先頭（ensure.sh と同じ取り方）
  ws_id="${HERDR_WORKSPACE_ID:-}"
  if [[ -z "$ws_id" ]]; then
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
  fi
  if [[ -z "$ws_id" ]]; then
    printf '{"ok":false,"error":"herdr_workspace_unavailable","hint":"herdr workspace list の結果を確認"}\n' >&2
    exit 1
  fi
  label="${title:-}"
  if [[ "$layout" == "pane" ]]; then
    # pane split（caller pane の下）— delegate-execute 等の単一委譲可視化用
    pane_json="$(herdr pane split --current --direction down --cwd "$workdir" --no-focus 2>/dev/null || true)"
    pane_id="$(printf '%s' "$pane_json" | python3 -c '
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
    tab_id=""
    if [[ -z "$pane_id" ]]; then
      printf '{"ok":false,"error":"herdr_pane_split_failed","hint":"herdr pane split の結果を確認"}\n' >&2
      exit 1
    fi
    spawned_via_split=1
  else
    # 新 tab を作る（--no-focus で司令塔のフォーカスを奪わない）— lane-control 等の複数レーン用
    tab_args=(--workspace "$ws_id" --cwd "$workdir" --no-focus)
    [[ -n "$label" ]] && tab_args+=(--label "$label")
    tab_json="$(herdr tab create "${tab_args[@]}" 2>/dev/null || true)"
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
  fi
  name="$(sanitize_name "${title:-agent}")"
  # 衝突時は suffix を付ける
  if herdr agent list 2>/dev/null | grep -q "\"$name\""; then
    name="${name}-$$"
  fi
  agent_err="$(herdr_start_pi "$name" "$pane_id" 2>&1)" || true
  if ! herdr agent get "$name" >/dev/null 2>&1; then
    herdr_close_own_split_pane "$pane_id" || true
    printf '{"ok":false,"error":"herdr_agent_start_failed","hint":"herdr agent start --kind pi の結果を確認: %s"}\n' "$agent_err" >&2
    exit 1
  fi

  # start 直後が interactive になるまで最大 15s（get は成功しても prompt 未着になり得る）
  ready_i=0
  while [[ "$ready_i" -lt 15 ]]; do
    st="$(herdr_agent_status "$name")"
    if [[ "$st" == "idle" || "$st" == "done" || "$st" == "blocked" ]]; then
      break
    fi
    sleep 1
    ready_i=$((ready_i + 1))
  done

  herdr_spawn_prompt_flow "$name" "$tab_id" "$pane_id" 0
  exit 0
fi

# --- none: ensure してから作った側で起動 ---
ensure_json="$("$ENSURE" 2>/dev/null || true)"
action="$(printf '%s' "$ensure_json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("action",""))' 2>/dev/null || true)"
if [[ "$action" == "created_herdr_tab" ]]; then
  pane_id="$(printf '%s' "$ensure_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["pane_id"])')"
  name="$(sanitize_name "${title:-agent}")"
  agent_err="$(herdr_start_pi "$name" "$pane_id" 2>&1)" || true
  if ! herdr agent get "$name" >/dev/null 2>&1; then
    printf '{"ok":false,"error":"herdr_agent_start_failed","hint":"%s"}\n' "$agent_err" >&2
    exit 1
  fi
  ready_i=0
  while [[ "$ready_i" -lt 15 ]]; do
    st="$(herdr_agent_status "$name")"
    if [[ "$st" == "idle" || "$st" == "done" || "$st" == "blocked" ]]; then
      break
    fi
    sleep 1
    ready_i=$((ready_i + 1))
  done
  herdr_spawn_prompt_flow "$name" "" "$pane_id" 1
  exit 0
fi

printf '{"ok":false,"error":"no_mux_available","hint":"Herdr が無い（ensure.sh 失敗: %s）。Herdr 外は subagent（async: true）で委譲する"}\n' "$ensure_json" >&2
exit 1
