# pi-skills-202610

[pi](https://github.com/earendil-works/pi)の筆者の設定一式を配布するパッケージしたもの。

以下の点を実現できるように目指しています

- 「賢い親モデルが監督、安いサブエージェントが調査と実装」とする運用を行うとき、親モデルのtoken消費を抑えつつしっかり監督できること
- Obsidianで読む前提のmarkdown格納ディレクトリ(本稿ではwikiと呼称)に作業状況の記録が残ること
- wikiに書いたタスクリストを元に並列処理ができること


具体的には以下の制御を行います

**委譲の強制(安委譲)** 知性高めのモデル(筆者はGrok4.5〜4.7を常用)に仕事を任せるが、殆どの作業を安いモデル(DeepSeek V4.1 Flashを想定)にやらせレビューや監督に徹させたいので、extensionsを使って「ちょっとだけの改変です」「ユーザー許可があったから」などの理由を付けないと作業がブロックされるようにする

**レーン制御** markdownに書いたタスクリストに従って、複数作業を並列で進めさせたい。よってレーン制御担当(賢いモデル指定)が、レーン監督(賢いモデル指定)を立ち上げて作業を分配。レーン監督はさらに安委譲して作業を進め、wikiに記録を残す。

**その他調整** 時間とtoken節約のため、単純grepやfindを封じてrgなど効率の良いものを使わせるよう強いたり、各種制御を円滑にするためのherdrやタイマー制御を入れたり


※ 筆者が利用している物を汎用化するために改変したものなので、意図通り動作するかは保証しかねます。



## 内容物


| スキル | 内容 |
|---|---|
| `lane-control` | wikiに書いた進捗確認ドキュメントに従って並列で作業レーンを立てるスキル(レーン運用) |
| `mux-pi` | Herdr の検出と起動スクリプト |
| `wiki` / `review` / `obsidian-syntax` | wiki の読み書き、レビュー手順、Obsidian 記法 |


| 拡張 | 内容 |
|---|---|
| `hijoui-guard` | 親モデルの手続きに従ってない操作をブロックしたりして、安モデルにタスクを投げるよう強いる |
| `bash-search-guard` | bash の GNU `find` / `grep` を block |
| `cheap-model` | 安モデル選択支援（`/cheap-model`） |
| `spawn-cheap` | Herdr 内の pane 起動 |
| `lane-supervisor` | レーンの状態監視（完了・異常だけ親へ伝達） |
| `mux-intervene-close` | 子への割り込み（`mux_intervene`）と pane / tab を閉じる（`mux_close`） |
| `start-lane` | `/start-lane` でレーン運用を開始 |
| `session-timer` | `timer_start` / `timer_stop` / `timer_status`タイマー割り込み制御。定期チェックを促したり、時間切れで打ち切ったり |
| `enable-search-tools` | grep / find / ls を常に有効化 |

## 始め方

Pi Coding Agent前提です。レーン制御はHerdrの中で動かす前提です。それ以外はsubagentを利用。 以下の拡張やツールをいれてください

// ここに表かリストインストールすべきコマンドや拡張を列挙


// ここに導入方法




---ここまで調整中--

| 項目 | 内容 |
|---|---|
| pi | 1.3 系で確認（拡張 API を使うため、古い版では動かない可能性がある）。導入は [pi 本体の手順](https://github.com/earendil-works/pi) に従う |
| Node | 22.19 以上（pi 1.3 の要件） |
| Herdr | 任意。[Herdr](https://github.com/ogulcancelik/herdr) を使う場合のみ。使うなら Herdr 側の pi 連携で `~/.pi/agent/extensions/herdr-agent-state.ts` が入る（`herdr integration install pi`） |
| rg / fd | 推奨。`bash-search-guard` が bash の GNU `find` / `grep` を止めるため、シェル検索は `rg` / `fd` を使う |
| bun | テスト用（拡張のテストは `bun test`） |
| gh | 任意。既製スキルの導入に `gh skill install` を使う |

## クイックスタート

```bash
# 1. このパッケージ
pi install git:github.com/y-sugitani/pi-skills-202610

# 2. 必須の依存（Herdr 無しの委譲と、agents/*.md の解決に使う）
pi install npm:pi-subagents

# 3. 反映
#    pi を起動して /reload

# 4. 安いサブのモデルを選ぶ（spawn_cheap / 拡張内の点検が使う）
#    pi 内で /cheap-model
```

一部の拡張・スキルだけ有効化したいときは `pi config`（Tab でグローバル / プロジェクトを行き来）。
設定ファイルの書き方（`packages` の絞り込み、`!pattern` での除外など）は pi 本体の
[Packages ドキュメント](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) を参照。

## 動作モード表

`HERDR_ENV=1` かどうかで使えるものが変わる。Herdr 外では Herdr 専用のツールが案内 JSON（`herdr_required` / `herdr_only`）を返し、`/start-lane` は警告を出すだけで終わる。壊れはしない。

| 機能 | 種別 | Herdr あり | Herdr 無し |
|---|---|---|---|
| `delegate-execute` | スキル | 使う | 使う |
| `review` / `wiki` / `obsidian-syntax` | スキル | 使う | 使う |
| `lane-control` | スキル | 使う | 使わない（レーンが成立しない） |
| `mux-pi` | スキル | 使う | abort（`no_mux_available`） |
| `spawn_cheap` | ツール | pane 起動 | `herdr_only` を返す |
| `mux_intervene` / `mux_close` | ツール | 使う | `herdr_required` |
| `lane_watch` / `lane_unwatch` / `lane_watch_status` / `peer_supervisor` | ツール | 使う | `herdr_required` |
| `/start-lane` | コマンド | 使う | 警告のみ |
| `subagent` / `subagent_wait` / `bg_wait` / `contact_supervisor`（pi-subagents） | ツール | **拒否**（in-process 禁止。`subagent` / `subagent_wait` のみ） | 使う（`async: true` + `bg_wait` で待つ） |
| `timer_start` / `timer_stop` / `timer_status` | ツール | 使う | 使う |
| `hijoui-guard` / `bash-search-guard` / `enable-search-tools` | 拡張 | 有効 | 有効 |

### Herdr 無しで安いモデルを使う

`agents/explore.md` / `agents/executor.md` は `model:` を持たない（モデルは環境ごとに選ぶ前提）。
Herdr 外の `subagent` では、pi-subagents の `agentOverrides` で役割ごとに固定する。`~/.pi/agent/settings.json` の例は次のとおり。

```json
{
  "subagents": {
    "agentOverrides": {
      "explore": { "model": "ollama-cloud/deepseek-v4.1-flash:1017", "thinking": "high" },
      "executor": { "model": "ollama-cloud/deepseek-v4.1-flash:1017", "thinking": "max" }
    }
  }
}
```

優先順位（強い順）: 実行時の指定 → 親 provider 別の上書き → `agentOverrides.<name>.model` →
エージェント定義の `model:` → `subagents.defaultModel` → 親セッションのモデル。
全員同じでよければ `"subagents": { "defaultModel": "<provider>/<model>" }` だけでもよい。
詳細は pi-subagents の
[models](https://github.com/nicobailon/pi-subagents/blob/main/docs/models.md) /
[agents](https://github.com/nicobailon/pi-subagents/blob/main/docs/agents.md)。

Herdr ありの pane 起動は `/cheap-model` の `cheap-model.json` を読む（下記）。

## 同梱物

### 拡張（`extensions/`）

| 名前 | 何をする | 依存 | モード |
|---|---|---|---|
| `hijoui-guard` | 親の作業ツール（read / bash / edit / write / grep / find / ls 等）を、同一ユーザーターンの `非委譲: <code>` 宣言が無いと block。`/hijoui-status` | なし | 共通（cheap 子は対象外） |
| `bash-search-guard` | bash のコマンド位置の `find` / `grep` / `egrep` / `fgrep` を block（`rg` / `fd` は通す。文字列・コメント内は対象外）。`/search-guard-check <cmd>` | なし | 共通 |
| `cheap-model` | `/cheap-model` で安いサブの provider / model / thinking を選び `cheap-model.json` に保存。親モデルは変えない | なし | 共通 |
| `enable-search-tools` | 起動時に `grep` / `find` / `ls` を active tools へ追加（既定は read / bash / edit / write のみ） | なし | 共通 |
| `session-timer` | `timer_start` / `timer_stop` / `timer_status`。時間になったら同じセッションへメッセージを差し込む（壁時計の sleep 監視はしない） | なし | 共通 |
| `spawn-cheap` | `spawn_cheap` ツール。`mux-pi` の `spawn-agent.sh --layout pane` を包む。Herdr 内では `subagent` を拒否 | Herdr、`skills/mux-pi/scripts` | Herdr 専用 |
| `lane-supervisor` | `lane_watch` / `lane_unwatch` / `lane_watch_status` / `peer_supervisor`。状態判定は拡張内（安いモデル）で行い、親は完了・異常のときだけ起きる | Herdr、`cheap-model.json` | Herdr 専用 |
| `mux-intervene-close` | `mux_intervene`（force + ack 付き割り込み）と `mux_close`（tab / pane） | Herdr、`skills/mux-pi/scripts` | Herdr 専用 |
| `start-lane` | `/start-lane [メモ]`。自タブを repo 名に改名し、`lane-control` の開始プロンプトを流す | Herdr、`skills/lane-control` | Herdr 専用 |

`_shared/` は拡張ではない（`index.ts` を持たない）。パス解決・`cheap-model.json` の読み書き・許可リストを集約している。

### スキル（`skills/`）

| 名前 | 何をする | 依存 | モード |
|---|---|---|---|
| `delegate-execute` | 委譲方針と起動の正本。何を親に残すか、どう短く渡すか、予算 timer（`budget` / `cheap-main`）、閉じる判定 | `timer_*`、`spawn_cheap` または `subagent` | 共通 |
| `lane-control` | progress（wiki の工事看板）を正本に、worktree + 子エージェントのレーンを最大 4 並列で起動・監視・merge・撤収する司令塔の運用 | Herdr の tab / pane、`lane_watch`、`wiki` | Herdr 専用 |
| `mux-pi` | Herdr の検出（`detect.sh`）と起動・状態・割り込み・close のスクリプト群 | Herdr CLI、`pi` | Herdr 専用 |
| `review` | レビュー手順。安いサブの成果物を回収するときの突き合わせ方 | なし | 共通 |
| `wiki` | Obsidian vault の読み書き手段と、progress / journals / keywords の役割・枠。接続は読む側の `AGENTS.md` の `## Wiki` 節で宣言する | `## Wiki` 宣言、任意で MCP | 共通 |
| `obsidian-syntax` | Obsidian Flavored Markdown のリファレンス。ノートを書く前に引く | なし | 共通 |

`skills/lane-control/prompts/start-lane.md`（`/start-lane` が流すプロンプト）と
`skills/wiki/journal.md`（journal の雛形）も同梱している。

### エージェント（`agents/`）

| 名前 | 役割 | 主な設定 |
|---|---|---|
| `explore` | 調査専用。事実・パス・引用だけ返す（採用案の推奨はしない） | `thinking: max`、`systemPromptMode: replace`、`skills: wiki` のみ、`edit` / `write` と委譲系ツールを除外、`completionGuard: false` |
| `executor` | 実装実行専用。渡された方針の範囲で実装を完了させる | `thinking: max`、`systemPromptMode: replace`、スキルは継承、委譲系ツールを除外、`maxSubagentDepth: 0` |

どちらも `model:` を持たない。Herdr ありは `/cheap-model`（`cheap-model.json`）、Herdr 無しは
`agentOverrides` で決める。Herdr ありの `spawn-agent.sh` は
`MUX_AGENT_DIR` → このパッケージの `agents/` → `~/.pi/agent/agents/` の順で定義を探す。

## hijoui-guard（非委譲宣言ガード）

方針を文章で書いても、親（高いモデル）はつい自分でファイルを読み始める。そこで機械的に止める。

- 親が作業ツール（read / bash / edit / write / grep / find / ls、MCP など）を呼ぶには、
  **同一ユーザーターンのアシスタント出力**に次の形の宣言が必要になる。
  ```
  非委譲: tiny-patch（1 行だけ直すので自分で直す）
  ```
- 許可 code は 6 つ: `user-forbid` / `decision-only` / `tiny-patch` / `meta` / `skill` / `design-write`。
- **宣言不要**で使えるもの: 委譲起動と監督（`spawn_cheap` / `subagent*` / `bg_wait` / `contact_supervisor` / `intercom` / `lane_*` / `peer_supervisor` / `herdr_*` / `mux_intervene` / `mux_close` / `timer_*`）と、
  委譲用スキルの read（`delegate-execute` / `mux-pi` / `lane-control` / `AGENTS.md` / `APPEND_SYSTEM.md`）。
- cheap 子（explore / executor）と `PI_SUBAGENT_PARENT_SESSION` 付きの子は**対象外**。子は委譲できないので止めない。
- 状態確認は `/hijoui-status`（`on (parent)` / `off (cheap child)` / `off (disabled)` と、いま効いている宣言 code）。

ガードは次のどちらでも無効にできる（既定は有効）。

```bash
# 環境変数で一時的に切る
PI_HIJOUIGUARD=off pi
```

```json
// ~/.pi/agent/hijoui-guard.json
{ "enabled": false }
```

有効にしたまま運用するなら、`AGENTS.md` に宣言ルールを書いておく（[agents-example.md](agents-example.md) 参照）。

## /cheap-model

安いサブのモデルを選ぶコマンド。親セッションのモデルは変えない。

1. モデルレジストリの候補から provider/model を選ぶ（`PI_CHEAP_PROVIDERS="provider-a,provider-b"` で候補を絞れる）
2. そのモデルが対応する thinking レベルを選ぶ（「指定しない」も可）
3. `~/.pi/agent/cheap-model.json` に保存

```json
{
  "provider": "ollama-cloud",
  "model": "deepseek-v4.1-flash:1017",
  "thinking": "high"
}
```

このファイルは `spawn_cheap`（`--model provider/model:thinking`）と `lane-supervisor` の拡張内点検が読む。
無い・壊れているときは pi の既定モデルに落ちる。

## wiki の `## Wiki` 宣言

`wiki` スキルは vault の場所を知らない。読む側の `AGENTS.md` に宣言があるときだけ動く
（無ければ推測せず中止する）。

```markdown
## Wiki

- vault: <vault 名>
- path: <vault の絶対パス>
- mcp: <MCP サーバ名（任意。無ければ Markdown を直接読む）>
```

## おすすめ既製パッケージ

このパッケージが前提にしているもの、併用すると効くもの。

| パッケージ | 用途 | install |
|---|---|---|
| `pi-subagents` | **必須**。`subagent` ツール（Herdr 無しの委譲）と `agents/*.md` の解決、`agentOverrides` | `pi install npm:pi-subagents` |
| `@ogulcancelik/pi-herdr` | Herdr のレイアウト・ペイン・エージェントを Pi ツールから操作（`herdr_layout` / `herdr_pane` / `herdr_agent`） | `pi install npm:@ogulcancelik/pi-herdr` |
| `@ff-labs/pi-fff` | `find` / `grep` を FFF（Rust 製・frecency 付き）に置換（`fffind` / `ffgrep`）。`~/.pi/agent/pi-fff.json` に `{"mode":"override"}` を置くと組み込み `find` / `grep` を置き換える | `pi install npm:@ff-labs/pi-fff` |
| `pi-web-access` | `web_search` / `fetch_content` / GitHub clone / PDF / YouTube。pi-subagents の researcher 系の前提 | `pi install npm:pi-web-access` |
| `pi-mcp-adapter` | MCP を codemode 経由で使い、コンテキストを消費しない。組み込み MCP を切って置き換える（`settings.json` の `extensions` に `"-builtin:mcp"`） | `pi install npm:pi-mcp-adapter` |
| `pi-ollama-cloud` | Ollama Cloud を provider として追加し、`ollama_web_search` / `ollama_web_fetch` を提供。安いサブの供給元にしやすい | `pi install npm:pi-ollama-cloud` |
| `@gotgenes/pi-anthropic-auth` | Claude Pro / Max の OAuth 互換を改善（pi の通常挙動は保つ） | `pi install npm:@gotgenes/pi-anthropic-auth` |
| `pi-commandcode-provider` | Command Code API を provider として追加（非公式・要アカウント） | `pi install npm:pi-commandcode-provider` |
| `pi-tps-status` | ストリーミング中の tokens/sec をステータスバーに表示（`/tps` で設定） | `pi install npm:pi-tps-status` |
| `@narumitw/pi-stamp` | 発言ごとの時刻・所要時間・トークン・コストをトランスクリプトに表示 | `pi install npm:@narumitw/pi-stamp` |
| `@narumitw/pi-chrome-devtools` | Chrome DevTools Protocol のツール（タブ一覧・移動・JS 実行・スクショ） | `pi install npm:@narumitw/pi-chrome-devtools` |
| `pi-mono-figma` | Figma REST を LLM 向けの要約で返す拡張 + スキル（デザイン → コード） | `pi install npm:pi-mono-figma` |

## おすすめ既製スキル

`gh skill install <owner>/<repo> <skill名>` で入る（GitHub CLI の preview 機能）。

| スキル | 入手先 | 用途 |
|---|---|---|
| `ax` | `yusukebe/ax` | `curl` + 捨てスクリプトの代わりに、ax CLI で URL を探索・構造抽出する |
| `grilling` | `mattpocock/skills` | 計画・判断・アイデアを、実装前に容赦なく質問攻めにして潰す |
| `yomiyasu` | `nanaism/yomiyasu` | AI が書いた日本語を、意味と条件を保ったまま読みやすく推敲する |
| `json-canvas` | `kepano/obsidian-skills` | Obsidian の `.canvas`（JSON Canvas）をノード・エッジ付きで作る |
| `mobilebuildmcp-cli` | `getsentry/XcodeBuildMCP` | iOS / macOS などのビルド・テスト・実行・UI 自動化を CLI で行う |

`wiki` スキルは、業務・技術文書を書き出すときに `yomiyasu` を読む前提で書かれている（無い場合は書き出しを止める）。

## おすすめ設定例

`~/.pi/agent/settings.json` の例（値は好みに合わせる。API キーや認証情報はここに書かない）。

```json
{
  "defaultProvider": "ollama-cloud",
  "defaultModel": "deepseek-v4.1-flash:1017",
  "defaultThinkingLevel": "high",
  "defaultTools": ["+codemode"],
  "hideThinkingBlock": true,
  "showCacheMissNotices": true,
  "extensions": ["-builtin:mcp"]
}
```

- `defaultTools: ["+codemode"]` は、`+name` を既定に足す。codemode を有効にすると、ツール呼び出しを JS スクリプトにまとめられる
- `hideThinkingBlock` は thinking の長文を表示しない（ログが読みやすい）
- `defaultThinkingLevel` は親の既定 thinking。安いサブは別に決める（`/cheap-model` か `agentOverrides`）
- `extensions: ["-builtin:mcp"]` は組み込み MCP を切り、`pi-mcp-adapter` に任せる
- `packages` は `pi install` が追記する（手で書かなくてよい）

`~/.pi/agent/models.json` ではレジストリの値を上書きできる。コンテキスト長や thinking の対応表を直せる。

```json
{
  "providers": {
    "ollama-cloud": {
      "modelOverrides": {
        "deepseek-v4.1-flash:1017": {
          "contextWindow": 200000,
          "thinkingLevelMap": { "max": "max" }
        }
      }
    }
  }
}
```

`thinkingLevelMap` は Pi の thinking レベルを provider 側の値へ対応させる。`null` は「そのレベルを使わない」。
`contextWindow` / `maxTokens` / `cost` も同じ場所で上書きできる。

`~/.pi/agent/cheap-model.json` は `/cheap-model` が書く。手で置いてもよい（上の例を参照）。

## AGENTS.md の書き方

このパッケージの運用は、`AGENTS.md` に委譲方針・探索の優先順位・レビュー手順を書いておくと安定する
（`hijoui-guard` の宣言ルールもここに書く）。
雛形と各節の「なぜその節があるか」は [agents-example.md](agents-example.md) に置いた。自分の環境に合わせて削って使う。

## 開発

```bash
# 拡張のユニットテスト（bun）
bun test extensions

# スキル同梱スクリプトのテスト
bash skills/lane-control/scripts/test-lane-scripts.sh
bash skills/mux-pi/scripts/test-pi-session-tail.sh
```

ファイル構成は次のとおり。

```
package.json          # pi マニフェスト（extensions / skills / subagents.agents）
extensions/           # 拡張（_shared は拡張ではない）
skills/               # スキル（scripts/ prompts/ fixtures/ を含む）
agents/               # explore / executor の定義
```

拡張を足すときは `extensions/<name>/index.ts` か `extensions/<name>.ts`。`_shared/` は共有コード専用で、
`index.ts` を置かない（置くと拡張としてロードされる）。

## 既知の制限

- **Herdr 専用の機能は Herdr 外で動かない**。`spawn_cheap` / `lane_watch` / `mux_*` / `/start-lane` / `lane-control` は
  案内 JSON を返すか警告で終わる（Herdr 外は `subagent`（async）に落とす設計）。
- `spawn_cheap` は pane 経路のみ。Herdr 内で `subagent`（in-process）は拡張が拒否する。
- `lane-supervisor` の拡張内判定は `cheap-model.json` のモデルに依存する。未設定だと pi の既定モデルで走る（コストが上がる）。
- `bash-search-guard` が見るのは**コマンド位置**だけ。`rg "find"` のような文字列は通す（ガードの説明を検索語にできる）。
- 拡張 API は pi 側で変わりうる。1.3 系で確認している。
- 同梱の `agents/*.md` は `model:` を持たない。何も設定しないと親セッションのモデルで子が走る（高い）。

## License

MIT（[LICENSE](LICENSE)）。同梱する第三者成果物は [NOTICE](NOTICE) を参照
（`skills/obsidian-syntax` は kepano/obsidian-skills 由来）。
