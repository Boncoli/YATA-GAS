#!/bin/bash

# YATA Local LLM Runner (SD Card Protection Mode)
# このスクリプトは、SDカードへの書き込みを最小限に抑えつつローカルLLMを実行します。

# 1. Pythonのバイトコード (.pyc) 書き込みを禁止
export PYTHONDONTWRITEBYTECODE=1

# 2. プロジェクトルートへ移動
cd "$(dirname "$0")/.." || exit

# 3. 仮想環境のパス
VENV_PATH="./local_llm/.venv/bin/python3"

if [ ! -f "$VENV_PATH" ]; then
    echo "Error: Virtual environment not found at $VENV_PATH"
    exit 1
fi

# 4. 実行引数の処理 (デフォルトは test_gemma.py)
SCRIPT_TO_RUN=${1:-"local_llm/test_gemma.py"}
shift
ARGS="$@"

echo "--- Starting Local LLM with SD Protection (nice -n 15) ---"

# 5. 低優先度 (nice -n 15) で実行
nice -n 15 "$VENV_PATH" "$SCRIPT_TO_RUN" $ARGS
