@echo off
chcp 65001 >nul
echo 正在执行本地抓取并同步到线上发卡网...
python local_sync.py
echo.
pause
