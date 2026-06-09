# Changelog

> **💡 履歴の読み方について**
> YATAプロジェクトは、クラウド（Google Apps Script）とローカルエッジ（Raspberry Pi / Node.js / SQLite等）が相互に連携するハイブリッドなアーキテクチャを採用しています。
> そのため、本チェンジログには **[GAS版（本リポジトリ配布対象）]** の更新履歴に加え、開発の歴史と文脈を保存するため、あえて **[Localエッジ版（ローカル専用モジュール）]** の更新履歴も併記しています。
>
> * 🌐 **[GAS / Cloud]**: スプレッドシートやGAS環境（Web UI含む）に関連する更新。
> * 🍓 **[Local Edge]**: ラズパイ、SQLite、Python、CarPlay連携などローカル環境に関連する更新。
> * 🧠 **[Common Core]**: 両環境で共有される共通エンジン（`lib/` 配下の共通ロジック）に関連する更新。

## [2.0.1] - 2026-06-09
### ⚙️ [Refactoring & Documentation] 依存関係のクレンジング・堅牢化 ＆ 主要インターフェースのJSDoc型定義の導入、およびREADMEドキュメントのOSS公開整備

#### 📖 README.md のOSS公開向けドキュメント整備とスキーマ明記
- **手動作成シートのカラム定義を明記**: 構築時に手動作成が必要となる3つのシート（`ActionLogs`, `Scrapers`, `prompt`）のカラム仕様（スキーマ）とサンプルデータをテーブル形式で可視化し、導入手順を完全補完。
- **プロジェクト構成の可視化**: プロジェクトのディレクトリ階層（`lib/` 内のモジュール群のロード順序など）をツリーで表現し、第三者への可読性を向上。
- **v2.0.1 設計ハックの追記**: 「変態的ハック 7選」として、`01_Helpers.js` へのモジュール境界の分離、および JSDoc `@typedef` を用いた型安全化をドキュメントへ追記。
- **ローカルエッジ環境（RasPi）連携への導線強化**: Node.js/SQLiteを用いたエッジ動作との双方向ブリッジ機能（`gas-bridge.js`）に言及し、`README_LOCAL.md` へのスムーズな誘導を設置。


