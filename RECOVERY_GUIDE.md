# YATA システム 災害復旧 (Disaster Recovery) ガイド

このドキュメントは、Raspberry PiのSDカードが物理的にクラッシュ、またはシステムが起動不能になるなど、致命的な障害が発生した際に、NAS上のバックアップデータからYATAシステムを完全復旧させるための手順書です。

## 1. 必要なもの
*   新しい MicroSD カード（32GB以上推奨）
*   Raspberry Pi Imager 等のOS書き込みツール
*   同一ネットワークに接続されたPC

---

## 2. 復旧手順

### Step 1: OSのクリーンインストールと初期設定
1.  新しいSDカードに Raspberry Pi OS (64-bit または使用していたバージョン) をインストールします。
    *   *※可能であれば、事前に作成しておいたシステムのフルバックアップイメージ（imgファイル）を使用すると、Step 2以降を大幅に省略できます。*
2.  Raspberry Piを起動し、ネットワーク（Wi-Fi/有線）に接続します。
3.  SSHを有効化し、PCからリモート接続できるようにします。
    *   ユーザー名は必ず以前と同じ（例: `boncoli`）に設定してください。

### Step 2: NASのマウント再構築
バックアップデータを取り出すために、NASを再マウントします。

1.  マウントポイントを作成します。
    ```bash
    sudo mkdir -p /mnt/nas
    ```
2.  バックアップされている `/etc/fstab` の記述を確認し、同じようにマウントします。
    *   手動で一時的にマウントする場合の例:
        ```bash
        sudo mount -t cifs -o username=YOUR_NAS_USER,password=YOUR_NAS_PASS,uid=1000,gid=1000 //YOUR_NAS_IP/YOUR_SHARE /mnt/nas
        ```

### Step 3: ホームディレクトリ（YATA本体とデータ）の復元
NAS上の `home_backup` から、YATAのコード、設定、Python環境、ログなどすべてを丸写しで書き戻します。

1.  rsyncコマンドでデータを復元します。
    ```bash
    rsync -av /mnt/nas/home_backup/ /home/boncoli/
    ```
    *※ `.env`（環境変数）や `.gemini/GEMINI.md`（記憶）、`yata-local/` 配下などの見えないファイルもすべて復元されます。*

### Step 4: データベースの最新化（必要な場合）
Step 3 の復元データには昨晩のバックアップ時点の `yata.db` が含まれていますが、もし最新のバックアップ（`yata_db_history/` 内）の方が新しければ、そちらをコピーします。

```bash
cp /mnt/nas/yata_db_history/yata_YYYYMMDD.db /home/boncoli/yata-local/yata.db
```

### Step 5: パッケージと環境の再構築
OSがクリーンな状態のため、Node.jsやPythonパッケージなどを入れ直す必要があります。

1.  **システムパッケージの復元**:
    ```bash
    sudo dpkg --set-selections < /home/boncoli/package_list.txt
    sudo apt-get dselect-upgrade
    ```
2.  **Node.js / PM2 / better-sqlite3 の再インストール**:
    *   nvmを使ってNode.jsをインストール（`v24.12.0`）。
    *   `npm install -g pm2`
    *   `cd /home/boncoli/yata-local && npm install` (ここで better-sqlite3 等がビルドされます)

### Step 6: スケジュールと常駐プロセスの復元
1.  **Cron設定の復元**:
    ```bash
    crontab /home/boncoli/crontab_last.txt
    ```
    *復元後、`crontab -l` で設定が反映されているか確認します。*

2.  **常駐サーバー (YATA Server) の起動**:
    ```bash
    cd /home/boncoli/yata-local
    pm2 start server.js --name yata-server
    pm2 save
    pm2 startup
    ```

3.  **log2ram の再設定 (重要)**:
    SDカード保護のため、必ず log2ram を再インストールし、`/etc/log2ram.conf` に `/home/boncoli/yata-local/logs` を追加してください。

---

## 3. 復旧後の確認
*   `http://[RasPiのIP]:3001/` にアクセスし、ポータル画面が開くか確認する。
*   `pm2 status` で `yata-server` が Online になっているか確認する。
*   Discordの `#system-alerts` や `#yata-digest` にテスト投稿が飛ぶか確認する。

以上で復旧は完了です。