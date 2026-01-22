#!/bin/bash
# .envを読み込み
if [ -f ~/yata-local/.env ]; then export $(cat ~/yata-local/.env | grep -v '^#' | xargs); fi

# 通知送信
if [ -n "$DISCORD_WEBHOOK_URL" ] && [ -n "$1" ]; then
  curl -H "Content-Type: application/json" -X POST -d "{\"content\": \"$1\"}" $DISCORD_WEBHOOK_URL
fi