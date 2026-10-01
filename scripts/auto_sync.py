# -*- coding: utf-8 -*-
"""
GitHub Actions 自动化抓取并推送到 Cloudflare 发卡网
"""
import requests
import re
import json
import os
import sys

TARGET_URL = os.environ.get("TARGET_URL", "https://haogd.top/share/app")
ONLINE_FAKA_URL = os.environ.get("ONLINE_FAKA_URL", "https://cf-auto-faka.maleftt88888888.workers.dev")
ADMIN_KEY = os.environ.get("ADMIN_KEY", "51245124")

headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
}

def run_sync():
    print("=" * 60)
    print("🚀 [GitHub Actions] 开始执行自动抓取与同步任务...")
    print(f"🎯 目标源站: {TARGET_URL}")
    print(f"🌐 目标发卡网: {ONLINE_FAKA_URL}")

    try:
        res = requests.get(TARGET_URL, headers=headers, timeout=20, verify=False)
        print(f"📡 源站响应状态码: {res.status_code}")
        if res.status_code != 200:
            print(f"❌ 抓取失败，HTTP 状态码: {res.status_code}")
            return

        html = res.text

        # 正则提取地区、账号、密码
        pattern = re.compile(r'(?:账号地区[：:]\s*([^\s\r\n<]+))?[\s\S]*?(?:账号[：:]\s*([a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+))[\s\S]*?(?:密码[：:]\s*([^\s\r\n<]+))', re.IGNORECASE)
        matches = pattern.findall(html)

        accounts = []
        for match in matches:
            region = (match[0] or "通用").replace("：", "").replace(":", "").strip()
            account = match[1].strip()
            password = match[2].strip()
            if account and password:
                accounts.append({
                    "region": region if region else "美国",
                    "account": account,
                    "password": password,
                    "carmi": f"【{region}】账号: {account} ---- 密码: {password}"
                })

        if not accounts:
            fallback = re.findall(r'([a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)\s+([a-zA-Z0-9!@#$%^&*()_+=\-`~]{6,30})', html)
            for acc, pwd in fallback:
                accounts.append({
                    "region": "美国",
                    "account": acc.strip(),
                    "password": pwd.strip(),
                    "carmi": f"【美国】账号: {acc.strip()} ---- 密码: {pwd.strip()}"
                })

        print(f"📊 成功从源站解析到 {len(accounts)} 条账号信息！")

        if not accounts:
            print("⚠️ 未解析到账号内容。")
            return

        # 推送到 Cloudflare 发卡网
        success_count = 0
        for item in accounts:
            try:
                push_res = requests.post(
                    f"{ONLINE_FAKA_URL}/api/admin/import",
                    json={
                        "key": ADMIN_KEY,
                        "region": item["region"],
                        "text": item["carmi"]
                    },
                    timeout=15
                )
                res_json = push_res.json()
                print(f"  ➜ 导入 [{item['region']}] {item['account']} 状态: {res_json.get('msg')}")
                if res_json.get("code") == 0:
                    success_count += 1
            except Exception as e:
                print(f"  ➜ 导入 [{item['region']}] 异常: {e}")

        print("\n🎉 GitHub Actions 同步任务执行完毕！")
        print("=" * 60)

    except Exception as err:
        print(f"❌ 任务执行出错: {err}")

if __name__ == "__main__":
    run_sync()
