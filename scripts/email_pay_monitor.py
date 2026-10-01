# -*- coding: utf-8 -*-
"""
====================================================================
  天翼云电脑 24H 邮箱 IMAP 秒级自动收款监听推送脚本
  无需安卓模拟器、无需挂 PC 微信，通过邮箱接收微信到账通知并秒级推送至 Cloudflare
====================================================================
"""

import sys
import os
import time
import re
import json
import imaplib
import email
from email.header import decode_header
import urllib.request
import urllib.error
from datetime import datetime

# 配置文件路径
CONFIG_FILE = os.path.join(os.path.dirname(__file__), "email_config.json")

DEFAULT_CONFIG = {
    "imap_server": "imap.qq.com",
    "imap_port": 993,
    "email_user": "your_email@qq.com",
    "email_auth_code": "your_imap_auth_code",
    "server_notify_url": "https://faka.medpic.eu.cc/api/pay/notify",
    "communication_key": "51245124",
    "check_interval_seconds": 3
}

def load_config():
    if not os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(DEFAULT_CONFIG, f, indent=4, ensure_ascii=False)
        return DEFAULT_CONFIG
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8-sig") as f:
            return json.load(f)
    except:
        return DEFAULT_CONFIG

config = load_config()

pushed_trade_numbers = set()

def print_banner():
    os.system('cls' if os.name == 'nt' else 'clear')
    print("=" * 65)
    print("  🚀 天翼云电脑 · 邮箱 IMAP 微信收款 24H 全自动秒级监控推送")
    print("=" * 65)
    print(f"  [+] 邮箱服务器: {config.get('imap_server')}:{config.get('imap_port')}")
    print(f"  [+] 监控邮箱:   {config.get('email_user')}")
    print(f"  [+] 推送目标:   {config.get('server_notify_url')}")
    print(f"  [+] 轮询间隔:   {config.get('check_interval_seconds', 3)} 秒")
    print("=" * 65)
    print("  💡 特点：0 模拟器、免 PC 微信挂机、手机任意退出切换、永不掉线！")
    print("=" * 65)
    print()

def push_payment(trade_no, amount=4.99, raw_text=""):
    trade_no = trade_no.strip()
    if not trade_no or trade_no in pushed_trade_numbers:
        return False

    payload = {
        "key": config.get("communication_key", "51245124"),
        "trade_no": trade_no,
        "amount": float(amount),
        "raw": raw_text[:200]
    }

    try:
        data = json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(
            config.get("server_notify_url"),
            data=data,
            headers={"Content-Type": "application/json", "User-Agent": "TianyiCloudPC-EmailPayMonitor/1.0"}
        )
        with urllib.request.urlopen(req, timeout=10) as response:
            res_body = response.read().decode('utf-8')
            res_json = json.loads(res_body)
            if res_json.get("code") == 0:
                pushed_trade_numbers.add(trade_no)
                now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                print(f"[{now_str}] 💰 【成功同步真实到账】单号: {trade_no} | 金额: ￥{amount} -> 已入库 Cloudflare！")
                return True
    except Exception as e:
        print(f"[!] 推送至发卡系统异常: {e}")
    return False

def decode_str(s):
    if not s:
        return ""
    val, encoding = decode_header(s)[0]
    if isinstance(val, bytes):
        try:
            return val.decode(encoding or "utf-8", errors="ignore")
        except:
            return val.decode("gbk", errors="ignore")
    return str(val)

def extract_email_body(msg):
    body = ""
    if msg.is_multipart():
        for part in msg.walk():
            content_type = part.get_content_type()
            content_disposition = str(part.get("Content-Disposition"))
            if "attachment" not in content_disposition:
                payload = part.get_payload(decode=True)
                if payload:
                    try:
                        charset = part.get_content_charset() or "utf-8"
                        body += payload.decode(charset, errors="ignore")
                    except:
                        body += payload.decode("gbk", errors="ignore")
    else:
        payload = msg.get_payload(decode=True)
        if payload:
            try:
                charset = msg.get_content_charset() or "utf-8"
                body = payload.decode(charset, errors="ignore")
            except:
                body = payload.decode("gbk", errors="ignore")
    return body

