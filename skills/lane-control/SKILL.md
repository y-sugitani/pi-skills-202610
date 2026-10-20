---
name: lane-control
description: >-
  progress（wiki 工事看板）を指定して司令塔が worktree + 子エージェントレーンを
  最大 N 並列で起動・監視・merge・撤収する。Use when user says レーン制御 /
  並列レーン / progress をレーンで / 司令塔 / lane control / worktree 並列で進め /
  最大Nレーン / 検証を並列.
---

# lane-control（progress 駆動レーン制御）

**Herdr 専用**。起動・監視・枠は Herdr のタブ/ペインと `lane_watch` が前提（`mux-pi` のスクリプトと `/start-lane` も Herdr を要求する）。
Herdr が無い環境ではレーン制御を使わない（`delegate-execute` の `subagent`（async）並列に落とす）。

**司令塔（親セッション）**が progress を正本に読み、スライスをレーンに割り、
**賢い子**を **別タブ/ウィンドウ + 専用 worktree** で走らせ、終わったら通知を受けて merge・撤収する。
作業中の子を定期的に覗かない。

| 層 | 担当 |
|---|---|
| **司令塔** | progress 分解 · 起動 · **完了通知への応答** · 判定 · **main merge** · worktree 撤収 · wiki 更新 |
| **レーン** | 担当スライスの主。実装/検証 · journal 結晶 · `merge待ち` まで。**main merge しない** |

起動・枠の開閉は **`mux-pi`**。本 skill は **運用プロトコル**。

---

## いつ使うか

- ユーザーが **progress パス**（例: `<vault 内>/global/progress/<工事名>`）を指して
  「レーンで進め」「並列で」「司令塔で」等と言ったとき
- 1 本の工事に独立スライスが 2 つ以上あり、worktree 並列が効くとき

**使わない**: 単発 tiny 修正 · 判断だけ · progress が無い雑談 · 安い子を監督しながら進める通常委譲

---

## 前提チェック（開始 30 秒）

1. **progress を読む**（**wiki**。無ければ中断）。無い・薄い → ユーザーに確認して中止
2. **いま** と **フェーズ**（`- [ ]` 能力行）を把握。袋フェーズは分解してから割当
3. リポジトリ root · git clean 気味 · プロジェクト AGENTS.md の有無
4. 並列上限: ユーザー指定があればそれ。無ければ **最大 4**（コスト・資源・CPU）

---

## 司令塔の責務（やること / やらない）

### やる

| 項目 | 内容 |
|---|---|
| スライス割当 | progress の未完能力を **独立単位**に切る（1 レーン = 1 能力 or 密結合の小束） |
| worktree | `git worktree add -b feat/<name> ../<repo>.<name> main`（プロジェクトに規約があればそれ） |
| 起動 | 各 worktree に `LANE.md` + 初回 prompt · **`mux-pi`**（`spawn-agent.sh`）で子エージェント |
| 通知待ち | **完了・異常のときだけ**起きる（起こし方は `lane_watch` の `LANE_EVENT`）。作業中の定期覗きはしない。`CHEAP_EVENT` を merge/撤収に使うな。`lane_watch` が使えないときだけ `lane-main` timer |
| merge | **司令塔のみ** main へ（rebase 衝突も司令塔 or 明示委譲） |
| 撤収 | merge 済 or 完了・ahead 0 の worktree/branch を remove |
| wiki | progress「いま」· フェーズ `[x]` · journal 記録を短く更新（要点の文章は残す。ログは削ってよい）· **merge/撤収の同一ターンで journal の status を閉じる** · ユーザー応答の最後に journal から要点を文章で伝える |

### やらない

- レーン作業を司令塔が高コスト model で丸ごと直実行（特に長時間の端末・エミュレータ操作）
- レーンに main merge / force push / 他レーン worktree 編集を許す
- progress に設計書・レーン常設表を肥大化させる（割当は一時 · 完了後クリア）
- 作業中の子を定期的に覗く
- **定期健康チェックを司令塔の高コスト model がやる**（`lane_watch` 拡張の仕組みに任せる。親は完了・異常だけ）
- レーン以外の agent を `lane_watch` / read / intervene する（完了の本線は journal / progress / git。`CHEAP_EVENT` は merge/撤収に使わない）

