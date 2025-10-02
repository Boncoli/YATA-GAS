# RSScollect - Google Apps ScriptによるRSSフィード収集・AI見出し生成・週次ダイジェスト

## 概要
このGoogle Apps Script (GAS) プロジェクトは、指定されたRSSフィードから記事を自動的に収集し、Googleスプレッドシートに保存します。さらに、収集した記事の抜粋やタイトルを基に、AI (GeminiまたはAzure OpenAI) を利用して「ネットニュース風の見出し」を生成し、スプレッドシートに追記します。また、設定に応じて週次で記事のダイジェストをメールやMicrosoft Teamsに通知する機能も備えています。

## 機能
- **RSSフィード収集**: 登録されたRSSフィードから最新記事を自動取得し、重複を排除してスプレッドシートに追記します。
- **AI見出し生成**: 記事の抜粋やタイトルから、AIがキャッチーで簡潔な日本語の見出しを生成します。
  - 短い記事や抜粋がない場合は、タイトルを基に自動翻訳（英語の場合）またはそのまま見出しとして利用します。
  - AIモデルはGeminiまたはAzure OpenAIを選択可能です。
- **週次ダイジェスト**: 過去N日間の記事から重要度を算出し、上位記事をまとめたダイジェストを作成します。
  - 重要度はヒューリスティックなスコアリングと、オプションでAIによる重み付けが可能です。
  - ダイジェストはMarkdown形式で生成され、メールまたはMicrosoft Teamsに送信できます。
- **HTMLタグ除去**: 記事の抜粋から不要なHTMLタグを除去し、クリーンなテキストとして扱います。
- **スプレッドシートの自動ソート**: 記事追加後、スプレッドシートを日付で自動的に昇順ソートします。

## スプレッドシートの構造

### 1. `RSS` シート (RSSフィードリスト)
RSSフィードのURLとサイト名を管理します。

| 列 | ヘッダー名 | 説明 | 例 |
|---|---|---|---|
| A | サイト名 | RSSフィードの提供元サイト名 | `Google Developers Japan` |
| B | RSS URL | RSSフィードのURL | `https://developers.google.com/japan/blog/rss.xml` |

### 2. `collect` シート (収集データ)
収集された記事データとAI生成見出しが保存されます。

| 列 | ヘッダー名 | 説明 | 例 |
|---|---|---|---|
| A | 日付 | 記事の公開日時 (pubDate/updated) | `2023/10/26 10:00` |
| B | 元タイトル | 記事の元のタイトル | `Google Cloud Next '23 で発表された生成 AI の最新情報` |
| C | URL | 記事のURL | `https://cloud.google.com/blog/ja/products/ai-ml/generative-ai-updates-from-google-cloud-next-23` |
| D | 抜粋 | 記事の抜粋または概要 (HTMLタグ除去済み) | `Google Cloud Next '23 では、生成 AI の最新情報が多数発表されました。` |
| E | 見出し（AI生成） | AIが生成したネットニュース風の見出し | `Google Cloud Next '23、生成AIの最新動向を発表` |
| F | ソース | 記事のソースサイト名 (RSSシートのサイト名) | `Google Developers Japan` |

## 設定方法

### 1. Google Apps Script プロジェクトの作成
1. Googleスプレッドシートを開き、「拡張機能」>「Apps Script」を選択してスクリプトエディタを開きます。
2. `RSScollect.js` の内容をスクリプトエディタにコピー＆ペーストします。
3. プロジェクト名を「RSScollect」など、任意の分かりやすい名前に変更します。

### 2. 必要なAPIの有効化
このスクリプトは以下のGoogleサービスを利用します。
- **Google Sheets API**: スプレッドシートの読み書きに必要です。
- **URL Fetch Service**: RSSフィードの取得に必要です。
- **Properties Service**: スクリプトプロパティの管理に必要です。
- **Gmail Service (メール通知を利用する場合)**: メール送信に必要です。

これらのサービスは通常、Apps Scriptのプロジェクトで自動的に有効化されますが、もしエラーが発生する場合は「リソース」>「詳細Googleサービス」から手動で有効化してください。

### 3. スクリプトプロパティの設定
スクリプトエディタの左側メニューにある「プロジェクトの設定」（歯車アイコン）をクリックし、「スクリプトプロパティ」セクションで以下のプロパティを設定します。

