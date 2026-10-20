# Obsidian 内部リンクと埋め込み

出典:
- <https://obsidian.md/help/links>
- <https://obsidian.md/help/embeds>

## 内部リンクの形式

Obsidianは2形式をサポート（同等で同じノートを指す）：

- ウィキリンク: `[[Three laws of motion]]` または `[[Three laws of motion.md]]`
- Markdown: `[Three laws of motion](Three%20laws%20of%20motion)` または `[Three laws of motion](Three%20laws%20of%20motion.md)`

> Markdown形式を使用する場合、リンク先をURLエンコードする（空白は `%20`）。

デフォルトでObsidianはコンパクトなウィキリンク形式を生成する。Markdownリンク主体に切り替えるには **設定 → ファイルとリンク → [[ウィキリンク]]を使用** を無効化。

### リンクで使用できない文字

`# | ^ : %% [[ ]]` を含むファイル名はリンクとして機能しない可能性がある。これらの文字を避ける。

### Markdown以外のファイルへのリンク

ファイル拡張子を含める必要がある：`[[Figure 1.png]]`

## 見出しへのリンク（アンカーリンク）

```md
[[#同じノート内の見出し]]
[[別のノート#見出し]]
[[ヘルプとサポート#Questions and advice#Report bugs and request features]]
```

`[[#` と入力すると同一ノート内の見出し候補が表示される。

### 保管庫全体の見出し検索

`[[##` で保管庫全体の見出しを検索。

```md
[[## team]]   # "team"を含むすべての見出し
```

## ブロック参照

ブロックとは段落、引用、リスト項目などのテキスト単位。リンク先末尾に `#^id` を追加。

### ブロック識別子の付け方

**通常の段落**: 行末に空白スペースに続けて `^id` を置く：

```md
The quick purple gem dashes through the paragraph. ^37066d
```

**構造化ブロック（リスト、引用、コールアウト、表）**: 識別子を別の行に置き、前後に空行：

```md
> 引用テキスト

^37066f

次の段落。
```

**リスト内の特定の行**: 箇条書きアイテムに直接配置：

```md
- Gemmy
    $$Paperclip / Pen$$ 
    ^37006f
- Unhelpful assistant
```

### ブロックへのリンク

`[[ノート名#^id]]`：

```md
[[2023-01-01#^37066d]]
[[2023-01-01#^quote-of-the-day]]
```

`^` を入力すると候補一覧が表示される。

### 人間が読みやすい識別子

ラテン文字、数字、ハイフンのみ。

```md
"Quote text" ^quote-of-the-day
```

### 保管庫全体のブロック検索

`[[^^block]]`。見出しに比べて候補が多い。

> ⚠️ ブロック参照はObsidian固有で、標準Markdown形式ではない。Obsidian以外では機能しない。

> ⚠️ 引用、コールアウト、表の**特定部分**（中の一行など）へのリンクはサポートされていない。

## リンクの表示テキスト変更

### ウィキリンク形式

パイプ `|` で表示テキストを指定：

```md
[[Example|カスタム名]]
[[Example#Details|セクション名]]
```

### Markdown形式

通常のMarkdown構文：

```md
[カスタム名](Example.md)
[セクション名](Example.md#Details)
```

> 同じノートを保管庫全体で別名参照したい場合は **エイリアス** を使う。表示テキスト変更は特定箇所での見た目のカスタマイズ用。

## ファイル埋め込み

内部リンクの前に `!` を追加すると埋め込みになる。

### ノートの埋め込み

```md
![[内部リンク]]
![[内部リンク#^b15695]]   # ブロック埋め込み
![[内部リンク#見出し]]    # 見出し以下を埋め込み
```

### 画像の埋め込み

```md
![[Engelbart.jpg]]
![[Engelbart.jpg|640x480]]   # 幅x高さ
![[Engelbart.jpg|100]]       # 幅のみ（アスペクト比維持）
```

外部画像をMarkdown形式で埋め込み（幅指定可）：

```md
![250](https://example.com/img.jpg)
```

### 音声ファイル

```md
![[Excerpt from Mother of All Demos (1968).ogg]]
```

### PDF

```md
![[Document.pdf]]
![[Document.pdf#page=3]]      # 特定ページ
![[Document.pdf#height=400]]  # ピクセル単位の高さ指定
```

### リストの埋め込み

リストにブロック識別子を付けて参照：

```md
- 項目1
- 項目2

^my-list-id
```

```md
![[My note#^my-list-id]]
```

### 検索結果の埋め込み

検索プラグインの機能。詳細は[検索ヘルプ](https://obsidian.md/help/search)参照。

## ホバープレビュー

リンクにホバー（編集モードでは `Ctrl`/`Cmd` 押しながら）するとプレビューが表示される。**設定 → ページプレビュー** を有効化する必要がある。

## ファイル名変更時の挙動

Obsidianは保管庫内の内部リンクを自動更新する。確認を求めるよう変更するには **設定 → ファイルとリンク → 内部リンクを毎回更新する**。
