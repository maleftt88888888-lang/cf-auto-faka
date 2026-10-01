/**
 * Cloudflare Worker - 智能自动发卡系统 (方案B：极简极速手机确认出卡版)
 * 100% 防白嫖 · 0服务器成本 · 手机后台一键秒发 · 实时穿透抓取最新账号
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
      // 确保数据库表结构完整
      await ensureDbMigrated(env);

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

        let qrcode = env.PAY_QRCODE_URL || "";
        let currentPrice = env.PRICE_PER_ACCOUNT || "4.99";
        try {
          const qrRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'PAY_QRCODE'").first();
          if (qrRow && qrRow.value) qrcode = qrRow.value;

          const priceRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'PRICE'").first();
          if (priceRow && priceRow.value) currentPrice = priceRow.value;
        } catch (e) {}

        return jsonResponse({
          code: 0,
          data: Object.values(regionMap),
          site_name: env.SITE_NAME || "小火箭账号",
          price: parseFloat(currentPrice).toFixed(2),
          pay_qrcode: qrcode || "https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=300"
        }, corsHeaders);
      }

      // 路由 2: 买家创建订单
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

        let basePriceStr = env.PRICE_PER_ACCOUNT || "4.99";
        try {
          const priceRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'PRICE'").first();
          if (priceRow && priceRow.value) basePriceStr = priceRow.value;
        } catch (e) {}
        const price = parseFloat(basePriceStr);

        const checkCode = Math.floor(1000 + Math.random() * 9000).toString();
        const orderNo = "FK" + Date.now().toString().slice(-6) + checkCode;

        await env.DB.prepare(`
          INSERT INTO orders (order_no, region, contact, price, status, pay_type, created_at, replace_count)
          VALUES (?, ?, ?, ?, 0, ?, datetime('now', '+8 hours'), 0)
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

      // 路由 2.5: 买家点击“我已付款，通知站长发货”
      if (path === "/api/order/notify_paid" && request.method === "POST") {
        const body = await request.json();
        const orderNo = (body.order_no || "").trim();
        const note = (body.note || "").trim();

        if (!orderNo) return jsonResponse({ code: -1, msg: "缺少订单号" }, corsHeaders);

        const order = await env.DB.prepare("SELECT * FROM orders WHERE order_no = ?").bind(orderNo).first();
        if (!order) return jsonResponse({ code: -1, msg: "订单不存在" }, corsHeaders);

        if (order.status === 1) {
          return jsonResponse({ code: 0, msg: "订单已完成发货！" }, corsHeaders);
        }

        const payTypeDesc = note ? `买家已付款(备注:${note})` : `买家已提交付款申请`;
        await env.DB.prepare("UPDATE orders SET pay_type = ? WHERE order_no = ?").bind(payTypeDesc, orderNo).run();

        return jsonResponse({ code: 0, msg: "已成功通知站长核对发货！页面将自动保持轮询出卡..." }, corsHeaders);
      }

      // 路由 3: 站长后台一键确认收款并自动出卡 (抓取源站最新账号)
      if (path === "/api/admin/approve" && request.method === "POST") {
        const body = await request.json();
        const key = body.key || "";
        if (key !== (env.ADMIN_KEY || "51245124")) {
          return jsonResponse({ code: 403, msg: "管理员密钥错误" }, corsHeaders, 403);
        }

        const orderNo = body.order_no;
        const order = await env.DB.prepare("SELECT * FROM orders WHERE order_no = ? AND status = 0").bind(orderNo).first();
        if (!order) return jsonResponse({ code: -1, msg: "订单不存在或已被核销" }, corsHeaders);

        console.log(`⚡ 站长确认收款，正在从原站获取【${order.region}】最新可用账号...`);
        const freshAccount = await fetchLatestLiveAccount(env, order.region);

        if (!freshAccount || !freshAccount.carmi) {
          return jsonResponse({ code: -1, msg: `原网站暂无可用的【${order.region}】账号，请稍后再试！` }, corsHeaders);
        }

        if (freshAccount.id) {
          await env.DB.prepare("UPDATE carmis SET status = 1, order_no = ?, sold_at = datetime('now', '+8 hours') WHERE id = ?").bind(orderNo, freshAccount.id).run();
        }
        await env.DB.prepare(`
          UPDATE orders 
          SET status = 1, carmi = ?, pay_type = '站长已核销', paid_at = datetime('now', '+8 hours'), replace_count = 0
          WHERE order_no = ?
        `).bind(freshAccount.carmi, orderNo).run();

        return jsonResponse({
          code: 0,
          msg: "✅ 发卡成功！买家屏幕已自动同步弹出账号和密码！",
          carmi: freshAccount.carmi
        }, corsHeaders);
      }

      // 路由 3.5: 密码错误自助换号（方案4：严格限制2小时内且最多1次）
      if (path === "/api/order/replace" && request.method === "POST") {
        const body = await request.json();
        const orderNo = (body.order_no || "").trim();

        if (!orderNo) return jsonResponse({ code: -1, msg: "缺少订单号" }, corsHeaders);

        const order = await env.DB.prepare("SELECT * FROM orders WHERE order_no = ? AND status = 1").bind(orderNo).first();
        if (!order) return jsonResponse({ code: -1, msg: "未找到已完成的有效订单" }, corsHeaders);

        const warranty = getOrderWarrantyInfo(order);
        if (!warranty.can_replace) {
          if (warranty.is_expired) {
            return jsonResponse({ code: -1, msg: "⚠️ 该订单已超过 2 小时售后保修期，已永久锁定归档！如需最新账号请重新下单购买。" }, corsHeaders);
          }
          if (warranty.is_limit_reached) {
            return jsonResponse({ code: -1, msg: "⚠️ 该订单已达到最大免费换号次数（上限 1 次），卡密已锁定。" }, corsHeaders);
          }
          return jsonResponse({ code: -1, msg: "该订单当前不可换号" }, corsHeaders);
        }

        console.log(`🔄 买家针对订单 ${orderNo} 申请换号（限额 1 次），正在实时抓取源站最新账号...`);
        const freshAccount = await fetchLatestLiveAccount(env, order.region);

        if (!freshAccount || !freshAccount.carmi) {
          return jsonResponse({ code: -1, msg: "原网站暂无可替换的新账号，请稍后再试！" }, corsHeaders);
        }

        const newReplaceCount = (order.replace_count || 0) + 1;
        await env.DB.prepare(`
          UPDATE orders 
          SET carmi = ?, replace_count = ?
          WHERE order_no = ?
        `).bind(freshAccount.carmi, newReplaceCount, orderNo).run();

        if (freshAccount.id) {
          await env.DB.prepare("UPDATE carmis SET status = 1, order_no = ?, sold_at = datetime('now', '+8 hours') WHERE id = ?").bind(orderNo, freshAccount.id).run();
        }

        const newOrder = await env.DB.prepare("SELECT * FROM orders WHERE order_no = ?").bind(orderNo).first();
        const newWarranty = getOrderWarrantyInfo(newOrder);

        return jsonResponse({
          code: 0,
          msg: "🎉 已为您从源站成功获取并换发最新账号！",
          data: {
            order_no: orderNo,
            carmi: freshAccount.carmi,
            region: freshAccount.region || order.region,
            warranty: newWarranty
          }
        }, corsHeaders);
      }

      // 路由 4: 轮询检查订单状态 (前端自动刷新)
      if (path === "/api/order/check") {
        const orderNo = url.searchParams.get("order_no");
        if (!orderNo) return jsonResponse({ code: -1, msg: "缺少订单号" }, corsHeaders);

        const order = await env.DB.prepare("SELECT order_no, status, carmi, region, price, pay_type, created_at, paid_at, replace_count FROM orders WHERE order_no = ?").bind(orderNo).first();
        if (!order) return jsonResponse({ code: -1, msg: "订单不存在" }, corsHeaders);

        const warranty = getOrderWarrantyInfo(order);

        return jsonResponse({
          code: 0,
          status: order.status,
          pay_type: order.pay_type,
          carmi: order.carmi || "",
          region: order.region,
          price: order.price,
          warranty
        }, corsHeaders);
      }

      // 路由 5: 管理员后台 - 获取待核销订单列表与数据
      if (path === "/api/admin/orders") {
        const key = url.searchParams.get("key") || "";
        if (key !== (env.ADMIN_KEY || "51245124")) {
          return jsonResponse({ code: 403, msg: "管理员密钥错误" }, corsHeaders, 403);
        }

        const pendingOrders = await env.DB.prepare(`
          SELECT id, order_no, region, contact, price, status, pay_type, created_at
          FROM orders
          WHERE status = 0
          ORDER BY id DESC LIMIT 50
        `).all();

        const recentPaid = await env.DB.prepare(`
          SELECT id, order_no, region, contact, price, status, carmi, pay_type, paid_at
          FROM orders
          WHERE status = 1
          ORDER BY id DESC LIMIT 20
        `).all();

        let currentQrcode = "";
        let currentPrice = env.PRICE_PER_ACCOUNT || "4.99";
        try {
          const qrSetting = await env.DB.prepare("SELECT value FROM settings WHERE key = 'PAY_QRCODE'").first();
          if (qrSetting) currentQrcode = qrSetting.value;

          const priceSetting = await env.DB.prepare("SELECT value FROM settings WHERE key = 'PRICE'").first();
          if (priceSetting) currentPrice = priceSetting.value;
        } catch (e) {}

        return jsonResponse({
          code: 0,
          pending: pendingOrders.results || [],
          recent: recentPaid.results || [],
          qrcode: currentQrcode,
          price: parseFloat(currentPrice).toFixed(2)
        }, corsHeaders);
      }

      // 路由 6: 管理员后台 - 修改基准价格
      if (path === "/api/admin/set_price" && request.method === "POST") {
        const body = await request.json();
        const key = body.key || "";
        if (key !== (env.ADMIN_KEY || "51245124")) {
          return jsonResponse({ code: 403, msg: "管理员密钥错误" }, corsHeaders, 403);
        }

        const price = parseFloat(body.price);
        if (isNaN(price) || price <= 0) {
          return jsonResponse({ code: -1, msg: "请输入有效金额" }, corsHeaders);
        }

        await env.DB.prepare(`
          INSERT INTO settings (key, value, updated_at)
          VALUES ('PRICE', ?, datetime('now', '+8 hours'))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now', '+8 hours')
        `).bind(price.toFixed(2)).run();

        return jsonResponse({
          code: 0,
          msg: `🎉 销售金额已设置为：￥${price.toFixed(2)}！`
        }, corsHeaders);
      }

      // 路由 7: 管理员后台 - 上传收款码
      if (path === "/api/admin/upload_qrcode" && request.method === "POST") {
        const body = await request.json();
        const key = body.key || "";
        if (key !== (env.ADMIN_KEY || "51245124")) {
          return jsonResponse({ code: 403, msg: "管理员密钥错误" }, corsHeaders, 403);
        }

        const imageData = body.image_data;
        if (!imageData || !imageData.startsWith("data:image/")) {
          return jsonResponse({ code: -1, msg: "无效的图片格式" }, corsHeaders);
        }

        await env.DB.prepare(`
          INSERT INTO settings (key, value, updated_at)
          VALUES ('PAY_QRCODE', ?, datetime('now', '+8 hours'))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now', '+8 hours')
        `).bind(imageData).run();

        return jsonResponse({
          code: 0,
          msg: "🎉 收款码已成功上传并保存在 Cloudflare 中！"
        }, corsHeaders);
      }

      // 路由 8: 管理员手动批量导入卡密 (备用库)
      if (path === "/api/admin/import" && request.method === "POST") {
        const body = await request.json();
        const key = body.key || "";
        if (key !== (env.ADMIN_KEY || "51245124")) {
          return jsonResponse({ code: 403, msg: "管理员密钥错误" }, corsHeaders, 403);
        }
        const lines = (body.text || "").split("\n");
        const defaultRegion = body.region || "美国";
        let imported = 0;

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          try {
            await env.DB.prepare(`
              INSERT INTO carmis (region, account, password, carmi, status, created_at)
              VALUES (?, ?, ?, ?, 0, datetime('now', '+8 hours'))
            `).bind(defaultRegion, line, line, line).run();
            imported++;
          } catch (e) {}
        }

        return jsonResponse({
          code: 0,
          msg: `成功导入 ${imported} 条卡密！`
        }, corsHeaders);
      }

      // 路由 9: 历史订单查询
      if (path === "/api/order/query") {
        const queryVal = (url.searchParams.get("keyword") || "").trim();
        if (!queryVal) return jsonResponse({ code: -1, msg: "请输入订单号或联系方式" }, corsHeaders);

        const orders = await env.DB.prepare(`
          SELECT order_no, region, contact, price, status, carmi, created_at, paid_at, replace_count
          FROM orders
          WHERE order_no = ? OR contact = ? OR pay_type LIKE ?
          ORDER BY id DESC LIMIT 10
        `).bind(queryVal, queryVal, `%${queryVal}%`).all();

        const results = (orders.results || []).map(o => {
          return {
            ...o,
            warranty: getOrderWarrantyInfo(o)
          };
        });

        return jsonResponse({ code: 0, data: results }, corsHeaders);
      }

      // 路由 10: 管理员后台页面 (/admin)
      if (path === "/admin") {
        return new Response(getAdminHTML(env), {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }

      // 路由 11: 买家前台首页
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
 * 确保数据库表结构完整
 */