| プロパティ名 | 説明 | 設定例 | 必須/任意 |
|---|---|---|---|
| `GEMINI_API_KEY` | Gemini APIを利用する場合のAPIキー | `AIzaSy...` | AI見出し生成にGeminiを利用する場合必須 |
| `AZURE_ENDPOINT_URL` | Azure OpenAIを利用する場合のエンドポイントURL | `https://your-resource-name.openai.azure.com/openai/deployments/your-deployment-name/chat/completions?api-version=2023-07-01-preview` | AI見出し生成にAzure OpenAIを利用する場合必須 |
| `OPENAI_API_KEY` | Azure OpenAIを利用する場合のAPIキー | `your-azure-openai-api-key` | AI見出し生成にAzure OpenAIを利用する場合必須 |
| `OPENAI_API_KEY_PERSONAL` | 個人的なOpenAI APIを利用する場合のAPIキー | `sk-...` | AI見出し生成にOpenAI APIを利用する場合必須 |
| `DIGEST_DAYS` | 週次ダイジェストの集計日数 | `7` (既定値) | 任意 |
| `DIGEST_TOP_N` | 週次ダイジェストで表示する上位記事数 | `20` (既定値) | 任意 |
| `DIGEST_USE_AI_RANK` | 週次ダイジェストでAIによる重要度重み付けを利用するか (`Y`/`N`) | `N` (既定値) | 任意 |
| `DIGEST_USE_AI_TLDR` | 週次ダイジェストでAIによる1行要約を利用するか (`Y`/`N`) | `N` (既定値) | 任意 |
| `DIGEST_AI_CANDIDATES` | AIに渡す最大候補数 (AIランキング/要約利用時) | `50` (既定値) | 任意 |
| `NOTIFY_CHANNEL_WEEKLY` | 週次ダイジェストの通知先 (`teams`, `email`, `both`, `none`) | `none` (既定値) | 任意 |
| `TEAMS_WEBHOOK_URL` | Microsoft Teamsへの通知に利用するWebhook URL | `https://outlook.office.com/webhook/...` | `NOTIFY_CHANNEL_WEEKLY` が `teams` または `both` の場合必須 |
| `MAIL_TO` | メール通知の送信先メールアドレス (カンマ区切りで複数指定可) | `your-email@example.com` | `NOTIFY_CHANNEL_WEEKLY` が `email` または `both` の場合必須 |
| `MAIL_SUBJECT_PREFIX` | メール件名のプレフィックス | `【週間RSS】` (既定値) | 任意 |
| `MAIL_SENDER_NAME` | メール送信者名 | `RSS要約ボット` (既定値) | 任意 |

**注意:** AIモデルの選択は以下の優先順位で行われます。
1. `AZURE_ENDPOINT_URL` と `OPENAI_API_KEY` が設定されている場合: Azure OpenAI
2. `OPENAI_API_KEY_PERSONAL` が設定されている場合: 個人的なOpenAI API
3. `GEMINI_API_KEY` が設定されている場合: Gemini API
いずれも設定されていない場合はAI見出し生成は行われません。

## 使い方

### Google Apps Scriptのトリガー設定

このスクリプトは、Google Apps Scriptのトリガー機能を利用して定期的に実行することを想定しています。トリガーを設定することで、手動でスクリプトを実行する手間を省き、自動運用が可能になります。

#### トリガー設定手順

1.  Apps Scriptエディタの左側メニューにある「トリガー」（時計アイコン）をクリックします。
2.  画面右下にある「トリガーを追加」ボタンをクリックします。
3.  以下の各トリガー設定を参考に、必要なトリガーを追加します。

#### 1. デイリートリガー (RSSフィードの収集と見出し生成)

-   **目的**: RSSフィードを定期的に収集し、AIによる見出し生成を行います。
-   **実行する関数を選択**: `mainAutomationFlow`
-   **実行するデプロイを選択**: `Head` (通常はデフォルト)
-   **イベントのソースを選択**: `時間主導型`
-   **時間ベースのトリガーのタイプを選択**: `日ベースのタイマー`
-   **時刻を選択**: 任意の時間帯（例: `午前 0 時～1 時`）

#### 2. ウィークリートリガー (週次ダイジェストの作成と通知)

-   **目的**: 過去1週間の記事からダイジェストを作成し、設定されたチャネルに通知します。
-   **実行する関数を選択**: `weeklyDigestJob`
-   **実行するデプロイを選択**: `Head` (通常はデフォルト)
-   **イベントのソースを選択**: `時間主導型`
-   **時間ベースのトリガーのタイプを選択**: `週ベースのタイマー`
-   **曜日を選択**: 任意の曜日（例: `月曜日`）
-   **時刻を選択**: 任意の時間帯（例: `午前 9 時～10 時`）

### 手動実行

各関数は、Apps Scriptエディタのツールバーから関数を選択し、実行ボタン（▶アイコン）をクリックすることで手動で実行することも可能です。

## 注意事項
- **APIキーの管理**: APIキーは機密情報です。スクリプトプロパティに安全に保存し、コード内に直接書き込まないでください。
- **レート制限**: AIサービスやUrlFetchAppにはレート制限があります。`DELAY_MS` の値を調整するなどして、APIの呼び出し頻度を適切に制御してください。
- **エラーハンドリング**: スクリプト実行中にエラーが発生した場合、Apps Scriptの「実行ログ」で詳細を確認できます。
- **スプレッドシートの保護**: `RSS` シートや `collect` シートのヘッダー行は、誤って変更されないように保護することを推奨します。
- **AIの出力**: AIが生成する見出しや要約は、常に完璧とは限りません。必要に応じて手動での修正を検討してください。
