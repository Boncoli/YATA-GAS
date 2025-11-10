# セマンティック検索（意味検索）導入 改造案メモ

## 1. 概要

現在のキーワード検索を、AIによるセマンティック検索（意味検索）にアップグレードする。
これにより、キーワードが完全に一致しなくても、文脈的に関連性の高い記事を検索できるようになり、情報発見の質を大幅に向上させる。

## 2. 方針

- **使用モデル:** OpenAI系のEmbeddingモデルを利用する。
  - **候補1:** `text-embedding-ada-002` (実績があり、コスト効率が良い)
  - **候補2:** `text-embedding-3-small` (比較的新しく、高性能)
  - **注意:** Azure OpenAI Serviceで利用可能なデプロイを確認し、最終的に使用するモデルを決定する。一度決定したモデルは、原則として変更しない。

- **APIの利用:** 
  - 会社のAzure OpenAI Serviceを優先的に利用する。
  - `callLlmWithFallback` の設計思想を踏襲し、個人のOpenAI APIキーでも動作するようにフォールバック機構を設ける。

## 3. 実装ステップ

### ステップ1: スプレッドシートの準備

1.  `collect` シートの **G列** に、新しいヘッダーとして `Vector` を追加する。
2.  この列に、各記事から生成されたベクトルデータ（カンマ区切りの数値文字列）を格納する。

### ステップ2: Google Apps Script (GAS) の改修

#### 2.1. ベクトル生成関数の新規作成

テキストを引数に取り、Embeddingモデルを呼び出してベクトル（数値の配列）を返す汎用関数を新設する。

```javascript
/**
 * テキストをベクトル化する（Azure/OpenAIフォールバック対応）
 * @param {string} text 変換対象のテキスト
 * @param {string} model 使用するEmbeddingモデル名 (例: 'text-embedding-ada-002')
 * @returns {number[]|null} ベクトルの配列、またはエラー時はnull
 */
function generateVector(text, model) {
  // TODO: Azure OpenAI / OpenAI 本家 API を呼び出すロジックを実装
  // APIのレスポンスからベクトルデータを抽出し、数値の配列として返す
  // レート制限を考慮し、Utilities.sleep() を適切に呼び出す
}
```

#### 2.2. 既存記事への適用（バッチ処理）

既存の全記事のベクトルを一括で生成するための関数を新設する。GASの実行時間制限（6分）を考慮し、一度に処理する行数を制限するか、タイムトリガーで複数回に分けて実行できる設計にする。

```javascript
/**
 * 【バッチ処理】既存記事のベクトルを生成・補完する
 */
function backfillVectors() {
  const sheet = SpreadsheetApp.getActive().getSheetByName("collect");
  const data = sheet.getDataRange().getValues();
  const vectorColumnIndex = 6; // G列 (0-indexed)
  const model = "text-embedding-ada-002"; // or "text-embedding-3-small"

  for (let i = 1; i < data.length; i++) { // 1行目はヘッダー
    const vectorCell = data[i][vectorColumnIndex];
    if (!vectorCell || vectorCell === "") {
      const title = data[i][1]; // B列
      const headline = data[i][4]; // E列
      const textToEmbed = title + "\n" + headline;

      const vector = generateVector(textToEmbed, model);
      if (vector) {
        // ベクトルをカンマ区切りの文字列としてシートに書き込む
        sheet.getRange(i + 1, vectorColumnIndex + 1).setValue(vector.join(','));
      }
      // TODO: 実行時間制限を考慮した中断・再開ロジック
    }
  }
}
```

#### 2.3. 新規記事への適用

`processSummarization` 関数内で、見出し生成が完了した記事に対してベクトル生成処理を追加する。

```javascript
// processSummarization() の中で...
// ... 見出し(newHeadline)が確定した後 ...

const textToEmbed = article.title + "\n" + newHeadline;
const vector = generateVector(textToEmbed, "text-embedding-ada-002");
if (vector) {
  // values配列の対応する行のVector列に、カンマ区切りの文字列として保存
  values[article.originalRowIndex][6] = vector.join(',');
}
```

#### 2.4. 検索ロジックの変更

Web UIからの検索 (`executeWeeklyDigest`) と週次ダイジェスト (`weeklyDigestJob`) の両方で、検索ロジックをキーワード検索からセマンティック検索に変更する。

1.  **コサイン類似度計算関数の作成**
    ```javascript
    /**
     * 2つのベクトルのコサイン類似度を計算する
     * @param {number[]} vecA
     * @param {number[]} vecB
     * @returns {number} 類似度スコア (-1から1)
     */
    function calculateCosineSimilarity(vecA, vecB) {
      // TODO: コサイン類似度の計算ロジックを実装
    }
    ```

2.  **検索処理の変更**
    - ユーザーの検索クエリを `generateVector` でベクトル化する。
    - `collect` シートから全記事のベクトル（G列）を読み込む。
    - 各記事のベクトルと検索クエリのベクトルのコサイン類似度を計算する。
    - 類似度スコアが高い順に記事をソートし、上位N件を結果として返す。

## 4. 運用上の注意点

- **モデルの一貫性:** 記事のベクトル化と検索クエリのベクトル化には、**必ず同じEmbeddingモデルを使用する**こと。
- **モデルの変更:** Embeddingモデルを変更する場合は、**必ず `backfillVectors()` を再実行し、全記事のベクトルを新しいモデルで再計算する**こと。
- **APIキーとエンドポイント:** Azure OpenAIを利用する場合、正しいエンドポイントとデプロイ名を指定する必要がある。
