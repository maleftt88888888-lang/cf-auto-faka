/**
 * Cloudflare Worker - 智能自动抓取发卡系统
 * 支持：Cron 定时自动抓取、地区分类库存、对接汇源开放平台/聚合支付、自动发卡、订单查询
 */

export default {
  // 1. 定时任务：自动抓取目标网站并入库
  async scheduled(event, env, ctx) {
    console.log("⏰ 触发定时抓取任务...");
    await syncAccountsFromSource(env);
  },

  // 2. HTTP 请求处理
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // 路由 1: 获取各地区库存统计
      if (path === "/api/stats") {
        const rows = await env.DB.prepare(`
          SELECT region, COUNT(CASE WHEN status = 0 THEN 1 END) as stock, COUNT(CASE WHEN status = 1 THEN 1 END) as sold
          FROM carmis
          GROUP BY region
        `).all();

        const defaultRegions = ["美国", "香港", "日本", "台湾", "通用"];
        const regionMap = {};
        for (const r of defaultRegions) {
          regionMap[r] = { region: r, stock: 0, sold: 0 };
        }

        if (rows.results) {
          for (const row of rows.results) {
            regionMap[row.region] = {
              region: row.region,
              stock: row.stock || 0,
              sold: row.sold || 0,
            };
          }
        }

        return jsonResponse({
          code: 0,
          data: Object.values(regionMap),
          site_name: env.SITE_NAME || "云账号智能发卡平台",
          price: env.PRICE_PER_ACCOUNT || "1.00",
          pay_enabled: !!(env.PAY_PID && env.PAY_KEY && env.PAY_URL)
        }, corsHeaders);
      }

      // 路由 2: 创建订单（支持免支付测试 & 汇源支付对接）
      if (path === "/api/order/create" && request.method === "POST") {
        const body = await request.json();
        const region = body.region || "美国";
        const contact = (body.contact || "").trim();
        const payType = body.pay_type || "alipay"; // alipay 或 wxpay

        // 检查库存
        const countRes = await env.DB.prepare(
          "SELECT COUNT(*) as cnt FROM carmis WHERE (region = ? OR region = '通用') AND status = 0"
        ).bind(region).first();

        if (!countRes || countRes.cnt <= 0) {
          return jsonResponse({ code: -1, msg: `当前【${region}】库存不足，请稍后重试！` }, corsHeaders);
        }

        const orderNo = "FK" + Date.now() + Math.floor(Math.random() * 1000).toString().padStart(3, "0");
        const price = parseFloat(env.PRICE_PER_ACCOUNT || "1.00");

        // 判断是否开启了真实支付（汇源开放平台）
        const isLivePay = !!(env.PAY_PID && env.PAY_KEY && env.PAY_URL);

        if (!isLivePay) {
          // 未配置支付秘钥时：走直接出卡模式（测试体验）
          const carmiRecord = await env.DB.prepare(
            "SELECT id, region, account, password, carmi FROM carmis WHERE (region = ? OR region = '通用') AND status = 0 ORDER BY RANDOM() LIMIT 1"
          ).bind(region).first();

          await env.DB.prepare("UPDATE carmis SET status = 1, order_no = ?, sold_at = datetime('now') WHERE id = ?").bind(orderNo, carmiRecord.id).run();
          await env.DB.prepare(`
            INSERT INTO orders (order_no, region, contact, price, status, carmi, pay_type, created_at, paid_at)
            VALUES (?, ?, ?, ?, 1, ?, 'free', datetime('now'), datetime('now'))
          `).bind(orderNo, region, contact, price, carmiRecord.carmi).run();

          return jsonResponse({
            code: 0,
            msg: "发卡成功",
            data: {
              order_no: orderNo,
              is_paid: true,
              carmi: carmiRecord.carmi
            }
          }, corsHeaders);
        }

        // 开启了汇源支付：创建待支付订单并生成支付网关链接
        await env.DB.prepare(`
          INSERT INTO orders (order_no, region, contact, price, status, pay_type, created_at)
          VALUES (?, ?, ?, ?, 0, ?, datetime('now'))
        `).bind(orderNo, region, contact, price, payType).run();

        const notifyUrl = `${url.origin}/api/pay/notify`;
        const returnUrl = `${url.origin}/?order_no=${orderNo}`;

        // 汇源 / 标准易支付签名参数
        const payParams = {
          pid: env.PAY_PID,
          type: payType,
          out_trade_no: orderNo,
          notify_url: notifyUrl,
          return_url: returnUrl,
          name: `${region}账号卡密`,
          money: price.toFixed(2),
        };

        const sign = await generateMD5Sign(payParams, env.PAY_KEY);
        payParams.sign = sign;
        payParams.sign_type = "MD5";

        const queryString = new URLSearchParams(payParams).toString();
        const paySubmitUrl = `${env.PAY_URL}?${queryString}`;

        return jsonResponse({
          code: 0,
          msg: "订单创建成功",
          data: {
            order_no: orderNo,
            is_paid: false,
            pay_url: paySubmitUrl
          }
        }, corsHeaders);
      }

      // 路由 3: 汇源支付异步回调通知 (Webhook)
      if (path === "/api/pay/notify") {
        let params = {};
        if (request.method === "POST") {
          const formData = await request.formData();
          for (const [k, v] of formData.entries()) params[k] = v;
        } else {
          url.searchParams.forEach((v, k) => { params[k] = v; });
        }

        const orderNo = params.out_trade_no;
        const tradeStatus = params.trade_status;
        const sign = params.sign;

        // 验证签名
        const expectedSign = await generateMD5Sign(params, env.PAY_KEY);
        if (sign !== expectedSign) {
          return new Response("fail: sign error", { status: 400 });
        }

        if (tradeStatus === "TRADE_SUCCESS") {
          // 查询该订单是否已处理
          const order = await env.DB.prepare("SELECT * FROM orders WHERE order_no = ?").bind(orderNo).first();
          if (order && order.status === 0) {
            // 从对应地区提取一张卡密
            const carmiRecord = await env.DB.prepare(
              "SELECT id, carmi FROM carmis WHERE (region = ? OR region = '通用') AND status = 0 ORDER BY RANDOM() LIMIT 1"
            ).bind(order.region).first();

            const finalCarmi = carmiRecord ? carmiRecord.carmi : "【库存告急】请联系平台客服补发！";

            if (carmiRecord) {
              await env.DB.prepare("UPDATE carmis SET status = 1, order_no = ?, sold_at = datetime('now') WHERE id = ?").bind(orderNo, carmiRecord.id).run();
            }

            // 更新订单为已支付并写入卡密
            await env.DB.prepare(
              "UPDATE orders SET status = 1, carmi = ?, paid_at = datetime('now') WHERE order_no = ?"
            ).bind(finalCarmi, orderNo).run();
          }
          return new Response("success");
        }

        return new Response("fail");
      }

      // 路由 4: 订单查询接口
      if (path === "/api/order/query") {
        const queryVal = (url.searchParams.get("keyword") || "").trim();
        if (!queryVal) {
          return jsonResponse({ code: -1, msg: "请输入订单号或联系方式查询" }, corsHeaders);
        }

        const orders = await env.DB.prepare(`
          SELECT order_no, region, contact, price, status, carmi, created_at, paid_at
          FROM orders
          WHERE order_no = ? OR contact = ?
          ORDER BY id DESC LIMIT 10
        `).bind(queryVal, queryVal).all();

        return jsonResponse({
          code: 0,
          data: orders.results || []
        }, corsHeaders);
      }

      // 路由 5: 管理员一键手动抓取同步
      if (path === "/api/admin/sync") {
        const key = url.searchParams.get("key") || "";
        if (key !== (env.ADMIN_KEY || "admin123456")) {
          return jsonResponse({ code: 403, msg: "管理员密钥错误" }, corsHeaders, 403);
        }
        const result = await syncAccountsFromSource(env);
        return jsonResponse({
          code: 0,
          msg: `同步完成！本次新增入库 ${result.inserted} 条卡密，总解析到 ${result.total} 条账号。`,
          data: result
        }, corsHeaders);
      }

      // 路由 6: 首页渲染前端页面
      if (path === "/" || path === "/index.html") {
        return new Response(getFrontendHTML(env), {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }

      return new Response("Not Found", { status: 404 });

    } catch (err) {
      console.error("系统错误:", err);
      return jsonResponse({ code: 500, msg: "服务器异常: " + err.message }, corsHeaders, 500);
    }
  }
};

