# local_sync.py - 本地自动抓取并推送到线上发卡网
import requests
from bs4 import BeautifulSoup
import re
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# 1. 目标抓取地址
TARGET_URL = "https://haogd.top/share/app"

# 2. 你的线上发卡网地址与管理员秘钥
ONLINE_FAKA_URL = "https://cf-auto-faka.maleftt88888888.workers.dev"
ADMIN_KEY = "admin123456"

headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
}

def sync():
    print("=" * 50)
    print("🚀 正在从目标源站抓取最新账号...")
    try:
        res = requests.get(TARGET_URL, headers=headers, timeout=15, verify=False)
        res.encoding = 'utf-8'
        html = res.text

        # 解析地区、账号、密码
        # 兼容多种标签和文本结构
        soup = BeautifulSoup(html, 'html.parser')
        text = soup.get_text()

        # 正则提取
        pattern = re.compile(r'(?:账号地区[：:]\s*([^\s\r\n<]+))?[\s\S]*?(?:账号[：:]\s*([a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+))[\s\S]*?(?:密码[：:]\s*([^\s\r\n<]+))', re.IGNORECASE)
        matches = pattern.findall(text)

        accounts = []
        for match in matches:
            region = (match[0] or "通用").strip()
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
            # 备用正则提取
            fallback = re.findall(r'([a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)\s+([a-zA-Z0-9!@#$%^&*()_+=\-`~]{6,30})', text)
            for acc, pwd in fallback:
                accounts.append({
                    "region": "美国",
                    "account": acc.strip(),
                    "password": pwd.strip(),
                    "carmi": f"【美国】账号: {acc.strip()} ---- 密码: {pwd.strip()}"
                })

        print(f"📊 本地成功解析到 {len(accounts)} 条账号信息！")

        if not accounts:
            print("⚠️ 未解析到账号，请检查目标页面是否改版。")
            return

        # 3. 按地区推送到线上发卡网
        for item in accounts:
            push_res = requests.post(
                f"{ONLINE_FAKA_URL}/api/admin/import",
                json={
                    "key": ADMIN_KEY,
                    "region": item["region"],
                    "text": item["carmi"]
                },
                timeout=10
            )
            print(f"  ➜ 推送 [{item['region']}] {item['account']} 结果: {push_res.json().get('msg')}")

        print("\n🎉 同步完成！线上发卡网库存已更新！")
        print(f"👉 线上网站：{ONLINE_FAKA_URL}")
        print("=" * 50)

    except Exception as e:
        print(f"❌ 同步出错: {e}")

if __name__ == "__main__":
    sync()
