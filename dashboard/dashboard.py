import os
import io
import sqlite3
import pandas as pd
import shutil
import sys
import json
import urllib.request
import time
import traceback
from datetime import datetime, timedelta
from PIL import Image, ImageDraw, ImageFont, ImageOps
import matplotlib.pyplot as plt
import pandas_datareader.data as web
import numpy as np
from scipy.interpolate import make_interp_spline
import requests
import holidays
import argparse
import matplotlib.dates as mdates

# ==========================================
#  YATA DASHBOARD - Master Config Edition
# ==========================================

# --- 動作設定 ---
DRAW_TO_EPD = True  # True: 電子ペーパーに描画 / False: /dev/shm/dashboard.png 保存のみ

# --- .env 読み込み ---
ENV_PATH = os.path.expanduser("~/yata-local/.env")
if os.path.exists(ENV_PATH):
    try:
        with open(ENV_PATH, "r") as f:
            for line in f:
                if line.strip() and not line.startswith("#") and "=" in line:
                    key, val = line.strip().split("=", 1)
                    if key not in os.environ:
                        os.environ[key] = val.strip().strip('"').strip("'")
    except Exception: pass

DISCORD_WEBHOOK_URL = os.environ.get("DISCORD_WEBHOOK_URL")

# --- 基本設定 ---
WIDTH, HEIGHT = 800, 480
FONT_DIR = os.path.expanduser("~/yata-local/dashboard/fonts")
if not os.path.exists(FONT_DIR): FONT_DIR = os.path.expanduser("~/yata_fonts")

DB_PATH_SHM = "/dev/shm/yata.db"
DB_PATH_DISK = os.path.expanduser("~/yata-local/yata.db")
DB_PATH = DB_PATH_SHM if os.path.exists(DB_PATH_SHM) else DB_PATH_DISK

# =========================================================
# ⚙️ 1. フォント設定 (M+ 1mn / M+ 1 Code 用)
# =========================================================

FONT_BASE = os.path.expanduser("~/yata-local/dashboard/fonts")

# 実在するファイル名に合わせて修正 (Mplus1Code をメインに使用)
FONT_MPLUS_REG = os.path.join(FONT_BASE, "Mplus1Code-Medium.ttf")
FONT_MPLUS_BOLD = os.path.join(FONT_BASE, "Mplus1-Bold.ttf") # 見出し用(プロポーショナル)
FONT_MPLUS_CODE_BOLD = os.path.join(FONT_BASE, "Mplus1Code-Bold.ttf") # 等幅太字が必要な場合用
FONT_MPLUS_BLACK = os.path.join(FONT_BASE, "Mplus1-Black.ttf") # 時計・日付用(極太プロポーショナル)

FONT_MPLUS_CODE = os.path.join(FONT_BASE, "Mplus1Code-Medium.ttf")

# 天気アイコン用フォント
FONT_WEATHER = os.path.join(FONT_BASE, "WeatherIcons.ttf")

FS = {
    "clock": 74, "date_num": 50, "date_day": 16,
    "icon_lg": 54, "icon_md": 22, "icon_sm": 16,
    "temp_md": 14, "weather_txt": 12, "card_title": 16,
    "sys_text": 14, "stock_name": 14, "stock_val": 14,
    "news_src": 12, "news_body": 14, "trend_text": 14,
}

# =========================================================
# 📐 2. レイアウト座標 & 余白設定 (LO)
# =========================================================
LO = {
    "header_h": 100,      # ヘッダーエリア(日付・時計・天気)の高さ
    "pad": 10,           # 全般的な余白
    "date_box": {"x": 10, "y": 10, "w": 80, "h": 80}, # 左上日付ボックスの配置
    "clock_x": 105,      # 時計のX座標
    "panel": {"x": 345, "y": 5, "w": 450, "h": 90},  # 右上天気・環境パネルの配置
    "panel_div1": 225,   # 天気パネル内: 第1区切り線 (パネル左端からの相対X)
    "panel_div2": 333,   # 天気パネル内: 第2区切り線 (パネル左端からの相対X)
    "cards_y": 105,      # 下段カードエリアの開始Y座標
    "gap": 5,            # カード同士の隙間
    "card_title_y_offset": 1, # カードタイトルのY座標オフセット (黒帯内での位置)
    
    # --- 左カラム (市場・システム情報) ---
    "col1_x": 10, "col1_w": 305,        # 左カラムのX座標と幅
    "h_sys": 140, "h_market": 219,     # システム情報/市場情報のカード高さ
    
    # --- 右カラム (ニュース・トレンド) ---
    "col2_x": 320, "col2_w": 470,       # 右カラムのX座標と幅
    "h_news": 280, "h_trend": 79,       # ニュース/トレンドのカード高さ
    
    # --- Detail Layouts ---
    "header": {
        # 日付 (数字) の位置 (date_boxの左上からの相対座標)
        "date_num_x": 0,  
        "date_num_y": -8,
        
        # 曜日 の位置 (Y座標のみ、Xはセンタリング自動計算)
        "day_y": 55,
        
        # 時計 の位置 (絶対座標)
        "clock_x": 105,
        "clock_y": -8,
        
        "hol_bg_y1": 75,     # 祝日名背景の開始Y
        "hol_bg_y2": 95,     # 祝日名背景の終了Y
        "hol_txt_y": 74,     # 祝日名テキストのY座標
        "clock_hol_y": -20   # 祝日時の時計のY座標 (祝日名と重ならないよう更に上へ)
    },
    "weather": {
        # メイン天気 (左上)
        "main_icon": {"x": 2, "y": 2}, 
        "main_temp": {"x": 55, "y": 65},
        
        # 3時間毎予報 (中央〜右)
        "hourly": {
            "start_x": 90, "step": 42,           # 開始X位置, 1つごとの横幅
            "time_x": 7, "icon_x": 8, "temp_x": 18,  # 各要素の内部Xオフセット
            "time_y": 3, "icon_y": 12, "temp_y": 40  # 各要素の内部Yオフセット
        },
        
        # 週間予報 (下段)
        "daily":  {
            "box_x": 90, "box_w": 125, "box_y": 54, "box_h": 35, # 枠線の矩形
            "start_x": 90, "step": 62,           # 開始X位置, 1つごとの横幅
            "day_x": 8, "icon_x": 30, "temp_x": 33,  # 各要素の内部Xオフセット
            "day_y": 62, "icon_y": 55, "temp_y": 77  # 各要素の内部Yオフセット
        },
        
        # 警報・注意報リスト
        "warn":   {
            "x_off": 10, "pitch": 17, # 開始Xオフセット, 行送り(高さ)
            "col_w": 54,              # 2列表示時の列幅
            "bar_w": 4, "bar_m": 2,   # 警報時の左側の赤帯の太さとマージン
            "other_x": 52             # 「..他」の表示位置
        }
    },
    "env": {
        "lbl_x": 4, "val_x": 35,      # ラベル("室温"等)と数値のXオフセット
        "room_y": 4, "humi_y": 23,    # 室温・湿度のY座標
        "mid_line": 45,               # 中央の区切り線Y座標
        "out_y": 49, "pres_y": 67     # 外気・気圧のY座標
    },
    "sys": {
        "pad_x": 10, 
        "row1": 0, "row2": 20,       # 1行目(CPU), 2行目(Mem) Y座標
        "line": 45,                   # 区切り線Y座標
        "row3": 55, "row4": 75        # 3行目(DB Total), 4行目(DB Size) Y座標
    },
    "market_pos": {
        "txt_x": 5, "name_y": 0, "val_y": 16, # テキストX, 銘柄名Y, 数値Y
        "chart_y": 35, "chart_w_adj": -10, "chart_h_adj": -40 # チャート開始Y, 幅/高の補正値
    },
}

COLOR_BLACK, COLOR_RED = 0, 1
TICKERS = [
    {"symbol": "^N225", "name": "Nikkei 225", "fmt": "{:,.0f}"},
    {"symbol": "^DJI",  "name": "NY Dow",     "fmt": "{:,.0f}"},
    {"symbol": "JPY=X", "name": "USD/JPY",    "fmt": "{:.2f}"},
    {"symbol": "6869.T", "name": "Sysmex",    "fmt": "{:,.0f}"},
]

