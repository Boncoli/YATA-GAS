# RSS Collector & AI Intelligence Tool

![Version](https://img.shields.io/badge/version-2.7.1-blue.svg)

## 概要

このプロジェクトは、単なる「RSSリーダー」や「要約ツール」ではありません。
臨床検査・バイオ技術などの専門領域において、**「Webでの能動的な深掘り（Deep Dive）」**と**「日次・週次の定点観測（Trend Tracking）」**を両立させる、**AI駆動型のインテリジェンス・ツール**です。

膨大なニュース記事を自動収集・蓄積し、LLM（GPT-4o, Gemini等）が「新規技術の発見」や「トレンドの進捗（加速・停滞）」を分析して可視化します。

## コンセプトと提供価値

1.  **「点」ではなく「線」を見る（週刊トレンド分析）**
    * 過去の分析結果をシステムが記憶。先週の状況と今週のニュースをAIが突合し、「あの治験が進んだ」「この話題は沈静化した」といった**時間軸での変化**をレポートします。
2.  **「今」の「新規性」を掘り起こす（Webスポット検索）**
    * 会議前やアイデア出しの瞬間に、直近（約1ヶ月分）のデータから**「最新の技術的成果」や「重要な知見」**だけを抽出。リッチなHTMLレポートで即座に状況を把握できます。
3.  **持続可能な運用（メンテナンスフリー）**
    * 設定期間（デフォルト6ヶ月）を過ぎた古い記事は自動で削除。スプレッドシートの容量圧迫を防ぎます。

## 主な機能

### 1. Web UIによるスポット分析（Deep Dive）
* **目的**: 能動的なリサーチ。直近の「新規技術」や「ブレイクスルー」の発掘。
* **特徴**:
    * キーワードに関連する**直近60件**（約1ヶ月分相当）の記事を総ざらい分析。
    * **高度な検索**: `AND`検索（例: `AI 創薬`）だけでなく、`OR`検索（例: `がん or 腫瘍`）にも対応。
    * **「新規性（Novelty）」**にフォーカスし、既存技術との違いやインパクトを抽出。
    * CSS分離型の軽量HTMLによる、視認性の高いカード形式レポート。

### 2. 週刊トレンドレポート（Trend Tracking）
* **目的**: 受動的な定点観測。登録キーワードの「変化」の把握。
* **特徴**:
    * **柔軟な配信スケジュール**: `Keywords`シートの設定により、キーワードごとに「毎週月曜日」「月・木のみ」「毎日」など配信曜日を細かく指定可能。
    * **記事数厳選（Top 20）**: メールで読み切れる量に情報を凝縮。
    * **進捗タグ**: `[⚡ 新規]` `[🚀 進展]` `[➡️ 継続]` などのタグで、ステータス変化を一目で理解可能（プロンプト設定に依存）。

### 3. 日刊ダイジェスト（Daily Briefing）
* **目的**: 速報性の高い情報のキャッチアップ。
* **特徴**:
    * 過去24時間の全記事から重要トピックをAIが要約して毎朝配信。
    * 記事数が多い場合は自動的にバッチ分割処理を行い、網羅性と要約精度を維持。

### 4. 自動メンテナンス
* **目的**: スプレッドシートのパフォーマンス維持。
* **特徴**:
    * コード内で設定された期間（`KEEP_MONTHS = 6`）を過ぎた古い記事を自動的に削除。

## システム構成

必要なスプレッドシート（6シート）:

| シート名 | 目的 |
|---|---|
| `RSS` | 収集対象のRSSフィードURL一覧。 |
| `collect` | 収集した全記事データ（データベース）。 |
| `Keywords`| 週刊レポートの観測対象キーワード（配信曜日の指定も可能）。 |
| `prompt` | AIへの指示（プロンプト）テンプレート。 |
| `DigestHistory` | 週ごとの分析結果を蓄積し、次週の比較に使用。 |
| `Users` | メール配信先ユーザー管理（有効/無効設定）。 |

## 技術仕様（Architecture Highlights）

### 1. マルチティア・LLMフォールバック
API障害やレート制限による停止を防ぐため、3段階のフォールバックシステムを実装しています。
1. **Azure OpenAI**: 高速・安定・セキュア（Primary）。
2. **OpenAI API**: Azure障害時のバックアップ（Secondary）。
3. **Google Gemini**: 上記すべてが利用不可な場合の最終防衛ライン（Tertiary）。

### 2. 堅牢なRSS収集エンジン
* **全フォーマット対応**: RSS 1.0, 2.0, Atom形式を自動判別してパース。
* **自己修復機能**: XMLパースエラー発生時、制御文字や不正なタグを自動除去して再試行する強力なサニタイズ処理を搭載。
* **Web互換性**: 一般的なブラウザ（User-Agent）を偽装し、Bot対策されたフィードも収集可能。

## アーキテクチャとロジックフロー

本システムのデータフローと処理ロジックの概要図です。
メンテナンスや機能追加の際の全体像把握にご利用ください。

```mermaid
graph TD
    %% データソース
    RSS[RSS Feeds] -->|collectRssFeeds| DB[(collect Sheet)];

    %% 日次自動処理フロー
    subgraph Daily Automation
        DB -->|processSummarization| AI_HEADLINE[AI Headline Gen];
        AI_HEADLINE -->|Update| DB;
        DB -->|sortCollectByDateDesc| DB;
    end

    %% 週刊レポート生成フロー
    subgraph Weekly Reporting
        DB -->|weeklyDigestJob| FILTER{Keyword Filter};
        CONFIG[Keywords Sheet] --> FILTER;
        FILTER -->|Hit Articles| AI_ANALYSIS[AI Trend Analysis];
        AI_ANALYSIS -->|Generate Report| MAIL[Email Digest];
        AI_ANALYSIS -->|Save History| HISTORY[(DigestHistory Sheet)];
    end

    %% Web UI フロー
    subgraph Web UI On-Demand
        USER((User)) -->|Search| WEB_UI[Web Interface];
        WEB_UI -->|searchAndAnalyzeKeyword| DB;
        DB -->|Retrieve| WEB_AI[AI Deep Dive];
        WEB_AI -->|HTML Report| WEB_UI;
    end

    %% 依存関係
    PROMPT[prompt Sheet] -.-> AI_HEADLINE;
    PROMPT -.-> AI_ANALYSIS;
    PROMPT -.-> WEB_AI;
    
    %% スタイル定義
    classDef sheet fill:#e1f5fe,stroke:#01579b,stroke-width:2px;
    classDef process fill:#fff3e0,stroke:#e65100,stroke-width:2px;
    class DB,CONFIG,HISTORY,PROMPT sheet;
    class AI_HEADLINE,AI_ANALYSIS,WEB_AI process;
```

### 主要関数リファレンス

開発・メンテナンス時に参照すべき主要な関数です。

| 関数名 | 役割・ロジック概要 | 依存シート |
|---|---|---|
| `collectRssFeeds` | RSS/Atomフィードを巡回・パースし、重複を除外してDBに追記。 | `RSS`, `collect` |
| `processSummarization` | 記事の「見出し」をAI生成。短い記事はルールベースで処理し、APIコストを抑制。 | `collect`, `prompt` |
| `weeklyDigestJob` | キーワードに基づくトレンド分析レポートを作成しメール配信。履歴との差分比較も行う。 | `Keywords`, `DigestHistory` |
| `searchAndAnalyzeKeyword` | **Web UI用**。指定キーワードでDBを検索し、直近記事をAI分析してHTMLを返す。 | `collect`, `prompt` |
| `maintenanceDeleteOldArticles` | 保存期間（`KEEP_MONTHS`）を過ぎた古い記事を物理削除し、スプレッドシートを軽量化。 | `collect` |
| `LlmService` (Module) | Azure/OpenAI/Geminiの切り替えを行う通信レイヤー。エラーハンドリングを一元管理。 | (Script Properties) |

## セットアップ手順

### 1. スクリプトプロパティの設定
「プロジェクトの設定」>「スクリプト プロパティ」に以下を設定します。

| プロパティ名 | デフォルト値 | 説明 |
|---|---|---|
| `DIGEST_TOP_N` | `20` | 週刊メールの1キーワードあたりの分析対象数。 |
| `DIGEST_DAYS` | `7` | 週刊レポートの集計期間。 |
| `OPENAI_MODEL_MINI` | `gpt-4.1-mini` | 分析・要約用モデル（Azure/OpenAI）。 |
| `OPENAI_MODEL_NANO` | `gpt-4.1-nano` | 見出し生成用軽量モデル。 |
| `EXECUTION_CONTEXT` | `COMPANY` | `COMPANY` (Azure優先) または `PERSONAL` (OpenAI優先)。 |

※ APIキー類（`OPENAI_API_KEY`, `AZURE_ENDPOINT...`, `GEMINI_API_KEY` 等）も適切に設定してください。

### 2. プロンプトの登録（`prompt` シート）
各機能に対応するプロンプトテンプレートを登録してください。

| プロンプトキー | 用途 |
|---|---|
| `WEB_ANALYSIS_SYSTEM` | Web UI検索・新規技術発掘用。 |
| `TREND_SYSTEM` | 週刊レポート・トレンド分析システムプロンプト。 |
| `TREND_USER_TEMPLATE` | 週刊レポート・ユーザープロンプト（初回）。 |
| `TREND_USER_TEMPLATE_WITH_HISTORY` | 週刊レポート・ユーザープロンプト（履歴比較あり）。 |
| `DIGEST_SUMMARY_SYSTEM` | 週刊レポート履歴保存用の要約生成。 |
| `DAILY_DIGEST_SYSTEM` | 日刊ダイジェスト・システムプロンプト。 |
| `DAILY_DIGEST_USER` | 日刊ダイジェスト・ユーザープロンプト。 |
| `BATCH_SYSTEM` / `BATCH_USER_TEMPLATE` | 記事見出し生成用。 |

### 3. トリガーの設定（推奨運用フロー）

| 関数名 | イベント | タイマー設定 | 目的 |
|---|---|---|---|
| `mainAutomationFlow` | 時間主導 | 毎日 1:00〜2:00 | RSS収集・AI見出し生成・並び替え（必須） |
| `dailyDigestJob` | 時間主導 | 毎日 7:00〜8:00 | 日刊ダイジェスト配信（任意） |
| `weeklyDigestJob` | 時間主導 | 毎週 月曜 9:00〜10:00 | 週刊トレンドレポート配信 |
| `maintenanceDeleteOldArticles` | 時間主導 | 毎週 日曜 3:00〜4:00 | 古いデータの自動削除 |

## 運用ベストプラクティス

1.  **キーワードの選定**:
    * いきなり `Keywords` シートに登録せず、まず **Web UI** で検索を試す。
    * ヒット数が **50件前後** になるよう `AND` 検索などで絞り込む（例: `AI` → `AI and 創薬`）。
2.  **使い分け**:
    * **Web UI**: 「最近どう？」と思ったら使う（能動的）。過去1ヶ月の**新規技術**が見つかる。
    * **日刊メール**: 毎朝のニュースチェック。全体像を把握。
    * **週刊メール**: 月曜朝にじっくり読む。先週からの**トレンド変化**を把握。
3.  **データ保持**:
    * デフォルトでは **6ヶ月** で自動削除されます。変更したい場合は `RSScollect.js` 内の `maintenanceDeleteOldArticles` 関数にある `KEEP_MONTHS` を修正してください。
