---
name: delegate-execute
description: >-
  賢い主 + 安いサブの委譲方針と起動。探索は explore、実装は executor。
  Herdr がある環境は spawn_cheap / lane_watch、無い環境は subagent（async）で出す。
  Use when implementing, exploring, fixing bugs, parallel subtasks,
  委譲, executor, explore, spawn_cheap, timer_start, 予算, 定期 tick.
---

# delegate-execute

方針と起動の正本。Herdr の有無で**起動手段だけ**が変わる（方針は同じ）。
予算の掛け方はこの skill の「予算と timer」（`timer_start` が無ければ予算トークンは使わず、コンパイル1+修正1周だけ）。

## 原則

判断の最終責任は主、手足は安いサブ。デフォルトは委譲。安い主 + 賢い実行だけにはしない。
**委譲前に設計を厚くするな。** 大雑把な方針と完了条件を渡して走らせ、監督とレビューで直す。

| 主に残す | 積極委譲 |
|---|---|
| 要件の大枠・最終判断・ユーザー応答 | 事実調査・実装の具体化・機械的編集 |
| 成果レビュー・統合・的外れへの介入 | ビルド／テスト実行・結果収集 |
| デザインツール（デザインファイル・キャンバス）への書き込み | スクショ・画像・ページの判定。エミュレータ / シミュレータ / ブラウザの読み取りと操作再現 |
| プロダクト／アーキの分岐（出てから決める） | 方針内の局所判断（ファイル選定含む） |

安いモデルが不安定でも、先に正確設計してから渡すな。代わりに **短く渡す → 監督 → レビュー → 短い next**。

主がやってはいけない: 委譲前に実装設計を書き切る / 設計が揃うまで委譲しない / サブが迷うのを恐れて自分で実装する。
迷ったら委譲。親が自分でツールを **2 往復以上**叩きそうなら出す。例外はデザインツールへの書き込みだけ。往復が多くても主が直実行し、先頭で `非委譲: design-write` を宣言する。既知の tiny-patch と、ユーザーへの判断・説明だけは出さない（spawn + 回収の方が高い）。`decision-only` は **少しの調査で終わる見込みのときだけ**。広く読む・複数ファイルを追う・時間がかかりそうなら先に explore。成果を親が作り直すな。短い next で戻す。

## 範囲

本 skill は **安委譲**（explore / executor）の**方針と起動**。
割り込み・枠は Herdr がある環境だけ **`mux-pi`**（無い環境は起動も回収も `subagent` だけで完結する）。壁時計の id は本 skill の「予算と timer」。

`--wait` して目を閉じるな。同時 **最大 2**。触るファイルが重なる executor 並列は禁止。
親が高コストで動くのは **完了・異常**と、**定期 tick で最新部分だけ**（トランスクリプト深読みはしない）。

## 起動

**Herdr がある環境（`HERDR_ENV=1`）**

1. **`spawn_cheap` ツール**（agent: explore|executor, task, title）。pane 経路・`--wait` なし・in-process 禁止（ツールが拒否する）
2. 成功 JSON の `agent` で直後 **`lane_watch`**（agent=<返却 agent>, kind=cheap, label=cheap-<title>。拡張内 safety/periodic は cheap ではオフ）
3. 親は同時に **`cheap-main`** の timer を回す（下記）
4. 閉じるのはレビューのあと（`lane_unwatch` → `mux_close pane`）

**Herdr が無い環境**（この手順が正本）

1. **`subagent` ツールを `async: true`** で呼ぶ:
   `subagent({ agent: "executor", task: "…", async: true })`（explore も同じ形）
2. 結果は**完了通知**で戻る。届くまで親は待たない（`--wait` で目を閉じない。sleep 監視をしない）
3. 同時稼働は最大 2。戻ったら「閉じる判定」→「レビュー」の順
4. 中断・追加指示は `subagent` の継続（同じ agent）に短い 1 文。枠の概念は無い（閉じる操作も無い）

**モデル**: 安いサブのモデルは `/cheap-model` で選ぶ（`cheap-model.json` に provider/model/thinking を保存）。
`spawn_cheap` は model 未指定時、その設定を読んで `--model provider/model[:thinking]` を渡す。
ファイルが無い・壊れている・旧形式のときはサフィックス無しで動き、pi の既定モデルに落ちる。
Herdr 外の `subagent` は agent 定義（`agents/*.md`）の設定に従う（`model:` は持たない。未設定なら pi 既定）。