---

## 起動手順

### 1. スライス表を決める（progress に長く残さない）

司令塔の頭 or 一時メモ。progress に書くなら **いま** に 5 行以内。

| Lane | 能力（progress 行） | branch | worktree | 完了条件 |
|---|---|---|---|---|
| A | … | `feat/…` | `…` | 外から検証できる 1 文 |

**独立**: 共有ファイル競合が無い / または claim が短い。  
**依存**: 直列（先レーン merge 後に次を起動）。

### 2. worktree

プロジェクトの worktree 規約に従う。汎用:

```bash
cd /path/to/repo-main
git worktree add -b feat/<slice> ../repo.<slice> main
# セットアップスクリプトがあれば実行（例: ./scripts/setup-worktree.sh）
```

### 3. LANE.md（各 worktree ルート）

```markdown
# Lane <ID> — <能力名>

## 参照
- progress: <vault-relative path>
- journal: <あれば>
- skills: <必須 skill 名>

## 担当 / 完了条件
- …

## 環境
- worktree / branch
- 検証コマンド（ビルド・テスト・画面確認 等）

## 禁止
- main merge / push / 他 worktree 編集
- 担当外フェーズへの勝手な拡大
- 対岸リポジトリ編集 / 対岸の穴を自側 workaround で握ること

## 方針
- 完了 → journal 結晶 + progress を merge待ち（または検証記録）+ 資源（端末・エミュレータ等）は release
- 結晶の「何をしたか」は**文章**（wiki）。表だけ禁止。聞きたいことの例: 経緯、目的、実装の概要、データの流れ
- **完了の定義**: herdr/Pi が idle でも「完了」ではない。完了条件を journal 終端語彙で書くまで done と言うな
- journal は「進行中」と「終端（PASS/FAIL/merge待ち）」を区別せよ。進行中だけでは司令塔が completion と誤認する
```

### 4. 子エージェント起動

起動の仕方は **`mux-pi`**（Herdr 専用）。**tab/window**（`--layout tab`）。
スクリプトはパッケージ内の `skills/mux-pi/scripts/`（`pi install` したパッケージの下。install 先は `~/.pi/agent/` 配下）。

```bash
MUX=<package>/skills/mux-pi             # 自分の環境のパスに読み替える
TASK=/tmp/lane-control/task-<id>.md
bash "$MUX/scripts/spawn-agent.sh" \
  --task-file "$TASK" --workdir "/path/to/repo.<slice>" --title "<id>"
```

成功 JSON の `agent` / `tab_id` で:

```
lane_watch
  agent: <spawn の agent>
  kind: lane
  tab_id: <tab_id>
  worktree: <workdir>
  branch: <feat/...>
  label: <Lane ID>
  journal: <journal path があれば>
  safety_sec: 900
```

初回 prompt に必ず含める:

- progress / journal パス
- 完了条件 · 禁止（merge しない）
- 完了時の結晶「何をしたか」は**文章**（wiki。表だけ禁止）
- 資源（端末・エミュレータ・デバイスプール等）acquire/release
- 対岸疑い: 対岸リポジトリは編集するな。あるべき形でないと確定したら workaround 禁止（`FAIL-<module>`。例: `FAIL-central` / `FAIL-client`）。対岸監督起動は司令塔
- **偽 completion 抑止**:
  - herdr/Pi が idle でも「完了」ではない。完了条件を journal 終端語彙で書くまで done と言うな
  - journal は「進行中」と「終端（PASS/FAIL/merge待ち）」を区別せよ。進行中だけでは司令塔が completion と誤認する

**レーン起動直後:** 上の watch（`lane_watch kind=lane`）。`lane_watch` が使えないときだけ `lane-main` timer。

### 5. progress「いま」を短く更新

レーン稼働中だけ:

```markdown
| すぐ | 担当 |
| A | … 稼働 |
| B | … 稼働 |
```

完了・撤収後はレーン表を消すか「撤収済」1 行。**常設の大きなレーン表は作らない**。

---

## 監視ループ（親は完了・異常だけ）

