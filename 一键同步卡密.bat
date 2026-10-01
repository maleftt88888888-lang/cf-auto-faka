@echo off
title 正在同步卡密到线上发卡网...
cd /d "%~dp0"
python local_sync.py
echo.
pause
