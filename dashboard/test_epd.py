# =================================================================
# 【点灯式用】電子ペーパー動作確認スクリプト (test_epd.py)
# =================================================================
# [ ファイルの場所 ]
#   ~/yata-local/dashboard/test_epd.py
#
# [ 実行方法 ]
#   python3 ~/yata-local/dashboard/test_epd.py
#
# [ 事前確認 ]
#   1. 電子ペーパーが正しく配線されていること
#   2. sudo raspi-config で SPI が「Enabled」になっていること
#   3. ライブラリが ~/e-Paper/... に配置されていること
#
# [ このスクリプトの役割 ]
#   DB接続や複雑な計算を一切行わず、単純な「文字」と「枠線」を
#   描画することで、ハードウェアの疎通確認を最優先で行います。
# =================================================================

import os
import sys
from PIL import Image, ImageDraw, ImageFont

# --- ライブラリパスの設定 ---
# findコマンドで特定したパスを指定
LIB_DIR = os.path.expanduser("~/e-Paper/RaspberryPi_JetsonNano/python/lib")
if os.path.exists(LIB_DIR):
    sys.path.append(LIB_DIR)
else:
    print(f"Error: ライブラリが見つかりません: {LIB_DIR}")
    sys.exit(1)

try:
    from waveshare_epd import epd7in5_V2
except ImportError:
    print("Error: waveshare_epd ドライバをインポートできません。")
    sys.exit(1)

def run_test():
    try:
        print("1. 電子ペーパーを初期化中... (Busyピン待ちが発生します)")
        epd = epd7in5_V2.EPD()
        epd.init()
        
        print("2. テスト画像を生成中...")
        width, height = 800, 480
        image = Image.new('L', (width, height), 255) # 255: 白
        draw = ImageDraw.Draw(image)

        # 画面の四隅のズレを確認するための太い枠線 (10px)
        draw.rectangle((0, 0, width-1, height-1), outline=0, width=10)

        # 中央に成功メッセージを描画
        # フォントがない場合はデフォルトを使用
        try:
            # ラズパイの標準的なフォントパス
            font_path = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
            font_large = ImageFont.truetype(font_path, 80)
            font_small = ImageFont.truetype(font_path, 40)
        except:
            print("Warning: 指定フォントが見つからないため、デフォルトを使用します")
            font_large = ImageFont.load_default()
            font_small = ImageFont.load_default()

        draw.text((120, 160), "HARDWARE OK!", font=font_large, fill=0)
        draw.text((200, 280), "Ready for Dashboard", font=font_small, fill=0)

        print("3. 電子ペーパーへ転送中... (画面が数回反転します)")
        epd.display(epd.getbuffer(image))

        print("4. 完了。パネル保護のためスリープに移行します。")
        epd.sleep()
        
        print("\n=== 点灯式成功！ ===")
        print("この画面が正しく映れば、本番の dashboard.py を動かす準備は完了です。")

    except IOError as e:
        print(f"\n通信エラー: {e}")
        print("配線が緩んでいないか、SPIが有効か再確認してください。")
    except KeyboardInterrupt:
        print("\n中断されました。")
        epd7in5_V2.epdconfig.module_exit()

if __name__ == "__main__":
    run_test()