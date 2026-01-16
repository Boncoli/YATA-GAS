import os
import io
import sqlite3
import pandas as pd
import shutil
from datetime import datetime, timedelta
from PIL import Image, ImageDraw, ImageFont
import matplotlib.pyplot as plt
import yfinance as yf

# --- 設定 ---
WIDTH, HEIGHT = 800, 480
FONT_DIR = os.path.expanduser("~/yata-local/dashboard")
if not os.path.exists(FONT_DIR): FONT_DIR = os.path.expanduser("~/yata_fonts")

DB_PATH_SHM = "/dev/shm/yata.db"
DB_PATH_DISK = os.path.expanduser("~/yata-local/yata.db")
DB_PATH = DB_PATH_SHM if os.path.exists(DB_PATH_SHM) else DB_PATH_DISK

FONT_JP_BOLD = os.path.join(FONT_DIR, "NotoSansCJKjp-Bold.otf")
FONT_EN_BOLD = os.path.join(FONT_DIR, "RobotoMono-Bold.ttf")
FONT_WEATHER = os.path.join(FONT_DIR, "WeatherIcons.ttf")

TICKERS = [
    {"symbol": "^N225", "name": "Nikkei 225", "fmt": "{:,.0f}"},
    {"symbol": "^DJI",  "name": "NY Dow",     "fmt": "{:,.0f}"},
    {"symbol": "JPY=X", "name": "USD/JPY",    "fmt": "{:.2f}"},
    {"symbol": "6869.T", "name": "Sysmex",    "fmt": "{:,.0f}"},
]

