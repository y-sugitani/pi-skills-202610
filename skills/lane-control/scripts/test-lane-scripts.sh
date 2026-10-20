#!/usr/bin/env bash
# lane-control scripts（P1/P2）の fixture テスト。jq で JSON を検証する。
# 使い方: bash scripts/test-lane-scripts.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SECTION="$SCRIPT_DIR/lane-journal-section.sh"
FACTS="$SCRIPT_DIR/lane-facts.sh"
BOARD="$SCRIPT_DIR/lane-worktree-board.sh"
FIX="$SCRIPT_DIR/fixtures"

pass=0
fail=0

fail_test() {
  fail=$((fail + 1))
  echo "FAIL: $1"
}

assert_eq() {
  local desc="$1" actual="$2" expected="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass=$((pass + 1))
  else
    fail_test "$desc: expected [$expected] got [$actual]"
  fi
}

j() { printf '%s' "$1" | jq -r "$2"; }

# --- lane-journal-section.sh ---
out="$("$SECTION" --journal "$FIX/journal-in-progress.md" --label TEST-A)"
assert_eq "in-progress found" "$(j "$out" .found)" "yes"
assert_eq "in-progress heading" "$(j "$out" .heading)" "### Lane TEST-A — 進行中"
assert_eq "in-progress status_word" "$(j "$out" .status_word)" "進行中"
assert_eq "in-progress terminal" "$(j "$out" .terminal)" "false"
assert_eq "in-progress table_line" "$(j "$out" .table_line)" "| TEST-A | ビルド ok |"
assert_eq "in-progress body_path" "$(j "$out" .body_path)" ""

out="$("$SECTION" --journal "$FIX/journal-pass.md" --label TEST-B)"
assert_eq "pass found" "$(j "$out" .found)" "yes"
assert_eq "pass heading" "$(j "$out" .heading)" "### Lane TEST-B — 実装完了"
assert_eq "pass status_word" "$(j "$out" .status_word)" "PASS"
assert_eq "pass terminal" "$(j "$out" .terminal)" "true"
assert_eq "pass table_line" "$(j "$out" .table_line)" "| TEST-B | PASS |"

out="$("$SECTION" --journal "$FIX/journal-no-section.md" --label TEST-C)"
assert_eq "no-section found" "$(j "$out" .found)" "no"
assert_eq "no-section status_word" "$(j "$out" .status_word)" "missing"
assert_eq "no-section terminal" "$(j "$out" .terminal)" "false"
assert_eq "no-section heading" "$(j "$out" .heading)" ""

out="$("$SECTION" --journal "$FIX/journal-shared.md" --label OTHER-D)"
assert_eq "shared other found" "$(j "$out" .found)" "yes"
assert_eq "shared other status_word" "$(j "$out" .status_word)" "検証完了"
assert_eq "shared other terminal" "$(j "$out" .terminal)" "true"
out="$("$SECTION" --journal "$FIX/journal-shared.md" --label TEST-E)"
assert_eq "shared missing found" "$(j "$out" .found)" "no"
assert_eq "shared missing status_word" "$(j "$out" .status_word)" "missing"

# 長い body → body_path に tempfile
long_journal="$(mktemp)"
{
  echo "# 長い記録"
  echo
  echo "### Lane TEST-LONG — 進行中"
  echo
  for i in $(seq 1 80); do
    echo "- 項目 $i: 本文を長くするためのダミーテキストをここに並べる"
  done
} > "$long_journal"
out="$("$SECTION" --journal "$long_journal" --label TEST-LONG)"
assert_eq "long found" "$(j "$out" .found)" "yes"
assert_eq "long status_word" "$(j "$out" .status_word)" "進行中"
body_path="$(j "$out" .body_path)"
if [[ -n "$body_path" && -f "$body_path" ]]; then
  pass=$((pass + 1))
else
  fail_test "long body_path が tempfile を指す: [$body_path]"
fi
rm -f "$long_journal" "$body_path"

# 見出し検出緩和: label 部分一致で feat/<branch> 見出しも拾う（`## Lane feat/<branch>` 型）
branch_journal="$(mktemp)"
cat > "$branch_journal" <<'EOF'
# 記録

## Lane feat/admin-report-filter — merged

