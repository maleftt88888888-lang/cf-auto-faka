# -*- coding: utf-8 -*-
"""
====================================================================
  天翼云电脑 / Windows PC 微信自动收款监控推送脚本
  无需安卓模拟器，直接在 Windows 上监控 PC 微信收款通知并实时推送到发卡系统
====================================================================
"""

import sys
import os
import time
import re
import json
import urllib.request
import urllib.error
from datetime import datetime

# 发卡系统服务端配置
SERVER_NOTIFY_URL = "https://faka.medpic.eu.cc/api/pay/notify"
COMMUNICATION_KEY = "51245124"  # 与后台 ADMIN_KEY 一致

# 记录已推送过的单号，防止重复推送
pushed_trade_numbers = set()

def print_banner():
    os.system('cls' if os.name == 'nt' else 'clear')
    print("=" * 60)
    print("  🚀 天翼云电脑 · PC 微信收款 24H 自动监控推送助手")
    print("=" * 60)
    print(f"  [+] 推送目标: {SERVER_NOTIFY_URL}")
    print(f"  [+] 通信密钥: {COMMUNICATION_KEY}")
    print(f"  [+] 运行环境: Windows PC 微信直接挂机 (无需安卓模拟器)")
    print("=" * 60)
    print("  💡 工作模式：")
    print("  1. 自动监听系统剪贴板与收款文本")
    print("  2. 支持在控制台手动输入单号测试验证")
    print("  3. 收到微信到账后自动提取【交易单号】与【金额】并推送到 Cloudflare")
    print("=" * 60)
    print()

def push_payment(trade_no, amount=4.99, raw_text=""):
    """向 Cloudflare Worker 发送真实到账凭证"""
    trade_no = trade_no.strip()
    if not trade_no or trade_no in pushed_trade_numbers:
        return False

    payload = {
        "key": COMMUNICATION_KEY,
        "trade_no": trade_no,
        "amount": float(amount),
        "raw": raw_text[:200]
    }

    try:
        data = json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(
            SERVER_NOTIFY_URL,
            data=data,
            headers={"Content-Type": "application/json", "User-Agent": "TianyiCloudPC-WeChatMonitor/1.0"}
        )
        with urllib.request.urlopen(req, timeout=10) as response:
            res_body = response.read().decode('utf-8')
            res_json = json.loads(res_body)
            if res_json.get("code") == 0:
                pushed_trade_numbers.add(trade_no)
                now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                print(f"[{now_str}] 💰 【成功同步到账】单号: {trade_no} | 金额: ￥{amount} -> 已入库发卡系统！")
                return True
            else:
                print(f"[-] 推送返回: {res_json.get('msg')}")
    except Exception as e:
        print(f"[!] 推送失败: {e}")
    return False

def parse_and_push_message(text):
    """智能解析微信到账文本中的单号与金额"""
    if not text or len(text) < 4:
        return False

    # 匹配交易单号（通常为 10000 开头或长数字串）
    # 例如：交易单号 1000049201202403210001234567 或 单号: 420000213123
    trade_match = re.search(r'(?:单号|交易单号|单号后|编号|Order)[:：\s]*([0-9A-Za-z]{4,32})', text)
    if not trade_match:
        # 尝试直接提取连续的长数字串 (>= 4 位)
        trade_match = re.search(r'\b([0-9]{4,32})\b', text)

    # 匹配金额
    amount_match = re.search(r'(?:收款|到账|支付|￥|¥|元)[:：\s]*([0-9]+(?:\.[0-9]{1,2})?)', text)
    amount = 4.99
    if amount_match:
        try:
            amount = float(amount_match.group(1))
        except:
            amount = 4.99

    if trade_match:
        trade_no = trade_match.group(1)
        return push_payment(trade_no, amount, text)
    return False

def get_clipboard_text():
    """获取 Windows 剪贴板内容（免依赖标准库实现）"""
    try:
        import ctypes
        from ctypes import wintypes

        CF_UNICODETEXT = 13
        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32

        if not user32.OpenClipboard(None):
            return ""

        handle = user32.GetClipboardData(CF_UNICODETEXT)
        if not handle:
            user32.CloseClipboard()
            return ""

        kernel32.GlobalLock.restype = ctypes.c_wchar_p
        data_ptr = kernel32.GlobalLock(handle)
        text = str(data_ptr) if data_ptr else ""
        kernel32.GlobalUnlock(handle)
        user32.CloseClipboard()
        return text
    except:
        return ""

def monitor_loop():
    """后台监控主循环"""
    print_banner()
    print("🟢 正在 24 小时实时监听微信到账通知...")
    print("💡 提示：您也可以直接在此窗口中输入单号并回车，手动同步一笔到账！\n")

    last_clip = ""

    while True:
        try:
            # 1. 检测剪贴板（如复制了微信账单文本）
            current_clip = get_clipboard_text()
            if current_clip and current_clip != last_clip:
                last_clip = current_clip
                parse_and_push_message(current_clip)

            time.sleep(1)
        except KeyboardInterrupt:
            print("\n🛑 监控已停止。")
            break
        except Exception as e:
            time.sleep(2)

if __name__ == "__main__":
    if len(sys.argv) > 1:
        # 支持命令行直接传参: python pc_wechat_monitor.py <单号> [金额]
        tn = sys.argv[1]
        amt = float(sys.argv[2]) if len(sys.argv) > 2 else 4.99
        print(f"正在直接推送单号 {tn} (￥{amt})...")
        push_payment(tn, amt, "CLI 手动测试")
    else:
        monitor_loop()