司令塔は sleep しない。子をプロセス内 wait / sleep で監視しない。
**起こし方**は `lane_watch`（`LANE_EVENT`）。形式は `mux-pi`。`lane_watch` が使えないときだけ `lane-main` timer。
本 skill が固定するのは **司令塔の稼働条件**だけ:

| 司令塔が動くとき | やること |
|---|---|
| **完了**（merge 待ち・検証完了など） | merge/撤収判断 · wiki。添付 facts があればそれを優先。ユーザー応答の最後に、journal から何をやったかの要点を文章で書く（全文転記・ログ・手順の復唱はしない） |
| **異常**（早期 done · blocked · gone · ループ疑い） | レーンへ短い intervene 1 文 or 方針 |
| 定期の「まだ working」 | **動かない**（`lane_watch` が処理。親に来ても 1 行無視） |

| 環境 | 起こし方（詳細は `mux-pi`） |
|---|---|
| `lane_watch` 使用可（Herdr） | `lane_watch` のイベント監督（完了・異常だけ親へ） |
| `lane_watch` 不能（拡張未ロード等） | **timer のみ**（`lane-main`。長い間隔。反応は遅いがトークン優先。変化なしは 1 行） |

**lane_watch は `tab_id` を必ず渡す**（P3 の children_alive 抑止は tab 配下 agent list で判定する。`tab_id` 無しは fail-open で抑止されない）。

### トークン予算（司令塔監視 · 必須）

高コスト model の司令塔は **完了・異常以外で起動しない**。transcript 深読み禁止。早期 done も深読みにエスカレートするな。

| 入力 | 既定でやってよいこと | 禁止（既定） |
|---|---|---|
| 遅延 / 撤収済 / 担当外イベント | 1 行無視 | あらゆる tool |
| 完了 | 添付 facts · journal · ahead で merge/撤収。不足時だけ git 1 回 | jsonl 全読み · agent list 全件 · レーン以外の transcript |
| 異常 | レーンへ **intervene 1 文** or 方針 | 介入のたび jsonl 深読み |
| 定期健康（まだ working） | **来ない前提** / 来ても無視 | 親が短間隔 TIMER で status 表を常時作る |
| timer フォールバック（`lane_watch` 不能） | 全レーン status 表だけ · 変化なし 1 行 | レーン以外の agent 名・jsonl · 端末ログ深追い · 短間隔化 |

**深読み例外**（レーン本体の末尾 1〜3 assistant 塊だけ）:

- intervene を 2 回以上しても journal が付かない
- レーン本体 15 分ループ疑い（異常通知後も解消しない）
- merge 衝突など本文なしでは司令塔が判定不能

完了判定の本線は **journal 節 · progress · git ahead**（`lane_watch` が facts を付けていればそれを先に使う）。result ファイルを先に読むな。  
progress の内訳 ☐/☑ は journal 更新と **同一ターン** で同期。

### completion の facts 確認（P1: journal_status / P1.b: status_word・suggest）

LANE_EVENT completion を受けたら、添付 facts の `journal_status` → `status_word` → `suggest` の順に確認する（無ければ journal 節を読む）。
**completion/anomaly 時は `scripts/lane-facts.sh` を 1 回呼ぶ**（その場 Python / heredoc 禁止。facts があればそれを優先）。

| journal_status | 追加 facts | 司令塔の手 |
|---|---|---|
| `terminal` | `status_word=merge待ち` かつ `suggest=merge_candidate` | merge/撤収判断へ進む |
| `terminal` | `status_word` が `中止` / `FAIL-*` / `延期` | **merge しない**。記録・撤収 or 再開のみ（`suggest=deny_terminal_no_merge`） |
| `terminal` | `suggest=deny_*` または `merge_candidate` 以外 | **撤収のみ / 介入のみ**（merge しない） |
| `terminal` | 節の worktree/branch が watch と不一致 / `journal_stale=1` / `suggest` が stale 系 | **偽 completion（stale）**。否認・介入（merge しない） |
| `in_progress` | （「進行中」節のみ） | **親へ来ない**（拡張が nudge）。届いても merge/撤収しない。1 行無視 |
| `missing` / `unknown` | `journal_body_merge_pending=1` かつ ahead≥1 → `verdict=merge_pending_no_heading` | **親へ来ない**（拡張が nudge。N=3 再 spawn 対象外）。届いても見出し修正のみ（label または feat/<branch>） |

