@echo off
:: ============================================================
::  MeetIntel — Start Electron (after renderer is up)
::  Run from project root:  start_electron.bat
::  NOTE: Start the renderer first (start_renderer.bat)!
:: ============================================================
echo.
echo  MeetIntel Electron Starting...
echo  ================================
echo  Waiting for renderer on http://localhost:3000...
echo.
npx wait-on http://localhost:3000 && npx electron .
