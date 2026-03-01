
import json
import os
import sys
import datetime
from llama_cpp import Llama

# 設定 (4Bモデルを使用)
MODEL_PATH = "local_llm/models/gemma-3-4b-it-Q4_K_M.gguf"
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
    NL = chr(10)
    for i, t in enumerate(tweets):
        text = t.get('t', '').replace(NL, ' ')
        context = context + str(i+1) + ". [" + t.get('d', '') + "] " + text + NL
    
    prompt = "<start_of_turn>user" + NL
    prompt += "あなたは世界最高峰の行動心理学者兼プロファイラーです。以下の100件のログ（ツイート）を精査し、この人物の「多面的な人格像」を深く分析してください。" + NL + NL
    prompt += "以下の項目について、具体的な発言内容を引用しながら洞察してください：" + NL
    prompt += "1. 精神的・身体的コンディションと、その変動の傾向（例：低気圧や気圧の変化への言及など）" + NL
    prompt += "2. 隠れたストレス要因、あるいは逆に「心の支え」になっているもの（特定の趣味、食事、嗜好品など）" + NL
    prompt += "3. 最近のポジティブな変化、または新しく芽生えつつある興味・関心" + NL
    prompt += "4. この人物への「今日のアドバイス」を一言" + NL + NL
    prompt += "### ログデータ：" + NL
    prompt += context
    prompt += NL + "### 深層解析結果：" + NL + "<end_of_turn>" + NL + "<start_of_turn>model" + NL
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

    print("[*] Initializing Gemma 3 4B-IT (Deep Analysis Mode)...")
    # Swapがあるので、コンテキストを7168トークンに設定
    llm = Llama(
        model_path=MODEL_PATH,
        n_ctx=7168,
        n_threads=3,
        verbose=False
    )

    prompt = format_prompt(tweets)
    print("[*] Deep Analyzing 100 logs... (Processing approx. 6,000 tokens, this will take 5-10 min)")
    
    response = llm(
        prompt,
        max_tokens=1024,
        temperature=0.7,
        top_p=0.9,
        stop=["<end_of_turn>"]
    )

    result = response['choices'][0]['text']
    line = "=" * 50
    print(NL + line)
    print("【Gemma 3 4B-IT : 100件ログ深層解析結果】")
    print(line)
    print(result.strip())
    print(line)

if __name__ == "__main__":
    main()
