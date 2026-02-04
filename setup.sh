#!/bin/bash

# LINE 群聊監控系統 - 一鍵部署腳本
# 使用方式: ./setup.sh

set -e

echo "=========================================="
echo " LINE 群聊監控系統 - 本地部署"
echo "=========================================="

# 檢查 Node.js
if ! command -v node &> /dev/null; then
    echo "❌ 請先安裝 Node.js (v18+)"
    exit 1
fi
echo "✅ Node.js: $(node -v)"

# 檢查 Docker
if ! command -v docker &> /dev/null; then
    echo "❌ 請先安裝 Docker"
    exit 1
fi
echo "✅ Docker: $(docker -v | cut -d' ' -f3)"

# 1. 安裝依賴
echo ""
echo "📦 安裝專案依賴..."
npm install

# 2. 啟動 PostgreSQL
echo ""
echo "🐘 啟動 PostgreSQL..."
docker compose up -d postgres

# 等待資料庫就緒
echo "⏳ 等待資料庫就緒..."
sleep 5
until docker compose exec -T postgres pg_isready -U postgres > /dev/null 2>&1; do
    sleep 1
done
echo "✅ PostgreSQL 已就緒"

# 3. 設定環境變數
echo ""
echo "⚙️  設定環境變數..."
if [ ! -f packages/server/.env ]; then
    cp packages/server/.env.example packages/server/.env
    echo "✅ 已建立 .env 檔案"
else
    echo "ℹ️  .env 檔案已存在"
fi

# 4. 資料庫遷移
echo ""
echo "🗄️  執行資料庫遷移..."
npm run db:migrate

# 5. 初始化資料
echo ""
echo "🌱 初始化資料..."
npm run db:seed

echo ""
echo "=========================================="
echo " ✅ 部署完成！"
echo "=========================================="
echo ""
echo "啟動服務："
echo "  npm run dev"
echo ""
echo "服務位址："
echo "  前端: http://localhost:5173"
echo "  後端: http://localhost:3000"
echo ""
echo "預設帳號："
echo "  帳號: admin"
echo "  密碼: admin123"
echo ""
