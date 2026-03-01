import json
import os
import time
import datetime
from llama_cpp import Llama

# 設定 (ダラダラ分析用)
MODEL_PATH = "local_llm/models/gemma-3-4b-it-Q4_K_M.gguf"
DATA_PATH = "data/high_concentration_archive.json"
STATE_FILE = "logs/analysis_state.json"
OUTPUT_FILE = "logs/deep_profile_journal.md"

CHUNK_SIZE = 100       # 一度に分析するツイート数 (約6000トークン)
COOLDOWN_SEC = 180     # チャンク間の休憩時間 (3分: 熱対策)
MAX_CHUNKS = 1      # 1回の実行での最大チャンク数

def load_state():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE, "r") as f:
            return json.load(f).get("last_index", 0)
    return 0

def save_state(index):
    with open(STATE_FILE, "w") as f:
        json.dump({"last_index": index}, f)

def get_tweets_chunk(start_idx, size):
    if not os.path.exists(DATA_PATH):
        print(f"[!] Data file not found: {DATA_PATH}")
        return []
    
    with open(DATA_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    
    tweets = data.get("x_tweets", [])
    if start_idx >= len(tweets):
        return [] # 最後まで到達
    
    return tweets[start_idx : start_idx + size]

def format_prompt(tweets, start_idx, end_idx):
    context = ""
    for i, t in enumerate(tweets):
        # 改行文字は安全に置換する
        text = str(t.get('t', '')).replace(chr(10), ' ')
        context += f"{start_idx + i + 1}. [{t.get('d', '')}] {text}" + chr(10)
    
    prompt = "<start_of_turn>user" + chr(10)
    prompt += f"あなたは有能なプロファイラーです。対象人物の過去のログ（{start_idx + 1}件目〜{end_idx}件目）を読み込み、当時の『精神状態』『関心事の変遷』『日常のストレスと癒やし』を深く分析してください。" + chr(10) + chr(10)
    prompt += "以下の項目について、具体的なエピソードを引用しながら論理的に考察してください：" + chr(10)
    prompt += "1. この期間の主な出来事と精神的な起伏の傾向" + chr(10)
    prompt += "2. 無意識に求めている「癒やし」や「心の支え」" + chr(10)
    prompt += "3. プロファイラーとしての客観的な所見" + chr(10) + chr(10)
    prompt += "### ログデータ：" + chr(10)
    prompt += context
    prompt += chr(10) + "### 分析レポート：" + chr(10) + "<end_of_turn>" + chr(10) + "<start_of_turn>model" + chr(10)
    return prompt

def main():
    print("[*] Starting Background Lazy Analysis (ダラダラ分析)...")
    
    if not os.path.exists(MODEL_PATH):
        print(f"[!] Model not found: {MODEL_PATH}")
        return

    print("[*] Loading Model (Gemma 3 4B)...")
    llm = Llama(
        model_path=MODEL_PATH,
        n_ctx=8192,
        n_threads=3,
        verbose=False
    )
    
    current_idx = load_state()
    print(f"[*] Resuming from index: {current_idx}")
    
    chunks_processed = 0

    while chunks_processed < MAX_CHUNKS:
        tweets = get_tweets_chunk(current_idx, CHUNK_SIZE)
        
        if not tweets:
            print("[*] All tweets have been analyzed. Job finished.")
            break
            
        end_idx = current_idx + len(tweets)
        print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] Processing chunk {chunks_processed + 1}: index {current_idx} to {end_idx - 1}")
        
        prompt = format_prompt(tweets, current_idx, end_idx - 1)
        
        response = llm(
            prompt,
            max_tokens=1024,
            temperature=0.7,
            top_p=0.9,
            stop=["<end_of_turn>"]
        )
        
        result_text = response['choices'][0]['text'].strip()
        
        with open(OUTPUT_FILE, "a", encoding="utf-8") as f:
            f.write(f"## 📝 分析レポート ({current_idx + 1}件目 〜 {end_idx}件目)\n")
            f.write(f"*分析日時: {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}*\n\n")
            f.write(result_text)
            f.write("\n\n---\n\n")
        
        current_idx = end_idx
        save_state(current_idx)
        chunks_processed += 1
        
        print(f"[*] Chunk complete. Cooling down for {COOLDOWN_SEC} seconds...")
        time.sleep(COOLDOWN_SEC)

    print("[*] Run finished. Will resume next time.")

if __name__ == "__main__":
    main()
