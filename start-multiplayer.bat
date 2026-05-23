@echo off
cd /d "%~dp0"
if exist "%~dp0node.exe" (
  "%~dp0node.exe" multiplayer-server.js
  pause
  exit /b
)
node multiplayer-server.js
pause
