import os
import sys
from ctypes import *

# --- 邪魔なALSAエラー出力を捨てるおまじない ---
ERROR_HANDLER_FUNC = CFUNCTYPE(None, c_char_p, c_int, c_char_p, c_int, c_char_p)
def py_error_handler(filename, line, function, err, fmt):
    pass
c_error_handler = ERROR_HANDLER_FUNC(py_error_handler)
try:
    asound = cdll.LoadLibrary('libasound.so.2')
    asound.snd_lib_error_set_handler(c_error_handler)
except OSError:
    pass

import speech_recognition as sr
from faster_whisper import WhisperModel
import time

# 設定
MODEL_SIZE = "tiny" # ラズパイでの速度重視（"base"にすると精度アップ）
TEMP_WAV = "/dev/shm/mutter_temp.wav" # RAMディスク上で処理

print("Loading local Whisper model...")
# CPUで軽量に動かす設定
model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
r = sr.Recognizer()

# マイクの感度調整
with sr.Microphone() as source:
    print("マイクの環境音を調整しています（数秒お待ち下さい）...")
    r.adjust_for_ambient_noise(source, duration=2)
    print(f"環境音の基準値が設定されました: {r.energy_threshold}")

print("==================================================")
print("🎙️ 独り言キャッチャー 起動完了")
print("==================================================")

while True:
    try:
        with sr.Microphone() as source:
            print("\n[待機中] 声を検知するまで待機しています...")
            # 声がするまで待機、話し終わったら自動で録音終了
            # phrase_time_limit で最大録音時間を制限可能（例: 10秒）
            audio = r.listen(source, timeout=None, phrase_time_limit=15)
            
            print("[録音完了] 音声をRAMに保存しています...")
            with open(TEMP_WAV, "wb") as f:
                f.write(audio.get_wav_data())
            
            print("[文字起こし中] Whisperで解析中...")
            start_time = time.time()
            segments, info = model.transcribe(TEMP_WAV, beam_size=5, language="ja")
            
            text = "".join([segment.text for segment in segments]).strip()
            elapsed_time = time.time() - start_time
            
            # --- ノイズ・短い音の足切りフィルター ---
            # カナや記号だけの短い文字列や、明らかに独り言ではない単発の音を弾く
            ignore_words = ["あ", "う", "え", "お", "ん", "あっ", "うっ", "えっ", "おっ", "うん", "はい", "いいえ", "ふふ", "へえ"]
            
            if not text:
                print("※ 有効な音声が検出されませんでした")
            elif len(text) <= 2 and text in ignore_words:
                print(f"※ ノイズまたは短すぎる音声のためスキップ: 「{text}」")
            elif len(text.replace(" ", "").replace("　", "")) < 2:
                 print(f"※ 1文字以下のためスキップ: 「{text}」")
            else:
                print(f"✨ 認識結果: 「{text}」 (処理時間: {elapsed_time:.2f}秒)")
                print("🔄 Node.jsに解析とDB保存を要求しています...")
                # Node.jsプロセスを呼び出して、RAM上のDBにアクセスさせる
                import subprocess
                try:
                    # 確実に yata-local ディレクトリから実行するようパスを指定し、標準出力を表示する
                    node_cmd = ["node", "tasks/process-mutter.js", text]
                    # cwd を指定して .env を確実に読み込ませる
                    result = subprocess.run(node_cmd, cwd="/home/boncoli/yata-local", check=True, capture_output=True, text=True)
                    print(result.stdout.strip())
                except subprocess.CalledProcessError as e:
                    print(f"Node.jsの呼び出しに失敗しました:\n標準出力: {e.stdout}\nエラー出力: {e.stderr}")
                except Exception as e:
                    print(f"予期せぬエラー: {e}")
            
            # 処理が終わったら即座にRAMから削除
            if os.path.exists(TEMP_WAV):
                os.remove(TEMP_WAV)

    except sr.WaitTimeoutError:
        pass
    except KeyboardInterrupt:
        print("\n停止します。")
        break
    except Exception as e:
        print(f"エラーが発生しました: {e}")
        time.sleep(1)