**P1.b 一文**: `journal_status=terminal` でも `status_word` が `中止|FAIL-*|延期` なら merge するな。`suggest=deny_*` または `merge_candidate` 以外は撤収のみ/介入のみ。節の worktree/branch が watch と不一致なら偽 completion（stale）。

### 偽 completion / 異常ループの N 回切替（P5）

同一レーンの偽 completion / 異常が繰り返すとき、intervene を無限に繰り返さない。N 回で切替:

| N | 司令塔の手 |
|---|---|
| 2 | 深読み例外 1 回（レーン親の末尾 1〜3 assistant 塊）+ force intervene（message-file で完了条件再掲） |
| 3 | **同一 task で再 spawn**（旧 tab は unwatch → close。worktree は維持） |
| 5 | レーン統合 or task 縮小（例: 「親が最後まで」）。**無限 intervene 禁止** |

**N の数え方**: 親が見た `LANE_EVENT` だけ。通告は journal 終端（frontmatter `status:` 先。idle 再読は拡張）。非終端のまま 5 分で anomaly 1 回。

**N 対象外（カウントしない）**: `verdict=merge_pending_no_heading`（ahead≥1 かつ本文に merge待ち があるのに見出し欠落）は N=3 再 spawn の N に数えない。
成果（コミット＋merge待ち）はあるので、指示は「見出しを label または feat/<branch> で立て直す」のみ。再 spawn / task 切替しない。

**複数 worktree 俯瞰（handoff・状況報告）は `scripts/lane-worktree-board.sh`**（git status 連打・その場 Python 禁止）

### 司令塔の点検（レーンまで）

**完了・異常の合図のときだけ。** 不足時・`lane_watch` 不能 timer 時に下表。

| 点検 | 内容 |
|---|---|
| レーン status | idle / done / working（`mux-pi` status） |
| worktree | `git status` / ahead（facts があれば優先） |
| progress / journal | 完了時の結晶確認 · 「いま」 |
| 資源 | lease（端末・エミュレータ・デバイスプール等）の有無（スロット表だけ。端末ログを深追いしない） |

- 未完なら撤収しない。異常なら **レーン本体へ** 短い intervene 1 件だけ
- レーン以外の agent には触れない
- レーン配下に他 agent がいる間、レーン settled でも LANE_EVENT は来ない（Herdr の tab 配下 agent list で判定。anomaly にもしない）。親は動かなくてよい

### 合図のとき司令塔がやること（例）

1. 担当外・遅延・撤収済 → 終了（1 行）
2. 完了 → facts/journal/ahead で merge/撤収判断。ユーザー応答の**最後**に、journal から何をやったかの要点を文章で書く（全文転記・ログ・手順の復唱はしない。transcript は読まない）
3. 異常 → 下表の手（intervene 1 文が中心）
4. 定期の healthy は親の仕事ではない

| 兆候 | 司令塔の手 |
|---|---|
| `merge待ち` · ビルド green · ahead ≥1 | rebase main → 衝突解消 → **merge --no-ff** → 撤収判断 |
| rebase `UU` でレーン停滞 | 司令塔が衝突解消 or レーンへ「rebase 最優先」 |
| 資源の DEAD / TTL 切れ | `release` · レーンに再 acquire 指示 |
| レーン本体の同一操作 15 分ループ | `mux-pi/scripts/intervene.sh --agent … --message …`（default force が esc 含む）で割り込み → 記録して次 or 停止 |
| スクショ判定待ち | レーン側が自分で画像を判定する（司令塔は画像を読まない）。必要ならレーンへ intervene 1 文 |
| FAIL-<module>（例: FAIL-central / FAIL-client） | 自レーンは workaround を捨てて終端。**`peer_supervisor` で対岸監督へ渡す**（自レーン化しない）。PEER_EVENT の `next=` で再開/停止。対岸タブは閉じない |
| レーン配下に他 agent がいる | **LANE_EVENT は来ない**（tab 配下 agent list で判定。anomaly にもしない）。親は動かない |
| レーン完了 · ahead 0 · 配下に他 agent なし | `lane_unwatch` → 枠を閉じる → worktree remove · branch -d · progress 更新 |