async function ensureDbMigrated(env) {
  try {
    await env.DB.prepare("ALTER TABLE orders ADD COLUMN replace_count INTEGER DEFAULT 0").run();
  } catch (e) {}
}

/**
 * 方案 4: 质保期与提取次数计算（2小时质保 + 最多1次换号）
 */
function getOrderWarrantyInfo(order) {
  const GUARANTEE_HOURS = 2; // 2 小时质保
  const MAX_REPLACE = 1;      // 最多允许换号 1 次

  if (!order || order.status !== 1) {
    return {
      is_locked: false,
      is_expired: false,
      is_limit_reached: false,
      remaining_seconds: 0,
      replace_count: 0,
      max_replace: MAX_REPLACE,
      can_replace: false
    };
  }

  const baseTimeStr = order.paid_at || order.created_at;
  let baseTime = Date.now();
  if (baseTimeStr) {
    let tStr = baseTimeStr;
    if (!tStr.includes("T") && !tStr.endsWith("Z") && !tStr.includes("+")) {
      tStr = tStr.replace(" ", "T") + "+08:00";
    }
    const parsed = new Date(tStr).getTime();
    if (!isNaN(parsed)) baseTime = parsed;
  }

  const now = Date.now();
  const elapsedSeconds = Math.max(0, Math.floor((now - baseTime) / 1000));
  const totalGuaranteeSeconds = GUARANTEE_HOURS * 3600;
  const remainingSeconds = Math.max(0, totalGuaranteeSeconds - elapsedSeconds);
  const replaceCount = order.replace_count || 0;

  const isExpired = remainingSeconds <= 0;
  const isLimitReached = replaceCount >= MAX_REPLACE;
  const isLocked = isExpired || isLimitReached;
  const canReplace = !isExpired && !isLimitReached;

  return {
    is_locked: isLocked,
    is_expired: isExpired,
    is_limit_reached: isLimitReached,
    remaining_seconds: remainingSeconds,
    replace_count: replaceCount,
    max_replace: MAX_REPLACE,
    can_replace: canReplace,
    guarantee_hours: GUARANTEE_HOURS
  };
}

