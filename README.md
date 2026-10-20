# pi-skills-202610

[pi](https://github.com/earendil-works/pi)の筆者の設定一式を配布するパッケージしたもの。

以下の点を実現できるように目指しています

- 「賢い親モデルが監督、安いサブエージェントが調査と実装」とする運用を行うとき、親モデルのtoken消費を抑えつつしっかり監督できること
- Obsidianで読む前提のmarkdown格納ディレクトリ(本稿ではwikiと呼称)に作業状況の記録が残ること
- wikiに書いたタスクリストを元に並列処理ができること


具体的には以下の制御を行います

**委譲の強制(安委譲)** 知性高めのモデル(筆者はGrok4.5〜4.7を常用)に仕事を任せるが、殆どの作業を安いモデル(DeepSeek V4.1 Flashを想定)にやらせレビューや監督に徹させたいので、extensionsを使って「ちょっとだけの改変です」「ユーザー許可があったから」などの理由を付けないと作業がブロックされるようにする

**レーン制御** markdownに書いたタスクリストに従って、複数作業を並列で進めさせたい。よってレーン制御担当(賢いモデル指定)が、レーン監督(賢いモデル指定)を立ち上げて作業を分配。レーン監督はさらに安委譲して作業を進め、wikiに記録を残す。

**Wiki管理** 以下のディレクトリ構造でObsidianで読む前提のmarkdownファイル群の管理を行います

```
<vault>/
├── global/               # 仕様・ドメイン・横断
│   ├── journals/
│   ├── progress/ + done/
│   └── keywords/
└── <module>/             # そのモジュールの実装知識
    └── {journals,progress,keywords}/
```

**その他調整** 時間とtoken節約のため、単純grepやfindを封じてrgなど効率の良いものを使わせるよう強いたり、各種制御を円滑にするためのherdrやタイマー制御を入れたり

※ 筆者が利用している物を汎用化するために改変したものなので、意図通り動作するかは保証しかねます。


## Wikiとレーン制御の詳細

以下の分類でドキュメント作成します

| 置き場 | 役割 |
|---|---|
| progress | 工事の看板。概要とタスクリストだけで詳細は書かない。終わったら `done/` へ |
| journals | 区切りの計画 → 記録 → 結晶。詳細の正本 |
| keywords | 安定した用語・最終仕様 |

`progress` は一連の作業の簡易説明＋タスクリストです。以下のように書いてから、Herdr 内で `/start-lane` を実行すると、このセッションが司令塔になり、未完のフェーズを最大 4 レーンに分けて進めます。Herdr 外では始まりません。

`progress`の簡易例

```markdown
# ほげほげリニューアル

〜を目的として〜をする

今: 〜をやっているところ

## フェーズ

- [x] 〜を実装して〜できるようにする (詳細: journalへのリンク…)
- [ ] 〜を実装して〜できるようにする (詳細: journalへのリンク…)
```



## 内容物


| スキル | 内容 |
|---|---|
| `delegate-execute` | 安委譲の方針。何を親に残し、何を安いモデルへ渡すか |
| `lane-control` | wikiに書いた進捗確認ドキュメントに従って並列で作業レーンを立てるスキル(レーン運用。Herdr 専用) |
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

Pi Coding Agent前提です。レーン制御はHerdrの中で動かす前提です。以下の拡張やツールに依存します

|入れるもの|必要|コマンド|用途|
|---|---|---|---|
|pi-subagents|必須|`pi install npm:pi-subagents`|Herdr 外の委譲（`subagent`）と `agents/*.md` の解決|
|ripgrep / fd|必須|`brew install ripgrep fd`|`bash-search-guard` が bash の `find` / `grep` を止めるため、シェル検索はこれらを使う|
|Herdr|任意|[Herdr](https://github.com/ogulcancelik/herdr) を導入し `herdr integration install pi`|レーンの pane / tab 制御。連携ファイル `~/.pi/agent/extensions/herdr-agent-state.ts` が入る|
|pi-herdr|任意|`pi install npm:@ogulcancelik/pi-herdr`|Herdr を pi のツールから操作する|

導入手順は次のとおりです。コマンドは使うものだけ選んで実行してください。

```bash
# 前準備（必須）
pi install npm:pi-subagents
brew install ripgrep fd

# 前準備（任意）: レーン制御を使うときだけ
# Herdr を導入してから
herdr integration install pi
pi install npm:@ogulcancelik/pi-herdr

# 任意の場所にこのパッケージを clone し、ローカル指定でインストール
# 改変したいときは clone 先を書き換えてから、pi install をもういちど実行する
git clone https://github.com/y-sugitani/pi-skills-202610.git
pi install ./pi-skills-202610

# 反映
#    pi を起動して /reload

# 安いサブのモデルを選ぶ（spawn_cheap とレーンの点検が使う）
#    pi 内で /cheap-model
```


## 使い方

### 1. obsidianのvault指定
`AGENTS.md` に vault の path を書く（`agents.md` ではない。pi とこのパッケージは大文字のファイル名を読む）。

wiki の読み書きは、今開いているリポジトリか `~/.pi/agent/AGENTS.md` の `## Wiki` を見る。レーン制御は、作業リポジトリ直下の `AGENTS.md` だけを見る。

```
## Wiki

- vault: <vault 名>
- path: <vault の絶対パス>
``` 


### 2. cheap-modelを指定する

piの中で
```
/cheap-model
```
を実行し、安いモデルを指定する

通常利用の `/model` の方はできるだけ賢いモデルを指定する

### 3. これでOK

親が自分でファイルを読んだり編集したりすると、`非委譲:` の宣言が無い限りブロックされる。宣言できるのは「ユーザーが禁止した」「判断だけ」など限られた場合なので、調査と実装は安いモデルへ渡すことになる。自動で転送されるわけではない。

### (任意) 4. レーン制御を利用する

Herdr の中で、作業リポジトリを開いた pi から使う。progress は、そのリポジトリ用の `<module>/progress/<工事名>.md` に置く。`global/progress` や、フェーズ見出しの無いチェックリストは拾わず、中断する。

フェーズは 1 行 1 能力にする。

```markdown
## フェーズ

- [ ] foo を実装して、〜できるようにする
- [ ] baa を実装して、〜できるようにする
```

その後 `/start-lane` を実行する。このセッションが司令塔になり、未完フェーズを最大4レーンに分け実行する。

## License

MIT（[LICENSE](LICENSE)）。同梱する第三者成果物は [NOTICE](NOTICE) を参照
（`skills/obsidian-syntax` は kepano/obsidian-skills 由来）。
