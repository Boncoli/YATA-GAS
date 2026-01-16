import os
import io
import sqlite3
import pandas as pd
import shutil
from datetime import datetime, timedelta
from PIL import Image, ImageDraw, ImageFont
import matplotlib.pyplot as plt
import yfinance as yf

# ==========================================
#  YATA DASHBOARD - 天気アイコンこだわり版
# ==========================================

# --- 基本設定 ---
WIDTH, HEIGHT = 800, 480
FONT_DIR = os.path.expanduser("~/yata-local/dashboard")
if not os.path.exists(FONT_DIR): FONT_DIR = os.path.expanduser("~/yata_fonts")

DB_PATH_SHM = "/dev/shm/yata.db"
DB_PATH_DISK = os.path.expanduser("~/yata-local/yata.db")
DB_PATH = DB_PATH_SHM if os.path.exists(DB_PATH_SHM) else DB_PATH_DISK

# --- フォント設定 ---
FONT_JP_BOLD = os.path.join(FONT_DIR, "IBMPlexSansJP-Bold.ttf")
FONT_EN_BOLD = os.path.join(FONT_DIR, "RobotoMono-Bold.ttf")
FONT_WEATHER = os.path.join(FONT_DIR, "WeatherIcons.ttf")

# --- 株価ティッカー設定 ---
TICKERS = [
    {"symbol": "^N225", "name": "Nikkei 225", "fmt": "{:,.0f}"},
    {"symbol": "^DJI",  "name": "NY Dow",     "fmt": "{:,.0f}"},
    {"symbol": "JPY=X", "name": "USD/JPY",    "fmt": "{:.2f}"},
    {"symbol": "6869.T", "name": "Sysmex",    "fmt": "{:,.0f}"},
]

# --- 天気アイコンマッピング (詳細版) ---
# 左側がAPIの description (小文字), 右側がアイコンコード
# --- 天気アイコンマッピング (日本語対応版) ---
# 左側がAPIの description (小文字/日本語), 右側がアイコンコード
# --- 天気アイコンマッピング (日本語DB対応・完全版) ---
WEATHER_ICONS = {
    # === 基本 (英語などの保険) ===
    "Sunny": "\uf00d", "Clear": "\uf00d",
    "Cloudy": "\uf013", "Clouds": "\uf013",
    "Rain": "\uf019", "Drizzle": "\uf019",
    "Snow": "\uf01b", "Thunder": "\uf01e",
    "Thunderstorm": "\uf01e", "Fog": "\uf014",
    "Mist": "\uf014", "Haze": "\uf014",

    # === 詳細 (日本語DBの実績データに基づく) ===
    # 晴れ・曇り系
    "晴天": "\uf00d",         # Clear
    "快晴": "\uf00d",
    "薄い雲": "\uf002",       # few clouds (実績あり: 晴れ間)
    "千切れ雲": "\uf002",     # scattered clouds
    "雲": "\uf013",           # clouds (実績あり)
    "雲り": "\uf013",         # broken clouds
    "曇り": "\uf013",
    "曇りがち": "\uf013",     # broken clouds (実績あり)
    "厚い雲": "\uf013",       # overcast clouds (実績あり: どんより)

    # 雨系
    "小雨": "\uf01c",         # light rain (実績あり: 🌂)
    "適度な雨": "\uf019",     # moderate rain (実績あり: ☔)
    "雨": "\uf019",
    "強い雨": "\uf018",       # heavy intensity rain (🌧)
    "激しい雨": "\uf018",     # very heavy rain
    "豪雨": "\uf01e",         # extreme rain (⛈)
    "にわか雨": "\uf01a",     # shower rain (🚿)
    "弱いにわか雨": "\uf01a", # light intensity shower rain (★新規追加)
    "霧雨": "\uf019",         # drizzle

    # 雪・その他
    "小雪": "\uf01b",         # light snow (❄)
    "雪": "\uf01b",
    "大雪": "\uf064",         # heavy snow (☃)
    "みぞれ": "\uf0b5",       # sleet (🌨)
    "雷雨": "\uf01e",         # thunderstorm (⚡)
    "霧": "\uf014",           # mist/fog (🌫)
    "靄": "\uf014",           # haze
}
DEFAULT_WEATHER_ICON = "\uf07b" 
JP_WEEKDAYS = ["月", "火", "水", "木", "金", "土", "日"]

