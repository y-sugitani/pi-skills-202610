---
name: obsidian-syntax
description: >
  Obsidian Flavored Markdown（ウィキリンク・埋め込み・コールアウト・Mermaid 等）。
  vault ノートの作成・編集、または OFM 構文に言及したときに使う。
---

# Obsidian構文 Skill

Obsidianの公式ドキュメント（[obsidian.md/help](https://obsidian.md/help)）を出典とした、Obsidian Markdown構文の網羅的なリファレンス。

Obsidianは [CommonMark](https://commonmark.org/)、[GitHub Flavored Markdown](https://github.github.com/gfm/)、[LaTeX](https://www.latex-project.org/) をサポートしており、Obsidian独自の拡張（ウィキリンク、埋め込み、ブロック参照、コールアウトなど）を Obsidian Flavored Markdown(OFM) と呼ぶ。

## 使い方

ノートを書く前に、関連するリファレンスを読む。

| やりたいこと | リファレンス |
|---|---|
| 見出し・リスト・コードブロック・脚注・コメント・エスケープ | `references/basic-syntax.md` |
| 表（アラインメント）・Mermaidダイアグラム・MathJax数式 | `references/advanced-syntax.md` |
| コールアウト（`> [!info]` 等）の全タイプ・折りたたみ・ネスト・カスタム化 | `references/callouts.md` |
| 内部リンク・見出しリンク・ブロック参照・表示テキスト変更 | `references/links-embeds.md` |
| ファイル埋め込み（ノート/画像/音声/PDF/リスト/検索結果） | `references/links-embeds.md` |
| OFM拡張一覧・タグ・ネストタグ・YAMLでのタグ | `references/ofm-and-tags.md` |

## 重要な原則

1. **ウィキリンクが第一級**: 内部参照は基本的に `[[ノート名]]` 形式を使う。Markdown形式 `[名前](path.md)` も併用可だが、Obsidianはデフォルトでウィキリンクを生成する。

2. **HTML内のMarkdownはレンダリングされない**: `<div>**bold**</div>` のような書き方では太字にならない。これはパフォーマンスのための意図的な設計。

3. **コードブロックのフェンス文字**: ネストしたコードブロックを書くときは、**外側を内側より多くの**バッククォート（またはチルダ）で囲む。Mermaid内にコードを示す場合などに重要。

4. **コールアウトは引用ブロックの拡張**: 通常の `>` 引用の最初の行に `[!type]` を加えるとコールアウトになる。`-` で初期折りたたみ、`+` で初期展開。

5. **ブロック参照はObsidian固有**: `^id` と `[[note#^id]]` は標準Markdownではなくbeyond-Obsidianでは機能しない。相互運用性が必要な場面では避ける。

6. **タグの形式**: 数字のみのタグ（`#1984`）は無効。少なくとも1つの非数字文字が必要。スラッシュでネスト（`#inbox/to-read`）。

## 出典

すべての構文情報は Obsidian 公式ヘルプドキュメントから取得：

- [Basic formatting syntax (基本的な書式構文)](https://obsidian.md/help/syntax)
- [Advanced formatting syntax (高度な書式構文)](https://obsidian.md/help/advanced-syntax)
- [Callouts (コールアウト)](https://obsidian.md/help/callouts)
- [Internal links (内部リンク)](https://obsidian.md/help/links)
- [Embedding files (ファイルの埋め込み)](https://obsidian.md/help/embeds)
- [Obsidian Flavored Markdown](https://obsidian.md/help/obsidian-flavored-markdown)
- [Tags (タグ)](https://obsidian.md/help/tags)

## 由来とライセンス

本 skill と `references/` は [kepano/obsidian-skills](https://github.com/kepano/obsidian-skills)（MIT License, Copyright (c) 2026 Steph Ango (@kepano)）を元にしている。ライセンス全文はパッケージ同梱の `NOTICE` を参照。