WEATHER_ICONS = {
    "Sunny": "\uf00d", "Clear": "\uf00d",
    "Cloudy": "\uf013", "Clouds": "\uf013",
    "Rain": "\uf019", "Drizzle": "\uf019",
    "Snow": "\uf01b",
    "Thunder": "\uf01e", "Thunderstorm": "\uf01e",
    "Fog": "\uf014", "Mist": "\uf014", "Haze": "\uf014",
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

def draw_card(draw, x, y, w, h, title, label_font):
    """カード枠と見出しを描画"""
    draw.rectangle((x, y, x + w, y + h), outline=0, width=2)
    draw.rectangle((x, y, x + w, y + 26), fill=0)
    draw.text((x + 10, y + 2), title, font=label_font, fill=255)
    return y + 32, y + h - 5

def draw_text_wrapped(draw, text, font, x, y, max_w, line_spacing=4, max_lines=None):
    if not text: return y
    lines = []
    current_line = ""
    for char in text:
        if char == '\n':
            lines.append(current_line)
            current_line = ""
            continue
        test_line = current_line + char
        w = draw.textlength(test_line, font=font)
        if w <= max_w: current_line = test_line
        else:
            lines.append(current_line)
            current_line = char
    if current_line: lines.append(current_line)
    if max_lines and len(lines) > max_lines:
        lines = lines[:max_lines]
        if lines: lines[-1] = lines[-1][:-1] + "..."
    for line in lines:
        draw.text((x, y), line, font=font, fill=0)
        y += font.size + line_spacing
    return y

def get_system_stats():
    stats = {}
    try:
        with open('/sys/class/thermal/thermal_zone0/temp', 'r') as f:
            temp = int(f.read()) / 1000.0
            stats['cpu_temp'] = f"{temp:.1f}°C"
    except: stats['cpu_temp'] = "--"
    try: load = os.getloadavg(); stats['load'] = f"{load[0]:.2f}"
    except: stats['load'] = "--"
    try:
        mem_total = 0; mem_avail = 0
        with open('/proc/meminfo', 'r') as f:
            for line in f:
                parts = line.split()
                if parts[0] == 'MemTotal:': mem_total = int(parts[1]) // 1024
                if parts[0] == 'MemAvailable:': mem_avail = int(parts[1]) // 1024
        if mem_total > 0:
            used = mem_total - mem_avail
            stats['mem'] = f"{int((used/mem_total)*100)}% ({used/1024:.1f}G)"
        else: stats['mem'] = "--"
    except: stats['mem'] = "--"
    try:
        total, used, free = shutil.disk_usage("/")
        stats['disk'] = f"{int((used/total)*100)}% ({used//(2**30)}G)"
    except: stats['disk'] = "--"
    return stats

def get_db_stats():
    stats = {"total": "--", "new": "--", "size": "--"}
    try:
        if os.path.exists(DB_PATH):
            stats["size"] = f"{os.path.getsize(DB_PATH) / (1024*1024):.1f} MB"
            conn = get_db_connection(); cur = conn.cursor()
            cur.execute("SELECT count(*) FROM collect"); stats["total"] = f"{cur.fetchone()[0]:,}"
            cur.execute("SELECT date FROM collect WHERE date IS NOT NULL ORDER BY date DESC LIMIT 1")
            latest = cur.fetchone()
            if latest:
                fmt = "%Y-%m-%d %H:%M:%S" if "-" in latest[0] else "%Y/%m/%d %H:%M:%S"
                threshold = (datetime.now() - timedelta(hours=24)).strftime(fmt)
                cur.execute("SELECT count(*) FROM collect WHERE date >= ?", (threshold,))
                stats["new"] = f"{cur.fetchone()[0]}"
            conn.close()
    except: pass
    return stats

# --- メイン画面生成 ---

def create_dashboard():
    img = Image.new('L', (WIDTH, HEIGHT), 255)
    draw = ImageDraw.Draw(img)
    conn = get_db_connection()
    now = datetime.now()
    
    try:
        cur = conn.cursor()
        cur.execute("SELECT main_weather, temp, pressure, humidity, alert_events FROM weather_log ORDER BY datetime DESC LIMIT 1")
        weather_row = cur.fetchone()
        cur.execute("SELECT date, weather_main FROM weather_forecast WHERE date > ? ORDER BY date ASC LIMIT 4", (now.strftime("%Y/%m/%d"),))
        forecast_rows = cur.fetchall()
        cur.execute("SELECT living_temp, living_humi FROM remo_log ORDER BY datetime DESC LIMIT 1")
        remo_row = cur.fetchone()
        cur.execute("SELECT summary, source FROM (SELECT summary, source, date FROM collect WHERE summary IS NOT NULL ORDER BY date DESC LIMIT 20) ORDER BY RANDOM() LIMIT 3")
        news_rows = cur.fetchall()
        cur.execute("SELECT rank1, rank2, rank3, rank4, rank5 FROM trend_log ORDER BY date DESC LIMIT 1")
        trend_row = cur.fetchone()
    except Exception as e: print(f"DB Fetch Error: {e}")
    finally: conn.close()

    # --- ヘッダー領域 ---
    draw.rectangle((0, 0, WIDTH, 100), fill=0)
    draw.rectangle((25, 10, 105, 90), outline=255, width=2)
    draw.text((25 + (10 if now.day >= 10 else 25), 7), str(now.day), font=get_font("en", 50), fill=255)
    draw.text((55, 57), JP_WEEKDAYS[now.weekday()], font=get_font("jp", 20), fill=255)
    draw.text((125, -3), now.strftime("%H:%M"), font=get_font("en", 80), fill=255)
    
    weather_base_x = 385
    if weather_row:
        icon = WEATHER_ICONS.get(weather_row[0], WEATHER_ICONS.get(weather_row[0].capitalize(), DEFAULT_WEATHER_ICON))
        draw.text((weather_base_x, 10), icon, font=get_font("weather", 60), fill=255)
        grid_start_x = weather_base_x + 80
        for i, row in enumerate(forecast_rows[:4]):
            x_off, y_off = grid_start_x + (i%2)*47, 15 + (i//2)*38
            draw.text((x_off, y_off), WEATHER_ICONS.get(row[1], DEFAULT_WEATHER_ICON), font=get_font("weather", 22), fill=255)
            dt_f = datetime.strptime(row[0], "%Y/%m/%d")
            draw.text((x_off + 27, y_off + 8), JP_WEEKDAYS[dt_f.weekday()], font=get_font("jp", 12), fill=255)

    warning_x = 570
    alert_text = weather_row[4] if weather_row and weather_row[4] else ""
    alerts = [a.strip() for a in alert_text.split(',') if a.strip()] if alert_text else []
    if alerts:
        draw.rectangle((warning_x, 15, warning_x + 100, 85), outline=255, width=2)
        for i, alert in enumerate(alerts[:3]):
            draw.text((warning_x + 8, 20 + (i*15)), alert[:6], font=get_font("jp", 12), fill=255)
        if len(alerts) > 3:
            draw.text((warning_x + 8, 65), f"..他{len(alerts)-3}", font=get_font("jp", 11), fill=255)

    env_x, env_lbl_font, env_val_font = 685, get_font("jp", 14), get_font("en", 16)
    c_tmp = f"{remo_row[0]:.1f}" if remo_row else "--"
    c_hum = f"{remo_row[1]:.1f}" if remo_row else "--"
    o_tmp = f"{weather_row[1]:.1f}" if weather_row and weather_row[1] else "--"
    pres = f"{weather_row[2]:.0f}" if weather_row and weather_row[2] else "--"
    draw.text((env_x, 10), "室温", font=env_lbl_font, fill=255)
    draw.text((env_x+33, 11), f"{c_tmp}°C", font=env_val_font, fill=255)
    draw.text((env_x, 30), "湿度", font=env_lbl_font, fill=255)
    draw.text((env_x+33, 31), f"{c_hum}%", font=env_val_font, fill=255)
    draw.text((env_x, 50), "外気", font=env_lbl_font, fill=255)
    draw.text((env_x+33, 51), f"{o_tmp}°C", font=env_val_font, fill=255)
    draw.text((env_x, 70), "気圧", font=env_lbl_font, fill=255)
    draw.text((env_x+33, 71), f"{pres} hPa", font=env_val_font, fill=255)

    # --- メインコンテンツ領域 ---
    label_font = get_font("jp", 14)
    stat_font = get_font("en", 14)
    jp_font = get_font("jp", 14)

    # 分離レイアウト: 隙間 6px を復活
    card_start_y = 106 
    v_gap = 5 
    
    # 1. 左側：SYSTEM & DB (底辺470pxに合わせるためのサイズ計算)
    card_x, card_w, card_h = 15, 290, 140
    current_y, card_bottom = draw_card(draw, card_x, card_start_y, card_w, card_h, "SYSTEM & DATABASE", label_font)
    sys = get_system_stats()
    draw.text((card_x + 10, current_y), f"CPU: {sys['cpu_temp']}  Load: {sys['load']}", font=stat_font, fill=0)
    draw.text((card_x + 10, current_y + 20), f"Mem: {sys['mem']}  Disk: {sys['disk']}", font=stat_font, fill=0)
    draw.line((card_x + 10, current_y + 45, card_x + card_w - 10, current_y + 45), fill=0, width=1)
    db = get_db_stats()
    draw.text((card_x + 10, current_y + 55), f"Total: {db['total']}", font=stat_font, fill=0)
    draw.text((card_x + 160, current_y + 55), f"New: +{db['new']}", font=stat_font, fill=0)
    draw.text((card_x + 10, current_y + 75), f"DB Size: {db['size']}", font=stat_font, fill=0)

    # 2. 左側：MARKET WATCH (底辺470px = 106+140+5+219)
    stock_y, stock_h = card_start_y + card_h + v_gap, 219
    draw_card(draw, card_x, stock_y, card_w, stock_h, "MARKET WATCH", label_font)
    img.paste(create_stock_grid(card_w - 10, stock_h - 30), (card_x + 5, stock_y + 30))

    # 3. 右側：TOP NEWS SUMMARY (底辺470px = 106+280+5+79 から逆算)
    news_x, news_w, news_h = 320, 465, 280 
    current_y, news_limit_y = draw_card(draw, news_x, card_start_y, news_w, news_h, "TOP NEWS SUMMARY", label_font)
    if news_rows:
        for summary, source in news_rows:
            if current_y + 25 > news_limit_y: break 
            draw.text((news_x + 10, current_y), f"[{source}]", font=get_font("en", 12), fill=0)
            current_y += 18
            rem_h = news_limit_y - current_y
            line_lim = max(1, rem_h // (jp_font.size + 4))
            current_y = draw_text_wrapped(draw, summary, jp_font, news_x + 10, current_y, news_w - 20, max_lines=min(4, int(line_lim)))
            current_y += 10

    # 4. 右側：TRENDING NOW
    trend_y, trend_h = card_start_y + news_h + v_gap, 79
    current_y, trend_limit_y = draw_card(draw, news_x, trend_y, news_w, trend_h, "TRENDING NOW", label_font)
    if trend_row:
        keywords = [k for k in trend_row if k]
        draw_text_wrapped(draw, "  ".join([f"#{k}" for k in keywords]), jp_font, news_x + 10, current_y, news_w - 20, max_lines=2)

    # --- 外枠 (クッキリ見えるように 2px 内側から描画) ---
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
                draw.text((x+5, y+2), item["name"], font=get_font("en", 14), fill=0)
                sign = "▲" if change > 0 else "▼" if change < 0 else "-"
                draw.text((x+5, y+18), f"{sign}{item['fmt'].format(current)}", font=get_font("jp", 14), fill=0)
        except: pass
    return grid_img

if __name__ == "__main__":
    dashboard = create_dashboard()
    dashboard.save("/dev/shm/dashboard.png")
    print("完了！黄金比・独立カードレイアウト版を復元しました。")