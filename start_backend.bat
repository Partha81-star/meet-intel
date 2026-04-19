@echo off
:: ============================================================
::  MeetIntel — Start Backend (FastAPI)
::  Run from the project root:  start_backend.bat
:: ============================================================
echo.
echo  MeetIntel Backend Starting...
echo  ===============================

:: Check for .env
if not exist "backend\.env" (
    echo  [WARNING] backend\.env not found!
    echo  Copy backend\.env.example to backend\.env and fill in your keys.
    echo.
)

:: Activate venv and launch uvicorn
cd backend
call venv\Scripts\activate.bat
echo  [OK] Virtual environment activated
echo  [OK] Starting FastAPI on http://127.0.0.1:8000
echo  [OK] WebSocket endpoint: ws://127.0.0.1:8000/ws/transcribe
echo.
:: Force UTF-8 output so ✅/❌ startup symbols render correctly in CMD / PowerShell
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
uvicorn main:app --host 127.0.0.1 --port 8000 --reload --log-level info