**割り込みメッセージ**は短く 1 件ずつ。割り込みは **`mux-pi`**（`mux-pi/scripts/intervene.sh --agent … --message …`（force+ack 正本）。**生 pane/tmux テキスト送信禁止**。15 分ループの「Escape 割り込み」も intervene.sh が default force で esc を含む）。

### 対岸ブロッカー（`FAIL-<module>`。例: `FAIL-central` / `FAIL-client`）

自レーンは対岸リポジトリを編集しない。対岸が **あるべき形でない** と確定したら、自側 workaround で能力を満たすな。ブロッカーに昇格する。

**昇格する**

- 契約（HTTP / GQL / SSE / schema）または自側と同等の能力が対岸に無い／壊れている
- 受信検証で欠落層が対岸と確定した
- 自側で直すと CQRS・仮表示・独断組み立て（URL 捏造等）に触る

**昇格しない**

- まだ「かも」
- 自側契約の穴（書き忘れ・未配線・Local 正本の未更新）

**昇格したあと**

- 自レーンは workaround を捨て、journal を `FAIL-<module>`（例: `FAIL-central` / `FAIL-client`）で終端（その差分は merge しない）
- 司令塔はユーザー依頼待ちにせず、**対岸監督を起動し自レーン化しない**:
  1. **`peer_supervisor open_journal`** で依頼 journal の枠を作り、中身（何を / どこを / 完了条件）と対岸 progress 1 行を書く（`wiki` の「依頼 journal」）
  2. **`peer_supervisor ensure`**（`repo`=対岸 repo 名＝tab ラベル、`workdir`=対岸 main、`journal` / `label`）。既存監督は奪わず intervene。無ければ spawn。**kind=peer の watch までツールがやる**
  3. 対岸レーンを `lane_watch` するな。merge/撤収も対岸側
- **PEER_EVENT**（依頼 journal 終端。completion の peer watch は extension が外す。対岸タブは閉じない）:
  | `next=` | 依頼元の手 |
  |---|---|
  | `resume_verify` | FAIL レーンは merge しない。受信検証を空き枠の**新レーン**。progress「いま」更新。応答末尾に要点 |
  | `deny_no_workaround` | workaround 禁止。次 module なら新規依頼。でなければユーザーへ |
  | `stop` | 受信検証しない。progress にポインタ |
  | `inspect_journal` | 終端語彙を確認して上へ |
- 元レーンを revive しない（FAIL 終端済み）。検証は新しいスライス

---

## merge · 撤収

### merge（司令塔 · main 作業ツリー）

```bash
cd /path/to/repo-main
git status -sb
# レーン tip を確認
git log --oneline main..<branch>
git merge --no-ff <branch> -m "Merge branch '<branch>'"
# 必要ならプロジェクトの検証コマンドで main 側確認（ビルド・テスト等）
```

- 検証専用で **コード差分なし** → merge 不要 · 記録だけ progress/journal
- **merge 後（または検証完了/中止判断後）は同一ターンで当該 journal の status を閉じる**（`merged` / `検証完了` / `中止` / `延期`。語彙は `wiki`）
- 衝突は main 側機能を残しつつレーン変更を統合（両取り）

### 撤収

この順（逆や「止まってよい」を先に送ると、閉じたあとに遅延 `LANE_EVENT reason=resumed` が来る）:

1. `lane_unwatch`（先）
2. レーンへ終了 prompt は送らない（close で十分）
3. `mux-pi` で枠を閉じる（司令塔枠は残す）
4. worktree / branch を消す

```bash
# 4. のだけ
git worktree remove ../repo.<slice> --force   # または先に clean
git branch -d feat/<slice>                    # 未 merge で捨てるなら -D + 確認
git worktree prune
```

ahead 0 · 未追跡は `LANE.md` のみ、が理想。撤収後の `LANE_EVENT` は無視（再起動しない）。

---

## progress / journal の書き方（wiki と整合）