# (WEATHER_ICONS 等の定義)
WEATHER_ICONS = {
    "Sunny": "\uf00d", "Clear": "\uf00d", "Cloudy": "\uf013", "Clouds": "\uf013",
    "Partly Cloudy": "\uf002", "Rain": "\uf019", "Showers": "\uf01a", "Drizzle": "\uf01c",
    "Snow": "\uf01b", "Thunder": "\uf01e", "Thunderstorm": "\uf01e", "Fog": "\uf014",
    "Mist": "\uf014", "Haze": "\uf0b6", "Dust": "\uf063", "Wind": "\uf050",
    "晴天": "\uf00d", "快晴": "\uf00d", "薄い雲": "\uf002", "千切れ雲": "\uf002",
    "雲": "\uf013", "雲り": "\uf013", "曇り": "\uf013", "曇りがち": "\uf002", "厚い雲": "\uf013",
    "小雨": "\uf01c", "適度な雨": "\uf019", "雨": "\uf019", "強い雨": "\uf019", "激しい雨": "\uf018",
    "豪雨": "\uf01e", "にわか雨": "\uf01a", "霧雨": "\uf017",
    "小雪": "\uf01b", "雪": "\uf01b", "大雪": "\uf064", "みぞれ": "\uf0b5",
    "雷雨": "\uf01e", "霧": "\uf014", "靄": "\uf0b6",
}
NIGHT_ICON_MAP = {
    "\uf00d": "\uf02e", "\uf002": "\uf081", "\uf013": "\uf086", "\uf01c": "\uf029",
    "\uf019": "\uf028", "\uf018": "\uf028", "\uf01a": "\uf029", "\uf017": "\uf026",
    "\uf01b": "\uf02a", "\uf064": "\uf02a", "\uf0b5": "\uf02a", "\uf01e": "\uf02d",
    "\uf014": "\uf04a",
}
DEFAULT_WEATHER_ICON = "\uf07b"
JP_WEEKDAYS = ["月", "火", "水", "木", "金", "土", "日"]

# --- ヘルパー関数群 ---
def send_discord(message):
    if not DISCORD_WEBHOOK_URL: return
    try:
        data = json.dumps({"content": message}).encode("utf-8")
        req = urllib.request.Request(DISCORD_WEBHOOK_URL, data=data, 
                                     headers={"Content-Type": "application/json", "User-Agent": "Python/3.9"})
        # タイムアウトを設定して無限待機を防止 (デフォルト10秒)
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        print(f"Discord Send Error: {e}")

def get_font(weight, size):
    """
    weight:
    "black"  : 極太 (時計・日付) -> Mplus1-Black
    "bold"   : 太字 (見出し・曜日) -> Mplus1Code-Bold
    "medium" : 通常 (本文・数値) -> Mplus1Code-Medium
    "weather": 天気アイコン
    """
    try:
        if weight == "weather":
            return ImageFont.truetype(FONT_WEATHER, size)

        if weight == "black":
            return ImageFont.truetype(FONT_MPLUS_BLACK, size)

        if weight == "bold":
            return ImageFont.truetype(FONT_MPLUS_BOLD, size)

        # "medium", "regular", "code", or fallback
        return ImageFont.truetype(FONT_MPLUS_REG, size)

    except Exception as e:
        return ImageFont.load_default()

def is_night_mode(sunrise_str=None, sunset_str=None, check_time=None):
    now = check_time if check_time else datetime.now()
    if sunrise_str and sunset_str:
        try:
            s_h, s_m = map(int, sunrise_str.split(':'))
            e_h, e_m = map(int, sunset_str.split(':'))
            dt_sunrise = now.replace(hour=s_h, minute=s_m)
            dt_sunset = now.replace(hour=e_h, minute=e_m)
            return (now < dt_sunrise or now >= dt_sunset)
        except: pass
    return (now.hour < 6 or now.hour >= 18)

def get_weather_icon(main, description, sunrise=None, sunset=None, check_time=None):
    desc_key = description if description else ""
    icon = WEATHER_ICONS.get(desc_key, WEATHER_ICONS.get(main, DEFAULT_WEATHER_ICON))
    if is_night_mode(sunrise, sunset, check_time):
        return NIGHT_ICON_MAP.get(icon, icon)
    return icon

def draw_weather_icon_smart(draw_b, draw_r, xy, icon_char, font, is_highlight=False):
    x, y = xy
    if is_highlight:
        # 1px Outline (8 directions)
        offsets = [(-1, -1), (0, -1), (1, -1),
                   (-1,  0),          (1,  0),
                   (-1,  1), (0,  1), (1,  1)]
        for dx, dy in offsets:
            draw_b.text((x + dx, y + dy), icon_char, font=font, fill=1)
        # Body (Red with white mask)
        draw_b.text((x, y), icon_char, font=font, fill=1)
        draw_r.text((x, y), icon_char, font=font, fill=0)
    else:
        # Standard (Black/White)
        draw_b.text((x, y), icon_char, font=font, fill=1)

def draw_smart_text(draw_b, draw_r, xy, text, font, color_type=COLOR_BLACK):
    target = draw_r if color_type == COLOR_RED else draw_b
    target.text(xy, text, font=font, fill=0)

def draw_text_wrapped_smart(draw_b, draw_r, text, font, x, y, max_w, max_lines=None, color_type=COLOR_BLACK, max_y=None):
    if not text: return y
    lines, current_line = [], ""
    for char in text:
        if char == '\n': lines.append(current_line); current_line = ""; continue
        test_line = current_line + char
        if draw_b.textlength(test_line, font=font) <= max_w: current_line = test_line
        else: lines.append(current_line); current_line = char
    if current_line: lines.append(current_line)
    
    if max_lines and len(lines) > max_lines:
        lines = lines[:max_lines]; lines[-1] = lines[-1][:-1] + "..."
    
    for line in lines:
        if max_y and (y + font.size > max_y):
            break
        draw_smart_text(draw_b, draw_r, (x, y), line, font, color_type)
        y += font.size + 4 
    return y

def draw_card_smart(draw_b, draw_r, x, y, w, h, title, label_font):
    draw_b.rectangle((x, y, x + w, y + h), outline=0, width=2)
    draw_b.rectangle((x, y, x + w, y + 26), fill=0)
    draw_b.text((x + LO['pad'], y + LO['card_title_y_offset']), title, font=label_font, fill=1) 
    return y + 30, y + h - 2

def get_system_stats():
    stats = {'cpu_temp': "--", 'load': "--", 'mem': "--", 'disk': "--"}
    try:
        with open('/sys/class/thermal/thermal_zone0/temp', 'r') as f:
            stats['cpu_temp'] = f"{int(f.read()) / 1000.0:.1f}°C"
        stats['load'] = f"{os.getloadavg()[0]:.2f}"
        mem_total, mem_avail = 0, 0
        with open('/proc/meminfo', 'r') as f:
            for line in f:
                if 'MemTotal:' in line: mem_total = int(line.split()[1]) // 1024
                if 'MemAvailable:' in line: mem_avail = int(line.split()[1]) // 1024
        if mem_total > 0: stats['mem'] = f"{int(((mem_total-mem_avail)/mem_total)*100)}%"
        total, used, _ = shutil.disk_usage("/")
        stats['disk'] = f"{int((used/total)*100)}%"
    except: pass
    return stats

def get_db_stats():
    stats = {"total": "--", "new": "--", "size": "--"}
    try:
        if os.path.exists(DB_PATH):
            stats["size"] = f"{os.path.getsize(DB_PATH) / (1024*1024):.1f} MB"
            conn = sqlite3.connect(DB_PATH); cur = conn.cursor()
            cur.execute("SELECT count(*) FROM collect"); stats["total"] = f"{cur.fetchone()[0]:,}"
            threshold = (datetime.now() - timedelta(hours=24)).strftime("%Y-%m-%d %H:%M:%S")
            cur.execute("SELECT count(*) FROM collect WHERE date >= ?", (threshold,)); stats["new"] = f"{cur.fetchone()[0]}"
            conn.close()
    except: pass
    return stats