**エージェント定義**: `agents/explore.md` / `agents/executor.md`（パッケージ同梱）。
- Herdr あり: `spawn-agent.sh` が `MUX_AGENT_DIR` → パッケージの `agents/` → `~/.pi/agent/agents` の順で解決する
- Herdr 外（`subagent`）: パッケージの `pi.subagents.agents` 宣言で同じ `agents/` が見える（コピー不要）。
  `pi-subagents` を使わない環境だけ `agents/*.md` を `~/.pi/agent/agents/` へコピーする

**フォールバック（Herdr あり・`spawn_cheap` が失敗）**: `mux-pi` の `spawn-agent.sh --layout pane`（`--wait` しない）。それも無い → 1 本だけ `--wait`。

## 予算と timer

壁時計は timer。**自分で測るな。sleep で監視するな。** Pi 終了で timer も消える（wake 先は呼んだ session）。
available tools に `timer_start` が無いなら timer するな（拡張未ロード。`/reload` か再起動）。

| id | interval_sec | max_ticks | session |
|---|---|---|---|
| `budget` | 1800 | 1（id=budget / TIME_BUDGET で強制） | **子**（開始時の最初のツール） |
| `cheap-main` | 300 | 0 | **親**（定期起こし。安委譲中） |
| `lane-main` | 180 | （省略可） | **親**（`lane-control` の点検フォールバック） |

**子（executor / explore）**: `timer_start id=budget` を開始時の最初のツールにする。完了時は可能なら `timer_stop id=budget`。

```
timer_start
  id: budget
  interval_sec: 1800
  message: "TIME_BUDGET_EXCEEDED — 即停止。新規ツール禁止。status=partial と done/remaining/next のみ報告。"
```

**親（定期起こし）**:

```
timer_start
  id: cheap-main
  interval_sec: 300
  max_ticks: 0
  message: "TIMER_TICK: cheap-main"
```

残 0 なら `timer_stop id=cheap-main`。延長するときも **対象 session** で `timer_start id=budget` する（親 session で子の budget を出さない）。

```
timer_status
timer_stop id: <id>
```

### 定期 tick（親）

安委譲中は親で `cheap-main` を回す。
`TIMER_TICK` では委譲先の最新部分だけ読む。変化なければ短く継続。的外れなら短い介入（Herdr ありは `mux_intervene`）。
閉じる判定は tick に載せない（完了通知 / 予算切れのとき下記）。

## 標準フロー

1. 事実が足りなければ **explore**（任意。委譲を待たない。事実・パス・引用。採用案の推奨は求めない）
2. **大雑把な方針 + 完了条件 1 つ**で **executor**（ファイル列挙・採用案の確定はしない）
3. 主は **監督**（定期 tick は上記。子が止まったら一度だけ見て継続か閉じるかを決める。異常は短い介入）
4. **閉じる判定**（下記）で継続 or 閉じる。閉じると決めても、枠を閉じる前に **レビュー** 節（`review` を read）。差し戻しなら短い next で**そのときだけ** spawn。通ってから枠を閉じ、ユーザーへ完了・要約

禁止: 設計が揃うまで委譲しないこと / 完了条件のない「全体をよろしく」。

実装の具体（触るファイル・関数名・手順）はサブに任せる。プロダクト方針が割れたときだけ `blocked:decision`。

## 閉じる判定（安委譲）

子が止まったとき（完了通知 / 予算切れ）は、自動で閉じて次を spawn しない。
親が**一度だけ**見て「継続」か「閉じる」かを決める。定期 tick の継続/1 文介入とは別に、閉じるのはここだけ。
手順（割り込み・枠を閉じる・予算 timer）は **`mux-pi`** / 本 skill の「予算と timer」。

見てよいもの: 末尾の発言・edit の有無・テスト/compile・commit。
ここでやらないもの: コードの是非（それは **レビュー** 節）。この判定だけで枠を閉じるな。ユーザーへ完了を言うな。

| 子の状態 | 親の手 |
|---|---|
| 本線で未完了 | **同じ子を継続**。短い指示の足し、または budget +1 |
| 空 done / 中断だけ / 早すぎる完了通知 | 閉じない。同じ指示を 1 行（Herdr ありは `mux_intervene`） |
| 完了条件を満たす | 枠はまだ閉じない。**レビュー** 節へ。差し戻しなら同じ子を継続。通ったら枠を閉じ、それからユーザーへ要約 |

