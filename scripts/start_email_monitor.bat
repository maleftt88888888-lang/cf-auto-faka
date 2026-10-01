@echo off
chcp 65001 >nul
title 天翼云电脑 - 邮箱IMAP微信收款24H自动监控
cd /d "%~dp0"
echo 正在启动天翼云电脑 邮箱微信收款秒级监听服务...
python email_pay_monitor.py
pause