- **progress**: 能力 1 行フェーズ。レーン表は常設しない。完了は `[x]` + いま更新
- **journal**: レーンの計画・結晶・資源と検証の記録表。結晶の「何をしたか」は**文章**（wiki。表だけ禁止）。司令塔は判定結果を短く patch する（要点の文章は残す。ログは削ってよい）。**merge/撤収の同一ターンで status を閉じる**（語彙: `進行中 | merge待ち | merged | 検証完了 | 中止 | 延期`。結晶 3 点と status の対応は `wiki`）
- 検証で開いた穴は **本線の能力行に分解**して先頭付近へ（袋の「残」にしない）

詳細は **`wiki`** スキル。

---

## プロジェクト接続（読む側が埋める）

| 項目 | 値 |
|---|---|
| progress パス | `<vault>/global/progress/<工事名>` または `<vault>/<module>/progress/<工事名>` |
| worktree | `git worktree add -b feat/<name> ../<repo>.<name> main`（規約があればそれ） |
| 資源 | 端末・エミュレータ・デバイスプール等の acquire/release 手順（あれば） |
| 検証 | プロジェクトのビルド・テスト・画面確認コマンド |
| wiki | `wiki`（vault は AGENTS.md の `## Wiki` 節で宣言） |
| 対岸ブロッカー | あるべき形でないと確定 → `FAIL-<module>` · **対岸監督を起動し自レーン化しない**（下節） |

読む側は worktree 命名・検証コマンド・資源手順を差し替える。

---

## 初回 prompt テンプレ

```text
LANE.md を読んで Lane <ID> を開始せよ。
progress: <path>
journal: <path or なし>
担当能力: <progress の1行>
完了条件: <外から検証できる文>
skills: <必須>
禁止: main merge / push / 他 worktree 編集 / 担当外の勝手な拡大
資源: <端末・エミュレータ等> 使用後は必ず release。
対岸疑い: 受信検証まで。対岸リポジトリは編集するな。あるべき形でないと確定したら workaround で握らず FAIL-<module>（例: FAIL-central / FAIL-client）。対岸監督起動は司令塔（依頼 journal + 対岸 progress → kind=peer。自レーン化しない）。
完了時: journal 結晶（「何をしたか」は文章。表だけ禁止。wiki）+ progress 更新（merge待ち or 検証記録）+ 資源 release。
完了の定義: herdr/Pi が idle でも「完了」ではない。完了条件を journal 終端語彙で書くまで done と言うな。
          journal は「進行中」と「終端（PASS/FAIL/merge待ち）」を区別せよ。進行中だけでは司令塔が completion と誤認する。
自立的に完了まで進めて。
```

---

## 司令塔の自己チェック

- [ ] progress の未完がレーンまたは「次」に落ちている
- [ ] 同時レーン ≤ 上限
- [ ] 各レーンに LANE.md と禁止事項
- [ ] merge は司令塔のみ · 検証後
- [ ] **merge 後（または検証完了/中止判断後）に当該 journal の status を閉じた**（`merged` / `検証完了` / `中止` / `延期`）
- [ ] **journal 冒頭の status と結晶が矛盾していない**（結晶を正として status を直す）
- [ ] 結晶の「何をしたか」が文章である（表だけではない）
- [ ] 完了・merge のユーザー応答末尾に、journal から何をやったかの要点を文章で書いた（全文転記ではない）
- [ ] **progress の `[x]` は merge 済（または検証完了/中止）と一致する**
- [ ] 完了 worktree を撤収した
- [ ] progress のレーン表をクリア / 最小化
- [ ] 資源（端末・エミュレータ等）の lease が残っていない
- [ ] レーン以外の agent を read / intervene / status 追い・lane_watch していない
- [ ] timer を停止した（`timer_stop`） / `lane_unwatch` した

---

## 関連

| skill | 役割 |
|---|---|
| `/start-lane` | 司令塔開始（Pi extension。Herdr タブを repo 名に改名。プロンプト正本は `skills/lane-control/prompts/start-lane.md`） |
| `peer_supervisor` | 対岸監督 lookup / 依頼 journal 枠 / ensure（intervene または spawn + kind=peer watch） |
| `mux-pi` | 子エージェント起動・status・割り込み・枠のクローズ（+ `lane_watch`） |
| `delegate-execute` | 委譲方針と起動・予算（timer）。レーン点検は `lane_watch` が使えないときのフォールバック |
| `wiki` | progress / journal の書き方・vault 接続 |
