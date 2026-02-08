#!/bin/bash

# 渠道觀察者 - 一鍵部署腳本
# 使用方式: ./setup.sh

set -e

echo "=========================================="
echo " 渠道觀察者 - Docker 部署"
echo "=========================================="

# 檢查 Docker
if ! command -v docker &> /dev/null; then
    echo "❌ 請先安裝 Docker"
    exit 1
fi
echo "✅ Docker: $(docker -v | cut -d' ' -f3)"

# 檢查 .env 檔案
if [ ! -f packages/server/.env ]; then
    echo "⚙️  建立預設 .env 檔案..."
    cp packages/server/.env.example packages/server/.env
    echo "✅ 已建立 packages/server/.env，請根據需求修改設定"
else
    echo "ℹ️  packages/server/.env 已存在"
fi

# 啟動所有服務
echo ""
echo "🚀 建構並啟動所有服務..."
docker compose up --build -d

echo ""
echo "⏳ 等待服務啟動..."
sleep 10

echo ""
echo "=========================================="
echo " ✅ 部署完成！"
echo "=========================================="
echo ""
echo "服務位址："
echo "  前端:    http://localhost:5173"
echo "  後端:    http://localhost:3000"
echo "  Adminer: http://localhost:8080"
echo ""
echo "預設帳號："
echo "  帳號: admin"
echo "  密碼: admin123"
echo ""
echo "常用指令："
echo "  查看狀態:  docker compose ps"
echo "  查看日誌:  docker compose logs -f"
echo "  停止服務:  docker compose down"
echo "  重新建構:  docker compose up --build -d"
echo ""
