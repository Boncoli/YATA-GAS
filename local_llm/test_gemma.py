from llama_cpp import Llama
import time
import os
import sys

# --- SD Card Protection: Disable bytecode (.pyc) creation ---
sys.dont_write_bytecode = True
# -----------------------------------------------------------

# Model path
default_model = "gemma-3-1b-it-Q4_K_M.gguf"
model_name = sys.argv[1] if len(sys.argv) > 1 else default_model
model_path = f"./local_llm/models/{model_name}"

if not os.path.exists(model_path):
    print(f"Error: Model not found at {model_path}")
    exit(1)

print(f"\n--- Testing Model: {model_name} ---")
print("Loading model (Local)...")
start_time = time.time()
# Raspberry Pi 5 has 4 cores. n_threads=3 is optimal to keep 1 core free for system tasks.
llm = Llama(
    model_path=model_path,
    n_ctx=2048,
    n_threads=3,
    verbose=False
)
print(f"Model loaded in {time.time() - start_time:.2f} seconds.")

# Test prompt
prompt = "ユーザー：ラズベリーパイ5でローカルLLMを動かすことの利点を3つ教えてください。\nシステム："

print(f"\nPrompt: {prompt}")
print("Generating response (Streaming)...")

start_time = time.time()
output = llm(
    prompt,
    max_tokens=256,
    stop=["ユーザー：", "\n"],
    echo=False,
    stream=True
)

full_response = ""
token_count = 0

for chunk in output:
    text = chunk['choices'][0]['text']
    print(text, end='', flush=True)
    full_response += text
    token_count += 1

generation_time = time.time() - start_time
print(f"\n\n---")
print(f"Time taken: {generation_time:.2f} seconds")
print(f"Tokens generated: {token_count}")
print(f"Speed: {token_count / generation_time:.2f} tokens/second")
