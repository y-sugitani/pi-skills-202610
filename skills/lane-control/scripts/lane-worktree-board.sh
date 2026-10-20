#!/usr/bin/env bash
# lane-control: 複数 worktree 横断の ahead 表を markdown/TSV で出力する（P5 正本）。
# 各レーンで lane-facts.sh を呼ぶ（journal が無ければ同等の git facts を直接計算）。
# その場 Python / git status 連打の代替。仕様は lane-control skill の点検節。
# 用法:
#   lane-worktree-board.sh --spec REPO:LABEL:BRANCH [--spec ...] \
#     [--root-client PATH] [--root-central PATH] [--root KEY=PATH] \
#     [--journal PATH] [--base REF] [--format markdown|tsv]
#   --spec の worktree は root の同階層 `<basename(root)>.<label>` に解決する
#   （`<repo>.<label>` の命名規則）。派生できないときは --lane で明示:
#     --lane 'label=.. worktree=.. [journal=..] [base=..]'
#   JSONL/TSV 入力（- は stdin）: --jsonl FILE | --tsv FILE
#     jsonl: {"label":..,"worktree":..,"journal":..,"base":..}
#     tsv:   label<TAB>worktree[<TAB>journal[<TAB>base]]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FACTS="$SCRIPT_DIR/lane-facts.sh"

usage() {
  cat <<'EOF'
usage: lane-worktree-board.sh --spec REPO:LABEL:BRANCH [--spec ...]
       [--root-client PATH] [--root-central PATH] [--root KEY=PATH]
       [--journal PATH] [--base REF] [--format markdown|tsv]
       [--lane 'label=.. worktree=.. [journal=..] [base=..]'] [--jsonl FILE|-] [--tsv FILE|-]
stdout: markdown table（default）または TSV。列: label, worktree, branch, ahead, dirty, tip, journal, status, suggest
EOF
}

specs=()
lanes=()
jsonl=""
tsv=""
format="markdown"
journal=""
base="main"
roots=()   # key=path の配列（bash 3 互換のため連想配列にしない）

while [[ $# -gt 0 ]]; do
  case "$1" in
    --spec)         specs+=("$2"); shift 2 ;;
    --lane)         lanes+=("$2"); shift 2 ;;
    --jsonl)        jsonl="$2"; shift 2 ;;
    --tsv)          tsv="$2"; shift 2 ;;
    --root-client)  roots+=("client=$2"); shift 2 ;;
    --root-central) roots+=("central=$2"); shift 2 ;;
    --root)         roots+=("$2"); shift 2 ;;
    --journal)      journal="$2"; shift 2 ;;
    --base)         base="$2"; shift 2 ;;
    --format)       format="$2"; shift 2 ;;
    -h|--help)      usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ "$format" == "markdown" || "$format" == "tsv" ]] || { echo "bad --format: $format (markdown|tsv)" >&2; exit 2; }
if [[ ${#specs[@]} -eq 0 && ${#lanes[@]} -eq 0 && -z "$jsonl" && -z "$tsv" ]]; then
  echo "no lanes given" >&2; usage >&2; exit 2
fi

root_for() {  # repo key → root path（無ければ exit 1）
  local key="$1" kv
  for kv in "${roots[@]}"; do
    if [[ "${kv%%=*}" == "$key" ]]; then
      echo "${kv#*=}"
      return 0
    fi
  done
  return 1
}

# レーン一覧を TSV（label, worktree, journal, base）で一時ファイルに集める
lanes_tsv="$(mktemp)"
trap 'rm -f "$lanes_tsv"' EXIT

for spec in "${specs[@]}"; do
  repo="${spec%%:*}"
  rest="${spec#*:}"
  label="${rest%%:*}"
  branch="${rest#*:}"
  if [[ -z "$label" || -z "$branch" ]]; then
    echo "bad --spec: $spec (REPO:LABEL:BRANCH)" >&2
    exit 2
  fi
  root="$(root_for "$repo" || true)"
  if [[ -z "$root" ]]; then
    echo "no root for repo '$repo' (--root-$repo or --root $repo=PATH)" >&2
    exit 2
  fi
  wt="$(dirname "$root")/$(basename "$root").$label"
  printf '%s\x1f%s\x1f%s\x1f%s\n' "$label" "$wt" "$journal" "$base" >> "$lanes_tsv"
done

for lane in "${lanes[@]}"; do
  label=""; wt=""; j=""; b=""
  for kv in $lane; do
    case "$kv" in
      label=*)    label="${kv#label=}" ;;
      worktree=*) wt="${kv#worktree=}" ;;
      journal=*)  j="${kv#journal=}" ;;
      base=*)     b="${kv#base=}" ;;
      *) echo "bad --lane key: $kv" >&2; exit 2 ;;
    esac
  done
  if [[ -z "$label" || -z "$wt" ]]; then
    echo "bad --lane: $lane (label=.. worktree=..)" >&2
    exit 2
  fi
  printf '%s\x1f%s\x1f%s\x1f%s\n' "$label" "$wt" "${j:-$journal}" "${b:-$base}" >> "$lanes_tsv"