/**
 * MD5 签名生成（适配汇源开放平台/标准易支付）
 */
async function generateMD5Sign(params, key) {
  const keys = Object.keys(params).filter(k => k !== "sign" && k !== "sign_type" && params[k] !== "" && params[k] !== undefined).sort();
  const signStr = keys.map(k => `${k}=${params[k]}`).join("&") + key;
  
  const msgUint8 = new TextEncoder().encode(signStr);
  const hashBuffer = await crypto.subtle.digest("MD5", msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 核心抓取与解析逻辑
 */
async function syncAccountsFromSource(env) {
  const targetUrl = env.TARGET_URL || "https://haogd.top/share/app";
  let inserted = 0;
  let total = 0;

  try {
    const res = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });

    const html = await res.text();

    const accountPattern = /(?:账号地区[：:]\s*([^\s\r\n<]+))?[\s\S]*?(?:账号[：:]\s*([a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+))[\s\S]*?(?:密码[：:]\s*([^\s\r\n<]+))/gi;
    const fallbackPattern = /([a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)\s+([a-zA-Z0-9!@#$%^&*()_+=\-`~]{6,30})/gi;

    let match;
    const accounts = [];

    while ((match = accountPattern.exec(html)) !== null) {
      const region = (match[1] || "通用").replace(/[^\u4e00-\u9fa5a-zA-Z]/g, "").trim() || "通用";
      const account = match[2].trim();
      const password = match[3].trim();
      if (account && password) {
        accounts.push({ region, account, password });
      }
    }

    if (accounts.length === 0) {
      while ((match = fallbackPattern.exec(html)) !== null) {
        const account = match[1].trim();
        const password = match[2].trim();
        accounts.push({ region: "美国", account, password });
      }
    }

    total = accounts.length;

    for (const item of accounts) {
      const carmi = `【${item.region}】账号: ${item.account} ---- 密码: ${item.password}`;
      try {
        const res = await env.DB.prepare(`
          INSERT INTO carmis (region, account, password, carmi, status, created_at)
          VALUES (?, ?, ?, ?, 0, datetime('now'))
        `).bind(item.region, item.account, item.password, carmi).run();

        if (res.meta && res.meta.changes > 0) {
          inserted++;
        }
      } catch (dbErr) {
        // 忽略重复卡密
      }
    }
    console.log(`✅ 抓取同步成功: 共解析 ${total} 条，成功新增入库 ${inserted} 条`);
  } catch (err) {
    console.error("❌ 抓取同步出错:", err);
  }

  return { total, inserted };
}

function jsonResponse(data, headers = {}, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers
    }
  });
}

/**
 * 现代化前端发卡页面
 */
function getFrontendHTML(env) {
  const siteName = env.SITE_NAME || "云账号智能发卡平台";
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${siteName} - 自动发卡网</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
  <style>
    body { background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #0f172a 100%); min-height: 100vh; color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .glass { background: rgba(30, 41, 59, 0.7); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.1); }
    .card-active { border-color: #6366f1; background: rgba(99, 102, 241, 0.15); box-shadow: 0 0 20px rgba(99, 102, 241, 0.3); }
  </style>
</head>
<body class="py-8 px-4 flex flex-col items-center">
  <div class="max-w-3xl w-full">
    <!-- Header -->
    <div class="text-center mb-8">
      <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-indigo-600/20 text-indigo-400 mb-4 border border-indigo-500/30">
        <i class="fa-solid fa-cloud-bolt text-2xl"></i>
      </div>
      <h1 class="text-3xl font-bold tracking-tight text-white mb-2">${siteName}</h1>
      <p class="text-slate-400 text-sm">24小时全自动发卡 · 实时抓取同步 · 付款秒出号</p>
    </div>

    <!-- 主卡片 -->
    <div class="glass rounded-2xl p-6 sm:p-8 shadow-2xl mb-6">
      <div class="flex border-b border-slate-700 mb-6">
        <button id="tab-buy" onclick="switchTab('buy')" class="py-2.5 px-6 font-medium text-indigo-400 border-b-2 border-indigo-500 flex items-center gap-2">
          <i class="fa-solid fa-cart-shopping"></i> 在线下单
        </button>
        <button id="tab-query" onclick="switchTab('query')" class="py-2.5 px-6 font-medium text-slate-400 hover:text-slate-200 flex items-center gap-2">
          <i class="fa-solid fa-magnifying-glass"></i> 订单查询
        </button>
      </div>

      <!-- 购买面板 -->
      <div id="panel-buy" class="space-y-6">
        <div>
          <label class="block text-sm font-medium text-slate-300 mb-3">选择地区分类：</label>
          <div id="region-list" class="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div class="p-4 rounded-xl border border-slate-700 bg-slate-800/50 animate-pulse text-center text-sm text-slate-400">加载库存中...</div>
          </div>
        </div>

        <div>
          <label class="block text-sm font-medium text-slate-300 mb-2">联系方式 (用于查单/找回卡密)：</label>
          <input type="text" id="contact" placeholder="填写您的邮箱或手机号" class="w-full px-4 py-3 rounded-xl bg-slate-800/80 border border-slate-700 text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 text-sm">
        </div>

        <!-- 支付方式选择 -->
        <div id="pay-type-container">
          <label class="block text-sm font-medium text-slate-300 mb-2">选择支付方式：</label>
          <div class="grid grid-cols-2 gap-3">
            <label class="p-3.5 rounded-xl border border-indigo-500 bg-indigo-500/10 flex items-center gap-3 cursor-pointer">
              <input type="radio" name="pay_type" value="alipay" checked class="text-indigo-600 focus:ring-indigo-500">
              <span class="text-sm font-medium text-white flex items-center gap-2"><i class="fa-brands fa-alipay text-blue-400 text-lg"></i> 支付宝</span>
            </label>
            <label class="p-3.5 rounded-xl border border-slate-700 bg-slate-800/50 flex items-center gap-3 cursor-pointer">
              <input type="radio" name="pay_type" value="wxpay" class="text-indigo-600 focus:ring-indigo-500">
              <span class="text-sm font-medium text-white flex items-center gap-2"><i class="fa-brands fa-weixin text-emerald-400 text-lg"></i> 微信支付</span>
            </label>
          </div>
        </div>

        <div class="pt-4 border-t border-slate-700/60 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div>
            <span class="text-sm text-slate-400">支付金额：</span>
            <span class="text-2xl font-bold text-indigo-400" id="display-price">￥1.00</span>
          </div>
          <button onclick="submitOrder()" id="btn-submit" class="w-full sm:w-auto px-8 py-3.5 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-semibold rounded-xl shadow-lg shadow-indigo-500/25 transition duration-200 flex items-center justify-center gap-2">
            <i class="fa-solid fa-bolt"></i> 立即下单付款
          </button>
        </div>
      </div>

      <!-- 订单查询面板 -->
      <div id="panel-query" class="space-y-6 hidden">
        <div>
          <label class="block text-sm font-medium text-slate-300 mb-2">输入订单号或联系方式：</label>
          <div class="flex gap-2">
            <input type="text" id="query-keyword" placeholder="输入订单号或购买时填写的联系方式" class="flex-1 px-4 py-3 rounded-xl bg-slate-800/80 border border-slate-700 text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 text-sm">
            <button onclick="queryOrders()" class="px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-xl transition">
              <i class="fa-solid fa-search"></i> 查询
            </button>
          </div>
        </div>
        <div id="query-results" class="space-y-3"></div>
      </div>
    </div>

    <!-- 弹窗：发卡结果 -->
    <div id="modal-result" class="fixed inset-0 bg-black/70 backdrop-blur-sm hidden flex items-center justify-center p-4 z-50">
      <div class="glass max-w-lg w-full rounded-2xl p-6 sm:p-8 shadow-2xl space-y-4 border border-indigo-500/30">
        <div class="text-center">
          <div class="w-12 h-12 bg-emerald-500/20 text-emerald-400 rounded-full flex items-center justify-center mx-auto mb-3 border border-emerald-500/30">
            <i class="fa-solid fa-check text-xl"></i>
          </div>
          <h3 class="text-xl font-bold text-white">提取卡密成功！</h3>
          <p class="text-xs text-slate-400 mt-1">订单号: <span id="res-order-no" class="font-mono text-indigo-300"></span></p>
        </div>

        <div class="bg-slate-900/90 rounded-xl p-4 border border-slate-800 space-y-3">
          <div>
            <span class="text-xs text-slate-400 block mb-1">账号密码：</span>
            <div id="res-carmi" class="text-sm font-mono text-emerald-400 select-all break-all bg-slate-950 p-3 rounded-lg border border-slate-800"></div>
          </div>
        </div>

        <div class="flex gap-3">
          <button onclick="copyCarmi()" class="flex-1 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-xl transition flex items-center justify-center gap-2">
            <i class="fa-solid fa-copy"></i> 一键复制卡密
          </button>
          <button onclick="closeModal()" class="px-5 py-3 bg-slate-700 hover:bg-slate-600 text-slate-200 font-medium rounded-xl transition">
            关闭
          </button>
        </div>
      </div>
    </div>

    <div class="text-center text-xs text-slate-500 space-y-2">
      <p>⚠️ 提示：账号仅供在 App Store 登录下载应用，切勿在系统设置中登录 iCloud！</p>
      <p>Powered by Cloudflare Workers & D1 Database</p>
    </div>
  </div>

  <script>
    let currentSelectedRegion = "美国";
    let loadedRegions = [];

    async function loadStats() {
      try {
        const res = await fetch("/api/stats");
        const json = await res.json();
        if (json.code === 0) {
          loadedRegions = json.data;
          document.getElementById("display-price").innerText = "￥" + json.price;
          renderRegions();
        }
      } catch (e) {
        console.error("加载失败", e);
      }
    }

    function renderRegions() {
      const container = document.getElementById("region-list");
      container.innerHTML = "";
      loadedRegions.forEach((r, idx) => {
        const isSelected = r.region === currentSelectedRegion || (idx === 0 && !currentSelectedRegion);
        if (isSelected) currentSelectedRegion = r.region;

        const card = document.createElement("div");
        card.className = "p-4 rounded-xl border cursor-pointer transition duration-150 flex flex-col justify-between " + 
                         (isSelected ? "card-active border-indigo-500" : "border-slate-700/80 bg-slate-800/40 hover:border-slate-600");
        card.onclick = () => {
          currentSelectedRegion = r.region;
          renderRegions();
        };

        card.innerHTML = \`
          <div class="flex items-center justify-between mb-2">
            <span class="font-medium text-white">\${r.region}</span>
            <span class="text-xs px-2 py-0.5 rounded-full \${r.stock > 0 ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-rose-500/20 text-rose-400'}">
              余量: \${r.stock}
            </span>
          </div>
          <div class="text-xs text-slate-400">已售: \${r.sold}</div>
        \`;
        container.appendChild(card);
      });
    }

    async function submitOrder() {
      const contact = document.getElementById("contact").value.trim();
      const payType = document.querySelector('input[name="pay_type"]:checked').value;
      const btn = document.getElementById("btn-submit");
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 处理中...';

      try {
        const res = await fetch("/api/order/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ region: currentSelectedRegion, contact: contact, pay_type: payType })
        });
        const data = await res.json();
        if (data.code === 0) {
          if (data.data.pay_url) {
            // 跳转到汇源支付收银台
            window.location.href = data.data.pay_url;
          } else if (data.data.is_paid) {
            // 直接出卡展示
            document.getElementById("res-order-no").innerText = data.data.order_no;
            document.getElementById("res-carmi").innerText = data.data.carmi;
            document.getElementById("modal-result").classList.remove("hidden");
            loadStats();
          }
        } else {
          alert(data.msg || "创建订单失败");
        }
      } catch (err) {
        alert("请求异常，请稍后重试");
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-bolt"></i> 立即下单付款';
      }
    }

    async function queryOrders() {
      const kw = document.getElementById("query-keyword").value.trim();
      if (!kw) return alert("请输入查询关键词");

      const resBox = document.getElementById("query-results");
      resBox.innerHTML = '<div class="text-center text-slate-400 text-sm py-4">查询中...</div>';

      try {
        const res = await fetch("/api/order/query?keyword=" + encodeURIComponent(kw));
        const json = await res.json();
        if (json.code === 0 && json.data.length > 0) {
          resBox.innerHTML = json.data.map(o => \`
            <div class="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-2">
              <div class="flex justify-between items-center text-xs text-slate-400">
                <span>订单号: \${o.order_no}</span>
                <span class="text-indigo-400">\${o.region}</span>
              </div>
              <div class="text-sm font-mono text-emerald-400 bg-slate-950 p-2.5 rounded border border-slate-800 select-all break-all">
                \${o.status === 1 ? o.carmi : '<span class="text-amber-400">待支付/处理中</span>'}
              </div>
              <div class="text-xs text-slate-500">下单时间: \${o.created_at}</div>
            </div>
          \`).join("");
        } else {
          resBox.innerHTML = '<div class="text-center text-slate-500 text-sm py-4">未查询到相关订单记录</div>';
        }
      } catch (e) {
        resBox.innerHTML = '<div class="text-center text-rose-400 text-sm py-4">查询失败</div>';
      }
    }

    // 检查 URL 是否带 order_no 跳转回来查单
    function checkUrlOrder() {
      const params = new URLSearchParams(window.location.search);
      const orderNo = params.get("order_no");
      if (orderNo) {
        switchTab('query');
        document.getElementById("query-keyword").value = orderNo;
        queryOrders();
      }
    }

    function switchTab(tab) {
      if (tab === 'buy') {
        document.getElementById("panel-buy").classList.remove("hidden");
        document.getElementById("panel-query").classList.add("hidden");
        document.getElementById("tab-buy").className = "py-2.5 px-6 font-medium text-indigo-400 border-b-2 border-indigo-500 flex items-center gap-2";
        document.getElementById("tab-query").className = "py-2.5 px-6 font-medium text-slate-400 hover:text-slate-200 flex items-center gap-2";
      } else {
        document.getElementById("panel-buy").classList.add("hidden");
        document.getElementById("panel-query").classList.remove("hidden");
        document.getElementById("tab-query").className = "py-2.5 px-6 font-medium text-indigo-400 border-b-2 border-indigo-500 flex items-center gap-2";
        document.getElementById("tab-buy").className = "py-2.5 px-6 font-medium text-slate-400 hover:text-slate-200 flex items-center gap-2";
      }
    }

    function copyCarmi() {
      const text = document.getElementById("res-carmi").innerText;
      navigator.clipboard.writeText(text).then(() => alert("卡密已成功复制到剪贴板！"));
    }

    function closeModal() {
      document.getElementById("modal-result").classList.add("hidden");
    }

    loadStats();
    checkUrlOrder();
  </script>
</body>
</html>`;
}