/**
 * 每次提卡时实时穿透抓取源站最新账号
 */
async function fetchLatestLiveAccount(env, region) {
  const syncRes = await syncAccountsFromSource(env);
  const accounts = syncRes.accounts || [];

  // 1. 优先匹配当前购买地区的最新账号
  let matched = accounts.find(a => a.region === region);
  if (!matched && accounts.length > 0) {
    matched = accounts[0]; // fallback
  }

  if (matched) {
    const carmi = `【${matched.region}】账号: ${matched.account} ---- 密码: ${matched.password}`;
    return {
      carmi: carmi,
      region: matched.region,
      account: matched.account,
      password: matched.password
    };
  }

  // 2. 如果源站当前抓取网络异常，从 D1 本地备用库中取一条未使用的卡密
  const dbRecord = await env.DB.prepare(
    "SELECT id, carmi, region FROM carmis WHERE (region = ? OR region = '通用') AND status = 0 ORDER BY id DESC LIMIT 1"
  ).bind(region).first();

  if (dbRecord) {
    return { carmi: dbRecord.carmi, region: dbRecord.region, id: dbRecord.id };
  }

  return null;
}

/**
 * 核心抓取与解析逻辑 (适配 haoged.top/share/app)
 */
async function syncAccountsFromSource(env) {
  const targetUrl = env.TARGET_URL || "https://haoged.top/share/app";
  let inserted = 0;
  let total = 0;

  try {
    const res = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });

    if (!res.ok) {
      return { total: 0, inserted: 0, accounts: [], error: `源站响应 HTTP ${res.status}: ${res.statusText}` };
    }

    const html = await res.text();
    const cards = html.split('card-body');
    const accounts = [];

    for (const card of cards.slice(1)) {
      const clips = card.match(/data-clipboard-text=["']([^"']+)["']/g) || [];
      let account = "";
      let password = "";
      for (const raw of clips) {
        const val = raw.replace(/data-clipboard-text=["']/, '').replace(/["']$/, '').trim();
        if (val.includes("@")) {
          account = val;
        } else if (!password && val.length >= 4) {
          password = val;
        }
      }

      let reg = "美国";
      for (const r of ["香港", "台湾", "日本", "美国", "韩国", "新加坡", "英国"]) {
        if (card.includes(r)) {
          reg = r;
          break;
        }
      }

      if (account && password) {
        accounts.push({ region: reg, account, password });
      }
    }

    total = accounts.length;

    for (const item of accounts) {
      const carmi = `【${item.region}】账号: ${item.account} ---- 密码: ${item.password}`;
      try {
        const dbRes = await env.DB.prepare(`
          INSERT INTO carmis (region, account, password, carmi, status, created_at)
          VALUES (?, ?, ?, ?, 0, datetime('now', '+8 hours'))
        `).bind(item.region, item.account, item.password, carmi).run();

        if (dbRes.meta && dbRes.meta.changes > 0) inserted++;
      } catch (dbErr) {}
    }

    return { total, inserted, accounts };
  } catch (err) {
    return { total: 0, inserted: 0, accounts: [], error: err.message };
  }
}

function jsonResponse(data, headers = {}, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers }
  });
}

/**
 * 买家前台页面 (方案B：买家一键提交付款通知 + 智能无感轮询秒出卡)
 */
