/**
 * Cloudflare Worker - 智能自动抓取发卡系统
 * 支持：Cron 定时自动抓取、地区分类库存、自动发卡、订单查询、管理面板
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

    // CORS 响应头
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
          price: env.PRICE_PER_ACCOUNT || "1.00"
        }, corsHeaders);
      }

      // 路由 2: 创建订单并自动发卡
      if (path === "/api/order/create" && request.method === "POST") {
        const body = await request.json();
        const region = body.region || "美国";
        const contact = (body.contact || "").trim();
        const payType = body.pay_type || "free"; // 默认为测试/免费体验或易支付

        // 1. 检查该地区是否有可用库存
        const carmiRecord = await env.DB.prepare(
          "SELECT id, region, account, password, carmi FROM carmis WHERE region = ? AND status = 0 ORDER BY RANDOM() LIMIT 1"
        ).bind(region).first();

        // 如果指定地区没有库存，尝试取通用库存
        let finalCarmi = carmiRecord;
        if (!finalCarmi) {
          finalCarmi = await env.DB.prepare(
            "SELECT id, region, account, password, carmi FROM carmis WHERE status = 0 ORDER BY RANDOM() LIMIT 1"
          ).first();
        }

        if (!finalCarmi) {
          return jsonResponse({ code: -1, msg: `当前【${region}】库存不足，请稍后重试或联系客服补货！` }, corsHeaders);
        }

        // 2. 生成订单号
        const orderNo = "FK" + Date.now() + Math.floor(Math.random() * 1000).toString().padStart(3, "0");
        const price = parseFloat(env.PRICE_PER_ACCOUNT || "1.00");

        // 3. 标记卡密为已售出
        await env.DB.prepare(
          "UPDATE carmis SET status = 1, order_no = ?, sold_at = datetime('now') WHERE id = ?"
        ).bind(orderNo, finalCarmi.id).run();

        // 4. 创建订单记录
        await env.DB.prepare(`
          INSERT INTO orders (order_no, region, contact, price, status, carmi, pay_type, created_at, paid_at)
          VALUES (?, ?, ?, ?, 1, ?, ?, datetime('now'), datetime('now'))
        `).bind(orderNo, region, contact, price, finalCarmi.carmi, payType).run();

        return jsonResponse({
          code: 0,
          msg: "购买成功，卡密已发放！",
          data: {
            order_no: orderNo,
            region: finalCarmi.region,
            carmi: finalCarmi.carmi,
            account: finalCarmi.account,
            password: finalCarmi.password
          }
        }, corsHeaders);
      }

      // 路由 3: 订单查询接口
      if (path === "/api/order/query") {
        const queryVal = (url.searchParams.get("keyword") || "").trim();
        if (!queryVal) {
          return jsonResponse({ code: -1, msg: "请输入订单号或联系方式查询" }, corsHeaders);
        }

        const orders = await env.DB.prepare(`
          SELECT order_no, region, contact, price, status, carmi, created_at
          FROM orders
          WHERE order_no = ? OR contact = ?
          ORDER BY id DESC LIMIT 10
        `).bind(queryVal, queryVal).all();

        return jsonResponse({
          code: 0,
          data: orders.results || []
        }, corsHeaders);
      }

      // 路由 4: 管理员一键手动抓取同步
      if (path === "/api/admin/sync") {
        const key = url.searchParams.get("key") || "";
        const expectedKey = env.ADMIN_KEY || "admin123456";
        if (key !== expectedKey) {
          return jsonResponse({ code: 403, msg: "管理员密钥错误" }, corsHeaders, 403);
        }

        const result = await syncAccountsFromSource(env);
        return jsonResponse({
          code: 0,
          msg: `同步完成！本次新增入库 ${result.inserted} 条卡密，总解析到 ${result.total} 条账号。`,
          data: result
        }, corsHeaders);
      }

      // 路由 5: 首页渲染前端页面
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

    // 匹配包含地区、账号、密码的卡片块
    // 兼容多种页面渲染结构
    const accountPattern = /(?:账号地区[：:]\s*([^\s\r\n<]+))?[\s\S]*?(?:账号[：:]\s*([a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+))[\s\S]*?(?:密码[：:]\s*([^\s\r\n<]+))/gi;
    
    // 备用正则：直接提取邮箱和紧随其后的密码
    const fallbackPattern = /([a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)\s+([a-zA-Z0-9!@#$%^&*()_+=\-`~]{6,30})/gi;

    let match;
    const accounts = [];

    // 尝试主匹配
    while ((match = accountPattern.exec(html)) !== null) {
      const region = (match[1] || "通用").replace(/[^\u4e00-\u9fa5a-zA-Z]/g, "").trim() || "通用";
      const account = match[2].trim();
      const password = match[3].trim();
      if (account && password) {
        accounts.push({ region, account, password });
      }
    }

    // 如果主匹配数量较少，使用备用正则补充
    if (accounts.length === 0) {
      while ((match = fallbackPattern.exec(html)) !== null) {
        const account = match[1].trim();
        const password = match[2].trim();
        accounts.push({ region: "美国", account, password });
      }
    }

    total = accounts.length;

    // 批量写入 D1
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
        // UNIQUE 约束跳过已存在的卡密
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
 * 现代化前端发卡页面 (单页集成，极速加载)
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
      <p class="text-slate-400 text-sm">24小时全自动发卡 · 实时抓取同步 · 极速出号</p>
    </div>

    <!-- 主卡片 -->
    <div class="glass rounded-2xl p-6 sm:p-8 shadow-2xl mb-6">
      <!-- 标签页切换 -->
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
        <!-- 地区分类选择 -->
        <div>
          <label class="block text-sm font-medium text-slate-300 mb-3">选择地区分类：</label>
          <div id="region-list" class="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div class="p-4 rounded-xl border border-slate-700 bg-slate-800/50 animate-pulse text-center text-sm text-slate-400">加载库存中...</div>
          </div>
        </div>

        <!-- 联系方式 -->
        <div>
          <label class="block text-sm font-medium text-slate-300 mb-2">联系方式 (查询卡密凭证)：</label>
          <input type="text" id="contact" placeholder="填写邮箱或手机号 (以便后续找回卡密)" class="w-full px-4 py-3 rounded-xl bg-slate-800/80 border border-slate-700 text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 text-sm">
        </div>

        <!-- 价格结算与购买按钮 -->
        <div class="pt-4 border-t border-slate-700/60 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div>
            <span class="text-sm text-slate-400">支付金额：</span>
            <span class="text-2xl font-bold text-indigo-400" id="display-price">￥1.00</span>
          </div>
          <button onclick="submitOrder()" id="btn-submit" class="w-full sm:w-auto px-8 py-3.5 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-semibold rounded-xl shadow-lg shadow-indigo-500/25 transition duration-200 flex items-center justify-center gap-2">
            <i class="fa-solid fa-bolt"></i> 立即购买并提取卡密
          </button>
        </div>
      </div>

      <!-- 订单查询面板 -->
      <div id="panel-query" class="space-y-6 hidden">
        <div>
          <label class="block text-sm font-medium text-slate-300 mb-2">输入订单号或联系方式：</label>
          <div class="flex gap-2">
            <input type="text" id="query-keyword" placeholder="输入订单号或之前填写的邮箱/手机号" class="flex-1 px-4 py-3 rounded-xl bg-slate-800/80 border border-slate-700 text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 text-sm">
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
            <span class="text-xs text-slate-400 block mb-1">账号密码卡密：</span>
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

    <!-- 页脚与说明 -->
    <div class="text-center text-xs text-slate-500 space-y-2">
      <p>⚠️ 注意：账号仅供登录 App Store 下载应用，严禁在系统设置中登录 iCloud，避免锁机！</p>
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
        console.error("加载数据失败", e);
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
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在出卡中...';

      try {
        const res = await fetch("/api/order/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ region: currentSelectedRegion, contact: contact })
        });
        const data = await res.json();
        if (data.code === 0) {
          document.getElementById("res-order-no").innerText = data.data.order_no;
          document.getElementById("res-carmi").innerText = data.data.carmi;
          document.getElementById("modal-result").classList.remove("hidden");
          loadStats();
        } else {
          alert(data.msg || "出卡失败");
        }
      } catch (err) {
        alert("网络请求失败，请稍后重试");
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-bolt"></i> 立即购买并提取卡密';
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
                \${o.carmi}
              </div>
              <div class="text-xs text-slate-500">购买时间: \${o.created_at}</div>
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
