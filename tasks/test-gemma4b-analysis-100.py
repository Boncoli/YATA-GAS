import json
import os
import sys
import datetime
from llama_cpp import Llama

# 設定
MODEL_PATH = "local_llm/models/gemma-3-4b-it-Q4_K_M.gguf"
DATA_PATH = "data/high_concentration_archive.json"
OUTPUT_PATH = "logs/gemma4b_analysis_100.txt"
COUNT = 100

def load_data(path, count):
    if not os.path.exists(path):
        return []
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    tweets = data.get('x_tweets', [])[:count]
    return tweets

def format_prompt(tweets):
    context = ""
    # \n の代わりに chr(10) を使用して、書き込み時の破損を防ぐ
    NL = chr(10)
    for i, t in enumerate(tweets):
        text = t.get('t', '').replace(NL, ' ')
        context = context + str(i+1) + ". [" + t.get('d', '') + "] " + text + NL
    
    prompt = "<start_of_turn>user" + NL
    prompt += "あなたは優秀なプロファイラー兼パーソナルアシスタントです。以下の100件のログ（ツイート）を深く読み込み、この人物の「多面的な人物像」を分析してください。" + NL + NL
    prompt += "以下の項目について、具体的なエピソードを交えて考察してください：" + NL
    prompt += "1. 現在の精神的・身体的なコンディションと、その変動の傾向" + NL
    prompt += "2. 隠れたストレス要因、あるいは逆に「心の支え」になっているもの" + NL
    prompt += "3. 最近のポジティブな変化、または新しく芽生えつつある興味" + NL
    prompt += "4. この人物への「今日のアドバイス」を一言" + NL + NL
    prompt += "### ログデータ：" + NL
    prompt += context
    prompt += NL + "### 深層解析結果：" + NL + "<end_of_turn>" + NL + "<start_of_turn>model" + NL
    return prompt

def main():
    print("[*] Starting Background Analysis: " + DATA_PATH)
    tweets = load_data(DATA_PATH, COUNT)
    
    if not tweets:
        print("[!] No data found.")
        return

    if not os.path.exists(MODEL_PATH):
        print("[!] Model not found: " + MODEL_PATH)
        return

    print("[*] Analyzing... Output: " + OUTPUT_PATH)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as out:
        out.write("=== Gemma 3 4B-IT Deep Analysis (n=" + str(COUNT) + ") ===\n")
        out.write("Generated at: " + datetime.datetime.now().isoformat() + "\n\n")
        out.flush()
        
        llm = Llama(
            model_path=MODEL_PATH,
            n_ctx=8192,
            n_threads=3,
            verbose=False
        )

        prompt = format_prompt(tweets)
        response = llm(
            prompt,
            max_tokens=1024,
            temperature=0.7,
            top_p=0.9,
            stop=["<end_of_turn>"]
        )

        result = response['choices'][0]['text']
        out.write(result.strip())
        out.write("\n\n=== End of Analysis ===\n")
        out.flush()

    print("[*] Analysis complete.")

if __name__ == "__main__":
    main()
