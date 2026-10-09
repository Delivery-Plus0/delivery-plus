# E2E Stack startup script: compose up + seed data
# Usage: .\start-e2e.ps1

Write-Host "🚀 Starting Delivery Plus E2E environment..." -ForegroundColor Cyan

# Start docker compose stack
Write-Host "`n📦 Bringing up Docker Compose..." -ForegroundColor Yellow
docker compose -f docker-compose.base.yml -f docker-compose.test.yml -f docker-compose.e2e.yml up -d --build --wait --wait-timeout 300

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Docker Compose failed" -ForegroundColor Red
    exit 1
}

Write-Host "✅ Docker Compose stack is healthy" -ForegroundColor Green

# Run seed data
Write-Host "`n🌱 Seeding E2E test data..." -ForegroundColor Yellow
npm run seed:e2e

if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ Seed script failed" -ForegroundColor Red
    exit 1
}

Write-Host "`n✅ E2E environment ready!" -ForegroundColor Green
Write-Host "`n🔗 API Gateway: http://localhost:3100" -ForegroundColor Cyan
Write-Host "📊 Media Storage: http://localhost:9100" -ForegroundColor Cyan
Write-Host "`n💾 Manifest: $(Get-Item e2e-seed-manifest.json -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)" -ForegroundColor Cyan
