from llama_cpp import Llama
import time
import os
import sys

# --- SD Card Protection: Disable bytecode (.pyc) creation ---
sys.dont_write_bytecode = True
# -----------------------------------------------------------

# Model path
model_name = sys.argv[1] if len(sys.argv) > 1 else "gemma-3-1b-it-Q4_K_M.gguf"
model_path = f"./local_llm/models/{model_name}"

if not os.path.exists(model_path):
    print(f"Error: Model not found at {model_path}")
    exit(1)

print(f"\n--- Benchmark: {model_name} ---")
print(f"Loading model into RAM...")
start_time = time.time()
# Use 3 threads to keep 1 core free
llm = Llama(
    model_path=model_path,
    n_ctx=2048,
    n_threads=3,
    verbose=False
)
load_time = time.time() - start_time
print(f"Model loaded in {load_time:.2f} seconds.")

# Test prompt (Short summary task)
prompt = "ユーザー：次の文章を短く要約してください。『ラズベリーパイ5は、前世代のラズパイ4に比べてCPU性能が2倍以上向上し、グラフィックス性能も大幅に強化されました。また、PCI Express 2.0インターフェースを搭載したことで、高速なNVMe SSDの接続も可能になっています。』\nシステム："

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
print(f"\n\n--- Results ---")
print(f"Load Time: {load_time:.2f}s")
print(f"Generation Time: {generation_time:.2f}s")
print(f"Tokens Generated: {token_count}")
print(f"Speed: {token_count / generation_time:.2f} tokens/second")
