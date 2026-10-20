#!/usr/bin/env bash
# mux-pi: Pi session jsonl の末尾 assistant 塊をテキストで出す（深読み例外専用）
# 用法:
#   pi-session-tail.sh --session-dir DIR [--assistant-blocks N] [--max-chars M] [--include-thinking]
#   pi-session-tail.sh --agent NAME [--assistant-blocks N] [--max-chars M] [--include-thinking]
#   --agent は herdr から最新 jsonl を解決（agent_session.value）。herdr が無ければ
#   --session-dir 必須（agent は best-effort）。
# 禁止: 通常 completion 経路から呼ばない（本線は lane-control の lane-facts.sh）。
set -euo pipefail

session_dir=""
agent=""
blocks=3
max_chars=2500
include_thinking=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --session-dir) session_dir="$2"; shift 2 ;;
    --agent) agent="$2"; shift 2 ;;
    --assistant-blocks) blocks="$2"; shift 2 ;;
    --max-chars) max_chars="$2"; shift 2 ;;
    --include-thinking) include_thinking=1; shift ;;
    *) printf 'pi-session-tail: unknown arg: %s\n' "$1" >&2; exit 1 ;;
  esac
done

if ! [[ "$blocks" =~ ^[0-9]+$ && "$max_chars" =~ ^[0-9]+$ ]]; then
  printf 'pi-session-tail: --assistant-blocks / --max-chars は正の整数\n' >&2
  exit 1
fi

jsonl=""
if [[ -n "$agent" ]]; then
  out="$(herdr agent get "$agent" 2>/dev/null)" && {
    jsonl="$(printf '%s' "$out" | python3 -c 'import json,sys; d=json.load(sys.stdin); a=d.get("result",{}).get("agent") or d; print(a.get("agent_session",{}).get("value",""))')"
  }
fi
if [[ -z "$jsonl" && -n "$session_dir" ]]; then
  dir="${session_dir/#\~/$HOME}"
  jsonl="$(ls -t "$dir"/*.jsonl 2>/dev/null | head -1 || true)"
fi
if [[ -z "$jsonl" ]]; then
  printf 'pi-session-tail: session を解決できません（--agent は herdr で名前解決できる場合のみ。--session-dir DIR を指定）\n' >&2
  exit 1
fi
if [[ ! -f "$jsonl" ]]; then
  printf 'pi-session-tail: jsonl がありません: %s\n' "$jsonl" >&2
  exit 1
fi

python3 - "$jsonl" "$blocks" "$max_chars" "$include_thinking" <<'PY'
import json, sys

path, blocks, max_chars, include_thinking = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])

# assistant 塊 = 連続する assistant message レコードのまとまり（1 ターン）
blocks_out = []
cur = None
for line in open(path, encoding="utf-8", errors="replace"):
    line = line.strip()
    if not line:
        continue
    try:
        d = json.loads(line)
    except json.JSONDecodeError:
        continue
    if d.get("type") != "message":
        continue
    m = d.get("message") or {}
    if m.get("role") == "assistant":
        if cur is None:
            cur = []
        cur.append(m)
    elif cur is not None:
        blocks_out.append(cur)
        cur = None
if cur is not None:
    blocks_out.append(cur)

parts = []
for i, blk in enumerate(blocks_out[-blocks:], 1):
    lines = []
    for m in blk:
        content = m.get("content") or []
        if isinstance(content, str):
            content = [{"type": "text", "text": content}]
        for c in content:
            t = c.get("type")
            if t == "text":
                lines.append(c.get("text", ""))
            elif t == "toolCall":
                lines.append("[tool: %s]" % c.get("name", "?"))
            elif t == "thinking" and include_thinking:
                lines.append("[thinking] %s" % c.get("thinking", ""))
    text = "\n".join(x for x in lines if x)
    if text:
        parts.append("=== assistant %d/%d ===\n%s" % (i, min(len(blocks_out), blocks), text))

out = "\n\n".join(parts)
if len(out) > max_chars:
    out = "…[truncated %d chars]…\n" % (len(out) - max_chars) + out[-max_chars:]
print(out)
PY
