# -*- coding: utf-8 -*-
"""
GitHub Actions 自动化抓取并推送到 Cloudflare 发卡网 (详细日志与多接口探测版)
"""
import requests
import re
import json
import os
import sys
import urllib3
urllib3.disable_warnings()

TARGET_URL = os.environ.get("TARGET_URL", "https://haogd.top/share/app")
ONLINE_FAKA_URL = os.environ.get("ONLINE_FAKA_URL", "https://cf-auto-faka.maleftt88888888.workers.dev")
ADMIN_KEY = os.environ.get("ADMIN_KEY", "51245124")

headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
}

def run_sync():
    print("=" * 60)
    print("🚀 [GitHub Actions] 开始请求目标源站...")
    print(f"🎯 目标源站: {TARGET_URL}")

    html = ""
    try:
        session = requests.Session()
        res = session.get(TARGET_URL, headers=headers, timeout=25, verify=False)
        print(f"📡 目标源站响应状态码: {res.status_code}")
        print(f"📄 响应内容长度: {len(res.text)} 字符")
        print(f"🔍 响应前 300 字符:\n{res.text[:300]}")
        html = res.text
    except Exception as e:
        print(f"❌ 请求源站异常: {e}")
        return

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
        # 尝试匹配包含邮箱和密码的块
        fallback = re.findall(r'([a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)\s+([a-zA-Z0-9!@#$%^&*()_+=\-`~]{6,30})', html)
        for acc, pwd in fallback:
            accounts.append({
                "region": "美国",
                "account": acc.strip(),
                "password": pwd.strip(),
                "carmi": f"【美国】账号: {acc.strip()} ---- 密码: {pwd.strip()}"
            })

    print(f"\n📊 解析结果: 共匹配到 {len(accounts)} 条账号信息！")

    if not accounts:
        print("⚠️ 警告: 源站页面上没有提取到账号，可能是页面使用 JS 动态加载，或者源站返回了拦截页面！")
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
            print(f"  ➜ 导入 [{item['region']}] {item['account']} 状态: {res_json.get('msg')}")
        except Exception as e:
            print(f"  ➜ 导入 [{item['region']}] 异常: {e}")

    print("\n🎉 同步执行结束！")
    print("=" * 60)

if __name__ == "__main__":
    run_sync()