#### 🏛️ ベクトル数学ユーティリティのHelpers移設（逆依存の解消）
- **`05_Analytics.js` からの機能抽出**: ビジネスロジックを含まない `parseVector_`, `calculateDotProduct_`, `calculateCosineSimilarity_` の3つの純粋関数を [lib/01_Helpers.js](file:///F:/code/YATA/lib/01_Helpers.js) へ移設。これにより、[03_Repository.js](file:///F:/code/YATA/lib/03_Repository.js) などの下位モジュールから上位モジュールへの暗黙の逆依存を完全解消。

#### 🌐 ネットワークリトライ機能 `fetchWithRetry_` の共通Helpers化
- **[lib/09_Pubmed.js](file:///F:/code/YATA/lib/09_Pubmed.js) からの共通化**: 指数バックオフ付きリトライ通信関数 `fetchWithRetry_` を [lib/01_Helpers.js](file:///F:/code/YATA/lib/01_Helpers.js) へ集約。将来的な他モジュールでの再利用性を高めつつ、Pubmedモジュール内の重複を排除。

#### 🧪 APIレスポンスパースの論理的整理
- **`LlmService` 通信レスポンスの `JSON.parse` 統一**: [lib/02_LlmService.js](file:///F:/code/YATA/lib/02_LlmService.js) 内のAPIから返る確実なJSON文字列に対して、修復用ロジック（`cleanAndParseJSON_`）を適用していた箇所を `JSON.parse` に変更。APIレスポンスの受信とAI生成テキストのサニタイズパースの役割を分離。

#### 📄 主要モジュール間オブジェクトのJSDoc明文化
- **`@typedef` の導入**: [lib/01_Helpers.js](file:///F:/code/YATA/lib/01_Helpers.js) に主要データ型（`YataArticle`, `YataRenderItem`, `YataLlmOptions`）を定義。第三者が見てもデータの構造（引き渡しオブジェクトの形状）をひと目で把握可能にし、将来のメンテナンスとIDE補完の堅牢性を保証。

## [2.0.0] - 2026-06-09
### 🚀 [Architecture & Optimization] YATA v2.0 正式リリース：ゲートウェイ総合窓口化・純粋関数化・多層グローバルキャッシュによる大要塞の完成

#### 🤖 AI通信・パース構造の完全中央集約（AI Gateway）
- **`LlmService.executeStructuredQuery` の完全新規実装**: 各サブスクリプトに分散していたLLM通信、3回論理リトライ、Markdown剥ぎ取り、壊れたJSONの自己修復（`cleanAndParseJSON_`）を一つの堅牢な「要塞」へ中央集約。purposeFlag（`NEWS` / `PUBMED`）による動的なプロンプト・モデルの出し分けスイッチを確立。
- **プロンプトクレンジングとガードシールドの配備**: 要約要求時にニュース用のリアルタイム日付ルールや `is_old` 判定が論文プロンプト（`PUBMED_UI_SYSTEM`）へ混い込んで混線する問題をフラグ制御で完全遮断。さらに、AIによる「ID捏造」を検知して安全な1件個別処理へ落とす「IDシールド」と、フォールバックの無限再帰を力技で止める緊急ブレーキ（`options.isFallback` 判定）を内包。

#### 📦 データ書き込み（I/O）の窓口一本化とコレクターのスリム化
- **`Repository.getExistingUrlSet` / `insertNewArticlesBatch` の新設**: ニュース収集（`04_Scraper.js`）と論文収集（`09_Pubmed.js`）の双方に重複ベタ書きされていた「スプレッドシートを開いて過去2万行をスキャンし、重複排除Setを作り、先頭に空行を挿入して書き込む」という重たいI/O実務をデータ層（`03_Repository.js`）へ完全移管・隠蔽。
- **生記事配列インターフェースの統一**: すべてのコレクターは「日付、タイトル、URL、本文、要約(=空)、情報源」のきれいな6列の2次元配列を返すピュアな役割に専念。クラウド（GAS）では先頭行への高速インジェクション、ローカル（RasPi/SQLite）では `gas-bridge.js` の主キー自動抽出フックとがっちゃんこ連動する完璧なパイプラインを確立。

#### 🎨 HTMLレポートのデザイン着せ替えテンプレート化 ＆ レンダラーの「純粋関数」化
- **`ReportTemplateEngine` の中央配備**: `06_UI.js` の奥深くにスパゲッティ化していたインラインCSS、骨格HTMLタグ、SOURCESリンクバッジの組み立て処理（ビュー）を最下部の一元管理モジュールへ完全追放。デザインの変更がロジックを1ミリも汚さない「着せ替え人形構造」を達成。
- **レポート生成関数の純粋関数（Pure Function）化**: `generateTrendReportHtml_` を、HTML組み立て中に裏でクエリ拡張のAPIを叩いたりシート検索に走る密結合から解放。事前抽出・間引きをすべて手前の配信コントロール側（ロジック層）で100%終わらせ、この関数は「完成したデータオブジェクトを受け取ってHTMLスキンを被せるだけ」の爆速描画エンジンへ昇華。

#### 🧹 テスト・デバッグ（DryRun）環境の統合と重複コードの完全デリート（DRYの徹底）
- **`sendPersonalizedReport` へのテストフラグ（`options.isDryRun`）完全内包**: 本番と全く同じ配信エンジンをテスト時にも100%安全に再利用できるスイッチを実装。フラグ検知時に「曜日を無視して強制起動」「来週への引き継ぎ履歴（`DigestHistory`）を汚さない」「送信先アドレスを本来のユーザーから管理者（`mailTo`）へ強制上書きする」防壁を構築。これにより、`08_Tests.js` 側で本番を真似て75行にわたりベタ書きされていたダミー配信関数（`debugPersonalReport`）を完全消去し、1行丸投げのウルトラスマートな形へ進化。
- **ユーティリティの共通窓口化**: クリック計測用URLの生成ロジックを `01_Helpers.js` の **`buildTrackingUrl_`** へ、管理画面用の正規表現テスト処理を `04_Scraper.js` の **`Scraper.testRegex`** へそれぞれ一本化。`07_Tools.js` 内の重複コピペコード（`_testRegexLocal_`）を跡形もなく完全デリート。

#### ⏳ 起動時一回のみの「多層グローバルキャッシュ」による通信量完全ゼロ化
- **システム構成のメモリ永続化 (`_YATA_GLOBAL_CONFIG_CACHE_`)**:中央定数管理（`00_Config.js`）を拡張。PropertiesService を毎回叩く重たいオーバーヘッドを廃止し、起動時に一度だけJSONをロードしてグローバル空間（`globalThis`）へ永続キャッシュする防壁を構築。
- **プロンプトJSONのメモリ永続化 (`_YATA_GLOBAL_JSON_CACHE_`)**: `03_Repository.js` の `fetchJsonFromDrive_` を大改造。1回のジョブ実行中に何十回も発生していた Google Drive からのプロンプトJSON（`prompts.json`）のファイル取得通信を物理的に「たったの1回」に削減。2回目以降はメモリから0秒で返却する形へ最適化し、GASの実行時間制限（タイムアウト）リスクを極限まで引き下げ。

#### ℹ️ 統合ロガー（LogManager）の設置による集中エラー監視体制の開通
- **中央集約型ロガーオブジェクト `Log` の新設**: システムのあちこちでバラバラに行われていた例外ロギングを `Log.info()`, `Log.warn()`, `Log.error()` 窓口へ完全統合。エラーの重要度（Level）に応じて、ActionLogsシートや将来のDiscordウェブフック通知（拡張フック内包）へと自動で綺麗にルーティング・仕分けする堅牢な監視基盤を確立。

#### 🐛 [Bug Fixes & Hybrid Synchronization]
- **ローカル環境（yata-loader.js）での即死クラッシュ（TypeError）の根絶**: ファイル分割・カプセル化（Phase 1）に伴い、ラズパイ上の起動エンジン（`yata-loader.js`）から PMC 論文全文ハイブリッド抽出関数が呼べなくなっていた露出漏れを解消。`09_Pubmed.js` の最下部にて `extractPmcSections_`, `getPubMedPaperIDs_`, `getPaperInfo_` を `global` 領域へ正しく再エクスポートすることで、ローカルデバッグ時のジョブ落ちを100%防止。
- **日刊ダイジェスト見出し目次（TOC）の文字表記ミスマッチ修正**: MarkdownからHTMLへの変換順序に伴い、ダイジェストメール内のラインナップ（目次パーツ）が空っぽになって機能しなくなる表現バグを修正。すでにHTML化されたタグ（`<h3[^>]*>・`）の形状から、1ミリの狂いもなく正確に見出しを検挙してアンカーID（`id="topic-N"`）を埋め込むように正規表現を完全同期。

## [1.9.0] - 2026-06-02
### 🚀 [Data Science & Infrastructure] 行動ログの英日名寄せ解析エンジン配備 ＆ 進化型クエリ辞書マスタの創設

#### 🧠 アーカイブJSONと記事のURLクレンジング突合による「関心の重心（Top 10）」可視化
- **`10_BehaviorIntelligence.js` の新規実装**: Google Driveに隔離・退避されていた過去のユーザー行動ログ（JSON）をサルベージし、スプレッドシート上の記事データとURL正規化（`normalizeUrl_`）を介して美しく結合（JOIN）するクレンジング突合エンジンを完全新規配備。
- **英日クエリ逆流による「自動名寄せ」の実現**: AIクエリ拡張を逆流判定させ、`FDA approval` と `FDA承認`、`MiniMed` と関連デバイスのような「多言語の表記揺れや包含関係」を裏側で同じ意味のバケットへ全自動マージするデータサイエンス・アルゴリズムを確立。分裂していたデータを統合し、組織や個人の真の熱狂度（関心濃度%）を最大10位まで暴き出す高解像度レポート出力を達成。
- **自律進化型レコメンドループの伏線配備**: 解析された上位3つの超重要キーワードを、`Users` シートの優先キーワード（K列: `PRIORITIES`）へ配信前に全自動で書き戻して翌朝の配信スコアにダイレクト反映させる「自己学習ループ」を内包（現在は安全運用のフェーズとしてReadOnly/コメントアウトモードでデプロイ）。

#### 💾 クエリ拡張の「永続化マスタシート化」によるAPIコスト完全遮断と爆速化
- **`05_Analytics.js` (`expandKeywordQuery_` の大改造)**: 一度実行したAIクエリ拡張の結果をシートへ永続的に書き溜めて再利用する「キャッシュ・アサイド・パターン」のインフラへ移行。
- **鉄壁の3段防衛キャッシュマスタの構築**: [メモリロード（1段目）] ➔ [シート辞書引用（2段目）] ➔ [初見ワードのみLLM通信（最終手段）] の3層構造へと完全刷新。これにより、毎時の収集ジョブや毎朝の `personalReport`（個人配信）、さらには10番スクリプトの総当たりループにおいて、発生していた無駄な重複LLM通信を物理的に100%遮断。APIコストを「完全ゼロ（0円）」へ、処理速度を「実質0秒（2秒未満の貫通）」へと極限最適化。
- **人間による手動調教（マスタカスタム）への解放**: AIが自動構築した拡張検索式を人間がスプレッドシート上で直接手動修正（調教）するだけで、次回からシステム全体がそのカスタム式を最優先して引用するハイブリッド運用に対応。

#### ⚙️ 辞書シートの非公開Config要塞化
- **聖域インフラへの配置**: `00_Config.js` に新設シート名 `KEYWORDS_DICTIONARY: "KeywordsDictionary"` を定義。さらに `03_Repository.js` の非公開リスト（`PRIVATE_SHEETS`）へ確実にバインドすることで、組織の追記キーワードや検索戦略（プロンプト機密）が一般閲覧者に見えないよう、Configシート側へ厳格に隔離・隠蔽するガバナンス保護を完了。

## [1.8.1] - 2026-06-02
### 🚀 [Intelligence & Quality] ベクトル類似度による送信前重複排除（Omit）エンジンの新設 ＆ AIパンク防止防壁の構築

#### ✂️ ベクトル空間の総当たり内積演算による酷似記事の水際パージ（内容重複Omit）
- **内容ベースの重複排除ロジックの開通**: `lib/06_UI.js` 内にヘルパー関数 `_omitSimilarArticles_` を完全新規実装。URLベースの排除をすり抜けてくる「同じプレスリリースを元にした別メディアの報道」や「日次・週次データの重複」を、AIにデータを投げる前段階でシステム側で100%自動間引き（Omit）する機構を確立。
- **実戦パフォーマンスの完全立証**: 監査診断ツールにおいて、わずか **102ミリ秒** で **52,975回** の総当たり内積演算を走破する超軽量・超高速駆動を実証。ビジネス価値を毀損するハズレURL（ノイズ）だけをピンポイントで抹殺し、生き残った優秀な主記事のURLだけを後続へバトンパス。

#### 🛡️ 大量流入時のLLM失神・手抜き応答を完全に封じる「枚数制限スライス」
- **コンテキストの容量最適化防壁の構築**: キーワードごとに350件を超えるような爆発的な流入が発生した際、巨大なコンテキスト窓（枠）に甘えてAIが破綻（Lost in the Middleによる思考放棄や『省略してください』というサボり応答）を起こす問題を根本解決。
- **黄金比ボリュームへのトリミング**: 優先度ソートおよび重複Omitをかけた後、なお多すぎる素材群を `AppConfig.get().Digest.topN` （配信設定JSONの `DIGEST_TOP_N`）に基づいて強制的にクリップ（`slice`）。`gpt-5-mini` が最も高い注意力と知能を100%発揮できる「適正かつ濃厚な材料（30〜40件）」へと自律トリミングする安全弁を配備。

#### ⚙️ 重複しきい値の環境変数JSON化と安全自動マージ
- **聖域コードの完全定数化**: 類似度の足切りラインをプログラム内に直接書かず、`00_Config.js` を拡張して `System.Thresholds.DUPLICATE_OMIT` キーへマッピング。
- **インフラ雛形の安全自動マージ**: `07_Tools.js` の `initializeSystemProperties()` における設計図に `SYSTEM_THRESHOLD_DUPLICATE: "0.85"` を追記。手動調整された既存のメールアドレスやプロバイダ優先順位を1ミリも上書き破壊せず、新設されたキーだけが安全にプロパティへ滑り込むマージ構造の貫通を確認。

## [1.8.0] - 2026-05-28
### 🚀 [Intelligence & Quality] メール内URL重複排除の完全覚醒 ＆ PubMedがっちゃんこ比較診断エンジンの新規配備

#### 🛡️ 1通のメール内におけるカテゴリー横断・別ソース露出の完全全滅（URL記憶の盾）
- **deliveredUrlsオプションのパイプライン開通**: 大本の個別レポート配信ジョブ（`sendPersonalizedReport`）からHTML組み立て関数（`generateTrendReportHtml_`）を呼び出す際、オプション引数への `deliveredUrls: deliveredUrls` の引き渡しが漏れていた死角をピンポイントで修正。
- **検索・抽出ステップでの水際パージ実現**: 既に上のセクション（別のキーワード）でAIに採択・出力が確定した記事のURLを、ユーザーごとに独立したSetオブジェクト（記憶の盾）へ即時刻印。後続セクションの文字検索に同じ記事が引っかかった瞬間、AI（LLM）に文字を投げる手前のフェーズ（308行目のフィルタ）で実質0秒で強制除外（パージ）する防壁を完全覚醒。
- **APIコストの自律的適正化 ＆ 配信高速化**: 閲覧者から指摘されていた「同じメール内に同じニュースが並ぶ」「昨日と今日でダブる」という情報過多ストレス（パターン①、②）を物理的に100%遮断。さらに、LLMへ冗長なリクエストを投げる回数と文字数を事前に間引くため、通信ラグが激減し、OpenAI/Azureへのトークン課金を自動的に節約する逆転の最適化構造を着地。

#### 📊 PubMed新着ヒット数「生 ＆ 拡張」がっちゃんこ比較診断ツールの新規配備
- **ビフォーアフターの瞬間診断インフラの構築**: `lib/08_Tests.js` に `testPubMedHitCountOnly()` 関数を新規追記。
- **手動バイパス判定の完全シミュレート**: 「Pubmed」シートのB1セルに入力されたキーワードをトリガーとし、[生の単語そのままによるPubMed直撃] と [AIによってMeSH Terms/TIAB指定へプロ仕様拡張された数式] の両方の直近7日間の新着ヒット数をパラレルにスキャンして一発比較。
- **100%安全なノーリスク・サンドボックス**: スプレッドシートへの永続書き込みやAI要約、メール送信トリガーを一切起動させない完全隔離設計。256dベクトルの内積演算と同様に、数ミリ秒〜数十ミリ秒で通信負荷なく何万回でもキーワードを打ち替えてクエリボリュームを味見できるリモコン診断環境を確立。

## [1.7.9] - 2026-05-28
### 🚀 [Architecture & Scalability] 時限式バケツリレー型分散配信への大改造 ＆ PubMedハイブリッド検索式の堅牢化

#### 📧 個人レポート配信ジョブの無限スケーラビリティ化（時限式セルフ・バケツリレー）
- **時間監視型中断 ＆ ワンタイムトリガー自律生成**: ユーザー数13名突破に伴うGASの5分（300秒）実行時間制限をハック。`sendPersonalizedReport` 内のループ処理に3.5分（220秒）の安全弁を配備。タイムアウトを検知すると次回の再開インデックスを保存し、5分後に自分自身を呼び出す一時トリガーを自動生成してジョブを安全に離脱するセルフ・チェーン構造を確立。
- **IDストック式ピンポイントクレンジング ＆ 起動時自動GC**: 自動生成した一時トリガーの固有IDを `YATA_SYSTEM_STATE` 内へ動的に記録し、ジョブ走破時に一括でピンポイント消去する自律お掃除ロジックを実装。さらに、予期せぬクラッシュ時の消し残りに備え、関数の「起動時（先頭）」にも過去のゴミトリガーを検挙して強制シュレッダーにかけるガベージコレクション（GC）を配備し、トリガーの雪だるま化を永久に防止。
- **排他ロック（LockService） ＆ 送信日時物理ガードによる二重送信の完全遮断**: バケツリレー中の手動連打や別トリガーの重なりによる競合を防ぐため、配信の先頭に `LockService` を導入し重複実行を強制ブロック。さらに、メール送信直後にシート側の `LAST_SENT` 列へタイムスタンプを即時刻印する処理と、日付比較バリデーションの2重壁により、同じ内容が1日に2通届くロジック破綻（誤送信）を物理的に100%シャットアウト。

#### 🔬 PubMed専用クエリ拡張エンジンの手動バイパス要塞化
- **2重のスキップ防衛線によるプロ仕様クエリの保護**: `expandKeywordQueryPubMed_` において、ユーザーが手動で高度に組み立てた検索式を破壊しないための防衛線を大幅強化。
- **演算子 ＆ 角括弧フックの導入**: クエリ内の `" AND "` / `" OR "` の検知（防衛線1）に加え、主要MeSHタグ（`[majr]`）や副見出し・日付指定等、PubMedのあらゆるプロ仕様タグで使用される半角の角括弧 **`[`** （防衛線2）が含まれている場合に、AI（LLM）拡張を通さずにそのまま PubMed API へパスする構造へ刷新。
- **完璧なハイブリッド稼働の実現**: これにより、`"Fabry Disease"[majr]` などの精密な手動クエリは無傷でそのまま突き刺さり、純粋な日本語キーワード（「ファブリー病」など）が入力された時だけ `gpt-5-nano` による網羅的なMeSH自動大拡張がフルドライブする最高の共存環境へと着地。

## [1.7.8] - 2026-05-21
### 🚀 [Architecture & Governance] 動的LLMオーケストレーションの導入 ＆ 企業ガバナンス要塞化

#### 🔗 配列ループ駆動型フォールバック構造への刷新（脱ハードコード）
- **ハードコード分岐の完全パージ**: `Context`（`PERSONAL` / `COMPANY`）のメタデータに依存し、`if-else` で泥臭く固定定義されていた旧LLMフォールバックロジックを根本から解体。
- **設定駆動型配列ループの導入**: 設定JSON（`YATA_TUNING_CONFIG`）内の新設キー `LLM_PRIORITY_ORDER` に記述されたプロバイダー配列（`["AZURE", "OPENAI", "GEMINI"]` 等）を忠実に走査し、稼働中の関数マップを動的にループフォールバックさせるエレガントなオーケストレーション構造を確立。これにより、システム全体のコードに一切触れることなく、環境変数（JSON）の書き換えだけで1秒でプロバイダー順序を並び替え、または特定のプロバイダーを完全バイパスできる無敵の柔軟性を実現。

#### 🤖 Gemini Nano/Miniモデルの動的出し分け対応
- **知能とコストの自律分散**: `_callGeminiLlm` 関数に第5引数 `modelOverride` を追加拡張。優先順位配列に `GEMINI` が指定された場合でも、毎時の軽量要約バッチ（Nano枠）と、PubMedなどの重厚な論文深掘り分析（Mini枠）の実行コンテキストに応じて、`gemini-2.5-flash-lite` と `gemini-2.5-pro` を自動で出し分け、精度とコストパフォーマンスの最適化を自動追従させる構造を配備。

#### 🛡️ ガバナンス完全遵守に伴う「Azure OpenAI一本運用」への安全シフト
- **シャドーIT・インサイダーリスクの物理的遮断**: 公開記事の要約であっても、我が社が「いま何を追跡しているか」という検索クエリ（プロンプト）自体が重大な機密情報であるコンプライアンスリスクを重く評価。
- **配列および個人鍵のクレンジング**: 配列定義から `OPENAI` および `GEMINI` を除外し、`["AZURE"]` に完全クリップ。さらに、GASの空欄保存バリデーション仕様をハックし、スクリプトプロパティから個人アカウントに紐づく `GEMINI_API_KEY` および `OPENAI_API_KEY_PERSONAL` を物理的に完全消去。これにより、プログラム誤動作による個人キーへの意図しないリークや不要な通信エラーログの発生を100%防止し、社内監査に対して「組織認可インフラ（Azure）以外へのクエリ送信ルートが物理的に存在しない状態」を完全証明。

#### ⚙️ インフラ雛形の同期と安全自動マージ
- **受け皿の完全同期**: `07_Tools.js` の `initializeSystemProperties()` における `tuningConfig` オブジェクトに、新設プロパティ（`LLM_PRIORITY_ORDER`, `GEMINI_MODEL_NANO`, `GEMINI_MODEL_MINI`）の初期構成を追記。
- **安全自動マージ実証**: 構成診断を実行し、人間が手動で調整した既存の配信設定やエンドポイントを1ミリも上書き破壊せず、新設された3つのキーだけが安全にピンポイント追記マージされる防壁のストレート貫通を確認。

## [1.7.7] - 2026-05-20
### 🌟 [機能拡張] 本文補完（Fetch）失敗時の「粘り強いハイブリッド救済ロジック」の実装

#### ♻️ 手持ち抄録（Abstract）のAI要約救済パイプライン構築
- **Fetchエラー時の即死刑宣告を撤廃**: 外部WebサイトのBotブロックや通信エラー（Fetch失敗）が発生した際、一律で `SKIP: FETCH_FAILED` に放流していた冷酷なバウンサーロジックを抜本改修。
- **手持ちカードでのAI要約敢行**: 本文補完がNGだった場合でも、元のフィードが持っているAbstractの文字数が指定の最小しきい値以上であれば自動で救済ルートへ切り替え、元のAbstractを武器にそのまま5W1Hの構造化AI要約へと滑り込ませる粘り強いアーキテクチャを確立。
- **空箱（ノイズ）の安全フィルター維持**: 本当にタイトルしか情報がない、あるいは最小文字数以下の「スカスカな記事」のみを安全に `SKIP: FETCH_FAILED` に落とすことで、情報の「網羅性」の最大化と「ノイズ除去」を完璧なハイバランスで両立。

#### ⚙️ 救済しきい値（最小文字数）のConfig・JSON一元連動化
- **ハードコードの完全パージ**: 従来コード内に `50` と直書きされて固定化されていた最小リミッターを撤廃。
- **パラメータJSONからの動的ロード化**: `00_Config.js` を拡張し、プロパティJSON内の新設キー（`SYSTEM_WEB_SUMMARY_MIN_CHARS`）から動的にしきい値をロードして制御する形へ解放。
- **インフラ雛形のアップデート**: `07_Tools.js` の初期化・マージ用オブジェクトにデフォルト救済ライン（50文字）を追記し、今後のクローン・横展開時にも自動でシステムが完全連動するよう配備。

## [1.7.6] - 2026-05-20
### 🌟 [インフラ大改革] プロパティカプセル化 ＆ 多層防衛アーキテクチャの確立

#### 📦 スクリプトプロパティのJSONカプセル化（50個制限の完全ハック）
- **単発プロパティ11個の完全パージ**: 画面に乱立していた配信・モデル設定関連の単発プロパティを役割ごとのJSONオブジェクト（`YATA_TUNING_CONFIG` / `YATA_DELIVERY_CONFIG`）へ完全集約。
- **インフラ鍵のスリム化**: プロパティ画面を「物理的なID・API鍵」と「数個のグループJSON」だけに絞り込み、GASの物理制限（50個）から永久に解放。
- **安全マージ構造の導入**: 初期化ツール（`initializeSystemProperties`）において、人間が手動調整した既存のJSON値を1ミリも上書き破壊せず、新設キー（モデル名など）だけをピンポイントで追記する自動マージ防壁を実装。

#### 🛡️ 論文ディープサマリーのスタミナ解放 ＆ 防壁同期
- **gpt-5-mini トークン上限の動的拡張**: 4件論文一括バッチ処理において、思考トークンの激しい消費による `finish_reason: length` エラーを検知。Config定義に基づき、上限を4,000から「8,000トークン」へ動的に引き上げるパッチを適用し、切断リスクを完全制圧。
- **PubMed 重複チェックの2万件完全同期**: `09_Pubmed.js` 内に置き去りになっていた「2,000件（直近4日分）」の固定チェックリミッターを撤廃。ニュース側と同様にConfigの `RSS_CHECK_ROWS`（20,000件＝過去40日ロック）と完全同期させ、1日500件運用の激流における論文の重複すり抜け（ピンク染まり）を昼の段階で100%シャットアウト。

#### ⚡ 起動順序（タイミズム）の完全ハック
- **遅延評価ゲッターによる初期化順序エラーの制圧**: システム多言語化に伴う `Messages`（日本語）の外部パージ時に発生したファイル読込順の競合（`ReferenceError: Repository is not defined`）を検知。
- **オブジェクトゲッター（`get` 構文）の採用**: メッセージプロパティを遅延評価化し、すべてのモジュールがRAM上に展開し終わるまで評価を遅延させる安全弁を構築。

#### 🧪 運用テスト
- **バッチ通信テスト（`debugBatchSummarization`）のストレート貫通**: `Retries: 0` での Azure / gpt-5-nano 1発JSON構造化パースを達成。5W1H（WHO/WHAT/WHEN/WHERE/WHY/HOW/RESULT）およびキーワード、古記事検知（`is_old: false`）の数学的判定まで完璧にドライブすることを確認。

## [1.7.5] - 2026-05-20
### ⚡️ [Performance & Infrastructure Optimization] Tens of Thousands Scaling
- **Blazing Fast Front-Injection**: 記事・論文収集ロジック (`04_Scraper.js`, `09_Pubmed.js`) において、シート最末尾への追記と、それに伴う数万行規模の全体物理ソート (`.sort()`) を完全に廃止。JavaScript側で新着データを新しい順に整列させた上で、2行目に `insertRowsBefore` で一括挿入する前方インジェクション方式へ全面移行。データベースの並び順の整合性を100%維持したまま、収集書き込みスピードを数百倍へ高速化。
- **Targeted Row Scanning Limit**: 未要約データの抽出ロジック (`03_Repository.js`) を根本からクランチ。直近7日間の全行（数千行規模）を無差別ロードする無駄を省き、1回のジョブの上限が30件である特性および前方インジェクションの恩恵を活かして、スキャン・ロード範囲をシート最上部から最大300行 (`SCAN_LIMIT = 300`) に制限。GASの通信量削減とメモリ爆発 (OOM) を永久に防止。
- **Lightweight Duplicate Cleanse**: 日次メンテナンスにおける重複排除 (`removeDuplicates_`) の処理範囲を、本日挿入された可能性のあるエリア（直近3000行）に制限。過去のクレンジング完了済みエリアへの冗長な全行ロードを完全に遮断し、日次サイクル中のフリーズリスクを排除。
- **Config Centralization & Optimization**: 重複チェック対象行数 (`Limits.RSS_CHECK_ROWS`) を 20,000 から `2,000` へ縮小し、`00_Config.js` へ一元集約。マジックナンバーを排除しつつ、毎時収集時のGoogleサーバー通信ラグとメモリ消費を90%削減。
- **High-Efficiency Sheet Object Caching**: `03_Repository.js` の `getSheet_` を拡張。スプレッドシートのファイルオブジェクトだけでなく、一度開いた各シートオブジェクト自体も実行セッション内のメモリ空間 (`_SsCache.sheets`) に完全記憶させる構造を確立。同一ジョブ内で多用される Google API (`getSheetByName`) の内部通信コストをゼロ化。
- **Zero-Latency Cost Tracking**: 累積コスト計算 (`_trackCost`) において、APIを叩くたびに発生していた `ScriptProperties` のロードと重いJSONパースを撤廃。`LlmService` 即時関数の内部空間にセッションフラグ (`_isMonthResetChecked`) を配備し、月次リセットの確認をジョブ中の初回通信時のみに制限。バッチ処理の合間の通信ラグを徹底排除。

### 🐛 [Bug Fixes & Hybrid Synchronization]
- **Data Overwrite Prevention on RasPi**: 前方インジェクション化（2行目固定挿入）に伴い、開発用ラズパイ環境のSQLiteモック (`gas-bridge.js`) で発生する行番号の不整合と既存データ誤認バグを修正。新着バルク書き込み (`numCols === 6 && col === 1`) 時は、SQLiteの既存行をスキャンせず、配列の3列目（生URL）から直接主キーを強制抽出する防壁を実装。既存の古いデータを行番号ズレで上書き破壊（デグレ）する罠を100%遮断し、ローカル環境での完全なデバッグ互換性を確保。

## [1.7.4] - 2026-05-12
### 🐛 [Bug Fixes & Reliability]
- **State Overwrite Prevention**: `YATA.js` の `jobDispatcher` において、ジョブ実行完了時に古いシステムステート（`YATA_SYSTEM_STATE`）で上書き保存してしまう致命的な競合バグを修正。ステート保存の直前に最新データを再取得（Re-fetch）する機構を追加し、バックグラウンドで更新されたAPIコストやRSSインデックスの巻き戻り（消失）を完全に防止。
- **is_old Flag Rescue**: `01_Helpers.js` の `cleanAndParseJSON_` 関数における最終フォールバック（正規表現による強制抽出）を強化。AIが壊れたJSONを返却した際でも、新設の `is_old` フラグを確実に見つけ出して救出するロジックを追加し、古い記事が新着としてすり抜ける現象を遮断。

## [1.7.3] - 2026-05-11
### 🐛 [Bug Fixes & Reliability]
- **Mojibake Resolution**: `YATA.js` の件名や `05_Analytics.js` の本文にハードコードされていた絵文字およびHTMLエンティティ（`&#129514;`等）が、メーラー環境によって文字化けする問題を解消。安全なプレーンテキスト表現（`[兆候]` や `■` 等）へ完全に置き換え。
- **English Date Parsing Rescue**: 記事の事後検問システム (`02_LlmService.js`) において、英語の月名（April等）がパースできずにデフォルトの「1月」と誤認され、最新記事が不当に `SKIP: OLD_ARCHIVE` として弾かれる致命的なバグを修正。英語月名の抽出対応と、取得不能時は「最新(12月)」として扱う安全弁を実装。
- **Strict Bouncer for System Messages**: `SKIP: OLD_ARCHIVE` などのシステム付与テキストが有効な記事見出しとして扱われ、LLMのトークン上限（`finish_reason: length`）を突破させて暴走する問題を修正。`04_Scraper.js` にて、`SKIP` から始まる文字列をすべて無効データとして弾くよう判定を厳格化。
- **Template Garbage Filter**: スクレイパー (`04_Scraper.js`) が Vue/Angular 等の動的レンダリング用テンプレート変数（`{{...}}`）を記事タイトルやURLとして誤取得してレポートに混入させる問題を防ぐため、ノイズフィルター（`isTemplateGarbage`）を実装。

### 🚀 [Feature & UI] Monthly Partner Letter Refinement
- **Strict Source Isolation**: 月次パートナーレターにおいて、記事本文のキーワード検索による混入（例：OGTの記事本文にSysmexが含まれるためSysmex枠に混ざる等）を完全に防ぐため、収集情報源（`source`）の完全一致のみで抽出・分類する `strictSourceMatch` フラグを実装 (`06_UI.js`, `08_Tests.js`)。
- **Minimalist Business Layout**: レターモード (`isLetterMode`) 時のデザインをさらに洗練。不要な概況文（Landscape）の出力を削ぎ落とし、`【Sysmex】` のようなシンプルなテキストヘッダーと青色ハイパーリンクのリストのみで構成された、極めて視認性の高いビジネスライクなフォーマットへ改修。
- **LLM Hallucination Prevention**: 月次レター生成時のAI暴走を防ぐため、プロンプトから `summary` 項目の出力を完全に削除。「空の要約を出力させる」不自然な指示によるAIの混乱と `length` エラーを根本から封じ込め。
- **Professional Greetings**: `08_Tests.js` におけるテスト配信用の定型文を、海外関係会社向けのビジネスライクな英語の挨拶文・フッターに刷新。

## [1.7.2] - 2026-04-28
### 🚀 [Architecture & Scalability] JSON Property Grouping
- **Overcoming 50-Property Limit**: GASスクリプトプロパティの「50個制限問題」を根本的に解決するため、散在していたキーを `YATA_TUNING_CONFIG` と `YATA_SYSTEM_STATE` というJSONオブジェクトへグループ化（`00_Config.js`, `07_Tools.js`）。将来のパラメータ増加に向けた物理的な拡張限界を完全撤去。
- **Legacy Key Cleanup**: JSON化に伴い、不要となった古いバラバラのプロパティ群を一括削除（`cleanupYataProperties`）。

### 🛡️ [Reliability & Self-Healing] Stateful Job Dispatcher
- **Time-Agnostic Dispatching**: `YATA.js` の `jobDispatcher` を「現在時刻（分）」依存のロジックから脱却。前回のジョブ履歴をJSONで状態保持（Stateful）させることで、GAS特有のトリガー発火遅延が発生しても「収集」と「要約」のバトンパスが絶対に狂わない堅牢なスケジューラへ進化。
- **Trigger Failsafe Test**: モジュール分割やリファクタリングによるトリガー関数の消失事故を未然に防ぐため、`08_Tests.js` に主要なエントリーポイントの存在保証テスト（`_test_triggerEntryPoints_`）を追加。

### ⚡️ [Performance & Concurrency] Tracking Optimization
- **High-Concurrency Logging**: `06_UI.js` のユーザートラッキング（`_logUserAction_`）において、負荷の高い `appendRow` を廃止。`LockService`（排他制御）と `setValues` による書き込みへ変更することで、複数人同時のリンククリック時におけるシート書き込み競合とタイムアウトエラーを完全に排除。

## [1.7.1] - 2026-04-27
### ⚡️ [Performance & Memory Optimization]
- **Targeted Pinpoint Extraction**: `03_Repository.js` のクリックログ集計 (`archiveActionLogsToDrive_`) における `getDataRange().getValues()` (シート全行・全列読み込み) を廃止。URL列とカウント列のみをピンポイントで取得する配列マッピング構造へ書き換え、数万件規模のデータにおけるメモリ爆発（OOM）とGASの6分タイムアウトの火種を物理的に消去。
- **Signal Engine Fast-Scan**: `05_Analytics.js` の予兆検知ジョブ (`_getArticlesForDetection`) において、重いベクトル列を含む無差別な全行ロードを廃止。まずA列（日付）のみをスキャンして対象期間の行数を特定し、必要な行数・列数のみをメモリに展開する2段構えの爆速アクセスへ改修。

### 🛡️ [Reliability & Self-Healing]
- **Summarization Infinite-Loop Prevention**: `02_LlmService.js` のバッチ要約時、AIのJSONパース失敗によりシートの要約列が「空欄」のままとなり、次回のジョブで同じ記事が無限にAPIリクエストを浪費し続ける（スタックする）致命的なバグを修正。パース失敗時は即座に `"ERROR: 解析失敗"` のフラグをシートへ刻印し、次回の抽出対象から安全に除外する自律防御機構を実装。
- **Code Cleanup**: `02_LlmService.js` 内に混入していた不要なコメントの残骸を清掃し、可読性を向上。

## [1.7.0] - 2026-04-24
### 🚀 [Architecture] Grand Modularization (v2.0 Foundation)
- **Monolith Deconstruction**: 3200行を超える `YATA.js` を完全に解体し、純粋なオーケストレーターへ軽量化。
- **ETL Pipeline Integration**:
    - **Extract**: `Repository.extractArticlesForSummarization` へ移植。
    - **Transform**: `LlmService.processSummarizationBatch` へ移植。
    - **Load**: `Repository.loadSummarizedArticles` へ移植。
- **Modular Services**:
    - **Scraper**: RSS収集とスクレイピングロジックを集約。
    - **DeliveryService**: 配信ジョブ（`dailyDigestJob`, `sendPersonalizedReport`）を `06_UI.js` へ完全委譲。
    - **Maintenance**: 日次メンテナンスロジックを `Repository` へ集約。
- **Reliability**: 各モジュールにグローバル・エイリアスを配備し、GASトリガーや外部呼び出しとの100%互換性を維持。

## [1.6.2] - 2026-04-23
### 🚀 [Feature & Intelligence] Monthly Partner Letter Refinement
- **All-English Formatting**: プロンプト (`PARTNER_REPORT_SYSTEM`) を完全英語化し、月次パートナーレターの出力を厳密なJSONかつ英語のみに固定。Markdownのコードブロック出力も明示的に禁止し、パースエラーを根絶。
- **Professional Greeting**: メールの冒頭に、海外パートナーや経営陣の閲覧を想定した「Dear All, ...」から始まるビジネスライクな定型挨拶文を自動挿入するよう修正。

### 🎨 [UI & Formatting]
- **Smart Letter Layout**: `isLetterMode` 時のデザインを最終調整。会社名ヘッダーを `(from 会社名)` 形式に統一し、概況（Landscape）を斜体（イタリック）で配置。各記事のタイトルの直下にオレンジ色（`#d35400`）の1行要約を添えることで、圧倒的な視認性を実現。
- **HTML Double Conversion Fix**: メール送信直前に不要なテキスト変換（`markdownToLetterStyle_`）が走り、インデントなどのレイアウトが崩れる不具合を物理的に解消。

### 🛡️ [Reliability & Failsafe]
- **Markdown Link Auto-Recovery**: AI（Nanoモデル等）が記事タイトルのMarkdownリンク記法（`[タイトル](URL)`）を生成し損ねた場合でも、システム側がJSONの `links` 配列から生URLを抽出し、強制的にハイパーリンクを再構築するフェイルセーフ機能を `06_UI.js` に実装。「クリックできない記事」の発生を完全に防ぐ。

### ⚡️ [Performance & Cost]
- **Dynamic Token Allocation**: 安価で高速な `gpt-5-nano` モデルを月次レターに適用しつつ、長文出力時の途切れ（`finish_reason: length`）を防ぐため、`02_LlmService.js` を改修。呼び出し元 (`runMonthlyPartnerReport`) から動的に `max_completion_tokens: 4000` を指定し、トークン上限を解放できる柔軟なアーキテクチャを確立。

## [1.6.1] - 2026-04-23
### 🚀 [Feature & Intelligence] Monthly Partner Intelligence
- **Official Letter Delivery System**: 特定の提携先や関係会社向けに、月次で「公的レター形式（装飾を排したテキストライクなHTML）」のインテリジェンス・レポートを自動配信するジョブ (`runMonthlyPartnerReport`) を新設。
- **Source-Based Grouping**: 検索キーワードではなく、スクレイピング元の `Label`（`Partner-` 接頭語）をトリガーにして記事を抽出し、レポート内で会社ごとにセクション分割する動的グルーピングロジックを実装。
- **Markdown Hyperlink Formatting**: `markdownToLetterStyle_` ヘルパーを強化し、Markdownの `[タイトル](URL)` 記法を標準のHTMLハイパーリンクへ変換する処理を追加。これにより、見出し自体がクリック可能なスマートなレターUIを実現。
- **Strict Bouncer Strategy (Users Sheet)**: `Users` シートに新設した `MONTHLY_PARTNER` フラグ（L列）が有効なユーザーを、通常の日刊・週刊レポート配信 (`sendPersonalizedReport`) から強制除外するフールプルーフを実装。外部への社内情報誤送信リスクを物理的に遮断。
- **Targeted Scraping Regex**: Sysmex, Riken Genesis, OGT の3サイトに対し、ノイズ（ナビゲーションやConference等の非ニュース記事）を完璧に弾き、記事タイトルとURLのみをピンポイントで抽出する究極の正規表現を `Scrapers` シートに配備完了。

### 🛠️ [Tests & Maintenance]
- **Isolated Debug Sandbox**: 月次レター専用のデバッグツール `debugMonthlyPartnerReport` を `08_Tests.js` に追加。Usersシートの宛先設定を無視し、管理者(`MAIL_TO`)のみに強制送信することで、外部誤送信リスクなしで安全にレイアウト調整を行える環境を構築。
- **Task Labeling Precision**: `08_Tests.js` の `_askAiForRegex_` に欠落していた LLM タスクラベルを追加し、ログ出力の視認性を向上。

## [1.6.0] - 2026-04-22
### Added (追加)
* **PubMed Deep Collection パイプライン**: 旧 InsightCore の機能を YATA エンジンに高次元で統合。単なる抄録の収集にとどまらず、無料公開されている PMC (PubMed Central) 論文の全文から `[Methods]` や `[Results]` を積極的に吸い上げ、より重厚な AI 分析（5W1H抽出）を可能にしました。
* **AI ハイブリッドクエリ拡張機能**: 日本語や単純な英単語を入力するだけで、AIが自動的に `[MeSH Terms]` と `[TIAB]` (Title/Abstract) を OR で結合したプロ仕様の検索式に翻訳して PubMed へリクエストします。手動でガチガチの検索式を入力した場合は、AI が空気を読んでそのまま API へパスするセーフティ機能付きです。
* **PubMed 特別ダイヤ (ジョブスケジューラ)**: 毎時0分/30分の汎用ディスパッチャー (`jobDispatcher`) に特別ダイヤを新設。水曜日と土曜日の深夜3時台（週2回）のみ、通常の RSS 収集の代わりに PubMed 深掘り収集が自動で起動します。

### Changed (変更)
* **モジュールの責務の純化 (関心の分離)**: 汎用スクレイパーである `04_Scraper.js` から PubMed 特有の泥臭い処理をすべて物理的に削除し、`09_Pubmed-UI.js` へ完全に集約・カプセル化しました。これにより、システム全体の保守性が劇的に向上しています。
* **シームレスなレポート統合**: PubMed 由来の重厚な論文データも、毎朝のパーソナライズレポート配信機能 (`sendPersonalizedReport`) にネイティブ対応。ニュースと論文が自然に融合したインテリジェンス・レポートが届くようになりました。

### Removed (削除)
* **破壊的お掃除ロジックの永久追放**: E列（SUMMARY）が英語表記というだけで「ノイズ」と誤認して削除してしまう `clearEnglishSummaries` や、最新の構造化JSONを消去してしまう旧仕様のメンテナンスツールを物理削除しました。大切なデータ資産はもう二度と消えません。

## [1.5.6] - 2026-04-22
### 🚀 [Analytics & UX] Zero-Latency Tracking & Click Aggregation
- **Instant Tracking (Zero-Latency)**: `06_UI.js` の `doGet` トラッキング処理を根本から改修。中継ページでのボタン押下を待たず、ページが開かれた瞬間に裏で即座にログを記録するゼロ遅延方式を採用し、データ欠損を完全に排除。
- **Sandbox Breakout Redirect**: GASの `iframe` 制約と外部サイトの接続拒否 (`X-Frame-Options`) を回避するため、中継ページに `<base target="_top">` を導入。ユーザーの1クリックで安全に全画面で元記事へ遷移できる堅牢なUXを確立。
- **Click Count Aggregation Engine**: `03_Repository.js` の `archiveActionLogsToDrive_` を拡張。ログをDriveへ退避する前にURLごとのクリック数を高速集計し、`TREND_DATA` (collect) シートの `CLICK_COUNT` 列（新設のR列）へ一括で累計加算する機能を実装。将来的な「ユーザー関心の重心ベクトル算出」に向けたデータ基盤が完成。

### ⚡️ [Performance & Self-Healing] Ultra-Lightweight Maintenance
- **Blazing Fast Duplicate Removal**: `03_Repository.js` の `removeDuplicates_` を「データベース用」のロジックへ完全書き換え。全列読み込みを廃止し、URL列のみをメモリに展開（メモリ消費約1/18化）。さらに「下から上への連続行バッチ削除」方式を採用し、数万件規模のデータでも数秒で完了する超軽量処理を実現。
- **Self-Healing Daily Cycle**: 爆速化された `removeDuplicates_` を月1回の重メンテナンスから `runDailyMaintenance`（日次メンテナンス）へ昇格。
- **Autonomous Noise Cleaning**: 同じく日次メンテナンスに `toolResetAllJsonErrors()` と `clearEnglishSummaries()` を組み込み。AIのハルシネーション（英語化、JSON崩れ）を毎晩自動検知して空欄に戻し、翌日の要約ジョブで自動再試行させる「自己修復（セルフヒーリング）サイクル」を構築。
- **Heavy Maintenance Refactor**: 重メンテナンス (`runHeavyMaintenance`) をクリックログの集計・Drive退避ジョブ専用へ整理。

## [1.5.5] - 2026-04-16
### 🚀 [Feature] User Action Tracking & Analytics Foundation
- **Tracking Server Integration**: GASの `doGet` を拡張し、メール内の記事クリックや「いいね」を検知して記録するトラッキング・エンドポイントを実装。
- **Private Action Logging**: 非公開（設定用）スプレッドシートに `ActionLogs` シートを新設。ユーザーのEmail、クリック日時、URL、キーワードを自動記録し、関心度を可視化する仕組みを構築。
- **Seamless Tracking URLs**: レポート生成時、リンクをトラッキングURLへ自動書き換え。スクリプトプロパティ `WEBAPP_URL` を利用することで、外部の短縮URLサービスに依存しない安全なGASネイティブの行動分析を実現。

### 🎨 [UX & Security]
- **Smart Redirect Page**: ブラウザのクロスサイトトラッキング防止機能（ITP）やiframeのセキュリティ制限によるリダイレクト拒否を回避するため、リッチな「転送中継ページ」を導入。自動転送がブロックされた場合でも、ユーザーが意図的にボタンを押すことで確実に元記事へ遷移できる堅牢なUIを実現。

### 🧹 [Scalability & Maintenance]
- **JSON Log Archiving**: 蓄積されるクリックログによる `ActionLogs` シートの肥大化を防ぐため、データをJSON形式でGoogle Driveへ自動退避し、シートを空にするアーカイブ機能（`archiveActionLogsToDrive_`）を実装。
- **Heavy Maintenance Workflow**: 重メンテナンスジョブ（`runHeavyMaintenance`）にログアーカイブ処理を統合。長期間の運用でもスプレッドシートのパフォーマンスが低下しないスケーラブルな設計を確立。

## [1.5.4] - 2026-04-16
### 🚀 [Feature & Personalization]
- **Priority Scoring Engine**: `Users` シートに「優先キーワード（K列: PRIORITIES）」を追加。検索でヒットした記事群に対し、優先キーワードが含まれる記事を高スコア化し、LLMへ渡すリストの最上位に押し上げる重み付けソート機能（`_sortArticlesByPriority_`）を実装。
- **Smart Query Expansion for Priorities**: 優先キーワードの判定にもAIによる自動クエリ展開（`expandKeywordQuery_`）を適用。「がん」と入力するだけで「Cancer」や「Tumor」も自動で加点対象とする、表記揺れに完全対応したインテリジェントなスコアリングを実現。

### 🎨 [UI & Prompt Engineering]
- **Clean Digest Formatting**: 日刊ダイジェストおよびパーソナライズレポートの目次から、文字化けの原因となっていた生の絵文字を排除し、安全なHTML実体参照（`&#128209;`）へ置換。
- **Bullet Point Styling**: ダイジェストの目次および本文の見出しフォーマットを、順位付け（1位、2位…）からフラットなバレット（・）形式へ統一し、視認性を向上。
- **Prompt Strictness**: `DIGEST_RANKING_SYSTEM` および `DIGEST_RANKING_USER` プロンプトを改修。「英語タイトルのカッコ併記」と「ランキング表記」を厳格に禁止する制約を追加。

### 🛠️ [Testing & Maintenance]
- **Debug Sync**: テスト配信ツール `debugPersonalReport` においても、K列の優先キーワード設定を動的に読み込んでテストできるようロジックを同期。本番環境を汚さずにパーソナライズの精度検証が可能に。

## [1.5.3] - 2026-04-16
### 🚀 [Scalability & Infrastructure]
- **Infinite Horizontal Scaling**: 個別レポート配信 (`sendPersonalizedReport`) における最終送信日時の記録先を、容量上限(9KB)のある `PropertiesService` のJSONから、`Users` シートの `LAST_SENT` 列（J列）へ直接書き込む方式へ完全移行。これにより、ユーザー数や長大な検索キーワードに対する物理的なスケール限界を撤廃。

### 🤖 [Logic & Prompt Engineering]
- **Batch Summarization Hardening**: `BATCH_SYSTEM` プロンプトを極限までチューニング。
  - AIによる `tldr` のサボり（短すぎる出力）を防ぐため、「2〜3文（200字程度）」という具体的なボリューム指定を追加。
  - Markdownコードブロック（```json）の出力を明示的に禁止し、パースエラーの発生率をさらに低減。
  - プロンプト内のJSONエスケープ (`\"Unknown\"`) を厳格化し、LLMの構文解釈ブレを防止。

### 🐛 [Bug Fixes]
- **Global Syntax Error Resolution**: `00_Config.js` をはじめとする全モジュールのファイル末尾に混入していた不正な閉じカッコ `}` を一斉削除。モジュール読み込み時の隠蔽された構文エラーを解消し、`ReferenceError: AppConfig is not defined` の発生を完全に根絶。

### 🛠️ [Tools & Maintenance]
- **Data Migration Tool**: 旧仕様の `PropertiesService` に蓄積されていたJSON形式の送信履歴を解析し、`Users` シートの該当行へ自動復旧・マッピングする移行スクリプト `toolMigrateJsonToSheet` を追加。

## [1.5.2] - 2026-04-13
### 🔬 [Feature] PubMed Dedicated UI & Seamless Routing
- **Frontend Routing**: 一般ニュース検索の `Index.html` と論文要約ツール `Pubmed.html` をシームレスに行き来できるルーティング機能 (`?p=pubmed`) を実装。
- **Smart Toggle System**: `Users` シートの `PUBMED` 列（I列）の役割を「専用クエリ入力」から「ON/OFFフラグ」へ仕様変更。フラグがONのユーザーに対し、一般ニュースと同じ `KWS` 列（D列）のキーワードを用いて PubMed 論文を自動収集するスマートな設計へ進化。

### 💠 [Architecture & Integration]
- **YATA Bridge (`09_Pubmed-UI.js`)**: 旧 InsightCore の UI リクエストを受け止め、YATA の強力なバックエンドへ横流しするブリッジモジュールを新設。手動要約時も YATA の `LlmService.summarizeBatch` を経由させることで、圧倒的な高速化とコスト最適化を実現。
- **Centralized Reporting**: 収集された論文（PubMed/arXiv）が共通の `TREND_DATA` シートへ蓄積され、一般ニュースと共に `sendPersonalizedReport` で「今週の動向」として一括配信される完全統合フローを確立。

### 🗑️ [Cleanup & Deprecation]
- **Legacy Code Removal**: YATA の汎用 `BATCH_SYSTEM` (5W1H抽出＆自動翻訳) が旧プロンプトの完全な上位互換として機能することが証明されたため、旧 `InsightCore.js` および `prompts.md` をプロジェクトから物理削除。
- **UI Code Cleanup**: `Index.html` に存在した重複ブロック（検索のコツ）の削除、および `Pubmed.html` の不要な空 CSS ルールの整理。

## [1.5.1] - 2026-04-12
### 🧪 [Refinement] PubMed Intelligence & 5W1H Logic Optimization
- **Golden Configuration Established**: PubMed論文解析において「専門家ペルソナ」をあえて外し、ニュース共通の `BATCH_SYSTEM` プロンプトを適用。これにより、LLMの独自要約バイアスによる構造破壊を防止し、完璧な 5W1H 抽出を実現。
- **Intelligent Model Selection**: PubMed論文（2,500文字緩和枠）に対し、知能の高い `ModelMini` (GPT-4o-mini等) を自動適用するロジックを確立。
- **Smart Query Builder**: AIによる PubMed クエリ拡張エンジンを正式統合。日本語の抽象キーワードから Mesh用語/TIABタグを駆使した高度な検索式を自動生成。
- **Unified Batch Protocol**: 内部の入力キーを `content` から `text_to_analyze` へ改名し、AIの「対になるキー(summary)を勝手に作る」癖を物理的に封じ込め。
- **Automated Collection Integration**: `runPubMedJob` を新設し、Usersシートの PubMed 列に基づいた自動巡回・解析フローを確立。

## [1.5.0] - 2026-04-11
### 🔬 [Major Feature] InsightCore Integration (Medical/Scientific Intelligence)
- **PubMed/PMC Scraping Engine**: 『InsightCore』より移植された PubMed 検索および PMC 全文スクレイピングロジックを `04_Scraper.js` へ統合。抄録(Abstract)のみならず、IntroductionからConclusionまでの重要セクションをピンポイントで抽出可能に。
- **Hybrid Summarization Pipeline**: `YATA.js` の要約プロセスを刷新。収集ソースが "PubMed" の場合、専用プロンプト `PAPER_BATCH_SYSTEM` へ自動分岐し、論文特有の「手法(HOW)」「成果(RESULT)」を高密度に抽出する知能を実装。
- **Advanced Hybrid Search (TODO Anticipated)**: ベクトル検索とキーワード一致の統合スコアリングの基盤を構築（`yata-loader.js` への先行パッチ）。
- **Raspi Hybrid Deployment**: ローカル運用（local-raspi）における PubMed / PMC 連携の外科的統合を完了。

## [1.4.20] - 2026-04-10
### 🤖 [Logic & Intelligence] (Query Expansion Engine Evolution)
- **Deep Medical/IT Vocabulary Expansion**: `expandKeywordQuery_` の推論モデルを格上げし、最新の疾患分類や専門的な略称まで広範にOR展開する語彙力を獲得。
- **Bulletproof Prompting**: YATAの内部テキストマッチでの構文エラーを防ぐため、厳格な最適化プロンプトを導入。

## [1.4.19] - 2026-04-09
### 💠 [Core/Architecture] (Branch Synchronization & TOC)
- **Multi-Branch Alignment**: `local-raspi` (SSoT) の Modular YATA v2.0 成果を `main` リモートへ完全同期。
- **Intelligent Table of Contents (TOC)**: ダイジェスト形式のメール冒頭に「本日のラインナップ（目次）」を自動生成するロジックを実装。
- **Seamless Anchor Navigation**: 各見出しへのアンカーリンク（`#topic-N`）を自動付与し、操作性を向上。
- **SKIP Article Filtering**: ニュース取得ロジックに `SKIP` 記事（要約スキップ済み）の除外フィルタを実装。
- **Doc Integrity**: `PROJECT_GUIDE.md` 等を最新のモジュール構造にアップデート。

## [1.4.18] - 2026-04-08
### 💠 [Core/Architecture] (Modular YATA v2.0)
- **Monolith Deconstruction**: 5500行を超えた巨大な `YATA.js` を解体し、9つの専門モジュール（00_Config 〜 08_Tests）へ完全分離。`YATA.js` 自体はジョブの指揮（オーケストレーション）に特化させ、保守性と可読性を劇的に向上。
- **Ordered Numbering Strategy**: GASエディタ上のタブ並び順を制御するため、ファイル名に番号付きナンバリングを採用。依存関係が一目で把握可能に。
- **Tests & Debug Isolation**: `08_Tests.js` を新設し、本番コードを汚さずにデバッグ・診断機能を維持。

### 🛠️ [Internal Modules]
- **Repository Pattern**: `03_Repository.js` にデータアクセス（シート/SQLite）を集約。列インデックス操作を隠蔽。
- **Scraper Engine**: `04_Scraper.js` にRSSパース、全文スクレイピング、PDF抽出ロジックを統合。
- **Analytics Engine**: `05_Analytics.js` に予兆検知、ベクトル検索、クエリ拡張を集約。
- **UI & Reporting**: `06_UI.js` にHTMLメール生成、Web UI制御を委譲。デザイン修正がロジックに影響しない構造へ。

### 🤖 [Logic & Intelligence]
- **Surgical Sync from Remote**: `origin/main` (v1.4.16.1) からの最新ロジック（日英別の動的スクレイピング閾値、高度な検索クエリパーサー）を、リファクタリング後の新構造へ外科的に移植・統合。

## [1.4.17] - 2026-04-07
### 💠 [Core/Common] (YATA.js Logic & Shared Prompts)
- **Ollama API Integration**: 全てのローカルLLMタスクを Ollama API (11434) 経由に統一。`llama_cpp-python` への直接依存を排除し、システムの安定性と応答速度を向上。
- **Intelligent Model Selection**: `.env` の `LOCAL_LLM_MODEL` による優先モデル指定を導入。指定モデルがない場合は `qwen2.5:3b` -> `gemma4:e2b` の順で自動フォールバックする動的選択ロジックを実装。

### 🤖 [Local LLM & AI]
- **Ollama Engine Optimization**: 
    - `OLLAMA_KEEP_ALIVE=0` 設定により、推論終了後のメモリ即時解放を実現。物理メモリ 8GB の効率的な使い分けを可能に。
    - `OLLAMA_ORIGINS="*"` 設定により、外部 UI ツールからのセキュアなアクセスに対応。
    - **CPU Thread Control**: 全ての AI タスクにおいて `num_thread: 3` を適用。4コア中1コアをシステム維持用に常時温存し、高負荷時のレスポンス低下を防止。
- **Mutter Engine Upgrade**: 
    - 毎時 0 分の「独り言 (ai-mutter)」生成を Ollama 駆動へ移行。モデルのロード待ちを排除し、定時ジョブ時のメモリ衝突（スワップ地獄）を完全に解消。
    - **Persona Synchronization**: 独り言のペルソナを `persona.txt`（メイドのヤタ）へ統一。
    - **Philosophical Prompt Design**: コンテキストを比喩として自然に織り込む「自律思考型プロンプト」を導入。小型モデル（Qwen2.5:3b）のポテンシャルを最大限に引き出し、情緒豊かで自然な一文の独白を実現。



### 🛡️ [Infrastructure & Security]
- **Infrastructure Fortress (ufw)**: 
    - `tailscale0` および自宅 LAN (`192.168.1.0/24`) を全面的に信頼し、それ以外のインターフェースからの受信を全て遮断 (Deny) する「要塞化」を完遂。
    - 外出先からの SSH/Ollama 利用と、家の中でのローカルIPアクセスを安全に両立。
- **Ultimate Resource Optimization**:
    - RAMディスク（tmpfs）を実情に合わせて `/dev/shm` (1GB) / `/tmp` (512MB) に制限し、物理メモリを LLM 用に明け渡す。
    - `swappiness=10` 設定と 2GB スワップのリセットにより、以前 100% だったスワップ消費を 0% 台へ劇的に改善。
- **Maintenance Tools**: 
    - `yata-status` エイリアスを導入。一撃でメモリ、PM2、Ollama、UFW、温度を確認可能に。

## [1.4.16] - 2026-04-06
### 💠 [Core/Common] (YATA.js Logic & Shared Prompts)
- **Modularization Phase 1**: 巨大な `YATA.js` モノリスを解体し、コア機能を以下の 3 つの外部モジュールへ分離。
  - `lib/YATA-Config.js` (AppConfig の抽出)
  - `lib/YATA-Helpers.js` (Utility 関数の抽出)
  - `lib/YATA-LlmService.js` (AI 通信/コスト管理の抽出)
- **Multi-Module Loader**: `lib/yata-loader.js` を拡張し、依存関係順 (Config -> Helpers -> LlmService -> YATA.js) での動的ロードをサポート。
- **18 Column Structure**: `Collect` シートに `CATEGORY` 列が新設されたことに伴い、SQLite 連携 (`gas-bridge.js`) を完全追従。
- **Enhanced Digest Richness**: Digestモードのプロンプト (`DIGEST_RANKING_SYSTEM/USER`) を大幅強化。構造化データ (WHAT/HOW/RESULT) をフル活用し、200〜300文字の「肉厚」な解説文を生成するよう調整。文系新入社員向けの専門用語解説ロジックを組み込み、ハルシネーション（捏造）を抑えつつ情報の密度を向上。
- **Japanese Query Expansion+**: キーワード拡張エンジン (`expandKeywordQuery_`) のプロンプトを改善。英語翻訳だけでなく、日本語特有の表記揺れ（例：がん/癌/ガン、ZFN/ジンクフィンガー等）を自動で OR 展開するよう強化し、国内ニュースの網羅性を向上。

### 📊 [Reporting & UI]
- **Display Labels for Users**: `Users` シートに「Label（5列目）」を新設。複雑な AND/OR クエリを裏側で回しつつ、メール件名やレポート見出しには「技術動向」等の簡潔な名称を表示できる機構を実装。ラベル未入力時の自動クエリ引用（後方互換）も維持。
- **Debug & Job Synchronization**: `debugPersonalReport` および `dailyDigestJob` において、新設されたラベル列が反映されない不具合（件名が巨大なクエリで埋まる問題）を修正。

### 🛠️ [Maintenance & Assets]
- **AppConfig Update**: `UsersSheet.Columns` の定義を更新し、スイッチ群のインデックスを物理的に同期。

## [1.4.15] - 2026-04-06
### 💠 [Core/Common] (YATA.js Logic & Shared Prompts)
- **Digest Mode - Top 10 Ranking Engine**: Digestモード（`DAILY_KW_DIGEST`）専用のプロンプトと処理ルートを新設。高度な考察を省き、事業インパクトの大きいTOP 10記事の選定、外国語タイトルの自動日本語翻訳、純粋なファクト（tldr）の速報出力に特化。
- **Strict 6-Month Bouncer (Scraper)**: スクレイピング時の除外防壁を強化。URL内の8桁日付（例: `20251203`）等を正確に抽出し、現在から6ヶ月以上前の化石記事（PDFリリース等含む）を完全にシャットアウトする処理を実装。
- **UI Render Fix**: トレンドレポートの `SOURCES:` において、複数のURLが1つの文字列として結合されてしまうバグを修正。配列およびカンマ/改行区切りを正しくパースし、独立したリンクバッジ（`[1] [2] [3]`）として表示するよう改善。
- **Tooling**: GASのUI制約を受けずにバックグラウンドでスクレイパーのAIセットアップを実行できる `toolBatchSetupScrapersSilent` を追加。

## [1.4.14] - 2026-04-03
### 💠 [Core/Common] (YATA.js Logic & Shared Prompts)
- **Stateful Engine Refactoring**: `sendPersonalizedReport` の配信履歴管理を個別プロパティから単一のJSONプロパティ (`YATA_USER_TIMESTAMPS`) へ統合。GASのプロパティ数上限（50件問題）を物理的に回避し、スケーラビリティを向上。
- **Multi-Profile Support**: ユーザーの識別キーを「メールアドレス＋キーワード」の複合キーに変更。これにより、同一メールアドレスで複数行（異なるキーワード・設定）を Users シートに登録しても、それぞれの配信履歴と対象期間が独立して正常に処理されるよう改善。

## [1.4.13] - 2026-04-03
### 💠 [Core/Common] (GAS互換・全環境共通)
- **Infrastructure**: `llama-cpp-python` を v0.3.19 へアップグレード。2026年3月末リリースの最新 GGUF 形式（量子化タイプ41等）への内部的な対応準備を完了。
- **Documentation**: `PROJECT_GUIDE.md` を最新の LLM 運用スペックに合わせて全体を同期。

### 🍓 [Environment: Local-RasPi] (ラズパイ固有・ローカルAI)
- **Local LLM**: メインモデルを **Qwen 2.5 3B Instruct (Q4_K_M)** へ刷新。
    - **省メモリ**: メモリ消費を 4.6GB (Gemma 3) -> 3.8GB へ約 800MB 削減。ラズパイ 5 のリソースに大きな余力を創出。
    - **日本語性能**: 漢字の扱いや文末の自然さが大幅に向上。YATA の要約タスクにおける指示遵守能力（JSON 構造の維持）の強化を確認。
    - **生成速度**: 約 15.0〜22.0 tokens/sec の高速応答を維持。
- **R&D (1-bit LLM検証)**: PrismML **1-bit Bonsai 8B** (BitNet) の導入検証を実施。
    - **結果**: 採用見送り。現状の `llama.cpp` (ARM/CPU) カーネルが 1-bit 量子化形式に未対応であり、出力の文字化け（NONE型エラー）が発生することを確認。技術の成熟を待つ判断を下した。

### 🛠️ [Maintenance & Assets] (DB・ログ・物理環境)
- **Log Management**: SSD (NVMe) 直接書き込み運用における安定性を確認。
- **Version Management**: プロジェクト全ファイルのバージョンを 1.4.13 へ物理同期。

## [1.4.12] - 2026-04-02
### 🍓 [Environment: Local-RasPi]
- **GAS Bridge (UrlFetchApp.fetch)**: `response.getHeaders is not a function` エラーを解消。`curl -i` を利用してレスポンスヘッダーの取得 (`getHeaders`) とバイナリデータ処理 (`getBlob`, `getBytes`) をネイティブサポート。これにより、PDF判定やスクレイピング時の本文補完が正常に動作するよう改善。

## [1.4.11] - 2026-04-02
### 🍓 [Environment: Local-RasPi]
- **Hybrid Boot Architecture**: SDカードをブート（玄関）、SSD (NVMe) をルート（居室）とする爆速・高耐久構成へ完全移行。SDカードの摩耗問題を根本的に解消。
- **Infrastructure Cleanup**: `log2ram` を廃止し、ログ出力を SSD 直接書き込みへ変更。マウント構造のシンプル化と耐障害性を向上。
- **Python Environment**: SSD側で不足していた `trafilatura` を再インストールし、スクレイピング機能を正常化。

### 🛠️ [Maintenance & Assets]
- **Database Restoration**: SSD移行直後のメモリDB不整合（記事数 0 問題）を検知し、物理ディスク上の 23,682 件を正しく再ロードして復旧。

## [1.4.10] - 2026-04-02
### 💠 [Core/Common] (YATA.js Logic & Shared Prompts)
- **5-Switch Personalization**: Usersシートのスイッチと連動し、トラッキングからディスカバリーまで 5段階で個人設定を最適化できる機構を実装。
- **Test Sandbox**: Usersシートの2行目を「テスト専用枠」として分離。記憶領域を汚染せずにUIや設定をテストできる環境を構築。
- **Query Expansion Engine**: AIによるキーワード拡張（英語・略称展開）とハイブリッド検索の連携を最適化。
- **Digest UI Emoji Fix**: 見出しの絵文字文字化けを HTML 実体参照（`&#128204;`）で物理的に解消。

## [1.4.9] - 2026-04-01
### 💠 [Core/Common] (YATA.js Logic & Shared Prompts)
- **Scraper Comparison Tool**: 正規表現設定と AI 提案案の的中率をリアルタイム診断するツールを実装。
- **Noise Filter**: 本文抽出前にナビゲーションやフッターを抹消するフィルタリングを実装。
- **Regex Robustness**: AI 提案の非互換フラグを自動除去する防壁を実装。
- **UUID Generation**: 一時ファイル命名に `getUuid()` を採用し、並列稼働時の衝突リスクを物理的に排除。
- **Bug Fix**: `expandKeywordQuery_` 内の変数宣言を修正し、クエリ拡張時の収集停止エラーを解消。

## [1.4.8] - 2026-03-31
### 💠 [Core/Common] (YATA.js Logic & Shared Prompts)
- **Universal Scraper Engine**: 汎用ロジック `collectScrapedFeeds_` を本家から統合し、Node.js環境での稼働を確認。
- **Optimization**: 本文抽出上限を 500 文字に制限し、コストと TPM リミット問題を解消。
- **Resilience**: メガファーマ勢の Next.js 構造等を解析し、推論ベースの正規表現による「攻めの収集」設定を完了。

### 🍓 [Environment: Local-RasPi]
- **Intelligence Hub**: 診断薬・医療機器系メーカー 21 社のニュースサイト監視を統合（`scrapers-list.json`）。
- **GAS Bridge**: `scrapers-list.json` へのブリッジ接続、および GAS UI系関数の完全モック化を完了。


## [1.4.7] - 2026-03-31
### 💠 [Core/Common] (YATA.js Logic & Shared Prompts)
- **Intelligent Pipeline**: 本文が短い場合に自動でリンク先をスキャンする「能動的本文補完」を実装。
- **Resilience**: 本文取得直後の更新フラグ更新により、AI 要約が失敗しても素材を保持する再開性を確保。
- **High-Density Feeds**: タイトルのみのフィードからも元記事から直接情報を引き出すことで、高密度な AI 分析を実現。

## [1.4.6] - 2026-03-31
### 💠 [Core/Common] (YATA.js Logic & Shared Prompts)
- **Token Calculation**: 各種 Usage オブジェクト形式に動的に対応するトークン計算ロジックへ刷新。
- **Performance**: GAS 本番環境での超高速なスプレッドシート書き込み（9列一気書き）ロジックを最適化。

### 🍓 [Environment: Local-RasPi]
- **GAS Bridge**: `setValues` メソッドを大幅強化。GAS 互換のバルクアップデートを SQLite トランザクションで完全再現し、クロス環境の互換性を確立。

## [1.4.5] - 2026-03-30
### 🍓 [Environment: Local-RasPi]
- **GAS Bridge**: `setValues` の一括更新ロジックにおける新規行スキップ不具合を修正。完全マッピング・インジェクションを実装し、RSS 収集と要約のバトンパスを復旧。

## [1.4.4] - 2026-03-30
### 💠 [Core/Common] (YATA.js Logic & Shared Prompts)
- **ADLM Scraper**: Clinical Laboratory News (ADLM) の直接収集ロジックを追加。
- **AI Prompt**: 要約プロンプトに「日本語強制」ルールを追加し、OpenAI Responses API での多言語混在を解消。

### 🍓 [Environment: Local-RasPi]
- **Infrastructure**: 常駐サーバー群 (`yata-bot`, `yata-ai-server`) の完全復旧と PM2 永続化（シャットダウン時の保護強化）。

### 🛠️ [Maintenance & Assets]
- **Policy**: USPTO PTAB 代替運用（Patently-O 等の活用）の策定。

## [1.4.3] - 2026-03-30
### 🛠️ [Maintenance & Assets]
- **Performance**: 過去記事の再構造化ツール (`toolBackfillStructuredSummaries`) に `setValues` を適用し、通信回数を 80% 削減。

## [1.4.2.3] - 2026-03-29
### 💠 [Core/Common] (YATA.js Logic & Shared Prompts)
- **OpenAI Responses API**: `usage` オブジェクトのキー変更および `reasoning_tokens` 抽出に対応。

## [1.4.2.2] - 2026-03-28
### 🍓 [Environment: Local-RasPi]
- **Windows Batch**: 管理バッチを v4.6 (Modern-Log) へ刷新。JST 補正とエスケープ防壁を実装。

## [1.4.2.1] - 2026-03-28
### 🍓 [Environment: Local-RasPi]
- **GAS Bridge**: ヘッダー名からの動的カラムマッピング（Index 自動特定）を実装。

### 🛠️ [Maintenance & Assets]
- **Safety**: 物理的なデータ減少ガード（20% 減少で同期停止）を導入。
- **Restore**: 大規模データ消失事故からの完全復旧（NAS バックアップからの復元）を完遂。


## [1.4.2] - 2026-03-28
### 💠 [Core/Common] (YATA.js Logic & Shared Prompts)
- **Search Logic**: 内積 (Dot Product) 計算への置換によるベクトル検索の高速化。
- **UI**: ダッシュボードのニュース表示を最新順 (`date DESC`) に変更。

### 🛠️ [Maintenance & Assets]
- **Sync**: `YATA.js` の配列構造と `gas-bridge.js` のインデックス参照を物理的に 1:1 同期。

## [1.4.1] - 2026-03-28
### 💠 [Core/Common] (YATA.js Logic & Shared Prompts)
- **Search**: 二刀流（ハイブリッド）検索、およびベクトルキャッシュ機能を実装。

### 🍓 [Environment: Local-RasPi]
- **Infrastructure**: 管理コンソールを v5.1.2 へ刷新。
- **Loader**: 聖域の関数を強制上書きする「最強物理パッチ (Strong Patch System)」を確立。
- **Bridge**: `stripHtml_` パッチを強化し、プレーンテキスト版メールの視認性を劇的に向上。

## [1.4.0] - 2026-03-28 (The Great Integration: 真・全統合版)
今回のアップデートは、ローカル環境 (Raspberry Pi) で先行していた高度な分析機能と、本家 (GAS/main) で導入された新しいデータ構造を完璧に融合させた「次世代の統合安定版」です。

### 💠 [Core/Common] (YATA.js Logic & Shared Prompts)
- **1.4.0 構造化JSON (5W1H) 統合**: 記事を 5W1H の個別カラムに保存する最新仕様を SQLite 側でも完全統合。
- **High-Density Context Engine**: 分析時に JSON から不要な情報を排除し、最高密度の文脈を LLM に供給するロジックを実装。
- **OpenAI Responses API (gpt-5-nano)**: 最新エンドポイントを用いた爆速・低コスト要約を安定稼働。
- **Usage Normalization**: API 通信ごとのモデル名とトークン記録の精度を向上。
- **System**: `initializeSystemProperties()` による設定不備の自動修復機能を統合。

### 🛠️ [Maintenance & Assets]
- **Integrity Protocol**: `tests/verify-db-integrity.js` を作成し、DB の物理的整合性検証を標準化。
- **Tools**: 過去記事の構造化バックフィルツールを追加。


## [1.3.3] - 2026-03-25
### Added
- **高密度コンテキスト・エンジン (High-Density Context Optimization)**:
    - 構造化抽出された 5W1H (who, what, how, result 等) の JSON から、`Unknown` 要素を排除し、論理的順序（WHAT→HOW→RESULT...）で再構成する高密度テキスト生成ロジック `getArticleContextForAnalysis_` を実装。
    - トレンド分析 (`generateTrendSections`) および予兆検知 (`EmergingSignalEngine`) に適用し、AI (miniモデル) への入力コンテキストを極限まで効率化。
    - 実データ検証により、文字数ベースで約 16〜30% のトークン削減と、分析精度の向上を物理的に証明。
- **実戦テストスイート**: 
    - `tests/test-context-optimization.js` (単体テスト) および `tests/test-real-trend-analysis.js` (実データによる AI 分析テスト) を追加。

### Changed
- **分析コンテキストの刷新**: 従来の「生の TL;DR (JSON形式)」から「素材ベースの高密度テキスト」へ移行。mini モデルの注意力を技術の核心（手法・成果）に集中させる設計へ進化。

## [1.3.2] - 2026-03-24
... [rest of file] ...All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.1] - 2026-03-24
### Fixed
- **英語記事の要約が英語になる問題を根本修正**:
    - `BATCH_SYSTEM` プロンプトをはじめとする全要約プロンプトにおいて、「出力は必ず日本語（Japanese）で行うこと」という指示を【最重要】項目として明示的に追加。これにより OpenAI Responses API での多言語混在を解消。
- **要約フォールバック時の致命的バグ修正**:
    - `lib/YATA.js` の `summarizeBatch` 内において、バッチ処理失敗時の個別リトライ（フォールバック）で `this.summarize` という不正な呼び出しをしていた箇所を `LlmService.summarize` に修正。
- **OpenAI Responses API の安定化とパース防壁の構築**:
    - `lib/YATA.js` における `_callOpenAiResponses` の致命的バグ（システムプロンプトの指定ミスによる400エラー）を修正。新仕様に基づき `instructions` パラメータへ移行。
    - **鉄壁のパース処理**: `JSON.parse` 前の try-catch 保護、`output_text` の厳密な型チェック、短すぎる応答の除外、429 (Rate Limit) 時の自動スリープを実装。
    - 異常パラメータ `response_format` を廃止し、プロンプトベースでの JSON 抽出に回帰することで、API レスポンスの安定性を 100% 確保。
- **管理コンソールのマルチプラットフォーム完全対応**:
    - Windows 版ランチャー (`local_public/yata-launcher-windows.txt`) を刷新。不安定な PowerShell パイプを廃止し、Git Bash を活用したネイティブ `.sh` スクリプト方式へ転換。
    - `yata-menu-core.sh` におけるプロンプトのバッファリング問題を解消。改行付き `echo` への変更により、SSH 越しでもリアルタイムに入力を促すメッセージが表示されるよう改善。
- **セキュリティ & 運用性向上**:
    - `lib/gas-bridge.js` において、`curl` 実行ログ内の API キーを自動マスク (`sk-[MASKED]`) する防壁を実装。
    - 詳細なデバッグログを環境変数 `DEBUG_CURL=true` 時のみに制限し、通常の運用コンソールをクリーンに維持。

## [1.3.0] - 2026-03-23
### Added
- **ブランチ構造の純化と会社共有用セットの確立**:
    - `main` ブランチを会社共有用（GAS環境等）に必要な 6 ファイル（`lib/YATA.js`, `Index.html`, `Visualize.html`, `prompts.json`, `CHANGELOG.md`, `README.md`）に整理。不要なローカル用ファイル（`package.json`, `gas-bridge.js` 等）を物理的に排除し、視認性と安全性を向上。
    - `public` ブランチを OSS 公開用として再定義。機密情報を除いたサニタイズ済みの `prompts.json` とライセンスを含む配布用 6 ファイル構成へ集約。
    - 開発環境である `local-raspi` を「唯一の正本 (SSoT)」として物理的に分離・確立。
- **プロンプト命名の正常化とオーバーライド機構の導入**:
    - ファイル命名を実態に合わせ、`prompts.json`（標準/会社用・旧 `prompt_company.json`）と `prompts_local.json`（自分専用/ローカル用・旧 `prompts.json`）にリネーム・分離。
    - `lib/gas-bridge.js` を改修。ローカル環境では `prompts_local.json` を優先的に読み込み、なければ `prompts.json` を使用する「動的オーバーライド方式」を採用。
    - これにより、本家同期を維持しつつ、ローカル環境で自由にプロンプトをチューニングできる「安全なサンドボックス」を構築。
- **ドキュメントの品質向上**:
    - `PROJECT_GUIDE.md` におけるブランチ戦略と構成マトリックスを最新の状態に更新。
    - ドキュメント内の誤字（ハングル助詞「의」の混入等）を一括修正し、日本語としての純度を確保。

## [1.2.12] - 2026-03-21
### Added
- **究極のスクレイピング・エンジン (Ultimate Scraper Engine)**:
    - **物理的リダイレクト追跡**: Google News 等の複雑なリダイレクトを `curl` で物理的に最後まで追いかけ、真の記事 URL を 100% 特定する機能を実装。
    - **Python Trafilatura 連携**: 本文抽出の決定版ライブラリ `trafilatura` を Python ブリッジ経由で導入。広告やノイズを排除した純粋な本文のみを LLM に供給。
    - **RSS コンテンツ・フォールバック**: サイト側からのボット遮断時も、DB 内のタイトルと概要 (abstract) を自動的にソースとして使用し、解析を継続する堅牢なフェイルセーフを確立。
    - **バイナリ・デコーダー**: Google News URL の Base64 内部に含まれる URL をバイナリレベルでスキャンする独自ロジックを搭載。

## [1.2.11] - 2026-03-21


## [1.2.10] - 2026-03-21
### Added
- **API通信ごとの詳細コスト記録（SDカード非破壊アーキテクチャ）**:
    - `lib/gas-bridge.js` において、従来の1日累計に加え、通信ごとの詳細情報（タイムスタンプ、モデル名、入出力・推論トークン数、コスト）を `api_usage.log` にJSON Lines形式で記録する機能を実装。
    - SDカードの摩耗を防ぐため、記録先を RAM ディスク (`/dev/shm/api_usage.log`) に指定。
    - `maintenance/do-backup.sh` を改修し、毎朝4:35に RAM ディスクから NAS (`/mnt/nas/yata_logs/`) へ日別ファイルとして退避させ、過去30日分を安全に保管・ローテーションする仕組みに統合。これにより、特定時間帯における特定のモデル（nano等）の異常なトークン消費を追跡可能とした。

## [1.2.9] - 2026-03-20
### Added
- **5件バッチ要約「超節約モード」の導入**:
    - `lib/yata-loader.js` において、`LlmService.summarizeBatch` をオーバーライドする実行時パッチを実装。
    - 従来の「1記事1リクエスト」から「5記事1バッチ（1プロンプト）」へ移行し、入力トークンの約 60〜80% 削減を達成。
    - バッチ用プロンプトを `prompts.json` へ外出しし、設定の柔軟性を向上。
    - 失敗時に自動で「1件ずつモード」へ戻る堅牢なフォールバック機構を搭載。
- **検証用スクリプト**: `tasks/test-batch-summarize.js` を追加。

## [1.2.8] - 2026-03-19
### Added
- **究極の効率化 & ダッシュボード刷新**: 
    - プロンプト圧縮とSingle-Pass抽出（要約+手法）によりAPI通信回数を 33% 削減。
    - 電子ペーパーダッシュボードにLLM詳細統計（i/o/rトークン）、JST変換ニュース、詳細システムリソース表示を実装。
- **詳細トークン管理 (v1.2.7)**: 
    - APIから思考トークンを含む usage を正確に取得し、日次DB (`api_usage_daily`) に累積記録する機能を実装。

## [1.2.6] - 2026-03-19
### Fixed
- **HTML清掃 & コスト適正化**: 
    - DB内の `abstract` カラムに混入していた HTML タグ汚染(906件)を一括清掃。
    - `yata-loader.js` による強力な HTML ストリップ防壁を強化。
    - 要約プロンプトの自然化により、トークン爆増を制圧。

## [1.2.5] - 2026-03-19
### Fixed
- **ラッパースクリプトの引数消失バグ修正**: `run-ram.sh` のSDカード保護機能アップデート時（2月26日）に混入した潜在バグを修正。`--light` などの追加引数が Node.js に渡されず、5分毎のライトタスクが常にフルタスク（RSS全収集＋AI要約）として実行されていた致命的な不具合を解消。これによりRaspberry Piの負荷とAPIコストを劇的に削減。

### Changed
- **情報ポートフォリオの完成**: `rss-list.json` を大幅にアップデート。重複フィードを整理し、「ロイター（国際）」「BBC」「CNN」などのフラットな世界情勢と、「ナゾロジー」「sorae」「ねとらぼ」などの知的好奇心を刺激するエンタメ・科学ニュース枠を追加。YATAのAI要約エンジンに最適な「見出し＋スニペット」の形式で収集効率を最大化。

### Added
- **Gzip Compression Support (Bridge)**: `lib/gas-bridge.js` の `curl` コマンドに `--compressed` フラグを追加。本家 v1.2.5 から導入された `Accept-Encoding: gzip` レスポンスをローカル環境でも自動解凍・パース可能に。
- **isLikelyEnglish_ Override (Loader)**: 本家での関数名変更 (`isLikelyEnglish` -> `isLikelyEnglish_`) に対応。`lib/yata-loader.js` において、ローカルの緩和された判定ロジックを強制的に再注入し、システム全体の判定精度を維持。
