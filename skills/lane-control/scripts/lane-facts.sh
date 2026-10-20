#!/usr/bin/env bash
# lane-control: レーン completion 判定の facts 一式を JSON で出力する（P2 正本）。
# 内部で lane-journal-section.sh を呼ぶ。suggest 規則は lane-control skill の facts 表に従う
# （P0.c: status_word で分岐。中止/延期/FAIL-* は merge_candidate にしない）。
# 用法:
#   lane-facts.sh --worktree PATH --base REF --journal PATH --label LABEL [--result-glob GLOB]
# stdout JSON: worktree, branch, ahead, dirty, dirty_names, journal, journal_status,
#              status_word, tip, result_files, suggest
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SECTION="$SCRIPT_DIR/lane-journal-section.sh"

usage() {
  cat <<'EOF'
usage: lane-facts.sh --worktree PATH --base REF --journal PATH --label LABEL [--result-glob GLOB]
stdout JSON: worktree, branch, ahead, dirty, dirty_names, journal, journal_status,
             status_word, tip, result_files, suggest
EOF
}

worktree=""
base="main"
journal=""
label=""
result_glob=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --worktree)    worktree="$2"; shift 2 ;;
    --base)        base="$2"; shift 2 ;;
    --journal)     journal="$2"; shift 2 ;;
    --label)       label="$2"; shift 2 ;;
    --result-glob) result_glob="$2"; shift 2 ;;
    -h|--help)     usage; exit 0 ;;
    *) printf '{"ok":false,"error":"unknown_arg","arg":"%s"}\n' "$1" >&2; exit 2 ;;
  esac
done

[[ -n "$worktree" ]] || { echo "missing --worktree" >&2; exit 2; }
[[ -n "$journal" ]] || { echo "missing --journal" >&2; exit 2; }
[[ -n "$label" ]] || { echo "missing --label" >&2; exit 2; }

# --- git facts ---
branch=""
tip=""
ahead=""
dirty=0
dirty_names=""
if git -C "$worktree" rev-parse --git-dir >/dev/null 2>&1; then
  branch="$(git -C "$worktree" branch --show-current 2>/dev/null || true)"
  tip="$(git -C "$worktree" rev-parse --short HEAD 2>/dev/null || true)"
  ahead="$(git -C "$worktree" rev-list --count "$base..HEAD" 2>/dev/null \
        || git -C "$worktree" rev-list --count "origin/$base..HEAD" 2>/dev/null || true)"
  porcelain="$(git -C "$worktree" status --porcelain 2>/dev/null || true)"
  if [[ -n "$porcelain" ]]; then
    dirty=1
    dirty_names="$(printf '%s\n' "$porcelain" | sed -E 's/^.. //; s/.* -> //' | sort -u | head -20 | paste -sd, -)"
  fi
fi

# --- journal facts（lane-journal-section.sh を呼ぶ） ---
journal_present="no"
journal_status="missing"
status_word="missing"
no_merge="no"
if [[ -f "$journal" ]]; then
  journal_present="yes"
  section_json="$("$SECTION" --journal "$journal" --label "$label" --branch "$branch")"
  {
    IFS= read -r journal_status
    IFS= read -r status_word
    IFS= read -r no_merge
  } < <(printf '%s' "$section_json" | python3 -c '
import json, sys
d = json.load(sys.stdin)
if d["found"] == "no":
    print("missing")
    print(d["status_word"])
    print("no")
elif d["terminal"]:
    print("terminal")
    print(d["status_word"])
    print("yes" if d["no_merge"] else "no")
else:
    print("in_progress")
    print(d["status_word"])
    print("no")
')
fi

# --- result files ---
result_files=""
if [[ -n "$result_glob" ]]; then
  result_files="$(ls -1 $result_glob 2>/dev/null | paste -sd, - || true)"
fi

# --- suggest（lane-control skill の facts 表。P0.c: status_word で分岐） ---
suggest=""
case "$journal_status" in
  missing)     suggest="deny_no_journal" ;;
  in_progress) suggest="deny_in_progress" ;;
  terminal)
    case "$status_word" in
      中止|延期|FAIL-*)
        suggest="deny_terminal_no_merge"
        ;;
      merge待ち|merge\ 待ち)
        if [[ "$ahead" =~ ^[0-9]+$ ]] && (( ahead >= 1 )); then
          suggest="merge_candidate"
        else
          suggest="merge_skip"
        fi
        ;;
      *)
        if [[ "$no_merge" == "yes" ]]; then
          suggest="record_only"
        elif [[ "$ahead" =~ ^[0-9]+$ ]] && (( ahead >= 1 )); then
          suggest="merge_candidate"
        else
          suggest="merge_skip"
        fi
        ;;
    esac
    ;;
esac

# 表に無い矛盾（merge待ち + ahead=0）は suggest を変えず note で知らせる
note=""
if [[ "$journal_status" == "terminal" ]]; then
  if [[ -z "$ahead" ]]; then
    note="ahead 判定不能（git/base を確認）"
  elif [[ "$ahead" =~ ^[0-9]+$ ]] && (( ahead == 0 )) \
    && [[ "$status_word" == "merge待ち" || "$status_word" == "merge 待ち" ]]; then
    note="merge待ち だが ahead=0 — 矛盾。merge 成果を確認（health.ts は needs_review）"
  fi
fi

python3 - "$worktree" "$branch" "$ahead" "$dirty" "$dirty_names" "$journal_present" "$journal_status" "$status_word" "$tip" "$result_files" "$suggest" "$note" <<'PY'
import json
import sys

worktree, branch, ahead, dirty, dirty_names, journal, journal_status, status_word, tip, result_files, suggest, note = sys.argv[1:]
out = {
    "worktree": worktree,
    "branch": branch,
    "ahead": int(ahead) if ahead.isdigit() else None,
    "dirty": int(dirty),
    "dirty_names": dirty_names,
    "journal": journal,
    "journal_status": journal_status,
    "status_word": status_word,
    "tip": tip,
    "result_files": result_files,
    "suggest": suggest,
}
if note:
    out["note"] = note
print(json.dumps(out, ensure_ascii=False))
PY
