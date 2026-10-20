# Obsidian Flavored Markdown (OFM) とタグ

出典:
- <https://obsidian.md/help/obsidian-flavored-markdown>
- <https://obsidian.md/help/tags>

## OFM の基本方針

ObsidianはCommonMark、GitHub Flavored Markdown、LaTeXをサポートしつつ、独自の拡張を行う。

### HTML内のMarkdown

> ⚠️ Obsidianは **HTML要素内のMarkdown構文をレンダリングしない**。これはパーサーの複雑さを抑えるための意図的な設計。

例：

```md
<div>
This **will not** be bold.
</div>
```

`<div>`、`<span>`、`<table>` などのHTMLタグ内では `**bold**` や `` `code` `` は処理されない。

## OFM拡張一覧（クイックリファレンス）

| 構文 | 説明 | 詳細 |
|---|---|---|
| `[[Link]]` | 内部リンク | `links-embeds.md` |
| `![[Link]]` | ファイルの埋め込み | `links-embeds.md` |
| `![[Link#^id]]` | ブロック参照 | `links-embeds.md` |
| `^id` | ブロックの定義 | `links-embeds.md` |
| `[^id]` | 脚注 | `basic-syntax.md` |
| `%%Text%%` | コメント | `basic-syntax.md` |
| `~~Text~~` | 取り消し線 | `basic-syntax.md` |
| `==Text==` | ハイライト | `basic-syntax.md` |
| ` ``` ` | コードブロック | `basic-syntax.md` |
| `- [ ]` | 未完了タスク | `basic-syntax.md` |
| `- [x]` | 完了タスク | `basic-syntax.md` |
| `> [!note]` | コールアウト | `callouts.md` |
| `\|...\|` | 表 | `advanced-syntax.md` |
| ` ```mermaid ` | Mermaidダイアグラム | `advanced-syntax.md` |
| `$...$` / `$$...$$` | MathJax数式 | `advanced-syntax.md` |

## タグ

### 基本

ハッシュ記号 `#` に続けてキーワード：

```md
#meeting
#project
```

### YAMLプロパティでのタグ

`tags`プロパティで追加可能。**必ずリスト形式**：

```yaml
---
tags:
  - recipe
  - cooking
---
```

### ネストされたタグ

スラッシュ `/` で階層化：

```md
#inbox/to-read
#inbox/processing
#project/acme/auth
```

検索 `tag:inbox` は `#inbox`、`#inbox/to-read` 等すべてにマッチする。タグペインでは親タグの下にネスト表示される。

Bases の `hasTag` 関数も親タグに一致する：`file.hasTag("a")` は `#a` と `#a/b` の両方にマッチ。

### 使用可能な文字

- アルファベット
- 数字
- アンダースコア `_`
- ハイフン `-`
- スラッシュ `/`（ネスト用）

### タグの規則

- **数字以外の文字が少なくとも1つ必要**：`#1984` は無効、`#y1984` は有効
- **大文字小文字を区別しない**：`#tag` と `#TAG` は同一
- 表示はタグペインで最初に作成された時の表記
- **空白を含めることはできない**

### 複数語タグの慣例

- `#camelCase`
- `#PascalCase`
- `#snake_case`
- `#kebab-case`

### タグ検索

検索プラグインで `tag` 演算子：

```
tag:#meeting
```

または、ノート内のタグをクリック、コマンドパレットから「タグ: タグペインを表示」。

## YAMLフロントマター（プロパティ）

ノート先頭の `---` 区切り内にYAMLでメタデータを記述。

```yaml
---
title: ノートのタイトル
tags:
  - example
  - reference
created: 2026-05-09
aliases:
  - 別名1
  - 別名2
publish: true
permalink: my-note
---
```

主要なプロパティ：

| プロパティ | 用途 |
|---|---|
| `tags` | タグ（リスト形式） |
| `aliases` | 別名（リスト形式） |
| `cssclasses` | カスタムCSSクラス |
| `publish` | Obsidian Publishで公開するか |
| `permalink` | Publishでの固定URL |

詳細は [Properties](https://obsidian.md/help/properties)。
