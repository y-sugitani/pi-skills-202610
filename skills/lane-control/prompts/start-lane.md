---
description: 自 repo の progress を正本に worktree + 子エージェントレーンを並列で起動・監視・merge・撤収する司令塔運用を開始する（Herdr 専用・既定 4）。任意でメモ指定
argument-hint: "[メモ]"
---

# /start-lane — 自 repo レーン制御の開始

あなたは司令塔（親セッション）として、現在のリポジトリの工事を progress 正本からスライスし、worktree + 子エージェントレーンで並列実行する。**`lane-control` スキルを正本に従うこと**。以下は要約であり、詳細・例外は skill 正本が優先する。

**Herdr 専用**。Herdr 外では起動も監視も成り立たない（`delegate-execute` の `subagent`（async）並列に落とす）。

## 前提・正本

- **対象 repo / progress の特定（この順で解決）**
  1. **cwd を起点**に `git rev-parse --show-toplevel` でリポジトリ root を特定
  2. root が worktree の場合は `git worktree list` で **main を特定**し、そこを統合・merge 先にする
  3. root 直下の **AGENTS.md の `## Wiki` 節** から **vault 名とパス**を特定（`wiki` スキル）
  4. vault から当該 repo の **module progress** を読む（無い・薄い場合は中断してユーザーに確認）
- **スキル**: `lane-control`（運用プロトコル）・`mux-pi`（起動・status・割り込み・close）・`delegate-execute`（レーン内の安委譲方針と timer）・`wiki`（progress / journal / vault 接続）・`review`（回収）。worktree 規約・検証コマンドはプロジェクトの AGENTS.md に従う
- **引数**: 自由文のメモ。並列数の指定・開始判断・スライス割当に反映する

## 並列数

- メモに並列数（「2」「並列 3」等）があればそれを優先。無指定なら 4
- skill 上限（4）を超える明示はユーザーに確認
- メモの残りは開始判断・スライス割当に反映する

## 開始手順（要約）

1. **progress を読む**（wiki）: 「いま」と未完フェーズを把握。袋フェーズは分解してから割当
2. **スライス表を決める**: 未完能力を独立単位に切る（1 レーン = 1 能力 or 密結合の小束）。共有ファイル競合が無い / claim が短いものだけ並列。依存は直列（先レーン merge 後に次を起動）
3. **worktree 作成**（プロジェクト規約に従う。汎用: `git worktree add -b feat/<name> ../<repo>.<name> main`。setup スクリプトがあれば実行）
4. **LANE.md** を各 worktree ルートに書く（参照・担当/完了条件・環境・禁止・方針）
5. **mux-pi で子エージェント起動**: `scripts/spawn-agent.sh --task-file … --workdir … --title <Lane ID>`（`--layout tab`）。初回 prompt に progress / journal パス・完了条件・禁止（merge しない）・delegate-execute 方針・資源・**偽 completion 抑止**を必ず含める
6. **監視開始**: 起動直後に `lane_watch`（kind: lane・safety_sec 900・**tab_id 必須**）。5 分健康点検は lane_watch 拡張内。`lane_watch` が使えないときだけ `lane-main` timer フォールバック
7. **progress「いま」** にレーン表を短く追記（稼働中のみ。常設の大きなレーン表は作らない）

## 司令塔の責務

- 割当・起動・**LANE_EVENT 監視**・merge（main へ `--no-ff`、衝突解消も司令塔）・撤収（`lane_unwatch` → `close.sh` → worktree remove → branch -d）・progress / journal 更新
- **レーン作業の丸投げ直実行はしない**（長時間操作を司令塔が高コスト model で直実行しない。レーン / executor へ）
- レーンは作業中に覗かない。孫（explore/executor）は監督しない（孫の主はレーンのみ）
- 遅延 `LANE_EVENT`（未 watch / 撤収済）は即無視。`CHEAP_EVENT` を merge/撤収に使わない

## 監督中の追加報告・回収依頼

ユーザーが監督中に **不具合報告・回収依頼・デバッグ追記** を渡したら、すぐレーン化せず、先に着手できる形にする。intake は司令塔の仕事。

1. **journal に書き留める**（対象 module）。何を・どこを・どうなれば完了。薄いなら計画 1 行でよい
2. **目安最大 5 分だけ調査**して分かった分を同じ journal に足す。経路・再現・既存フェーズとの重複。設計を厚くするな
3. 5 分で切れない・分からないことは **「着手時に判断」** と 1 行残して打ち切る。曖昧（優先・範囲・再現不足）なら **ユーザーに聞く**。推測で progress を肥大化させない
4. **progress に 1 行追記**してから順次着手（空き枠・独立スライスのみ。依存は直列）
   - **既定**: 着手待ちの **末尾**（既存より後）
   - ユーザーが「前に」「優先」「今すぐ」等と言ったら **先頭**（高優先）
5. 既存レーンとファイルが重なるなら待たせる。progress に設計書を書くな

## 対岸ブロッカー時の扱い

正本は `lane-control` の **対岸ブロッカー**。要約:

- **env**: 司令塔がレーンを割り当ててよい
- **あるべき形でないと確定**（契約欠落・受信検証で対岸・workaround が CQRS/仮表示に触る）: 自レーンは workaround を捨て `FAIL-<module>` （例: `FAIL-central` / `FAIL-client`）で終端。その差分は merge しない
- **対岸は自分でレーン化しない。`peer_supervisor` で渡す**:
  1. `open_journal` で枠を作り、中身と対岸 progress 1 行を書く
  2. `ensure`（`repo`=対岸 repo 名、`workdir`、`journal`、`label`）。既存は intervene、無ければ spawn。watch までツールがやる
- 対岸レーンを `lane_watch` するな。対岸タブは閉じるな
- **PEER_EVENT の `next=`**: `resume_verify` → 受信検証の新レーン / `deny_no_workaround` → workaround 禁止 / `stop` → 検証しない / `inspect_journal` → 語彙確認。元 FAIL レーンは revive しない
- **昇格しない**: 「かも」、自側契約の穴（書き忘れ・未配線）

## 禁止

- レーンに main merge / push / 他 worktree 編集を許さない
- progress に設計書・常設レーン表を肥大化させない（完了後クリア）
- 本コマンドの目的外のファイル・コマンド改変
