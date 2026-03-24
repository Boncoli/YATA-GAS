#!/bin/bash
# YATA Integrity Verifier - 物理的整合性検証スクリプト
# 実行者: Gemini CLI (自動義務)

COLOR_RED='\033[0;31m'
COLOR_GREEN='\033[0;32m'
COLOR_NC='\033[0m'

echo "🔍 [Integrity Check] 物理的整合性の検証を開始します..."

# 1. ブランチ構成チェック (main)
echo -n "  - main ブランチの最小構成チェック: "
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git checkout main > /dev/null 2>&1
FILE_COUNT=$(ls -1 | grep -vE "^(node_modules|logs|hdd.logs|yata.db|archive|data|local_llm|local_public|dashboard|modules|tasks|tests|nanobanana-output|package-lock.json|defined_funcs.txt|backup.log|core\.|credentials\.json|interests\.json|persona\.txt|server-properties.json|yata_ram\.db|yata\.db-shm|yata\.db-wal)$" | wc -l)

# 期待される 7 ファイル: lib/YATA.js, Index.html, Visualize.html, prompts.json, README.md, CHANGELOG.md, PROJECT_GUIDE.md
if [ "$FILE_COUNT" -le 10 ]; then
    echo -e "${COLOR_GREEN}PASS${COLOR_NC} (ファイル数: $FILE_COUNT)"
else
    echo -e "${COLOR_RED}FAIL${COLOR_NC} (不要なファイルが混入しています: $FILE_COUNT 個)"
    ls -F | grep -vE "^(node_modules|logs|hdd.logs|yata.db|archive|data|local_llm|local_public|dashboard|modules|tasks|tests|nanobanana-output|package-lock.json|defined_funcs.txt|backup.log|core\.|credentials\.json|interests\.json|persona\.txt|server-properties.json|yata_ram\.db|yata\.db-shm|yata\.db-wal)$"
    git checkout "$CURRENT_BRANCH" > /dev/null 2>&1
    exit 1
fi

# 2. Azure Embedding ロジックチェック
echo -n "  - lib/YATA.js Azure Embedding 存在確認: "
if grep -q "function _callAzureEmbedding" lib/YATA.js; then
    echo -e "${COLOR_GREEN}PASS${COLOR_NC}"
else
    echo -e "${COLOR_RED}FAIL${COLOR_NC} (_callAzureEmbedding が見当たりません)"
    git checkout "$CURRENT_BRANCH" > /dev/null 2>&1
    exit 1
fi

# 3. ドキュメント掟チェック
echo -n "  - PROJECT_GUIDE.md 物理的証拠の掟チェック: "
if grep -q "物理的証拠による証明義務" PROJECT_GUIDE.md; then
    echo -e "${COLOR_GREEN}PASS${COLOR_NC}"
else
    echo -e "${COLOR_RED}FAIL${COLOR_NC} (掟が記述されていません)"
    git checkout "$CURRENT_BRANCH" > /dev/null 2>&1
    exit 1
fi

git checkout "$CURRENT_BRANCH" > /dev/null 2>&1
echo -e "\n✅ ${COLOR_GREEN}INTEGRITY OK: すべての物理的要件を満たしています。${COLOR_NC}"
exit 0
