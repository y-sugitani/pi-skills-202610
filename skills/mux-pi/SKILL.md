---
name: mux-pi
description: >-
  Pi 用。Herdr を検出してペイン・タブ・子 pi を開く。
  Use when mux / herdr / HERDR_ENV / ペイン / split / 子 pi。
  Herdr が無い環境では abort し、subagent（async）で代用する。
---

# mux-pi

端末マルチプレクサ **Herdr** の検出とルーティング（Herdr 専用）。
呼び出し（tab か pane か、watch の kind）は呼び出し元。

スクリプトはこの skill からの相対 `scripts/` にある（拡張もパッケージ内の同じ場所を指す）。

## 使い方（要点）

- **常に先に `scripts/detect.sh`** を実行し、backend を確認する
- backend に従い **herdr の CLI / 本 skill のスクリプト** を使う
- backend=none（Herdr 外）→ 委譲は **`subagent` を `async: true`** で使う。本 skill のスクリプトは
  `no_mux_available` を返す（pane が無いので当然。無理に使わない）
- backend=none → `scripts/ensure.sh` で Herdr 側にシェルを用意し、ユーザーに attach を案内する。現セッションは殺さない
- 長時間プロセス → `scripts/run-bg.sh -- cmd...`
- 子 pi → `scripts/spawn-agent.sh`（`--layout tab` = tab create / `--layout pane` = 下ペイン split → `agent start --kind pi`。`--agent <name>` で agent 定義を再現。定義は `MUX_AGENT_DIR` → パッケージの `agents/<name>.md` → `~/.pi/agent/agents/<name>.md` の順で探す）
- 詳細 CLI は herdr skill（あれば）

## 検出（固定）

1. `HERDR_ENV=1` → backend=`herdr`
2. else backend=`none`

preferred（backend=none のときの起動先）: `herdr` が PATH にあれば `herdr`、無ければ `none`。

## 前提

- `pi` が PATH にある
- herdr で status を見るなら `herdr integration install pi`（未導入だと `unknown` になりやすい）
- `lane_watch` はこのパッケージの拡張 `lane-supervisor/`（`pi install` すれば一緒に入る）。`/reload` が必要
- Herdr 外では `lane_watch` / `lane_unwatch` / `peer_supervisor ensure` / `spawn_cheap` / `mux_intervene` / `mux_close` / `/start-lane` は
  `herdr_required`（または `herdr_only`）と案内を返す

## scripts

| script | 役割 |
|---|---|
| `detect.sh` | backend / preferred / herdr_server 等を JSON 1 行で出力 |
| `ensure.sh` | backend=none のとき Herdr 側にシェルを用意（exit 2 = 用意した） |
| `run-bg.sh` | 長時間プロセスを Herdr の pane で起動 |
| `spawn-agent.sh` | 子 pi 起動。`--layout tab`（既定）= tab create / `--layout pane` = 下ペイン split → `agent start --kind pi`（`--agent <name>` で agent 定義を再現）→ **prompt 受理確認**（`working\|blocked`、失敗時 1 回リトライ・`ok:false`）。`--wait` は settled まで待つ（付けなければ受理まで） |
| `status.sh` | agent の状態 |
| `intervene.sh` | force+ack 付き割り込み prompt。生テキスト送信禁止の受け口（`mux_intervene` が包む） |
| `close.sh` | tab/pane を閉じる（司令塔枠は残す。`mux_close` が包む） |
| `pi-session-tail.sh` | Pi session jsonl の末尾 assistant 塊をテキストで出す |
| `lane-supervisor/` | 拡張。親へは `signal=completion|anomaly` の `LANE_EVENT`/`CHEAP_EVENT` だけ |

### spawn-agent（herdr）の契約

- 成功 stdout: `ok:true` · `agent` · `tab_id`/`pane_id` · `prompt_attempts` · `agent_status`
- 失敗 stderr + exit 1: `herdr_prompt_not_acked` 等（**`|| true` で握りつぶさない**）
- env: `MUX_SPAWN_PROMPT_ACK_SEC`（default 10）· `MUX_SPAWN_PROMPT_RETRIES`（default 1 = 合計 2 試行）
- `--layout pane`: 下ペイン。閉じるなら `lane_unwatch` → `mux_close pane=…`
- `--wait`: 受理後に settled（idle/done/blocked）まで追加待ち。付けなければ受理まで
- `--layout pane` + `--wait`: result 回収後に自分で split した下ペインを閉じる（`closed_pane:true`）。失敗時は残す。`MUX_SPAWN_KEEP_PANE=1` で残す
- `--layout tab` は閉じない。閉じるなら `mux_close tab=…`
- 子 pi には `--approve` を付ける（worktree の AGENTS.md 信頼プロンプトで止まらない）

## 指示・割り込み

子への指示・追加指示・割り込みは **必ず** `mux_intervene`（初回起動は `spawn-agent.sh` または呼び出し元の起動ツール）。

- **禁止**: `herdr pane send_text` / `herdr_pane send_text` で agent に本文を送ること（Enter・bracketed-paste 不一致で **延々 pending** の主因）
- **禁止**: `herdr agent prompt` を ack 確認なしで一度きり投げて成功扱い
- `mux_intervene` は force 既定 true（working 中は esc → prompt で**中断して挿入**）。`force=false` と `herdr_agent prompt` はキュー積み
- メッセージは短く 1 件。長文は `message_file`
- 枠を閉じる: `mux_close`（`tab` / `pane`。司令塔枠は拒否）
- 実装は `scripts/intervene.sh` / `scripts/close.sh`

## 禁止

- herdr server stop / 既存ユーザー pane の close
- in-process `subagent` で tab/pane 相当を Herdr 内で代替する（Herdr 内は `spawn_cheap`）
- `project.open` を `spawn-agent.sh` の代替にする

## 監視（lane_watch）

拡張が待ち・トリアージする。親へは `signal=completion|anomaly` だけ。healthy は届けない。
親は `herdr agent wait` / sleep しない。
kind とパラメータは呼び出し元。

| 入力 | mux の約束 |
|---|---|
| `signal=completion` / `anomaly` | 親に届ける |
| healthy safety / periodic | 親に届けない |
| 未 watch / 撤収済 / `signal` 無し | 無視 |

撤収順: `lane_unwatch` → `mux_close`（終了 prompt を間に挟まない）。
`/reload` 後は session の watch を復元（gone は捨てる）。

