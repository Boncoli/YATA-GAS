#!/bin/bash
# maintenance/bump-version.sh
# YATA プロジェクトのバージョン一括更新スクリプト
# 
# 使い方: bash maintenance/bump-version.sh <new_version> [commit_message]
# 例: bash maintenance/bump-version.sh 1.0.1 "fix: minor bug fixes"

set -e

if [ -z "$1" ]; then
  echo "❌ エラー: 新しいバージョン番号を指定してください。"
  echo "使い方: $0 <new_version> [commit_message]"
  echo "例: $0 1.0.1 \"fix: minor bug fixes\""
  exit 1
fi

NEW_VERSION=$1
COMMIT_MSG=${2:-"chore: bump version to v${NEW_VERSION}"}

# package.json から現在のバージョンを取得（文字列抽出）
CURRENT_VERSION=$(grep -m 1 '"version":' package.json | sed -E 's/.*"version": "([^"]+)".*/\1/')

echo "======================================"
echo "🚀 YATA Version Bump Tool"
echo "Current Version: ${CURRENT_VERSION}"
echo "New Version:     ${NEW_VERSION}"
echo "======================================"

# 1. package.json の更新
echo "📦 Updating package.json..."
sed -i "s/\"version\": \"${CURRENT_VERSION}\"/\"version\": \"${NEW_VERSION}\"/" package.json

# 2. lib/YATA.js の更新 (@version と * @version の両方に対応)
echo "📜 Updating lib/YATA.js..."
sed -i "s/@version ${CURRENT_VERSION}/@version ${NEW_VERSION}/g" lib/YATA.js

# 3. README.md の更新 (バッジや表記があれば)
# "YATA v1.0.0" のような表記を更新
echo "📖 Updating README.md..."
sed -i "s/YATA v${CURRENT_VERSION}/YATA v${NEW_VERSION}/g" README.md
sed -i "s/YATA-v${CURRENT_VERSION}/YATA-v${NEW_VERSION}/g" README.md 2>/dev/null || true

# 4. README_LOCAL.md の更新
echo "🏠 Updating README_LOCAL.md..."
sed -i "s/YATA v${CURRENT_VERSION}/YATA v${NEW_VERSION}/g" README_LOCAL.md 2>/dev/null || true

# 5. PROJECT_GUIDE.md の更新
echo "🧭 Updating PROJECT_GUIDE.md..."
sed -i "s/YATA v${CURRENT_VERSION}/YATA v${NEW_VERSION}/g" PROJECT_GUIDE.md 2>/dev/null || true

echo ""
echo "✅ 全ファイルのバージョン書き換えが完了しました。"

# Git コミットとタグ打ち (local-raspi のみ)
# 現在のブランチが local-raspi かどうか確認
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)

if [ "$CURRENT_BRANCH" = "local-raspi" ]; then
  echo "🌿 Gitへのコミットとタグ付けを実行します (Branch: local-raspi)..."
  
  git add package.json lib/YATA.js README.md README_LOCAL.md PROJECT_GUIDE.md
  
  # 変更がある場合のみコミット
  if git diff-index --quiet HEAD --; then
    echo "ℹ️ 変更がありません。コミットをスキップします。"
  else
    git commit -m "${COMMIT_MSG}"
    echo "✅ コミット完了: ${COMMIT_MSG}"
  fi
  
  # 既存のタグと同名ならエラーになるが、set -e によってスクリプトは安全に止まる
  git tag "v${NEW_VERSION}"
  echo "✅ タグ作成完了: v${NEW_VERSION}"
  
  echo ""
  echo "🎉 成功しました！ リモートへ反映する場合は以下のコマンドを実行してください："
  echo "git push origin local-raspi --tags"
else
  echo "⚠️ 現在のブランチは ${CURRENT_BRANCH} です。"
  echo "安全のため、Gitへの自動コミット・タグ付けは local-raspi ブランチでのみ実行されます。"
  echo "ファイルの書き換えのみで終了します。"
fi
