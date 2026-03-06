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

# キーボードの打鍵音などの瞬間的なノイズを無視するため、
# 少し長く（2.5秒）声が途切れるまでを一つの発話とみなす（ぶつ切り防止）
r.pause_threshold = 2.5 
# 環境音の自動追従をオフにし、固定のしきい値を使用する
r.dynamic_energy_threshold = False
# 音量がしきい値を超えても、それが0.3秒以上継続しなければ「声」とみなさず無視する（キーボード強打対策）
r.non_speaking_duration = 0.3

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
            # タイピング音などで空振りした場合に生成されやすいノイズ
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
                 print(f"※ 1文字スキップ(打鍵音等の可能性): 「{text}」")
            else:
                print(f"✨ 認識結果: 「{text}」 ({elapsed_time:.2f}秒)")
                
                if not TEST_MODE:
                    print(f"🔄 ローカルLLMへ送信中: 「{text[:10]}...」")
                    try:
                        # ローカルLLM版のPythonスクリプトを呼び出す
                        python_cmd = ["/home/boncoli/yata-local/local_llm/.venv/bin/python3", "tasks/process-mutter-local.py", text]
                        subprocess.run(python_cmd, cwd="/home/boncoli/yata-local", check=True, capture_output=True, text=True)
                        print("✅ ローカルAI解析＆DB保存完了")
                    except Exception as e:
                        print(f"❌ ローカルLLM送信エラー: {e}")
                else:
                    print("🛠️ テストモード: LLM送信をスキップしました")

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

# マイクの感度設定
# 起動時の自動調整は行わず、メーターで計測した固定のしきい値を使用する
# 300(無音) 〜 600(キーボード) 〜 1000(小声/強打) という環境のため、800で固定
r.energy_threshold = 800
print(f"環境音の固定基準値（感度）が設定されました: {r.energy_threshold}")

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