# --- ヘルパー関数 ---

def get_font(font_type, size):
    try:
        if font_type == "weather": return ImageFont.truetype(FONT_WEATHER, size)
        path = FONT_JP_BOLD if font_type == "jp" else FONT_EN_BOLD
        return ImageFont.truetype(path, size)
    except: return ImageFont.load_default()

def get_db_connection():
    return sqlite3.connect(DB_PATH)

def get_weather_icon(main, description):
    """詳細(description)があれば優先、なければMainを使う"""
    desc_key = description.lower() if description else ""
    return WEATHER_ICONS.get(desc_key, WEATHER_ICONS.get(main, WEATHER_ICONS.get(main.capitalize(), DEFAULT_WEATHER_ICON)))

def draw_card(draw, x, y, w, h, title, label_font):
    draw.rectangle((x, y, x + w, y + h), outline=0, width=2)
    draw.rectangle((x, y, x + w, y + 26), fill=0)
    draw.text((x + 10, y + 2), title, font=label_font, fill=255)
    return y + 32, y + h - 5

def draw_text_wrapped(draw, text, font, x, y, max_w, line_spacing=4, max_lines=None):
    if not text: return y
    lines = []
    current_line = ""
    for char in text:
        if char == '\n': lines.append(current_line); current_line = ""; continue
        test_line = current_line + char
        if draw.textlength(test_line, font=font) <= max_w: current_line = test_line
        else: lines.append(current_line); current_line = char
    if current_line: lines.append(current_line)
    if max_lines and len(lines) > max_lines:
        lines = lines[:max_lines]
        if lines: lines[-1] = lines[-1][:-1] + "..."
    for line in lines:
        draw.text((x, y), line, font=font, fill=0)
        y += font.size + line_spacing
    return y

def get_system_stats():
    stats = {'cpu_temp': "--", 'load': "--", 'mem': "--", 'disk': "--"}
    try:
        with open('/sys/class/thermal/thermal_zone0/temp', 'r') as f:
            stats['cpu_temp'] = f"{int(f.read()) / 1000.0:.1f}°C"
    except: pass
    try: stats['load'] = f"{os.getloadavg()[0]:.2f}"
    except: pass
    try:
        mem_total = 0; mem_avail = 0
        with open('/proc/meminfo', 'r') as f:
            for line in f:
                if 'MemTotal:' in line: mem_total = int(line.split()[1]) // 1024
                if 'MemAvailable:' in line: mem_avail = int(line.split()[1]) // 1024
        if mem_total > 0: stats['mem'] = f"{int(((mem_total-mem_avail)/mem_total)*100)}% ({ (mem_total-mem_avail)/1024:.1f}G)"
    except: pass
    try:
        total, used, _ = shutil.disk_usage("/")
        stats['disk'] = f"{int((used/total)*100)}% ({used//(2**30)}G)"
    except: pass
    return stats

def get_db_stats():
    stats = {"total": "--", "new": "--", "size": "--"}
    try:
        if os.path.exists(DB_PATH):
            stats["size"] = f"{os.path.getsize(DB_PATH) / (1024*1024):.1f} MB"
            conn = get_db_connection(); cur = conn.cursor()
            cur.execute("SELECT count(*) FROM collect"); stats["total"] = f"{cur.fetchone()[0]:,}"
            threshold = (datetime.now() - timedelta(hours=24)).strftime("%Y-%m-%d %H:%M:%S")
            cur.execute("SELECT count(*) FROM collect WHERE date >= ?", (threshold,)); stats["new"] = f"{cur.fetchone()[0]}"
            conn.close()
    except: pass
    return stats

# --- メイン画面生成 ---

