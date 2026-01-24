import RPi.GPIO as GPIO
import time

# --- 設定 ---
# 紫色の線 (BUSY) は GPIO 24 (物理ピン18)
BUSY_PIN = 24
# 白色の線 (RST) は GPIO 17 (物理ピン11)
RST_PIN = 17

GPIO.setmode(GPIO.BCM)
GPIO.setup(BUSY_PIN, GPIO.IN)
GPIO.setup(RST_PIN, GPIO.OUT)

print("--- 診断開始 ---")

# 1. 現在の状態を見る
initial_state = GPIO.input(BUSY_PIN)
print(f"現在のBUSYピンの状態: {initial_state} (0ならLow, 1ならHigh)")

# 2. リセット信号を送って反応を見る
print("リセット信号を送信中...")
GPIO.output(RST_PIN, 0)
time.sleep(0.1)
GPIO.output(RST_PIN, 1)
time.sleep(0.1)

# 3. リセット後の状態を見る
after_reset = GPIO.input(BUSY_PIN)
print(f"リセット直後のBUSYピン: {after_reset}")

print("----------------")
if initial_state == after_reset:
    print("判定: 変化なし... ピンが死んでいるか、断線の可能性大")
else:
    print("判定: 反応あり！ 配線は生きています！")

GPIO.cleanup()