import yfinance as yf
import matplotlib.pyplot as plt
from PIL import Image, ImageDraw, ImageFont
import io
import os

# --- 設定 ---
# 監視する4銘柄
TICKERS = [
    {"symbol": "^N225", "name": "Nikkei 225"},
    {"symbol": "^DJI",  "name": "NY Dow"},
    {"symbol": "JPY=X", "name": "USD/JPY"},
    {"symbol": "6869.T", "name": "Sysmex"},
]

# フォントパス (英数用と日本語用)
FONT_EN_BOLD = os.path.expanduser("~/yata_fonts/RobotoMono-Bold.ttf")
# ★追加: 日本語フォント（▲▼用）
FONT_JP_BOLD = os.path.expanduser("~/yata_fonts/NotoSansCJKjp-Bold.otf")

# --- 個別のミニチャートを作る関数 ---
def create_mini_chart(ticker_symbol, width, height):
    print(f"取得中: {ticker_symbol} ...")
    stock = yf.Ticker(ticker_symbol)
    
    # "1d" で今日(または直近営業日)のデータを取得
    hist = stock.history(period="1d", interval="5m")
    
    # データがない場合(休日など)は "5d" に広げてみる救済措置
    if hist.empty:
        hist = stock.history(period="5d", interval="60m")
    
    if hist.empty:
        return None, 0, 0 # 降参

    current_price = hist['Close'].iloc[-1]
    
    # 前日終値 (点線用)
    try:
        prev_close = stock.info.get('previousClose', hist['Close'].iloc[0])
    except:
        prev_close = hist['Close'].iloc[0]

    # --- グラフ描画 ---
    # 指定されたサイズ(px)に合わせてdpi調整
    dpi = 50
    figsize_inch = (width / dpi, height / dpi)
    
    plt.figure(figsize=figsize_inch, dpi=dpi)
    
    # 点線 (基準)
    plt.axhline(y=prev_close, color='gray', linestyle='--', linewidth=2, alpha=0.6)
    # 実線 (株価)
    plt.plot(hist['Close'], color='black', linewidth=3) # 線を太く！

    # お掃除 (軸などを消す)
    plt.axis('off')
    plt.gca().spines['top'].set_visible(False)
    plt.gca().spines['right'].set_visible(False)
    plt.gca().spines['bottom'].set_visible(False)
    plt.gca().spines['left'].set_visible(False)
    plt.tight_layout(pad=0)

    # メモリ保存
    buf = io.BytesIO()
    plt.savefig(buf, format='png', transparent=True)
    plt.close()
    
    buf.seek(0)
    img = Image.open(buf)
    
    change = current_price - prev_close
    return img, current_price, change

def create_market_grid(total_width, total_height):
    grid_img = Image.new('L', (total_width, total_height), 255)
    draw = ImageDraw.Draw(grid_img)
    
    try:
        font_name = ImageFont.truetype(FONT_EN_BOLD, 18) # 銘柄名は英数フォント
        # ★変更: 価格は日本語フォントで！
        font_val  = ImageFont.truetype(FONT_JP_BOLD, 14)
    except:
        font_name = ImageFont.load_default()
        font_val  = ImageFont.load_default()

    cell_w = total_width // 2
    cell_h = total_height // 2
    
    for i, item in enumerate(TICKERS):
        row = i // 2
        col = i % 2
        x_base = col * cell_w
        y_base = row * cell_h
        
        draw.rectangle((x_base, y_base, x_base + cell_w, y_base + cell_h), outline=0, width=2)
        
        chart_h = int(cell_h * 0.6)
        chart_img, price, change = create_mini_chart(item["symbol"], cell_w, chart_h)
        
        if chart_img:
            chart_img = chart_img.resize((cell_w, chart_h), Image.Resampling.LANCZOS)
            grid_img.paste(chart_img, (x_base, y_base + cell_h - chart_h), chart_img)
            
            # 銘柄名 (英数フォント)
            draw.text((x_base + 10, y_base + 5), item["name"], font=font_name, fill=0)
            
            # 価格と変化率 (日本語フォント)
            sign = "▲" if change > 0 else "▼"
            val_str = f"{sign} {price:,.0f}" # 記号を前につけたほうが見やすいかも
            if item["symbol"] == "JPY=X":
                val_str = f"{sign} {price:.2f}"
                
            draw.text((x_base + 10, y_base + 30), val_str, font=font_val, fill=0)

    return grid_img

# --- 実行 ---
cockpit_image = create_market_grid(320, 240)
cockpit_image.save("market_grid_preview.png")
print("market_grid_preview.png を保存しました！")