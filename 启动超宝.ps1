$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '需要安装 Node.js 22 或更高版本。' }
if (-not (Test-Path -LiteralPath '.env')) { Copy-Item -LiteralPath '.env.example' -Destination '.env' }
if (-not (Test-Path -LiteralPath 'node_modules')) { npm install; if ($LASTEXITCODE -ne 0) { throw '依赖安装失败。' } }
if (-not (Test-Path -LiteralPath 'web/public/models/kws/tokens.txt')) { npm run setup:assets -- --speaker; if ($LASTEXITCODE -ne 0) { throw '模型安装失败。' } }
if (-not (Test-Path -LiteralPath '.runtime/livekit/livekit-server.exe')) { npm run setup:livekit; if ($LASTEXITCODE -ne 0) { throw 'LiveKit 安装失败。' } }
New-Item -ItemType Directory -Path '.runtime' -Force | Out-Null
if (-not (Get-NetTCPConnection -LocalPort 7880 -State Listen -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath (Join-Path $PSScriptRoot '.runtime/livekit/livekit-server.exe') -ArgumentList @('--dev', '--bind', '127.0.0.1') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot '.runtime/livekit.stdout.log') -RedirectStandardError (Join-Path $PSScriptRoot '.runtime/livekit.stderr.log') | Out-Null
}
if (-not (Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath (Get-Command node).Source -ArgumentList @('node_modules/concurrently/dist/bin/concurrently.js', '-k', 'npm:dev:server', 'npm:dev:web') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot '.runtime/app.stdout.log') -RedirectStandardError (Join-Path $PSScriptRoot '.runtime/app.stderr.log') | Out-Null
}
Write-Host '超宝正在启动：http://127.0.0.1:5173/'
Write-Host '日志位于 .runtime。首次使用请在页面点击“连接麦克风”并允许浏览器访问麦克风。'
