# -*- coding: utf-8 -*-
"""
GitHub Actions 自动化抓取并推送到 Cloudflare 发卡网
目标网站: https://haoged.top/share/app
"""
import requests
import re
import json
import os
import sys
import urllib3
urllib3.disable_warnings()

TARGET_URL = os.environ.get("TARGET_URL", "https://haoged.top/share/app")
ONLINE_FAKA_URL = os.environ.get("ONLINE_FAKA_URL", "https://cf-auto-faka.maleftt88888888.workers.dev")
ADMIN_KEY = os.environ.get("ADMIN_KEY", "51245124")

headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
}

def run_sync():
    print("=" * 60)
    print("🚀 [GitHub Actions] 开始抓取目标源站: " + TARGET_URL)

    try:
        res = requests.get(TARGET_URL, headers=headers, timeout=25, verify=False)
        if res.status_code != 200:
            print(f"❌ 抓取失败，HTTP 状态码: {res.status_code}")
            return

        html = res.text
        cards = html.split('card-body')
        print(f"📄 成功获取页面，检测到 {len(cards) - 1} 个卡片块")

        accounts = []
        for card in cards[1:]:
            clips = re.findall(r'data-clipboard-text=["\']([^"\']+)["\']', card)
            account = ""
            password = ""
            for val in clips:
                if "@" in val:
                    account = val.strip()
                elif not password and len(val) >= 4:
                    password = val.strip()

            reg = "美国"
            for r in ["香港", "台湾", "日本", "美国", "韩国", "新加坡", "英国"]:
                if r in card:
                    reg = r
                    break

            if account and password:
                accounts.append({
                    "region": reg,
                    "account": account,
                    "password": password,
                    "carmi": f"【{reg}】账号: {account} ---- 密码: {password}"
                })

        print(f"📊 成功精确解析到 {len(accounts)} 条最新可用账号！")

        if not accounts:
            print("⚠️ 未解析到账号。")
            return

        # 推送到 Cloudflare 发卡网
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
                print(f"  ➜ 导入 [{item['region']}] {item['account']} 结果: {res_json.get('msg')}")
            except Exception as e:
                print(f"  ➜ 导入 [{item['region']}] 出错: {e}")

        print("\n🎉 GitHub Actions 自动同步成功完成！")
        print("=" * 60)

    except Exception as err:
        print(f"❌ 运行异常: {err}")

if __name__ == "__main__":
    run_sync()
