#!/usr/bin/env bash
# lane-control: 共有 journal から当該 label のレーン節を抽出し JSON で出力する（P1 正本）。
# 見出し検出・終端語彙は mux-pi/lane-supervisor/lib.ts と整合させる。
# 見出しは label または feat/<branch> の部分一致で拾う（`Lane <label>` 必須ではない）。
# 用法:
#   lane-journal-section.sh --journal PATH --label LABEL [--branch feat/xxx]
# stdout JSON: label, found(yes|no), heading, status_word, terminal(bool), table_line, body_path
set -euo pipefail

usage() {
  cat <<'EOF'
usage: lane-journal-section.sh --journal PATH --label LABEL [--branch feat/xxx]
stdout JSON: label, found(yes|no), heading, status_word, terminal(bool), table_line, body_path
EOF
}

journal=""
label=""
branch=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --journal) journal="$2"; shift 2 ;;
    --label)   label="$2"; shift 2 ;;
    --branch)  branch="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf '{"ok":false,"error":"unknown_arg","arg":"%s"}\n' "$1" >&2; exit 2 ;;
  esac
done

[[ -n "$journal" ]] || { echo "missing --journal" >&2; exit 2; }
[[ -n "$label" ]] || { echo "missing --label" >&2; exit 2; }
[[ -f "$journal" ]] || { echo "journal not found: $journal" >&2; exit 2; }

python3 - "$journal" "$label" "$branch" <<'PY'
import json
import os
import re
import sys
import tempfile

journal, label = sys.argv[1], sys.argv[2]
branch = sys.argv[3] if len(sys.argv) > 3 else ""
body = open(journal, encoding="utf-8").read()

# lib.ts extractJournalSection と同型（P5）: 先に厳密一致（見出し内 `Lane <label>` / 見出し先頭が <branch>）を試し、
# 落ちたときだけ label / branch の部分一致で拾う。`Lane <label>` の直後に識別子継続文字が無いこと
# （OS-FOLLOW が OS-FOLLOWING に釣られない）。
# H1 `# Lane <label>`（レーンが書く形）も拾う。label/branch が無いタイトル行は当たらない。
TAIL = r"[^\n]*(?:\n[\s\S]*?)?(?=\n#+\s|$)"
strict_patterns = [
    r"(^|\n)#{1,}[^\n]*?Lane\s+" + re.escape(label) + r"(?![-A-Za-z0-9_])" + TAIL,
]
if branch:
    strict_patterns.append(r"(^|\n)#{1,}\s*" + re.escape(branch) + TAIL)
m = None
for pat in strict_patterns:
    m = re.search(pat, body)
    if m:
        break
if m is None:
    alternatives = [re.escape(label)]
    if branch:
        alternatives.append(re.escape(branch))
    re_partial = re.compile(
        r"(^|\n)#{1,}\s*[^\n]*?(?:" + "|".join(alternatives) + r")[^\n]*(?:\n[\s\S]*?)?(?=\n#+\s|$)"
    )
    m = re_partial.search(body)
section = m.group(0) if m else None

# lib.ts JOURNAL_TERMINAL_WORDS と同型・同順序（fixtures も共有）。
# FAIL は FAIL-<module> が本則。汎用 FAIL-* は matched_terminal の regex フォールバックで拾う。
TERMINAL_WORDS = [
    "PASS",
    "merge待ち", "merge 待ち", "merge済", "merge 済", "merged",
    "検証完了", "中止", "延期",
    "merge不要", "merge 不要", "検証のみ", "調査のみ", "変更なし", "差分なし", "記録のみ",
]
NON_TERMINAL_WORDS = ["進行中", "修正中", "未達"]
# P0.c: merge 不要系の終端語彙。PASS・検証完了 と併せて record_only を導く（lib.ts JOURNAL_NO_MERGE_WORDS と同一）
NO_MERGE_WORDS = [
    "merge不要", "merge 不要", "差分なし", "変更なし",
    "検証のみ", "調査のみ", "記録のみ",
    "merge済", "merge 済", "merged",
]


def word_matches(word, text):
    # lib.ts と同じ: ASCII 語は単語境界、日本語混在は部分一致
    if word.isascii():
        return re.search(r"\b" + re.escape(word) + r"\b", text) is not None
    return word in text


def matched_terminal(text):
    for w in TERMINAL_WORDS:
        if word_matches(w, text):
            return w
    m = re.search(r"\bFAIL-[A-Za-z0-9_.\-]+", text)
    return m.group(0) if m else None


def frontmatter_status(text):
    if not text.startswith("---"):
        return None
    rest = text[3:]
    if rest.startswith("\n"):
        rest = rest[1:]
    m = re.search(r"\n---\s*(?:\n|$)", rest)
    if not m:
        return None
    for line in rest[:m.start()].splitlines():
        if line.startswith("status:"):
            raw = line.split(":", 1)[1].strip().strip("'\"")
            return raw or None
    return None


fm = frontmatter_status(body)
fm_term = matched_terminal(fm) if fm else None
if fm_term:
    print(json.dumps({
        "label": label,
        "found": "yes",
        "heading": "frontmatter status",
        "status_word": fm_term,
        "terminal": True,
        "table_line": "",
        "body_path": "",
        "no_merge": any(word_matches(w, fm_term) for w in NO_MERGE_WORDS),
    }, ensure_ascii=False))
    raise SystemExit(0)

if section is None:
    found, heading, terminal, status_word = "no", "", False, "missing"
else:
    found = "yes"
    # lib.ts は節先頭の \n を含めて split するため先頭以外の節で heading が空になる。
    # ここでは実 heading を使う（「見出しが最新状態の宣言」という意図どおり）。
    heading = section.lstrip("\n").split("\n", 1)[0]
    heading_term = matched_terminal(heading)
    if "進行中" in heading and heading_term is None:
        terminal, status_word = False, "進行中"
    elif heading_term is not None:
        terminal, status_word = True, heading_term
    else:
        section_term = matched_terminal(section)
        if section_term is not None:
            terminal, status_word = True, section_term
        else:
            terminal = False
            status_word = next((w for w in NON_TERMINAL_WORDS if w in section), "")

# 内訳表の該当行（label を含む | 始まりの行）。節が無くても表にあれば出す
table_line = ""
for line in body.splitlines():
    if line.strip().startswith("|") and label in line:
        table_line = line.strip()[:500]
        break

no_merge = section is not None and any(word_matches(w, section) for w in NO_MERGE_WORDS)

body_path = ""
if section is not None and len(section) > 2000:
    fd, body_path = tempfile.mkstemp(prefix="lane-journal-section-", suffix=".md")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(section)

print(json.dumps({
    "label": label,
    "found": found,
    "heading": heading,
    "status_word": status_word,
    "terminal": terminal,
    "table_line": table_line,
    "body_path": body_path,
    "no_merge": no_merge,
}, ensure_ascii=False))
PY
