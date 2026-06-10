# RetrieverX (godlink)

mangaraw.best 向け漫画ビューア。Flask + 静的フロントエンド。

## ローカル開発

```powershell
cd godlink
pip install -r requirements.txt
python extractor.py
```

ブラウザで **http://127.0.0.1:5000** を開く（`index.html` を直接開かない）。

同一 Wi-Fi のスマホ: 起動時に表示される `http://192.168.x.x:5000` →「ホーム画面に追加」

## Git（学校 ↔ 家）

```powershell
git clone https://github.com/あなたのユーザー名/godlink.git
cd godlink
pip install -r requirements.txt
python extractor.py
```

変更を送る:

```powershell
git add .
git commit -m "変更内容"
git push
```

## クラウド公開（Render・無料）

Python を PC で起動する必要がなくなり、URL だけでスマホから使えます。

1. [GitHub](https://github.com) にこのリポジトリを push
2. [Render](https://render.com) でアカウント作成（GitHub 連携）
3. **New → Blueprint** → このリポジトリを選択（`render.yaml` を読み込む）
4. デプロイ完了後、`https://godlink-xxxx.onrender.com` のような URL が発行される
5. スマホでその URL を開き「ホーム画面に追加」

### 注意（無料プラン）

- 15 分アクセスがないとスリープ → 最初の表示が 30 秒ほど遅いことがある
- 作品一覧の全ページ取得は時間がかかる（↻ 更新は Wi-Fi 推奨）

### Settings

クラウド URL から開けば API は自動設定されます。別サーバーを使う場合のみ Settings → サーバーURL を変更。

## ファイル構成

| ファイル | 役割 |
|---------|------|
| `extractor.py` | API + スクレイピング + 静的配信 |
| `app.js` / `index.html` / `style.css` | フロント UI |
| `manifest.json` | PWA（ホーム画面追加） |
| `render.yaml` | Render デプロイ設定 |
