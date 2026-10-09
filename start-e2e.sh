#!/bin/bash
# E2E Stack startup script: compose up + seed data
# Usage: ./start-e2e.sh

set -e

echo "🚀 Starting Delivery Plus E2E environment..."

# Start docker compose stack
echo -e "\n📦 Bringing up Docker Compose..."
docker compose -f docker-compose.base.yml -f docker-compose.test.yml -f docker-compose.e2e.yml up -d --build --wait --wait-timeout 300

echo "✅ Docker Compose stack is healthy"

# Run seed data
echo -e "\n🌱 Seeding E2E test data..."
npm run seed:e2e

echo -e "\n✅ E2E environment ready!"
echo -e "\n🔗 API Gateway: http://localhost:3100"
echo "📊 Media Storage: http://localhost:9100"
echo -e "\n💾 Manifest: $(pwd)/e2e-seed-manifest.json"
