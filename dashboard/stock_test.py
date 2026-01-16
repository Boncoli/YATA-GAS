import yfinance as yf
import matplotlib.pyplot as plt
from PIL import Image
import io

# --- 設定 ---
TICKER_SYMBOL = "^N225"  # 日経平均

def create_stock_chart(ticker):
    print(f"{ticker} のデータを取得中...")
    
    stock = yf.Ticker(ticker)
    
    # 1. データの取得 (5日間)
    hist = stock.history(period="1d", interval="5m")
    
    if hist.empty:
        print("データが取得できませんでした")
        return None, 0, 0

    current_price = hist['Close'].iloc[-1] # 最新価格
    
    # ★追加: 前日終値を取得する
    # (infoから取れない場合は、データの最初の価格で代用する安全策付き)
    try:
        prev_close = stock.info.get('previousClose', hist['Close'].iloc[0])
    except:
        prev_close = hist['Close'].iloc[0]

    # 2. グラフを描く
    plt.figure(figsize=(4, 2), dpi=100)
    
    # --- ★ここが追加ポイント: 前日終値の点線 ---
    # y=高さ, color=グレー, linestyle=点線, linewidth=細め, alpha=透明度
    plt.axhline(y=prev_close, color='gray', linestyle='--', linewidth=1, alpha=0.8)

    # メインの株価線 (黒の実線)
    plt.plot(hist['Close'], color='black', linewidth=2)
    
    # 軸を消す（スパークライン化）
    plt.axis('off')
    plt.gca().spines['top'].set_visible(False)
    plt.gca().spines['right'].set_visible(False)
    plt.gca().spines['bottom'].set_visible(False)
    plt.gca().spines['left'].set_visible(False)
    
    plt.tight_layout(pad=0)

    # 3. 画像保存
    buf = io.BytesIO()
    plt.savefig(buf, format='png', transparent=True)
    plt.close()
    
    buf.seek(0)
    img = Image.open(buf)
    
    # 前日比も計算して返す
    change = current_price - prev_close
    
    return img, current_price, change

# --- 実行テスト ---
chart_image, price, change = create_stock_chart(TICKER_SYMBOL)

if chart_image:
    # プレビュー作成
    canvas = Image.new('L', (400, 200), 255)
    canvas.paste(chart_image, (0, 0))
    
    # ログ表示
    sign = "+" if change > 0 else ""
    print(f"現在値: {price:.2f}")
    print(f"前日比: {sign}{change:.2f}")
    
    canvas.save("stock_preview.png")
    print("stock_preview.png を保存しました（点線入り）")