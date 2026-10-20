# Obsidian コールアウト

出典: <https://obsidian.md/help/callouts>

コールアウトは引用ブロックの最初の行に `[!type]` を加えると有効化される。Markdown、ウィキリンク、埋め込みをサポート。Obsidian Publishでもネイティブにサポート。

```md
> [!info] コールアウトタイトルの例
> コールアウトブロックです。
> **Markdown**、[[内部リンク|ウィキリンク]]、および[[ファイルの埋め込み|埋め込み]]をサポート！
> ![[Engelbart.jpg]]
```

## カスタムタイトル

タイプ識別子の後にテキストを追加する。

```md
> [!tip] コールアウトにはカスタムタイトルを付けられます
> このように。
```

タイトルのみのコールアウト：

```md
> [!tip] タイトルのみのコールアウト
```

## 折りたたみ可能なコールアウト

タイプ識別子の直後に `+`（デフォルト展開）または `-`（デフォルト折りたたみ）を追加：

```md
> [!faq]- コールアウトは折りたたみ可能ですか？
> はい！
```

```md
> [!info]+ デフォルトで展開
> 折りたたみ可能だが、最初は開いている。
```

## ネストされたコールアウト

引用のネストと同様に `>` を増やす：

```md
> [!question] コールアウトはネストできますか？
> > [!todo] はい！ネストできます。
> > > [!example] 複数のレベルのネストも使えます。
```

## サポートされるタイプ

タイプ識別子は **大文字小文字を区別しない**。サポートされていないタイプは `note` がデフォルトで使用される。

| タイプ | エイリアス |
|---|---|
| `note` | （デフォルト） |
| `abstract` | `summary`, `tldr` |
| `info` | |
| `todo` | |
| `tip` | `hint`, `important` |
| `success` | `check`, `done` |
| `question` | `help`, `faq` |
| `warning` | `caution`, `attention` |
| `failure` | `fail`, `missing` |
| `danger` | `error` |
| `bug` | |
| `example` | |
| `quote` | `cite` |

各タイプは異なる背景色とアイコンを持つ。

## カスタムコールアウトの定義

CSSスニペットで新しいタイプを定義できる：

```css
.callout[data-callout="custom-question-type"] {
    --callout-color: 0, 0, 0;
    --callout-icon: lucide-alert-circle;
}
```

- `data-callout` の値がタイプ識別子（例: `[!custom-question-type]`）
- `--callout-color` は RGB（0〜255）で背景色を定義
- `--callout-icon` は [lucide.dev](https://lucide.dev) のアイコンID、またはSVG要素

```css
--callout-icon: '<svg>...custom svg...</svg>';
```

> 注意: ObsidianのLucideアイコンバージョンは定期的に更新される。古いバージョンのアイコンを使うとレンダリングされない可能性がある。

## 挿入方法

- コマンドパレットで「コールアウトを挿入」（デフォルトは `[!note]`）
- 既存テキストを選択して「コールアウトを挿入」を実行 → 選択範囲が囲まれる
- ライブプレビューでコールアウト名を右クリック → タイプ変更
