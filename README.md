# my-pages

資料置き場。`content/` にファイルを置いて push すると GitHub Pages にデプロイされ、
ディレクトリ構造から index ページが自動生成される。

## 使い方

```sh
# 資料を追加
cp ~/Downloads/なにか.html content/network/

# ローカルで確認 (build + http://localhost:4173)
npm run dev

# push すれば自動デプロイ
git add -A && git commit -m "add: なにか" && git push
```

## ルール

| content/ の中身 | 結果 |
| --- | --- |
| `foo.html` | ページとして一覧に載る。`<title>` がカードのタイトル、`<meta name="description">` または最初の `<p>` が説明文 |
| `dir/` | フォルダ。`dir/index.html` が自動生成され、中身が一覧になる（何階層でも可） |
| `dir/index.html` を自前で持つ | そのディレクトリ全体を 1 つのサイト/アプリとして扱い、index は生成しない |
| `.pdf` `.png` `.md` など | ファイルとして一覧に載る（リンク+サイズ表示） |
| `_` や `.` で始まる名前 | 無視 |

- 更新日は git の最終コミット日時（未コミットなら mtime）
- サイト名・説明は `site.json`
- ビルド出力は `dist/`（git 管理外）
- 依存パッケージなし。Node 20+ だけあれば動く
