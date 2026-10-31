@echo off
rem JobHunter: double-click to start (same as "npm start"). Extra arguments pass through, e.g. start.cmd --hunt
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed: https://nodejs.org
  echo Node.js לא מותקן
  pause
  exit /b 1
)
node scripts\start.mjs %*
if errorlevel 1 pause
