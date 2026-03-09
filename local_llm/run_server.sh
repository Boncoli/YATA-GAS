#!/bin/bash
# local_llm/run_server.sh
# Gemma 3 4B ローカルAIサーバー (OpenAI互換)
# Raspberry Pi 5 (8GB) 用、SDカード保護モード

export PYTHONDONTWRITEBYTECODE=1
cd "$(dirname "$0")/.."

# Python仮想環境のパス
PYTHON_BIN="./local_llm/.venv/bin/python3"
MODEL_PATH="./local_llm/models/gemma-3-4b-it-Q4_K_M.gguf"

# サーバーの起動 (n_threads=3, n_ctx=4096)
# nice -n 15 で優先度を下げ、taskset -c 0-2 で1コアをシステム用に完全開放する
exec nice -n 15 taskset -c 0-2 $PYTHON_BIN -m llama_cpp.server \
    --model $MODEL_PATH \
    --n_threads 3 \
    --n_ctx 4096 \
    --host 0.0.0.0 \
    --port 8000
