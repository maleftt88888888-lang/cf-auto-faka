/**
 * Cloudflare Worker - 智能自动抓取发卡系统 (XPay 动态浮动金额核销版)
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
      // 自动确保数据库表结构完整
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

      // 路由 2: 买家创建订单 (引入 XPay 动态浮动金额算法)
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
        const basePrice = parseFloat(basePriceStr);

        // XPay 核心动态浮动算法：查询最近 5 分钟内所有未支付订单的浮动金额
        const pendingPricesRes = await env.DB.prepare(`
          SELECT price FROM orders 
          WHERE status = 0 AND created_at > datetime('now', '-5 minutes')
        `).all();

        const activePrices = new Set((pendingPricesRes.results || []).map(r => Number(r.price).toFixed(2)));

        // 从基准价依次递增（+0.00, +0.01, +0.02, ... +0.99），找出第一个当前未被占用的金额
        let finalPrice = basePrice;
        for (let i = 0; i < 100; i++) {
          const testPrice = (basePrice + i * 0.01).toFixed(2);
          if (!activePrices.has(testPrice)) {
            finalPrice = parseFloat(testPrice);
            break;
          }
        }

        const checkCode = Math.floor(1000 + Math.random() * 9000).toString();
        const orderNo = "FK" + Date.now().toString().slice(-6) + checkCode;

        await env.DB.prepare(`
          INSERT INTO orders (order_no, region, contact, price, status, pay_type, created_at, replace_count)
          VALUES (?, ?, ?, ?, 0, ?, datetime('now'), 0)
        `).bind(orderNo, region, contact, finalPrice, `XPay浮动价:￥${finalPrice.toFixed(2)}`).run();

        return jsonResponse({
          code: 0,
          msg: "订单创建成功",
          data: {
            order_no: orderNo,
            check_code: checkCode,
            base_price: basePrice.toFixed(2),
            price: finalPrice.toFixed(2),
            region: region,
            expire_seconds: 300
          }
        }, corsHeaders);
      }

      // 路由 2.5: PC 微信 / 监控端 自动到账通知接口 (支持 XPay 精准浮动金额自动匹配)
      if (path === "/api/pay/notify" && request.method === "POST") {
        const body = await request.json();
        const key = body.key || body.secret || "";
        if (key !== (env.ADMIN_KEY || "51245124")) {
          return jsonResponse({ code: 403, msg: "通信密钥错误" }, corsHeaders, 403);
        }

        const tradeNo = (body.trade_no || "").trim();
        const amount = parseFloat(body.amount || "0");
        const raw = body.raw || "";

        if (!tradeNo && !amount) {
          return jsonResponse({ code: -1, msg: "缺少交易单号或金额" }, corsHeaders);
        }

        // 记录到 payments 流水池
        try {
          if (tradeNo) {
            await env.DB.prepare(`
              INSERT INTO payments (trade_no, amount, status, raw_message, created_at)
              VALUES (?, ?, 0, ?, datetime('now'))
            `).bind(tradeNo, amount, raw).run();
          }
        } catch (e) {}

        // XPay 核心：根据精准浮动金额自动匹配最近 6 分钟内的未支付订单并自动发卡
        if (amount > 0) {
          const matchedOrder = await env.DB.prepare(`
            SELECT * FROM orders 
            WHERE status = 0 AND ABS(price - ?) < 0.005 AND created_at > datetime('now', '-6 minutes')
            ORDER BY id ASC LIMIT 1
          `).bind(amount).first();

          if (matchedOrder) {
            console.log(`🎯 XPay 浮动金额自动命中订单: ${matchedOrder.order_no}, 金额: ￥${amount}`);
            const freshAccount = await fetchLatestLiveAccount(env, matchedOrder.region);
            if (freshAccount && freshAccount.carmi) {
              if (freshAccount.id) {
                await env.DB.prepare("UPDATE carmis SET status = 1, order_no = ?, sold_at = datetime('now') WHERE id = ?").bind(matchedOrder.order_no, freshAccount.id).run();
              }
              await env.DB.prepare(`
                UPDATE orders 
                SET status = 1, carmi = ?, pay_type = ?, paid_at = datetime('now'), replace_count = 0
                WHERE order_no = ?
              `).bind(freshAccount.carmi, `XPay自动核销(￥${amount.toFixed(2)}${tradeNo ? ' 单号:' + tradeNo : ''})`, matchedOrder.order_no).run();

              if (tradeNo) {
                await env.DB.prepare("UPDATE payments SET status = 1, order_no = ?, used_at = datetime('now') WHERE trade_no = ?").bind(matchedOrder.order_no, tradeNo).run();
              }
              return jsonResponse({ code: 0, msg: `🎉 XPay 自动匹配成功！订单 ${matchedOrder.order_no} 已自动发卡出库！`, order_no: matchedOrder.order_no }, corsHeaders);
            }
          }
        }

        return jsonResponse({ code: 0, msg: "到账流水已入库，未匹配到待支付订单" }, corsHeaders);
      }

      // 路由 3: 买家自助提取卡密 (支持 XPay 精准浮动验证 / 微信单号验证)
      if (path === "/api/order/claim" && request.method === "POST") {
        const body = await request.json();
        const orderNo = (body.order_no || "").trim();
        const tradeNo = (body.trade_no || "").trim();

        if (!orderNo) return jsonResponse({ code: -1, msg: "缺少订单号" }, corsHeaders);

        const order = await env.DB.prepare("SELECT * FROM orders WHERE order_no = ?").bind(orderNo).first();
        if (!order) return jsonResponse({ code: -1, msg: "订单不存在" }, corsHeaders);

        // 如果该订单之前已出过卡密，直接返回之前已领取的卡密（防止刷单重复获取不同卡）
        if (order.status === 1 && order.carmi) {
          const warranty = getOrderWarrantyInfo(order);
          return jsonResponse({
            code: 0,
            msg: "提取成功",
            data: { order_no: orderNo, carmi: order.carmi, region: order.region, warranty }
          }, corsHeaders);
        }

        let verifiedTradeNo = "";

        // 情况 A: 买家输入了微信交易单号（至少4位）
        if (tradeNo && tradeNo.length >= 4) {
          // 防单号被重复盗用
          const usedCheck = await env.DB.prepare(
            "SELECT id FROM orders WHERE pay_type LIKE ? AND id != ? AND status = 1"
          ).bind(`%${tradeNo}%`, order.id).first();

          if (usedCheck) {
            return jsonResponse({ code: -1, msg: "❌ 该微信交易单号已被使用，请勿重复提交！" }, corsHeaders);
          }

          // 如果到账池有对应流水则同步标记
          try {
            await env.DB.prepare("UPDATE payments SET status = 1, order_no = ?, used_at = datetime('now') WHERE (trade_no LIKE ? OR trade_no = ?) AND status = 0").bind(orderNo, `%${tradeNo}`, tradeNo).run();
          } catch(e) {}

          verifiedTradeNo = `微信单号:${tradeNo}`;
        } else {
          // 情况 B: 买家没有填单号，直接点“立即出卡”，检查后台是否已监听到真实到账
          const paymentRecord = await env.DB.prepare(
            "SELECT id, trade_no, amount FROM payments WHERE ABS(amount - ?) < 0.005 AND status = 0 AND created_at > datetime('now', '-10 minutes') ORDER BY id DESC LIMIT 1"
          ).bind(order.price).first();

          if (!paymentRecord) {
            return jsonResponse({
              code: -1,
              msg: `⚠️ 未自动检测到 ￥${Number(order.price).toFixed(2)} 的到账记录。\n如果您已微信扫码付款，请在下方输入微信账单中的【交易单号后4位】即可秒提卡密！`
            }, corsHeaders);
          }

          await env.DB.prepare("UPDATE payments SET status = 1, order_no = ?, used_at = datetime('now') WHERE id = ?").bind(orderNo, paymentRecord.id).run();
          verifiedTradeNo = `XPay核销:${paymentRecord.trade_no || ('￥' + Number(order.price).toFixed(2))}`;
        }

        // 实时穿透请求原网页抓取最新账号
        console.log(`⚡ 核验通过 (订单 ${orderNo}, 凭证 ${verifiedTradeNo})，正在实时从原网页获取最新账号...`);
        const freshAccount = await fetchLatestLiveAccount(env, order.region);

        if (!freshAccount || !freshAccount.carmi) {
          return jsonResponse({ code: -1, msg: `原网站暂无可用的【${order.region}】最新账号，请稍后再试或联系站长！` }, corsHeaders);
        }

        if (freshAccount.id) {
          await env.DB.prepare("UPDATE carmis SET status = 1, order_no = ?, sold_at = datetime('now') WHERE id = ?").bind(orderNo, freshAccount.id).run();
        }
        await env.DB.prepare(`
          UPDATE orders 
          SET status = 1, carmi = ?, pay_type = ?, paid_at = datetime('now'), replace_count = 0
          WHERE order_no = ?
        `).bind(freshAccount.carmi, verifiedTradeNo, orderNo).run();

        const updatedOrder = await env.DB.prepare("SELECT * FROM orders WHERE order_no = ?").bind(orderNo).first();
        const warranty = getOrderWarrantyInfo(updatedOrder);

        return jsonResponse({
          code: 0,
          msg: "🎉 核验成功！已为您实时获取原网站最新可用账号！",
          data: {
            order_no: orderNo,
            carmi: freshAccount.carmi,
            region: freshAccount.region || order.region,
            warranty
          }
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
          await env.DB.prepare("UPDATE carmis SET status = 1, order_no = ?, sold_at = datetime('now') WHERE id = ?").bind(orderNo, freshAccount.id).run();
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

        const order = await env.DB.prepare("SELECT order_no, status, carmi, region, price, created_at, paid_at, replace_count FROM orders WHERE order_no = ?").bind(orderNo).first();
        if (!order) return jsonResponse({ code: -1, msg: "订单不存在" }, corsHeaders);

        const warranty = getOrderWarrantyInfo(order);

        return jsonResponse({
          code: 0,
          status: order.status,
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
          ORDER BY id DESC LIMIT 15
        `).all();

        let currentQrcode = "";
        let currentPrice = env.PRICE_PER_ACCOUNT || "4.99";
        let strictVerify = "0";
        try {
          const qrSetting = await env.DB.prepare("SELECT value FROM settings WHERE key = 'PAY_QRCODE'").first();
          if (qrSetting) currentQrcode = qrSetting.value;

          const priceSetting = await env.DB.prepare("SELECT value FROM settings WHERE key = 'PRICE'").first();
          if (priceSetting) currentPrice = priceSetting.value;

          const strictSetting = await env.DB.prepare("SELECT value FROM settings WHERE key = 'STRICT_VERIFY'").first();
          if (strictSetting) strictVerify = strictSetting.value;
        } catch (e) {}

        return jsonResponse({
          code: 0,
          pending: pendingOrders.results || [],
          recent: recentPaid.results || [],
          qrcode: currentQrcode,
          price: parseFloat(currentPrice).toFixed(2),
          strict_verify: strictVerify
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
          VALUES ('PRICE', ?, datetime('now'))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
        `).bind(price.toFixed(2)).run();

        return jsonResponse({
          code: 0,
          msg: `🎉 基准销售金额已设置为：￥${price.toFixed(2)}！`
        }, corsHeaders);
      }

      // 路由 6.5: 管理员后台 - 切换核销模式
      if (path === "/api/admin/set_mode" && request.method === "POST") {
        const body = await request.json();
        const key = body.key || "";
        if (key !== (env.ADMIN_KEY || "51245124")) {
          return jsonResponse({ code: 403, msg: "管理员密钥错误" }, corsHeaders, 403);
        }

        const mode = body.strict_verify === "1" ? "1" : "0";
        await env.DB.prepare(`
          INSERT INTO settings (key, value, updated_at)
          VALUES ('STRICT_VERIFY', ?, datetime('now'))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
        `).bind(mode).run();

        return jsonResponse({
          code: 0,
          msg: `核销模式已切换为：${mode === '1' ? '【严格到账池验资模式】' : '【XPay 动态浮动极速秒出卡模式】'}`
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
          VALUES ('PAY_QRCODE', ?, datetime('now'))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
        `).bind(imageData).run();

        return jsonResponse({
          code: 0,
          msg: "🎉 收款码已成功上传并保存在 Cloudflare 中！"
        }, corsHeaders);
      }

      // 路由 8: 管理员后台 - 手动一键核销发卡
      if (path === "/api/admin/approve" && request.method === "POST") {
        const body = await request.json();
        const key = body.key || "";
        if (key !== (env.ADMIN_KEY || "51245124")) {
          return jsonResponse({ code: 403, msg: "管理员密钥错误" }, corsHeaders, 403);
        }

        const orderNo = body.order_no;
        const order = await env.DB.prepare("SELECT * FROM orders WHERE order_no = ? AND status = 0").bind(orderNo).first();
        if (!order) return jsonResponse({ code: -1, msg: "订单不存在或已被核销" }, corsHeaders);

        const freshAccount = await fetchLatestLiveAccount(env, order.region);
        if (!freshAccount || !freshAccount.carmi) {
          return jsonResponse({ code: -1, msg: `【${order.region}】原网站暂无可发账号！` }, corsHeaders);
        }

        if (freshAccount.id) {
          await env.DB.prepare("UPDATE carmis SET status = 1, order_no = ?, sold_at = datetime('now') WHERE id = ?").bind(orderNo, freshAccount.id).run();
        }
        await env.DB.prepare("UPDATE orders SET status = 1, carmi = ?, paid_at = datetime('now') WHERE order_no = ?").bind(freshAccount.carmi, orderNo).run();

        return jsonResponse({
          code: 0,
          msg: "核销成功，已自动出卡！",
          carmi: freshAccount.carmi
        }, corsHeaders);
      }

      // 路由 9: 管理员手动批量导入卡密
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
              VALUES (?, ?, ?, ?, 0, datetime('now'))
            `).bind(defaultRegion, line, line, line).run();
            imported++;
          } catch (e) {}
        }

        return jsonResponse({
          code: 0,
          msg: `成功导入 ${imported} 条卡密！`
        }, corsHeaders);
      }

      // 路由 10: 历史订单查询
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

      // 路由 11: 管理员后台页面 (/admin)
      if (path === "/admin") {
        return new Response(getAdminHTML(env), {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }

      // 路由 12: 买家前台首页
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
 * 确保数据库表结构完整 (orders表扩展 + payments真实到账池表)
 */
