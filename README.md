# YATA (八咫) - AI Intelligence Grimoire
> **The Three-Legged Guide to the Web.**
> **情報の海を導き、真実を映し出す。あなたのための「AIインテリジェンス・パートナー」。**

本書は、AI駆動型RSS収集・分析プラットフォーム「YATA」の全貌を記したマスターマニュアル（虎の巻）である。
導入から高度な検索テクニック、内部アーキテクチャまでを網羅する。

---

## ⛩️ コンセプト：三本足の導き手
名前の由来は、日本神話の「八咫烏（ヤタガラス）」と「八咫鏡（ヤタノカガミ）」。

1.  **収集 (Collection)**: 広大なWebから鮮度の高い情報を掴む足。並列処理による高速RSS巡回。
2.  **分析 (Analysis)**: 本質を見抜き、過去からの文脈を紡ぐ足。LLMによる要約と予兆検知。
3.  **伝達 (Dispatch)**: 必要な時に、必要な形（メール/Web）で届ける足。パーソナライズされたインサイト。

この3つの機能を調和させ、情報のノイズを 90% 削減しつつ、意思決定に必要なインサイトを抽出することが本システムの使命である。

---

## 🚀 Key Features

### 1. インテリジェント・モニタリング
*   **重複排除 & ボット対策**: URL正規化とタイトル一致確認により重複記事を徹底排除。ランダム待機とUser-Agent偽装で安定収集。
*   **多層監視**: 技術、ビジネス、論文など、登録されたあらゆるRSSソースを24時間監視。

### 2. 予兆（サイン）検知：Emerging Signal Engine
*   **マジョリティからの乖離**: 現在のトレンド重心から数学的に離れた「異質な記事」を検出。
*   **核形成 (Nucleation)**: 異なるソースで同時に語られ始めた「小さなシグナル」を特定し、将来のトレンドを予測。
*   **AIレポート**: なぜそれが予兆なのか、AIが定性的に分析して報告する。

### 3. ハイブリッド検索 & 高度なクエリ
*   **Semantic Search (意味検索)**: ベクトル埋め込み (Embedding) により、キーワードが一致しなくても「文脈」が近い記事をヒットさせる。
*   **Advanced Query**: AND/OR/NOT やカッコを使った複雑な論理検索が可能。

### 4. パーソナライズド・レポート
*   **日刊/週刊の自動切り替え**: ユーザーごとのライフスタイルに合わせて配信頻度を自動調整。
*   **コンテキスト認識**: 過去のダイジェスト履歴を参照し、「先週からの進展」を含めたストーリーのあるレポートを生成。

---

## 📖 User Guide (虎の巻・壱：活用編)

### 1. 検索クエリの書き方
`Keywords` シートや `Users` シートで設定するキーワードは、以下の高度な演算子をサポートしています。

| 検索タイプ | 記法例 | 説明 |
| :--- | :--- | :--- |
| **AND検索** | `AI 医療` | 両方の単語を含む記事 (スペース区切り) |
| **OR検索** | `Python OR Ruby` | いずれかの単語を含む記事 (**大文字**で指定) |
| **NOT検索** | `Apple -Fruit` | Appleを含み、Fruitを**含まない**記事 |
| **グループ化** | `(AI OR 機械学習) 医療` | カッコで優先順位を指定可能 |
| **複合** | `(EV OR 電気自動車) -テスラ` | EVまたは電気自動車だが、テスラ以外の記事 |

> **⚠️ 注意**: 演算子の優先順位は `NOT` > `AND` > `OR` です。
> 例: `A OR B AND C` は `A OR (B AND C)` として解釈されます。意図した結果にならない場合は `()` で囲んでください。

### 2. シート設定の仕様

#### 👥 Users シート (配信設定)
| 列 | 項目名 | 設定値の例 | 説明 |
| :--- | :--- | :--- | :--- |
| A | Name | Boncoli | ユーザー名 |
| B | Email | user@example.com | 配信先メールアドレス |
| C | Day | `月` / `(空欄)` | `空欄`=毎日(日刊)、`曜日`=週1回その曜日に配信(週刊) |
| D | Keywords | `AI, 半導体` | このユーザー専用の関心キーワード(カンマ区切り) |
| E | Semantic | `TRUE` | `TRUE`にするとベクトル検索(意味検索)を有効化 |

#### 🔑 Keywords シート (全体トレンド監視)
| 列 | 項目名 | 説明 |
| :--- | :--- | :--- |
| A | Query | 上記の「検索クエリ」を入力 |
| B | Flag | `TRUE` で有効、`FALSE` で一時停止 |
| C | Day | (現在未使用 / 将来用) |
| D | Label | レポートでの表示名 (Queryが複雑な場合に短縮名を設定) |