- `done` は自動 close ではない（空 done は上表）。`partial` は新しい spawn より**同じ子の継続が先**。
- 予算切れで延長してよい: 対象の edit がある、または本線のテスト/compile が動いている。+1 回まで。子へ短く指示し、子が `budget` を出し直す。
- 延長しない: 調査だけ・同じ失敗の繰り返し・禁止パス・空 done。「もう少しで終わりそう」だけでは足さない。
- 閉じる判定を定期 tick に載せない。空 done に妥当性の長考をしない。
- 同じ仕事を 3 本目の spawn で細切れにしない。

## 非委譲

先頭で `非委譲: <理由コード>`。許可は次だけ。

| コード | 意味 |
|---|---|
| `user-forbid` | ユーザーが委譲禁止を明示 |
| `decision-only` | 判断・説明のみ。**短い調査で足りる見込みのときだけ**（既知の局所・1〜2 ファイル程度）。構造把握や広範囲の事実集めは explore に委譲。途中で長引いたら打ち切って委譲 |
| `tiny-patch` | 既知パス・1ファイル・新規なし・実質≤5行・テスト/DB/DI なし・その1応答で完結 |
| `meta` | 説明のみ。コード・skill・拡張・AGENTS 本文は直さない |
| `skill` | 適用スキルが委譲なしと書いてある |
| `design-write` | デザインツール（デザインファイル・キャンバス）への書き込み。読み取りだけ、またはコードへの落とし込みは含まない。安委譲しない |

tiny-patch は1つ欠けたら委譲。追指示・2ファイル目で失効。宣言の継続禁止。
「設計がまだ無い」は非委譲理由にならない。
`design-write` は主が直実行する。ターンごとに宣言し直す。

## バッチ

1 委譲 = 完了条件 1 つ。長文・多シナリオ同梱禁止。prompt は画面 0.5〜1 枚が目安。手順の正本は skill 名で指す。
安委譲の同時稼働は **2 まで**。3 本目は 1 本回収してから。

| OK | NG |
|---|---|
| 設定ファイルの項目追加 + そのテスト | 設定変更 + UI badge + 画面確認の一括 |
| 1 画面の表示崩れ修正 | 複数画面 + 反映待ち経路の検証まで |
| `partial` の next 1 行で再開 | 失敗後に同じ長文を再投下 |

## エスカレート

| サブ status | 主 |
|---|---|
| `done` | 閉じる判定（空 done は閉じない → 1 行介入）。通れば **レビュー** 節（枠を閉じる前）。通ってから枠を閉じ、ユーザーへ要約 |
| `partial` | **同じ子を継続**が先（短い指示の足し or budget +1）。同じ長い prompt の再投下はしない |
| `blocked:decision` | 主が決める → 再指示 |
| `blocked:env` | 環境解消 or ユーザー確認。即再投げしない |
| `failed` / 空 | 短い next。同じ長い prompt は再投下しない |

`partial` / `blocked:*` では同じ子を継続する（新しい spawn より先）。

予算切れ or コンパイル1+修正1周で未完 → `partial` + next。

## 委譲プロンプト

```
目的: …
範囲外: …
方針: （大雑把でよい。ファイル列挙・採用案の確定は不要）
完了条件: （1 つ）
手順: （skill 名 or 短い箇条書き。無くてよい）
検証: …
制約: 目的を変えるな。プロダクト/アーキの分岐だけ blocked:decision。局所判断は自分でせよ。
handoff: 予算切れ or コンパイル1+修正1周 → partial + next。
         スクショ・画像の判定と、エミュレータ / シミュレータ / ブラウザの操作は自分でする（推測で進めるな）。
         デザインツールへの書き込みは渡すな。親が直実行。
```

explore 用は知りたい事実 / 探すパス・記号 / 報告形式だけ。

## レビュー

閉じると決めたら、枠を閉じる前・ユーザーへ完了を言う前にやる。省略禁止。閉じる判定（末尾・テストの有無）はこれに数えない。

1. `review` を read し、「レビューするとき」と「安委譲の成果物回収」に従う。差分を眺めただけでは不可。
2. ユーザーへ言う前に、次を先に書く。書かずに完了・要約を言うな。
   - 完了条件と、見た差分（パス）
   - 自己申告と食い違う点。無ければ「食い違いなし」
   - 方針逸脱と、差し戻すか
3. 差し戻すなら枠は閉じない。短い next で同じ子を継続。通ったら枠を閉じ、それからユーザーへ要約。

## 回収

完了通知はレビュー済みではない。ユーザーへ完了・要約を言う前に上のレビュー節を実行する（`review` を read）。未実施のまま枠を閉じるな。
