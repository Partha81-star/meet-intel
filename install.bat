@echo off
:: ============================================================
::  MeetIntel — Install all dependencies
::  Run ONCE from the project root before starting the app.
:: ============================================================
echo.
echo  MeetIntel — Dependency Installer
echo  ==================================
echo.

:: ── Python backend ────────────────────────────────────────────
echo [1/3] Setting up Python virtual environment...
cd backend

if not exist venv (
    python -m venv venv
    echo  [OK] venv created
) else (
    echo  [OK] venv already exists
)

call venv\Scripts\activate.bat
echo [2/3] Installing Python packages...
pip install -r requirements.txt --quiet
echo  [OK] Python packages installed

cd ..

:: ── Node.js root (Electron) ───────────────────────────────────
echo [3/3] Installing Node packages (root)...
if exist node_modules (
    echo  [OK] node_modules already exists — skipping
) else (
    npm install --silent
    echo  [OK] Root node packages installed
)

:: ── Node.js renderer (Next.js) ────────────────────────────────
echo [3b/3] Installing Node packages (renderer)...
cd renderer
if exist node_modules (
    echo  [OK] renderer/node_modules already exists — skipping
) else (
    npm install --silent
    echo  [OK] Renderer packages installed
)
cd ..

:: ── .env setup ────────────────────────────────────────────────
if not exist backend\.env (
    copy backend\.env.example backend\.env >nul
    echo.
    echo  [ACTION REQUIRED] backend\.env was created from the template.
    echo  Open it and fill in your API keys before starting.
    echo  Keys needed:
    echo    DEEPGRAM_API_KEY  — https://console.deepgram.com
    echo    OPENAI_API_KEY    — https://platform.openai.com/api-keys
    echo    SUPABASE_URL      — Supabase Dashboard → Settings → API
    echo    SUPABASE_SERVICE_KEY
) else (
    echo  [OK] backend\.env already exists
)

echo.
echo  ============================================================
echo   Installation complete!
echo.
echo   To start MeetIntel for demo (3 terminals):
echo     Terminal 1:  start_backend.bat
echo     Terminal 2:  start_renderer.bat
echo     Terminal 3:  start_electron.bat
echo.
echo   Or run everything at once:
echo     npm run dev   (from project root)
echo  ============================================================
echo.
pause
