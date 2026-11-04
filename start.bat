@echo off
cd /d "%~dp0"
echo Starting BTC Indicator Dashboard...
node server.js --open
pause