### 3. Web UI (検索アーカイブ)
*   デプロイされたWebアプリのURLにアクセスすると、過去の記事データベースからオンデマンドで検索・分析が可能です。
*   **機能**: 期間指定検索、トレンド分析レポートの即時生成。

---

## 🛠️ Setup & Maintenance (虎の巻・弐：導入・保守編)

### 1. 必須環境変数 (Script Properties)
動作には以下のスクリプトプロパティの設定が必須です。

#### 🔑 API Keys & Endpoints
| プロパティ名 | 説明 | 例 / 備考 |
| :--- | :--- | :--- |
| `EXECUTION_CONTEXT` | 実行コンテキスト (`COMPANY` or `PERSONAL`) | 優先するLLMプロバイダを決定 |
| `OPENAI_API_KEY` | **Azure OpenAI** 用のAPIキー | ※変数名に注意 (Azure用) |
| `OPENAI_API_KEY_PERSONAL` | **本家 OpenAI** 用のAPIキー | 個人利用時のフォールバック先 |
| `GEMINI_API_KEY` | **Google Gemini** 用のAPIキー | 最終バックアップ用 |
| `AZURE_ENDPOINT_URL_NANO` | Azure (高速モデル) エンドポイント | GPT-4o-mini 等 |
| `AZURE_ENDPOINT_URL_MINI` | Azure (高精度モデル) エンドポイント | GPT-4o 等 |
| `AZURE_EMBEDDING_ENDPOINT` | Azure Embedding エンドポイント | ベクトル生成用 |
| `OPENAI_EMBEDDING_MODEL` | OpenAI Embedding モデル名 | `text-embedding-3-small` 等 |

#### ⚙️ System Settings
| プロパティ名 | 説明 | デフォルト値 |
| :--- | :--- | :--- |
| `DIGEST_DAYS` | トレンド分析のデフォルト遡り日数 | `7` |
| `DIGEST_TOP_N` | 1トピックあたりの最大採用記事数 | `20` |
| `MAIL_TO` | 管理者メールアドレス (カンマ区切り) | エラー通知やテスト用 |
| `MAIL_SENDER_NAME` | メール送信者名 | `YATA (AI Intelligence Bot)` |
| `DIGEST_SHEET_URL` | メールのフッターに記載するシートURL | |

### 2. LLMフォールバック戦略
`LlmService` は以下の優先順位でAPIを呼び出し、障害時や制限到達時に自動で次候補へ切り替えます。

**Case: EXECUTION_CONTEXT = `COMPANY` (会社用)**
1.  🟦 **Azure OpenAI** (Primary)
2.  🟩 **OpenAI (Personal)** (Secondary)
3.  ✨ **Gemini** (Final Backup)

**Case: EXECUTION_CONTEXT = `PERSONAL` (個人用)**
1.  🟩 **OpenAI (Personal)** (Primary)
2.  🟦 **Azure OpenAI** (Secondary)
3.  ✨ **Gemini** (Final Backup)

### 3. デバッグ・メンテナンスコマンド
スクリプトエディタから手動実行できる便利な関数です。

*   `runAllTests()`: 検索ロジック、ベクトル計算、AppConfigの健全性を一括テストします。修正後は必ず実行してください。
*   `debugRssFeed()`: 特定のRSSが取得できない場合、生のレスポンスヘッダーやXML構造をログ出力して診断します。
*   `maintenanceDeleteOldArticles()`: `DATA_RETENTION_MONTHS` (デフォルト6ヶ月) より古い記事を物理削除し、スプレッドシートの肥大化を防ぎます。

---

## 📜 History / Changelog

| Version | Date | Key Updates |
| :--- | :--- | :--- |
| **v3.2.0** | 2026-01-02 | **Logic & Config Refinement**<br>ベクトル生成精度向上(翻訳ロジック改善)、検索クエリ優先順位修正(AND>OR)、設定値(AppConfig)の集約化。 |
| **v3.1.0** | 2025-12-29 | **Performance & Scale Update**<br>RSS収集の並列化、レポート生成の高速化、AI意味検索のメモリ最適化。 |
| **v3.0.0** | 2025-12-27 | **Emerging Intelligence Edition**<br>「予兆（サイン）検知」エンジン搭載。核形成 (Nucleation) の数学的検知。 |
| **v2.9.0** | 2025-12-27 | **Refactoring**<br>定数・設定管理の集約化、テストスイートの実装。 |
| **v2.5.0** | 2025-12-25 | **Semantic Search**<br>ベクトル検索 (Embedding) 実装。ハイブリッド検索対応。 |
| **v2.0.0** | 2025-12-23 | **Rebranding to "YATA"**<br>プロジェクト名変更、セキュリティ強化、アーキテクチャ刷新。 |
| **v1.x** | 2025-11〜 | **Initial Development**<br>RSS収集、OpenAI/Gemini連携、Web UI実装。 |