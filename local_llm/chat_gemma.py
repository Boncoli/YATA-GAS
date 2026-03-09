import sys
import os
import json
from llama_cpp import Llama

# SDカード保護: バイトコード生成を抑制
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'

def main():
    if len(sys.argv) < 3:
        print("Error: Missing arguments. Usage: python3 chat_gemma.py <model_path> <json_input>")
        return

    model_path = sys.argv[1]
    
    try:
        # 第2引数以降を結合して一つのJSONとして扱う（シェルでのエスケープ対策）
        json_str = " ".join(sys.argv[2:])
        data = json.loads(json_str)
    except Exception as e:
        print(f"Error: Invalid JSON input. {str(e)}")
        return

    system_prompt = data.get("system", "有能なアシスタントです。")
    history = data.get("messages", [])

    # モデルのロード (n_threads=3, Pi 5 向け最適化)
    # SDカード保護のため、モデル読み込み以外は極力メモリ上で行う
    try:
        llm = Llama(
            model_path=model_path,
            n_ctx=4096, # 4096まで拡大して長いシステムプロンプトと履歴に対応
            n_threads=3,
            n_gpu_layers=0,
            verbose=False
        )
    except Exception as e:
        print(f"Error: Failed to load model. {str(e)}")
        return

    # Gemma 3 Chat Template 構築
    prompt = f"<bos><start_of_turn>system\n{system_prompt}<end_of_turn>\n"
    for msg in history:
        role = "user" if msg["role"] == "user" else "model"
        content = msg["content"]
        prompt += f"<start_of_turn>{role}\n{content}<end_of_turn>\n"
    prompt += "<start_of_turn>model\n"

    # 推論実行 (温度0.7で少しの揺らぎを持たせる)
    try:
        output = llm(
            prompt,
            max_tokens=120, # 40〜60文字程度を想定
            stop=["<end_of_turn>", "<eos>", "ユーザー:", "旦那様:"],
            echo=False,
            temperature=0.7,
            top_p=0.9
        )
        response = output["choices"][0]["text"].strip()
        print(response)
    except Exception as e:
        print(f"Error: Inference failed. {str(e)}")

if __name__ == "__main__":
    main()
