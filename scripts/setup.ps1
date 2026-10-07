param([switch]$Desktop)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $projectRoot
$runtimeRoot = if ($env:MEETINTEL_RUNTIME) { $env:MEETINTEL_RUNTIME } else { Join-Path $env:LOCALAPPDATA 'MeetIntel/runtime' }
$pythonPath = Join-Path $runtimeRoot 'venv/Scripts/python.exe'
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
if (-not (Test-Path -LiteralPath $pythonPath)) {
    py -3.12 -m venv (Join-Path $runtimeRoot 'venv')
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.12 is required. Install it and rerun setup.' }
}
& $pythonPath -m pip install -r backend/requirements.txt -c backend/requirements-lock.txt
if ($LASTEXITCODE -ne 0) { throw 'Backend dependency installation failed.' }
$rendererRuntime = Join-Path $runtimeRoot 'renderer'
New-Item -ItemType Directory -Force -Path $rendererRuntime | Out-Null
Copy-Item -LiteralPath renderer/package.json,renderer/package-lock.json -Destination $rendererRuntime
npm ci --prefix $rendererRuntime
if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency installation failed.' }
if ($Desktop) {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'Desktop dependency installation failed.' }
}
if (-not (Test-Path -LiteralPath backend/.env)) {
    Copy-Item -LiteralPath backend/.env.example -Destination backend/.env
}
New-Item -ItemType Directory -Force -Path .runtime | Out-Null
Set-Content -LiteralPath .runtime/python.txt -Value $pythonPath
Set-Content -LiteralPath .runtime/runtime.txt -Value $runtimeRoot
Write-Host 'Ready. Run: powershell -ExecutionPolicy Bypass -File scripts/start.ps1'
