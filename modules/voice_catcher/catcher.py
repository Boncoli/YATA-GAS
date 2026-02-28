import os
import sys
import time
import threading
import queue
import subprocess
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

# 設定
MODEL_SIZE = "base" # ラズパイでの速度重視（"base"にすると精度アップ）
# スレッドごとに別々のファイル名を使うためのベース
TEMP_WAV_BASE = "/dev/shm/mutter_temp" 

# --- テストモード設定 ---
# True の場合、文字起こし結果を画面に表示するだけで、Gemini API (Node.js) は呼び出しません。
TEST_MODE = False

print("Loading local Whisper model...")
model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")
r = sr.Recognizer()
r.pause_threshold = 1.0 
r.dynamic_energy_threshold = True

# 音声データを積むキュー
audio_queue = queue.Queue()

# --- ワーカー・スレッド（文字起こし＆AI解析をバックグラウンドで処理する） ---
def process_audio():
    # スレッドごとの連番（複数同時処理時のファイル名衝突を避ける）
    thread_id = threading.get_ident()
    temp_wav = f"{TEMP_WAV_BASE}_{thread_id}.wav"

    while True:
        audio = audio_queue.get()
        if audio is None: break # 終了シグナル

        try:
            # print("\n[Worker] 録音データを処理中...")
            with open(temp_wav, "wb") as f:
                f.write(audio.get_wav_data())
            
            start_time = time.time()
            segments, info = model.transcribe(temp_wav, beam_size=5, language="ja")
            text = "".join([segment.text for segment in segments]).strip()
            elapsed_time = time.time() - start_time
            
            # --- フィルター処理 ---
            ignore_words = ["あ", "う", "え", "お", "ん", "あっ", "うっ", "えっ", "おっ", "うん", "はい", "いいえ", "ふふ", "へえ"]
            hallucinations = [
                "ご視聴ありがとうございました", "ご視聴いただきありがとうございました", 
                "チャンネル登録", "高評価", "お疲れ様でした", "字幕", "ありがとうございました"
            ]
            is_hallucination = any(h in text for h in hallucinations)
            
            if not text:
                pass
            elif is_hallucination:
                print(f"※ 幻聴スキップ: 「{text}」")
            elif len(text) <= 2 and text in ignore_words:
                print(f"※ 短音スキップ: 「{text}」")
            elif len(text.replace(" ", "").replace("　", "")) < 2:
                 print(f"※ 1文字スキップ: 「{text}」")
            else:
                print(f"✨ 認識結果: 「{text}」 ({elapsed_time:.2f}秒)")
                
                if not TEST_MODE:
                    print(f"🔄 Node.jsへ送信中: 「{text[:10]}...」")
                    try:
                        node_cmd = ["node", "tasks/process-mutter.js", text]
                        subprocess.run(node_cmd, cwd="/home/boncoli/yata-local", check=True, capture_output=True, text=True)
                        print("✅ AI解析＆DB保存完了")
                    except Exception as e:
                        print(f"❌ Node.js送信エラー: {e}")

        except Exception as e:
            print(f"Worker Error: {e}")
        finally:
            if os.path.exists(temp_wav):
                os.remove(temp_wav)
            audio_queue.task_done()

# ワーカー・スレッドを起動 (1スレッドで順次処理)
worker = threading.Thread(target=process_audio, daemon=True)
worker.start()

# --- コールバック関数（音声が拾えるたびに呼ばれる） ---
def callback(recognizer, audio):
    # 録音完了したらすぐにキューに投げる。メインスレッドはブロックしない。
    audio_queue.put(audio)

# マイクの感度調整
with sr.Microphone() as source:
    print("マイクの環境音を調整しています（2秒お待ち下さい）...")
    r.adjust_for_ambient_noise(source, duration=2)
    r.energy_threshold = r.energy_threshold * 0.8
    print(f"環境音の基準値（感度）が設定されました: {r.energy_threshold:.2f}")

print("==================================================")
print("🎙️ 独り言キャッチャー [マルチスレッド版] 起動完了")
print("   (録音しながらバックグラウンドで解析します)")
print("==================================================")

# バックグラウンドで常時リッスン開始
stop_listening = r.listen_in_background(sr.Microphone(), callback, phrase_time_limit=15)

try:
    while True:
        time.sleep(0.1) # メインスレッドはただ生き続けるだけ
except KeyboardInterrupt:
    print("\n停止シグナルを受信しました。")
    stop_listening(wait_for_stop=False) # リッスン停止
    print("残りのキューを処理しています...")
    audio_queue.join() # キューが空になるまで待つ
    print("終了しました。")
