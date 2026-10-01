/**
 * Cloudflare Worker - 智能自动抓取发卡系统 (0成本个人收款码核销版)
 * 支持：自动抓取目标站账号、多地区库存、微信赞赏码/个人收款码支付、手机端管理后台一键核销发卡
 */

export default {
  // 1. 定时任务：自动抓取目标网站账号入库
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
      // 路由 1: 获取各地区库存统计及网站配置
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
          pay_qrcode: env.PAY_QRCODE_URL || "https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=300" // 收款码图片
        }, corsHeaders);
      }

      // 路由 2: 买家创建订单（生成专属4位核销码）
      if (path === "/api/order/create" && request.method === "POST") {
        const body = await request.json();
        const region = body.region || "美国";
        const contact = (body.contact || "").trim();

        // 检查库存
        const countRes = await env.DB.prepare(
          "SELECT COUNT(*) as cnt FROM carmis WHERE (region = ? OR region = '通用') AND status = 0"
        ).bind(region).first();

        if (!countRes || countRes.cnt <= 0) {
          return jsonResponse({ code: -1, msg: `当前【${region}】库存不足，请稍后再试或联系站长补货！` }, corsHeaders);
        }

        // 生成唯一订单号及简短 4 位核销码（方便买家在微信付款时备注）
        const checkCode = Math.floor(1000 + Math.random() * 9000).toString();
        const orderNo = "FK" + Date.now().toString().slice(-6) + checkCode;
        const price = parseFloat(env.PRICE_PER_ACCOUNT || "1.00");

        // 插入待付款/待核销订单 (status = 0)
        await env.DB.prepare(`
          INSERT INTO orders (order_no, region, contact, price, status, pay_type, created_at)
          VALUES (?, ?, ?, ?, 0, ?, datetime('now'))
        `).bind(orderNo, region, contact, price, `核销码:${checkCode}`).run();

        return jsonResponse({
          code: 0,
          msg: "订单创建成功",
          data: {
            order_no: orderNo,
            check_code: checkCode,
            price: price.toFixed(2),
            region: region
          }
        }, corsHeaders);
      }

      // 路由 3: 轮询检查订单状态（买家付款后页面自动查询出卡）
      if (path === "/api/order/check") {
        const orderNo = url.searchParams.get("order_no");
        if (!orderNo) return jsonResponse({ code: -1, msg: "缺少订单号" }, corsHeaders);

        const order = await env.DB.prepare("SELECT order_no, status, carmi, region FROM orders WHERE order_no = ?").bind(orderNo).first();
        if (!order) return jsonResponse({ code: -1, msg: "订单不存在" }, corsHeaders);

        return jsonResponse({
          code: 0,
          status: order.status, // 0=待核销, 1=已发卡
          carmi: order.carmi || "",
          region: order.region
        }, corsHeaders);
      }

      // 路由 4: 管理员后台 - 获取待核销订单列表与所有数据
      if (path === "/api/admin/orders") {
        const key = url.searchParams.get("key") || "";
        if (key !== (env.ADMIN_KEY || "admin123456")) {
          return jsonResponse({ code: 403, msg: "管理员密钥错误" }, corsHeaders, 403);
        }

        const pendingOrders = await env.DB.prepare(`
          SELECT id, order_no, region, contact, price, status, pay_type, created_at
          FROM orders
          WHERE status = 0
          ORDER BY id DESC LIMIT 50
        `).all();

        const recentPaid = await env.DB.prepare(`
          SELECT id, order_no, region, contact, price, status, carmi, paid_at
          FROM orders
          WHERE status = 1
          ORDER BY id DESC LIMIT 15
        `).all();

        return jsonResponse({
          code: 0,
          pending: pendingOrders.results || [],
          recent: recentPaid.results || []
        }, corsHeaders);
      }

      // 路由 5: 管理员后台 - 一键核销并发卡
      if (path === "/api/admin/approve" && request.method === "POST") {
        const body = await request.json();
        const key = body.key || "";
        if (key !== (env.ADMIN_KEY || "admin123456")) {
          return jsonResponse({ code: 403, msg: "管理员密钥错误" }, corsHeaders, 403);
        }

        const orderNo = body.order_no;
        const order = await env.DB.prepare("SELECT * FROM orders WHERE order_no = ? AND status = 0").bind(orderNo).first();
        if (!order) {
          return jsonResponse({ code: -1, msg: "订单不存在或已被核销" }, corsHeaders);
        }

        // 从对应地区库存取出一张卡密
        const carmiRecord = await env.DB.prepare(
          "SELECT id, carmi FROM carmis WHERE (region = ? OR region = '通用') AND status = 0 ORDER BY RANDOM() LIMIT 1"
        ).bind(order.region).first();

        if (!carmiRecord) {
          return jsonResponse({ code: -1, msg: `库存告急：【${order.region}】暂无可用的有效卡密，请先抓取同步！` }, corsHeaders);
        }

        // 标记卡密已售
        await env.DB.prepare("UPDATE carmis SET status = 1, order_no = ?, sold_at = datetime('now') WHERE id = ?").bind(orderNo, carmiRecord.id).run();

        // 标记订单已完成
        await env.DB.prepare("UPDATE orders SET status = 1, carmi = ?, paid_at = datetime('now') WHERE order_no = ?").bind(carmiRecord.carmi, orderNo).run();

        return jsonResponse({
          code: 0,
          msg: "核销成功，已自动为买家出卡！",
          carmi: carmiRecord.carmi
        }, corsHeaders);
      }

      // 路由 6: 管理员一键手动抓取同步
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

      // 路由 7: 历史订单查询
      if (path === "/api/order/query") {
        const queryVal = (url.searchParams.get("keyword") || "").trim();
        if (!queryVal) return jsonResponse({ code: -1, msg: "请输入订单号或联系方式" }, corsHeaders);

        const orders = await env.DB.prepare(`
          SELECT order_no, region, contact, price, status, carmi, created_at, paid_at
          FROM orders
          WHERE order_no = ? OR contact = ?
          ORDER BY id DESC LIMIT 10
        `).bind(queryVal, queryVal).all();

        return jsonResponse({ code: 0, data: orders.results || [] }, corsHeaders);
      }

      // 路由 8: 管理员控制台页面 (/admin)
      if (path === "/admin") {
        return new Response(getAdminHTML(env), {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }

      // 路由 9: 买家前台首页
      if (path === "/" || path === "/index.html") {
        return new Response(getFrontendHTML(env), {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }

      return new Response("Not Found", { status: 404 });

    } catch (err) {
      console.error("系统异常:", err);
      return jsonResponse({ code: 500, msg: "服务器异常: " + err.message }, corsHeaders, 500);
    }
  }
};

/**
 * 抓取与解析逻辑
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
      if (account && password) accounts.push({ region, account, password });
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

        if (res.meta && res.meta.changes > 0) inserted++;
      } catch (dbErr) {}
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
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers }
  });
}

/**
 * 买家前台页面
 */
function getFrontendHTML(env) {
  const siteName = env.SITE_NAME || "云账号智能发卡平台";
  const payQrcode = env.PAY_QRCODE_URL || "https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=请在CF后台设置PAY_QRCODE_URL填入您的微信赞赏码";
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
      <p class="text-slate-400 text-sm">24小时自动发卡 · 实时抓取同步 · 微信扫码即出号</p>
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

        <div class="pt-4 border-t border-slate-700/60 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div>
            <span class="text-sm text-slate-400">应付金额：</span>
            <span class="text-2xl font-bold text-indigo-400" id="display-price">￥1.00</span>
          </div>
          <button onclick="submitOrder()" id="btn-submit" class="w-full sm:w-auto px-8 py-3.5 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-semibold rounded-xl shadow-lg shadow-indigo-500/25 transition duration-200 flex items-center justify-center gap-2">
            <i class="fa-solid fa-qrcode"></i> 立即扫码付款出卡
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

    <!-- 弹窗 1：扫码付款弹窗 -->
    <div id="modal-pay" class="fixed inset-0 bg-black/80 backdrop-blur-md hidden flex items-center justify-center p-4 z-50">
      <div class="glass max-w-sm w-full rounded-2xl p-6 shadow-2xl space-y-4 border border-indigo-500/40 text-center">
        <h3 class="text-lg font-bold text-white flex items-center justify-center gap-2">
          <i class="fa-brands fa-weixin text-emerald-400 text-xl"></i> 微信扫码付款
        </h3>
        
        <div class="p-2 bg-white rounded-xl inline-block shadow-inner mx-auto">
          <img id="pay-qr-img" src="${payQrcode}" alt="微信收款码" class="w-48 h-48 rounded-lg object-contain mx-auto">
        </div>

        <div class="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 text-left space-y-1">
          <div class="text-xs text-amber-300 font-medium">⚠️ 付款关键步骤：</div>
          <div class="text-xs text-slate-300 leading-relaxed">
            1. 扫码支付金额：<span class="text-emerald-400 font-bold" id="pay-money">￥1.00</span><br>
            2. 微信付款备注填写：<span class="text-xl font-black text-amber-400 font-mono select-all" id="pay-check-code">8888</span>
          </div>
        </div>

        <div class="text-xs text-slate-400 flex items-center justify-center gap-2">
          <i class="fa-solid fa-spinner fa-spin text-indigo-400"></i> 付款后正在自动检测出卡中...
        </div>

        <button onclick="cancelPay()" class="w-full py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium rounded-xl text-sm transition">
          取消 / 返回
        </button>
      </div>
    </div>

    <!-- 弹窗 2：发卡成功结果 -->
    <div id="modal-result" class="fixed inset-0 bg-black/80 backdrop-blur-md hidden flex items-center justify-center p-4 z-50">
      <div class="glass max-w-lg w-full rounded-2xl p-6 sm:p-8 shadow-2xl space-y-4 border border-emerald-500/40">
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
            完成
          </button>
        </div>
      </div>
    </div>

    <div class="text-center text-xs text-slate-500 space-y-2">
      <p>⚠️ 提示：账号仅供在 App Store 登录下载应用，切勿在系统设置中登录 iCloud！</p>
      <p><a href="/admin" class="hover:text-indigo-400">管理后台</a> · Powered by Cloudflare Workers & D1</p>
    </div>
  </div>

  <script>
    let currentSelectedRegion = "美国";
    let loadedRegions = [];
    let currentOrderNo = null;
    let pollTimer = null;

    async function loadStats() {
      try {
        const res = await fetch("/api/stats");
        const json = await res.json();
        if (json.code === 0) {
          loadedRegions = json.data;
          document.getElementById("display-price").innerText = "￥" + json.price;
          if (json.pay_qrcode) document.getElementById("pay-qr-img").src = json.pay_qrcode;
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
      const btn = document.getElementById("btn-submit");
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在生成支付核销单...';

      try {
        const res = await fetch("/api/order/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ region: currentSelectedRegion, contact: contact })
        });
        const data = await res.json();
        if (data.code === 0) {
          currentOrderNo = data.data.order_no;
          document.getElementById("pay-money").innerText = "￥" + data.data.price;
          document.getElementById("pay-check-code").innerText = data.data.check_code;
          document.getElementById("modal-pay").classList.remove("hidden");

          // 开始轮询检查订单是否核销
          startPolling();
        } else {
          alert(data.msg || "创建订单失败");
        }
      } catch (err) {
        alert("网络异常，请重试");
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-qrcode"></i> 立即扫码付款出卡';
      }
    }

    function startPolling() {
      clearInterval(pollTimer);
      pollTimer = setInterval(async () => {
        if (!currentOrderNo) return;
        try {
          const res = await fetch("/api/order/check?order_no=" + currentOrderNo);
          const json = await res.json();
          if (json.code === 0 && json.status === 1) {
            // 已出卡！
            clearInterval(pollTimer);
            document.getElementById("modal-pay").classList.add("hidden");
            document.getElementById("res-order-no").innerText = currentOrderNo;
            document.getElementById("res-carmi").innerText = json.carmi;
            document.getElementById("modal-result").classList.remove("hidden");
            loadStats();
          }
        } catch (e) {}
      }, 2500);
    }

    function cancelPay() {
      clearInterval(pollTimer);
      document.getElementById("modal-pay").classList.add("hidden");
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
                \${o.status === 1 ? o.carmi : '<span class="text-amber-400">待核销付款中</span>'}
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
  </script>
</body>
</html>`;
}

/**
 * 站长手机端管理后台页面 (/admin)
 */
function getAdminHTML(env) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>发卡网管理后台</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
  <style>body { background: #0f172a; color: #f8fafc; font-family: sans-serif; }</style>
</head>
<body class="p-4 max-w-2xl mx-auto">
  <div class="mb-6 flex justify-between items-center border-b border-slate-800 pb-4">
    <h1 class="text-xl font-bold flex items-center gap-2 text-indigo-400">
      <i class="fa-solid fa-shield-halved"></i> 站长核销与库存管理
    </h1>
    <a href="/" class="text-xs text-slate-400 hover:text-white">返回首页</a>
  </div>

  <div class="space-y-4">
    <!-- 管理秘钥输入 -->
    <div class="p-4 rounded-xl bg-slate-900 border border-slate-800 flex gap-2">
      <input type="password" id="admin-key" placeholder="输入管理员密钥 (默认: admin123456)" value="admin123456" class="flex-1 px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm text-white">
      <button onclick="loadAdminData()" class="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-medium">刷新</button>
      <button onclick="syncNow()" class="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-sm font-medium flex items-center gap-1">
        <i class="fa-solid fa-rotate"></i> 抓取同步
      </button>
    </div>

    <!-- 待核销订单列表 -->
    <div class="p-4 rounded-xl bg-slate-900 border border-slate-800 space-y-3">
      <h2 class="font-bold text-amber-400 flex items-center gap-2 text-sm">
        <i class="fa-solid fa-bell"></i> 待核销订单（买家扫码付款后点击发卡）
      </h2>
      <div id="pending-list" class="space-y-2">
        <div class="text-slate-500 text-xs py-2 text-center">点击刷新加载数据</div>
      </div>
    </div>

    <!-- 最近已出卡记录 -->
    <div class="p-4 rounded-xl bg-slate-900 border border-slate-800 space-y-3">
      <h2 class="font-bold text-slate-300 text-sm">最近已发卡记录</h2>
      <div id="recent-list" class="space-y-2"></div>
    </div>
  </div>

  <script>
    async function loadAdminData() {
      const key = document.getElementById("admin-key").value.trim();
      const pBox = document.getElementById("pending-list");
      const rBox = document.getElementById("recent-list");
      pBox.innerHTML = '<div class="text-xs text-slate-400 text-center py-2">加载中...</div>';

      try {
        const res = await fetch("/api/admin/orders?key=" + encodeURIComponent(key));
        const json = await res.json();
        if (json.code === 0) {
          if (json.pending.length === 0) {
            pBox.innerHTML = '<div class="text-xs text-slate-500 text-center py-2">暂无待核销订单</div>';
          } else {
            pBox.innerHTML = json.pending.map(o => \`
              <div class="p-3 rounded-lg bg-slate-800 border border-slate-700 flex justify-between items-center gap-2">
                <div class="text-xs space-y-1">
                  <div class="font-mono text-white font-bold">\${o.order_no} | <span class="text-indigo-400">\${o.region}</span></div>
                  <div class="text-amber-400 font-bold">\${o.pay_type} | 金额: ￥\${o.price}</div>
                  <div class="text-slate-500">\${o.created_at}</div>
                </div>
                <button onclick="approveOrder('\${o.order_no}')" class="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-lg text-xs shadow-lg flex items-center gap-1">
                  <i class="fa-solid fa-check"></i> 确认发卡
                </button>
              </div>
            \`).join("");
          }

          rBox.innerHTML = json.recent.map(o => \`
            <div class="p-2.5 rounded-lg bg-slate-800/60 text-xs border border-slate-700/60 space-y-1">
              <div class="flex justify-between text-slate-400">
                <span>\${o.order_no} (\${o.region})</span>
                <span class="text-emerald-400 font-mono">\${o.paid_at}</span>
              </div>
              <div class="text-slate-300 font-mono select-all break-all">\${o.carmi}</div>
            </div>
          \`).join("");
        } else {
          alert(json.msg || "密钥错误");
        }
      } catch (e) {
        alert("请求失败");
      }
    }

    async function approveOrder(orderNo) {
      const key = document.getElementById("admin-key").value.trim();
      if (!confirm("确认已收到该笔微信款项并为买家出卡？")) return;

      try {
        const res = await fetch("/api/admin/approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key, order_no: orderNo })
        });
        const json = await res.json();
        if (json.code === 0) {
          alert("✅ 发卡成功！买家端已自动同步显示卡密。");
          loadAdminData();
        } else {
          alert(json.msg || "核销失败");
        }
      } catch (e) {
        alert("网络错误");
      }
    }

    async function syncNow() {
      const key = document.getElementById("admin-key").value.trim();
      try {
        const res = await fetch("/api/admin/sync?key=" + encodeURIComponent(key));
        const json = await res.json();
        alert(json.msg);
      } catch (e) {
        alert("同步请求失败");
      }
    }

    loadAdminData();
  </script>
</body>
</html>`;
}
