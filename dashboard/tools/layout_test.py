import os
from PIL import Image, ImageDraw, ImageFont
from datetime import datetime

# --- 設定 ---
WIDTH, HEIGHT = 800, 480
# dashboard/tools/ から見た dashboard/fonts/ へのパス
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONT_DIR = os.path.join(BASE_DIR, "fonts")

if not os.path.exists(FONT_DIR):
    # フォールバック
    FONT_DIR = os.path.expanduser("~/yata_fonts")
FONT_JP_BOLD = os.path.join(FONT_DIR, "NotoSansCJKjp-Bold.otf")
FONT_EN_BOLD = os.path.join(FONT_DIR, "RobotoMono-Bold.ttf")

# --- 画像のキャンバスを作成 (白背景) ---
# プレビュー用にグレースケール('L')で作成
image = Image.new('L', (WIDTH, HEIGHT), 255) # 255=白
draw = ImageDraw.Draw(image)

# --- フォント読み込み ---
try:
    font_clock = ImageFont.truetype(FONT_EN_BOLD, 80)      # 時計用
    font_date  = ImageFont.truetype(FONT_EN_BOLD, 25)      # 日付用
    font_h1    = ImageFont.truetype(FONT_JP_BOLD, 30)      # 見出し用
    font_body  = ImageFont.truetype(FONT_JP_BOLD, 18)      # 本文用
    font_cal   = ImageFont.truetype(FONT_EN_BOLD, 20)      # カレンダー数字
except OSError:
    print("フォントが見つかりません。パスを確認してください。")
    exit()

# === 1. ヘッダーエリア (時計) ===
# 黒い帯を描く
draw.rectangle((0, 0, WIDTH, 110), fill=0) # 0=黒

# 時計を描く (白文字)
now = datetime.now()
time_str = now.strftime("%H:%M")
date_str = now.strftime("%Y/%m/%d %A")

draw.text((30, 10), time_str, font=font_clock, fill=255) # 255=白
draw.text((30, 85), date_str, font=font_date, fill=255)

# === 2. 左サイド (カレンダー & データ) ===
# 境界線
draw.line((300, 130, 300, 460), fill=0, width=3)

draw.text((30, 130), "[ CALENDAR ]", font=font_date, fill=0)
# ダミーカレンダー (雰囲気だけ)
cal_text = """
 Su Mo Tu We Th Fr Sa
          1  2  3  4
  5  6  7  8  9 10 11
 12 13 14 15 16 17 18
 19 20 21 22 23 24 25
 26 27 28 29 30 31
"""
draw.text((30, 160), cal_text, font=font_cal, fill=0)

# 環境データ
draw.text((30, 350), "TEMP : 24.5°C", font=font_date, fill=0)
draw.text((30, 390), "HUM  : 45.0 %", font=font_date, fill=0)
draw.text((30, 430), "PRES : 1013 hPa", font=font_date, fill=0)

# === 3. 右サイド (ニュース) ===
draw.text((330, 130), "◆ Pickup News", font=font_h1, fill=0)

news_title = "ラズパイ5、ついに完全無線化へ"
news_body = """
本日のアップデートにより、YATAシステムが
Wi-Fi環境下での完全動作に対応しました。
これにより設置場所の制約がなくなり、
リビングや寝室など自由な配置が可能になります。
Tailscaleによる外部アクセスも維持されており、
セキュリティと利便性を両立しています。
(Source: Boncoli Tech)
"""
# ニュース描画
draw.text((330, 180), news_title, font=font_h1, fill=0)
draw.text((330, 230), news_body, font=font_body, fill=0, spacing=10)

# --- 保存 ---
save_path = "preview.png"
image.save(save_path)
print(f"プレビュー画像を保存しました: {save_path}")