- 状態: **merge待ち**
EOF
out="$("$SECTION" --journal "$branch_journal" --label admin-report-filter)"
assert_eq "branch-heading label found" "$(j "$out" .found)" "yes"
assert_eq "branch-heading status_word" "$(j "$out" .status_word)" "merged"
assert_eq "branch-heading terminal" "$(j "$out" .terminal)" "true"
# label 不一致でも --branch 部分一致で拾う（`## feat/xxx` 型。Lane 接頭辞なし）
cat > "$branch_journal" <<'EOF'
# 記録

## feat/admin-id-links

status: merge待ち
EOF
out="$("$SECTION" --journal "$branch_journal" --label admin-id-links --branch feat/admin-id-links)"
assert_eq "branch-only found" "$(j "$out" .found)" "yes"
assert_eq "branch-only status_word" "$(j "$out" .status_word)" "merge待ち"
assert_eq "branch-only terminal" "$(j "$out" .terminal)" "true"
# label も branch も一致しない → no
out="$("$SECTION" --journal "$branch_journal" --label OTHER-X)"
assert_eq "branch-only other found" "$(j "$out" .found)" "no"
rm -f "$branch_journal"

# H1 `# Lane <label>`（レーンが書く形）も節にする
h1_journal="$(mktemp)"
cat > "$h1_journal" <<'EOF'
# Lane C — feat/settings-section-align

status: merge待ち
EOF
out="$("$SECTION" --journal "$h1_journal" --label "Lane C" --branch feat/settings-section-align)"
assert_eq "h1-lane found" "$(j "$out" .found)" "yes"
assert_eq "h1-lane status_word" "$(j "$out" .status_word)" "merge待ち"
assert_eq "h1-lane terminal" "$(j "$out" .terminal)" "true"
rm -f "$h1_journal"

# P5: 厳密一致（見出し内 `Lane <label>`）が部分一致節より優先される
strict_journal="$(mktemp)"
cat > "$strict_journal" <<'EOF'
### OS-FOLLOW 残件（検証完了）

- done

### Lane OS-FOLLOW — 進行中

- 実装中
EOF
out="$("$SECTION" --journal "$strict_journal" --label OS-FOLLOW)"
assert_eq "strict-priority heading" "$(j "$out" .heading)" "### Lane OS-FOLLOW — 進行中"
assert_eq "strict-priority status_word" "$(j "$out" .status_word)" "進行中"
assert_eq "strict-priority terminal" "$(j "$out" .terminal)" "false"
# P5: 見出し先頭 <branch>（厳密）が部分一致節より優先される
cat > "$strict_journal" <<'EOF'
### 残件: feat/admin-id-links（進行中）

- 作業中

## feat/admin-id-links

status: merge待ち
EOF
out="$("$SECTION" --journal "$strict_journal" --label admin-id-links --branch feat/admin-id-links)"
assert_eq "branch-strict heading" "$(j "$out" .heading)" "## feat/admin-id-links"
assert_eq "branch-strict status_word" "$(j "$out" .status_word)" "merge待ち"
assert_eq "branch-strict terminal" "$(j "$out" .terminal)" "true"
rm -f "$strict_journal"

# --- lane-facts.sh ---
tmp="$(mktemp -d)"
board_tmp="$(mktemp -d)"
trap 'rm -rf "$tmp" "$board_tmp"' EXIT
repo="$tmp/repo"
git init -q -b main "$repo"
git -C "$repo" config user.email test@example.com
git -C "$repo" config user.name test
echo base > "$repo/base.txt"
git -C "$repo" add .
git -C "$repo" commit -qm base
git -C "$repo" checkout -qb feat/test-a
echo 'LANE.md' > "$repo/LANE.md"   # 未コミット → dirty

# ahead0 + dirty LANE.md + in_progress → deny_in_progress
cp "$FIX/journal-in-progress.md" "$tmp/journal.md"
out="$("$FACTS" --worktree "$repo" --base main --journal "$tmp/journal.md" --label TEST-A)"
assert_eq "facts branch" "$(j "$out" .branch)" "feat/test-a"
assert_eq "facts ahead" "$(j "$out" .ahead)" "0"
assert_eq "facts dirty" "$(j "$out" .dirty)" "1"
assert_eq "facts dirty_names" "$(j "$out" .dirty_names)" "LANE.md"
assert_eq "facts journal" "$(j "$out" .journal)" "yes"
assert_eq "facts journal_status" "$(j "$out" .journal_status)" "in_progress"
assert_eq "facts status_word" "$(j "$out" .status_word)" "進行中"
assert_eq "facts suggest" "$(j "$out" .suggest)" "deny_in_progress"
assert_eq "facts tip" "$(j "$out" .tip)" "$(git -C "$repo" rev-parse --short HEAD)"