done

if [[ -n "$jsonl" ]]; then
  cat "${jsonl:--}" | python3 -c '
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    d = json.loads(line)
    print("\x1f".join([d.get("label", ""), d.get("worktree", ""), d.get("journal", ""), d.get("base", "")]))
' >> "$lanes_tsv"
fi
if [[ -n "$tsv" ]]; then
  cat "${tsv:--}" | sed 's/\t/\x1f/g' >> "$lanes_tsv"
fi

# 1 レーンの facts（lane-facts.sh を呼ぶ。journal が無ければ同等の git facts）
row_facts() {
  local label="$1" wt="$2" j="$3" b="$4"
  if [[ -n "$j" ]]; then
    "$FACTS" --worktree "$wt" --base "$b" --journal "$j" --label "$label" | python3 -c '
import json, sys
d = json.load(sys.stdin)
print(d.get("branch") or "")
print(d.get("ahead") if d.get("ahead") is not None else "")
print(d.get("dirty", 0))
print(d.get("tip") or "")
print(d.get("journal_status") or "missing")
print(d.get("status_word") or "missing")
print(d.get("suggest") or "")
'
  else
    local branch="" tip="" ahead="" dirty=0
    if git -C "$wt" rev-parse --git-dir >/dev/null 2>&1; then
      branch="$(git -C "$wt" branch --show-current 2>/dev/null || true)"
      tip="$(git -C "$wt" rev-parse --short HEAD 2>/dev/null || true)"
      ahead="$(git -C "$wt" rev-list --count "$b..HEAD" 2>/dev/null \
            || git -C "$wt" rev-list --count "origin/$b..HEAD" 2>/dev/null || true)"
      porcelain="$(git -C "$wt" status --porcelain 2>/dev/null || true)"
      [[ -n "$porcelain" ]] && dirty=1
    fi
    printf '%s\n%s\n%s\n%s\n%s\n%s\n%s\n' "$branch" "$ahead" "$dirty" "$tip" "missing" "missing" ""
  fi
}

if [[ "$format" == "markdown" ]]; then
  printf '| Lane | worktree | branch | ahead | dirty | tip | journal | status | suggest |\n'
  printf '|---|---|---|---|---|---|---|---|---|\n'
else
  printf 'label\tworktree\tbranch\tahead\tdirty\ttip\tjournal\tstatus\tsuggest\n'
fi

while IFS=$'\x1f' read -r label wt j b; do
  [[ -n "$label" ]] || continue
  {
    IFS= read -r branch
    IFS= read -r ahead
    IFS= read -r dirty
    IFS= read -r tip
    IFS= read -r jstatus
    IFS= read -r sword
    IFS= read -r suggest
  } < <(row_facts "$label" "$wt" "$j" "$b")
  if [[ "$format" == "markdown" ]]; then
    printf '| %s | %s | %s | %s | %s | %s | %s | %s | %s |\n' \
      "$label" "${wt:-—}" "${branch:-—}" "${ahead:-—}" "${dirty:-—}" "${tip:-—}" \
      "${jstatus:-—}" "${sword:-—}" "${suggest:-—}"
  else
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$label" "$wt" "$branch" "$ahead" "$dirty" "$tip" "$jstatus" "$sword" "$suggest"
  fi
done < "$lanes_tsv"