function getFrontendHTML(env) {
  const siteName = env.SITE_NAME || "小火箭账号";
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
    <!-- 自动恢复最近订单横幅 -->
    <div id="recent-order-banner" class="hidden mb-4 p-3.5 rounded-xl bg-indigo-600/20 border border-indigo-500/40 flex justify-between items-center text-xs">
      <div class="flex items-center gap-2 text-indigo-200">
        <i class="fa-solid fa-clock-rotate-left text-indigo-400"></i>
        <span>检测到您有一笔最近的订单：<b id="banner-order-no" class="font-mono text-emerald-400"></b></span>
      </div>
      <button onclick="restoreRecentOrder()" class="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-lg transition">
        查看/提取卡密
      </button>
    </div>

    <div class="text-center mb-6">
      <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-indigo-600/20 text-indigo-400 mb-3 border border-indigo-500/30">
        <i class="fa-solid fa-cloud-bolt text-2xl"></i>
      </div>
      <h1 class="text-3xl font-bold tracking-tight text-white mb-2">${siteName}</h1>
      <p class="text-slate-400 text-sm">24小时极速出卡 · 实时库存同步 · 关网页随时查回最新卡密</p>
    </div>

    <!-- 顶部重要安全使用须知 (图文指引) -->
    <div class="mb-6 p-4 sm:p-5 rounded-2xl bg-amber-500/10 border border-amber-500/30 backdrop-blur-md shadow-xl relative overflow-hidden">
      <div class="absolute -right-6 -bottom-6 text-amber-500/10 text-8xl pointer-events-none">
        <i class="fa-solid fa-triangle-exclamation"></i>
      </div>
      <div class="flex items-center gap-2 mb-3">
        <span class="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-amber-500/20 text-amber-400 font-bold text-sm">
          <i class="fa-solid fa-triangle-exclamation"></i>
        </span>
        <h3 class="font-bold text-sm sm:text-base text-amber-300">安全使用须知（必读）</h3>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
        <div class="p-3 rounded-xl bg-slate-900/80 border border-emerald-500/30 flex items-start gap-3">
          <div class="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0 text-base">
            <i class="fa-brands fa-apple"></i>
          </div>
          <div>
            <div class="font-bold text-emerald-400 flex items-center gap-1">
              <i class="fa-solid fa-circle-check"></i> 仅在 App Store 登录
            </div>
            <div class="text-slate-300 mt-0.5 leading-relaxed">
              打开苹果应用商店（App Store），点击右上角头像退出当前账号并登录购买的账号即可下载。
            </div>
          </div>
        </div>
        <div class="p-3 rounded-xl bg-slate-900/80 border border-rose-500/30 flex items-start gap-3">
          <div class="w-8 h-8 rounded-lg bg-rose-500/20 text-rose-400 flex items-center justify-center shrink-0 text-base">
            <i class="fa-solid fa-ban"></i>
          </div>
          <div>
            <div class="font-bold text-rose-400 flex items-center gap-1">
              <i class="fa-solid fa-circle-xmark"></i> 切勿在设置中登录 iCloud
            </div>
            <div class="text-slate-300 mt-0.5 leading-relaxed">
              严禁在手机系统【设置】或【iCloud】中登录共享账号，避免同步个人数据或导致手机被锁！
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="glass rounded-2xl p-6 sm:p-8 shadow-2xl mb-6">
      <div class="flex border-b border-slate-700 mb-6">
        <button id="tab-buy" onclick="switchTab('buy')" class="py-2.5 px-6 font-medium text-indigo-400 border-b-2 border-indigo-500 flex items-center gap-2">
          <i class="fa-solid fa-cart-shopping"></i> 在线下单
        </button>
        <button id="tab-query" onclick="switchTab('query')" class="py-2.5 px-6 font-medium text-slate-400 hover:text-slate-200 flex items-center gap-2">
          <i class="fa-solid fa-magnifying-glass"></i> 订单查询 (随时找回)
        </button>
      </div>

      <div id="panel-buy" class="space-y-6">
        <div>
          <label class="block text-sm font-medium text-slate-300 mb-3">选择地区分类：</label>
          <div id="region-list" class="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div class="p-4 rounded-xl border border-slate-700 bg-slate-800/50 animate-pulse text-center text-sm text-slate-400">加载库存中...</div>
          </div>
        </div>

        <div>
          <label class="block text-sm font-medium text-slate-300 mb-2">联系方式 (用于查单/随时找回卡密)：</label>
          <input type="text" id="contact" placeholder="建议填写您的手机号或QQ/邮箱" class="w-full px-4 py-3 rounded-xl bg-slate-800/80 border border-slate-700 text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 text-sm">
        </div>

        <div class="pt-4 border-t border-slate-700/60 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div>
            <span class="text-sm text-slate-400">固定单价：</span>
            <span class="text-2xl font-bold text-indigo-400" id="display-price">￥4.99</span>
          </div>
          <button onclick="submitOrder()" id="btn-submit" class="w-full sm:w-auto px-8 py-3.5 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-semibold rounded-xl shadow-lg shadow-indigo-500/25 transition duration-200 flex items-center justify-center gap-2">
            <i class="fa-solid fa-qrcode"></i> 立即扫码付款出卡
          </button>
        </div>
      </div>

      <div id="panel-query" class="space-y-6 hidden">
        <div>
          <label class="block text-sm font-medium text-slate-300 mb-2">输入订单号或联系方式找回：</label>
          <div class="flex gap-2">
            <input type="text" id="query-keyword" placeholder="输入订单号 / 手机号 / 邮箱" class="flex-1 px-4 py-3 rounded-xl bg-slate-800/80 border border-slate-700 text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 text-sm">
            <button onclick="queryOrders()" class="px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-xl transition">
              <i class="fa-solid fa-search"></i> 查询找回
            </button>
          </div>
        </div>
        <div id="query-results" class="space-y-3"></div>
      </div>
    </div>

    <!-- 弹窗 1：扫码付款与极速发货等待弹窗 -->
    <div id="modal-pay" class="fixed inset-0 bg-black/80 backdrop-blur-md hidden flex items-center justify-center p-4 z-50">
      <div class="glass max-w-sm w-full rounded-2xl p-6 shadow-2xl space-y-4 border border-indigo-500/40 text-center">
        <h3 class="text-base font-bold text-white flex items-center justify-center gap-1.5">
          <i class="fa-brands fa-weixin text-emerald-400 text-lg"></i> 微信扫码付款
        </h3>

        <!-- 应付金额 -->
        <div class="bg-indigo-950/60 border border-indigo-500/30 rounded-xl p-2.5 text-center">
          <div class="text-xs text-slate-400">应付金额：</div>
          <div class="text-2xl font-extrabold text-emerald-400 font-mono my-0.5" id="pay-money">￥4.99</div>
          <div class="text-[11px] text-slate-400">订单号: <span id="pay-order-no-disp" class="font-mono text-indigo-300"></span></div>
        </div>

        <!-- 收款二维码 -->
        <div class="p-2 bg-white rounded-xl inline-block shadow-inner mx-auto max-w-[190px] max-h-[190px]">
          <img id="pay-qr-img" src="" alt="微信收款码" class="w-40 h-40 rounded-lg object-contain mx-auto">
        </div>

        <!-- 提交付款状态区 -->
        <div id="pay-action-section" class="space-y-3">
          <div class="space-y-1.5">
            <input type="text" id="pay-note-input" placeholder="输入付款微信昵称或单号尾号 (选填)" class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 text-center">
            <button onclick="confirmPaidAndNotify()" id="btn-notify-paid" class="w-full py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold rounded-xl text-xs flex items-center justify-center gap-1.5 shadow-lg transition">
              <i class="fa-solid fa-paper-plane"></i> 我已完成支付，通知站长发货
            </button>
          </div>
          <div class="text-[11px] text-slate-400 leading-tight">
            * 扫码付款后点击上方按钮，系统将自动核实并在数秒内在此页面为您弹出账号密码！
          </div>
        </div>

        <!-- 等待站长确认状态条 (默认隐藏，点击后显示) -->
        <div id="pay-waiting-section" class="hidden space-y-2 bg-indigo-950/80 p-3 rounded-xl border border-indigo-500/40">
          <div class="flex items-center justify-center gap-2 text-xs text-emerald-400 font-bold animate-pulse">
            <i class="fa-solid fa-spinner fa-spin text-base"></i>
            <span>已通知站长，正在为您出库账号...</span>
          </div>
          <div class="text-[11px] text-slate-400">
            站长确认后页面将<b>自动秒级弹出卡密</b>，无需手动刷新。
          </div>
        </div>

        <button onclick="cancelPay()" class="w-full py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-400 font-medium rounded-xl text-xs transition">
          关闭 (关闭后可随时在首页查单找回)
        </button>
      </div>
    </div>

    <!-- 弹窗 2：发卡成功结果 (账号密码分别独立显示与单独一键复制) -->
    <div id="modal-result" class="fixed inset-0 bg-black/80 backdrop-blur-md hidden flex items-center justify-center p-4 z-50">
      <div class="glass max-w-lg w-full rounded-2xl p-6 sm:p-8 shadow-2xl space-y-4 border border-emerald-500/40">
        <div class="text-center">
          <div class="w-12 h-12 bg-emerald-500/20 text-emerald-400 rounded-full flex items-center justify-center mx-auto mb-2 border border-emerald-500/30">
            <i class="fa-solid fa-check text-xl"></i>
          </div>
          <h3 class="text-xl font-bold text-white">🎉 出卡成功！</h3>
          <p class="text-xs text-slate-400 mt-0.5">订单号: <span id="res-order-no" class="font-mono text-indigo-300"></span></p>
        </div>

        <div class="bg-slate-900/90 rounded-xl p-4 border border-slate-800 space-y-3">
          <div class="flex justify-between items-center mb-1">
            <span class="text-xs text-slate-400 font-medium">Apple ID 账号信息详情：</span>
            <span id="warranty-badge" class="text-xs text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20 flex items-center gap-1">
              <i class="fa-solid fa-shield-halved"></i> 2小时质保中
            </span>
          </div>

          <!-- 独立账号卡片 -->
          <div class="p-3 bg-slate-950 rounded-xl border border-slate-800 flex items-center justify-between gap-2">
            <div class="min-w-0 flex-1">
              <div class="text-[11px] text-slate-400 mb-0.5">Apple ID 账号 (邮箱)</div>
              <div id="res-account" class="text-sm font-mono text-white font-semibold truncate select-all">--</div>
            </div>
            <button onclick="copySingleField('res-account', '账号已复制')" class="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-medium transition flex items-center gap-1 shrink-0 shadow">
              <i class="fa-solid fa-copy"></i> 复制账号
            </button>
          </div>

          <!-- 独立密码卡片 -->
          <div class="p-3 bg-slate-950 rounded-xl border border-slate-800 flex items-center justify-between gap-2">
            <div class="min-w-0 flex-1">
              <div class="text-[11px] text-slate-400 mb-0.5">登录密码</div>
              <div id="res-password" class="text-sm font-mono text-emerald-400 font-semibold truncate select-all">--</div>
            </div>
            <button onclick="copySingleField('res-password', '密码已复制')" class="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-medium transition flex items-center gap-1 shrink-0 shadow">
              <i class="fa-solid fa-copy"></i> 复制密码
            </button>
          </div>

          <!-- 隐藏的完整卡密引用 -->
          <div id="res-carmi" class="hidden"></div>

          <!-- 方案4：质保与换号风控控制栏 -->
          <div id="warranty-action-box" class="pt-2 border-t border-slate-800 flex justify-between items-center text-xs">
            <span id="warranty-countdown" class="text-slate-400 font-mono flex items-center gap-1">
              <i class="fa-regular fa-clock text-indigo-400"></i> 质保剩余: 计算中...
            </span>
            <button id="btn-replace" onclick="replaceCarmi()" class="text-amber-400 hover:text-amber-300 font-medium flex items-center gap-1">
              <i class="fa-solid fa-rotate"></i> 密码错误？换号 (1/1)
            </button>
          </div>
        </div>

        <div class="flex gap-3">
          <button onclick="copyAllCarmi()" class="flex-1 py-3 bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium rounded-xl transition flex items-center justify-center gap-2 text-xs">
            <i class="fa-solid fa-clone"></i> 复制完整账号+密码
          </button>
          <button onclick="closeModal()" class="px-6 py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-medium rounded-xl transition text-xs">
            完成
          </button>
        </div>
      </div>
    </div>

    <div class="text-center text-xs text-slate-500 space-y-1">
      <p>自动发卡服务系统 · 24小时智能极速出卡</p>
      <p>Powered by Cloudflare Workers & D1</p>
    </div>
  </div>

  <script>
    var currentSelectedRegion = "美国";
    var loadedRegions = [];
    var currentOrderNo = null;
    var warrantyTimer = null;
    var currentFullCarmi = "";
    var payPollingTimer = null;

    function parseCarmi(raw) {
      if (!raw) return { account: "", password: "", raw: "" };
      var account = "";
      var password = "";

      var accMatch = raw.match(/账号:\s*([^\s-]+)/);
      if (accMatch) account = accMatch[1].trim();

      var pwdMatch = raw.match(/密码:\s*(.+)$/);
      if (pwdMatch) password = pwdMatch[1].trim();

      if (!account && !password) {
        if (raw.includes("----")) {
          var parts = raw.split("----");
          account = parts[0].replace(/【.*?】/g, "").replace("账号:", "").trim();
          password = parts[1].replace("密码:", "").trim();
        } else {
          account = raw;
        }
      }

      return { account: account, password: password, raw: raw };
    }

    function renderCarmiResult(carmiStr) {
      currentFullCarmi = carmiStr || "";
      var parsed = parseCarmi(carmiStr);
      var accEl = document.getElementById("res-account");
      var pwdEl = document.getElementById("res-password");
      var rawEl = document.getElementById("res-carmi");
      if (accEl) accEl.innerText = parsed.account || carmiStr || "--";
      if (pwdEl) pwdEl.innerText = parsed.password || "--";
      if (rawEl) rawEl.innerText = carmiStr || "";
    }

    function showToast(msg) {
      var toast = document.getElementById("toast-msg");
      if (!toast) {
        toast = document.createElement("div");
        toast.id = "toast-msg";
        toast.className = "fixed top-6 left-1/2 -translate-x-1/2 px-4 py-2 bg-emerald-500 text-white text-xs font-bold rounded-full shadow-2xl z-[9999] transition duration-300 opacity-0 pointer-events-none flex items-center gap-1.5";
        document.body.appendChild(toast);
      }
      toast.innerHTML = '<i class="fa-solid fa-circle-check"></i> ' + msg;
      toast.classList.remove("opacity-0");
      toast.classList.add("opacity-100");
      setTimeout(function() {
        toast.classList.remove("opacity-100");
        toast.classList.add("opacity-0");
      }, 2000);
    }

    function copyText(text, successMsg) {
      if (!text) return;
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(function() {
          showToast(successMsg || "复制成功！");
        }).catch(function() {
          fallbackCopy(text, successMsg);
        });
      } else {
        fallbackCopy(text, successMsg);
      }
    }

    function fallbackCopy(text, successMsg) {
      var textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.position = "fixed";
      textArea.style.left = "-999999px";
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      try {
        document.execCommand('copy');
        showToast(successMsg || "复制成功！");
      } catch (err) {
        alert("复制失败，请手动长按复制");
      }
      document.body.removeChild(textArea);
    }

    function copySingleField(elementId, msg) {
      var el = document.getElementById(elementId);
      if (el) copyText(el.innerText, msg);
    }

    function copyAllCarmi() {
      copyText(currentFullCarmi, "完整账号密码已复制！");
    }

    async function loadStats() {
      try {
        var res = await fetch("/api/stats");
        var json = await res.json();
        if (json.code === 0) {
          loadedRegions = json.data;
          document.getElementById("display-price").innerText = "￥" + json.price;
          if (json.pay_qrcode) document.getElementById("pay-qr-img").src = json.pay_qrcode;
          renderRegions();
        }
      } catch (e) {
        console.error("加载失败", e);
      }
      checkSavedRecentOrder();
    }

    function checkSavedRecentOrder() {
      var saved = localStorage.getItem("faka_recent_order");
      if (saved) {
        currentOrderNo = saved;
        document.getElementById("banner-order-no").innerText = saved;
        document.getElementById("recent-order-banner").classList.remove("hidden");
      }
    }

    function updateWarrantyUI(warranty, orderNo) {
      if (warrantyTimer) clearInterval(warrantyTimer);

      var badge = document.getElementById("warranty-badge");
      var countdown = document.getElementById("warranty-countdown");
      var btnReplace = document.getElementById("btn-replace");

      if (!warranty || !warranty.remaining_seconds || warranty.is_locked) {
        if (badge) {
          badge.className = "text-xs text-slate-400 bg-slate-800 px-2 py-0.5 rounded border border-slate-700 flex items-center gap-1";
          badge.innerHTML = '<i class="fa-solid fa-lock"></i> 账号已固化锁定';
        }
        if (countdown) countdown.innerHTML = '<span class="text-slate-500">已过质保期或已达换号上限</span>';
        if (btnReplace) btnReplace.classList.add("hidden");
        return;
      }

      var seconds = warranty.remaining_seconds;
      if (badge) {
        badge.className = "text-xs text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20 flex items-center gap-1";
        badge.innerHTML = '<i class="fa-solid fa-shield-halved"></i> 2小时质保生效中';
      }
      if (btnReplace) {
        if (warranty.can_replace) {
          btnReplace.classList.remove("hidden");
          btnReplace.innerHTML = '<i class="fa-solid fa-rotate"></i> 密码错误？换号 (' + (warranty.max_replace - warranty.replace_count) + '/' + warranty.max_replace + ')';
        } else {
          btnReplace.classList.add("hidden");
        }
      }

      function renderCountdown() {
        if (seconds <= 0) {
          if (countdown) countdown.innerHTML = '<span class="text-slate-500">质保已过期</span>';
          if (btnReplace) btnReplace.classList.add("hidden");
          if (badge) {
            badge.className = "text-xs text-slate-400 bg-slate-800 px-2 py-0.5 rounded border border-slate-700 flex items-center gap-1";
            badge.innerHTML = '<i class="fa-solid fa-lock"></i> 账号已固化锁定';
          }
          clearInterval(warrantyTimer);
          return;
        }
        var m = Math.floor(seconds / 60);
        var s = seconds % 60;
        if (countdown) {
          countdown.innerHTML = '<i class="fa-regular fa-clock text-indigo-400"></i> 质保剩余: <span class="text-indigo-300 font-bold">' + m + '分' + (s < 10 ? '0' : '') + s + '秒</span>';
        }
        seconds--;
      }

      renderCountdown();
      warrantyTimer = setInterval(renderCountdown, 1000);
    }

    function startPayPolling(orderNo) {
      if (payPollingTimer) clearInterval(payPollingTimer);

      payPollingTimer = setInterval(async function() {
        try {
          var res = await fetch("/api/order/check?order_no=" + orderNo);
          var json = await res.json();
          if (json.code === 0 && json.status === 1 && json.carmi) {
            clearInterval(payPollingTimer);
            document.getElementById("modal-pay").classList.add("hidden");
            document.getElementById("res-order-no").innerText = orderNo;
            renderCarmiResult(json.carmi);
            updateWarrantyUI(json.warranty, orderNo);
            document.getElementById("modal-result").classList.remove("hidden");
            showToast("🎉 站长已确认出卡！");
            loadStats();
          }
        } catch (e) {}
      }, 2000);
    }

    async function restoreRecentOrder() {
      if (!currentOrderNo) return;
      try {
        var res = await fetch("/api/order/check?order_no=" + currentOrderNo);
        var json = await res.json();
        if (json.code === 0) {
          if (json.status === 1 && json.carmi) {
            document.getElementById("res-order-no").innerText = currentOrderNo;
            renderCarmiResult(json.carmi);
            updateWarrantyUI(json.warranty, currentOrderNo);
            document.getElementById("modal-result").classList.remove("hidden");
          } else {
            document.getElementById("pay-money").innerText = "￥" + json.price;
            document.getElementById("pay-order-no-disp").innerText = currentOrderNo;
            document.getElementById("modal-pay").classList.remove("hidden");
            startPayPolling(currentOrderNo);
          }
        } else {
          alert("订单查询失败");
        }
      } catch (e) {
        alert("请求异常");
      }
    }

    function renderRegions() {
      var container = document.getElementById("region-list");
      container.innerHTML = "";
      loadedRegions.forEach(function(r, idx) {
        var isSelected = r.region === currentSelectedRegion || (idx === 0 && !currentSelectedRegion);
        if (isSelected) currentSelectedRegion = r.region;

        var card = document.createElement("div");
        card.className = "p-4 rounded-xl border cursor-pointer transition duration-150 flex flex-col justify-between " + 
                         (isSelected ? "card-active border-indigo-500" : "border-slate-700/80 bg-slate-800/40 hover:border-slate-600");
        card.onclick = function() {
          currentSelectedRegion = r.region;
          renderRegions();
        };

        card.innerHTML = '<div class="flex items-center justify-between mb-2">' +
            '<span class="font-medium text-white">' + r.region + '</span>' +
            '<span class="text-xs px-2 py-0.5 rounded-full ' + (r.stock > 0 ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-rose-500/20 text-rose-400') + '">' +
              '余量: ' + r.stock +
            '</span>' +
          '</div>' +
          '<div class="text-xs text-slate-400">已售: ' + r.sold + '</div>';
        container.appendChild(card);
      });
    }

    async function submitOrder() {
      var contact = document.getElementById("contact").value.trim();
      var btn = document.getElementById("btn-submit");
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在生成支付单...';

      try {
        var res = await fetch("/api/order/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ region: currentSelectedRegion, contact: contact })
        });
        var data = await res.json();
        if (data.code === 0) {
          currentOrderNo = data.data.order_no;
          localStorage.setItem("faka_recent_order", currentOrderNo);
          checkSavedRecentOrder();

          document.getElementById("pay-money").innerText = "￥" + data.data.price;
          document.getElementById("pay-order-no-disp").innerText = currentOrderNo;
          document.getElementById("pay-note-input").value = "";
          document.getElementById("pay-action-section").classList.remove("hidden");
          document.getElementById("pay-waiting-section").classList.add("hidden");
          document.getElementById("modal-pay").classList.remove("hidden");

          startPayPolling(currentOrderNo);
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

    async function confirmPaidAndNotify() {
      if (!currentOrderNo) return alert("订单已失效，请重新下单");
      var note = document.getElementById("pay-note-input").value.trim();
      var btn = document.getElementById("btn-notify-paid");
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在通知站长...';

      try {
        var res = await fetch("/api/order/notify_paid", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order_no: currentOrderNo, note: note })
        });
        var json = await res.json();
        if (json.code === 0) {
          showToast("已通知站长！");
          document.getElementById("pay-action-section").classList.add("hidden");
          document.getElementById("pay-waiting-section").classList.remove("hidden");
        } else {
          alert(json.msg || "通知失败");
        }
      } catch (e) {
        alert("网络异常");
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> 我已完成支付，通知站长发货';
      }
    }

    async function replaceCarmi(orderNoToReplace) {
      var targetOrderNo = orderNoToReplace || currentOrderNo;
      if (!targetOrderNo) return alert("缺少订单号");

      if (!confirm("确定此账号无法登录？系统将从源站获取最新账号为您免费更换（每单仅限 1 次，2小时内有效）！")) return;

      var btn = document.getElementById("btn-replace");
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在换新...';
      }

      try {
        var res = await fetch("/api/order/replace", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order_no: targetOrderNo })
        });
        var json = await res.json();
        if (json.code === 0) {
          alert("🎉 换号成功！已为您换发源站最新账号！");
          renderCarmiResult(json.data.carmi);
          updateWarrantyUI(json.data.warranty, targetOrderNo);
          if (!document.getElementById("panel-query").classList.contains("hidden")) {
            queryOrders();
          }
          loadStats();
        } else {
          alert(json.msg || "换号失败");
        }
      } catch (err) {
        alert("换号请求失败");
      } finally {
        if (btn) {
          btn.disabled = false;
        }
      }
    }

    function cancelPay() {
      if (payPollingTimer) clearInterval(payPollingTimer);
      document.getElementById("modal-pay").classList.add("hidden");
    }

    async function queryOrders() {
      var kw = document.getElementById("query-keyword").value.trim();
      if (!kw) return alert("请输入查询关键词 (手机号/邮箱/订单号)");

      var resBox = document.getElementById("query-results");
      resBox.innerHTML = '<div class="text-center text-slate-400 text-sm py-4">查询中...</div>';

      try {
        var res = await fetch("/api/order/query?keyword=" + encodeURIComponent(kw));
        var json = await res.json();
        if (json.code === 0 && json.data.length > 0) {
          resBox.innerHTML = json.data.map(function(o) {
            var w = o.warranty || {};
            var parsed = parseCarmi(o.carmi || "");
            var statusHtml = '';
            if (o.status === 1) {
              if (w.can_replace) {
                var m = Math.floor((w.remaining_seconds || 0) / 60);
                statusHtml = '<span class="text-emerald-400 text-xs flex items-center gap-1"><i class="fa-solid fa-shield-halved"></i> 质保中 (剩' + m + '分)</span>' +
                  '<button data-no="' + o.order_no + '" onclick="replaceCarmi(this.dataset.no)" class="text-amber-400 hover:text-amber-300 font-medium text-xs"><i class="fa-solid fa-rotate"></i> 换号 (' + (w.max_replace - w.replace_count) + '次)</button>';
              } else {
                statusHtml = '<span class="text-slate-500 text-xs flex items-center gap-1"><i class="fa-solid fa-lock"></i> 账号已固化锁定</span>';
              }
            } else {
              statusHtml = '<button data-no="' + o.order_no + '" onclick="currentOrderNo=this.dataset.no;restoreRecentOrder()" class="text-emerald-400 hover:text-emerald-300 font-medium text-xs"><i class="fa-solid fa-key"></i> 查看付款/发卡</button>';
            }

            return '<div class="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-3">' +
                '<div class="flex justify-between items-center text-xs text-slate-400">' +
                  '<span>订单号: ' + o.order_no + '</span>' +
                  '<span class="text-indigo-400 font-medium">' + o.region + ' · ￥' + o.price + '</span>' +
                '</div>' +
                (o.status === 1 ?
                  '<div class="space-y-2">' +
                    '<div class="flex items-center justify-between p-2.5 bg-slate-950 rounded-lg border border-slate-800">' +
                      '<div class="text-xs font-mono text-white truncate mr-2"><span class="text-slate-500">账号: </span>' + parsed.account + '</div>' +
                      '<button data-copy="' + parsed.account + '" onclick="copyText(this.dataset.copy)" class="px-2.5 py-1 bg-indigo-600/80 hover:bg-indigo-600 text-white rounded text-[11px] font-medium shrink-0">复制账号</button>' +
                    '</div>' +
                    '<div class="flex items-center justify-between p-2.5 bg-slate-950 rounded-lg border border-slate-800">' +
                      '<div class="text-xs font-mono text-emerald-400 truncate mr-2"><span class="text-slate-500">密码: </span>' + parsed.password + '</div>' +
                      '<button data-copy="' + parsed.password + '" onclick="copyText(this.dataset.copy)" class="px-2.5 py-1 bg-emerald-600/80 hover:bg-emerald-600 text-white rounded text-[11px] font-medium shrink-0">复制密码</button>' +
                    '</div>' +
                  '</div>'
                 : '<div class="text-xs font-mono text-amber-400 bg-slate-950 p-2.5 rounded border border-slate-800">已下单 · 待站长确认出卡</div>') +
                '<div class="flex justify-between items-center text-xs text-slate-500 pt-1 border-t border-slate-800/60">' +
                  '<span>下单: ' + o.created_at + '</span>' +
                  '<div class="flex items-center gap-3">' +
                    statusHtml +
                  '</div>' +
                '</div>' +
              '</div>';
          }).join("");
        } else {
          resBox.innerHTML = '<div class="text-center text-slate-500 text-sm py-4">未查询到相关订单记录，请核对输入的手机号/邮箱</div>';
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

    function closeModal() {
      document.getElementById("modal-result").classList.add("hidden");
    }

    loadStats();
  </script>
</body>
</html>`;
}

/**
 * 手机端站长管理后台页面 (/admin)
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
  <style>
    body { background: #0f172a; color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    @keyframes pulse-ring {
      0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.7); }
      70% { box-shadow: 0 0 0 10px rgba(239, 68, 68, 0); }
      100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); }
    }
    .pending-alert { animation: pulse-ring 2s infinite; }
  </style>
</head>
<body class="p-4 max-w-2xl mx-auto pb-16">
  <div class="mb-5 flex justify-between items-center border-b border-slate-800 pb-3">
    <h1 class="text-lg font-bold flex items-center gap-2 text-indigo-400">
      <i class="fa-solid fa-shield-halved"></i> 站长手机工作台
    </h1>
    <a href="/" class="text-xs text-slate-400 hover:text-white flex items-center gap-1">
      <i class="fa-solid fa-arrow-left"></i> 前台首页
    </a>
  </div>

  <div class="space-y-4">
    <!-- 管理秘钥与自动刷新控制 -->
    <div class="p-3.5 rounded-xl bg-slate-900 border border-slate-800 flex flex-col sm:flex-row gap-2 justify-between items-center">
      <div class="flex gap-2 w-full sm:w-auto flex-1">
        <input type="password" id="admin-key" placeholder="输入管理员密钥" value="51245124" class="flex-1 px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-white">
        <button onclick="loadAdminData()" class="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-medium">刷新</button>
      </div>
      <div class="flex items-center gap-2 text-xs text-slate-400">
        <span class="w-2 h-2 rounded-full bg-emerald-400 animate-ping"></span>
        <span>4秒自动刷新中</span>
      </div>
    </div>

    <!-- 待发货订单列表 (核心功能) -->
    <div class="p-4 rounded-xl bg-slate-900 border border-slate-800 space-y-3">
      <div class="flex justify-between items-center">
        <h2 class="font-bold text-amber-400 flex items-center gap-2 text-sm">
          <i class="fa-solid fa-bell"></i> 待确认收款发货订单
        </h2>
        <span id="pending-count-badge" class="text-xs px-2.5 py-0.5 rounded-full font-bold bg-slate-800 text-slate-400">
          0 笔
        </span>
      </div>
      
      <div id="pending-list" class="space-y-3">
        <div class="text-slate-500 text-xs py-3 text-center">加载中...</div>
      </div>
    </div>

    <!-- 设置销售价格 -->
    <div class="p-4 rounded-xl bg-slate-900 border border-slate-800 space-y-2">
      <h2 class="font-bold text-indigo-400 flex items-center gap-2 text-sm">
        <i class="fa-solid fa-tag"></i> 设置单价 (元)
      </h2>
      <div class="flex gap-2">
        <div class="relative flex-1">
          <span class="absolute left-3 top-2 text-slate-400 text-xs">￥</span>
          <input type="number" id="price-input" step="0.01" min="0.01" placeholder="4.99" class="w-full pl-7 pr-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs font-bold text-emerald-400">
        </div>
        <button onclick="savePrice()" class="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-lg text-xs">
          保存
        </button>
      </div>
    </div>

    <!-- 上传微信收款码图片 -->
    <div class="p-4 rounded-xl bg-slate-900 border border-slate-800 space-y-2">
      <h2 class="font-bold text-emerald-400 flex items-center gap-2 text-sm">
        <i class="fa-solid fa-image"></i> 设置微信收款码
      </h2>
      <div class="flex gap-3 items-center">
        <div class="w-16 h-16 bg-slate-800 rounded-lg border border-slate-700 flex items-center justify-center overflow-hidden shrink-0">
          <img id="current-qrcode-preview" src="" alt="收款码" class="w-full h-full object-contain hidden">
          <span id="no-qrcode-text" class="text-[10px] text-slate-500">未设置</span>
        </div>
        <div class="flex-1 space-y-1.5">
          <input type="file" id="qrcode-file-input" accept="image/*" class="text-xs text-slate-400 file:mr-2 file:py-1 file:px-2.5 file:rounded-lg file:border-0 file:text-[11px] file:font-semibold file:bg-indigo-600 file:text-white cursor-pointer">
          <button onclick="uploadQrcode()" id="btn-upload-qr" class="w-full px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-lg text-xs">
            <i class="fa-solid fa-cloud-arrow-up"></i> 保存收款码
          </button>
        </div>
      </div>
    </div>

    <!-- 手动批量导入卡密 -->
    <div class="p-4 rounded-xl bg-slate-900 border border-slate-800 space-y-2">
      <h2 class="font-bold text-indigo-400 flex items-center gap-2 text-sm">
        <i class="fa-solid fa-file-import"></i> 批量导入卡密 (备用库存)
      </h2>
      <div class="space-y-2">
        <div class="flex gap-2">
          <select id="import-region" class="px-2.5 py-1 rounded-lg bg-slate-800 border border-slate-700 text-xs text-white">
            <option value="美国">美国</option>
            <option value="香港">香港</option>
            <option value="日本">日本</option>
            <option value="台湾">台湾</option>
            <option value="通用">通用</option>
          </select>
          <button onclick="importCarmis()" class="px-3 py-1 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-lg text-xs">
            导入
          </button>
        </div>
        <textarea id="import-text" rows="2" placeholder="一行一条卡密，例如：&#10;账号: xxx@outlook.com ---- 密码: xxx" class="w-full px-2.5 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs font-mono text-white"></textarea>
      </div>
    </div>

    <!-- 最近已出卡记录 -->
    <div class="p-4 rounded-xl bg-slate-900 border border-slate-800 space-y-2">
      <h2 class="font-bold text-slate-300 text-sm">最近发卡记录</h2>
      <div id="recent-list" class="space-y-2"></div>
    </div>
  </div>

  <script>
    var savedKey = localStorage.getItem("faka_admin_key");
    if (savedKey) {
      document.getElementById("admin-key").value = savedKey;
    }

    async function loadAdminData() {
      var key = document.getElementById("admin-key").value.trim();
      localStorage.setItem("faka_admin_key", key);

      var pBox = document.getElementById("pending-list");
      var rBox = document.getElementById("recent-list");
      var pBadge = document.getElementById("pending-count-badge");

      try {
        var res = await fetch("/api/admin/orders?key=" + encodeURIComponent(key));
        var json = await res.json();
        if (json.code === 0) {
          if (json.price) {
            document.getElementById("price-input").value = json.price;
          }

          if (json.qrcode) {
            document.getElementById("current-qrcode-preview").src = json.qrcode;
            document.getElementById("current-qrcode-preview").classList.remove("hidden");
            document.getElementById("no-qrcode-text").classList.add("hidden");
          }

          var pendingCount = (json.pending || []).length;
          if (pBadge) {
            pBadge.innerText = pendingCount + " 笔待发";
            if (pendingCount > 0) {
              pBadge.className = "text-xs px-2.5 py-0.5 rounded-full font-bold bg-rose-500/20 text-rose-400 border border-rose-500/30 pending-alert";
            } else {
              pBadge.className = "text-xs px-2.5 py-0.5 rounded-full font-bold bg-slate-800 text-slate-400";
            }
          }

          if (pendingCount === 0) {
            pBox.innerHTML = '<div class="text-xs text-slate-500 text-center py-3">✅ 暂无待发货订单</div>';
          } else {
            pBox.innerHTML = json.pending.map(function(o) {
              return '<div class="p-3.5 rounded-xl bg-slate-800/90 border border-amber-500/40 space-y-2 shadow-lg">' +
                '<div class="flex justify-between items-center text-xs">' +
                  '<span class="font-mono text-white font-bold">' + o.order_no + '</span>' +
                  '<span class="px-2 py-0.5 bg-indigo-500/20 text-indigo-300 font-bold rounded">' + o.region + ' · ￥' + o.price + '</span>' +
                '</div>' +
                '<div class="text-xs text-amber-300 font-medium bg-slate-900 p-2 rounded-lg border border-slate-700 flex justify-between items-center">' +
                  '<span><i class="fa-solid fa-user-tag text-indigo-400 mr-1"></i> ' + (o.pay_type || '买家已扫码待发') + '</span>' +
                  '<span class="text-slate-400 text-[11px]">' + (o.contact ? '联系:' + o.contact : '') + '</span>' +
                '</div>' +
                '<div class="flex justify-between items-center pt-1">' +
                  '<span class="text-[11px] text-slate-400">' + o.created_at + '</span>' +
                  '<button data-no="' + o.order_no + '" onclick="approveOrder(this.dataset.no)" class="px-5 py-2 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white font-bold rounded-lg text-xs shadow-lg flex items-center gap-1.5 transition">' +
                    '<i class="fa-solid fa-check"></i> 确认收款并出卡' +
                  '</button>' +
                '</div>' +
              '</div>';
            }).join("");
          }

          rBox.innerHTML = json.recent.map(function(o) {
            return '<div class="p-2.5 rounded-lg bg-slate-800/60 text-xs border border-slate-700/60 space-y-1">' +
              '<div class="flex justify-between text-slate-400">' +
                '<span>' + o.order_no + ' (' + o.region + ')</span>' +
                '<span class="text-emerald-400 font-mono">' + o.paid_at + '</span>' +
              '</div>' +
              '<div class="text-slate-300 font-mono select-all break-all text-[11px] bg-slate-950 p-1.5 rounded">' + o.carmi + '</div>' +
            '</div>';
          }).join("");
        }
      } catch (e) {}
    }

    async function approveOrder(orderNo) {
      var key = document.getElementById("admin-key").value.trim();
      if (!confirm("确认已收到买家微信付款，立即为买家发货？")) return;

      try {
        var res = await fetch("/api/admin/approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: key, order_no: orderNo })
        });
        var json = await res.json();
        if (json.code === 0) {
          alert("✅ 发卡成功！买家屏幕已瞬间自动跳出账号和密码！");
          loadAdminData();
        } else {
          alert(json.msg || "核销失败");
        }
      } catch (e) {
        alert("网络错误");
      }
    }

    async function savePrice() {
      var key = document.getElementById("admin-key").value.trim();
      var price = document.getElementById("price-input").value.trim();
      if (!price || parseFloat(price) <= 0) return alert("请输入有效金额");

      try {
        var res = await fetch("/api/admin/set_price", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: key, price: price })
        });
        var json = await res.json();
        alert(json.msg || "价格保存成功");
        loadAdminData();
      } catch (e) {
        alert("价格保存失败");
      }
    }

    async function uploadQrcode() {
      var fileInput = document.getElementById("qrcode-file-input");
      var key = document.getElementById("admin-key").value.trim();
      if (!fileInput.files || fileInput.files.length === 0) return alert("请先选择一张图片");

      var file = fileInput.files[0];
      var btn = document.getElementById("btn-upload-qr");
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 上传中...';

      var reader = new FileReader();
      reader.onload = function(e) {
        var img = new Image();
        img.onload = async function() {
          var canvas = document.createElement("canvas");
          var maxDim = 600;
          var w = img.width, h = img.height;
          if (w > maxDim || h > maxDim) {
            if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
            else { w = Math.round(w * maxDim / h); h = maxDim; }
          }
          canvas.width = w;
          canvas.height = h;
          var ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, w, h);
          var compressedBase64 = canvas.toDataURL("image/jpeg", 0.88);

          try {
            var res = await fetch("/api/admin/upload_qrcode", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ key: key, image_data: compressedBase64 })
            });
            var json = await res.json();
            alert(json.msg || "上传成功");
            loadAdminData();
          } catch (err) {
            alert("上传失败，请重试");
          } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-cloud-arrow-up"></i> 保存收款码';
          }
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    }

    async function importCarmis() {
      var key = document.getElementById("admin-key").value.trim();
      var region = document.getElementById("import-region").value;
      var text = document.getElementById("import-text").value.trim();
      if (!text) return alert("请输入要导入的卡密内容");

      try {
        var res = await fetch("/api/admin/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: key, region: region, text: text })
        });
        var json = await res.json();
        alert(json.msg || "导入完成");
        document.getElementById("import-text").value = "";
        loadAdminData();
      } catch (e) {
        alert("导入失败");
      }
    }

    loadAdminData();
    var adminPollTimer = setInterval(loadAdminData, 5000);

    // 智能节流：离开页面/锁屏时自动停止请求，切回页面时立即刷新并恢复
    document.addEventListener("visibilitychange", function() {
      if (document.hidden) {
        if (adminPollTimer) clearInterval(adminPollTimer);
      } else {
        loadAdminData();
        adminPollTimer = setInterval(loadAdminData, 5000);
      }
    });
  </script>
</body>
</html>`;
}
