import json
import os
import sys
import datetime
from llama_cpp import Llama

# 設定 (1Bモデルを使用)
MODEL_PATH = "local_llm/models/gemma-3-1b-it-Q4_K_M.gguf"
DATA_PATH = "data/high_concentration_archive.json"
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
    # \n の代わりに chr(10) を使用
    NL = chr(10)
    for i, t in enumerate(tweets):
        text = t.get('t', '').replace(NL, ' ')
        context = context + str(i+1) + ". [" + t.get('d', '') + "] " + text + NL
    
    prompt = "<start_of_turn>user" + NL
    prompt += "あなたは優秀なパーソナルアシスタントです。以下の100件のログ（ツイート）を読み、この人物の現在の状況を分析してください。" + NL + NL
    prompt += "以下の3点について、簡潔にまとめてください：" + NL
    prompt += "1. 現在の主な関心事（上位3つ）" + NL
    prompt += "2. 健康状態やメンタル面での傾向（懸念点があれば指摘）" + NL
    prompt += "3. 最近のポジティブなトピックや変化" + NL + NL
    prompt += "### ログデータ：" + NL
    prompt += context
    prompt += NL + "### 解析結果：" + NL + "<end_of_turn>" + NL + "<start_of_turn>model" + NL
    return prompt

def main():
    NL = chr(10)
    print("[*] Loading 100 logs from: " + DATA_PATH)
    tweets = load_data(DATA_PATH, COUNT)
    
    if not tweets:
        print("[!] No data found.")
        return

    if not os.path.exists(MODEL_PATH):
        print("[!] Model not found: " + MODEL_PATH)
        return

    print("[*] Initializing Gemma 3 1B-IT (Lightweight Mode)...")
    llm = Llama(
        model_path=MODEL_PATH,
        n_ctx=8192,
        n_threads=3,
        verbose=False
    )

    prompt = format_prompt(tweets)
    print("[*] Analyzing 100 logs... (Please wait a moment)")
    
    response = llm(
        prompt,
        max_tokens=800,
        temperature=0.7,
        top_p=0.9,
        stop=["<end_of_turn>"]
    )

    result = response['choices'][0]['text']
    line = "=" * 50
    print(NL + line)
    print("【Gemma 3 1B-IT : 100件ログ解析結果】")
    print(line)
    print(result.strip())
    print(line)

if __name__ == "__main__":
    main()
