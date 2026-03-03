import os
import sqlite3
import json
import requests
from datetime import datetime
from llama_cpp import Llama
from dotenv import load_dotenv

# .env から環境変数をロード
load_dotenv(os.path.expanduser("~/yata-local/.env"))

# --- 設定 ---
MODEL_PATH = os.path.expanduser("~/yata-local/local_llm/models/gemma-3-4b-it-Q4_K_M.gguf")
DB_PATH = "/dev/shm/yata.db"
PERSONA_PATH = os.path.expanduser("~/yata-local/data/digital_twin_analysis/synthesized_master_persona.md")
# Discord設定
DISCORD_BOT_TOKEN = os.getenv("DISCORD_BOT_TOKEN")
MUTTER_CHANNEL_ID = "1476471757601767475" # 以前確認した ai-mutter チャンネル

def post_to_discord(content):
    if not DISCORD_BOT_TOKEN:
        print("Skip Discord: No token found.")
        return
    
    url = f"https://discord.com/api/v10/channels/{MUTTER_CHANNEL_ID}/messages"
    headers = {
        "Authorization": f"Bot {DISCORD_BOT_TOKEN}",
        "Content-Type": "application/json"
    }
    payload = {"content": content}
    
    try:
        res = requests.post(url, headers=headers, json=payload)
        if res.status_code == 200:
            print("✅ Successfully posted to Discord.")
        else:
            print(f"❌ Discord Post Failed: {res.status_code} {res.text}")
    except Exception as e:
        print(f"❌ Discord Post Error: {e}")

def get_context():
    try:
        conn = sqlite3.connect(DB_PATH)
        cur = conn.cursor()
        
        # 1. 直近24時間以内の記事からランダムに3件選ぶ（重複を避け、バリエーションを出す）
        cur.execute("""
            SELECT title FROM collect 
            WHERE date > datetime('now', '-24 hours') 
            ORDER BY RANDOM() LIMIT 3
        """)
        news = [row[0] for row in cur.fetchall()]
        
        # もし直近24時間に記事がない場合は、最新の3件をフォールバックとして取得
        if not news:
            cur.execute("SELECT title FROM collect ORDER BY date DESC LIMIT 3")
            news = [row[0] for row in cur.fetchall()]
        
        # 2. 最新の行動ログ
        cur.execute("SELECT action, address, note FROM drive_logs ORDER BY id DESC LIMIT 1")
        move = cur.fetchone()
        
        conn.close()
        
        news_list = "\n- ".join(news)
        context_str = f"【最近のニューストピック（ランダム抽出）】\n- {news_list}"
        if move:
            context_str += f"\n\n【旦那様（BON様）の現在の動静】\nステータス: {move[0]} / 場所: {move[1] or '不明'} / 備考: {move[2] or 'なし'}"
        return context_str
    except Exception as e:
        print(f"Context Error: {e}")
        return "コンテキストの取得に失敗しました。"

def main():
    if not os.path.exists(MODEL_PATH):
        print(f"Error: Model not found at {MODEL_PATH}")
        return

    # ペルソナ読み込み
    with open(PERSONA_PATH, "r", encoding="utf-8") as f:
        persona = f.read()

    context = get_context()
    
    # プロンプトの組み立て（極限まで削ぎ落とし、視点に集中させる）
    system_prompt = f"""
    あなたは以下の『BON様』という人物の思考回路をシミュレートするAIです。

    【BON様の思考フィルター】
    - 合理主義・実証主義（数字と事実しか信じない）
    - 皮肉屋だがユーモアを忘れない
    - PC/自動車/最新技術への偏執的なこだわり（ただし、文脈がない限り単語を出すのは禁止）
    - 関西弁が混じる独特の語り口

    【今の状況】
    {context}

    【命令】
    - 上記の『今の状況（ニュースや動静）』を見て、BON様が心の中でボソッと呟きそうな『本音』を1〜2文で生成してください。
    - 7800X3D、CX-80、二郎などのキーワードは、文脈上どうしても必要な場合を除き、**絶対に出さないでください**。
    - 「〜しましょうか？」というメイド口調は廃止し、独り言としての「〜やな」「〜か？」「〜だわ」という口調に徹してください。
    """

    print(f"[*] Loading Model with 3 threads (keeping 1 core free for system)...")
    llm = Llama(model_path=MODEL_PATH, n_ctx=2048, n_threads=3, verbose=False)

    print("[*] Generating natural mutter (Gemma 3 4B)...")
    response = llm.create_chat_completion(
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": "今のニュースや自分の状況について、思うところを独り言でボソッと言って。"}
        ],
        max_tokens=150,
        temperature=0.7, # 安定性を高めるために少し下げる
        top_p=0.9
    )
    
    thought = response["choices"][0]["message"]["content"].strip()
    thought = thought.strip('"').strip("'")

    print(f"\n--- 生成された独り言 ---\n{thought}\n------------------------\n")

    # DB保存 (ai_chat_log)
    try:
        conn = sqlite3.connect(DB_PATH)
        cur = conn.cursor()
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        cur.execute("INSERT INTO ai_chat_log (role, content, timestamp) VALUES (?, ?, ?)", 
                    ('ai', thought, now_str))
        conn.commit()
        conn.close()
        print(f"✅ DB (ai_chat_log) に保存しました。")
        
        # Discordへの投稿
        post_to_discord(thought)
        
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    main()
