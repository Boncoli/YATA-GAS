# YATA (八咫) - Local AI Intelligence Hub (boncoli RasPi)
> **ラズパイで稼働する、あなた専用の「AI インテリジェンス・パートナー」。**
> **情報の海を導き、日々の移動を刻み、記憶を共有する。**

このファイルは、**boncoli RasPi エッジ環境** における YATA の構成と運用を記した専用の README です。本家（GAS版）との共通コードを維持しつつ、ローカル独自の進化を遂げた機能群を網羅しています。

---

## 🚀 ローカル独自の主要機能 (Local Features)

### 1. 🤖 AI コンシェルジュ & Portal
- **ポータル画面**: スマホ最適化された `portal.html` から、システムの健康状態やニュースを確認。
- **LINE風チャット**: Gemini 2.5 Flash-Lite を搭載した秘書と対話。TODO 管理や調べ物をお手伝い。
- **自己進化する記憶**: チャットで「〜を覚えておいて」と頼むと、AI が自ら `GEMINI.md` を書き換え。

### 2. 🧠 Shared Memory (記憶の同期システム)
- **全デバイス共有**: ラズパイ上の記憶 (`GEMINI.md`) を NAS (DS220j) 経由で Win / Mac と同期。
- **Function Calling**: AIが会話の中から重要な情報を抽出し、自動的にグローバルな記憶ファイルへ書き込み・同期を実行。

### 3. 🚗 インテリジェント・ドライブログ (CX-80 連携)
- **CarPlay 連動**: 車の乗降（InCar / OutCar）をトリガーに、位置・高度・バッテリーを自動記録。
- **自動距離計算**: OSRM API を活用し、走行区間の道路距離を自動算出し Discord へ即時レポート。
- **位置継承**: 停車位置から近い場所での再出発時、GPS 誤差を排除して正確な地点を維持。

### 4. ⛽ 燃費・給油ダッシュボード
- **即時解析**: iPhone からの給油記録をリアルタイムに処理し、区間燃費を算出。
- **自動通知**: 「今回の燃費は ○○ km/L でした！」と Discord へ即座にフィードバック。

### 5. 🛡️ 堅牢なエッジ設計 (SD Protection)
- **RAMディスク運用**: SQLite DB をメモリ上に展開 (`/dev/shm`) して運用。`run-ram.sh` により、終了時のみ物理ディスクへ書き戻すことで SD カードの寿命を保護。

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

---

## 📖 関連ドキュメント (Local Docs)

- **[PROJECT_GUIDE.md](./PROJECT_GUIDE.md)**: ローカル環境の運用・設定・APIに関する「虎の巻」。
- **[PROJECT_ARCHITECTURE.md](./PROJECT_ARCHITECTURE.md)**: Mermaid による詳細なシステム構成図。
- **[TODO.md](./TODO.md)**: ローカル環境での課題と今後の野望。

---

**YATA Local Project** - *Personal Intelligence Environment on boncoli*
