import urllib.request
import re
import ssl

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

req = urllib.request.Request(
    'https://haoged.top/share/app',
    headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}
)

with urllib.request.urlopen(req, context=ctx, timeout=15) as resp:
    html = resp.read().decode('utf-8', errors='ignore')

# 提取所有 card-body 块
cards = html.split('card-body')
print(f"找到卡片数: {len(cards) - 1}")

for i, card in enumerate(cards[1:], 1):
    # 查找账号和密码
    clips = re.findall(r'data-clipboard-text=["\']([^"\']+)["\']', card)
    account = ""
    password = ""
    for val in clips:
        if "@" in val:
            account = val.strip()
        elif not password and len(val) >= 4:
            password = val.strip()
    
    # 提取地区
    reg = "美国"
    for r in ["香港", "台湾", "日本", "美国", "韩国", "新加坡", "英国"]:
        if r in card:
            reg = r
            break

    if account and password:
        print(f"[{i}] 地区: {reg} | 账号: {account} | 密码: {password}")