# terminal + ahead0 → merge_skip
cp "$FIX/journal-pass.md" "$tmp/journal.md"
out="$("$FACTS" --worktree "$repo" --base main --journal "$tmp/journal.md" --label TEST-B)"
assert_eq "facts terminal status" "$(j "$out" .journal_status)" "terminal"
assert_eq "facts terminal status_word" "$(j "$out" .status_word)" "PASS"
assert_eq "facts terminal suggest" "$(j "$out" .suggest)" "merge_skip"

# terminal + ahead1 → merge_candidate
git -C "$repo" add LANE.md
echo x > "$repo/x.txt"
git -C "$repo" add x.txt
git -C "$repo" commit -qm work
out="$("$FACTS" --worktree "$repo" --base main --journal "$tmp/journal.md" --label TEST-B)"
assert_eq "facts ahead1" "$(j "$out" .ahead)" "1"
assert_eq "facts clean dirty" "$(j "$out" .dirty)" "0"
assert_eq "facts candidate suggest" "$(j "$out" .suggest)" "merge_candidate"

# P0.c: 中止 + ahead1 → deny_terminal_no_merge（merge_candidate にしない）
cat > "$tmp/journal-abort.md" <<'EOF'
# 記録

### Lane TEST-ABORT — 中止

- 方針変更でやめた
EOF
out="$("$FACTS" --worktree "$repo" --base main --journal "$tmp/journal-abort.md" --label TEST-ABORT)"
assert_eq "facts abort status" "$(j "$out" .journal_status)" "terminal"
assert_eq "facts abort status_word" "$(j "$out" .status_word)" "中止"
assert_eq "facts abort suggest" "$(j "$out" .suggest)" "deny_terminal_no_merge"

# P0.c: FAIL-central + ahead1 → deny_terminal_no_merge
cat > "$tmp/journal-fail.md" <<'EOF'
# 記録

### Lane TEST-FAIL — 再証

- OS は FAIL-central。
EOF
out="$("$FACTS" --worktree "$repo" --base main --journal "$tmp/journal-fail.md" --label TEST-FAIL)"
assert_eq "facts fail status_word" "$(j "$out" .status_word)" "FAIL-central"
assert_eq "facts fail suggest" "$(j "$out" .suggest)" "deny_terminal_no_merge"

# FAIL-<module> 汎用形（例: FAIL-core）も終端・deny（読み互換）
cat > "$tmp/journal-fail-module.md" <<'EOF'
# 記録

### 依頼 TEST-MOD — 契約修復

- 契約は FAIL-core。
EOF
out="$("$FACTS" --worktree "$repo" --base main --journal "$tmp/journal-fail-module.md" --label TEST-MOD)"
assert_eq "facts fail-module status" "$(j "$out" .journal_status)" "terminal"
assert_eq "facts fail-module status_word" "$(j "$out" .status_word)" "FAIL-core"
assert_eq "facts fail-module suggest" "$(j "$out" .suggest)" "deny_terminal_no_merge"
sec_out="$("$SECTION" --journal "$tmp/journal-fail-module.md" --label TEST-MOD)"
assert_eq "section fail-module terminal" "$(j "$sec_out" .terminal)" "true"
assert_eq "section fail-module status_word" "$(j "$sec_out" .status_word)" "FAIL-core"

# P0.c: 延期 + ahead1 → deny_terminal_no_merge
cat > "$tmp/journal-post.md" <<'EOF'
# 記録

### Lane TEST-POST — 延期

- 後で再開
EOF
out="$("$FACTS" --worktree "$repo" --base main --journal "$tmp/journal-post.md" --label TEST-POST)"
assert_eq "facts post status_word" "$(j "$out" .status_word)" "延期"
assert_eq "facts post suggest" "$(j "$out" .suggest)" "deny_terminal_no_merge"

# P0.c: PASS + 差分なし/merge不要 + ahead1 → record_only
cat > "$tmp/journal-record.md" <<'EOF'
# 記録

### Lane TEST-REC — 検証完了

