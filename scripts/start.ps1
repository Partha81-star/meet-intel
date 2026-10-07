param([switch]$Desktop)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $projectRoot
if (-not (Test-Path -LiteralPath .runtime/python.txt)) { throw 'Run scripts/setup.ps1 first.' }
$pythonPath = (Get-Content -LiteralPath .runtime/python.txt -Raw).Trim()
if (Test-Path -LiteralPath .runtime/runtime.txt) { $env:MEETINTEL_RUNTIME = (Get-Content -LiteralPath .runtime/runtime.txt -Raw).Trim() }
$backendPath = Join-Path $projectRoot 'backend'
$backend = Start-Process -FilePath $pythonPath -ArgumentList @('-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '8000', '--app-dir', "`"$backendPath`"") -WorkingDirectory $backendPath -RedirectStandardOutput (Join-Path $projectRoot '.runtime/backend.log') -RedirectStandardError (Join-Path $projectRoot '.runtime/backend-error.log') -WindowStyle Hidden -PassThru
try {
    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if ($backend.HasExited) { throw 'Backend failed to start. Check backend/.env and port 8000.' }
        try { Invoke-RestMethod http://127.0.0.1:8000/health | Out-Null; $ready = $true; break } catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $ready) { throw 'Backend did not become healthy.' }
    if ($Desktop) { npm run dev:desktop } else { node scripts/renderer.cjs dev }
} finally {
    if (-not $backend.HasExited) { Stop-Process -Id $backend.Id }
}
