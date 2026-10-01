# -*- coding: utf-8 -*-
"""
智能抓取与同步工具（支持：浏览器直接复制HTML自动解析导入）
"""
import sys
import json
import re
import urllib.request
import ssl

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

ONLINE_FAKA_URL = "https://cf-auto-faka.maleftt88888888.workers.dev"
ADMIN_KEY = "51245124"

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

def parse_and_sync(raw_text):
    print("=" * 60)
    print("[*] 正在解析账号与密码信息...")

    # 正则提取地区、账号、密码
    pattern = re.compile(r'(?:账号地区[：:]\s*([^\s\r\n<]+))?[\s\S]*?(?:账号[：:]\s*([a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+))[\s\S]*?(?:密码[：:]\s*([^\s\r\n<]+))', re.IGNORECASE)
    matches = pattern.findall(raw_text)

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
        # 备用匹配模式
        fallback = re.findall(r'([a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)\s+([a-zA-Z0-9!@#$%^&*()_+=\-`~]{6,30})', raw_text)
        for acc, pwd in fallback:
            accounts.append({
                "region": "美国",
                "account": acc.strip(),
                "password": pwd.strip(),
                "carmi": f"【美国】账号: {acc.strip()} ---- 密码: {pwd.strip()}"
            })

    print(f"[+] 成功解析到 {len(accounts)} 条有效账号！")

    if not accounts:
        print("[!] 未解析到账号，请确认粘贴的内容是否包含账号和密码。")
        return

    # 推送到线上发卡网
    for item in accounts:
        payload = json.dumps({
            "key": ADMIN_KEY,
            "region": item["region"],
            "text": item["carmi"]
        }).encode("utf-8")

        push_req = urllib.request.Request(
            f"{ONLINE_FAKA_URL}/api/admin/import",
            data=payload,
            headers={
                "Content-Type": "application/json; charset=utf-8",
                "User-Agent": "Mozilla/5.0"
            }
        )

        try:
            with urllib.request.urlopen(push_req, context=ctx, timeout=10) as push_resp:
                res_data = json.loads(push_resp.read().decode("utf-8"))
                print(f"  -> 同步 [{item['region']}] {item['account']} 结果: {res_data.get('msg')}")
        except Exception as push_err:
            print(f"  -> 同步 [{item['region']}] 出错: {push_err}")

    print("\n[OK] 同步完成！线上发卡网库存已更新！")
    print(f"[>] 线上发卡网：{ONLINE_FAKA_URL}")
    print("=" * 60)

if __name__ == "__main__":
    print("------------------------------------------------------------")
    print("💡 智能卡密解析与同步助手")
    print("你可以直接在浏览器打开目标网站（haogd.top/share/app），")
    print("按 Ctrl+A 全选页面文字，Ctrl+C 复制后粘贴在下方，然后按回车：")
    print("------------------------------------------------------------")
    try:
        lines = []
        while True:
            line = input()
            if not line and lines:
                break
            lines.append(line)
        raw_text = "\n".join(lines)
        if raw_text.strip():
            parse_and_sync(raw_text)
    except (EOFError, KeyboardInterrupt):
        pass