- PASS
- 差分なし → merge 不要
EOF
out="$("$FACTS" --worktree "$repo" --base main --journal "$tmp/journal-record.md" --label TEST-REC)"
assert_eq "facts record status_word" "$(j "$out" .status_word)" "検証完了"
assert_eq "facts record suggest" "$(j "$out" .suggest)" "record_only"

# 節なし → deny_no_journal
cp "$FIX/journal-no-section.md" "$tmp/journal.md"
out="$("$FACTS" --worktree "$repo" --base main --journal "$tmp/journal.md" --label TEST-C)"
assert_eq "facts missing status" "$(j "$out" .journal_status)" "missing"
assert_eq "facts missing suggest" "$(j "$out" .suggest)" "deny_no_journal"

# journal ファイル自体が無い → journal=no / deny_no_journal
out="$("$FACTS" --worktree "$repo" --base main --journal "$tmp/none.md" --label TEST-A)"
assert_eq "facts no-journal" "$(j "$out" .journal)" "no"
assert_eq "facts no-journal status" "$(j "$out" .journal_status)" "missing"
assert_eq "facts no-journal suggest" "$(j "$out" .suggest)" "deny_no_journal"

# result-glob
touch "$tmp/result-check.md"
out="$("$FACTS" --worktree "$repo" --base main --journal "$tmp/journal.md" --label TEST-C --result-glob "$tmp/result-*")"
assert_eq "facts result_files" "$(j "$out" .result_files)" "$tmp/result-check.md"

# merge待ち + ahead0 → merge_skip + note（矛盾。表に無いケース）
git -C "$repo" checkout -q main
git -C "$repo" branch -qD feat/test-a
git -C "$repo" checkout -qb feat/test-m
cat > "$tmp/journal-merge.md" <<'EOF'
# 記録

### Lane TEST-M — merge待ち

- merge 依頼済み
EOF
out="$("$FACTS" --worktree "$repo" --base main --journal "$tmp/journal-merge.md" --label TEST-M)"
assert_eq "facts mergewait status" "$(j "$out" .journal_status)" "terminal"
assert_eq "facts mergewait status_word" "$(j "$out" .status_word)" "merge待ち"
assert_eq "facts mergewait suggest" "$(j "$out" .suggest)" "merge_skip"
assert_eq "facts mergewait note" "$(j "$out" .note)" "merge待ち だが ahead=0 — 矛盾。merge 成果を確認（health.ts は needs_review）"

# 見出しが feat/<branch> のみ（label 不一致）でも branch 一致で terminal（lane-facts 経由）
git -C "$repo" checkout -q main
git -C "$repo" branch -qD feat/test-m
git -C "$repo" checkout -qb feat/test-bh
cat > "$tmp/journal-branch-heading.md" <<'EOF'
# 記録

## feat/test-bh

- 状態: merge待ち
EOF
out="$("$FACTS" --worktree "$repo" --base main --journal "$tmp/journal-branch-heading.md" --label zz-bh)"
assert_eq "facts branch-heading status" "$(j "$out" .journal_status)" "terminal"
assert_eq "facts branch-heading status_word" "$(j "$out" .status_word)" "merge待ち"

# --- lane-worktree-board.sh ---
# fixture: client / central の worktree 2 本（命名は `<repo>.<lane>` 準拠）
client_root="$board_tmp/client"
central_root="$board_tmp/central"
git init -q -b main "$client_root"
git -C "$client_root" config user.email test@example.com
git -C "$client_root" config user.name test
echo base > "$client_root/base.txt"
git -C "$client_root" add .
git -C "$client_root" commit -qm base
git -C "$client_root" worktree add -q -b feat/lane-a "$board_tmp/client.lane-a" main
echo a1 > "$board_tmp/client.lane-a/a1.txt"
git -C "$board_tmp/client.lane-a" add .
git -C "$board_tmp/client.lane-a" commit -qm a1
echo a2 > "$board_tmp/client.lane-a/a2.txt"
git -C "$board_tmp/client.lane-a" add .
git -C "$board_tmp/client.lane-a" commit -qm a2

git init -q -b main "$central_root"
git -C "$central_root" config user.email test@example.com
git -C "$central_root" config user.name test
echo base > "$central_root/base.txt"
git -C "$central_root" add .
git -C "$central_root" commit -qm base
git -C "$central_root" worktree add -q -b fix/lane-b "$board_tmp/central.lane-b" main
echo b1 > "$board_tmp/central.lane-b/b1.txt"
git -C "$board_tmp/central.lane-b" add .
git -C "$board_tmp/central.lane-b" commit -qm b1
echo dirty > "$board_tmp/central.lane-b/dirty.txt"   # 未コミット → dirty=1