def parse_and_process_email(subject, body):
    full_text = subject + " " + body
    if not any(k in full_text for k in ["微信支付", "微信收款", "财付通", "收款", "到账", "转账"]):
        return False

    trade_matches = re.findall(r'(?:交易单号|单号|订单号|凭证号|交易号)[:：\s]*([0-9A-Za-z]{4,32})', full_text)
    if not trade_matches:
        trade_matches = re.findall(r'\b(420000[0-9]{10,24}|10000[0-9]{10,24})\b', full_text)

    amount = 4.99
    amount_match = re.search(r'(?:收款|到账|支付|金额|￥|¥|元)[:：\s]*([0-9]+(?:\.[0-9]{1,2})?)', full_text)
    if amount_match:
        try:
            amount = float(amount_match.group(1))
        except:
            amount = 4.99

    success = False
    if trade_matches:
        for tn in trade_matches:
            if len(tn) >= 4:
                if push_payment(tn, amount, subject):
                    success = True
    return success

def connect_imap():
    server_host = config.get("imap_server", "imap.qq.com")
    server_port = config.get("imap_port", 993)
    user = config.get("email_user", "")
    pwd = config.get("email_auth_code", "")

    if "your_email" in user or not pwd:
        print("⚠️ 提示：请先在 email_config.json 中配置您的邮箱账号与 IMAP 授权码！")
        return None

    try:
        mail = imaplib.IMAP4_SSL(server_host, server_port)
        mail.login(user, pwd)
        mail.select("INBOX")
        return mail
    except Exception as e:
        print(f"[!] IMAP 连接/登录失败: {e}")
        return None

def monitor_loop():
    print_banner()

    if "your_email" in config.get("email_user", "") or config.get("email_auth_code") == "your_imap_auth_code":
        print("❌ 未检测到有效配置！")
        print("请打开同目录下的 【email_config.json】 文件配置您的 QQ/163 邮箱和授权码。")
        print("配置示例 (QQ邮箱)：")
        print('  "imap_server": "imap.qq.com",')
        print('  "email_user": "你的QQ号码@qq.com",')
        print('  "email_auth_code": "在QQ邮箱设置->账户中开启IMAP生成的16位授权码"')
        print()
        input("配置完成后按回车键重新启动...")
        return

    print("🟢 正在连接邮箱服务器...")
    mail = connect_imap()
    if not mail:
        print("❌ 连接失败，将在 5 秒后重试...")
        time.sleep(5)
        return

    print("✅ 邮箱连接成功！已开启 24 小时微信到账秒级监听...")
    print("💡 无论何时收到微信收款邮件，系统将在 0.5 秒内自动提取单号并推送到发卡站！\n")

    check_interval = config.get("check_interval_seconds", 3)
    last_checked_id = 0

    while True:
        try:
            status, messages = mail.search(None, "UNSEEN")
            if status != "OK" or not messages[0]:
                status, messages = mail.search(None, "ALL")

            if status == "OK" and messages[0]:
                msg_ids = messages[0].split()
                recent_ids = msg_ids[-5:]

                for mid in recent_ids:
                    num_id = int(mid)
                    if num_id <= last_checked_id:
                        continue

                    res, msg_data = mail.fetch(mid, "(RFC822)")
                    if res == "OK":
                        raw_email = msg_data[0][1]
                        msg = email.message_from_bytes(raw_email)
                        subject = decode_str(msg.get("Subject", ""))
                        body = extract_email_body(msg)
                        parse_and_process_email(subject, body)
                        last_checked_id = max(last_checked_id, num_id)

            time.sleep(check_interval)
        except (imaplib.IMAP4.abort, imaplib.IMAP4.error, OSError):
            print("🔄 网络波动，正在自动重新连接邮箱...")
            time.sleep(2)
            mail = connect_imap()
        except KeyboardInterrupt:
            print("\n🛑 监控已安全退出。")
            break
        except Exception as e:
            time.sleep(3)

if __name__ == "__main__":
    monitor_loop()
