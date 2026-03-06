import sys
import os
import json
import sqlite3
import subprocess
import requests
from dotenv import load_dotenv
from llama_cpp import Llama

# --- 設定 ---
load_dotenv(os.path.expanduser("~/yata-local/.env"))
# DB_PATHは環境変数があればそれを優先、なければRAMディスク
DB_PATH = os.environ.get("DB_PATH", "/dev/shm/yata.db")
MODEL_PATH = os.path.expanduser("~/yata-local/local_llm/models/gemma-3-4b-it-Q4_K_M.gguf")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")

def check_cpu_temp():
    try:
        temp_str = subprocess.check_output(['vcgencmd', 'measure_temp']).decode('utf-8')
        return float(temp_str.replace('temp=', '').replace('\'C\n', ''))
    except:
        return 0.0

def call_gemini_api(raw_text):
    if not GEMINI_API_KEY:
        raise Exception("GEMINI_API_KEY not found")
    
    # 2.5-flash-lite を優先使用 (1日1000回制限)
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key={GEMINI_API_KEY}"
    
    prompt = f"""
以下の独り言から「感情(emotion)」「関心(interest)」「次の行動(next_action)」を推測し、JSONのみで出力せよ。
マークダウン記法(```json)は禁止。

独り言: "{raw_text}"

出力形式:
{{"emotion": "..", "interest": "..", "next_action": ".."}}
"""
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.2}
    }
    
    response = requests.post(url, json=payload, timeout=10)
    if response.status_code != 200:
        raise Exception(f"API Error: {response.status_code} {response.text}")
    
    res_data = response.json()
    res_text = res_data['candidates'][0]['content']['parts'][0]['text'].strip()
    return res_text

def call_local_llm(raw_text):
    if not os.path.exists(MODEL_PATH):
        raise Exception("Local model file not found")
    
    # 熱暴走対策
    if check_cpu_temp() > 75.0:
        raise Exception("CPU temperature too high, skipping local LLM")

    print(f"[Fallback] ローカルLLMで分析中...")
    llm = Llama(model_path=MODEL_PATH, n_ctx=1024, n_threads=3, verbose=False)
    
    prompt = f"""<start_of_turn>user
以下の独り言から「感情(emotion)」「関心(interest)」「次の行動(next_action)」を推測し、JSONのみで出力せよ。
マークダウン記法(```json)は禁止。

独り言: "{raw_text}"

出力形式:
{{"emotion": "..", "interest": "..", "next_action": ".."}}<end_of_turn>
<start_of_turn>model
"""
    response = llm(prompt, max_tokens=256, temperature=0.2)
    return response['choices'][0]['text'].strip()

def process_mutter(raw_text):
    if not raw_text:
        return

    # 挨拶や短い感嘆詞は分析スキップ
    skip_words = ["おはよう", "おやすみ", "はい", "うん", "あー", "えーと"]
    if len(raw_text) <= 10 and any(w in raw_text for w in skip_words):
        save_to_db(raw_text, "{}")
        print("[分析スキップ] 定型文のため保存のみ行いました。")
        return

    analysis_json = "{}"
    try:
        print(f"[Gemini API] 分析中: \"{raw_text}\"")
        res_text = call_gemini_api(raw_text)
        # クリーンアップ
        res_text = res_text.replace("```json", "").replace("```", "").strip()
        json.loads(res_text) # バリデーション
        analysis_json = res_text
        print("✅ Gemini API分析完了")
    
    except Exception as e:
        print(f"⚠️ Gemini API失敗: {e}")
        try:
            res_text = call_local_llm(raw_text)
            res_text = res_text.replace("```json", "").replace("```", "").strip()
            json.loads(res_text)
            analysis_json = res_text
            print("✅ ローカルLLMでリカバリー完了")
        except Exception as e2:
            print(f"❌ ローカルLLMも失敗: {e2}")
            analysis_json = json.dumps({"error": "All analysis failed"})

    save_to_db(raw_text, analysis_json)

def save_to_db(raw_text, analysis_json):
    try:
        conn = sqlite3.connect(DB_PATH)
        cur = conn.cursor()
        cur.execute("INSERT INTO mutter_logs (raw_text, analysis_json) VALUES (?, ?)", (raw_text, analysis_json))
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"DB保存エラー: {e}")

if __name__ == "__main__":
    if len(sys.argv) > 1:
        process_mutter(sys.argv[1])
    else:
        print("Error: No text provided.")