# 共有 journal: lane-a は PASS（terminal）、lane-b は進行中
cat > "$board_tmp/journal.md" <<'EOF'
# 記録

### Lane lane-a — 実装完了

- PASS

| レーン | 結果 |
|---|---|
| lane-a | PASS |

### Lane lane-b — 進行中

- 作業中
EOF

md_col() { printf '%s' "$1" | awk -F'|' -v c="$2" '{print $c}' | sed -E 's/^[[:space:]]+|[[:space:]]+$//g'; }

out="$("$BOARD" \
  --spec client:lane-a:feat/lane-a \
  --spec central:lane-b:fix/lane-b \
  --root-client "$client_root" \
  --root-central "$central_root" \
  --journal "$board_tmp/journal.md")"
assert_eq "board header" "$(printf '%s\n' "$out" | sed -n 1p)" "| Lane | worktree | branch | ahead | dirty | tip | journal | status | suggest |"
row_a="$(printf '%s\n' "$out" | grep '^| lane-a ')"
assert_eq "board lane-a branch" "$(md_col "$row_a" 4)" "feat/lane-a"
assert_eq "board lane-a ahead" "$(md_col "$row_a" 5)" "2"
assert_eq "board lane-a dirty" "$(md_col "$row_a" 6)" "0"
assert_eq "board lane-a tip" "$(md_col "$row_a" 7)" "$(git -C "$board_tmp/client.lane-a" rev-parse --short HEAD)"
assert_eq "board lane-a journal" "$(md_col "$row_a" 8)" "terminal"
assert_eq "board lane-a status" "$(md_col "$row_a" 9)" "PASS"
assert_eq "board lane-a suggest" "$(md_col "$row_a" 10)" "merge_candidate"
row_b="$(printf '%s\n' "$out" | grep '^| lane-b ')"
assert_eq "board lane-b ahead" "$(md_col "$row_b" 5)" "1"
assert_eq "board lane-b dirty" "$(md_col "$row_b" 6)" "1"
assert_eq "board lane-b journal" "$(md_col "$row_b" 8)" "in_progress"
assert_eq "board lane-b status" "$(md_col "$row_b" 9)" "進行中"
assert_eq "board lane-b suggest" "$(md_col "$row_b" 10)" "deny_in_progress"

# TSV（journal 無し → inline git facts）
out="$("$BOARD" --spec client:lane-a:feat/lane-a --root-client "$client_root" --format tsv)"
assert_eq "board tsv header" "$(printf '%s\n' "$out" | sed -n 1p)" "label	worktree	branch	ahead	dirty	tip	journal	status	suggest"
row_a_tsv="$(printf '%s\n' "$out" | grep '^lane-a	')"
assert_eq "board tsv lane-a ahead" "$(printf '%s' "$row_a_tsv" | cut -f4)" "2"
assert_eq "board tsv lane-a journal" "$(printf '%s' "$row_a_tsv" | cut -f7)" "missing"

# worktree が無いレーン → 行は出るが git 列は —
out="$("$BOARD" --spec client:ghost:feat/ghost --root-client "$client_root")"
row_g="$(printf '%s\n' "$out" | grep '^| ghost ')"
assert_eq "board ghost ahead" "$(md_col "$row_g" 5)" "—"
assert_eq "board ghost journal" "$(md_col "$row_g" 8)" "missing"

# --lane 明示（journal 無し → inline git facts）
out="$("$BOARD" --lane "label=lane-a worktree=$board_tmp/client.lane-a base=main" --format tsv)"
row_l="$(printf '%s\n' "$out" | grep '^lane-a	')"
assert_eq "board lane-mode ahead" "$(printf '%s' "$row_l" | cut -f4)" "2"
assert_eq "board lane-mode journal" "$(printf '%s' "$row_l" | cut -f7)" "missing"

# root 未指定の repo key → exit 2
if "$BOARD" --spec client:lane-a:feat/lane-a >/dev/null 2>&1; then
  fail_test "board no-root は exit 2 になるべき"
else
  pass=$((pass + 1))
fi

echo
echo "pass=$pass fail=$fail"
[[ $fail -eq 0 ]]
