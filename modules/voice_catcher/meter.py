import speech_recognition as sr
import time
import os
import sys
from ctypes import *

# --- ALSAエラーのミュート ---
ERROR_HANDLER_FUNC = CFUNCTYPE(None, c_char_p, c_int, c_char_p, c_int, c_char_p)
def py_error_handler(filename, line, function, err, fmt): pass
c_error_handler = ERROR_HANDLER_FUNC(py_error_handler)
try:
    asound = cdll.LoadLibrary('libasound.so.2')
    asound.snd_lib_error_set_handler(c_error_handler)
except OSError: pass

import audioop

print("🎤 マイクのリアルタイム音量メーターを起動します...")
print("※ キーボードを叩いたり、声を出したりして数値を観察してください。")
print("※ Ctrl+C で終了します。\n")

r = sr.Recognizer()

try:
    with sr.Microphone() as source:
        # source.stream.read で生データを取得し、audioop.rms で音量(エネルギー)を計算する
        while True:
            buffer = source.stream.read(source.CHUNK)
            if len(buffer) == 0: continue

            # 音のエネルギー(RMS: Root Mean Square)を計算。これが r.energy_threshold の基準値と同じ概念です
            energy = audioop.rms(buffer, source.SAMPLE_WIDTH)

            # メーターの長さを計算
            meter_length = min(int(energy / 100), 50) # 100単位で1文字、最大50文字
            meter = "█" * meter_length

            # 同じ行を上書きして表示
            sys.stdout.write(f"\r音量: {energy:5d} | {meter:<50}")
            sys.stdout.flush()

except KeyboardInterrupt:
    print("\n\n終了しました。")