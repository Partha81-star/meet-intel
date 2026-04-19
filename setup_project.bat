@echo off
SETLOCAL ENABLEDELAYEDEXPANSION
echo.
echo ============================================================
echo   MeetIntel — Automated Backend Setup (Windows)
echo ============================================================
echo.

cd /d d:\MeetIntel\backend

:: ── 1. Nuke corrupt venv ────────────────────────────────────────────────────
if exist venv (
    echo [1/5] Removing existing venv...
    rmdir /s /q venv
    echo       Done.
) else (
    echo [1/5] No existing venv found. Skipping.
)

:: ── 2. Create fresh venv ────────────────────────────────────────────────────
echo [2/5] Creating fresh Python virtual environment...
python -m venv venv
if errorlevel 1 (
    echo ERROR: python not found. Make sure Python 3.11+ is on PATH.
    pause
    exit /b 1
)
echo       Done.

:: ── 3. Upgrade pip silently ──────────────────────────────────────────────────
echo [3/5] Upgrading pip...
venv\Scripts\python.exe -m pip install --upgrade pip --quiet
echo       Done.

:: ── 4. Install all dependencies ──────────────────────────────────────────────
echo [4/5] Installing dependencies...
venv\Scripts\pip.exe install ^
    fastapi ^
    "uvicorn[standard]" ^
    python-dotenv ^
    "deepgram-sdk>=3.2.7" ^
    "openai>=1.14.3" ^
    pydantic ^
    "supabase>=2.4.2" ^
    websockets ^
    Pillow ^
    imagehash ^
    httpx ^
    numpy

if errorlevel 1 (
    echo ERROR: pip install failed.
    pause
    exit /b 1
)
echo       Done.

:: ── 5. Write VS Code settings ────────────────────────────────────────────────
echo [5/5] Configuring VS Code interpreter path...

if not exist "d:\MeetIntel\.vscode" mkdir "d:\MeetIntel\.vscode"

:: Get absolute venv python path
set VENV_PYTHON=d:\MeetIntel\backend\venv\Scripts\python.exe

(
echo {
echo     "python.defaultInterpreterPath": "%VENV_PYTHON:\=\\%",
echo     "python.terminal.activateEnvironment": true,
echo     "python.linting.enabled": true,
echo     "python.linting.pylintEnabled": false,
echo     "python.analysis.typeCheckingMode": "basic",
echo     "python.analysis.extraPaths": [
echo         "d:\\MeetIntel\\backend"
echo     ],
echo     "[python]": {
echo         "editor.formatOnSave": true
echo     }
echo }
) > "d:\MeetIntel\.vscode\settings.json"

echo       Written to d:\MeetIntel\.vscode\settings.json
echo.
echo ============================================================
echo   Setup complete!
echo.
echo   To start the backend server, run:
echo.
echo     cd d:\MeetIntel\backend
echo     venv\Scripts\activate
echo     uvicorn main:app --reload --port 8000
echo.
echo   WebSocket test endpoint:
echo     ws://127.0.0.1:8000/ws/transcribe
echo.
echo   Mock audio sender:
echo     venv\Scripts\python.exe mock_client.py
echo ============================================================
echo.
pause
