import json
import os
from llama_cpp import Llama

# 設定
MODEL_PATH = "local_llm/models/gemma-3-4b-it-Q4_K_M.gguf"
DATA_PATH = "data/high_concentration_archive.json"
COUNT = 20  # 解析する件数

def load_data(path, count):
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    # x_tweets から直近のものを取得
    tweets = data.get('x_tweets', [])[:count]
    return tweets

def format_prompt(tweets):
    context = ""
    for i, t in enumerate(tweets):
        # 改行コードのエスケープを確実に
        text = t['t'].replace('\n', ' ')
        context += f"{i+1}. [{t['d']}] {text}\n"
    
    prompt = "<start_of_turn>user\n"
    prompt += "あなたは優秀なパーソナルアシスタントです。以下の短いログ（ツイート）を読み、この人物の現在の「興味・関心」を上位3つ挙げてください。また、健康状態や生活習慣について何か懸念があれば、簡潔に教えてください。\n\n"
    prompt += "### ログデータ:\n"
    prompt += context
    prompt += "\n### 解析結果:\n<end_of_turn>\n<start_of_turn>model\n"
    return prompt

def main():
    print(f"[*] Loading data: {DATA_PATH} (Count: {COUNT})")
    tweets = load_data(DATA_PATH, COUNT)
    
    if not os.path.exists(MODEL_PATH):
        print(f"[!] Model not found: {MODEL_PATH}")
        return

    print(f"[*] Loading Model: {MODEL_PATH} (Gemma 3 4B-IT)")
    # Raspberry Pi 5 向け設定: CPUスレッド数を3に制限、メモリ節約
    llm = Llama(
        model_path=MODEL_PATH,
        n_ctx=4096,
        n_threads=3,
        verbose=True
    )

    prompt = format_prompt(tweets)
    print("[*] Generating analysis...")
    
    response = llm(
        prompt,
        max_tokens=512,
        temperature=0.7,
        top_p=0.9,
        stop=["<end_of_turn>"]
    )

    result = response['choices'][0]['text']
    print("\n" + "="*50)
    print("【Gemma 3 4B-IT 解析結果】")
    print("="*50)
    print(result.strip())
    print("="*50)

if __name__ == "__main__":
    main()
