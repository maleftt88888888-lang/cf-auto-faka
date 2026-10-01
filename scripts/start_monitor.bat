@echo off
chcp 65001 >nul
title 天翼云电脑 - PC微信到账24H自动同步助手
cd /d "%~dp0"
echo 正在启动天翼云电脑 PC 微信收款监控...
python pc_wechat_monitor.py
pause