def create_dashboard():
    img = Image.new('L', (WIDTH, HEIGHT), 255)
    draw = ImageDraw.Draw(img)
    conn = get_db_connection()
    now = datetime.now()
    
    # 1. データ取得
    try:
        cur = conn.cursor()
        cur.execute("SELECT main_weather, description, temp, pressure, humidity, alert_events FROM weather_log ORDER BY datetime DESC LIMIT 1")
        weather_row = cur.fetchone()
        
        cur.execute("SELECT temp_max, temp_min FROM weather_forecast WHERE date = ?", (now.strftime("%Y/%m/%d"),))
        today_forecast = cur.fetchone()
        
        # descriptionカラムがあるか確認して分岐
        try:
            cur.execute("SELECT date, weather_main, description, temp_max, temp_min FROM weather_forecast WHERE date > ? ORDER BY date ASC LIMIT 4", (now.strftime("%Y/%m/%d"),))
            forecast_rows = cur.fetchall()
            forecast_has_desc = True
        except:
            cur.execute("SELECT date, weather_main, temp_max, temp_min FROM weather_forecast WHERE date > ? ORDER BY date ASC LIMIT 4", (now.strftime("%Y/%m/%d"),))
            forecast_rows = cur.fetchall()
            forecast_has_desc = False
        
        cur.execute("SELECT living_temp, living_humi FROM remo_log ORDER BY datetime DESC LIMIT 1")
        remo_row = cur.fetchone()
        cur.execute("SELECT summary, source FROM (SELECT summary, source, date FROM collect WHERE summary IS NOT NULL ORDER BY date DESC LIMIT 20) ORDER BY RANDOM() LIMIT 3")
        news_rows = cur.fetchall()
        cur.execute("SELECT rank1, rank2, rank3, rank4, rank5 FROM trend_log ORDER BY date DESC LIMIT 1")
        trend_row = cur.fetchone()
    except Exception as e: print(f"DB Fetch Error: {e}")
    finally: conn.close()

    # 2. ヘッダー
    draw.rectangle((0, 0, WIDTH, 100), fill=0)
    draw.rectangle((25, 10, 105, 90), outline=255, width=2)
    draw.text((25 + (10 if now.day >= 10 else 25), 7), str(now.day), font=get_font("en", 50), fill=255)
    draw.text((55, 61), JP_WEEKDAYS[now.weekday()], font=get_font("jp", 20), fill=255) 
    draw.text((125, -3), now.strftime("%H:%M"), font=get_font("en", 80), fill=255)

    # 3. 天気エリア (詳細ロジック対応)
    # -----------------------------------------------------------------
    # ▼▼▼ 天気エリアの位置設定 ▼▼▼
    weather_base_x = 368  # ➡ 全体の左右位置

    if weather_row:
        icon_shift = 3 # ➡ 今日のアイコンだけ右にズラす量
        
        # 今日の天気 (descriptionがあれば詳細アイコン)
        current_icon = get_weather_icon(weather_row[0], weather_row[1])
        draw.text((weather_base_x + icon_shift, 2), current_icon, font=get_font("weather", 60), fill=255)

        # 今日の気温
        if today_forecast:
            t_max = f"{today_forecast[0]:.0f}" if today_forecast[0] is not None else "-"
            t_min = f"{today_forecast[1]:.0f}" if today_forecast[1] is not None else "-"
            draw.text((weather_base_x + 17, 79), f"{t_max}/{t_min}", font=get_font("en", 16), fill=255)

        # 週間予報グリッド
        grid_start_x = weather_base_x + 80
        
        # ▼▼▼ 週間予報の間隔設定 ▼▼▼
        grid_w = 63       # ➡ 横の間隔 (広げると右へ伸びる)
        grid_h = 40       # ⬇ 縦の間隔 (広げると下へ伸びる)
        grid_base_y = 18  # ⬇ 全体の開始高さ (増やすと下がる)

        for i, row in enumerate(forecast_rows[:4]):
            x_off, y_off = grid_start_x + (i%2)*grid_w, grid_base_y + (i//2)*grid_h
            
            # 詳細アイコン対応
            if forecast_has_desc:
                f_icon = get_weather_icon(row[1], row[2])
                max_t = f"{row[3]:.0f}" if row[3] is not None else "-"
                min_t = f"{row[4]:.0f}" if row[4] is not None else "-"
            else:
                f_icon = get_weather_icon(row[1], "")
                max_t = f"{row[2]:.0f}" if row[2] is not None else "-"
                min_t = f"{row[3]:.0f}" if row[3] is not None else "-"

            draw.text((x_off, y_off), f_icon, font=get_font("weather", 20), fill=255)
            
            # ▼▼▼ 内部パーツの微調整 ▼▼▼
            wd_x, wd_y = 26, -2     # 曜日の位置 (右へ, 上下へ)
            temp_x, temp_y = 26, 13 # 気温の位置 (右へ, 上下へ)

            dt_f = datetime.strptime(row[0], "%Y/%m/%d")
            draw.text((x_off + wd_x, y_off + wd_y), JP_WEEKDAYS[dt_f.weekday()], font=get_font("jp", 11), fill=255)
            draw.text((x_off + temp_x, y_off + temp_y), f"{max_t}/{min_t}", font=get_font("en", 11), fill=255)

    # 4. 注意報
    warning_x = 570
    alert_text = weather_row[5] if weather_row and weather_row[5] else ""
    alerts = [a.strip() for a in alert_text.split(',') if a.strip()] if alert_text else []
    if alerts:
        draw.rectangle((warning_x, 15, warning_x + 100, 85), outline=255, width=2)
        for i, alert in enumerate(alerts[:3]):
            draw.text((warning_x + 8, 20 + (i*15)), alert[:6], font=get_font("jp", 12), fill=255)
        if len(alerts) > 3:
            draw.text((warning_x + 8, 65), f"..他{len(alerts)-3}", font=get_font("jp", 11), fill=255)

    # 5. 環境データ (室温・湿度)
    # -----------------------------------------------------------------
    # ▼▼▼ 右上の室温エリア設定 ▼▼▼
    env_x, env_y = 680, 10  # 位置 (X, Y)
    val_x_offset, val_y_offset = 33, -2 # 数値のズレ (横, 縦)
    
    env_lbl_font, env_val_font = get_font("jp", 14), get_font("en", 16)
    c_tmp = f"{remo_row[0]:.1f}" if remo_row else "--"
    c_hum = f"{remo_row[1]:.1f}" if remo_row else "--"
    o_tmp = f"{weather_row[2]:.1f}" if weather_row and weather_row[2] else "--"
    pres = f"{weather_row[3]:.0f}" if weather_row and weather_row[3] else "--"

    draw.text((env_x, env_y),    "室温", font=env_lbl_font, fill=255)
    draw.text((env_x + val_x_offset, env_y + val_y_offset), f"{c_tmp}°C", font=env_val_font, fill=255)
    draw.text((env_x, env_y+20), "湿度", font=env_lbl_font, fill=255)
    draw.text((env_x + val_x_offset, env_y+20 + val_y_offset), f"{c_hum}%", font=env_val_font, fill=255)
    draw.text((env_x, env_y+40), "外気", font=env_lbl_font, fill=255)
    draw.text((env_x + val_x_offset, env_y+40 + val_y_offset), f"{o_tmp}°C", font=env_val_font, fill=255)
    draw.text((env_x, env_y+60), "気圧", font=env_lbl_font, fill=255)
    draw.text((env_x + val_x_offset, env_y+60 + val_y_offset), f"{pres} hPa", font=env_val_font, fill=255)

    # 6. カードレイアウト (SYSTEM, MARKET, NEWS, TREND)
    # -----------------------------------------------------------------
    label_font = get_font("jp", 16)# ← これは枠の「見出し」のサイズ
    stat_font = get_font("en", 14)# ← 中身の数値（CPUなど）のサイズ
    jp_font = get_font("jp", 14)# ← ニュース本文のサイズ

    # ▼▼▼ 全体のレイアウト設定 ▼▼▼
    card_start_y = 105  # ⬇ カード開始位置 (ヘッダーの下)
    v_gap = 5           # ↕ 上下の隙間

    # === 左カラム (System & Market) ===
    card_x = 10         # ➡ 左端の位置
    card_w = 305        # ⇔ 幅
    
    card_h = 140        # Systemカードの高さ
    
    # Marketカードの位置計算
    stock_y = card_start_y + card_h + v_gap
    stock_h = 219       # Marketカードの高さ

    # === 右カラム (News & Trend) ===
    news_x = 320        # ➡ 右カラムの開始位置
    news_w = 470        # ⇔ 幅
    
    news_h = 280        # Newsカードの高さ
    
    # Trendカードの位置計算
    trend_y = card_start_y + news_h + v_gap
    trend_h = 79        # Trendカードの高さ

    # ----------------------------------------
    # 描画実行
    
    # 1. System
    current_y, card_bottom = draw_card(draw, card_x, card_start_y, card_w, card_h, "SYSTEM & DATABASE", label_font)
    sys = get_system_stats()
    draw.text((card_x + 10, current_y), f"CPU: {sys['cpu_temp']}  Load: {sys['load']}", font=stat_font, fill=0)
    draw.text((card_x + 10, current_y + 20), f"Mem: {sys['mem']}  Disk: {sys['disk']}", font=stat_font, fill=0)
    draw.line((card_x + 10, current_y + 45, card_x + card_w - 10, current_y + 45), fill=0, width=1)
    db = get_db_stats()
    draw.text((card_x + 10, current_y + 55), f"Total: {db['total']}", font=stat_font, fill=0)
    draw.text((card_x + 160, current_y + 55), f"New: +{db['new']}", font=stat_font, fill=0)
    draw.text((card_x + 10, current_y + 75), f"DB Size: {db['size']}", font=stat_font, fill=0)

    # 2. Market
    # stock_h - 30 だったのを、 -35 や -40 に変えると、下に隙間ができます。
    draw_card(draw, card_x, stock_y, card_w, stock_h, "MARKET WATCH", label_font)
    img.paste(create_stock_grid(card_w - 10, stock_h - 34), (card_x + 5, stock_y + 30))

    # 3. News
    current_y, news_limit_y = draw_card(draw, news_x, card_start_y, news_w, news_h, "TOP NEWS SUMMARY", label_font)
    if news_rows:
        for summary, source in news_rows:
            if current_y + 25 > news_limit_y: break 
            draw.text((news_x + 10, current_y), f"[{source}]", font=get_font("jp", 12), fill=0)
            current_y += 18
            rem_h = news_limit_y - current_y
            line_lim = max(1, rem_h // (jp_font.size + 4))
            current_y = draw_text_wrapped(draw, summary, jp_font, news_x + 10, current_y, news_w - 20, max_lines=min(4, int(line_lim)))
            current_y += 10

    # 4. Trend
    current_y, trend_limit_y = draw_card(draw, news_x, trend_y, news_w, trend_h, "TRENDING NOW", label_font)
    if trend_row:
        keywords = [k for k in trend_row if k]
        draw_text_wrapped(draw, "  ".join([f"#{k}" for k in keywords]), jp_font, news_x + 10, current_y, news_w - 20, max_lines=2)

    draw.rectangle((0, 0, WIDTH-1, HEIGHT-1), outline=0, width=4)
    return img

def create_stock_grid(w, h):
    grid_img = Image.new('L', (w, h), 255)
    draw = ImageDraw.Draw(grid_img)
    cell_w, cell_h = w // 2, h // 2
    for i, item in enumerate(TICKERS):
        r, c = i // 2, i % 2
        x, y = c * cell_w, r * cell_h
        draw.rectangle((x, y, x+cell_w, y+cell_h), outline=0, width=1)
        try:
            stock = yf.Ticker(item["symbol"])
            hist = stock.history(period="1d", interval="5m")
            if hist.empty: hist = stock.history(period="5d", interval="60m")
            if not hist.empty:
                current = hist['Close'].iloc[-1]
                prev = stock.info.get('previousClose', hist['Open'].iloc[0])
                change = current - prev
                plt.figure(figsize=(cell_w/50, (cell_h-40)/50), dpi=50)
                plt.axhline(y=prev, color='gray', linestyle='--', linewidth=2, alpha=0.6)
                plt.plot(hist['Close'].values, color='black', linewidth=2)
                plt.axis('off'); plt.tight_layout(pad=0)
                buf = io.BytesIO(); plt.savefig(buf, format='png', transparent=True); plt.close(); buf.seek(0)
                chart = Image.open(buf).resize((cell_w-10, cell_h-40), Image.Resampling.LANCZOS)
                grid_img.paste(chart, (x+5, y+35), chart)
                
                # ▼▼▼ ① 銘柄名 (Nikkei 225など) のサイズ ▼▼▼
                # 今は 14 です。小さくするなら 12 とかに変更
                draw.text((x+5, y+2), item["name"], font=get_font("en", 12), fill=0)
                sign = "▲" if change > 0 else "▼" if change < 0 else "-"

                # ▼▼▼ ② 株価 (38,000など) のサイズ ▼▼▼
                # ここも今は 14 です。
                draw.text((x+5, y+18), f"{sign}{item['fmt'].format(current)}", font=get_font("jp", 12), fill=0)
        except: pass
    return grid_img

if __name__ == "__main__":
    dashboard = create_dashboard()
    dashboard.save("/dev/shm/dashboard.png")
    print("完了！詳細天気ロジックと、全エリアのレイアウト調整マニュアルを統合しました。")