def create_dashboard_layers():
    img_b = Image.new('1', (WIDTH, HEIGHT), 1)
    img_r = Image.new('1', (WIDTH, HEIGHT), 1)
    draw_b = ImageDraw.Draw(img_b); draw_r = ImageDraw.Draw(img_r)
    now = datetime.now()
    jp_hols = holidays.Japan(language='jp')

    conn = sqlite3.connect(DB_PATH); cur = conn.cursor()
    try:
        cur.execute("SELECT main_weather, description, temp, pressure, humidity, alert_events, sunrise_time, sunset_time FROM weather_log ORDER BY datetime DESC LIMIT 1")
        weather_row = cur.fetchone()
        sr_time, ss_time = (weather_row[6], weather_row[7]) if weather_row and len(weather_row) >= 8 else (None, None)
        cur.execute("SELECT temp_max, temp_min FROM weather_forecast WHERE date = ?", (now.strftime("%Y/%m/%d"),))
        today_forecast = cur.fetchone()
        cur.execute("SELECT datetime, weather_main, weather_desc, temp FROM weather_hourly WHERE datetime > ? ORDER BY datetime ASC LIMIT 10", (now.strftime("%Y/%m/%d %H:%M"),))
        hourly_rows = cur.fetchall()
        cur.execute("SELECT date, weather_main, weather_desc, temp_max, temp_min FROM weather_forecast WHERE date > ? ORDER BY date ASC LIMIT 2", (now.strftime("%Y/%m/%d"),))
        daily_rows = cur.fetchall()
        cur.execute("SELECT living_temp, living_humi FROM remo_log ORDER BY datetime DESC LIMIT 1")
        remo_row = cur.fetchone()
        cur.execute("SELECT COALESCE(summary, title), source FROM (SELECT summary, title, source FROM collect WHERE summary IS NOT NULL OR title IS NOT NULL ORDER BY date DESC LIMIT 20) ORDER BY RANDOM() LIMIT 3")
        news_rows = cur.fetchall()
        cur.execute("SELECT rank1, rank2, rank3, rank4, rank5 FROM trend_log ORDER BY date DESC LIMIT 1")
        trend_row = cur.fetchone()
    except: hourly_rows, daily_rows, news_rows, trend_row, weather_row, today_forecast, remo_row = [], [], [], None, None, None, None
    finally: conn.close()

    draw_b.rectangle((0, 0, WIDTH, LO['header_h']), fill=0)

    dbox = LO['date_box']; dx, dy = dbox['x'], dbox['y']
    draw_b.rectangle((dx, dy, dx + dbox['w'], dy + dbox['h']), outline=1, width=2)
    holiday_name = jp_hols.get(now.date())
    
    # 日付 (数字) - 中央揃え (Mplus1-Blackでも真ん中に)
    dn_font = get_font("black", FS['date_num'])
    dn_str = str(now.day)
    dn_w = draw_b.textlength(dn_str, font=dn_font)
    
    # ボックスの中央 - 文字幅の半分 + 微調整オフセット
    dn_x = dx + (dbox['w'] - dn_w) / 2 + LO['header'].get('date_num_x', 0)
    dn_y = dy + LO['header']['date_num_y']
    
    draw_b.text((dn_x, dn_y), dn_str, font=dn_font, fill=1)

    # 曜日 - 中央揃え & 祝日対応
    w_center_x = dx + (dbox['w'] // 2)
    w_font = get_font("bold", FS['date_day'])
    wd_str = JP_WEEKDAYS[now.weekday()]

    if holiday_name:
        # "月 祝" の場合 (曜日は白、祝は赤)
        gap = 4
        hol_mark = "祝"
        wd_w = draw_b.textlength(wd_str, font=w_font)
        hm_w = draw_b.textlength(hol_mark, font=w_font)
        total_w = wd_w + gap + hm_w
        
        start_x = w_center_x - (total_w / 2)
        
        # 曜日(白)
        draw_b.text((start_x, dy + LO['header']['day_y']), wd_str, font=w_font, fill=1)
        # 祝(赤)
        draw_b.text((start_x + wd_w + gap, dy + LO['header']['day_y']), hol_mark, font=w_font, fill=1) # 白抜き
        draw_r.text((start_x + wd_w + gap, dy + LO['header']['day_y']), hol_mark, font=w_font, fill=0) # 赤
    else:
        # 通常 (曜日のみ白)
        wd_w = draw_b.textlength(wd_str, font=w_font)
        start_x = w_center_x - (wd_w / 2)
        draw_b.text((start_x, dy + LO['header']['day_y']), wd_str, font=w_font, fill=1)

    pbox = LO['panel']; px, py = pbox['x'], pbox['y']

    # 時計 - エリア中央揃え (日付ボックスと天気パネルの間)
    c_font = get_font("black", FS['clock'])
    c_str = now.strftime("%H:%M")
    c_w = draw_b.textlength(c_str, font=c_font)
    
    # 時計エリアの開始(日付枠の右)と終了(天気パネルの左)
    c_area_start = dx + dbox['w'] # 10 + 80 = 90
    c_area_end = px               # 345
    c_area_w = c_area_end - c_area_start
    
    # エリア中央に配置 + 微調整オフセット
    clock_x = c_area_start + (c_area_w - c_w) / 2 + (LO['header']['clock_x'] - 105)
    clock_y = LO['header']['clock_y']
    
    if holiday_name:
        h_font = get_font("bold", FS['card_title'])
        h_w = draw_b.textlength(holiday_name, font=h_font)
        draw_b.rectangle((clock_x, LO['header']['hol_bg_y1'], clock_x + h_w + 10, LO['header']['hol_bg_y2']), fill=1)
        draw_smart_text(draw_b, draw_r, (clock_x + 5, LO['header']['hol_txt_y']), holiday_name, h_font, COLOR_RED)
        draw_b.text((clock_x, LO['header']['clock_hol_y']), c_str, font=c_font, fill=1)
    else:
        draw_b.text((clock_x, clock_y), c_str, font=c_font, fill=1)

    draw_b.rectangle((px, py, px + pbox['w'], py + pbox['h']), outline=1, width=2)
    div1_x, div2_x = px + LO['panel_div1'], px + LO['panel_div2']
    draw_b.line((div1_x, py, div1_x, py + pbox['h']), fill=1, width=2)
    draw_b.line((div2_x, py, div2_x, py + pbox['h']), fill=1, width=2)

    weather_base_x = px + LO['pad']
    if weather_row:
        cur_icon = get_weather_icon(weather_row[0], weather_row[1], sr_time, ss_time)
        is_rain = "Rain" in str(weather_row) or "Snow" in str(weather_row)
        icon_f = get_font("weather", FS['icon_lg'])
        
        main_pos = (weather_base_x + LO['weather']['main_icon']['x'], py + LO['weather']['main_icon']['y'])
        draw_weather_icon_smart(draw_b, draw_r, main_pos, cur_icon, icon_f, is_rain)

        if today_forecast:
            temp_pos = (weather_base_x + LO['weather']['main_temp']['x'], py + LO['weather']['main_temp']['y'])
            draw_b.text(temp_pos,
                f"{today_forecast[0]:.0f}/{today_forecast[1]:.0f}",
                font=get_font("medium", 16), fill=1)

        HP = LO['weather']['hourly']
        target_hourly = hourly_rows[2::3][:3]
        for i, r in enumerate(target_hourly): # 3, 6, 9時間後
            bx = weather_base_x + HP['start_x'] + (i * HP['step'])
            dt_h = datetime.strptime(r[0], "%Y/%m/%d %H:%M")
            draw_b.text((bx + HP['time_x'], py + HP['time_y']), dt_h.strftime("%H:%M"), font=get_font("medium", 10), fill=1)
            
            icon_char = get_weather_icon(r[1], r[2], sr_time, ss_time, dt_h)
            is_rain_h = "Rain" in r[1] or "Snow" in r[1] or "Rain" in r[2] or "Snow" in r[2]
            icon_x, icon_y = bx + HP['icon_x'], py + HP['icon_y']
            font_h = get_font("weather", 22)

            draw_weather_icon_smart(draw_b, draw_r, (icon_x, icon_y), icon_char, font_h, is_rain_h)

            draw_b.text((bx + HP['temp_x'], py + HP['temp_y']), f"{r[3]:.0f}°", font=get_font("medium", 11), fill=1)

        # ▼▼▼ 修正箇所：ここに存在した重複コード（3時間予報の再描画）を削除しました ▼▼▼

        DP = LO['weather']['daily']
        draw_b.rectangle((weather_base_x + DP['box_x'], py + DP['box_y'], weather_base_x + DP['box_x'] + DP['box_w'], py + DP['box_y'] + DP['box_h']), outline=1, width=2)
        for i, r in enumerate(daily_rows):
            bx = weather_base_x + DP['start_x'] + (i * DP['step'])
            dt_d = datetime.strptime(r[0], "%Y/%m/%d")
            draw_b.text((bx + DP['day_x'], py + DP['day_y']), JP_WEEKDAYS[dt_d.weekday()], font=get_font("medium", 14), fill=1)
            # 明日以降は常に昼アイコン (12:00判定)
            icon_char = get_weather_icon(r[1], r[2], check_time=dt_d.replace(hour=12))
            is_rain_d = "Rain" in r[1] or "Snow" in r[1] or "Rain" in r[2] or "Snow" in r[2]
            
            draw_weather_icon_smart(draw_b, draw_r, (bx + DP['icon_x'], py + DP['icon_y']), icon_char, get_font("weather", 16), is_rain_d)
            
            draw_b.text((bx + DP['temp_x'], py + DP['temp_y']), f"{r[3]:.0f}/{r[4]:.0f}", font=get_font("medium", 10), fill=1)

    WP = LO['weather']['warn']
    warning_x = div1_x + WP['x_off']
    alert_text = weather_row[5] if weather_row and weather_row[5] else ""
    alerts = [a.strip() for a in alert_text.split(',') if a.strip()] if alert_text else []
    def get_priority(t):
        if "特別警報" in t: return 0
        if "警報" in t: return 1
        return 2
    alerts.sort(key=get_priority)

    if alerts:
        a_font = get_font("medium", 14)
        BAR_W, BAR_M, PITCH = WP['bar_w'], WP['bar_m'], WP['pitch']
        MAX_ITEMS = 10  # 2列x5行
        
        for i, alert in enumerate(alerts):
            if i >= MAX_ITEMS:
                # 最後のスペースに「他」を表示
                draw_b.text((warning_x + WP['other_x'], py + 1 + (4 * PITCH)), f"..他", font=a_font, fill=1)
                break

            # 文字列短縮
            # "特別警報" -> "特", "警報"/"注意報" -> 削除
            display_text = alert.replace("特別警報", "特").replace("警報", "").replace("注意報", "")
            is_warning = "警報" in alert

            # 2列配置 (左:0, 右:1)
            col = i % 2
            row = i // 2
            
            # 幅108pxを2等分 (54pxずつ)
            x_pos = warning_x + (col * WP['col_w'])
            y_pos = py + 1 + (row * PITCH)
            
            # 5行目(index 8,9)に入ろうとして、かつまだ続きがある場合は「他」のために左側で止める処理
            if row == 4 and len(alerts) > MAX_ITEMS and col == 1:
                 draw_b.text((x_pos, y_pos), "..他", font=a_font, fill=1)
                 break

            if is_warning:
                draw_r.rectangle((x_pos-BAR_M-BAR_W, y_pos+5, x_pos-BAR_M, y_pos+17), fill=0)
                draw_b.rectangle((x_pos-BAR_M-BAR_W, y_pos+5, x_pos-BAR_M, y_pos+17), fill=1)
                
            draw_b.text((x_pos, y_pos), display_text[:3], font=a_font, fill=1)

    EP = LO['env']
    draw_b.line((div2_x, py + EP['mid_line'], px + pbox['w'], py + EP['mid_line']), fill=1, width=2)
    ev_x, vx_off = div2_x + EP['lbl_x'], EP['val_x']
    lbl_f, val_f = get_font("medium", 16), get_font("medium", 16)
    c_t = f"{remo_row[0]:.1f}" if remo_row else "--"
    c_h = f"{remo_row[1]:.1f}" if remo_row else "--"
    o_t = f"{weather_row[2]:.1f}" if weather_row else "--"
    pr = f"{weather_row[3]:.0f}" if weather_row else "--"
    
    draw_b.text((ev_x, py+EP['room_y']), "室温", font=lbl_f, fill=1)
    if remo_row and remo_row[0] > 28.0:
        draw_b.text((ev_x+vx_off, py+EP['room_y']), f"{c_t}°C", font=val_f, fill=1)
        draw_r.text((ev_x+vx_off, py+EP['room_y']), f"{c_t}°C", font=val_f, fill=0)
    else:
        draw_b.text((ev_x+vx_off, py+EP['room_y']), f"{c_t}°C", font=val_f, fill=1)
    draw_b.text((ev_x, py+EP['humi_y']), "湿度", font=lbl_f, fill=1)
    draw_b.text((ev_x+vx_off, py+EP['humi_y']), f"{c_h}%", font=val_f, fill=1)
    draw_b.text((ev_x, py+EP['out_y']), "外気", font=lbl_f, fill=1)
    draw_b.text((ev_x+vx_off, py+EP['out_y']), f"{o_t}°C", font=val_f, fill=1)
    draw_b.text((ev_x, py+EP['pres_y']), "気圧", font=lbl_f, fill=1)
    draw_b.text((ev_x+vx_off, py+EP['pres_y']), f"{pr} hPa", font=val_f, fill=1)

    l_f = get_font("bold", 16)
    cy, _ = draw_card_smart(draw_b, draw_r, LO['col1_x'], LO['cards_y'], LO['col1_w'], LO['h_sys'], "SYSTEM & DATABASE", l_f)
    s_f, s_s = get_font("medium", 16), get_system_stats()
    SP = LO['sys']
    # システム情報
    draw_b.text((LO['col1_x']+SP['pad_x'], cy+SP['row1']),
    f"CPU: {s_s['cpu_temp']} Load: {s_s['load']}",
    font=get_font("medium", 16), fill=0)
    draw_b.text((LO['col1_x']+SP['pad_x'], cy+SP['row2']), f"Mem: {s_s['mem']}  Disk: {s_s['disk']}", font=s_f, fill=0)
    draw_b.line((LO['col1_x']+SP['pad_x'], cy+SP['line'], LO['col1_x']+LO['col1_w']-SP['pad_x'], cy+SP['line']), fill=0)
    db = get_db_stats()
    draw_b.text((LO['col1_x']+SP['pad_x'], cy+SP['row3']), f"Total: {db['total']}   New: +{db['new']}", font=s_f, fill=0)
    draw_b.text((LO['col1_x']+SP['pad_x'], cy+SP['row4']), f"DB Size: {db['size']}", font=s_f, fill=0)

    m_y = LO['cards_y'] + LO['h_sys'] + LO['gap']
    draw_card_smart(draw_b, draw_r, LO['col1_x'], m_y, LO['col1_w'], LO['h_market'], "MARKET WATCH", l_f)
    create_stock_grid_direct(draw_b, draw_r, LO['col1_x']+5, m_y+30, LO['col1_w']-10, LO['h_market']-34)

    n_y, n_lim = draw_card_smart(draw_b, draw_r, LO['col2_x'], LO['cards_y'], LO['col2_w'], LO['h_news'], "TOP NEWS SUMMARY", l_f)
    for txt, src in news_rows:
        if n_y + 18 > n_lim: break 
        
        draw_smart_text(draw_b, draw_r, (LO['col2_x']+10, n_y), f"[{src}]", get_font("bold", 14), COLOR_RED)
        n_y += 18 
        
        n_y = draw_text_wrapped_smart(
            draw_b, draw_r, txt, get_font("medium", 14), 
            LO['col2_x']+10, n_y, LO['col2_w']-20, 
            max_lines=3, max_y=n_lim
        )
        n_y += 8

    t_y, t_lim = draw_card_smart(draw_b, draw_r, LO['col2_x'], LO['cards_y']+LO['h_news']+LO['gap'], LO['col2_w'], LO['h_trend'], "TRENDING NOW", l_f)
    if trend_row:
        tags = "  ".join([f"#{k}" for k in trend_row if k])
        draw_text_wrapped_smart(draw_b, draw_r, tags, get_font("medium", 16), LO['col2_x']+10, t_y-2, LO['col2_w']-20, max_lines=2)

    draw_b.rectangle((0, 0, WIDTH-1, HEIGHT-1), outline=0, width=4)
    return img_b, img_r

def create_stock_grid_direct(draw_b, draw_r, start_x, start_y, w, h):
    MP, cell_w, cell_h = LO['market_pos'], w // 2, h // 2
    db_col_map = {"^N225": "nikkei_225", "^DJI": "ny_dow", "JPY=X": "usd_jpy", "6869.T": "sysmex_6869"}

    for i, item in enumerate(TICKERS):
        r, c = i // 2, i % 2
        x, y = start_x + (c * cell_w), start_y + (r * cell_h)
        draw_b.rectangle((x, y, x+cell_w, y+cell_h), outline=0, width=1)
        
        df = pd.DataFrame()
        date_label = ""
        current_val, prev_close_val = 0, 0
        col_name = db_col_map.get(item["symbol"])

        # --- STEP 1: DB からデータを取得 (yfinance は BAN 回避のため廃止) ---
        try:
            conn = sqlite3.connect(DB_PATH)
            # 直近400件取得 (十分な「静止期間」を探すため広めに)
            q = f"SELECT date, {col_name} FROM finance_log WHERE {col_name} IS NOT NULL ORDER BY date DESC LIMIT 400"
            raw_df = pd.read_sql(q, conn)
            conn.close()
            
            if not raw_df.empty:
                raw_df['date'] = pd.to_datetime(raw_df['date'])
                raw_df = raw_df.sort_values('date').reset_index(drop=True)
                
                vals = raw_df[col_name].values
                dates = raw_df['date'].values
                n = len(vals)

                # --- A. 末尾(最新)のトリミング ---
                # 「最後に値が動いた地点」を探す。
                # 最新から遡って、変化点を見つける。
                last_change_idx = n - 1
                for i in range(n - 1, 0, -1):
                    if vals[i] != vals[i-1]:
                        last_change_idx = i
                        break
                
                # 末尾の静止が5点(約1時間強)以上続くなら、そこをチャートの右端とする
                # (動きが終わった直後までを表示)
                cutoff_idx = n
                if (n - 1) - last_change_idx >= 5:
                    cutoff_idx = last_change_idx + 1 # 変化後の最初の静止点まで含める
                
                # チャート候補データ (一旦ここまでの範囲とする)
                # ただしデータが少なすぎる場合はトリミングしない
                if cutoff_idx < 5: cutoff_idx = n

                target_vals = vals[:cutoff_idx]
                target_dates = dates[:cutoff_idx]
                
                # --- B. 開始点(基準値)の探索 ---
                # トリミング地点から過去へ遡り、「8点(約2時間)以上値が変わらない期間」を探す。
                # その静止期間の値こそが「前日終値(基準値)」である。
                
                prev_close_val = target_vals[0]
                start_plot_idx = 0
                
                # 連続同一値のカウンター
                stable_count = 1
                found_baseline = False
                
                # 変動開始地点 (時系列的な開始点) を保持する変数
                # 初期値はデータの先頭(0)ではなく、末尾付近であることを想定しないといけないが、
                # ループ内で「最初の変化」を見つけた時点で更新される。
                # もし一度も変化がなければ(ずっと平坦なら)、volatility_start_idxは更新されないか、初期値の扱いになる。
                volatility_start_idx = 0

                for i in range(len(target_vals) - 2, -1, -1):
                    if target_vals[i] != target_vals[i+1]:
                        # 値が変わった = ここより右側(i+1以降)が「新しい変動ブロック」
                        volatility_start_idx = i + 1
                        stable_count = 1
                    else:
                        # 値が変わらない
                        stable_count += 1
                        # 静止期間が一定以上続いた場合、ここが「基準となる静止期間」であると判定
                        if stable_count >= 8:
                            prev_close_val = target_vals[i]
                            # チャートの開始位置は、変動が始まる直前の点 (静止期間の最後の1点) とする
                            # これにより、基準値から変動への遷移が描画される
                            start_plot_idx = volatility_start_idx - 1
                            if start_plot_idx < 0: start_plot_idx = 0
                            
                            found_baseline = True
                            break
                
                # もし基準が見つからない場合(ずっと変動している、またはデータ不足)
                if not found_baseline:
                      start_plot_idx = 0
                      prev_close_val = target_vals[0]

                # --- C. チャート用データの確定 ---
                # 基準値より後のデータのみをプロットする
                df = pd.DataFrame({
                    'date': target_dates[start_plot_idx:], 
                    col_name: target_vals[start_plot_idx:]
                })
                
                # 現在値（表示上の最新値）
                current_val = df[col_name].iloc[-1]
                date_label = df['date'].iloc[-1].strftime("%m/%d %H:%M") # 時間も入れた方が分かりやすいかも

                # 変化検知フラグ (軽量化: スプラインを綺麗に引くため、極端に変化がない点は間引いてもよいが
                # 今回はロジックで範囲を絞ったので、全点描画でもOK。一応連続重複削除は入れておく)
                # df = df[df[col_name].shift() != df[col_name]].copy() # これをやると階段状になるので、スプラインなら全点推奨
                # ユーザー要望: "変動しているポイントのみつなげてチャート化" -> 重複削除する
                df_plot = df.loc[df[col_name].shift() != df[col_name]].copy()
                if len(df_plot) < 2: df_plot = df # 点が少なすぎたら元に戻す

            else:
                df_plot = pd.DataFrame()

        except Exception as e:
            print(f"DB Fetch Error for {item['name']}: {e}")
            df_plot = pd.DataFrame()

        # --- STEP 2: 描画 ---
        # データが無い、あるいは計算不能時は初期値のまま
        if not df_plot.empty and len(df_plot) >= 2:
            hist_values = df_plot[col_name].values
            current_val = hist_values[-1]
            change = current_val - prev_close_val

            fig = plt.figure(figsize=((cell_w+MP['chart_w_adj'])/50, (cell_h+MP['chart_h_adj'])/50), dpi=50)
            fig.patch.set_facecolor('white')
            # 前日終値の基準線 (黒点線)
            plt.axhline(y=prev_close_val, color='black', linestyle='--', linewidth=1.2)

            if len(hist_values) >= 4:
                x_idx = np.arange(len(hist_values))
                x_new = np.linspace(0, len(hist_values)-1, 200)
                spl = make_interp_spline(x_idx, hist_values, k=3)
                plt.plot(x_new, spl(x_new), color='black', linewidth=3)
            else:
                plt.plot(hist_values, color='black', linewidth=3)
            
            # 軸範囲の調整 (点線を確実に含める)
            all_vals = np.append(hist_values, prev_close_val)
            y_min, y_max = np.min(all_vals), np.max(all_vals)
            margin = (y_max - y_min) * 0.15 if y_max != y_min else y_max * 0.01
            plt.ylim(y_min - margin, y_max + margin)

            # USD/JPYの場合、Y軸を反転 (値が小さい=円高 を上に)
            if item["symbol"] == "JPY=X":
                plt.gca().invert_yaxis()
            
            plt.axis('off'); plt.tight_layout(pad=0)
            buf = io.BytesIO(); plt.savefig(buf, format='png', facecolor='white', transparent=False); plt.close(); buf.seek(0)
            
            # 白背景・黒線 -> 反転して 黒背景(0)・白線(1) にする。bitmapは1の部分をfillで塗るため。
            chart = ImageOps.invert(Image.open(buf).convert("L")).convert("1")
            cx, cy = int(x+MP['txt_x']), int(y+MP['chart_y'])
            
            if change < 0:
                draw_r.bitmap((cx, cy), chart, fill=0) # 赤で描く
                draw_b.bitmap((cx, cy), chart, fill=1) # 黒を抜く
            else:
                draw_b.bitmap((cx, cy), chart, fill=0) # 黒で描く
        else:
            # データ不足などで描画できない場合
            change = current_val - prev_close_val
            
        # テキスト情報はグラフの有無に関わらず描画
        draw_smart_text(draw_b, draw_r, (x+MP['txt_x'], y+MP['name_y']), item["name"], get_font("medium", 14))
        name_w = draw_b.textlength(item["name"], font=get_font("medium", 14))
        draw_smart_text(draw_b, draw_r, (x+MP['txt_x'] + name_w + 5, y+MP['name_y'] + 2), f"[{date_label}]", get_font("medium", 10))
        
        # 変化記号と色: プラス=黒(+), マイナス=赤(-), 変わらず=黒(=)
        # Mplus1Code等で豆腐になるのを防ぐためASCII文字を使用
        sign_char = '+' if change > 0 else '-' if change < 0 else '='
        text_color = COLOR_RED if change < 0 else COLOR_BLACK
        
        # 1. 現在値 (大きく)
        val_str = f"{sign_char}{item['fmt'].format(current_val)}"
        val_font = get_font("medium", 14)
        draw_smart_text(draw_b, draw_r, (x+MP['txt_x'], y+MP['val_y']), val_str, val_font, text_color)
        
        # 2. 差分 (横に同じ大きさで)
        val_w = draw_b.textlength(val_str, font=val_font)
        diff_val_str = item['fmt'].format(abs(change))
        # 差分は符号を明示
        diff_sign = '+' if change > 0 else '-' if change < 0 else '='
        diff_str = f"({diff_sign}{diff_val_str})"
        
        # メインと同じフォントサイズ(14px)で表示
        draw_smart_text(draw_b, draw_r, (x+MP['txt_x'] + val_w + 4, y+MP['val_y']), diff_str, val_font, text_color)
        
        time.sleep(0.1)

def create_weather_detail_layers():
    """天気詳細モード: 3時間予報グラフ(気温+降水確率) + 週間予報"""
    img_b = Image.new('1', (WIDTH, HEIGHT), 1)
    img_r = Image.new('1', (WIDTH, HEIGHT), 1)
    draw_b = ImageDraw.Draw(img_b); draw_r = ImageDraw.Draw(img_r)
    
    conn = sqlite3.connect(DB_PATH)
    try:
        # 現在の天気 (alert_eventsを追加)
        cur = conn.cursor()
        cur.execute("SELECT main_weather, description, temp, humidity, pressure, alert_events FROM weather_log ORDER BY datetime DESC LIMIT 1")
        cur_w = cur.fetchone()
        
        # 3時間予報 (直近24時間分)
        # データが1時間毎の場合と3時間毎の場合があるため、多めに取得してPython側で調整する
        now_str = datetime.now().strftime("%Y/%m/%d %H:%M")
        cur.execute("SELECT datetime, temp, weather_main, weather_desc, pop FROM weather_hourly WHERE datetime > ? ORDER BY datetime ASC LIMIT 48", (now_str,))
        raw_hourly = cur.fetchall()
        
        # 3時間ごとのデータに間引く
        hourly_data = []
        if raw_hourly:
            # 最初のデータは採用
            hourly_data.append(raw_hourly[0])
            last_dt = datetime.strptime(raw_hourly[0][0], "%Y/%m/%d %H:%M")
            
            for row in raw_hourly[1:]:
                curr_dt = datetime.strptime(row[0], "%Y/%m/%d %H:%M")
                # 3時間以上経過していれば採用
                if (curr_dt - last_dt).total_seconds() >= 3 * 3600:
                    hourly_data.append(row)
                    last_dt = curr_dt
                    
            # 9個(24時間分)に絞る
            hourly_data = hourly_data[:9]

        # 週間予報 (明日から7日分)
        today_str = datetime.now().strftime("%Y/%m/%d")
        cur.execute("SELECT date, weather_main, weather_desc, temp_max, temp_min, pop FROM weather_forecast WHERE date > ? ORDER BY date ASC LIMIT 7", (today_str,))
        daily_data = cur.fetchall()
    except Exception as e:
        print(f"DB Error: {e}")
        return img_b, img_r
    finally:
        conn.close()

    # --- 1. Header (0 - 110px) ---
    draw_b.rectangle((0, 0, WIDTH, 110), fill=0) # 黒帯
    
    if cur_w:
        # 左: 特大アイコン (視覚的中央へさらに上へ)
        icon_f = get_font("weather", 90)
        icon_char = get_weather_icon(cur_w[0], cur_w[1])
        draw_b.text((20, -10), icon_char, font=icon_f, fill=1)
        
        # 中央: 気温 (超特大)
        temp_str = f"{cur_w[2]:.1f}°C"
        # フォントのアセンダを考慮して少しマイナスへ
        draw_b.text((140, -15), temp_str, font=get_font("bold", 75), fill=1)
        
        # 補足情報 (湿度・気圧) - 気温の下
        sub_str = f"Humi: {cur_w[3]}%   Pres: {cur_w[4]}hPa"
        draw_b.text((150, 80), sub_str, font=get_font("medium", 18), fill=1)
        
        # 右: 日付・時刻 (少し小さくして上に詰める)
        now = datetime.now()
        date_str = now.strftime("%Y/%m/%d")
        day_str = JP_WEEKDAYS[now.weekday()]
        time_str = now.strftime("%H:%M")
        
        # 右端配置
        date_x = WIDTH - 200
        draw_b.text((date_x, 5), f"{date_str} ({day_str})", font=get_font("bold", 20), fill=1)
        draw_b.text((date_x, 28), time_str, font=get_font("bold", 46), fill=1)
        
        # 警報・注意報表示 (ヘッダー上部、メイン画面同様の2列グリッド配置)
        alert_text = cur_w[5] if cur_w[5] else ""
        alerts = [a.strip() for a in alert_text.split(',') if a.strip()] if alert_text else []
        
        # 優先度ソート関数
        def get_priority(t):
            if "特別警報" in t: return 0
            if "警報" in t: return 1
            return 2
            
        alerts.sort(key=get_priority)
        
        if alerts:
            # 視認性を重視して上詰め配置
            # 気温の右側、日付の左側のスペースを活用
            base_x = 380 
            base_y = 10  # 上詰め
            col_w = 105 # 列幅
            pitch = 22  # 行送り(メイン画面22pxに合わせる)
            bar_w, bar_m = 4, 4
            a_font = get_font("medium", 14)
            
            MAX_ITEMS = 8 # 2x4まで表示可能
            
            for i, alert in enumerate(alerts):
                if i >= MAX_ITEMS:
                    # 最後のスペースに「他」
                    c = 1; r = 3
                    dx = base_x + (c * col_w)
                    dy = base_y + (r * pitch)
                    draw_b.text((dx, dy), "..他", font=a_font, fill=1)
                    break
                
                # 文字列短縮
                disp = alert.replace("特別警報", "特").replace("警報", "").replace("注意報", "")
                is_warning = "警報" in alert
                
                col = i % 2
                row = i // 2
                
                x_pos = base_x + (col * col_w)
                y_pos = base_y + (row * pitch)
                
                # スタイル描画 (メイン画面準拠)
                if is_warning:
                    # 赤バー (赤0/黒1 = 赤)
                    draw_r.rectangle((x_pos, y_pos+2, x_pos + bar_w, y_pos + 16), fill=0)
                    draw_b.rectangle((x_pos, y_pos+2, x_pos + bar_w, y_pos + 16), fill=1)
                    # 文字 (白)
                    draw_b.text((x_pos + bar_w + bar_m, y_pos), disp, font=a_font, fill=1)
                else:
                    # 注意報 (白文字のみ)
                    draw_b.text((x_pos, y_pos), disp, font=a_font, fill=1)

    # --- 2. Hourly Chart (120px - 280px) ---
    # 今後24時間分 (3h x 8 = 24h + 始点 = 9個)
    target_hourly = hourly_data[:9] 
    
    if target_hourly:
        times = [datetime.strptime(r[0], "%Y/%m/%d %H:%M") for r in target_hourly]
        temps = [r[1] for r in target_hourly]
        pops = [r[4] if r[4] is not None else 0 for r in target_hourly]
        icons = [r[2] for r in target_hourly] # weather_main
        descs = [r[3] for r in target_hourly] # weather_desc
        
        plt.rcParams.update({'font.size': 14})
        # 高さを少し減らしてアイコン用のスペースを空ける (160 -> 130px 程度)
        fig, ax1 = plt.subplots(figsize=(16, 2.6), dpi=50) 
        fig.patch.set_facecolor('white')
        
        # 枠線削除
        for spine in ['top', 'right', 'left']:
            ax1.spines[spine].set_visible(False)
        ax1.spines['bottom'].set_color('black')
            
        # 降水確率 (棒) -> 右軸
        ax2 = ax1.twinx()
        for spine in ['top', 'right', 'left', 'bottom']:
            ax2.spines[spine].set_visible(False)
        ax2.bar(times, pops, color='red', width=0.06, alpha=1.0, align='center') # 幅を少し狭める
        ax2.set_ylim(0, 100)
        ax2.set_yticks([])
        
        # 気温 (折れ線) -> 左軸
        ax1.plot(times, temps, color='black', marker='o', markersize=6, linewidth=4)
        
        # 数値表示
        for x, y in zip(times, temps):
            ax1.text(x, y + 0.5, f"{y:.0f}", ha='center', va='bottom', fontsize=20, fontweight='bold', color='black')

        # --- 3. 完全同期レイアウト描画 ---
        
        # グラフ描画エリア定義
        margin_left = 40
        chart_w_px = WIDTH - (margin_left * 2) # 720px
        chart_h_px = 110 # 高さ短縮 (140->110) で週間予報との被りを防ぐ
        
        # Matplotlib内部のマージン率 (左右に少し余白を持たせて見切れを防ぐ)
        mp_margin_rate = 0.06 
        
        # PIL側のX座標計算
        # 描画幅の実質領域 = 全幅 * (1 - 左右マージン率*2)
        inner_w = chart_w_px * (1.0 - (mp_margin_rate * 2))
        num_points = len(times)
        step_px = inner_w / (num_points - 1)
        
        # 左端オフセット = 全体左マージン + グラフ内左マージン
        start_x = margin_left + (chart_w_px * mp_margin_rate)
        
        x_coords = [start_x + (i * step_px) for i in range(num_points)]
        
        # Y座標定義 (時間 -> アイコン -> グラフ の順に変更)
        time_y = 118
        icon_y = 145
        chart_start_y = 205 # さらに下げて隙間を作る
        
        # 1. アイコンと時間を描画
        for i, (main, desc) in enumerate(zip(icons, descs)):
            cx = x_coords[i] 
            dt = times[i]
            chk_icon = get_weather_icon(main, desc, check_time=dt)
            is_rain = "Rain" in main or "Snow" in main
            
            # 時間 (一番上)
            time_str = dt.strftime("%H")
            f_time = get_font("bold", 22)
            time_w = draw_b.textlength(time_str, font=f_time)
            draw_b.text((cx - time_w/2, time_y), time_str, font=f_time, fill=0)
            
            # アイコン (その下)
            f_icon = get_font("weather", 38)
            icon_w = draw_b.textlength(chk_icon, font=f_icon)
            
            if is_rain:
                draw_r.text((cx - icon_w/2, icon_y), chk_icon, font=f_icon, fill=0)
            else:
                draw_b.text((cx - icon_w/2, icon_y), chk_icon, font=f_icon, fill=0)

        # 2. Matplotlibでグラフ生成
        plt.rcParams.update({'font.size': 14})
        fig = plt.figure(figsize=(chart_w_px/50, chart_h_px/50), dpi=50)
        fig.patch.set_facecolor('white')
        
        # マージンを設定して見切れを防ぐ
        # left/rightで内側に余白を作る -> データ点はその内側に描画される
        # これによりPILの座標(inner_w)と一致する
        plt.subplots_adjust(left=mp_margin_rate, right=1.0-mp_margin_rate, bottom=0, top=1)
        
        ax1 = fig.add_subplot(111)
        ax1.set_axis_off()
        
        ax2 = ax1.twinx()
        ax2.set_axis_off()
        ax2.set_ylim(0, 100)
        ax2.bar(times, pops, color='red', width=0.04, alpha=1.0, align='center')

        ax1.set_xlim(times[0], times[-1])
        
        t_min, t_max = min(temps), max(temps)
        margin_t = (t_max - t_min) * 0.5 if t_max != t_min else 5
        ax1.set_ylim(t_min - margin_t, t_max + margin_t)
        
        ax1.plot(times, temps, color='black', marker='o', markersize=9, linewidth=4)
        
        for x, y in zip(times, temps):
            ax1.text(x, y + (margin_t * 0.15), f"{y:.0f}", ha='center', va='bottom', fontsize=20, fontweight='bold', color='black')

        # 画像保存と貼り付け
        buf = io.BytesIO()
        fig.savefig(buf, format='png', facecolor='white')
        plt.close() # 保存後に閉じる
        buf.seek(0)
        
        # 画像貼り付け (PILの計算したLeftマージン位置に貼る)
        src_img = Image.open(buf).convert("RGB")
        
        # 色分離
        arr = np.array(src_img)
        white_mask = (arr[:,:,0] > 220) & (arr[:,:,1] > 220) & (arr[:,:,2] > 220)
        red_mask = (arr[:,:,0] > 150) & (arr[:,:,1] < 100) & (arr[:,:,2] < 100)
        black_mask = (~white_mask) & (~red_mask)
        
        img_r_arr = red_mask.astype(np.uint8) * 255
        chart_red = Image.fromarray(img_r_arr, mode='L').convert('1')
        img_b_arr = black_mask.astype(np.uint8) * 255
        chart_black = Image.fromarray(img_b_arr, mode='L').convert('1')
        
        draw_b.bitmap((margin_left, chart_start_y), chart_black, fill=0)
        draw_r.bitmap((margin_left, chart_start_y), chart_red, fill=0)

    # --- 3. Weekly Forecast (290px - 480px) ---
    if daily_data:
        # 開始位置を下げる (300 -> 330)
        y_start = 330
        box_w = WIDTH // len(daily_data)
        
        # 区切り線
        draw_b.line((20, y_start-10, WIDTH-20, y_start-10), fill=0, width=3)
        
        for i, day in enumerate(daily_data):
            x = i * box_w
            cx = x + (box_w // 2) 
            
            # 日付
            dt = datetime.strptime(day[0], "%Y/%m/%d")
            d_str = f"{dt.day}"
            wd_str = f"({JP_WEEKDAYS[dt.weekday()]})"
            
            d_font = get_font("bold", 24)
            w_font = get_font("medium", 18)
            
            w_d = draw_b.textlength(d_str, font=d_font)
            w_w = draw_b.textlength(wd_str, font=w_font)
            
            gap = 5
            total_w = w_d + gap + w_w
            start_x = cx - (total_w / 2)
            
            draw_smart_text(draw_b, draw_r, (start_x, y_start), d_str, d_font, COLOR_BLACK)
            
            wd_color = COLOR_RED if dt.weekday() == 6 else COLOR_BLACK
            draw_smart_text(draw_b, draw_r, (start_x + w_d + gap, y_start + 6), wd_str, w_font, wd_color)
            
            # アイコン (少し上に詰める: +40 -> +35)
            icon_char = get_weather_icon(day[1], day[2], check_time=dt.replace(hour=12))
            is_rain = "Rain" in day[1] or "Snow" in day[1]
            icon_f = get_font("weather", 50)
            
            ix = cx - 25
            iy = y_start + 35
            
            if is_rain:
                draw_r.text((ix, iy), icon_char, font=icon_f, fill=0)
            else:
                draw_b.text((ix, iy), icon_char, font=icon_f, fill=0)
                
            # 気温 (上に詰める: +110 -> +95)
            max_s = f"{day[3]:.0f}"
            sep_s = " / "
            min_s = f"{day[4]:.0f}"
            
            temp_font = get_font("bold", 24)
            
            w_max = draw_b.textlength(max_s, font=temp_font)
            w_sep = draw_b.textlength(sep_s, font=temp_font)
            w_min = draw_b.textlength(min_s, font=temp_font)
            
            total_w = w_max + w_sep + w_min
            start_x = cx - (total_w / 2)
            
            temp_y = y_start + 95
            
            draw_smart_text(draw_b, draw_r, (start_x, temp_y), max_s, temp_font, COLOR_RED)
            draw_smart_text(draw_b, draw_r, (start_x + w_max, temp_y), sep_s, temp_font, COLOR_BLACK)
            draw_smart_text(draw_b, draw_r, (start_x + w_max + w_sep, temp_y), min_s, temp_font, COLOR_BLACK)
            
            # 降水確率 (上に詰める: +150 -> +130)
            if day[5] is not None and int(day[5]) >= 30:
                pop_s = f"{day[5]}%"
                w = draw_b.textlength(pop_s, font=get_font("bold", 18))
                draw_smart_text(draw_b, draw_r, (cx - (w/2), y_start + 130), pop_s, get_font("bold", 18), COLOR_BLACK)

    return img_b, img_r

def create_env_chart_layers():
    """環境センサーモード: 室温・外気・湿度の24時間推移グラフ"""
    img_b = Image.new('1', (WIDTH, HEIGHT), 1)
    img_r = Image.new('1', (WIDTH, HEIGHT), 1)
    draw_b = ImageDraw.Draw(img_b); draw_r = ImageDraw.Draw(img_r)

    conn = sqlite3.connect(DB_PATH)
    try:
        # 過去24時間のデータを取得
        yesterday = (datetime.now() - timedelta(hours=24)).strftime("%Y-%m-%d %H:%M:%S")
        
        # Remo (室温・湿度) - 10分毎くらいに間引くか、そのまま描画してmatplotlibに任せる
        df_remo = pd.read_sql(f"SELECT datetime, living_temp, living_humi FROM remo_log WHERE datetime > '{yesterday}' ORDER BY datetime ASC", conn)
        
        # Weather (外気・気圧)
        df_weather = pd.read_sql(f"SELECT datetime, temp FROM weather_log WHERE datetime > '{yesterday}' ORDER BY datetime ASC", conn)
        
        # 最新値
        cur = conn.cursor()
        cur.execute("SELECT living_temp, living_humi FROM remo_log ORDER BY datetime DESC LIMIT 1")
        cur_remo = cur.fetchone()
        cur.execute("SELECT temp, pressure FROM weather_log ORDER BY datetime DESC LIMIT 1")
        cur_weather = cur.fetchone()
        
    except Exception as e:
        print(f"DB Error: {e}")
        return img_b, img_r
    finally:
        conn.close()

    # --- Header ---
    draw_b.rectangle((0, 0, WIDTH, 65), fill=0) # ヘッダー領域
    
    # タイトル
    draw_b.text((15, 12), "ENV MONITOR", font=get_font("bold", 28), fill=1)
    
    # 最新値 4種 (In, Humi, Out, Pres)
    if cur_remo and cur_weather:
        # レイアウト: タイトルの右側に4つ並べる
        start_x = 280
        step_x = 130
        lbl_y = 5
        val_y = 28
        
        lbl_f = get_font("medium", 14)
        val_f = get_font("bold", 26)
        
        # 1. Room (In)
        draw_b.text((start_x, lbl_y), "ROOM", font=lbl_f, fill=1)
        draw_b.text((start_x, val_y), f"{cur_remo[0]:.1f}°C", font=val_f, fill=1)
        
        # 2. Humi
        draw_b.text((start_x + step_x, lbl_y), "HUMIDITY", font=lbl_f, fill=1)
        draw_b.text((start_x + step_x, val_y), f"{cur_remo[1]:.0f}%", font=val_f, fill=1)
        
        # 3. Out
        # 外気温はグラフの色(赤)に合わせて赤文字(白抜き+赤)にしたいが、黒背景上なので
        # ここは白文字で統一し、ラベルで識別させる
        draw_b.text((start_x + step_x*2, lbl_y), "OUTSIDE", font=lbl_f, fill=1)
        draw_b.text((start_x + step_x*2, val_y), f"{cur_weather[0]:.1f}°C", font=val_f, fill=1)
        
        # 4. Pressure
        draw_b.text((start_x + step_x*3 + 10, lbl_y), "PRESSURE", font=lbl_f, fill=1)
        draw_b.text((start_x + step_x*3 + 10, val_y), f"{cur_weather[1]:.0f}hPa", font=get_font("bold", 22), fill=1) # 単位長いので少し小さく

    # --- Chart ---
    if not df_remo.empty and not df_weather.empty:
        df_remo['datetime'] = pd.to_datetime(df_remo['datetime'])
        df_weather['datetime'] = pd.to_datetime(df_weather['datetime'])
        
        plt.rcParams.update({'font.size': 18})

        # RGBで作成 (後で色分離する)
        fig, ax1 = plt.subplots(figsize=(16, 8), dpi=50) 
        fig.patch.set_facecolor('white')
        
        # 不要な枠線を消す (モダン化)
        for spine in ['top', 'right']:
            ax1.spines[spine].set_visible(False)
            
        # --- 左軸: 気温 (Temperature) ---
        # 室温: 黒・極太実線
        line1, = ax1.plot(df_remo['datetime'], df_remo['living_temp'], 
                          color='black', linewidth=8, linestyle='-', label='Room')
        
        # 外気: 赤・太実線 (アクセント)
        # Matplotlibの 'red' は (1.0, 0.0, 0.0)
        line2, = ax1.plot(df_weather['datetime'], df_weather['temp'], 
                          color='red', linewidth=5, linestyle='-', label='Out')
        
        ax1.set_ylabel('Temp (°C)', fontsize=22, weight='bold', color='black')
        ax1.tick_params(axis='y', colors='black', labelsize=18, width=2, length=6)
        ax1.tick_params(axis='x', colors='black', labelsize=18, width=2, length=6)
        
        # --- 右軸: 湿度 (Humidity) ---
        ax2 = ax1.twinx()
        for spine in ['top', 'left']: # 右軸用なので左枠は不要(ax1にある)、上も不要
            ax2.spines[spine].set_visible(False)
        ax2.spines['right'].set_visible(True) # 右枠はあってもいいが、数値だけで十分なら消すのもあり。今回は残す

        # 湿度: グレー(黒レイヤーでディザリングされるか、濃いグレーなら黒になる)・点線
        # ここでは「黒の点線」として明示的に描く
        line3, = ax2.plot(df_remo['datetime'], df_remo['living_humi'], 
                          color='#444444', linewidth=3, linestyle=':', label='Humi')
        
        ax2.set_ylabel('Humidity (%)', fontsize=22, weight='bold', color='#444444')
        ax2.set_ylim(0, 100)
        ax2.tick_params(axis='y', colors='#444444', labelsize=18, width=2, length=6)
        
        # グリッド削除
        ax1.grid(False)
        ax2.grid(False)

        # 凡例 (枠なし、上部配置)
        lines = [line1, line2, line3]
        labels = [l.get_label() for l in lines]
        legend = ax1.legend(lines, labels, loc='upper center', bbox_to_anchor=(0.5, 1.15),
                   ncol=3, fontsize=20, frameon=False)
        
        # 凡例のテキスト色を合わせる
        plt.setp(legend.get_texts()[1], color='red') # Out を赤に
        plt.setp(legend.get_texts()[2], color='#444444') # Humi をグレーに

        # 時間軸 (時のみ表示)
        ax1.xaxis.set_major_formatter(mdates.DateFormatter('%H'))
        ax1.xaxis.set_major_locator(mdates.HourLocator(interval=2)) # 2時間ごと
        
        # 範囲をきっちり現在から24時間前に固定
        end_time = datetime.now()
        start_time = end_time - timedelta(hours=24)
        ax1.set_xlim(start_time, end_time)
        
        # 回転なし(水平)に戻す
        plt.setp(ax1.xaxis.get_majorticklabels(), rotation=0, ha='center')
        
        plt.tight_layout()
        buf = io.BytesIO()
        plt.savefig(buf, format='png', facecolor='white')
        plt.close()
        buf.seek(0)
        
        # 画像処理: 色分解 (赤 vs 黒)
        src_img = Image.open(buf).convert("RGB")
        if src_img.width > WIDTH:
             src_img = src_img.crop((0, 0, WIDTH, src_img.height))

        # ピクセルデータを走査して分離 (Numpyを使うと高速だが、PILのみで実装)
        import numpy as np
        arr = np.array(src_img)
        
        # マスク作成
        # 1. 白背景 (R,G,B > 220)
        white_mask = (arr[:,:,0] > 220) & (arr[:,:,1] > 220) & (arr[:,:,2] > 220)
        
        # 2. 赤 (R > 150, G < 100, B < 100)
        red_mask = (arr[:,:,0] > 150) & (arr[:,:,1] < 100) & (arr[:,:,2] < 100)
        
        # 3. 黒 (それ以外)
        # 「白ではない」かつ「赤ではない」もの
        black_mask = (~white_mask) & (~red_mask)
        
        # 画像生成: マスクがTrueの部分を255(白)にする
        # draw.bitmapは「1(白)の部分」を指定色(fill=0)で塗るため。
        
        # 赤レイヤー: 赤マスク部分(True)を255にする
        img_r_arr = red_mask.astype(np.uint8) * 255
        chart_red = Image.fromarray(img_r_arr, mode='L').convert('1')
        
        # 黒レイヤー: 黒マスク部分(True)を255にする
        img_b_arr = black_mask.astype(np.uint8) * 255
        chart_black = Image.fromarray(img_b_arr, mode='L').convert('1')
        
        # 貼り付け
        draw_b.bitmap((0, 70), chart_black, fill=0)
        draw_r.bitmap((0, 70), chart_red, fill=0)

    return img_b, img_r


# --- 実行 ---
if __name__ == "__main__":
    def log(msg): print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")
    
    parser = argparse.ArgumentParser(description="YATA Dashboard")
    parser.add_argument("--mode", type=str, default="default", help="Display mode: default, weather, env")
    parser.add_argument("--no-epd", action="store_true", help="Skip e-Paper drawing")
    args = parser.parse_args()

    try:
        log(f"🚀 処理開始 Mode: {args.mode}")
        
        if args.mode == "weather":
            img_black, img_red = create_weather_detail_layers()
        elif args.mode == "env":
            img_black, img_red = create_env_chart_layers()
        else:
            img_black, img_red = create_dashboard_layers()
        
        # Debug保存
        debug = Image.new("RGB", (WIDTH, HEIGHT), (255, 255, 255))
        debug.paste((0,0,0), mask=ImageOps.invert(img_black.convert("L")))
        debug.paste((255,0,0), mask=ImageOps.invert(img_red.convert("L")))
        debug_path = "/dev/shm/dashboard.png"
        debug.save(debug_path)
        log(f"📸 保存完了 ({args.mode}) -> {debug_path}")

        if DRAW_TO_EPD and not args.no_epd:
            sys.path.append(os.path.expanduser("~/e-Paper/RaspberryPi_JetsonNano/python/lib"))
            from waveshare_epd import epd7in5b_V2
            epd = epd7in5b_V2.EPD()
            epd.init()
            epd.display(epd.getbuffer(img_black), epd.getbuffer(img_red))
            epd.sleep()
            log("🎉 EPD描画完了")
            
    except Exception as e:
        log(f"⚠ Error: {e}")
        traceback.print_exc()
        send_discord(f"⚠ YATA Dashboard Error: {e}")