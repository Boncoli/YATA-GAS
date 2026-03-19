# YATA (八咫) - Local AI Intelligence Hub (boncoli RasPi)
[![Version](https://img.shields.io/badge/version-1.2.5-green.svg)]()
[![Platform](https://img.shields.io/badge/platform-Raspberry%20Pi%205-red.svg)]()

> **ラズパイで稼働する、あなた専用の「AI インテリジェンス・パートナー」。**
> **情報の海を導き、日々の移動を刻み、記憶を共有する。**

このファイルは、**boncoli RasPi エッジ環境** における YATA の構成と運用を記した専用の README です。本家（GAS版）との共通コードを維持しつつ、ローカル独自の進化を遂げた機能群を網羅しています。

---

## 🚀 ローカル独自の主要機能 (Local Features)

### 1. 🤖 AI コンシェルジュ & Portal
- **ポータル画面**: スマホ最適化された `portal.html` から、システムの健康状態やニュース、独り言ログをリアルタイム確認。
- **LINE風チャット**: `gpt-5-nano` を搭載した秘書と対話。TODO 管理や調べ物をお手伝い。
- **自己進化する記憶**: チャットで「〜を覚えておいて」と頼むと、AI が自ら `GEMINI.md` を書き換え。

### 2. 🧠 Shared Memory & Digital Twin
- **全デバイス共有**: ラズパイ上の記憶 (`GEMINI.md`) を NAS (DS220j) 経由で Win / Mac と同期。
- **独り言キャッチャー (Voice Catcher)**: ローカルマイクとWhisperで独り言をテキスト化し、ハイブリッド(Gemini/Gemma)で思考・関心を抽出・蓄積。
- **ローカルLLM自律稼働**: Gemma 3 4B-ITによる深層解析や自律的な「時報ボヤキ」機能。熱暴走防止の安全装置付き。

### 3. 🚗 インテリジェント・ドライブログ & ヘルスケア
- **CarPlay 連動**: 車の乗降（InCar / OutCar）をトリガーに、位置・高度・バッテリーを自動記録し、距離を算出してDiscordへ通知。
- **燃費・給油ダッシュボード**: iPhone からの給油記録をリアルタイムに処理し、区間燃費を算出して自動通知。
- **統合ヘルスケアログ**: 歩数、睡眠（AutoSleep）、HRV、安静時心拍、消費カロリーを1日1行のレコードに集約し自動分析。

### 4. 🛡️ 堅牢なエッジ設計 & 3層ログアーキテクチャ
- **RAMディスク運用**: SQLite DB をメモリ上に展開 (`/dev/shm`) して運用。終了時のみ物理ディスクへ書き戻し、SDカードを保護。
- **3層ログ戦略 (RAM/NAS/SD)**: 揮発性ログ（RAM）、長期保存（NAS）、致命的エラー（SD）を明確に分離し、日常のSD書き込みを完全にゼロ化。
- **自動復旧・フェイルセーフ**: OOM枯渇を防ぐための軽量同期通信（curl移行）や、自動アーカイブ（180日）・VACUUMなど、長期間の放置に耐えうる自律システム。

---

## 🏗️ システム構成 (Architecture Summary)

```mermaid
graph TD
    subgraph Input
        iPhone["📱 iPhone (Shortcuts)"]
        RSS["📡 RSS Feeds"]
    end

    subgraph RasPi ["🍓 Raspberry Pi (boncoli)"]
        Server["🚀 server.js (API/Portal)"]
        YATA["🧠 lib/YATA.js (AI Engine)"]
        DB[( "💾 RAM Disk DB (yata.db)" )]
        Memory["📝 GEMINI.md (Memory)"]
    end

    subgraph External
        NAS[("🗄️ NAS (DS220j)")]
        Discord["💬 Discord (Notification)"]
        LLM["🧠 Gemini 2.5 Flash-Lite"]
    end

    iPhone --> Server
    RSS --> YATA
    Server <--> DB
    YATA <--> DB
    Server <--> LLM
    LLM -- "Function Calling" --> Memory
    Memory <--> NAS
    Server --> Discord
```

### 🔄 データフロー (Data Flow)
1. **起動 (`@reboot`)**: `run-ram.sh` により RAM へ DB 展開。
2. **収集・要約**: 指定時間ごとに RSS 収集と AI 要約を実行 (`yata-task.js`)。
3. **常駐サーバー (`server.js`)**: iPhone からのログ（CarPlay / 給油 / ヘルスケア）をリアルタイムに受信し、距離計算や Discord 通知を実行。
4. **常駐ボット (`discord-bot.js`)**: リアルタイム対話と自律的な独り言を担当。
5. **AI 連携**: ポータル画面を通じてユーザーと対話し、`GEMINI.md` を書き換えて自己進化。
6. **終了・同期**: 定期的に RAM DB -> Disk DB へ書き戻し。

### ⚙️ 運行・プロセス・マップ (Service Architecture)
システムが「どこで何をしているか」の全体像です。

| プロセス名 | 実行主体 (PM2) | 主要な責務 | ポート/トリガー |
| :--- | :--- | :--- | :--- |
| **YATA Server** | `server.js` | Web UI提供、iPhoneログ受信、API提供 | **3001** |
| **YATA Bot** | `discord-bot.js` | Discord対話、メンション返答、自律的独り言 | Discord Mention |
| **Voice Catcher**| `catcher.py` | マイク音声の常時監視・テキスト化 | (常駐) |
| **Local Mutter** | `do-local-mutter.py` | 1時間毎の時報ボヤキ (Gemma 3 4B) | **Cron (0分)** |
| **Daily Digest** | `do-discord-digest.js`| 毎朝のニュース速報 (Gemini API) | **Cron (10:02)** |
| **Main Task** | `yata-task.js` | RSS収集、AI要約、DBメンテ | **Cron (26,56分)** |

---

## 📖 関連ドキュメント (Local Docs)

- **[PROJECT_GUIDE.md](./PROJECT_GUIDE.md)**: ローカル環境の運用・設定・APIに関する「虎の巻」。
- **[PROJECT_ARCHITECTURE.md](./PROJECT_ARCHITECTURE.md)**: Mermaid による詳細なシステム構成図。
- **[TODO.md](./TODO.md)**: ローカル環境での課題と今後の野望。

---

**YATA Local Project** - *Personal Intelligence Environment on boncoli*
