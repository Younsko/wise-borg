@echo off
title Wise Borg Deal Sniper Launcher
color 0b
echo ==============================================================
echo               WISE BORG DEAL SNIPER STARTUP
echo ==============================================================
echo.
echo [+] Navigating to project directory...
cd /d "C:\Users\hbib6\Documents\antigravity\wise-borg"
echo [+] Starting server...
echo [+] Automatically opening your browser to http://localhost:3001...
echo.

:: Open the browser immediately to the sniper page
start "" "http://localhost:3001"

:: Start the server process
node server.js

echo.
echo [!] Server stopped.
pause