async function ensureDbMigrated(env) {
  try {
    await env.DB.prepare("ALTER TABLE orders ADD COLUMN replace_count INTEGER DEFAULT 0").run();
  } catch (e) {}
  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_no TEXT UNIQUE NOT NULL,
        amount REAL NOT NULL DEFAULT 0.0,
        status INTEGER DEFAULT 0,
        order_no TEXT DEFAULT NULL,
        raw_message TEXT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        used_at DATETIME DEFAULT NULL
      )
    `).run();
    await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_payments_trade_no ON payments(trade_no)").run();
    await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_payments_amount ON payments(amount)").run();
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
    const parsed = new Date(baseTimeStr.replace(" ", "T") + "Z").getTime();
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
          VALUES (?, ?, ?, ?, 0, datetime('now'))
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
 * 买家前台页面 (集成 XPay 动态浮动金额支付 + 自动轮询秒出卡 + 质保换号)
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
    @keyframes pulse-glow {
      0%, 100% { transform: scale(1); filter: drop-shadow(0 0 8px rgba(245, 158, 11, 0.6)); }
      50% { transform: scale(1.03); filter: drop-shadow(0 0 16px rgba(245, 158, 11, 0.9)); }
    }
    .pulse-amount { animation: pulse-glow 2s infinite ease-in-out; }
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

    <div class="text-center mb-8">
      <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-indigo-600/20 text-indigo-400 mb-4 border border-indigo-500/30">
        <i class="fa-solid fa-cloud-bolt text-2xl"></i>
      </div>
      <h1 class="text-3xl font-bold tracking-tight text-white mb-2">${siteName}</h1>
      <p class="text-slate-400 text-sm">XPay 智能核销 · 24小时自动发卡 · 实时库存同步 · 关网页随时查回最新卡密</p>
    </div>

    <div class="glass rounded-2xl p-6 sm:p-8 shadow-2xl mb-6">
      <div class="flex border-b border-slate-700 mb-6">
        <button id="tab-buy" onclick="switchTab('buy')" class="py-2.5 px-6 font-medium text-indigo-400 border-b-2 border-indigo-500 flex items-center gap-2">
          <i class="fa-solid fa-cart-shopping"></i> 在线下单
        </button>
        <button id="tab-query" onclick="switchTab('query')" class="py-2.5 px-6 font-medium text-slate-400 hover:text-slate-200 flex items-center gap-2">
          <i class="fa-solid fa-magnifying-glass"></i> 订单查询 (找回卡密)
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
            <span class="text-sm text-slate-400">基准单价：</span>
            <span class="text-2xl font-bold text-indigo-400" id="display-price">￥4.99</span>
            <span class="text-xs text-slate-400 block mt-0.5">（支付时将微调角分自动秒出卡）</span>
          </div>
          <button onclick="submitOrder()" id="btn-submit" class="w-full sm:w-auto px-8 py-3.5 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-semibold rounded-xl shadow-lg shadow-indigo-500/25 transition duration-200 flex items-center justify-center gap-2">
            <i class="fa-solid fa-qrcode"></i> 立即扫码付款出卡
          </button>
        </div>
      </div>

      <div id="panel-query" class="space-y-6 hidden">
        <div>
          <label class="block text-sm font-medium text-slate-300 mb-2">输入订单号、联系方式或微信单号找回：</label>
          <div class="flex gap-2">
            <input type="text" id="query-keyword" placeholder="输入订单号 / 手机号 / 邮箱 / 微信交易单号" class="flex-1 px-4 py-3 rounded-xl bg-slate-800/80 border border-slate-700 text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 text-sm">
            <button onclick="queryOrders()" class="px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-xl transition">
              <i class="fa-solid fa-search"></i> 查询找回
            </button>
          </div>
        </div>
        <div id="query-results" class="space-y-3"></div>
      </div>
    </div>

    <!-- 弹窗 1：XPay 动态浮动金额扫码支付与自动秒提卡弹窗 -->
    <div id="modal-pay" class="fixed inset-0 bg-black/80 backdrop-blur-md hidden flex items-center justify-center p-4 z-50">
      <div class="glass max-w-sm w-full rounded-2xl p-6 shadow-2xl space-y-4 border border-indigo-500/40 text-center">
        <div class="flex justify-between items-center">
          <h3 class="text-base font-bold text-white flex items-center gap-1.5">
            <i class="fa-brands fa-weixin text-emerald-400 text-lg"></i> 微信扫码支付
          </h3>
          <span class="text-[11px] bg-indigo-500/20 text-indigo-300 px-2 py-0.5 rounded-full border border-indigo-500/30">
            XPay智能核销
          </span>
        </div>

        <!-- 动态微调浮动金额提示栏 -->
        <div class="bg-gradient-to-r from-amber-500/20 via-indigo-500/20 to-emerald-500/20 border border-amber-500/40 rounded-xl p-3 text-center">
          <div class="text-xs text-slate-300 mb-0.5">请微信扫码精准支付（含角分）：</div>
          <div class="text-3xl font-extrabold text-amber-400 font-mono tracking-tight pulse-amount my-1" id="pay-money">￥4.99</div>
          <div class="text-[11px] text-amber-300/90 font-medium flex items-center justify-center gap-1 mt-1">
            <i class="fa-solid fa-triangle-exclamation"></i> 请务必按上述精准金额付款，多付少付无法自动识别
          </div>
        </div>

        <!-- 收款二维码 -->
        <div class="p-2 bg-white rounded-xl inline-block shadow-inner mx-auto max-w-[190px] max-h-[190px]">
          <img id="pay-qr-img" src="" alt="微信收款码" class="w-40 h-40 rounded-lg object-contain mx-auto">
        </div>

        <!-- 倒计时与监听指示器 -->
        <div class="space-y-1.5">
          <div class="text-xs font-mono text-indigo-300 bg-slate-900/80 py-1.5 px-3 rounded-lg border border-indigo-500/30 inline-flex items-center gap-1.5">
            <i class="fa-regular fa-clock text-amber-400"></i> 金额有效倒计时: <span id="pay-countdown" class="text-amber-400 font-bold">05:00</span>
          </div>
          <div class="text-[11px] text-slate-400 flex items-center justify-center gap-1.5 animate-pulse">
            <i class="fa-solid fa-spinner fa-spin text-emerald-400"></i> 系统正在实时监听微信到账，付款后约3秒自动出卡...
          </div>
        </div>

        <!-- 自助提卡栏 -->
        <div class="bg-indigo-950/60 border border-indigo-500/40 rounded-xl p-3 text-left space-y-2">
          <label class="text-[11px] text-indigo-300 font-medium block">
            <i class="fa-solid fa-receipt"></i> 付款后输入【微信账单交易单号后4位】：
          </label>
          <div class="flex gap-2">
            <input type="text" id="trade-no-input" placeholder="输入账单单号后4位" class="flex-1 px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-xs font-mono text-emerald-400 focus:outline-none focus:border-indigo-500">
            <button onclick="claimCarmi()" id="btn-claim" class="px-4 py-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold rounded-lg text-xs flex items-center gap-1 shadow-lg shrink-0 transition">
              <i class="fa-solid fa-key"></i> 立即提卡
            </button>
          </div>
          <div class="text-[10px] text-slate-400 leading-tight">
            * 微信付款后点进账单详情即可查看交易单号。
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
          <h3 class="text-xl font-bold text-white">🎉 支付成功，已为您发卡！</h3>
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

    <div class="text-center text-xs text-slate-500 space-y-2">
      <p>⚠️ 提示：账号仅供在 App Store 登录下载应用，切勿在系统设置中登录 iCloud！</p>
      <p><a href="/admin" class="hover:text-indigo-400">管理后台</a> · Powered by Cloudflare Workers & D1</p>
    </div>
  </div>

  <script>
    var currentSelectedRegion = "美国";
    var loadedRegions = [];
    var currentOrderNo = null;
    var warrantyTimer = null;
    var currentFullCarmi = "";
    var payPollingTimer = null;
    var payExpireTimer = null;

    function parseCarmi(raw) {
      if (!raw) return { account: "", password: "", raw: "" };
      var account = "";
      var password = "";

      var accMatch = raw.match(/账号:\\s*([^\\s-]+)/);
      if (accMatch) account = accMatch[1].trim();

      var pwdMatch = raw.match(/密码:\\s*(.+)$/);
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

    function startPayPolling(orderNo, expireSecs) {
      if (payPollingTimer) clearInterval(payPollingTimer);
      if (payExpireTimer) clearInterval(payExpireTimer);

      var leftSeconds = expireSecs || 300;
      var countEl = document.getElementById("pay-countdown");

      function updateExpireUI() {
        if (leftSeconds <= 0) {
          if (countEl) countEl.innerText = "已失效";
          clearInterval(payExpireTimer);
          clearInterval(payPollingTimer);
          return;
        }
        var m = Math.floor(leftSeconds / 60);
        var s = leftSeconds % 60;
        if (countEl) {
          countEl.innerText = (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
        }
        leftSeconds--;
      }

      updateExpireUI();
      payExpireTimer = setInterval(updateExpireUI, 1000);

      payPollingTimer = setInterval(async function() {
        try {
          var res = await fetch("/api/order/check?order_no=" + orderNo);
          var json = await res.json();
          if (json.code === 0 && json.status === 1 && json.carmi) {
            clearInterval(payPollingTimer);
            clearInterval(payExpireTimer);
            document.getElementById("modal-pay").classList.add("hidden");
            document.getElementById("res-order-no").innerText = orderNo;
            renderCarmiResult(json.carmi);
            updateWarrantyUI(json.warranty, orderNo);
            document.getElementById("modal-result").classList.remove("hidden");
            showToast("🎉 支付成功，已自动出卡！");
            loadStats();
          }
        } catch (e) {}
      }, 2500);
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
            document.getElementById("modal-pay").classList.remove("hidden");
            startPayPolling(currentOrderNo, 300);
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
          document.getElementById("trade-no-input").value = "";
          document.getElementById("modal-pay").classList.remove("hidden");

          startPayPolling(currentOrderNo, data.data.expire_seconds || 300);
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

    async function claimCarmi(orderNoOverride) {
      var targetOrder = orderNoOverride || currentOrderNo;
      var tradeNo = document.getElementById("trade-no-input").value.trim();
      if (!targetOrder) return alert("订单已失效，请重新下单");

      var btn = document.getElementById("btn-claim");
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在核验并从原站提取账号...';
      }

      try {
        var res = await fetch("/api/order/claim", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order_no: targetOrder, trade_no: tradeNo })
        });
        var json = await res.json();
        if (json.code === 0) {
          if (payPollingTimer) clearInterval(payPollingTimer);
          if (payExpireTimer) clearInterval(payExpireTimer);
          document.getElementById("modal-pay").classList.add("hidden");
          document.getElementById("res-order-no").innerText = targetOrder;
          renderCarmiResult(json.data.carmi);
          updateWarrantyUI(json.data.warranty, targetOrder);
          document.getElementById("modal-result").classList.remove("hidden");
          loadStats();
        } else {
          alert(json.msg || "提卡失败");
        }
      } catch (err) {
        alert("网络异常，请稍后重试");
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<i class="fa-solid fa-bolt"></i> 我已完成精准支付，立即出卡';
        }
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
      if (payExpireTimer) clearInterval(payExpireTimer);
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
              statusHtml = '<button data-no="' + o.order_no + '" onclick="currentOrderNo=this.dataset.no;restoreRecentOrder()" class="text-emerald-400 hover:text-emerald-300 font-medium text-xs"><i class="fa-solid fa-key"></i> 去提卡</button>';
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
                 : '<div class="text-xs font-mono text-amber-400 bg-slate-950 p-2.5 rounded border border-slate-800">待付款/待提卡</div>') +
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
 * 站长管理后台页面 (/admin)
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
      <i class="fa-solid fa-shield-halved"></i> 站长控制台 (XPay动态浮动核销版)
    </h1>
    <a href="/" class="text-xs text-slate-400 hover:text-white">返回首页</a>
  </div>

  <div class="space-y-4">
    <!-- 管理秘钥输入 -->
    <div class="p-4 rounded-xl bg-slate-900 border border-slate-800 flex gap-2">
      <input type="password" id="admin-key" placeholder="输入管理员密钥" value="51245124" class="flex-1 px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm text-white">
      <button onclick="loadAdminData()" class="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-medium">刷新</button>
    </div>

    <!-- 设置基准销售价格与核销模式 -->
    <div class="p-4 rounded-xl bg-slate-900 border border-slate-800 space-y-4">
      <div>
        <h2 class="font-bold text-indigo-400 flex items-center gap-2 text-sm mb-2">
          <i class="fa-solid fa-tag"></i> 设置基准销售价格 (元)
        </h2>
        <div class="flex gap-2">
          <div class="relative flex-1">
            <span class="absolute left-3 top-2 text-slate-400 text-sm">￥</span>
            <input type="number" id="price-input" step="0.01" min="0.01" placeholder="4.99" class="w-full pl-8 pr-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm font-bold text-emerald-400">
          </div>
          <button onclick="savePrice()" class="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-lg text-xs flex items-center gap-1">
            <i class="fa-solid fa-floppy-disk"></i> 保存价格
          </button>
        </div>
      </div>

      <div class="pt-3 border-t border-slate-800">
        <h2 class="font-bold text-emerald-400 flex items-center gap-2 text-sm mb-2">
          <i class="fa-solid fa-sliders"></i> 核销出卡模式切换
        </h2>
        <div class="flex items-center justify-between bg-slate-800/80 p-3 rounded-xl border border-slate-700">
          <div>
            <div class="text-xs font-bold text-white" id="mode-title">XPay 动态浮动秒出卡模式 (推荐)</div>
            <div class="text-[11px] text-slate-400">买家按微调金额付款后，系统即可极速发卡，无需等待复杂监控插件</div>
          </div>
          <select id="strict-mode-select" onchange="changeMode()" class="px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-xs font-bold text-indigo-300">
            <option value="0">⚡ XPay 动态浮动模式</option>
            <option value="1">🔒 严格到账池验资模式</option>
          </select>
        </div>
      </div>
    </div>

    <!-- 上传微信收款码图片 -->
    <div class="p-4 rounded-xl bg-slate-900 border border-slate-800 space-y-3">
      <h2 class="font-bold text-emerald-400 flex items-center gap-2 text-sm">
        <i class="fa-solid fa-image"></i> 设置微信收款码 (直接保存至 Cloudflare)
      </h2>
      <div class="flex flex-col sm:flex-row gap-4 items-center">
        <div class="w-24 h-24 bg-slate-800 rounded-lg border border-slate-700 flex items-center justify-center overflow-hidden">
          <img id="current-qrcode-preview" src="" alt="收款码" class="w-full h-full object-contain hidden">
          <span id="no-qrcode-text" class="text-xs text-slate-500">未设置</span>
        </div>
        <div class="flex-1 space-y-2 w-full">
          <input type="file" id="qrcode-file-input" accept="image/*" class="text-xs text-slate-400 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-indigo-600 file:text-white hover:file:bg-indigo-700 cursor-pointer">
          <button onclick="uploadQrcode()" id="btn-upload-qr" class="w-full sm:w-auto px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-lg text-xs flex items-center justify-center gap-1">
            <i class="fa-solid fa-cloud-arrow-up"></i> 一键上传到 Cloudflare
          </button>
        </div>
      </div>
    </div>

    <!-- 待核销订单列表 -->
    <div class="p-4 rounded-xl bg-slate-900 border border-slate-800 space-y-3">
      <h2 class="font-bold text-amber-400 flex items-center gap-2 text-sm">
        <i class="fa-solid fa-bell"></i> 待提取订单 (含精准浮动金额)
      </h2>
      <div id="pending-list" class="space-y-2">
        <div class="text-slate-500 text-xs py-2 text-center">点击刷新加载数据</div>
      </div>
    </div>

    <!-- 手动批量导入卡密 -->
    <div class="p-4 rounded-xl bg-slate-900 border border-slate-800 space-y-3">
      <h2 class="font-bold text-indigo-400 flex items-center gap-2 text-sm">
        <i class="fa-solid fa-file-import"></i> 批量导入卡密 (备用库存)
      </h2>
      <div class="space-y-2">
        <div class="flex gap-2">
          <select id="import-region" class="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-white">
            <option value="美国">美国</option>
            <option value="香港">香港</option>
            <option value="日本">日本</option>
            <option value="台湾">台湾</option>
            <option value="通用">通用</option>
          </select>
          <button onclick="importCarmis()" class="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-lg text-xs">
            确认导入
          </button>
        </div>
        <textarea id="import-text" rows="3" placeholder="一行一条卡密，例如：&#10;账号: xxx@outlook.com ---- 密码: xxx&#10;账号: yyy@outlook.com ---- 密码: yyy" class="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-xs font-mono text-white"></textarea>
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
      var key = document.getElementById("admin-key").value.trim();
      var pBox = document.getElementById("pending-list");
      var rBox = document.getElementById("recent-list");
      pBox.innerHTML = '<div class="text-xs text-slate-400 text-center py-2">加载中...</div>';

      try {
        var res = await fetch("/api/admin/orders?key=" + encodeURIComponent(key));
        var json = await res.json();
        if (json.code === 0) {
          if (json.price) {
            document.getElementById("price-input").value = json.price;
          }

          if (json.strict_verify !== undefined) {
            document.getElementById("strict-mode-select").value = json.strict_verify;
          }

          if (json.qrcode) {
            document.getElementById("current-qrcode-preview").src = json.qrcode;
            document.getElementById("current-qrcode-preview").classList.remove("hidden");
            document.getElementById("no-qrcode-text").classList.add("hidden");
          }

          if (json.pending.length === 0) {
            pBox.innerHTML = '<div class="text-xs text-slate-500 text-center py-2">暂无未提取订单</div>';
          } else {
            pBox.innerHTML = json.pending.map(function(o) {
              return '<div class="p-3 rounded-lg bg-slate-800 border border-slate-700 flex justify-between items-center gap-2">' +
                '<div class="text-xs space-y-1">' +
                  '<div class="font-mono text-white font-bold">' + o.order_no + ' | <span class="text-indigo-400">' + o.region + '</span></div>' +
                  '<div class="text-amber-400 font-bold">' + o.pay_type + ' | 精准金额: ￥' + o.price + '</div>' +
                  '<div class="text-slate-500">' + o.created_at + '</div>' +
                '</div>' +
                '<button data-no="' + o.order_no + '" onclick="approveOrder(this.dataset.no)" class="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-lg text-xs shadow-lg flex items-center gap-1">' +
                  '<i class="fa-solid fa-check"></i> 手动发卡' +
                '</button>' +
              '</div>';
            }).join("");
          }

          rBox.innerHTML = json.recent.map(function(o) {
            return '<div class="p-2.5 rounded-lg bg-slate-800/60 text-xs border border-slate-700/60 space-y-1">' +
              '<div class="flex justify-between text-slate-400">' +
                '<span>' + o.order_no + ' (' + o.region + ') - <b class="text-indigo-300">￥' + o.price + ' | ' + o.pay_type + '</b></span>' +
                '<span class="text-emerald-400 font-mono">' + o.paid_at + '</span>' +
              '</div>' +
              '<div class="text-slate-300 font-mono select-all break-all">' + o.carmi + '</div>' +
            '</div>';
          }).join("");
        } else {
          alert(json.msg || "密钥错误");
        }
      } catch (e) {
        alert("请求失败");
      }
    }

    async function changeMode() {
      var key = document.getElementById("admin-key").value.trim();
      var mode = document.getElementById("strict-mode-select").value;

      try {
        var res = await fetch("/api/admin/set_mode", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: key, strict_verify: mode })
        });
        var json = await res.json();
        alert(json.msg || "模式切换成功");
        loadAdminData();
      } catch (e) {
        alert("模式切换失败");
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
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 压缩并上传中...';

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
            btn.innerHTML = '<i class="fa-solid fa-cloud-arrow-up"></i> 一键上传到 Cloudflare';
          }
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    }

    async function approveOrder(orderNo) {
      var key = document.getElementById("admin-key").value.trim();
      if (!confirm("确认手动为买家出卡？")) return;

      try {
        var res = await fetch("/api/admin/approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: key, order_no: orderNo })
        });
        var json = await res.json();
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
  </script>
</body>
</html>`;
}
