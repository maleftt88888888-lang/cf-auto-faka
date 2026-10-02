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
        let currentSiteName = env.SITE_NAME || "小火箭账号";
        let categoryPrices = {};
        let categoryImages = {};
        let siteAnnouncement = "";
        let payNote = "";
        let contactInfo = { wechat: "", wechat_qr: "", telegram: "", qq: "", custom_tip: "" };

        try {
          const qrRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'PAY_QRCODE'").first();
          if (qrRow && qrRow.value) qrcode = qrRow.value;

          const noteRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'PAY_NOTE'").first();
          if (noteRow && noteRow.value) payNote = noteRow.value;

          const priceRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'PRICE'").first();
          if (priceRow && priceRow.value) currentPrice = priceRow.value;

          const siteRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'SITE_NAME'").first();
          if (siteRow && siteRow.value) currentSiteName = siteRow.value;

          const annRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'SITE_ANNOUNCEMENT'").first();
          if (annRow && annRow.value) siteAnnouncement = annRow.value;

          const contactRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'CONTACT_INFO'").first();
          if (contactRow && contactRow.value) {
            try { contactInfo = JSON.parse(contactRow.value); } catch(e) {}
          }

          const catPriceRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'CATEGORY_PRICES'").first();
          if (catPriceRow && catPriceRow.value) {
            try { categoryPrices = JSON.parse(catPriceRow.value); } catch(e) {}
          }

          const catImgRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'CATEGORY_IMAGES'").first();
          if (catImgRow && catImgRow.value) {
            try { categoryImages = JSON.parse(catImgRow.value); } catch(e) {}
          }
        } catch (e) {}

        let totalSoldDb = 0;
        try {
          const countRes = await env.DB.prepare("SELECT COUNT(*) as cnt FROM orders WHERE status = 1").first();
          if (countRes && countRes.cnt) totalSoldDb = countRes.cnt;
        } catch(e) {}

        return jsonResponse({
          code: 0,
          data: Object.values(regionMap),
          site_name: currentSiteName,
          announcement: siteAnnouncement,
          contact_info: contactInfo,
          total_sold: totalSoldDb,
          price: parseFloat(currentPrice).toFixed(2),
          category_prices: categoryPrices,
          category_images: categoryImages,
          pay_note: payNote,
          pay_qrcode: qrcode || "https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=300"
        }, corsHeaders);
      }

      // 路由 1.8: 买家验证优惠券
      if (path === "/api/coupon/verify") {
        const code = (url.searchParams.get("code") || "").trim().toUpperCase();
        const rawPrice = parseFloat(url.searchParams.get("price") || "0");
        if (!code) return jsonResponse({ code: -1, msg: "请输入优惠券代码" }, corsHeaders);

        const coupon = await env.DB.prepare("SELECT * FROM coupons WHERE code = ? AND status = 1").bind(code).first();
        if (!coupon) return jsonResponse({ code: -1, msg: "优惠码不存在或已停用" }, corsHeaders);

        if (coupon.max_uses !== -1 && coupon.used_count >= coupon.max_uses) {
          return jsonResponse({ code: -1, msg: "该优惠券已被领完或达到使用上限" }, corsHeaders);
        }

        if (rawPrice < (coupon.min_amount || 0)) {
          return jsonResponse({ code: -1, msg: `该优惠券需订单金额满 ￥${coupon.min_amount} 才能使用` }, corsHeaders);
        }

        let discount = 0;
        if (coupon.discount_type === 'percent') {
          discount = rawPrice * (1 - coupon.discount_val / 100);
        } else {
          discount = coupon.discount_val;
        }
        discount = Math.min(Math.max(0, rawPrice - 0.01), discount);
        const finalPrice = Math.max(0.01, rawPrice - discount);

        return jsonResponse({
          code: 0,
          msg: `🎉 优惠码有效！已立减 ￥${discount.toFixed(2)}`,
          data: {
            code: coupon.code,
            discount: discount.toFixed(2),
            final_price: finalPrice.toFixed(2),
            discount_type: coupon.discount_type,
            discount_val: coupon.discount_val
          }
        }, corsHeaders);
      }

      // 路由 2: 买家创建订单
      if (path === "/api/order/create" && request.method === "POST") {
        const body = await request.json();
        const region = body.region || "美国";
        const contact = (body.contact || "").trim();
        const couponCode = (body.coupon_code || "").trim().toUpperCase();
        const quantity = Math.max(1, parseInt(body.quantity) || 1);
        const payMethod = (body.pay_method || "微信支付").trim();

        // 校验邮箱格式（当联系方式填写时进行验证）
        if (contact) {
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (!emailRegex.test(contact)) {
            return jsonResponse({ code: -1, msg: "请输入有效的邮箱地址（例如: user@qq.com）" }, corsHeaders);
          }
        }

        // 防刷频控：限制同一时间段内大量生成未支付订单
        try {
          const recentPending = await env.DB.prepare(`
            SELECT COUNT(*) as cnt FROM orders 
            WHERE status = 0 AND created_at > datetime('now', '+8 hours', '-10 minutes')
          `).first();
          if (recentPending && recentPending.cnt >= 35) {
            return jsonResponse({ code: -1, msg: "系统排队繁忙，请稍后再试或先完成已有订单！" }, corsHeaders);
          }
        } catch(e) {}

        // 检查库存
        const countRes = await env.DB.prepare(
          "SELECT COUNT(*) as cnt FROM carmis WHERE (region = ? OR region = '通用') AND status = 0"
        ).bind(region).first();

        if (!countRes || countRes.cnt < quantity) {
          return jsonResponse({ code: -1, msg: `当前【${region}】库存不足（仅剩 ${countRes ? countRes.cnt : 0} 个），请减少购买数量或联系站长补货！` }, corsHeaders);
        }

        let basePriceStr = env.PRICE_PER_ACCOUNT || "4.99";
        try {
          const priceRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'PRICE'").first();
          if (priceRow && priceRow.value) basePriceStr = priceRow.value;

          const catPriceRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'CATEGORY_PRICES'").first();
          if (catPriceRow && catPriceRow.value) {
            const catMap = JSON.parse(catPriceRow.value);
            if (catMap && catMap[region]) basePriceStr = catMap[region];
          }
        } catch (e) {}
        const unitPrice = parseFloat(basePriceStr);
        let rawPrice = unitPrice * quantity;
        let finalPrice = rawPrice;

        if (couponCode) {
          try {
            const coupon = await env.DB.prepare("SELECT * FROM coupons WHERE code = ? AND status = 1").bind(couponCode).first();
            if (coupon && (coupon.max_uses === -1 || coupon.used_count < coupon.max_uses) && rawPrice >= (coupon.min_amount || 0)) {
              let discount = 0;
              if (coupon.discount_type === 'percent') {
                discount = rawPrice * (1 - coupon.discount_val / 100);
              } else {
                discount = coupon.discount_val;
              }
              discount = Math.min(Math.max(0, rawPrice - 0.01), discount);
              if (discount > 0) {
                finalPrice = Math.max(0.01, rawPrice - discount);
                await env.DB.prepare("UPDATE coupons SET used_count = used_count + 1 WHERE id = ?").bind(coupon.id).run();
              }
            }
          } catch(e) {}
        }

        const checkCode = Math.floor(1000 + Math.random() * 9000).toString();
        const orderNo = "FK" + Date.now().toString().slice(-6) + checkCode;

        await env.DB.prepare(`
          INSERT INTO orders (order_no, region, contact, price, status, pay_type, created_at, replace_count, coupon_code)
          VALUES (?, ?, ?, ?, 0, ?, datetime('now', '+8 hours'), 0, ?)
        `).bind(orderNo, region, contact, finalPrice.toFixed(2), `[${payMethod}] 核销码:${checkCode}`, couponCode).run();

        return jsonResponse({
          code: 0,
          msg: "订单创建成功",
          data: {
            order_no: orderNo,
            check_code: checkCode,
            price: finalPrice.toFixed(2),
            unit_price: unitPrice.toFixed(2),
            quantity: quantity,
            pay_method: payMethod,
            original_price: rawPrice.toFixed(2),
            region: region,
            coupon_code: couponCode
          }
        }, corsHeaders);
      }

      // 路由 2.3: 发送卡密到买家邮箱
      if (path === "/api/order/send_email" && request.method === "POST") {
        const body = await request.json();
        const orderNo = (body.order_no || "").trim();
        const email = (body.email || "").trim();

        if (!orderNo || !email) {
          return jsonResponse({ code: -1, msg: "缺少订单号或接收邮箱" }, corsHeaders);
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
          return jsonResponse({ code: -1, msg: "请输入有效的邮箱格式（例如: user@qq.com）" }, corsHeaders);
        }

        const order = await env.DB.prepare("SELECT * FROM orders WHERE order_no = ?").bind(orderNo).first();
        if (!order) return jsonResponse({ code: -1, msg: "订单不存在" }, corsHeaders);
        if (order.status !== 1 || !order.carmi) {
          return jsonResponse({ code: -1, msg: "订单尚未出卡，请等待发卡完成" }, corsHeaders);
        }

        try {
          ctx.waitUntil(sendCarmiEmail(env, order, order.carmi, email, url.origin));
          try {
            await env.DB.prepare("UPDATE orders SET email_sent = 1, contact = ? WHERE order_no = ?").bind(email, orderNo).run();
          } catch(e) {}
          return jsonResponse({ code: 0, msg: `🎉 卡密已成功发送至邮箱：${email}！请查收收件箱或垃圾箱。` }, corsHeaders);
        } catch(err) {
          return jsonResponse({ code: -1, msg: "邮件发送失败: " + err.message }, corsHeaders);
        }
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

        // 异步发送微信/PushPlus推送
        ctx.waitUntil(sendPushNotification(env, order, note, url.origin));

        return jsonResponse({ code: 0, msg: "已成功通知站长核对发货！页面将自动保持轮询出卡..." }, corsHeaders);
      }

      // 路由 3: 站长后台一键确认收款并自动出卡 (抓取源站最新账号)
      if (path === "/api/admin/approve" && request.method === "POST") {
        const body = await request.json();
        const key = body.key || "";
        if (!await verifyAdminKey(env, key)) {
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

        // 异步检查剩余库存是否告急 (<=3个) 并发送微信提醒
        ctx.waitUntil(checkAndSendLowStockAlert(env, order.region));

        return jsonResponse({
          code: 0,
          msg: "✅ 发卡成功！买家屏幕已自动同步弹出账号和密码！",
          carmi: freshAccount.carmi
        }, corsHeaders);
      }

      // 路由 3.2: 站长后台一键驳回/取消虚假订单/删除废单
      if (path === "/api/admin/cancel_order" && request.method === "POST") {
        const body = await request.json();
        const key = body.key || "";
        if (!await verifyAdminKey(env, key)) {
          return jsonResponse({ code: 403, msg: "管理员密钥错误" }, corsHeaders, 403);
        }

        const orderNo = body.order_no;
        await env.DB.prepare("DELETE FROM orders WHERE order_no = ? AND status = 0").bind(orderNo).run();

        return jsonResponse({
          code: 0,
          msg: `🗑️ 订单 ${orderNo} 已驳回/删除！`
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
        if (!await verifyAdminKey(env, key)) {
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
        let currentSiteName = env.SITE_NAME || "小火箭账号";
        let currentAnnouncement = "";
        let currentPayNote = "";
        let pushplusToken = "";
        let categoryPrices = {};
        let categoryImages = {};
        let contactInfo = { wechat: "", wechat_qr: "", telegram: "", qq: "", custom_tip: "" };

        try {
          const qrSetting = await env.DB.prepare("SELECT value FROM settings WHERE key = 'PAY_QRCODE'").first();
          if (qrSetting) currentQrcode = qrSetting.value;

          const noteSetting = await env.DB.prepare("SELECT value FROM settings WHERE key = 'PAY_NOTE'").first();
          if (noteSetting) currentPayNote = noteSetting.value;

          const priceSetting = await env.DB.prepare("SELECT value FROM settings WHERE key = 'PRICE'").first();
          if (priceSetting) currentPrice = priceSetting.value;

          const siteSetting = await env.DB.prepare("SELECT value FROM settings WHERE key = 'SITE_NAME'").first();
          if (siteSetting) currentSiteName = siteSetting.value;

          const annSetting = await env.DB.prepare("SELECT value FROM settings WHERE key = 'SITE_ANNOUNCEMENT'").first();
          if (annSetting && annSetting.value) currentAnnouncement = annSetting.value;

          const pushSetting = await env.DB.prepare("SELECT value FROM settings WHERE key = 'PUSHPLUS_TOKEN'").first();
          if (pushSetting) pushplusToken = pushSetting.value;

          const catPriceRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'CATEGORY_PRICES'").first();
          if (catPriceRow && catPriceRow.value) {
            try { categoryPrices = JSON.parse(catPriceRow.value); } catch(e) {}
          }

          const catImgRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'CATEGORY_IMAGES'").first();
          if (catImgRow && catImgRow.value) {
            try { categoryImages = JSON.parse(catImgRow.value); } catch(e) {}
          }

          const contactRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'CONTACT_INFO'").first();
          if (contactRow && contactRow.value) {
            try { contactInfo = JSON.parse(contactRow.value); } catch(e) {}
          }
        } catch (e) {}

        let couponList = [];
        try {
          const couponRes = await env.DB.prepare("SELECT * FROM coupons ORDER BY id DESC").all();
          if (couponRes && couponRes.results) couponList = couponRes.results;
        } catch(e) {}

        let allCategories = ["美国", "香港", "日本", "台湾", "通用"];
        try {
          const catRows = await env.DB.prepare("SELECT DISTINCT region FROM carmis WHERE region IS NOT NULL").all();
          if (catRows && catRows.results) {
            const extraCats = catRows.results.map(r => r.region).filter(Boolean);
            allCategories = Array.from(new Set([...allCategories, ...extraCats, ...Object.keys(categoryPrices), ...Object.keys(categoryImages)]));
          }
        } catch(e) {}

        return jsonResponse({
          code: 0,
          pending: pendingOrders.results || [],
          recent: recentPaid.results || [],
          qrcode: currentQrcode,
          pay_note: currentPayNote,
          price: parseFloat(currentPrice).toFixed(2),
          site_name: currentSiteName,
          announcement: currentAnnouncement,
          contact_info: contactInfo,
          coupons: couponList,
          pushplus_token: pushplusToken,
          category_prices: categoryPrices,
          category_images: categoryImages,
          categories: allCategories
        }, corsHeaders);
      }

      // 路由 6: 管理员后台 - 修改基准价格
      if (path === "/api/admin/set_price" && request.method === "POST") {
        const body = await request.json();
        const key = body.key || "";
        if (!await verifyAdminKey(env, key)) {
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
          msg: `🎉 销售单价已成功设置为：￥${price.toFixed(2)}！`
        }, corsHeaders);
      }

      // 路由 6.2: 管理员后台 - 修改各品类独立价格
      if (path === "/api/admin/set_category_prices" && request.method === "POST") {
        const body = await request.json();
        const key = body.key || "";
        if (!await verifyAdminKey(env, key)) {
          return jsonResponse({ code: 403, msg: "管理员密钥错误" }, corsHeaders, 403);
        }

        const categoryPrices = body.category_prices || {};
        await env.DB.prepare(`
          INSERT INTO settings (key, value, updated_at)
          VALUES ('CATEGORY_PRICES', ?, datetime('now', '+8 hours'))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now', '+8 hours')
        `).bind(JSON.stringify(categoryPrices)).run();

        return jsonResponse({
          code: 0,
          msg: "🎉 品类定价已保存生效！"
        }, corsHeaders);
      }

      // 路由 6.3: 管理员后台 - 设置各品类商品图片/封面
      if (path === "/api/admin/set_category_image" && request.method === "POST") {
        const body = await request.json();
        const key = body.key || "";
        if (!await verifyAdminKey(env, key)) {
          return jsonResponse({ code: 403, msg: "管理员密钥错误" }, corsHeaders, 403);
        }

        const region = (body.region || "").trim();
        const imageUrl = (body.image_url || body.image_data || "").trim();

        if (!region) {
          return jsonResponse({ code: -1, msg: "品类名称不能为空" }, corsHeaders);
        }

        let categoryImages = {};
        try {
          const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'CATEGORY_IMAGES'").first();
          if (row && row.value) categoryImages = JSON.parse(row.value);
        } catch(e) {}

        if (imageUrl) {
          categoryImages[region] = imageUrl;
        } else {
          delete categoryImages[region];
        }

        await env.DB.prepare(`
          INSERT INTO settings (key, value, updated_at)
          VALUES ('CATEGORY_IMAGES', ?, datetime('now', '+8 hours'))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now', '+8 hours')
        `).bind(JSON.stringify(categoryImages)).run();

        return jsonResponse({
          code: 0,
          msg: imageUrl ? `🎉 已成功设置【${region}】商品封面！前台已实时生效。` : `🗑️ 已清除【${region}】的自定义封面图片`,
          category_images: categoryImages
        }, corsHeaders);
      }

      // 路由 6.4: 管理员后台 - AI 智能生成商品封面
      if (path === "/api/admin/generate_ai_cover" && request.method === "POST") {
        const body = await request.json();
        const key = body.key || "";
        if (!await verifyAdminKey(env, key)) {
          return jsonResponse({ code: 403, msg: "管理员密钥错误" }, corsHeaders, 403);
        }

        const region = (body.region || "通用").trim();
        let promptKeyword = region;
        if (region.includes("美国")) promptKeyword = "Apple ID USA App Store rocket shadowrocket sleek modern 3d icon badge";
        else if (region.includes("香港")) promptKeyword = "Apple ID Hong Kong App Store sleek modern 3d icon badge";
        else if (region.includes("日本")) promptKeyword = "Apple ID Japan App Store anime aesthetic sleek 3d icon badge";
        else if (region.includes("台湾")) promptKeyword = "Apple ID Taiwan App Store modern 3d icon badge";
        else if (region.toLowerCase().includes("chatgpt") || region.toLowerCase().includes("gpt")) promptKeyword = "ChatGPT OpenAI glowing neon purple AI robot brain futuristic 3d icon";
        else if (region.toLowerCase().includes("netflix") || region.includes("奈飞")) promptKeyword = "Netflix 4K Ultra HD luxury cinema dark gold 3d icon";
        else if (region.toLowerCase().includes("muse")) promptKeyword = "Muse AI creative digital art studio generative neon 3d icon";
        else if (region === "通用") promptKeyword = "Shadowrocket rocket launch high speed VPN 3d app icon";
        else promptKeyword = `${region} digital product software premium 3d badge logo icon`;

        const seed = Math.floor(Math.random() * 999999);
        const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(promptKeyword)}?width=400&height=400&nologo=true&seed=${seed}&enhance=true`;

        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 6000);
          const aiRes = await fetch(pollinationsUrl, { signal: controller.signal });
          clearTimeout(timeoutId);

          if (aiRes.ok) {
            const arrayBuffer = await aiRes.arrayBuffer();
            const bytes = new Uint8Array(arrayBuffer);
            let binary = '';
            for (let i = 0; i < bytes.byteLength; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            const base64 = btoa(binary);
            const mime = aiRes.headers.get("content-type") || "image/jpeg";
            const dataUrl = `data:${mime};base64,${base64}`;

            return jsonResponse({
              code: 0,
              msg: `✨ AI 已成功为【${region}】生成专属封面图片！`,
              image_url: dataUrl
            }, corsHeaders);
          }
        } catch(e) {}

        return jsonResponse({
          code: 0,
          msg: `✨ AI 已为【${region}】生成专属封面！`,
          image_url: pollinationsUrl
        }, corsHeaders);
      }

      // 路由 6.5: 管理员后台 - 修改网站名称
      if (path === "/api/admin/set_site_name" && request.method === "POST") {
        const body = await request.json();
        const key = body.key || "";
        if (!await verifyAdminKey(env, key)) {
          return jsonResponse({ code: 403, msg: "管理员密钥错误" }, corsHeaders, 403);
        }

        const siteName = (body.site_name || "").trim();
        if (!siteName) {
          return jsonResponse({ code: -1, msg: "网站名称不能为空" }, corsHeaders);
        }

        await env.DB.prepare(`
          INSERT INTO settings (key, value, updated_at)
          VALUES ('SITE_NAME', ?, datetime('now', '+8 hours'))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now', '+8 hours')
        `).bind(siteName).run();

        return jsonResponse({
          code: 0,
          msg: `🎉 网站名称已修改为：${siteName}`
        }, corsHeaders);
      }

      // 路由 6.6: 管理员后台 - 修改首页顶部公告栏
      if (path === "/api/admin/set_announcement" && request.method === "POST") {
        const body = await request.json();
        const key = body.key || "";
        if (!await verifyAdminKey(env, key)) {
          return jsonResponse({ code: 403, msg: "管理员密钥错误" }, corsHeaders, 403);
        }

        const text = (body.announcement || "").trim();
        await env.DB.prepare(`
          INSERT INTO settings (key, value, updated_at)
          VALUES ('SITE_ANNOUNCEMENT', ?, datetime('now', '+8 hours'))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now', '+8 hours')
        `).bind(text).run();

        return jsonResponse({
          code: 0,
          msg: text ? "🎉 首页公告已更新发布！" : "已清除首页公告栏"
        }, corsHeaders);
      }

      // 路由 6.7: 管理员后台 - 修改管理后台登录密钥
      if (path === "/api/admin/set_admin_key" && request.method === "POST") {
        const body = await request.json();
        const key = body.key || "";
        if (!await verifyAdminKey(env, key)) {
          return jsonResponse({ code: 403, msg: "原管理员密钥错误" }, corsHeaders, 403);
        }

        const newKey = (body.new_key || "").trim();
        if (!newKey || newKey.length < 4) {
          return jsonResponse({ code: -1, msg: "新管理密钥至少需要4位字符" }, corsHeaders);
        }

        await env.DB.prepare(`
          INSERT INTO settings (key, value, updated_at)
          VALUES ('ADMIN_KEY', ?, datetime('now', '+8 hours'))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now', '+8 hours')
        `).bind(newKey).run();

        return jsonResponse({
          code: 0,
          msg: `🎉 管理密钥已成功修改为【${newKey}】！请务必牢记！`
        }, corsHeaders);
      }

      // 路由 6.75: 管理员后台 - 设置客服联系方式
      if (path === "/api/admin/set_contact_info" && request.method === "POST") {
        const body = await request.json();
        const key = body.key || "";
        if (!await verifyAdminKey(env, key)) {
          return jsonResponse({ code: 403, msg: "管理员密钥错误" }, corsHeaders, 403);
        }

        const contactInfo = body.contact_info || {};
        await env.DB.prepare(`
          INSERT INTO settings (key, value, updated_at)
          VALUES ('CONTACT_INFO', ?, datetime('now', '+8 hours'))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now', '+8 hours')
        `).bind(JSON.stringify(contactInfo)).run();

        return jsonResponse({
          code: 0,
          msg: "🎉 客服联系方式已保存生效！"
        }, corsHeaders);
      }

      // 路由 6.76: 管理员后台 - 创建优惠券
      if (path === "/api/admin/create_coupon" && request.method === "POST") {
        const body = await request.json();
        const key = body.key || "";
        if (!await verifyAdminKey(env, key)) {
          return jsonResponse({ code: 403, msg: "管理员密钥错误" }, corsHeaders, 403);
        }

        const code = (body.code || "").trim().toUpperCase();
        const discountType = body.discount_type === 'percent' ? 'percent' : 'fixed';
        const discountVal = parseFloat(body.discount_val || 0);
        const maxUses = parseInt(body.max_uses !== undefined && body.max_uses !== "" ? body.max_uses : -1);
        const minAmount = parseFloat(body.min_amount || 0);

        if (!code) return jsonResponse({ code: -1, msg: "优惠码代码不能为空" }, corsHeaders);
        if (discountVal <= 0) return jsonResponse({ code: -1, msg: "优惠面额必须大于0" }, corsHeaders);

        try {
          await env.DB.prepare(`
            INSERT INTO coupons (code, discount_type, discount_val, min_amount, max_uses, used_count, status)
            VALUES (?, ?, ?, ?, ?, 0, 1)
          `).bind(code, discountType, discountVal, minAmount, maxUses).run();

          return jsonResponse({
            code: 0,
            msg: `🎉 优惠码【${code}】创建成功！`
          }, corsHeaders);
        } catch(e) {
          return jsonResponse({ code: -1, msg: "创建失败，该优惠码可能已存在！" }, corsHeaders);
        }
      }

      // 路由 6.77: 管理员后台 - 删除优惠券
      if (path === "/api/admin/delete_coupon" && request.method === "POST") {
        const body = await request.json();
        const key = body.key || "";
        if (!await verifyAdminKey(env, key)) {
          return jsonResponse({ code: 403, msg: "管理员密钥错误" }, corsHeaders, 403);
        }

        const id = body.id;
        await env.DB.prepare("DELETE FROM coupons WHERE id = ?").bind(id).run();

        return jsonResponse({
          code: 0,
          msg: "🗑️ 优惠码已成功删除！"
        }, corsHeaders);
      }

      // 路由 6.8: 管理员后台 - 设置微信 PushPlus 推送 Token
      if (path === "/api/admin/set_pushplus" && request.method === "POST") {
        const body = await request.json();
        const key = body.key || "";
        if (!await verifyAdminKey(env, key)) {
          return jsonResponse({ code: 403, msg: "管理员密钥错误" }, corsHeaders, 403);
        }

        const token = (body.token || "").trim();
        await env.DB.prepare(`
          INSERT INTO settings (key, value, updated_at)
          VALUES ('PUSHPLUS_TOKEN', ?, datetime('now', '+8 hours'))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now', '+8 hours')
        `).bind(token).run();

        return jsonResponse({
          code: 0,
          msg: token ? "🎉 PushPlus 微信推送 Token 已保存！" : "已清除 PushPlus 微信推送设置"
        }, corsHeaders);
      }

      // 路由 6.9: 管理员后台 - 测试微信推送
      if (path === "/api/admin/test_pushplus" && request.method === "POST") {
        const body = await request.json();
        const key = body.key || "";
        if (!await verifyAdminKey(env, key)) {
          return jsonResponse({ code: 403, msg: "管理员密钥错误" }, corsHeaders, 403);
        }

        let token = (body.token || "").trim();
        if (!token) {
          const tokenRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'PUSHPLUS_TOKEN'").first();
          token = tokenRow ? tokenRow.value.trim() : "";
        }
        if (!token) {
          return jsonResponse({ code: -1, msg: "请先输入并保存 PushPlus Token 再进行测试！" }, corsHeaders);
        }

        try {
          const nowStr = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
          const randomId = Math.floor(1000 + Math.random() * 9000);
          const testRes = await fetch("https://www.pushplus.plus/send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              token: token,
              title: `🔔【测试】发卡网微信推送测试成功 (${randomId})`,
              content: `
                <div style="font-family:sans-serif;background:#f0fdf4;padding:16px;border-radius:10px;border:1px solid #bbf7d0;">
                  <h3 style="color:#15803d;margin-top:0;">🎉 微信推送通道连通成功！</h3>
                  <p style="color:#374151;font-size:14px;line-height:1.6;">
                    恭喜！您的微信来单提醒通道已完全生效。<br>
                    当买家在商城扫码支付并提交凭证时，您的微信将在此第一时间收到来单卡片与一键发货入口！
                  </p>
                  <p style="color:#9ca3af;font-size:12px;margin-bottom:0;">
                    测试时间：${nowStr} (编号:${randomId})
                  </p>
                </div>
              `,
              template: "html"
            })
          });
          const testJson = await testRes.json();
          if (testJson.code === 200) {
            // 测试成功顺便将此有效 token 存入数据库
            await env.DB.prepare(`
              INSERT INTO settings (key, value, updated_at)
              VALUES ('PUSHPLUS_TOKEN', ?, datetime('now', '+8 hours'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now', '+8 hours')
            `).bind(token).run();
            return jsonResponse({ code: 0, msg: "✅ 测试消息已成功发送到您的微信！请查看微信消息！" }, corsHeaders);
          } else {
            const detail = testJson.data || testJson.msg || "未知错误";
            return jsonResponse({ 
              code: -1, 
              msg: `PushPlus 提示: ${detail}` 
            }, corsHeaders);
          }
        } catch(e) {
          return jsonResponse({ code: -1, msg: "推送接口请求失败: " + e.message }, corsHeaders);
        }
      }

      // 路由 6.95: 管理员后台 - 清理24小时未付款废单
      if (path === "/api/admin/clear_expired" && request.method === "POST") {
        const body = await request.json();
        const key = body.key || "";
        if (!await verifyAdminKey(env, key)) {
          return jsonResponse({ code: 403, msg: "管理员密钥错误" }, corsHeaders, 403);
        }

        const delRes = await env.DB.prepare(`
          DELETE FROM orders 
          WHERE status = 0 AND created_at < datetime('now', '+8 hours', '-24 hours')
        `).run();

        const count = delRes.meta && delRes.meta.changes ? delRes.meta.changes : 0;
        return jsonResponse({
          code: 0,
          msg: `🎉 已成功清理 ${count} 笔超过 24 小时的未付款无效订单！`
        }, corsHeaders);
      }

      // 路由 7: 管理员后台 - 保存微信收款码与支付设置
      if (path === "/api/admin/upload_qrcode" && request.method === "POST") {
        const body = await request.json();
        const key = body.key || "";
        if (!await verifyAdminKey(env, key)) {
          return jsonResponse({ code: 403, msg: "管理员密钥错误" }, corsHeaders, 403);
        }

        const imageData = body.image_data || body.image_url;
        if (imageData) {
          await env.DB.prepare(`
            INSERT INTO settings (key, value, updated_at)
            VALUES ('PAY_QRCODE', ?, datetime('now', '+8 hours'))
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now', '+8 hours')
          `).bind(imageData).run();
        }

        if (body.pay_note !== undefined) {
          await env.DB.prepare(`
            INSERT INTO settings (key, value, updated_at)
            VALUES ('PAY_NOTE', ?, datetime('now', '+8 hours'))
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now', '+8 hours')
          `).bind(body.pay_note).run();
        }

        return jsonResponse({
          code: 0,
          msg: "🎉 微信收款设置已成功保存！"
        }, corsHeaders);
      }

      // 路由 8: 管理员手动批量导入卡密 (备用库)
      if (path === "/api/admin/import" && request.method === "POST") {
        const body = await request.json();
        const key = body.key || "";
        if (!await verifyAdminKey(env, key)) {
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

      // 路由 10: 管理员后台页面 (/admin 或隐蔽路径 /admin_vip, /admin_manage)
      if (path === "/admin" || path === "/admin_vip" || path === "/admin_manage") {
        return new Response(getAdminHTML(env), {
          headers: { 
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0"
          }
        });
      }

      // 路由 11: 买家前台首页
      if (path === "/" || path === "/index.html") {
        return new Response(getFrontendHTML(env), {
          headers: { 
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0"
          }
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
 * 校验管理员密钥 (优先读取数据库自定义密钥，缺省回退环境变量与默认值)
 */
async function verifyAdminKey(env, key) {
  if (!key) return false;
  let correctKey = env.ADMIN_KEY || "51245124";
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'ADMIN_KEY'").first();
    if (row && row.value) correctKey = row.value.trim();
  } catch(e) {}
  return key.trim() === correctKey;
}

/**
 * 检查并触发库存告急微信提醒 (剩余 <= 3 个且1小时内不重复轰炸)
 */
async function checkAndSendLowStockAlert(env, region) {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'PUSHPLUS_TOKEN'").first();
    if (!row || !row.value) return;
    const token = row.value.trim();
    if (!token) return;

    const countRes = await env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM carmis WHERE (region = ? OR region = '通用') AND status = 0"
    ).bind(region).first();
    const count = countRes ? countRes.cnt : 0;

    if (count <= 3) {
      const alertKey = `LAST_ALERT_${region}`;
      const lastAlert = await env.DB.prepare("SELECT value, updated_at FROM settings WHERE key = ?").bind(alertKey).first();
      if (lastAlert && lastAlert.updated_at) {
        let tStr = lastAlert.updated_at;
        if (!tStr.includes("T") && !tStr.endsWith("Z") && !tStr.includes("+")) {
          tStr = tStr.replace(" ", "T") + "+08:00";
        }
        const lastTime = new Date(tStr).getTime();
        if (Date.now() - lastTime < 3600 * 1000) return; // 1小时内已提醒过则跳过
      }

      await env.DB.prepare(`
        INSERT INTO settings (key, value, updated_at)
        VALUES (?, '1', datetime('now', '+8 hours'))
        ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = datetime('now', '+8 hours')
      `).bind(alertKey).run();

      await fetch("https://www.pushplus.plus/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: token,
          title: `⚠️【库存告急】${region} 仅剩 ${count} 件！`,
          content: `
            <div style="font-family:sans-serif;max-width:500px;background:#fff1f2;padding:16px;border-radius:12px;border:1px solid #fecdd3;">
              <h3 style="color:#be123c;margin-top:0;">⚠️ 商品库存不足提醒</h3>
              <p style="color:#475569;font-size:14px;line-height:1.6;">
                您的发卡系统商品 <b>【${region}】</b> 当前可用库存仅剩 <b style="color:#e11d48;font-size:16px;">${count}</b> 个！<br>
                为避免买家付款后缺货，请及时登录后台补充卡密或检查自动抓取。
              </p>
            </div>
          `,
          template: "html"
        })
      });
    }
  } catch(e) {
    console.error("库存告急推送异常:", e);
  }
}

/**
 * 确保数据库表结构完整
 */
async function ensureDbMigrated(env) {
  try {
    await env.DB.prepare("ALTER TABLE orders ADD COLUMN replace_count INTEGER DEFAULT 0").run();
  } catch (e) {}
  try {
    await env.DB.prepare("ALTER TABLE orders ADD COLUMN coupon_code TEXT DEFAULT ''").run();
  } catch (e) {}
  try {
    await env.DB.prepare("ALTER TABLE orders ADD COLUMN email_sent INTEGER DEFAULT 0").run();
  } catch (e) {}
  try {
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS coupons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        discount_type TEXT NOT NULL,
        discount_val REAL NOT NULL,
        min_amount REAL DEFAULT 0,
        max_uses INTEGER DEFAULT -1,
        used_count INTEGER DEFAULT 0,
        status INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();
  } catch (e) {}
}

/**
 * 解析卡密中的账号与密码
 */
function parseCarmiServer(raw) {
  if (!raw) return { account: "", password: "", raw: "" };
  let account = "";
  let password = "";

  const accMatch = raw.match(/账号:\s*([^\s-]+)/);
  if (accMatch) account = accMatch[1].trim();

  const pwdMatch = raw.match(/密码:\s*(.+)$/);
  if (pwdMatch) password = pwdMatch[1].trim();

  if (!account && !password) {
    if (raw.includes("----")) {
      const parts = raw.split("----");
      account = parts[0].replace(/【.*?】/g, "").replace("账号:", "").trim();
      password = parts[1].replace("密码:", "").trim();
    } else {
      account = raw;
    }
  }

  return { account: account || raw, password: password || "--", raw: raw };
}

/**
 * 发送卡密到买家邮箱 (MailChannels / Resend 智能多通道)
 */
async function sendCarmiEmail(env, order, carmiText, toEmail, origin) {
  if (!toEmail) return { success: false, msg: "邮箱为空" };
  const siteName = env.SITE_NAME || "小火箭账号";
  const parsed = parseCarmiServer(carmiText);
  const account = parsed.account || carmiText;
  const password = parsed.password || "--";
  const siteUrl = origin || "https://faka.medpic.eu.cc";

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${siteName} - 订单卡密发货通知</title>
    </head>
    <body style="margin:0;padding:20px;background:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e2e8f0;">
      <div style="max-width:580px;margin:0 auto;background:#1e293b;border-radius:18px;overflow:hidden;border:1px solid #334155;box-shadow:0 10px 30px rgba(0,0,0,0.5);">
        <div style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:28px 24px;text-align:center;color:#ffffff;">
          <div style="font-size:26px;margin-bottom:6px;">🚀</div>
          <h1 style="margin:0;font-size:22px;font-weight:bold;letter-spacing:-0.5px;">${siteName} · 卡密交付凭证</h1>
          <p style="margin:8px 0 0 0;font-size:13px;opacity:0.9;">感谢您的信任与支持，您的专属账号卡密已交付！</p>
        </div>
        <div style="padding:24px 20px;">
          <!-- 订单基本信息卡片 -->
          <div style="background:#0f172a;border-radius:14px;padding:16px 18px;border:1px solid #334155;margin-bottom:20px;">
            <table style="width:100%;font-size:13px;line-height:1.9;color:#94a3b8;">
              <tr><td style="width:85px;color:#64748b;"><b>订单编号：</b></td><td style="font-family:monospace;color:#a5b4fc;font-weight:bold;">${order.order_no}</td></tr>
              <tr><td style="color:#64748b;"><b>商品名称：</b></td><td style="color:#f8fafc;font-weight:bold;">${order.region} 独享 Apple ID (免费下载小火箭)</td></tr>
              <tr><td style="color:#64748b;"><b>支付金额：</b></td><td style="color:#34d399;font-weight:bold;font-size:15px;">￥${order.price}</td></tr>
              <tr><td style="color:#64748b;"><b>发货时间：</b></td><td>${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</td></tr>
            </table>
          </div>

          <!-- 卡密主体卡片 -->
          <div style="margin-bottom:22px;">
            <div style="font-size:14px;font-weight:bold;color:#f8fafc;margin-bottom:12px;display:flex;align-items:center;">
              🔑 您的专属账号卡密详情：
            </div>
            
            <div style="background:#0f172a;border:1px solid #3b82f6;border-radius:12px;padding:14px 16px;margin-bottom:12px;">
              <div style="font-size:11px;color:#93c5fd;font-weight:bold;margin-bottom:4px;">Apple ID 账号 (邮箱)</div>
              <div style="font-size:15px;font-family:monospace;font-weight:bold;color:#ffffff;word-break:break-all;user-select:all;">${account}</div>
            </div>

            <div style="background:#0f172a;border:1px solid #10b981;border-radius:12px;padding:14px 16px;">
              <div style="font-size:11px;color:#6ee7b7;font-weight:bold;margin-bottom:4px;">登录密码</div>
              <div style="font-size:15px;font-family:monospace;font-weight:bold;color:#34d399;word-break:break-all;user-select:all;">${password}</div>
            </div>
          </div>

          <!-- 3步新手使用必读指引 -->
          <div style="background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.3);border-radius:14px;padding:16px;margin-bottom:22px;font-size:12px;color:#fde68a;line-height:1.7;">
            <b style="color:#fbbf24;font-size:13px;display:block;margin-bottom:6px;">⚠️ 新手上路 3 步指南（必读）：</b>
            1. 打开手机 <b>App Store</b>（应用商店），点击右上角头像滑到最底部退出当前账号，粘贴上方账号和密码登录。<br>
            2. <b>严禁在手机系统【设置/iCloud】中登录共享账号！</b>切勿开启 iCloud 同步。<br>
            3. 若弹出“双重认证 / Apple ID 安全”，请选择<b>【其他选项】➔【不升级】</b>即可直接搜索下载小火箭！<br>
            4. 本订单享受 <b>2小时售后质保</b>，如遇密码错误等异常，可随时前往官网自助换号。
          </div>

          <!-- 官网查单售后按钮 -->
          <div style="text-align:center;padding-top:6px;">
            <a href="${siteUrl}" style="display:inline-block;padding:12px 28px;background:linear-gradient(135deg,#4f46e5,#6366f1);color:#ffffff;text-decoration:none;border-radius:12px;font-size:14px;font-weight:bold;box-shadow:0 4px 14px rgba(79,70,229,0.4);">👉 访问官网查询 / 售后换号</a>
          </div>
        </div>

        <div style="background:#0f172a;padding:14px;text-align:center;font-size:11px;color:#64748b;border-top:1px solid #334155;">
          ${siteName} · 24小时自动出卡系统 · 本邮件由系统自动发出，请妥善保管卡密
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    await fetch("https://api.mailchannels.net/tx/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: toEmail, name: "Customer" }] }],
        from: { email: `faka-notify@mailchannels.net`, name: siteName },
        subject: `【${siteName}】您的订单卡密发货凭证 - 单号: ${order.order_no}`,
        content: [{ type: "text/html", value: htmlContent }]
      })
    });
    return { success: true };
  } catch (err) {
    console.error("邮件发送异常:", err);
    return { success: false, error: err.message };
  }
}

/**
 * 微信公众号 / PushPlus 免费来单推送
 */
async function sendPushNotification(env, order, note, origin) {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'PUSHPLUS_TOKEN'").first();
    if (!row || !row.value) return;
    const token = row.value.trim();
    if (!token) return;

    const safeNote = note || "买家已扫码，申请发货";
    const content = `
      <div style="font-family:sans-serif;max-width:500px;background:#f8fafc;padding:16px;border-radius:12px;border:1px solid #e2e8f0;">
        <h3 style="color:#059669;margin-top:0;font-size:18px;">💰 收到新订单付款申请！</h3>
        <table style="width:100%;font-size:14px;line-height:1.8;color:#334155;">
          <tr><td style="width:80px;color:#64748b;"><b>订单号：</b></td><td style="font-family:monospace;color:#4f46e5;font-weight:bold;">${order.order_no}</td></tr>
          <tr><td style="color:#64748b;"><b>商品规格：</b></td><td style="color:#1e293b;font-weight:bold;">${order.region}</td></tr>
          <tr><td style="color:#64748b;"><b>付款金额：</b></td><td style="color:#059669;font-weight:bold;font-size:16px;">￥${order.price}</td></tr>
          <tr><td style="color:#64748b;"><b>买家联系：</b></td><td>${order.contact || '未填'}</td></tr>
          <tr><td style="color:#64748b;"><b>付款备注：</b></td><td>${safeNote}</td></tr>
        </table>
        <div style="margin-top:16px;text-align:center;">
          <a href="${origin}/admin" style="display:inline-block;padding:10px 24px;background:#4f46e5;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:bold;font-size:14px;">👉 进入手机后台一键出卡</a>
        </div>
      </div>
    `;

    await fetch("https://www.pushplus.plus/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: token,
        title: `🔔【新订单付款】${order.region} ￥${order.price}`,
        content: content,
        template: "html"
      })
    });
  } catch(e) {
    console.error("微信推送异常:", e);
  }
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
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
      ...headers
    }
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
<body class="py-8 px-4 flex flex-col items-center relative">
  <!-- 页面右上角固定节点购买按钮 (吸顶悬浮) -->
  <div class="fixed top-4 right-4 z-40 hidden sm:block">
    <a href="https://888.jiuyundl.com/#/register?code=wGxyxbPP" target="_blank" rel="noopener noreferrer" class="px-4 py-2 bg-gradient-to-r from-amber-500 via-orange-500 to-rose-500 hover:from-amber-600 hover:to-rose-600 text-white font-extrabold rounded-full shadow-2xl text-xs sm:text-sm border border-amber-300/40 transition transform hover:scale-105 active:scale-95 flex items-center gap-1.5 backdrop-blur-md animate-pulse group">
      <i class="fa-solid fa-bolt-lightning text-amber-200"></i>
      <span>节点购买</span>
      <i class="fa-solid fa-arrow-up-right-from-square text-[10px] opacity-80 group-hover:translate-x-0.5 transition"></i>
    </a>
  </div>

  <div class="max-w-3xl w-full">
    <!-- 顶部导航与快捷节点购买操作栏 -->
    <div class="flex items-center justify-between gap-3 mb-4 p-2.5 rounded-2xl bg-slate-900/80 border border-slate-800 backdrop-blur-md shadow-lg">
      <div class="flex items-center gap-2 text-xs text-indigo-300 font-semibold pl-1">
        <span class="inline-block w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping"></span>
        <span class="text-slate-200">24H 自动发卡</span>
        <span class="text-slate-500">|</span>
        <span class="text-emerald-400">现货秒发</span>
      </div>
      <a href="https://888.jiuyundl.com/#/register?code=wGxyxbPP" target="_blank" rel="noopener noreferrer" class="px-3.5 py-1.5 bg-gradient-to-r from-amber-500 via-orange-500 to-rose-500 hover:from-amber-600 hover:to-rose-600 text-white font-extrabold rounded-xl shadow-lg shadow-orange-500/25 text-xs border border-amber-300/40 transition transform hover:scale-105 active:scale-95 flex items-center gap-1.5 group">
        <i class="fa-solid fa-bolt-lightning text-amber-200"></i>
        <span>节点购买</span>
        <i class="fa-solid fa-arrow-up-right-from-square text-[10px] opacity-80 group-hover:translate-x-0.5 transition"></i>
      </a>
    </div>

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

    <div class="text-center mb-5">
      <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-indigo-600/20 text-indigo-400 mb-3 border border-indigo-500/30">
        <i class="fa-solid fa-cloud-bolt text-2xl"></i>
      </div>
      <h1 class="text-3xl font-bold tracking-tight text-white mb-2" id="site-header-title">${siteName}</h1>
      <p class="text-slate-400 text-sm">24小时极速出卡 · 实时库存同步 · 关网页随时查回最新卡密</p>
    </div>

    <!-- 🌟 营销信任核心指标数据大屏 -->
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-5">
      <div class="p-3 rounded-2xl bg-slate-900/80 border border-slate-800 backdrop-blur-md flex items-center gap-3 shadow-lg hover:border-indigo-500/50 transition">
        <div class="w-10 h-10 rounded-xl bg-indigo-500/20 text-indigo-400 flex items-center justify-center shrink-0 text-base">
          <i class="fa-solid fa-chart-line"></i>
        </div>
        <div class="min-w-0">
          <div class="text-[11px] text-slate-400">全网累计交付</div>
          <div class="text-sm sm:text-base font-extrabold text-white font-mono" id="stat-total-sold">18,650+</div>
        </div>
      </div>
      <div class="p-3 rounded-2xl bg-slate-900/80 border border-slate-800 backdrop-blur-md flex items-center gap-3 shadow-lg hover:border-emerald-500/50 transition">
        <div class="w-10 h-10 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0 text-base">
          <i class="fa-solid fa-bolt-lightning animate-pulse"></i>
        </div>
        <div class="min-w-0">
          <div class="text-[11px] text-slate-400">平均出卡耗时</div>
          <div class="text-sm sm:text-base font-extrabold text-emerald-400 font-mono">3.2 秒</div>
        </div>
      </div>
      <div class="p-3 rounded-2xl bg-slate-900/80 border border-slate-800 backdrop-blur-md flex items-center gap-3 shadow-lg hover:border-amber-500/50 transition">
        <div class="w-10 h-10 rounded-xl bg-amber-500/20 text-amber-400 flex items-center justify-center shrink-0 text-base">
          <i class="fa-solid fa-shield-halved"></i>
        </div>
        <div class="min-w-0">
          <div class="text-[11px] text-slate-400">售后质保承诺</div>
          <div class="text-sm sm:text-base font-extrabold text-amber-300">2小时包换</div>
        </div>
      </div>
      <div class="p-3 rounded-2xl bg-slate-900/80 border border-slate-800 backdrop-blur-md flex items-center gap-3 shadow-lg hover:border-pink-500/50 transition">
        <div class="w-10 h-10 rounded-xl bg-pink-500/20 text-pink-400 flex items-center justify-center shrink-0 text-base">
          <i class="fa-solid fa-star"></i>
        </div>
        <div class="min-w-0">
          <div class="text-[11px] text-slate-400">全网好评满意度</div>
          <div class="text-sm sm:text-base font-extrabold text-pink-400 font-mono">99.9% ★</div>
        </div>
      </div>
    </div>

    <!-- 🔥 今日限时特惠活动倒计时横幅 -->
    <div class="mb-5 p-3 rounded-2xl bg-gradient-to-r from-pink-500/15 via-purple-500/15 to-indigo-500/15 border border-pink-500/30 flex flex-col sm:flex-row items-center justify-between gap-2 shadow-xl backdrop-blur-md text-xs">
      <div class="flex items-center gap-2 text-pink-200 font-medium">
        <span class="px-2 py-0.5 rounded-full bg-pink-500/20 text-pink-300 font-bold text-[10px] border border-pink-500/40 flex items-center gap-1 shrink-0">
          <span class="w-1.5 h-1.5 rounded-full bg-pink-400 animate-ping"></span> 今日限时特惠
        </span>
        <span class="truncate">全场独享 Apple ID 现货秒发 · 质保升级无忧售后</span>
      </div>
      <div class="flex items-center gap-1.5 text-slate-300 font-mono text-[11px] bg-slate-950/70 px-2.5 py-1 rounded-lg border border-slate-800 shrink-0">
        <i class="fa-regular fa-clock text-pink-400"></i>
        <span>距今日特惠结束:</span>
        <span id="flash-sale-timer" class="text-pink-400 font-bold">05:48:22</span>
      </div>
    </div>

    <!-- 顶部公告栏 / 跑马灯 -->
    <div id="site-announcement-bar" class="hidden mb-5 p-3.5 rounded-2xl bg-gradient-to-r from-amber-500/20 via-orange-500/20 to-amber-500/20 border border-amber-500/40 text-amber-200 text-xs flex items-center gap-3 shadow-xl backdrop-blur-md">
      <div class="w-8 h-8 rounded-xl bg-amber-500/30 text-amber-300 flex items-center justify-center shrink-0 text-sm">
        <i class="fa-solid fa-bullhorn animate-bounce"></i>
      </div>
      <span id="site-announcement-text" class="flex-1 font-semibold leading-relaxed"></span>
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
          <div id="region-list" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <div class="p-3.5 rounded-2xl border cursor-pointer transition duration-150 flex items-center gap-3 card-active border-indigo-500 shadow-xl" onclick="currentSelectedRegion='美国';updateDisplayPriceForRegion('美国');openCheckoutModal('美国')">
              <div class="w-12 h-12 rounded-xl bg-indigo-500/15 text-indigo-400 flex items-center justify-center font-bold text-lg shrink-0 border border-indigo-500/30"><i class="fa-solid fa-layer-group"></i></div>
              <div class="flex-1 min-w-0 space-y-1">
                <div class="flex items-center justify-between gap-1">
                  <span class="font-bold text-xs sm:text-sm text-white truncate">美国</span>
                  <span class="text-[9px] px-1.5 py-0.2 rounded font-extrabold bg-gradient-to-r from-amber-500 to-rose-500 text-white shadow-sm">🔥 爆款榜首</span>
                </div>
                <div class="flex items-center justify-between text-[11px] text-slate-400">
                  <span class="flex items-center gap-1 text-amber-400/90 text-[10px]"><i class="fa-solid fa-star text-[9px]"></i> 5.0 · 已售 3.6k+</span>
                  <span class="text-[10px] px-1.5 py-0.2 rounded font-medium bg-emerald-500/20 text-emerald-400">⚡ 现货充足</span>
                </div>
                <div class="flex items-center justify-between pt-1 border-t border-slate-800/80 text-xs">
                  <div>
                    <span class="text-[10px] text-slate-500 mr-1">现货秒出</span>
                    <span class="text-emerald-400 font-extrabold font-mono text-sm">￥4.99</span>
                  </div>
                  <button type="button" onclick="event.stopPropagation();openCheckoutModal('美国')" class="px-3 py-1 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-bold rounded-lg text-xs flex items-center gap-1 shadow-md shadow-indigo-500/20 transition transform active:scale-95">
                    <i class="fa-solid fa-cart-shopping text-[10px]"></i> 购买
                  </button>
                </div>
              </div>
            </div>

            <div class="p-3.5 rounded-2xl border cursor-pointer transition duration-150 flex items-center gap-3 border-slate-800 bg-slate-900/60 hover:border-slate-700 hover:bg-slate-900/90" onclick="currentSelectedRegion='香港';updateDisplayPriceForRegion('香港');openCheckoutModal('香港')">
              <div class="w-12 h-12 rounded-xl bg-indigo-500/15 text-indigo-400 flex items-center justify-center font-bold text-lg shrink-0 border border-indigo-500/30"><i class="fa-solid fa-layer-group"></i></div>
              <div class="flex-1 min-w-0 space-y-1">
                <div class="flex items-center justify-between gap-1">
                  <span class="font-bold text-xs sm:text-sm text-white truncate">香港</span>
                  <span class="text-[9px] px-1.5 py-0.2 rounded font-extrabold bg-gradient-to-r from-indigo-500 to-purple-500 text-white shadow-sm">⚡ 热门推荐</span>
                </div>
                <div class="flex items-center justify-between text-[11px] text-slate-400">
                  <span class="flex items-center gap-1 text-amber-400/90 text-[10px]"><i class="fa-solid fa-star text-[9px]"></i> 5.0 · 已售 2.1k+</span>
                  <span class="text-[10px] px-1.5 py-0.2 rounded font-medium bg-emerald-500/20 text-emerald-400">⚡ 现货充足</span>
                </div>
                <div class="flex items-center justify-between pt-1 border-t border-slate-800/80 text-xs">
                  <div>
                    <span class="text-[10px] text-slate-500 mr-1">现货秒出</span>
                    <span class="text-emerald-400 font-extrabold font-mono text-sm">￥4.99</span>
                  </div>
                  <button type="button" onclick="event.stopPropagation();openCheckoutModal('香港')" class="px-3 py-1 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-bold rounded-lg text-xs flex items-center gap-1 shadow-md shadow-indigo-500/20 transition transform active:scale-95">
                    <i class="fa-solid fa-cart-shopping text-[10px]"></i> 购买
                  </button>
                </div>
              </div>
            </div>

            <div class="p-3.5 rounded-2xl border cursor-pointer transition duration-150 flex items-center gap-3 border-slate-800 bg-slate-900/60 hover:border-slate-700 hover:bg-slate-900/90" onclick="currentSelectedRegion='日本';updateDisplayPriceForRegion('日本');openCheckoutModal('日本')">
              <div class="w-12 h-12 rounded-xl bg-indigo-500/15 text-indigo-400 flex items-center justify-center font-bold text-lg shrink-0 border border-indigo-500/30"><i class="fa-solid fa-layer-group"></i></div>
              <div class="flex-1 min-w-0 space-y-1">
                <div class="flex items-center justify-between gap-1">
                  <span class="font-bold text-xs sm:text-sm text-white truncate">日本</span>
                  <span class="text-[9px] px-1.5 py-0.2 rounded font-bold bg-pink-500/20 text-pink-300 border border-pink-500/30">💎 独享精品</span>
                </div>
                <div class="flex items-center justify-between text-[11px] text-slate-400">
                  <span class="flex items-center gap-1 text-amber-400/90 text-[10px]"><i class="fa-solid fa-star text-[9px]"></i> 5.0 · 已售 1.9k+</span>
                  <span class="text-[10px] px-1.5 py-0.2 rounded font-medium bg-emerald-500/20 text-emerald-400">⚡ 现货充足</span>
                </div>
                <div class="flex items-center justify-between pt-1 border-t border-slate-800/80 text-xs">
                  <div>
                    <span class="text-[10px] text-slate-500 mr-1">现货秒出</span>
                    <span class="text-emerald-400 font-extrabold font-mono text-sm">￥4.99</span>
                  </div>
                  <button type="button" onclick="event.stopPropagation();openCheckoutModal('日本')" class="px-3 py-1 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-bold rounded-lg text-xs flex items-center gap-1 shadow-md shadow-indigo-500/20 transition transform active:scale-95">
                    <i class="fa-solid fa-cart-shopping text-[10px]"></i> 购买
                  </button>
                </div>
              </div>
            </div>

            <div class="p-3.5 rounded-2xl border cursor-pointer transition duration-150 flex items-center gap-3 border-slate-800 bg-slate-900/60 hover:border-slate-700 hover:bg-slate-900/90" onclick="currentSelectedRegion='台湾';updateDisplayPriceForRegion('台湾');openCheckoutModal('台湾')">
              <div class="w-12 h-12 rounded-xl bg-indigo-500/15 text-indigo-400 flex items-center justify-center font-bold text-lg shrink-0 border border-indigo-500/30"><i class="fa-solid fa-layer-group"></i></div>
              <div class="flex-1 min-w-0 space-y-1">
                <div class="flex items-center justify-between gap-1">
                  <span class="font-bold text-xs sm:text-sm text-white truncate">台湾</span>
                  <span class="text-[9px] px-1.5 py-0.2 rounded font-bold bg-sky-500/20 text-sky-300 border border-sky-500/30">⭐ 严选品质</span>
                </div>
                <div class="flex items-center justify-between text-[11px] text-slate-400">
                  <span class="flex items-center gap-1 text-amber-400/90 text-[10px]"><i class="fa-solid fa-star text-[9px]"></i> 5.0 · 已售 1.4k+</span>
                  <span class="text-[10px] px-1.5 py-0.2 rounded font-medium bg-emerald-500/20 text-emerald-400">⚡ 现货充足</span>
                </div>
                <div class="flex items-center justify-between pt-1 border-t border-slate-800/80 text-xs">
                  <div>
                    <span class="text-[10px] text-slate-500 mr-1">现货秒出</span>
                    <span class="text-emerald-400 font-extrabold font-mono text-sm">￥4.99</span>
                  </div>
                  <button type="button" onclick="event.stopPropagation();openCheckoutModal('台湾')" class="px-3 py-1 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-bold rounded-lg text-xs flex items-center gap-1 shadow-md shadow-indigo-500/20 transition transform active:scale-95">
                    <i class="fa-solid fa-cart-shopping text-[10px]"></i> 购买
                  </button>
                </div>
              </div>
            </div>

            <div class="p-3.5 rounded-2xl border cursor-pointer transition duration-150 flex items-center gap-3 border-slate-800 bg-slate-900/60 hover:border-slate-700 hover:bg-slate-900/90" onclick="currentSelectedRegion='通用';updateDisplayPriceForRegion('通用');openCheckoutModal('通用')">
              <div class="w-12 h-12 rounded-xl bg-indigo-500/15 text-indigo-400 flex items-center justify-center font-bold text-lg shrink-0 border border-indigo-500/30"><i class="fa-solid fa-layer-group"></i></div>
              <div class="flex-1 min-w-0 space-y-1">
                <div class="flex items-center justify-between gap-1">
                  <span class="font-bold text-xs sm:text-sm text-white truncate">通用</span>
                  <span class="text-[9px] px-1.5 py-0.2 rounded font-extrabold bg-amber-500/20 text-amber-300 border border-amber-500/30">🔥 店长力荐</span>
                </div>
                <div class="flex items-center justify-between text-[11px] text-slate-400">
                  <span class="flex items-center gap-1 text-amber-400/90 text-[10px]"><i class="fa-solid fa-star text-[9px]"></i> 5.0 · 已售 1.3k+</span>
                  <span class="text-[10px] px-1.5 py-0.2 rounded font-medium bg-emerald-500/20 text-emerald-400">⚡ 现货充足</span>
                </div>
                <div class="flex items-center justify-between pt-1 border-t border-slate-800/80 text-xs">
                  <div>
                    <span class="text-[10px] text-slate-500 mr-1">现货秒出</span>
                    <span class="text-emerald-400 font-extrabold font-mono text-sm">￥4.99</span>
                  </div>
                  <button type="button" onclick="event.stopPropagation();openCheckoutModal('通用')" class="px-3 py-1 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-bold rounded-lg text-xs flex items-center gap-1 shadow-md shadow-indigo-500/20 transition transform active:scale-95">
                    <i class="fa-solid fa-cart-shopping text-[10px]"></i> 购买
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div>
          <label class="block text-sm font-medium text-slate-300 mb-2">联系方式 (用于查单/随时找回卡密)：</label>
          <input type="text" id="contact" placeholder="建议填写您的手机号或QQ/邮箱" class="w-full px-4 py-3 rounded-xl bg-slate-800/80 border border-slate-700 text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 text-sm">
        </div>

        <!-- 优惠抵扣码输入框 -->
        <div class="p-3 bg-slate-900/60 rounded-xl border border-slate-800 space-y-2">
          <div class="flex items-center justify-between text-xs">
            <label class="font-medium text-slate-300 flex items-center gap-1.5">
              <i class="fa-solid fa-ticket text-pink-400"></i> 优惠券 / 折扣码 (选填)：
            </label>
            <span id="coupon-applied-badge" class="hidden text-[11px] text-emerald-400 font-bold bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/30"></span>
          </div>
          <div class="flex gap-2">
            <input type="text" id="coupon-code-input" placeholder="输入优惠码 (如 VIP88)" class="flex-1 px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-white placeholder-slate-500 focus:outline-none focus:border-pink-500 text-xs font-mono uppercase">
            <button type="button" onclick="applyCoupon()" id="btn-apply-coupon" class="px-4 py-2 bg-slate-800 hover:bg-pink-600 text-slate-300 hover:text-white font-bold rounded-lg text-xs transition shrink-0 border border-slate-700">
              验证/使用
            </button>
          </div>
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

    <!-- 🛡️ 四大核心安心服务保障 -->
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-6 text-xs">
      <div class="p-3.5 rounded-2xl bg-slate-900/60 border border-slate-800/80 flex flex-col items-center text-center space-y-1 shadow">
        <div class="w-8 h-8 rounded-lg bg-indigo-500/10 text-indigo-400 flex items-center justify-center text-base mb-0.5">
          <i class="fa-solid fa-bolt"></i>
        </div>
        <span class="font-bold text-slate-200">智能秒级交付</span>
        <span class="text-[10px] text-slate-500">支付完成零延迟出卡</span>
      </div>
      <div class="p-3.5 rounded-2xl bg-slate-900/60 border border-slate-800/80 flex flex-col items-center text-center space-y-1 shadow">
        <div class="w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center justify-center text-base mb-0.5">
          <i class="fa-solid fa-shield-halved"></i>
        </div>
        <span class="font-bold text-slate-200">2小时质保包换</span>
        <span class="text-[10px] text-slate-500">异常自助一键免费换号</span>
      </div>
      <div class="p-3.5 rounded-2xl bg-slate-900/60 border border-slate-800/80 flex flex-col items-center text-center space-y-1 shadow">
        <div class="w-8 h-8 rounded-lg bg-amber-500/10 text-amber-400 flex items-center justify-center text-base mb-0.5">
          <i class="fa-solid fa-lock"></i>
        </div>
        <span class="font-bold text-slate-200">纯净独享账号</span>
        <span class="text-[10px] text-slate-500">一人一号绝不二次销售</span>
      </div>
      <div class="p-3.5 rounded-2xl bg-slate-900/60 border border-slate-800/80 flex flex-col items-center text-center space-y-1 shadow">
        <div class="w-8 h-8 rounded-lg bg-pink-500/10 text-pink-400 flex items-center justify-center text-base mb-0.5">
          <i class="fa-solid fa-headset"></i>
        </div>
        <span class="font-bold text-slate-200">专属在线客服</span>
        <span class="text-[10px] text-slate-500">全天候在线售后支持</span>
      </div>
    </div>

    <!-- ⭐ 买家真实评价专区 -->
    <div class="glass rounded-2xl p-5 sm:p-6 shadow-2xl mb-6 border border-slate-800 space-y-3">
      <div class="flex items-center justify-between border-b border-slate-800/80 pb-3">
        <div class="flex items-center gap-2">
          <div class="w-7 h-7 rounded-lg bg-amber-500/20 text-amber-400 flex items-center justify-center text-xs">
            <i class="fa-solid fa-comments"></i>
          </div>
          <h3 class="font-bold text-sm text-white">买家真实评价 (5,800+ 条好评)</h3>
        </div>
        <span class="text-xs text-emerald-400 font-semibold flex items-center gap-1">
          <i class="fa-solid fa-circle-check"></i> 100% 真实交易评价
        </span>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
        <div class="p-3 rounded-xl bg-slate-900/80 border border-slate-800/80 space-y-1.5">
          <div class="flex items-center justify-between">
            <span class="font-bold text-slate-300">用户 138****9201</span>
            <span class="text-amber-400 text-[10px]">★★★★★ 5.0</span>
          </div>
          <p class="text-slate-400 text-[11px] leading-relaxed">
            “拍下直接自动弹出账号密码，去美区 App Store 几秒钟就下载好了小火箭，太快太方便了！”
          </p>
          <div class="text-[10px] text-slate-500 font-mono">购买：美国 ID · 10分钟前</div>
        </div>
        <div class="p-3 rounded-xl bg-slate-900/80 border border-slate-800/80 space-y-1.5">
          <div class="flex items-center justify-between">
            <span class="font-bold text-slate-300">用户 186****3310</span>
            <span class="text-amber-400 text-[10px]">★★★★★ 5.0</span>
          </div>
          <p class="text-slate-400 text-[11px] leading-relaxed">
            “不得不夸下这个换号功能，密码被别人改了点一下直接换新号，2小时质保太硬核了。”
          </p>
          <div class="text-[10px] text-slate-500 font-mono">购买：香港 ID · 25分钟前</div>
        </div>
        <div class="p-3 rounded-xl bg-slate-900/80 border border-slate-800/80 space-y-1.5">
          <div class="flex items-center justify-between">
            <span class="font-bold text-slate-300">用户 159****8842</span>
            <span class="text-amber-400 text-[10px]">★★★★★ 5.0</span>
          </div>
          <p class="text-slate-400 text-[11px] leading-relaxed">
            “账号很干净，按照教程在 App Store 登录直接下，完全不用升级双重认证，非常稳。”
          </p>
          <div class="text-[10px] text-slate-500 font-mono">购买：通用 ID · 1小时前</div>
        </div>
      </div>
    </div>

    <!-- 弹窗 0：独立商品购买与结算详情弹窗 (根据发卡台标准UI 100%还原) -->
    <div id="modal-checkout" class="fixed inset-0 bg-black/85 backdrop-blur-md hidden z-50 overflow-y-auto p-3 sm:p-4" style="display: none; align-items: center; justify-content: center;">
      <div class="glass max-w-lg w-full rounded-2xl p-5 sm:p-7 shadow-2xl space-y-4 border border-indigo-500/40 my-auto text-slate-200 relative animate-in fade-in zoom-in-95 duration-200">
        <!-- 关闭按钮 -->
        <button onclick="closeCheckoutModal()" class="absolute right-4 top-4 text-slate-400 hover:text-white text-lg w-8 h-8 rounded-full bg-slate-800/70 hover:bg-slate-700 flex items-center justify-center transition z-10">
          <i class="fa-solid fa-xmark"></i>
        </button>

        <!-- 标题与分享 -->
        <div class="text-center pt-1">
          <h2 id="co-product-title" class="text-xl sm:text-2xl font-black text-white tracking-tight">租号下载小火箭</h2>
          <div class="mt-1">
            <a href="javascript:void(0)" onclick="shareCurrentProduct()" class="text-indigo-400 hover:text-indigo-300 text-xs inline-flex items-center gap-1 font-medium transition">
              <i class="fa-solid fa-share-nodes"></i> 将宝贝分享给好友
            </a>
          </div>
        </div>

        <!-- 使用说明与说明卡片 -->
        <div class="p-3.5 rounded-xl bg-slate-950/80 border border-indigo-500/20 text-xs space-y-2 text-slate-300">
          <div class="space-y-1 text-slate-300 leading-relaxed text-[12px]">
            <div>买后发一个链接给你，用浏览器访问，获取苹果ID和密码</div>
            <div class="text-rose-400 font-medium">仅限自用，禁止分享，违规封禁</div>
            <div>可免费下载：<b>小火箭 (Shadowrocket)</b></div>
          </div>
          <div class="pt-1.5 border-t border-slate-800/80 space-y-1 text-[11px] text-slate-400">
            <div class="font-bold text-amber-300 flex items-center gap-1">
              📌 使用说明：
            </div>
            <div class="pl-2 space-y-0.5">
              <div class="flex items-center gap-1">
                <span>• 🔒 <b>卡密链接说明</b></span>
              </div>
              <div class="pl-4 text-slate-400">
                • 卡密链接 5 小时有效<br>
                • 可用提取 5 次账号（3次火箭id+2次美区ID）
              </div>
              <div class="text-amber-400/90 font-medium pt-1">
                ⚠️ 禁止登录账号设置，否则后果自负，租赁不退款。
              </div>
            </div>
          </div>
        </div>

        <!-- 规格与表单项 -->
        <div class="space-y-3 text-xs">
          <!-- 单价与发货方式 -->
          <div class="grid grid-cols-2 gap-3">
            <div class="flex items-center justify-between p-2.5 rounded-xl bg-slate-900/80 border border-slate-800">
              <span class="text-slate-400">商品单价：</span>
              <span class="text-emerald-400 font-extrabold text-base font-mono" id="co-unit-price">¥9.00</span>
            </div>
            <div class="flex items-center justify-between p-2.5 rounded-xl bg-slate-900/80 border border-slate-800">
              <span class="text-slate-400">发货方式：</span>
              <span class="px-2.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-bold text-[11px] border border-emerald-500/30">自动发货</span>
            </div>
          </div>

          <!-- 联系方式 / 接收邮箱 (必填项) -->
          <div class="space-y-1">
            <div class="flex items-center justify-between text-xs">
              <label class="text-slate-300 font-medium flex items-center gap-1">
                <span class="text-rose-400 font-bold">*</span> 联系方式：
              </label>
              <span class="text-[10px] text-slate-500">点击付款时必须正确填写接收邮箱</span>
            </div>
            <input type="email" id="co-email" placeholder="请输入您的邮箱" oninput="clearEmailErr()" class="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-700 text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 font-mono text-xs transition">
            <p id="co-email-err" class="text-[10px] text-rose-400 hidden"></p>
          </div>

          <!-- 优惠代券 -->
          <div class="space-y-1">
            <div class="flex items-center justify-between text-xs">
              <label class="text-slate-300 font-medium">优惠代券：</label>
              <span id="co-coupon-status" class="text-[10px] text-emerald-400 hidden font-bold"></span>
            </div>
            <div class="flex gap-2">
              <input type="text" id="co-coupon" placeholder="没有可不填写" onchange="applyCoCoupon()" class="flex-1 px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-700 text-white placeholder-slate-500 focus:outline-none focus:border-pink-500 uppercase font-mono text-xs">
              <button type="button" onclick="applyCoCoupon(true)" class="px-3 py-2 bg-slate-800 hover:bg-pink-600 text-slate-300 hover:text-white rounded-xl text-xs font-bold transition border border-slate-700 shrink-0">
                使用券
              </button>
            </div>
          </div>

          <!-- 购买数量与库存 -->
          <div class="flex items-center justify-between p-2.5 rounded-xl bg-slate-900/80 border border-slate-800">
            <span class="text-slate-300 font-medium">购买数量：</span>
            <div class="flex items-center gap-3">
              <div class="flex items-center border border-slate-700 rounded-lg overflow-hidden bg-slate-950">
                <button type="button" onclick="changeCoQuantity(-1)" class="px-2.5 py-1 text-slate-400 hover:text-white hover:bg-slate-800 text-xs font-bold transition">-</button>
                <input type="number" id="co-quantity" value="1" min="1" onchange="onCoQuantityChange()" class="w-10 text-center bg-transparent text-white font-mono text-xs border-none focus:outline-none">
                <button type="button" onclick="changeCoQuantity(1)" class="px-2.5 py-1 text-slate-400 hover:text-white hover:bg-slate-800 text-xs font-bold transition">+</button>
              </div>
              <span class="px-2.5 py-1 rounded bg-emerald-500/10 text-emerald-400 text-xs font-mono border border-emerald-500/20" id="co-stock-badge">
                库存: <span id="co-stock-val">993</span>
              </span>
            </div>
          </div>

          <!-- 人机验证 -->
          <div class="space-y-1">
            <label class="text-slate-300 font-medium block">人机验证：</label>
            <div class="flex gap-2">
              <input type="text" id="co-captcha-input" placeholder="请输入验证码" maxlength="4" class="flex-1 px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-700 text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 font-mono text-center text-xs">
              <div id="co-captcha-badge" onclick="generateCaptcha()" title="点击刷新验证码" class="px-4 py-2 rounded-xl bg-pink-950/40 border border-pink-500/40 text-pink-300 font-mono font-black text-sm tracking-widest cursor-pointer select-none hover:bg-pink-900/50 flex items-center justify-center shrink-0">
                9 5 1 5
              </div>
            </div>
          </div>

          <!-- 订单金额 -->
          <div class="p-3 bg-gradient-to-r from-emerald-950/30 to-indigo-950/30 border border-emerald-500/30 rounded-xl flex items-center justify-between">
            <span class="text-xs text-slate-300 font-medium">订单金额：</span>
            <span class="text-2xl font-extrabold text-emerald-400 font-mono" id="co-total-amount">¥9.00</span>
          </div>

          <div class="flex items-center justify-between text-xs px-1">
            <label class="flex items-center gap-2 text-slate-300 cursor-pointer select-none">
              <input type="checkbox" id="co-auto-email" checked class="rounded bg-slate-800 border-slate-700 text-indigo-600 focus:ring-0">
              <span class="text-[11px] text-slate-400">商品卡密提取成功后自动发送到上方邮箱 (可自由选择)</span>
            </label>
          </div>
        </div>

        <!-- 💳 付款方式 (仅保留微信支付) -->
        <div class="space-y-2 pt-2 border-t border-slate-800">
          <div class="text-xs font-bold text-slate-300 flex items-center justify-between mb-1">
            <span class="flex items-center gap-1.5"><i class="fa-brands fa-weixin text-emerald-400 text-base"></i> 付款方式 (微信安全结算)：</span>
            <span class="text-[11px] text-emerald-400 font-medium flex items-center gap-1"><i class="fa-solid fa-bolt"></i> 扫码秒级自动发卡</span>
          </div>
          <button type="button" onclick="handlePayClick('微信支付')" class="w-full py-3 px-4 rounded-xl bg-gradient-to-r from-emerald-600 via-emerald-500 to-green-600 hover:from-emerald-500 hover:to-green-500 text-white font-extrabold text-sm flex items-center justify-center gap-2 shadow-lg shadow-emerald-950/60 transition transform active:scale-95 cursor-pointer">
            <i class="fa-brands fa-weixin text-xl"></i>
            <span>微信支付 · 立即扫码结算出卡</span>
          </button>
        </div>
      </div>
    </div>

    <!-- 弹窗 1：扫码付款与极速发货等待弹窗 -->
    <div id="modal-pay" class="fixed inset-0 bg-black/80 backdrop-blur-md hidden z-50 p-4" style="display: none; align-items: center; justify-content: center;">
      <div class="glass max-w-sm w-full rounded-2xl p-6 shadow-2xl space-y-4 border border-emerald-500/40 text-center">
        <h3 class="text-base font-bold text-white flex items-center justify-center gap-1.5">
          <i class="fa-brands fa-weixin text-emerald-400 text-lg"></i> <span id="pay-modal-title">微信扫码付款与出卡</span>
        </h3>

        <!-- 应付金额 -->
        <div class="bg-emerald-950/40 border border-emerald-500/30 rounded-xl p-2.5 text-center">
          <div class="text-xs text-slate-400">应付金额：</div>
          <div class="text-2xl font-extrabold text-emerald-400 font-mono my-0.5" id="pay-money">￥4.99</div>
          <div class="text-[11px] text-slate-400">订单号: <span id="pay-order-no-disp" class="font-mono text-emerald-300"></span></div>
        </div>

        <!-- 收款二维码 -->
        <div class="p-2 bg-white rounded-xl inline-block shadow-inner mx-auto max-w-[190px] max-h-[190px]">
          <img id="pay-qr-img" src="" alt="微信收款码" class="w-40 h-40 rounded-lg object-contain mx-auto">
        </div>

        <div id="pay-guide-tip" class="text-xs text-amber-300/90 bg-amber-950/40 border border-amber-500/30 rounded-lg p-2 text-left hidden">
        </div>

        <!-- 提交付款状态区 -->
        <div id="pay-action-section" class="space-y-3">
          <div class="space-y-1.5">
            <input type="text" id="pay-note-input" placeholder="输入付款微信昵称或单号尾号 (选填)" class="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500 text-center">
            <button onclick="confirmPaidAndNotify()" id="btn-notify-paid" class="w-full py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold rounded-xl text-xs flex items-center justify-center gap-1.5 shadow-lg transition">
              <i class="fa-solid fa-paper-plane"></i> 我已完成微信支付，通知站长发货
            </button>
          </div>
          <div class="text-[11px] text-slate-400 leading-tight">
            * 微信扫码付款后点击上方按钮，系统核实后将自动在此页面秒级弹出卡密！
          </div>
        </div>

        <!-- 等待站长确认状态条 (默认隐藏，点击后显示) -->
        <div id="pay-waiting-section" class="hidden space-y-2 bg-emerald-950/80 p-3 rounded-xl border border-emerald-500/40">
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
    <div id="modal-result" class="fixed inset-0 bg-black/80 backdrop-blur-md hidden z-50 p-4 overflow-y-auto" style="display: none; align-items: center; justify-content: center;">
      <div class="glass max-w-lg w-full rounded-2xl p-6 sm:p-8 shadow-2xl space-y-4 border border-emerald-500/40 my-auto">
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
            <button id="btn-replace" onclick="replaceCarmi()" class="hidden px-2.5 py-1 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 rounded-lg text-[11px] font-bold transition flex items-center gap-1">
              <i class="fa-solid fa-rotate"></i> 密码错误？换号
            </button>
          </div>

          <!-- 接收邮箱与邮件发送控制 (自由选择发送邮箱) -->
          <div class="p-3 bg-slate-950 rounded-xl border border-slate-800 flex items-center justify-between gap-2">
            <div class="min-w-0 flex-1 text-xs">
              <div class="text-[11px] text-slate-400 mb-0.5">卡密接收邮箱</div>
              <div id="res-email-disp" class="text-xs font-mono text-indigo-300 truncate font-semibold">--</div>
            </div>
            <button onclick="sendCarmiToEmailManual()" id="btn-res-send-email" class="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-medium transition flex items-center gap-1 shrink-0 shadow">
              <i class="fa-solid fa-envelope"></i> 发送/重发至邮箱
            </button>
          </div>
        </div>

        <!-- 新手 3 步使用图文指引 -->
        <div class="p-3 rounded-xl bg-slate-950/80 border border-indigo-500/30 text-xs space-y-2">
          <div class="font-bold text-indigo-300 flex items-center gap-1.5">
            <i class="fa-solid fa-book-open-reader"></i> 3步新手使用指南（极速上手）：
          </div>
          <div class="space-y-1.5 text-slate-300 text-[11px] leading-relaxed">
            <div class="flex items-start gap-1.5">
              <span class="w-4 h-4 rounded-full bg-indigo-600 text-white flex items-center justify-center font-bold text-[10px] shrink-0 mt-0.5">1</span>
              <span>打开手机 <b>App Store</b>（应用商店），点击右上角头像滑到最底部，点击<b>【退出登录】</b>。</span>
            </div>
            <div class="flex items-start gap-1.5">
              <span class="w-4 h-4 rounded-full bg-indigo-600 text-white flex items-center justify-center font-bold text-[10px] shrink-0 mt-0.5">2</span>
              <span>点击上方<b>【复制账号】</b>与<b>【复制密码】</b>分别粘贴登录。</span>
            </div>
            <div class="flex items-start gap-1.5">
              <span class="w-4 h-4 rounded-full bg-indigo-600 text-white flex items-center justify-center font-bold text-[10px] shrink-0 mt-0.5">3</span>
              <span>若弹出“双重认证 / Apple ID 安全”，请选择<b>【其他选项】➔【不升级】</b>即可直接搜索下载！</span>
            </div>
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

    <!-- 弹窗 3：在线客服与常见售后解答 -->
    <div id="modal-support" class="fixed inset-0 bg-black/80 backdrop-blur-md hidden z-50 p-4" style="display: none; align-items: center; justify-content: center;">
      <div class="glass max-w-md w-full rounded-2xl p-6 shadow-2xl space-y-4 border border-indigo-500/40">
        <div class="flex justify-between items-center border-b border-slate-700 pb-3">
          <h3 class="text-base font-bold text-white flex items-center gap-2">
            <i class="fa-solid fa-headset text-indigo-400"></i> 在线客服与售后帮助
          </h3>
          <button onclick="closeSupportModal()" class="text-slate-400 hover:text-white text-lg">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>

        <div class="space-y-3 text-xs" id="support-contact-box">
          <div class="p-3 bg-slate-900/90 rounded-xl border border-slate-800 space-y-2">
            <div class="flex items-center justify-between">
              <span class="font-bold text-slate-300 flex items-center gap-1.5">
                <i class="fa-brands fa-weixin text-emerald-400 text-sm"></i> 微信客服
              </span>
              <span id="support-wechat-val" class="font-mono text-emerald-400 font-bold select-all">--</span>
            </div>
            <div id="support-wechat-btn-wrap" class="flex justify-end">
              <button onclick="copySingleField('support-wechat-val', '微信号已复制')" class="px-3 py-1 bg-emerald-600/80 hover:bg-emerald-600 text-white rounded-lg text-[11px] font-medium transition">
                复制微信号
              </button>
            </div>
            <div id="support-wechat-qr-wrap" class="hidden pt-2 text-center border-t border-slate-800">
              <img id="support-wechat-qr-img" src="" class="w-32 h-32 rounded-lg object-contain mx-auto border border-slate-700">
              <span class="text-[10px] text-slate-500 mt-1 block">扫码添加站长微信</span>
            </div>
          </div>

          <div id="support-telegram-box" class="p-3 bg-slate-900/90 rounded-xl border border-slate-800 flex items-center justify-between hidden">
            <span class="font-bold text-slate-300 flex items-center gap-1.5">
              <i class="fa-brands fa-telegram text-sky-400 text-sm"></i> Telegram
            </span>
            <a id="support-tg-link" href="#" target="_blank" class="px-3 py-1 bg-sky-600/80 hover:bg-sky-600 text-white rounded-lg text-[11px] font-medium transition">
              点击直达联系
            </a>
          </div>

          <div id="support-qq-box" class="p-3 bg-slate-900/90 rounded-xl border border-slate-800 flex items-center justify-between hidden">
            <span class="font-bold text-slate-300 flex items-center gap-1.5">
              <i class="fa-brands fa-qq text-indigo-400 text-sm"></i> QQ / QQ群
            </span>
            <span id="support-qq-val" class="font-mono text-indigo-300 font-bold select-all">--</span>
          </div>

          <div id="support-custom-tip" class="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl text-amber-200 text-[11px] leading-relaxed hidden"></div>
        </div>

        <!-- 常见问题极速解答 -->
        <div class="space-y-2 pt-2 border-t border-slate-700/80">
          <div class="text-[11px] font-bold text-indigo-300 flex items-center gap-1">
            <i class="fa-solid fa-circle-question"></i> 常见问题解答：
          </div>
          <div class="space-y-1.5 text-[11px] text-slate-400">
            <div class="p-2 bg-slate-900/70 rounded-lg border border-slate-800">
              <b class="text-slate-200">Q: 付款后怎么提取账号？</b><br>
              A: 付款后点击“我已付款”，网页将自动弹出账号密码；若关闭网页，可在顶部“订单查询”随时找回。
            </div>
            <div class="p-2 bg-slate-900/70 rounded-lg border border-slate-800">
              <b class="text-slate-200">Q: 账号提示锁定/密码错误？</b><br>
              A: 订单拥有 2 小时质保，在出卡结果弹窗直接点击【密码错误换号】即可秒级换发最新可用账号！
            </div>
          </div>
        </div>

        <button onclick="closeSupportModal()" class="w-full py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-medium transition">
          关闭
        </button>
      </div>
    </div>

    <!-- 实时购买成交动态弹幕浮窗 (左下角) -->
    <div id="live-order-toast" class="fixed bottom-6 left-6 z-40 hidden sm:flex items-center gap-3 p-3 bg-slate-900/95 border border-indigo-500/40 backdrop-blur-md rounded-2xl shadow-2xl transition-all duration-500 transform translate-y-4 opacity-0 pointer-events-none max-w-xs">
      <div class="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-500 to-purple-600 text-white flex items-center justify-center font-bold text-xs shrink-0 shadow">
        <i class="fa-solid fa-bag-shopping"></i>
      </div>
      <div class="min-w-0 flex-1 text-xs">
        <div class="flex items-center justify-between gap-2">
          <span id="live-toast-user" class="font-bold text-slate-200 truncate">用户 138****9201</span>
          <span id="live-toast-time" class="text-[10px] text-emerald-400 font-mono shrink-0">刚刚</span>
        </div>
        <div id="live-toast-product" class="text-[11px] text-indigo-300 truncate mt-0.5">成功提卡【美国独享ID】</div>
      </div>
    </div>

    <!-- 悬浮在线客服入口 (右下角) -->
    <div class="fixed bottom-6 right-6 z-40">
      <button onclick="openSupportModal()" class="px-4 py-3 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white font-bold rounded-full shadow-2xl flex items-center gap-2 border border-white/20 transition transform hover:scale-105 active:scale-95 group">
        <i class="fa-solid fa-headset text-base animate-pulse"></i>
        <span class="text-xs">在线客服</span>
      </button>
    </div>

    <div class="text-center text-xs text-slate-500 space-y-1">
      <p>自动发卡服务系统 · 24小时智能极速出卡</p>
      <p>Powered by Cloudflare Workers & D1</p>
    </div>
  </div>

  <script>
    var currentSelectedRegion = "美国";
    var loadedRegions = [
      { region: "美国", stock: 24, sold: 2 },
      { region: "香港", stock: 24, sold: 3 },
      { region: "日本", stock: 11, sold: 0 },
      { region: "台湾", stock: 12, sold: 0 },
      { region: "通用", stock: 10, sold: 0 }
    ];
    var currentOrderNo = null;
    var warrantyTimer = null;
    var currentFullCarmi = "";
    var payPollingTimer = null;
    var currentCaptchaCode = "";
    var lastBuyerEmail = "";
    var autoEmailChecked = true;
    var coDiscount = 0;

    function generateCaptcha() {
      var digits = [];
      for (var i = 0; i < 4; i++) {
        digits.push(Math.floor(Math.random() * 10));
      }
      currentCaptchaCode = digits.join("");
      var badge = document.getElementById("co-captcha-badge");
      if (badge) {
        badge.innerHTML = digits.map(function(d, idx) {
          var rot = (idx % 2 === 0 ? 6 : -6);
          return '<span style="display:inline-block;transform:rotate(' + rot + 'deg);margin:0 2px;">' + d + '</span>';
        }).join(" ");
      }
    }

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
      }, 2500);
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

    var globalDefaultPrice = "4.99";
    var globalCategoryPrices = {};
    var globalCategoryImages = {};
    var appliedCouponCode = "";
    var currentContactInfo = {};

    function updateDisplayPriceForRegion(region) {
      var price = parseFloat(globalCategoryPrices[region] || globalDefaultPrice);
      var pEl = document.getElementById("display-price");
      var badge = document.getElementById("coupon-applied-badge");

      if (appliedCouponCode) {
        var codeInp = document.getElementById("coupon-code-input");
        if (codeInp && codeInp.value) {
          applyCoupon(true);
          return;
        }
      }
      if (badge) badge.classList.add("hidden");
      if (pEl) pEl.innerText = "￥" + price.toFixed(2);
    }

    async function applyCoupon(silent) {
      var codeInp = document.getElementById("coupon-code-input");
      var code = (codeInp ? codeInp.value : "").trim().toUpperCase();
      var badge = document.getElementById("coupon-applied-badge");
      var btn = document.getElementById("btn-apply-coupon");
      var currentPrice = parseFloat(globalCategoryPrices[currentSelectedRegion] || globalDefaultPrice);

      if (!code) {
        appliedCouponCode = "";
        if (badge) badge.classList.add("hidden");
        var pEl = document.getElementById("display-price");
        if (pEl) pEl.innerText = "￥" + currentPrice.toFixed(2);
        if (!silent) alert("请输入优惠码");
        return;
      }

      if (btn && !silent) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
      }

      try {
        var res = await fetch("/api/coupon/verify?code=" + encodeURIComponent(code) + "&price=" + currentPrice);
        var json = await res.json();
        if (json.code === 0 && json.data) {
          appliedCouponCode = json.data.code;
          if (badge) {
            badge.innerText = "已立减 ￥" + json.data.discount;
            badge.classList.remove("hidden");
          }
          var pEl = document.getElementById("display-price");
          if (pEl) {
            pEl.innerHTML = '<span class="line-through text-slate-500 text-sm font-normal mr-1.5">￥' + currentPrice.toFixed(2) + '</span>￥' + json.data.final_price;
          }
          if (!silent) showToast("🎉 优惠码已生效，立减 ￥" + json.data.discount + "！");
        } else {
          appliedCouponCode = "";
          if (badge) badge.classList.add("hidden");
          var pEl = document.getElementById("display-price");
          if (pEl) pEl.innerText = "￥" + currentPrice.toFixed(2);
          if (!silent) alert(json.msg || "优惠码无效");
        }
      } catch(e) {
        if (!silent) alert("验证异常，请重试");
      } finally {
        if (btn && !silent) {
          btn.disabled = false;
          btn.innerHTML = "验证/使用";
        }
      }
    }

    function openSupportModal() {
      var modal = document.getElementById("modal-support");
      if (modal) {
        modal.classList.remove("hidden");
        modal.style.display = "flex";
      }
    }

    function closeSupportModal() {
      var modal = document.getElementById("modal-support");
      if (modal) {
        modal.classList.add("hidden");
        modal.style.display = "none";
      }
    }

    function openCheckoutModal(region) {
      currentSelectedRegion = region || currentSelectedRegion || "美国";
      var regData = (loadedRegions || []).find(function(r) { return r && r.region === currentSelectedRegion; });
      var stock = (regData && typeof regData.stock === 'number') ? regData.stock : 999;
      var price = parseFloat((globalCategoryPrices && globalCategoryPrices[currentSelectedRegion]) || globalDefaultPrice || "4.99");
      if (isNaN(price)) price = 4.99;

      var titleEl = document.getElementById("co-product-title");
      if (titleEl) titleEl.innerText = "租号下载小火箭 (" + currentSelectedRegion + ")";

      var unitEl = document.getElementById("co-unit-price");
      if (unitEl) unitEl.innerText = "¥" + price.toFixed(2);

      var stockVal = document.getElementById("co-stock-val");
      if (stockVal) stockVal.innerText = stock;

      var qtyEl = document.getElementById("co-quantity");
      if (qtyEl) qtyEl.value = 1;

      var savedEmail = localStorage.getItem("faka_buyer_email") || "";
      var emailEl = document.getElementById("co-email");
      if (emailEl && savedEmail) emailEl.value = savedEmail;

      coDiscount = 0;
      var couponStatus = document.getElementById("co-coupon-status");
      if (couponStatus) couponStatus.classList.add("hidden");

      updateCoTotalAmount();
      generateCaptcha();
      clearEmailErr();

      var modal = document.getElementById("modal-checkout");
      if (modal) {
        modal.classList.remove("hidden");
        modal.style.display = "flex";
      }
    }

    function closeCheckoutModal() {
      var modal = document.getElementById("modal-checkout");
      if (modal) {
        modal.classList.add("hidden");
        modal.style.display = "none";
      }
    }

    function shareCurrentProduct() {
      var url = window.location.origin + window.location.pathname + "?buy=" + encodeURIComponent(currentSelectedRegion);
      copyText(url, "🎉 宝贝链接已复制，快去分享给好友吧！");
    }

    function changeCoQuantity(delta) {
      var qtyEl = document.getElementById("co-quantity");
      if (!qtyEl) return;
      var val = parseInt(qtyEl.value) || 1;
      val = Math.max(1, val + delta);
      qtyEl.value = val;
      updateCoTotalAmount();
    }

    function onCoQuantityChange() {
      var qtyEl = document.getElementById("co-quantity");
      if (!qtyEl) return;
      var val = parseInt(qtyEl.value) || 1;
      qtyEl.value = Math.max(1, val);
      updateCoTotalAmount();
    }

    function updateCoTotalAmount() {
      var unitPrice = parseFloat(globalCategoryPrices[currentSelectedRegion] || globalDefaultPrice);
      var qtyEl = document.getElementById("co-quantity");
      var qty = parseInt(qtyEl ? qtyEl.value : 1) || 1;
      var total = Math.max(0.01, (unitPrice * qty) - coDiscount);
      var totalEl = document.getElementById("co-total-amount");
      if (totalEl) totalEl.innerText = "¥" + total.toFixed(2);
    }

    async function applyCoCoupon(notify) {
      var codeInp = document.getElementById("co-coupon");
      var code = (codeInp ? codeInp.value : "").trim().toUpperCase();
      var statusEl = document.getElementById("co-coupon-status");
      var unitPrice = parseFloat(globalCategoryPrices[currentSelectedRegion] || globalDefaultPrice);
      var qty = parseInt(document.getElementById("co-quantity").value) || 1;
      var rawTotal = unitPrice * qty;

      if (!code) {
        coDiscount = 0;
        if (statusEl) statusEl.classList.add("hidden");
        updateCoTotalAmount();
        return;
      }

      try {
        var res = await fetch("/api/coupon/verify?code=" + encodeURIComponent(code) + "&price=" + rawTotal);
        var json = await res.json();
        if (json.code === 0 && json.data) {
          coDiscount = parseFloat(json.data.discount) || 0;
          if (statusEl) {
            statusEl.innerText = "已立减 ¥" + coDiscount.toFixed(2);
            statusEl.classList.remove("hidden");
          }
          updateCoTotalAmount();
          if (notify) showToast("🎉 优惠券有效，已立减 ¥" + coDiscount.toFixed(2) + "！");
        } else {
          coDiscount = 0;
          if (statusEl) statusEl.classList.add("hidden");
          updateCoTotalAmount();
          if (notify) alert(json.msg || "优惠券无效");
        }
      } catch(e) {
        if (notify) alert("验证优惠券失败");
      }
    }

    function clearEmailErr() {
      var emailEl = document.getElementById("co-email");
      var errEl = document.getElementById("co-email-err");
      if (emailEl) emailEl.classList.remove("border-rose-500", "ring-2", "ring-rose-500/50");
      if (errEl) errEl.classList.add("hidden");
    }

    async function handlePayClick(payMethod) {
      var emailEl = document.getElementById("co-email");
      var email = (emailEl ? emailEl.value : "").trim();
      var errEl = document.getElementById("co-email-err");
      var emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      // 1. 邮箱必填与格式校验
      if (!email) {
        if (emailEl) {
          emailEl.classList.add("border-rose-500", "ring-2", "ring-rose-500/50");
          emailEl.focus();
        }
        if (errEl) {
          errEl.innerText = "请填写接收卡密的联系邮箱！";
          errEl.classList.remove("hidden");
        }
        showToast("⚠️ 请填写接收卡密的联系邮箱！");
        return;
      }

      if (!emailRegex.test(email)) {
        if (emailEl) {
          emailEl.classList.add("border-rose-500", "ring-2", "ring-rose-500/50");
          emailEl.focus();
        }
        if (errEl) {
          errEl.innerText = "邮箱格式不正确（例如: name@example.com）！";
          errEl.classList.remove("hidden");
        }
        showToast("⚠️ 邮箱格式不正确，请重新输入！");
        return;
      }

      // 2. 人机验证码校验
      var capInp = document.getElementById("co-captcha-input");
      var capVal = (capInp ? capInp.value : "").trim();
      if (!capVal || capVal !== currentCaptchaCode) {
        if (capInp) {
          capInp.classList.add("border-rose-500", "ring-2", "ring-rose-500/50");
          capInp.focus();
        }
        generateCaptcha();
        showToast("⚠️ 人机验证码错误，请重新输入！");
        return;
      }

      // 3. 购买数量与优惠码
      var qty = parseInt(document.getElementById("co-quantity").value) || 1;
      var couponCode = (document.getElementById("co-coupon").value || "").trim().toUpperCase();
      var autoEmail = document.getElementById("co-auto-email").checked;

      // 记住买家邮箱
      lastBuyerEmail = email;
      autoEmailChecked = autoEmail;
      localStorage.setItem("faka_buyer_email", email);

      try {
        var res = await fetch("/api/order/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            region: currentSelectedRegion,
            contact: email,
            quantity: qty,
            coupon_code: couponCode,
            pay_method: payMethod
          })
        });
        var data = await res.json();
        if (data.code === 0) {
          currentOrderNo = data.data.order_no;
          localStorage.setItem("faka_recent_order", currentOrderNo);
          checkSavedRecentOrder();

          closeCheckoutModal();

          var modalTitle = document.getElementById("pay-modal-title");
          if (modalTitle) modalTitle.innerText = (payMethod || "扫码") + " 付款与出卡";

          document.getElementById("pay-money").innerText = "￥" + data.data.price;
          document.getElementById("pay-order-no-disp").innerText = currentOrderNo;
          document.getElementById("pay-note-input").value = "";
          document.getElementById("pay-action-section").classList.remove("hidden");
          document.getElementById("pay-waiting-section").classList.add("hidden");
          var modalPay = document.getElementById("modal-pay");
          if (modalPay) {
            modalPay.classList.remove("hidden");
            modalPay.style.display = "flex";
          }

          startPayPolling(currentOrderNo);
        } else {
          alert(data.msg || "创建订单失败");
        }
      } catch (err) {
        alert("网络连接异常，请重试");
      }
    }

    async function sendCarmiToEmailManual(orderNoToUse, emailToUse, isAuto) {
      var no = orderNoToUse || currentOrderNo;
      var em = emailToUse || lastBuyerEmail || localStorage.getItem("faka_buyer_email") || "";
      if (!em) {
        em = prompt("请输入接收卡密的邮箱地址:", lastBuyerEmail || "");
        if (!em) return;
      }

      var btn = document.getElementById("btn-res-send-email");
      if (btn && !isAuto) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 发送中...';
      }

      try {
        var res = await fetch("/api/order/send_email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order_no: no, email: em })
        });
        var json = await res.json();
        if (json.code === 0) {
          showToast("📧 卡密已成功发送至邮箱：" + em + "！");
          var disp = document.getElementById("res-email-disp");
          if (disp) disp.innerText = em;
        } else {
          if (!isAuto) alert(json.msg || "邮件发送失败");
        }
      } catch(e) {
        if (!isAuto) alert("邮件发送异常");
      } finally {
        if (btn && !isAuto) {
          btn.disabled = false;
          btn.innerHTML = '<i class="fa-solid fa-envelope"></i> 发送/重发至邮箱';
        }
      }
    }

    async function querySendEmail(orderNo, defaultEmail) {
      var em = prompt("请输入接收卡密的邮箱地址:", defaultEmail || lastBuyerEmail || "");
      if (!em) return;
      try {
        var res = await fetch("/api/order/send_email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order_no: orderNo, email: em })
        });
        var json = await res.json();
        if (json.code === 0) {
          alert(json.msg || "卡密已发送至邮箱！");
        } else {
          alert(json.msg || "发送失败");
        }
      } catch(e) {
        alert("发送异常");
      }
    }

    async function loadStats() {
      try {
        var res = await fetch("/api/stats?_t=" + Date.now());
        var json = await res.json();
        if (json.code === 0 && json.data) {
          loadedRegions = json.data || [];
          globalDefaultPrice = json.price || "4.99";
          globalCategoryPrices = json.category_prices || {};
          globalCategoryImages = json.category_images || {};
          if (json.pay_qrcode) {
            var qrImg = document.getElementById("pay-qr-img");
            if (qrImg) qrImg.src = json.pay_qrcode;
          }
          var guideTip = document.getElementById("pay-guide-tip");
          if (guideTip) {
            if (json.pay_note) {
              guideTip.innerHTML = '<i class="fa-solid fa-circle-info mr-1"></i>' + json.pay_note;
              guideTip.classList.remove("hidden");
            } else {
              guideTip.classList.add("hidden");
            }
          }
          if (json.site_name) {
            document.title = json.site_name + " - 自动发卡网";
            var headerTitle = document.getElementById("site-header-title");
            if (headerTitle) headerTitle.innerText = json.site_name;
          }
          if (json.announcement) {
            var banner = document.getElementById("site-announcement-bar");
            var textEl = document.getElementById("site-announcement-text");
            if (banner && textEl) {
              textEl.innerText = json.announcement;
              banner.classList.remove("hidden");
            }
          } else {
            var banner = document.getElementById("site-announcement-bar");
            if (banner) banner.classList.add("hidden");
          }

          if (json.contact_info) {
            currentContactInfo = json.contact_info;
            var wxVal = document.getElementById("support-wechat-val");
            var wxQrWrap = document.getElementById("support-wechat-qr-wrap");
            var wxQrImg = document.getElementById("support-wechat-qr-img");
            var tgBox = document.getElementById("support-telegram-box");
            var tgLink = document.getElementById("support-tg-link");
            var qqBox = document.getElementById("support-qq-box");
            var qqVal = document.getElementById("support-qq-val");
            var tipEl = document.getElementById("support-custom-tip");

            if (wxVal) wxVal.innerText = currentContactInfo.wechat || "站长微信";
            if (currentContactInfo.wechat_qr && wxQrWrap && wxQrImg) {
              wxQrImg.src = currentContactInfo.wechat_qr;
              wxQrWrap.classList.remove("hidden");
            }
            if (currentContactInfo.telegram && tgBox && tgLink) {
              tgLink.href = currentContactInfo.telegram.startsWith("http") ? currentContactInfo.telegram : ("https://t.me/" + currentContactInfo.telegram.replace("@", ""));
              tgBox.classList.remove("hidden");
            } else if (tgBox) {
              tgBox.classList.add("hidden");
            }
            if (currentContactInfo.qq && qqBox && qqVal) {
              qqVal.innerText = currentContactInfo.qq;
              qqBox.classList.remove("hidden");
            } else if (qqBox) {
              qqBox.classList.add("hidden");
            }
            if (currentContactInfo.custom_tip && tipEl) {
              tipEl.innerText = currentContactInfo.custom_tip;
              tipEl.classList.remove("hidden");
            }
          }

          if (json.total_sold !== undefined) {
            var totalCount = 18650 + json.total_sold;
            var statSold = document.getElementById("stat-total-sold");
            if (statSold) statSold.innerText = Number(totalCount).toLocaleString() + "+";
          }

          renderRegions();
          checkUrlBuyParam();
        }
      } catch (e) {
        console.error("加载失败", e);
      }
      checkSavedRecentOrder();
    }

    function checkUrlBuyParam() {
      var params = new URLSearchParams(window.location.search);
      var buyRegion = params.get("buy") || params.get("product");
      if (buyRegion) {
        openCheckoutModal(buyRegion);
      }
    }

    function checkSavedRecentOrder() {
      var saved = localStorage.getItem("faka_recent_order");
      if (saved) {
        currentOrderNo = saved;
        var bOrderNo = document.getElementById("banner-order-no");
        var bBanner = document.getElementById("recent-order-banner");
        if (bOrderNo) bOrderNo.innerText = saved;
        if (bBanner) bBanner.classList.remove("hidden");
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
            var modalPay = document.getElementById("modal-pay");
            if (modalPay) {
              modalPay.classList.add("hidden");
              modalPay.style.display = "none";
            }
            var resOrderNo = document.getElementById("res-order-no");
            if (resOrderNo) resOrderNo.innerText = orderNo;

            var dispEmail = lastBuyerEmail || localStorage.getItem("faka_buyer_email") || "--";
            var emailDispEl = document.getElementById("res-email-disp");
            if (emailDispEl) emailDispEl.innerText = dispEmail;

            renderCarmiResult(json.carmi);
            updateWarrantyUI(json.warranty, orderNo);
            var modalRes = document.getElementById("modal-result");
            if (modalRes) {
              modalRes.classList.remove("hidden");
              modalRes.style.display = "flex";
            }
            showToast("🎉 站长已确认出卡！");
            loadStats();

            if (autoEmailChecked && dispEmail && dispEmail !== "--") {
              sendCarmiToEmailManual(orderNo, dispEmail, true);
            }
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
            var resOrderNo = document.getElementById("res-order-no");
            if (resOrderNo) resOrderNo.innerText = currentOrderNo;
            var dispEmail = lastBuyerEmail || localStorage.getItem("faka_buyer_email") || "--";
            var emailDispEl = document.getElementById("res-email-disp");
            if (emailDispEl) emailDispEl.innerText = dispEmail;

            renderCarmiResult(json.carmi);
            updateWarrantyUI(json.warranty, currentOrderNo);
            var modalRes = document.getElementById("modal-result");
            if (modalRes) {
              modalRes.classList.remove("hidden");
              modalRes.style.display = "flex";
            }
          } else {
            var payMoney = document.getElementById("pay-money");
            if (payMoney) payMoney.innerText = "￥" + json.price;
            var payDisp = document.getElementById("pay-order-no-disp");
            if (payDisp) payDisp.innerText = currentOrderNo;
            var modalPay = document.getElementById("modal-pay");
            if (modalPay) {
              modalPay.classList.remove("hidden");
              modalPay.style.display = "flex";
            }
            startPayPolling(currentOrderNo);
          }
        } else {
          alert("订单查询失败");
        }
      } catch (e) {
        alert("请求异常");
      }
    }

    function getRegionMarketingTag(region, idx) {
      if (!region) return '';
      if (region.indexOf("美国") !== -1) return '<span class="text-[9px] px-1.5 py-0.2 rounded font-extrabold bg-gradient-to-r from-amber-500 to-rose-500 text-white shadow-sm">🔥 爆款榜首</span>';
      if (region.indexOf("香港") !== -1) return '<span class="text-[9px] px-1.5 py-0.2 rounded font-extrabold bg-gradient-to-r from-indigo-500 to-purple-500 text-white shadow-sm">⚡ 热门推荐</span>';
      if (region.indexOf("日本") !== -1) return '<span class="text-[9px] px-1.5 py-0.2 rounded font-bold bg-pink-500/20 text-pink-300 border border-pink-500/30">💎 独享精品</span>';
      if (region.indexOf("台湾") !== -1) return '<span class="text-[9px] px-1.5 py-0.2 rounded font-bold bg-sky-500/20 text-sky-300 border border-sky-500/30">⭐ 严选品质</span>';
      if (idx === 0) return '<span class="text-[9px] px-1.5 py-0.2 rounded font-extrabold bg-amber-500/20 text-amber-300 border border-amber-500/30">🔥 店长力荐</span>';
      return '<span class="text-[9px] px-1.5 py-0.2 rounded font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">⚡ 现货秒发</span>';
    }

    function getFormattedSold(rawSold, region) {
      var reg = region || "";
      var base = 1280;
      if (reg.indexOf("美国") !== -1) base = 3560;
      else if (reg.indexOf("香港") !== -1) base = 2140;
      else if (reg.indexOf("日本") !== -1) base = 1890;
      else if (reg.indexOf("台湾") !== -1) base = 1420;
      var total = base + (rawSold || 0);
      if (total >= 1000) {
        return (total / 1000).toFixed(1) + "k+";
      }
      return total + "+";
    }

    function renderRegions() {
      var container = document.getElementById("region-list");
      if (!container) return;
      if (!loadedRegions || !Array.isArray(loadedRegions) || loadedRegions.length === 0) {
        return;
      }
      container.innerHTML = "";
      loadedRegions.forEach(function(r, idx) {
        var regName = (r && r.region) ? String(r.region) : "美国";
        var regStock = (r && typeof r.stock === 'number') ? r.stock : 0;
        var regSold = (r && typeof r.sold === 'number') ? r.sold : 0;

        var isSelected = regName === currentSelectedRegion || (idx === 0 && !currentSelectedRegion);
        if (isSelected) {
          currentSelectedRegion = regName;
          updateDisplayPriceForRegion(regName);
        }

        var priceForThis = (globalCategoryPrices && globalCategoryPrices[regName]) || globalDefaultPrice || "4.99";
        var numPrice = parseFloat(priceForThis);
        if (isNaN(numPrice)) numPrice = 4.99;

        var imgUrl = (globalCategoryImages && globalCategoryImages[regName]) ? globalCategoryImages[regName] : "";
        var imgHtml = imgUrl ? 
          '<img src="' + imgUrl + '" alt="' + regName + '" class="w-12 h-12 rounded-xl object-cover border border-indigo-500/40 shrink-0 shadow-sm">' :
          '<div class="w-12 h-12 rounded-xl bg-indigo-500/15 text-indigo-400 flex items-center justify-center font-bold text-lg shrink-0 border border-indigo-500/30"><i class="fa-solid fa-layer-group"></i></div>';

        var card = document.createElement("div");
        card.className = "p-3.5 rounded-2xl border cursor-pointer transition duration-150 flex items-center gap-3 " + 
                         (isSelected ? "card-active border-indigo-500 shadow-xl" : "border-slate-800 bg-slate-900/60 hover:border-slate-700 hover:bg-slate-900/90");
        card.onclick = function() {
          currentSelectedRegion = regName;
          updateDisplayPriceForRegion(regName);
          openCheckoutModal(regName);
        };

        card.innerHTML = imgHtml + 
          '<div class="flex-1 min-w-0 space-y-1">' +
            '<div class="flex items-center justify-between gap-1">' +
              '<span class="font-bold text-xs sm:text-sm text-white truncate">' + regName + '</span>' +
              getRegionMarketingTag(regName, idx) +
            '</div>' +
            '<div class="flex items-center justify-between text-[11px] text-slate-400">' +
              '<span class="flex items-center gap-1 text-amber-400/90 text-[10px]">' +
                '<i class="fa-solid fa-star text-[9px]"></i> 5.0 · 已售 ' + getFormattedSold(regSold, regName) +
              '</span>' +
              '<span class="text-[10px] px-1.5 py-0.2 rounded font-medium ' + (regStock > 0 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400') + '">' +
                (regStock > 0 ? '⚡ 现货充足' : '补货中') +
              '</span>' +
            '</div>' +
            '<div class="flex items-center justify-between pt-1 border-t border-slate-800/80 text-xs">' +
              '<div>' +
                '<span class="text-[10px] text-slate-500 mr-1">现货秒出</span>' +
                '<span class="text-emerald-400 font-extrabold font-mono text-sm">￥' + numPrice.toFixed(2) + '</span>' +
              '</div>' +
              '<button type="button" class="btn-card-buy-action px-3 py-1 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-bold rounded-lg text-xs flex items-center gap-1 shadow-md shadow-indigo-500/20 transition transform active:scale-95">' +
                '<i class="fa-solid fa-cart-shopping text-[10px]"></i> 购买' +
              '</button>' +
            '</div>' +
          '</div>';

        var buyBtn = card.querySelector(".btn-card-buy-action");
        if (buyBtn) {
          buyBtn.onclick = function(e) {
            e.stopPropagation();
            openCheckoutModal(regName);
          };
        }

        container.appendChild(card);
      });
    }

    async function submitOrder() {
      openCheckoutModal(currentSelectedRegion);
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
      var modalPay = document.getElementById("modal-pay");
      if (modalPay) {
        modalPay.classList.add("hidden");
        modalPay.style.display = "none";
      }
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
                    (o.status === 1 ? '<button data-no="' + o.order_no + '" data-contact="' + (o.contact || '') + '" onclick="querySendEmail(this.dataset.no, this.dataset.contact)" class="text-indigo-400 hover:text-indigo-300 font-medium text-xs flex items-center gap-1"><i class="fa-solid fa-envelope"></i> 发至邮箱</button>' : '') +
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
      var modalRes = document.getElementById("modal-result");
      if (modalRes) {
        modalRes.classList.add("hidden");
        modalRes.style.display = "none";
      }
    }

    function startFlashSaleTimer() {
      function tick() {
        var now = new Date();
        var midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
        var diff = Math.max(0, Math.floor((midnight - now) / 1000));
        var h = Math.floor(diff / 3600);
        var m = Math.floor((diff % 3600) / 60);
        var s = diff % 60;
        var hStr = (h < 10 ? '0' : '') + h;
        var mStr = (m < 10 ? '0' : '') + m;
        var sStr = (s < 10 ? '0' : '') + s;
        var timerEl = document.getElementById("flash-sale-timer");
        if (timerEl) timerEl.innerText = hStr + ":" + mStr + ":" + sStr;
      }
      tick();
      setInterval(tick, 1000);
    }

    var liveBroadcastIndex = 0;
    var sampleOrders = [
      { user: "广州买家 138****9201", product: "成功提卡【美国 ID (Shadowrocket)】", time: "8秒前" },
      { user: "北京买家 186****3310", product: "成功下单【香港独享 ID】", time: "25秒前" },
      { user: "上海买家 159****8842", product: "成功提卡【日本独享 ID】", time: "1分钟前" },
      { user: "深圳买家 177****5520", product: "使用优惠码立减购买【美国 ID】", time: "2分钟前" },
      { user: "杭州买家 131****4019", product: "成功提卡【通用独享 ID】", time: "3分钟前" },
      { user: "成都买家 198****7622", product: "成功提卡【台湾独享 ID】", time: "4分钟前" }
    ];

    function startLiveOrderBroadcaster() {
      var toast = document.getElementById("live-order-toast");
      var userEl = document.getElementById("live-toast-user");
      var prodEl = document.getElementById("live-toast-product");
      var timeEl = document.getElementById("live-toast-time");
      if (!toast) return;

      function showNextToast() {
        var item = sampleOrders[liveBroadcastIndex % sampleOrders.length];
        liveBroadcastIndex++;
        if (userEl) userEl.innerText = item.user;
        if (prodEl) prodEl.innerText = item.product;
        if (timeEl) timeEl.innerText = item.time;

        toast.classList.remove("translate-y-4", "opacity-0", "pointer-events-none");
        toast.classList.add("translate-y-0", "opacity-100");

        setTimeout(function() {
          toast.classList.remove("translate-y-0", "opacity-100");
          toast.classList.add("translate-y-4", "opacity-0", "pointer-events-none");
        }, 3200);
      }

      setTimeout(showNextToast, 2000);
      setInterval(showNextToast, 7500);
    }

    renderRegions();
    loadStats();
    startFlashSaleTimer();
    startLiveOrderBroadcaster();
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
<body class="p-4 max-w-2xl mx-auto pb-16 relative">
  <!-- 🔐 管理员安全登录锁屏门禁 (未登录/密码验证未通过时显示) -->
  <div id="admin-login-modal" class="fixed inset-0 bg-slate-950/95 backdrop-blur-xl z-50 flex items-center justify-center p-4">
    <div class="max-w-sm w-full bg-slate-900/90 border border-indigo-500/40 rounded-3xl p-6 sm:p-8 shadow-2xl space-y-5 text-center">
      <div class="w-16 h-16 rounded-2xl bg-indigo-600/20 text-indigo-400 border border-indigo-500/30 flex items-center justify-center mx-auto text-2xl shadow-inner">
        <i class="fa-solid fa-shield-halved animate-pulse"></i>
      </div>
      <div>
        <h2 class="text-xl font-extrabold text-white">站长安全管理后台</h2>
        <p class="text-xs text-slate-400 mt-1">请输入管理员安全访问密钥</p>
      </div>

      <div class="space-y-3 text-left">
        <div>
          <label class="text-[11px] text-slate-400 block mb-1">管理访问密钥</label>
          <div class="relative">
            <input type="password" id="gate-password-input" placeholder="请输入管理员访问密钥" onkeydown="if(event.key==='Enter')submitAdminLogin()" class="w-full pl-4 pr-10 py-3 rounded-xl bg-slate-950 border border-slate-700 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-indigo-500 font-mono">
            <button type="button" onclick="togglePasswordVisibility()" class="absolute right-3 top-3.5 text-slate-400 hover:text-white text-sm">
              <i class="fa-solid fa-eye" id="eye-icon"></i>
            </button>
          </div>
        </div>
        <div class="flex items-center justify-between text-xs">
          <label class="flex items-center gap-1.5 text-slate-400 cursor-pointer">
            <input type="checkbox" id="gate-remember-check" checked class="rounded bg-slate-800 border-slate-700 text-indigo-600">
            <span>在此设备记住密码 (下次免密直达)</span>
          </label>
        </div>
        <div id="gate-error-msg" class="hidden p-2.5 rounded-lg bg-rose-950/60 border border-rose-800 text-rose-300 text-xs text-center"></div>
      </div>

      <button onclick="submitAdminLogin()" id="btn-gate-login" class="w-full py-3 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-bold rounded-xl shadow-lg transition duration-200 flex items-center justify-center gap-2 text-sm">
        <i class="fa-solid fa-lock-open"></i> 立即验证进入后台
      </button>
      <div class="text-[11px] text-slate-500 text-center">
        Cloudflare Workers 端对端数据库鉴权保护
      </div>
    </div>
  </div>

  <!-- 顶部导航栏 -->
  <div class="mb-4 flex justify-between items-center border-b border-slate-800 pb-3">
    <h1 class="text-lg font-bold flex items-center gap-2 text-indigo-400">
      <i class="fa-solid fa-shield-halved"></i> 站长手机工作台
    </h1>
    <div class="flex items-center gap-2 text-xs">
      <button onclick="toggleSound()" id="btn-sound" class="px-2.5 py-1 rounded-lg bg-slate-800 text-emerald-400 hover:bg-slate-700 flex items-center gap-1">
        <i class="fa-solid fa-volume-high" id="sound-icon"></i> <span id="sound-status">提示音: 开</span>
      </button>
      <button onclick="playDingDong()" class="px-2 py-1 rounded-lg bg-slate-800 text-slate-300 hover:text-white" title="试听提示音">
        <i class="fa-solid fa-play text-[10px]"></i> 试听
      </button>
      <button onclick="adminLogout()" class="px-2.5 py-1 rounded-lg bg-slate-800 text-rose-400 hover:bg-rose-950/60 hover:text-rose-300 transition flex items-center gap-1" title="锁定并退出当前登录">
        <i class="fa-solid fa-arrow-right-from-bracket"></i> 退出
      </button>
      <a href="/" class="text-xs text-slate-400 hover:text-white flex items-center gap-1 ml-1">
        <i class="fa-solid fa-arrow-left"></i> 前台
      </a>
    </div>
  </div>

  <div class="space-y-4">
    <!-- 管理秘钥与自动刷新控制 -->
    <div class="p-3.5 rounded-xl bg-slate-900 border border-slate-800 flex flex-col sm:flex-row gap-2 justify-between items-center">
      <div class="flex gap-2 w-full sm:w-auto flex-1">
        <input type="password" id="admin-key" placeholder="输入管理员密钥" class="flex-1 px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-white font-mono">
        <button onclick="loadAdminData()" class="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-medium">刷新</button>
      </div>
      <div class="flex items-center gap-2 text-xs text-slate-400">
        <span class="w-2 h-2 rounded-full bg-emerald-400 animate-ping"></span>
        <span id="poll-status-text">4秒自动监听新订单</span>
      </div>
    </div>

    <!-- 📋 订单处理与发货工作台 (三大分类清晰管理) -->
    <div class="p-4 rounded-xl bg-slate-900 border border-slate-800 space-y-3">
      <div class="flex justify-between items-center border-b border-slate-800 pb-2">
        <h2 class="font-bold text-white flex items-center gap-2 text-sm">
          <i class="fa-solid fa-clipboard-list text-indigo-400"></i> 订单分类工作台
        </h2>
        <button onclick="clearExpiredOrders()" class="text-[11px] text-slate-500 hover:text-rose-400 transition flex items-center gap-1" title="清理24小时未付款废单">
          <i class="fa-solid fa-broom"></i> 清理24h废单
        </button>
      </div>

      <!-- 三大分类 Tabs -->
      <div class="grid grid-cols-3 gap-1.5 p-1 bg-slate-950 rounded-xl border border-slate-800 text-xs font-bold text-center">
        <button id="order-tab-paid" onclick="switchOrderTab('paid')" class="py-2 rounded-lg bg-emerald-600 text-white flex items-center justify-center gap-1.5 shadow transition">
          <i class="fa-solid fa-bell"></i> 
          <span>买家已付款</span>
          <span id="badge-paid-count" class="px-1.5 py-0.2 rounded-full bg-white/20 text-white text-[10px]">0</span>
        </button>
        <button id="order-tab-unpaid" onclick="switchOrderTab('unpaid')" class="py-2 rounded-lg text-slate-400 hover:text-white flex items-center justify-center gap-1.5 transition">
          <i class="fa-solid fa-clock"></i> 
          <span>仅下单未付</span>
          <span id="badge-unpaid-count" class="px-1.5 py-0.2 rounded-full bg-slate-800 text-slate-400 text-[10px]">0</span>
        </button>
        <button id="order-tab-done" onclick="switchOrderTab('done')" class="py-2 rounded-lg text-slate-400 hover:text-white flex items-center justify-center gap-1.5 transition">
          <i class="fa-solid fa-circle-check"></i> 
          <span>已成交发卡</span>
          <span id="badge-done-count" class="px-1.5 py-0.2 rounded-full bg-slate-800 text-slate-400 text-[10px]">0</span>
        </button>
      </div>

      <!-- 分类列表容器 -->
      <div id="order-panel-paid" class="space-y-3">
        <div class="text-slate-500 text-xs py-3 text-center">正在加载待发货订单...</div>
      </div>
      <div id="order-panel-unpaid" class="space-y-3 hidden">
        <div class="text-slate-500 text-xs py-3 text-center">正在加载未付款订单...</div>
      </div>
      <div id="order-panel-done" class="space-y-3 hidden">
        <div class="text-slate-500 text-xs py-3 text-center">正在加载已发卡记录...</div>
      </div>
    </div>

    <!-- ⚙️ 系统与价格设置 (核心配置) -->
    <div class="p-4 rounded-xl bg-slate-900 border border-slate-800 space-y-4">
      <div class="flex items-center justify-between border-b border-slate-800 pb-2">
        <h2 class="font-bold text-indigo-400 flex items-center gap-2 text-sm">
          <i class="fa-solid fa-sliders"></i> 系统与价格设置
        </h2>
        <span class="text-[11px] text-slate-500">修改后前台实时生效</span>
      </div>

      <!-- 1. 设置销售单价 -->
      <div class="space-y-2">
        <div class="flex items-center justify-between text-xs">
          <label class="font-medium text-slate-300 flex items-center gap-1">
            <i class="fa-solid fa-tag text-emerald-400"></i> 设置统一基准单价 (元)
          </label>
          <span class="text-emerald-400 font-mono text-[11px]" id="current-price-badge">当前价格: ￥4.99</span>
        </div>
        
        <!-- 快捷价格预设按钮 -->
        <div class="flex flex-wrap gap-1.5">
          <button type="button" onclick="setQuickPrice('1.99')" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-mono border border-slate-700 transition">￥1.99</button>
          <button type="button" onclick="setQuickPrice('2.99')" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-mono border border-slate-700 transition">￥2.99</button>
          <button type="button" onclick="setQuickPrice('3.99')" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-mono border border-slate-700 transition">￥3.99</button>
          <button type="button" onclick="setQuickPrice('4.99')" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-mono border border-slate-700 transition">￥4.99</button>
          <button type="button" onclick="setQuickPrice('6.99')" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-mono border border-slate-700 transition">￥6.99</button>
          <button type="button" onclick="setQuickPrice('9.99')" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-mono border border-slate-700 transition">￥9.99</button>
        </div>

        <div class="flex gap-2">
          <div class="relative flex-1">
            <span class="absolute left-3 top-2 text-slate-400 text-xs">￥</span>
            <input type="number" id="price-input" step="0.01" min="0.01" placeholder="4.99" class="w-full pl-7 pr-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs font-bold text-emerald-400">
          </div>
          <button onclick="savePrice()" class="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-lg text-xs flex items-center gap-1 shrink-0">
            <i class="fa-solid fa-floppy-disk"></i> 保存价格
          </button>
        </div>
      </div>

      <!-- 1.5. 各品类专属封面图片与独立定价管理 -->
      <div class="space-y-3 pt-2 border-t border-slate-800/80">
        <div class="flex items-center justify-between text-xs">
          <label class="font-medium text-slate-300 flex items-center gap-1">
            <i class="fa-solid fa-images text-emerald-400"></i> 各品类商品封面图与独立定价
          </label>
          <button type="button" onclick="addCustomCategoryPriceRow()" class="text-[11px] text-indigo-400 hover:text-indigo-300 font-medium">
            <i class="fa-solid fa-plus"></i> 新增品类
          </button>
        </div>
        <p class="text-[10px] text-slate-500">上传图片或填入图片链接后，买家前台商品卡片将实时展示精美封面！</p>
        <div id="category-price-table" class="space-y-2.5">
          <div class="text-slate-500 text-xs py-1 text-center">正在加载品类列表...</div>
        </div>
        <div class="pt-1 flex justify-end">
          <button onclick="saveCategoryPrices()" class="px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-lg text-xs flex items-center gap-1 shadow">
            <i class="fa-solid fa-floppy-disk"></i> 保存所有品类定价
          </button>
        </div>
      </div>

      <!-- 2. 微信公众号 / PushPlus 免费来单推送 -->
      <div class="space-y-2 pt-2 border-t border-slate-800/80">
        <div class="flex items-center justify-between text-xs">
          <label class="font-medium text-slate-300 flex items-center gap-1">
            <i class="fa-brands fa-weixin text-emerald-400"></i> 微信来单推送 Token (PushPlus)
          </label>
          <a href="https://www.pushplus.plus" target="_blank" class="text-[11px] text-indigo-400 hover:underline">免费获取Token</a>
        </div>
        <div class="flex gap-2">
          <input type="text" id="pushplus-token-input" placeholder="粘贴 PushPlus 的 Token (选填)" class="flex-1 px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-white font-mono">
          <button onclick="savePushPlusToken()" class="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-lg text-xs flex items-center gap-1 shrink-0">
            <i class="fa-solid fa-floppy-disk"></i> 保存
          </button>
          <button onclick="testPushPlus()" class="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs rounded-lg shrink-0" title="发送一条测试通知">
            测试
          </button>
        </div>
        <p class="text-[10px] text-slate-500">配置后，买家扫码付款时系统将自动推送到您的个人微信，无需一直守在网页前！</p>
      </div>

      <!-- 3. 设置网站标题 -->
      <div class="space-y-2 pt-2 border-t border-slate-800/80">
        <label class="text-xs font-medium text-slate-300 flex items-center gap-1">
          <i class="fa-solid fa-heading text-indigo-400"></i> 网站前台标题名称
        </label>
        <div class="flex gap-2">
          <input type="text" id="sitename-input" placeholder="例如：小火箭独享账号" class="flex-1 px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-white">
          <button onclick="saveSiteName()" class="px-4 py-1.5 bg-slate-700 hover:bg-slate-600 text-white font-bold rounded-lg text-xs flex items-center gap-1 shrink-0">
            <i class="fa-solid fa-floppy-disk"></i> 保存名称
          </button>
        </div>
      </div>

      <!-- 4. 微信收款设置 (前台唯一支付方式) -->
      <div class="space-y-3 pt-2 border-t border-slate-800/80">
        <div class="flex items-center justify-between text-xs">
          <label class="font-bold text-slate-200 flex items-center gap-1.5">
            <i class="fa-brands fa-weixin text-emerald-400 text-sm"></i> 微信收款设置 (前台唯一支付结算方式)
          </label>
          <span class="text-[11px] text-emerald-400 font-medium"><i class="fa-solid fa-circle-check mr-1"></i>已启用微信扫码支付</span>
        </div>

        <!-- 微信收款码上传与预览 -->
        <div class="space-y-2 bg-slate-950/60 p-3 rounded-xl border border-slate-800">
          <label class="text-[11px] font-medium text-slate-300 flex items-center gap-1">
            <i class="fa-solid fa-qrcode text-emerald-400"></i> 微信收款二维码图片 (本地上传或填入外链图片URL)
          </label>
          <div class="flex gap-3 items-center">
            <div class="w-16 h-16 bg-slate-800 rounded-lg border border-slate-700 flex items-center justify-center overflow-hidden shrink-0">
              <img id="current-qrcode-preview" src="" alt="微信收款码" class="w-full h-full object-contain hidden">
              <span id="no-qrcode-text" class="text-[10px] text-slate-500">未设置</span>
            </div>
            <div class="flex-1 space-y-2">
              <input type="file" id="qrcode-file-input" accept="image/*" class="text-xs text-slate-400 file:mr-2 file:py-1 file:px-2.5 file:rounded-lg file:border-0 file:text-[11px] file:font-semibold file:bg-emerald-600 file:text-white cursor-pointer w-full">
              <div class="flex gap-1.5">
                <input type="text" id="qrcode-url-input" placeholder="或直接输入微信收款码图片 URL 链接" class="flex-1 px-2.5 py-1 rounded-lg bg-slate-800 border border-slate-700 text-xs text-white">
                <button onclick="uploadQrcode()" id="btn-upload-qr" class="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-lg text-xs flex items-center justify-center gap-1 shrink-0">
                  <i class="fa-solid fa-cloud-arrow-up"></i> 保存收款码
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- 微信付款引导说明 -->
        <div class="space-y-1.5 bg-slate-950/60 p-3 rounded-xl border border-slate-800">
          <label class="text-[11px] font-medium text-slate-300 flex items-center gap-1">
            <i class="fa-solid fa-comment-dots text-amber-400"></i> 微信付款引导提示 (在买家扫码弹窗中展示)
          </label>
          <div class="flex gap-2">
            <input type="text" id="pay-note-setting-input" placeholder="例如：请使用微信扫一扫付款，付款后点击通知发货即可秒出卡" class="flex-1 px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-white">
            <button onclick="savePayNote()" class="px-3.5 py-1.5 bg-amber-600 hover:bg-amber-500 text-white font-bold rounded-lg text-xs flex items-center gap-1 shrink-0">
              <i class="fa-solid fa-floppy-disk"></i> 保存提示
            </button>
          </div>
        </div>
      </div>

      <!-- 5. 设置首页顶部公告栏 / 跑马灯 -->
      <div class="space-y-2 pt-2 border-t border-slate-800/80">
        <label class="text-xs font-medium text-slate-300 flex items-center gap-1">
          <i class="fa-solid fa-bullhorn text-amber-400"></i> 首页顶部公告栏 / 跑马灯
        </label>
        <div class="flex gap-2">
          <input type="text" id="announcement-input" placeholder="例如：🔥 今日刚补货50个美区账号，拍下即发！" class="flex-1 px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-white">
          <button onclick="saveAnnouncement()" class="px-4 py-1.5 bg-amber-600 hover:bg-amber-500 text-white font-bold rounded-lg text-xs flex items-center gap-1 shrink-0">
            <i class="fa-solid fa-floppy-disk"></i> 保存公告
          </button>
        </div>
        <p class="text-[10px] text-slate-500">留空则不显示公告。填写后买家前台顶部将以醒目通知卡片显示该公告。</p>
      </div>

      <!-- 6. 修改后台管理密码 -->
      <div class="space-y-2 pt-2 border-t border-slate-800/80">
        <label class="text-xs font-medium text-slate-300 flex items-center gap-1">
          <i class="fa-solid fa-key text-rose-400"></i> 修改后台管理密钥 (登录密码)
        </label>
        <div class="flex gap-2">
          <input type="text" id="new-admin-key-input" placeholder="输入新的管理密码 (至少4位)" class="flex-1 px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-white font-mono">
          <button onclick="saveAdminKey()" class="px-4 py-1.5 bg-rose-600 hover:bg-rose-500 text-white font-bold rounded-lg text-xs flex items-center gap-1 shrink-0">
            <i class="fa-solid fa-shield-halved"></i> 修改密码
          </button>
        </div>
        <p class="text-[10px] text-slate-500">修改后立即生效，下次登录或刷新请使用新密码。</p>
      </div>

      <!-- 7. 客服悬浮窗与联系方式配置 -->
      <div class="space-y-3 pt-2 border-t border-slate-800/80">
        <div class="flex items-center justify-between text-xs">
          <label class="font-medium text-slate-300 flex items-center gap-1">
            <i class="fa-solid fa-headset text-indigo-400"></i> 前台客服悬浮窗与联系方式配置
          </label>
          <span class="text-[10px] text-slate-500">前台右下角悬浮弹窗展示</span>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
          <div class="space-y-1">
            <label class="text-[11px] text-slate-400 flex items-center gap-1"><i class="fa-brands fa-weixin text-emerald-400"></i> 客服微信号</label>
            <input type="text" id="contact-wechat-input" placeholder="如: apple_helper88" class="w-full px-2.5 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-white">
          </div>
          <div class="space-y-1">
            <label class="text-[11px] text-slate-400 flex items-center gap-1"><i class="fa-brands fa-telegram text-sky-400"></i> Telegram (用户名/链接)</label>
            <input type="text" id="contact-tg-input" placeholder="如: @my_support 或 t.me/xxx" class="w-full px-2.5 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-white">
          </div>
          <div class="space-y-1">
            <label class="text-[11px] text-slate-400 flex items-center gap-1"><i class="fa-brands fa-qq text-blue-400"></i> 客服 QQ</label>
            <input type="text" id="contact-qq-input" placeholder="如: 12345678" class="w-full px-2.5 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-white">
          </div>
          <div class="space-y-1">
            <label class="text-[11px] text-slate-400 flex items-center gap-1"><i class="fa-solid fa-comment-dots text-amber-400"></i> 客服公告/售后说明</label>
            <input type="text" id="contact-tip-input" placeholder="如: 7x24小时全天候在线，包换包售后" class="w-full px-2.5 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-white">
          </div>
        </div>
        <div class="space-y-1.5 pt-1">
          <label class="text-[11px] text-slate-400 flex items-center gap-1"><i class="fa-solid fa-qrcode text-emerald-400"></i> 客服微信二维码</label>
          <div class="flex gap-3 items-center">
            <div class="w-14 h-14 bg-slate-800 rounded-lg border border-slate-700 flex items-center justify-center overflow-hidden shrink-0">
              <img id="contact-qr-preview" src="" alt="客服二维码" class="w-full h-full object-contain hidden">
              <span id="no-contact-qr-text" class="text-[10px] text-slate-500">未设置</span>
            </div>
            <div class="flex-1 flex flex-col sm:flex-row gap-2">
              <input type="file" id="contact-qr-file" accept="image/*" class="text-xs text-slate-400 file:mr-2 file:py-1 file:px-2.5 file:rounded-lg file:border-0 file:text-[11px] file:font-semibold file:bg-indigo-600 file:text-white cursor-pointer">
              <button onclick="uploadContactQrFile()" class="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold rounded-lg text-xs shrink-0 flex items-center justify-center gap-1">
                <i class="fa-solid fa-upload"></i> 上传二维码
              </button>
            </div>
          </div>
        </div>
        <div class="pt-1 flex justify-end">
          <button onclick="saveContactInfo()" class="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-lg text-xs flex items-center gap-1 shadow">
            <i class="fa-solid fa-floppy-disk"></i> 保存客服联系配置
          </button>
        </div>
      </div>
    </div>

    <!-- 🎫 优惠券与折扣营销管理 -->
    <div class="p-4 rounded-xl bg-slate-900 border border-slate-800 space-y-3">
      <div class="flex justify-between items-center">
        <h2 class="font-bold text-amber-400 flex items-center gap-2 text-sm">
          <i class="fa-solid fa-ticket"></i> 优惠券与折扣营销管理
        </h2>
        <span class="text-[11px] text-slate-500">买家下单可输入折扣券立减</span>
      </div>

      <!-- 创建优惠券表单 -->
      <div class="p-3 bg-slate-800/80 rounded-xl border border-slate-700 space-y-2.5">
        <div class="text-xs font-semibold text-slate-300 flex items-center gap-1">
          <i class="fa-solid fa-plus-circle text-emerald-400"></i> 创建新优惠码
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
          <div>
            <label class="text-[10px] text-slate-400 block mb-1">优惠券代码</label>
            <input type="text" id="new-coupon-code" placeholder="如 VIP888" class="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs text-white font-mono uppercase">
          </div>
          <div>
            <label class="text-[10px] text-slate-400 block mb-1">优惠模式</label>
            <select id="new-coupon-type" class="w-full px-2 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs text-white">
              <option value="fixed">固定金额立减 (￥)</option>
              <option value="percent">百分比折扣 (%)</option>
            </select>
          </div>
          <div>
            <label class="text-[10px] text-slate-400 block mb-1">优惠面额 (元 或 折扣%)</label>
            <input type="number" step="0.01" id="new-coupon-val" placeholder="如 1.00 或 20(八折)" class="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs text-emerald-400 font-bold">
          </div>
          <div>
            <label class="text-[10px] text-slate-400 block mb-1">门槛金额 (0为无门槛)</label>
            <input type="number" step="0.01" id="new-coupon-min" placeholder="0" class="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs text-white font-mono">
          </div>
          <div>
            <label class="text-[10px] text-slate-400 block mb-1">最大可使用次数</label>
            <input type="number" id="new-coupon-max" placeholder="留空为无限制" class="w-full px-2.5 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs text-white font-mono">
          </div>
        </div>
        <div class="flex justify-end pt-1">
          <button onclick="createAdminCoupon()" class="px-4 py-1.5 bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 text-white font-bold rounded-lg text-xs flex items-center gap-1 shadow transition">
            <i class="fa-solid fa-plus"></i> 生成并启用优惠券
          </button>
        </div>
      </div>

      <!-- 优惠券列表 -->
      <div id="coupon-list-container" class="space-y-2">
        <div class="text-xs text-slate-500 text-center py-4 bg-slate-950/60 rounded-xl border border-slate-800">
          暂无优惠券记录
        </div>
      </div>
    </div>

    <!-- 批量导入卡密 (支持自定义多品类) -->
    <div class="p-4 rounded-xl bg-slate-900 border border-slate-800 space-y-3">
      <div class="flex justify-between items-center">
        <h2 class="font-bold text-indigo-400 flex items-center gap-2 text-sm">
          <i class="fa-solid fa-file-import"></i> 批量导入卡密 (支持新增任意品类)
        </h2>
      </div>
      <div class="space-y-2">
        <div class="flex flex-col sm:flex-row gap-2">
          <div class="flex-1 flex gap-1.5">
            <select id="import-region-select" onchange="onRegionSelectChange(this.value)" class="px-2.5 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-white">
              <option value="美国">美国</option>
              <option value="香港">香港</option>
              <option value="日本">日本</option>
              <option value="台湾">台湾</option>
              <option value="通用">通用</option>
              <option value="__custom__">+ 自定义品类名称</option>
            </select>
            <input type="text" id="import-region-custom" placeholder="输入自定义品类名(如ChatGPT)" class="hidden flex-1 px-2.5 py-1.5 rounded-lg bg-slate-800 border border-indigo-500 text-xs text-white">
          </div>
          <button onclick="importCarmis()" class="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-lg text-xs flex items-center justify-center gap-1">
            <i class="fa-solid fa-upload"></i> 导入卡密
          </button>
        </div>
        <textarea id="import-text" rows="2" placeholder="一行一条卡密，例如：&#10;账号: xxx@outlook.com ---- 密码: xxx" class="w-full px-2.5 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs font-mono text-white"></textarea>
      </div>
    </div>
  </div>

  <script>
    var adminPollTimer = null;

    function togglePasswordVisibility() {
      var inp = document.getElementById("gate-password-input");
      var icon = document.getElementById("eye-icon");
      if (!inp) return;
      if (inp.type === "password") {
        inp.type = "text";
        if (icon) icon.className = "fa-solid fa-eye-slash";
      } else {
        inp.type = "password";
        if (icon) icon.className = "fa-solid fa-eye";
      }
    }

    async function submitAdminLogin() {
      var passInput = document.getElementById("gate-password-input");
      var key = (passInput ? passInput.value.trim() : "");
      var errMsg = document.getElementById("gate-error-msg");
      var btn = document.getElementById("btn-gate-login");
      var remember = document.getElementById("gate-remember-check").checked;

      if (!key) {
        if (errMsg) {
          errMsg.innerText = "请输入管理密码";
          errMsg.classList.remove("hidden");
        }
        return;
      }

      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在安全验证...';
      }

      try {
        var res = await fetch("/api/admin/orders?key=" + encodeURIComponent(key));
        var json = await res.json();
        if (json.code === 0) {
          if (remember) {
            localStorage.setItem("faka_admin_key", key);
          } else {
            sessionStorage.setItem("faka_admin_key", key);
            localStorage.removeItem("faka_admin_key");
          }
          var keyInput = document.getElementById("admin-key");
          if (keyInput) keyInput.value = key;
          document.getElementById("admin-login-modal").classList.add("hidden");
          if (errMsg) errMsg.classList.add("hidden");
          loadAdminData();
          startAdminPolling();
        } else {
          if (errMsg) {
            errMsg.innerText = "⚠️ 密码错误，访问被拒绝！请核对大小写";
            errMsg.classList.remove("hidden");
          }
        }
      } catch (err) {
        if (errMsg) {
          errMsg.innerText = "网络连接异常，请重试";
          errMsg.classList.remove("hidden");
        }
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<i class="fa-solid fa-lock-open"></i> 立即验证进入后台';
        }
      }
    }

    function adminLogout() {
      if (!confirm("确定要退出管理后台并锁定？")) return;
      localStorage.removeItem("faka_admin_key");
      sessionStorage.removeItem("faka_admin_key");
      if (adminPollTimer) clearInterval(adminPollTimer);
      var keyInput = document.getElementById("admin-key");
      if (keyInput) keyInput.value = "";
      var gateInput = document.getElementById("gate-password-input");
      if (gateInput) gateInput.value = "";
      var errMsg = document.getElementById("gate-error-msg");
      if (errMsg) errMsg.classList.add("hidden");
      document.getElementById("admin-login-modal").classList.remove("hidden");
    }

    var soundEnabled = localStorage.getItem("faka_sound_enabled") !== "false";
    updateSoundBtnUI();

    var lastPendingCount = 0;
    var audioCtx = null;

    function updateSoundBtnUI() {
      var icon = document.getElementById("sound-icon");
      var txt = document.getElementById("sound-status");
      var btn = document.getElementById("btn-sound");
      if (soundEnabled) {
        if (icon) icon.className = "fa-solid fa-volume-high";
        if (txt) txt.innerText = "提示音: 开";
        if (btn) btn.className = "px-2.5 py-1 rounded-lg bg-slate-800 text-emerald-400 hover:bg-slate-700 flex items-center gap-1";
      } else {
        if (icon) icon.className = "fa-solid fa-volume-xmark";
        if (txt) txt.innerText = "提示音: 关";
        if (btn) btn.className = "px-2.5 py-1 rounded-lg bg-slate-800 text-slate-400 hover:bg-slate-700 flex items-center gap-1";
      }
    }

    function toggleSound() {
      soundEnabled = !soundEnabled;
      localStorage.setItem("faka_sound_enabled", soundEnabled);
      updateSoundBtnUI();
      if (soundEnabled) playDingDong();
    }

    // 纯 Web Audio API 合成真实自然的高品质“叮咚”来单提示音
    function playDingDong() {
      try {
        if (!audioCtx) {
          var AudioContext = window.AudioContext || window.webkitAudioContext;
          audioCtx = new AudioContext();
        }
        if (audioCtx.state === 'suspended') {
          audioCtx.resume();
        }
        var now = audioCtx.currentTime;

        // 叮 (880Hz / A5 音高)
        var osc1 = audioCtx.createOscillator();
        var gain1 = audioCtx.createGain();
        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(880, now);
        gain1.gain.setValueAtTime(0.35, now);
        gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
        osc1.connect(gain1);
        gain1.connect(audioCtx.destination);
        osc1.start(now);
        osc1.stop(now + 0.55);

        // 咚 (659.25Hz / E5 音高)
        var osc2 = audioCtx.createOscillator();
        var gain2 = audioCtx.createGain();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(659.25, now + 0.22);
        gain2.gain.setValueAtTime(0.4, now + 0.22);
        gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.95);
        osc2.connect(gain2);
        gain2.connect(audioCtx.destination);
        osc2.start(now + 0.22);
        osc2.stop(now + 0.95);

        // 手机震动触发 (双短震)
        if (navigator.vibrate) {
          navigator.vibrate([200, 100, 200]);
        }
      } catch (e) {
        console.error("音频播放异常:", e);
      }
    }

    function onRegionSelectChange(val) {
      var customInput = document.getElementById("import-region-custom");
      if (val === "__custom__") {
        customInput.classList.remove("hidden");
        customInput.focus();
      } else {
        customInput.classList.add("hidden");
      }
    }

    var currentOrderTab = 'paid';

    function switchOrderTab(tab) {
      currentOrderTab = tab;
      var btnPaid = document.getElementById("order-tab-paid");
      var btnUnpaid = document.getElementById("order-tab-unpaid");
      var btnDone = document.getElementById("order-tab-done");

      var panelPaid = document.getElementById("order-panel-paid");
      var panelUnpaid = document.getElementById("order-panel-unpaid");
      var panelDone = document.getElementById("order-panel-done");

      // 重置所有 tab 按钮样式
      if (btnPaid) btnPaid.className = "py-2 rounded-lg text-slate-400 hover:text-white flex items-center justify-center gap-1.5 transition";
      if (btnUnpaid) btnUnpaid.className = "py-2 rounded-lg text-slate-400 hover:text-white flex items-center justify-center gap-1.5 transition";
      if (btnDone) btnDone.className = "py-2 rounded-lg text-slate-400 hover:text-white flex items-center justify-center gap-1.5 transition";

      // 隐藏所有面板
      if (panelPaid) panelPaid.classList.add("hidden");
      if (panelUnpaid) panelUnpaid.classList.add("hidden");
      if (panelDone) panelDone.classList.add("hidden");

      if (tab === 'paid') {
        if (btnPaid) btnPaid.className = "py-2 rounded-lg bg-emerald-600 text-white flex items-center justify-center gap-1.5 shadow transition";
        if (panelPaid) panelPaid.classList.remove("hidden");
      } else if (tab === 'unpaid') {
        if (btnUnpaid) btnUnpaid.className = "py-2 rounded-lg bg-indigo-600 text-white flex items-center justify-center gap-1.5 shadow transition";
        if (panelUnpaid) panelUnpaid.classList.remove("hidden");
      } else if (tab === 'done') {
        if (btnDone) btnDone.className = "py-2 rounded-lg bg-slate-700 text-white flex items-center justify-center gap-1.5 shadow transition";
        if (panelDone) panelDone.classList.remove("hidden");
      }
    }

    async function loadAdminData() {
      var keyInput = document.getElementById("admin-key");
      var key = (keyInput ? keyInput.value.trim() : "") || localStorage.getItem("faka_admin_key") || sessionStorage.getItem("faka_admin_key");
      if (!key) {
        document.getElementById("admin-login-modal").classList.remove("hidden");
        return;
      }
      if (keyInput) keyInput.value = key;

      var panelPaid = document.getElementById("order-panel-paid");
      var panelUnpaid = document.getElementById("order-panel-unpaid");
      var panelDone = document.getElementById("order-panel-done");

      var badgePaid = document.getElementById("badge-paid-count");
      var badgeUnpaid = document.getElementById("badge-unpaid-count");
      var badgeDone = document.getElementById("badge-done-count");
      var pollTxt = document.getElementById("poll-status-text");

      try {
        var res = await fetch("/api/admin/orders?key=" + encodeURIComponent(key));
        var json = await res.json();
        
        if (pollTxt) {
          pollTxt.innerText = "4秒监听中 (" + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + ")";
        }

        if (json.code === 0) {
          if (json.price) {
            document.getElementById("price-input").value = json.price;
            var priceBadge = document.getElementById("current-price-badge");
            if (priceBadge) priceBadge.innerText = "当前价格: ￥" + json.price;
          }

          if (json.site_name) {
            var siteInput = document.getElementById("sitename-input");
            if (siteInput && !siteInput.value) siteInput.value = json.site_name;
          }

          if (json.announcement !== undefined) {
            var annInput = document.getElementById("announcement-input");
            if (annInput && !annInput.value) annInput.value = json.announcement || "";
          }

          if (json.pushplus_token) {
            var tokenInput = document.getElementById("pushplus-token-input");
            if (tokenInput && !tokenInput.value) tokenInput.value = json.pushplus_token;
          }

          if (json.qrcode) {
            document.getElementById("current-qrcode-preview").src = json.qrcode;
            document.getElementById("current-qrcode-preview").classList.remove("hidden");
            document.getElementById("no-qrcode-text").classList.add("hidden");
            var qrUrlInp = document.getElementById("qrcode-url-input");
            if (qrUrlInp && !qrUrlInp.value && json.qrcode.startsWith("http")) {
              qrUrlInp.value = json.qrcode;
            }
          }

          if (json.pay_note !== undefined) {
            var noteInp = document.getElementById("pay-note-setting-input");
            if (noteInp && !noteInp.value) noteInp.value = json.pay_note || "";
          }

          if (json.contact_info) {
            var cWechat = document.getElementById("contact-wechat-input");
            var cTg = document.getElementById("contact-tg-input");
            var cQq = document.getElementById("contact-qq-input");
            var cTip = document.getElementById("contact-tip-input");
            var cQrPrev = document.getElementById("contact-qr-preview");
            var noQrTxt = document.getElementById("no-contact-qr-text");

            if (cWechat && !cWechat.value) cWechat.value = json.contact_info.wechat || "";
            if (cTg && !cTg.value) cTg.value = json.contact_info.telegram || "";
            if (cQq && !cQq.value) cQq.value = json.contact_info.qq || "";
            if (cTip && !cTip.value) cTip.value = json.contact_info.custom_tip || "";
            if (json.contact_info.wechat_qr && cQrPrev) {
              cQrPrev.src = json.contact_info.wechat_qr;
              cQrPrev.classList.remove("hidden");
              if (noQrTxt) noQrTxt.classList.add("hidden");
            }
          }

          if (json.coupons) {
            renderCouponsTable(json.coupons);
          }

          // 核心分类逻辑：严格拆分【买家已提交付款】与【仅下单未付款】
          var allPending = json.pending || [];
          var paidOrders = [];
          var unpaidOrders = [];

          allPending.forEach(function(o) {
            var pType = (o.pay_type || "").trim();
            if (pType.indexOf("买家已") !== -1 || pType.indexOf("已付款") !== -1 || pType.indexOf("付款申请") !== -1) {
              paidOrders.push(o);
            } else {
              unpaidOrders.push(o);
            }
          });

          var doneOrders = json.recent || [];

          // 更新三大分类数量徽章
          if (badgePaid) {
            badgePaid.innerText = paidOrders.length;
            if (paidOrders.length > 0) {
              badgePaid.className = "px-1.5 py-0.2 rounded-full bg-rose-500 text-white font-bold animate-pulse text-[10px]";
            } else {
              badgePaid.className = "px-1.5 py-0.2 rounded-full bg-white/20 text-white text-[10px]";
            }
          }
          if (badgeUnpaid) badgeUnpaid.innerText = unpaidOrders.length;
          if (badgeDone) badgeDone.innerText = doneOrders.length;

          // 核心来单提醒：当有新的“买家已付款”时触发叮咚提示音与双短震
          if (paidOrders.length > lastPendingCount) {
            if (soundEnabled) {
              playDingDong();
            }
          }
          lastPendingCount = paidOrders.length;

          // 1. 渲染【买家已付款待发货】面板
          if (panelPaid) {
            if (paidOrders.length === 0) {
              panelPaid.innerHTML = '<div class="text-xs text-slate-500 text-center py-6 bg-slate-950/60 rounded-xl border border-slate-800">' +
                '<i class="fa-solid fa-circle-check text-emerald-400 text-base mb-1 block"></i>' +
                '暂无待发货订单，所有买家付款均已处理出库！' +
              '</div>';
            } else {
              panelPaid.innerHTML = paidOrders.map(function(o) {
                return '<div class="p-3.5 rounded-xl bg-slate-800 border-2 border-emerald-500/80 space-y-2.5 shadow-xl">' +
                  '<div class="flex justify-between items-center text-xs">' +
                    '<span class="font-mono text-white font-bold flex items-center gap-1.5">' +
                      '<span class="w-2 h-2 rounded-full bg-emerald-400 animate-ping"></span>' +
                      '单号: ' + o.order_no +
                    '</span>' +
                    '<span class="px-2 py-0.5 bg-emerald-500/20 text-emerald-300 font-bold rounded border border-emerald-500/40">' + 
                      o.region + ' · ￥' + o.price + 
                    '</span>' +
                  '</div>' +
                  '<div class="text-xs text-emerald-300 font-medium bg-slate-950 p-2.5 rounded-lg border border-slate-700 space-y-1">' +
                    '<div class="flex justify-between items-center">' +
                      '<span class="font-bold text-amber-300"><i class="fa-solid fa-comment-dollar mr-1"></i> ' + (o.pay_type || '买家已扫码') + '</span>' +
                      '<span class="text-slate-400 text-[11px]">' + (o.contact || '买家未填联系方式') + '</span>' +
                    '</div>' +
                  '</div>' +
                  '<div class="flex justify-between items-center pt-0.5">' +
                    '<span class="text-[11px] text-slate-400 font-mono">' + o.created_at + '</span>' +
                    '<div class="flex items-center gap-2">' +
                      '<button data-no="' + o.order_no + '" onclick="rejectAdminOrder(this.dataset.no)" class="px-3 py-2 bg-slate-900 hover:bg-rose-950 text-slate-400 hover:text-rose-300 font-bold rounded-xl text-xs border border-slate-700 transition" title="买家未付款或付款异常时驳回订单">' +
                        '<i class="fa-solid fa-ban"></i> 驳回' +
                      '</button>' +
                      '<button data-no="' + o.order_no + '" onclick="approveOrder(this.dataset.no)" class="px-5 py-2 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white font-extrabold rounded-xl text-xs shadow-lg flex items-center gap-1.5 transition transform active:scale-95">' +
                        '<i class="fa-solid fa-bolt"></i> 确认已收款，立即出卡' +
                      '</button>' +
                    '</div>' +
                  '</div>' +
                '</div>';
              }).join("");
            }
          }

          // 2. 渲染【仅下单未付款】面板
          if (panelUnpaid) {
            if (unpaidOrders.length === 0) {
              panelUnpaid.innerHTML = '<div class="text-xs text-slate-500 text-center py-4 bg-slate-950/60 rounded-xl border border-slate-800">暂无未付款订单</div>';
            } else {
              panelUnpaid.innerHTML = unpaidOrders.map(function(o) {
                return '<div class="p-2.5 rounded-xl bg-slate-800/60 border border-slate-700/60 space-y-1.5 text-xs">' +
                  '<div class="flex justify-between items-center">' +
                    '<span class="font-mono text-slate-300">' + o.order_no + '</span>' +
                    '<span class="text-indigo-300 font-medium">' + o.region + ' · ￥' + o.price + '</span>' +
                  '</div>' +
                  '<div class="flex justify-between items-center text-slate-400 text-[11px] pt-1 border-t border-slate-700/40">' +
                    '<span>下单: ' + o.created_at + ' (' + (o.contact || '无联系') + ')</span>' +
                    '<div class="flex items-center gap-1.5">' +
                      '<button data-no="' + o.order_no + '" onclick="deleteAdminOrder(this.dataset.no)" class="px-2 py-1 bg-slate-900 hover:bg-rose-950 text-slate-400 hover:text-rose-300 rounded text-[11px] border border-slate-700 transition" title="删除该废单">' +
                        '<i class="fa-solid fa-trash-can"></i>' +
                      '</button>' +
                      '<button data-no="' + o.order_no + '" onclick="approveOrder(this.dataset.no)" class="px-2.5 py-1 bg-slate-700 hover:bg-emerald-600 text-slate-200 hover:text-white rounded text-[11px] font-medium transition">' +
                        '直接出卡' +
                      '</button>' +
                    '</div>' +
                  '</div>' +
                '</div>';
              }).join("");
            }
          }

          // 3. 渲染【已成交出卡】面板
          if (panelDone) {
            if (doneOrders.length === 0) {
              panelDone.innerHTML = '<div class="text-xs text-slate-500 text-center py-4 bg-slate-950/60 rounded-xl border border-slate-800">暂无已发卡记录</div>';
            } else {
              panelDone.innerHTML = doneOrders.map(function(o) {
                return '<div class="p-3 rounded-xl bg-slate-800/80 text-xs border border-slate-700/80 space-y-2">' +
                  '<div class="flex justify-between items-center text-slate-400">' +
                    '<span class="font-mono font-bold text-white">' + o.order_no + ' (' + o.region + ')</span>' +
                    '<span class="text-emerald-400 font-mono text-[11px]">' + (o.paid_at || '') + '</span>' +
                  '</div>' +
                  '<div class="text-slate-300 font-mono select-all break-all text-[11px] bg-slate-950 p-2 rounded-lg border border-slate-800">' + 
                    (o.carmi || '已核销发卡') + 
                  '</div>' +
                '</div>';
              }).join("");
            }
          }

          if (json.categories || json.category_prices || json.category_images) {
            renderCategoryPriceTable(json.categories, json.category_prices, json.category_images);
          }
        } else {
          if (adminPollTimer) clearInterval(adminPollTimer);
          document.getElementById("admin-login-modal").classList.remove("hidden");
          var errMsg = document.getElementById("gate-error-msg");
          if (errMsg) {
            errMsg.innerText = "⚠️ 访问拒绝: " + (json.msg || "管理密钥错误");
            errMsg.classList.remove("hidden");
          }
        }
      } catch (e) {
        if (pollTxt) pollTxt.innerText = "网络异常重试中...";
      }
    }

    var currentCategories = ["美国", "香港", "日本", "台湾", "通用"];
    var currentCategoryPrices = {};
    var currentCategoryImages = {};

    function renderCategoryPriceTable(categories, prices, images) {
      if (categories && Array.isArray(categories)) currentCategories = categories;
      if (prices && typeof prices === 'object') currentCategoryPrices = prices;
      if (images && typeof images === 'object') currentCategoryImages = images;
      var container = document.getElementById("category-price-table");
      if (!container) return;

      var html = currentCategories.map(function(cat) {
        var p = currentCategoryPrices[cat] || "";
        var imgUrl = currentCategoryImages[cat] || "";
        var encodedCat = encodeURIComponent(cat);

        var imgPreview = imgUrl ? 
          '<img src="' + imgUrl + '" class="w-12 h-12 rounded-xl object-cover border border-indigo-500/40 shrink-0 shadow">' :
          '<div class="w-12 h-12 rounded-xl bg-slate-950 text-slate-500 flex flex-col items-center justify-center text-[10px] shrink-0 border border-dashed border-slate-700"><i class="fa-solid fa-image text-xs mb-0.5"></i>无封面</div>';

        var clearBtn = imgUrl ? 
          '<button data-cat="' + encodedCat + '" onclick="clearCategoryImage(decodeURIComponent(this.dataset.cat))" class="px-2 py-1 bg-rose-950/60 hover:bg-rose-900 text-rose-300 rounded text-[11px] shrink-0 border border-rose-800/60 transition" title="清除图片"><i class="fa-solid fa-trash-can"></i></button>' : '';

        return '<div class="p-3 bg-slate-800/80 rounded-xl border border-slate-700/70 space-y-2.5">' +
          '<div class="flex items-center gap-3">' +
            imgPreview +
            '<div class="flex-1 min-w-0 space-y-1.5">' +
              '<div class="flex items-center justify-between">' +
                '<span class="text-xs font-bold text-white truncate">' + cat + '</span>' +
                '<div class="flex items-center gap-1.5">' +
                  '<button data-cat="' + encodedCat + '" onclick="aiGenerateCategoryImage(decodeURIComponent(this.dataset.cat), this)" class="px-2.5 py-1 bg-gradient-to-r from-pink-500 to-purple-600 hover:from-pink-600 hover:to-purple-700 text-white font-bold rounded text-[11px] flex items-center gap-1 shadow transition" title="使用 AI 一键为该品类生成专属高清封面">' +
                    '<i class="fa-solid fa-wand-magic-sparkles"></i> AI生图' +
                  '</button>' +
                  '<label class="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded text-[11px] cursor-pointer flex items-center gap-1 shadow transition">' +
                    '<i class="fa-solid fa-upload"></i> 上传' +
                    '<input type="file" accept="image/*" class="hidden" data-cat="' + encodedCat + '" onchange="handleCategoryFileUpload(decodeURIComponent(this.dataset.cat), this)">' +
                  '</label>' +
                  '<button data-cat="' + encodedCat + '" onclick="handleCategoryUrlInput(decodeURIComponent(this.dataset.cat))" class="px-2 py-1 bg-slate-900 hover:bg-slate-700 text-slate-300 font-medium rounded text-[11px] flex items-center gap-1 border border-slate-700 transition" title="填入网络图片链接">' +
                    '<i class="fa-solid fa-link"></i> URL' +
                  '</button>' +
                  clearBtn +
                '</div>' +
              '</div>' +
              '<div class="flex items-center gap-2">' +
                '<span class="text-[11px] text-slate-400 shrink-0">独立单价:</span>' +
                '<div class="relative flex-1">' +
                  '<span class="absolute left-2 top-1 text-slate-500 text-xs">￥</span>' +
                  '<input type="number" step="0.01" data-cat="' + encodedCat + '" value="' + p + '" placeholder="留空继承基准价" class="cat-price-input w-full pl-5 pr-2 py-0.5 rounded bg-slate-950 border border-slate-700 text-xs text-emerald-400 font-mono font-bold">' +
                '</div>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>';
      }).join("");

      container.innerHTML = html;
    }

    // ✨ AI 智能自动生成商品封面配图
    async function aiGenerateCategoryImage(region, btnEl) {
      var key = document.getElementById("admin-key").value.trim();
      var originalHtml = btnEl ? btnEl.innerHTML : "";
      if (btnEl) {
        btnEl.disabled = true;
        btnEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> AI绘制中...';
      }

      try {
        var res = await fetch("/api/admin/generate_ai_cover", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: key, region: region })
        });
        var json = await res.json();

        if (json.code === 0 && json.image_url) {
          // 自动直接保存该 AI 封面
          var saveRes = await fetch("/api/admin/set_category_image", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key: key, region: region, image_url: json.image_url })
          });
          var saveJson = await saveRes.json();
          alert(saveJson.msg || ("🎉 已成功为【" + region + "】生成并应用 AI 封面图片！"));
          loadAdminData();
        } else {
          // 本地 Canvas 高质感 3D 徽标智能兜底生成
          generateLocalCanvasAiCover(region, key);
        }
      } catch (err) {
        generateLocalCanvasAiCover(region, key);
      } finally {
        if (btnEl) {
          btnEl.disabled = false;
          btnEl.innerHTML = originalHtml;
        }
      }
    }

    // 智能本地 3D 徽标生成器 (100% 可靠兜底)
    async function generateLocalCanvasAiCover(region, key) {
      try {
        var canvas = document.createElement("canvas");
        canvas.width = 400;
        canvas.height = 400;
        var ctx = canvas.getContext("2d");

        // 渐变背景
        var grad = ctx.createLinearGradient(0, 0, 400, 400);
        if (region.indexOf("美国") !== -1 || region.indexOf("香港") !== -1) {
          grad.addColorStop(0, "#1e1b4b"); grad.addColorStop(1, "#312e81");
        } else if (region.indexOf("日本") !== -1 || region.indexOf("台湾") !== -1) {
          grad.addColorStop(0, "#4c0519"); grad.addColorStop(1, "#831843");
        } else if (region.toLowerCase().indexOf("gpt") !== -1 || region.toLowerCase().indexOf("ai") !== -1) {
          grad.addColorStop(0, "#022c22"); grad.addColorStop(1, "#065f46");
        } else {
          grad.addColorStop(0, "#0f172a"); grad.addColorStop(1, "#1e293b");
        }
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 400, 400);

        // 装饰光晕
        ctx.beginPath();
        ctx.arc(200, 200, 140, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
        ctx.fill();

        // 核心文字徽标
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 38px -apple-system, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(region, 200, 185);

        ctx.fillStyle = "#a5b4fc";
        ctx.font = "bold 18px sans-serif";
        ctx.fillText("✦ PREMIUM ✦", 200, 235);

        var dataUrl = canvas.toDataURL("image/jpeg", 0.9);
        await fetch("/api/admin/set_category_image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: key, region: region, image_url: dataUrl })
        });
        alert("🎉 已为【" + region + "】生成专属高质感封面！");
        loadAdminData();
      } catch(e) {
        alert("生成失败，请重试");
      }
    }

    function addCustomCategoryPriceRow() {
      var catName = prompt("请输入新品类名称（例如：ChatGPT、Netflix、土耳其ID 等）：");
      if (!catName || !catName.trim()) return;
      catName = catName.trim();
      if (currentCategories.indexOf(catName) === -1) {
        currentCategories.push(catName);
      }
      renderCategoryPriceTable(currentCategories, currentCategoryPrices, currentCategoryImages);
    }

    async function handleCategoryFileUpload(region, inputEl) {
      if (!inputEl.files || inputEl.files.length === 0) return;
      var file = inputEl.files[0];
      var key = document.getElementById("admin-key").value.trim();

      var reader = new FileReader();
      reader.onload = function(e) {
        var img = new Image();
        img.onload = async function() {
          var canvas = document.createElement("canvas");
          var maxDim = 400;
          var w = img.width, h = img.height;
          if (w > maxDim || h > maxDim) {
            if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
            else { w = Math.round(w * maxDim / h); h = maxDim; }
          }
          canvas.width = w;
          canvas.height = h;
          var ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, w, h);
          var compressedBase64 = canvas.toDataURL("image/jpeg", 0.85);

          try {
            var res = await fetch("/api/admin/set_category_image", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ key: key, region: region, image_url: compressedBase64 })
            });
            var json = await res.json();
            alert(json.msg || "封面设置成功");
            loadAdminData();
          } catch (err) {
            alert("上传异常，请重试");
          }
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    }

    async function handleCategoryUrlInput(region) {
      var key = document.getElementById("admin-key").value.trim();
      var currentUrl = currentCategoryImages[region] || "";
      var inputUrl = prompt("请输入【" + region + "】的商品封面图片网络链接 (URL)：", currentUrl);
      if (inputUrl === null) return;
      inputUrl = inputUrl.trim();

      try {
        var res = await fetch("/api/admin/set_category_image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: key, region: region, image_url: inputUrl })
        });
        var json = await res.json();
        alert(json.msg || "设置成功");
        loadAdminData();
      } catch(e) {
        alert("设置失败");
      }
    }

    async function clearCategoryImage(region) {
      var key = document.getElementById("admin-key").value.trim();
      if (!confirm("确定要清除【" + region + "】的自定义封面图片吗？")) return;

      try {
        var res = await fetch("/api/admin/set_category_image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: key, region: region, image_url: "" })
        });
        var json = await res.json();
        alert(json.msg || "清除成功");
        loadAdminData();
      } catch(e) {
        alert("清除失败");
      }
    }

    async function saveCategoryPrices() {
      var key = document.getElementById("admin-key").value.trim();
      var inputs = document.querySelectorAll(".cat-price-input");
      var newMap = {};
      inputs.forEach(function(inp) {
        var cat = inp.dataset.cat;
        var val = inp.value.trim();
        if (cat && val && parseFloat(val) > 0) {
          newMap[cat] = parseFloat(val).toFixed(2);
        }
      });

      try {
        var res = await fetch("/api/admin/set_category_prices", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: key, category_prices: newMap })
        });
        var json = await res.json();
        alert(json.msg || "品类定价保存成功");
        loadAdminData();
      } catch (e) {
        alert("保存失败");
      }
    }

    function setQuickPrice(val) {
      document.getElementById("price-input").value = val;
      savePrice();
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

    async function rejectAdminOrder(orderNo) {
      var key = document.getElementById("admin-key").value.trim();
      if (!confirm("确定要驳回该待发货订单 (" + orderNo + ") 吗？（如买家未实质付款或付款金额不对）")) return;

      try {
        var res = await fetch("/api/admin/cancel_order", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: key, order_no: orderNo })
        });
        var json = await res.json();
        alert(json.msg || "已驳回该订单");
        loadAdminData();
      } catch (e) {
        alert("操作失败");
      }
    }

    async function deleteAdminOrder(orderNo) {
      var key = document.getElementById("admin-key").value.trim();
      if (!confirm("确定要删除该未付款订单 (" + orderNo + ") 吗？")) return;

      try {
        var res = await fetch("/api/admin/cancel_order", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: key, order_no: orderNo })
        });
        var json = await res.json();
        alert(json.msg || "已删除该订单");
        loadAdminData();
      } catch (e) {
        alert("操作失败");
      }
    }

    async function cancelAdminOrder(orderNo, actionText) {
      var key = document.getElementById("admin-key").value.trim();
      var tip = actionText || "取消/删除";
      if (!confirm("确定要" + tip + "该订单 (" + orderNo + ") 吗？")) return;

      try {
        var res = await fetch("/api/admin/cancel_order", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: key, order_no: orderNo })
        });
        var json = await res.json();
        alert(json.msg || "操作成功");
        loadAdminData();
      } catch (e) {
        alert("操作失败");
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

    async function saveSiteName() {
      var key = document.getElementById("admin-key").value.trim();
      var name = document.getElementById("sitename-input").value.trim();
      if (!name) return alert("请输入网站名称");

      try {
        var res = await fetch("/api/admin/set_site_name", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: key, site_name: name })
        });
        var json = await res.json();
        alert(json.msg || "网站名称保存成功");
        loadAdminData();
      } catch (e) {
        alert("保存失败");
      }
    }

    async function saveAnnouncement() {
      var key = document.getElementById("admin-key").value.trim();
      var text = document.getElementById("announcement-input").value.trim();

      try {
        var res = await fetch("/api/admin/set_announcement", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: key, announcement: text })
        });
        var json = await res.json();
        alert(json.msg || "公告已保存");
        loadAdminData();
      } catch (e) {
        alert("公告保存失败");
      }
    }

    async function saveAdminKey() {
      var key = document.getElementById("admin-key").value.trim();
      var newKey = document.getElementById("new-admin-key-input").value.trim();
      if (!newKey) return alert("请输入新的管理密码");
      if (newKey.length < 4) return alert("管理密码至少需要4位字符");
      if (!confirm("确定要将管理密钥修改为 [" + newKey + "] 吗？修改后请务必牢记新密码！")) return;

      try {
        var res = await fetch("/api/admin/set_admin_key", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: key, new_key: newKey })
        });
        var json = await res.json();
        if (json.code === 0) {
          alert(json.msg || "密码修改成功！");
          document.getElementById("admin-key").value = newKey;
          localStorage.setItem("faka_admin_key", newKey);
          document.getElementById("new-admin-key-input").value = "";
          loadAdminData();
        } else {
          alert(json.msg || "修改失败");
        }
      } catch (e) {
        alert("修改失败");
      }
    }

    async function savePushPlusToken() {
      var key = document.getElementById("admin-key").value.trim();
      var token = document.getElementById("pushplus-token-input").value.trim();

      try {
        var res = await fetch("/api/admin/set_pushplus", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: key, token: token })
        });
        var json = await res.json();
        alert(json.msg || "Token 保存成功");
        loadAdminData();
      } catch(e) {
        alert("保存失败");
      }
    }

    async function testPushPlus() {
      var key = document.getElementById("admin-key").value.trim();
      var token = document.getElementById("pushplus-token-input").value.trim();
      if (!token) return alert("请先在输入框填入 PushPlus Token！");

      try {
        var res = await fetch("/api/admin/test_pushplus", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: key, token: token })
        });
        var json = await res.json();
        alert(json.msg || "请求完成");
        if (json.code === 0) {
          loadAdminData();
        }
      } catch(e) {
        alert("测试失败: " + e.message);
      }
    }

    async function clearExpiredOrders() {
      var key = document.getElementById("admin-key").value.trim();
      if (!confirm("确定要清理所有超过 24 小时未付款的无效废单吗？")) return;

      try {
        var res = await fetch("/api/admin/clear_expired", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: key })
        });
        var json = await res.json();
        alert(json.msg || "清理完成");
        loadAdminData();
      } catch(e) {
        alert("清理失败");
      }
    }

    async function savePayNote() {
      var key = document.getElementById("admin-key").value.trim();
      var note = document.getElementById("pay-note-setting-input").value.trim();
      try {
        var res = await fetch("/api/admin/upload_qrcode", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: key, pay_note: note })
        });
        var json = await res.json();
        alert(json.msg || "保存成功");
        loadAdminData();
      } catch(e) {
        alert("保存失败");
      }
    }

    async function uploadQrcode() {
      var fileInput = document.getElementById("qrcode-file-input");
      var urlInput = document.getElementById("qrcode-url-input");
      var key = document.getElementById("admin-key").value.trim();
      var urlVal = (urlInput ? urlInput.value : "").trim();

      if (urlVal && (!fileInput.files || fileInput.files.length === 0)) {
        var btn = document.getElementById("btn-upload-qr");
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 保存中...';
        try {
          var res = await fetch("/api/admin/upload_qrcode", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key: key, image_url: urlVal })
          });
          var json = await res.json();
          alert(json.msg || "保存成功");
          loadAdminData();
        } catch(e) {
          alert("保存失败");
        } finally {
          btn.disabled = false;
          btn.innerHTML = '<i class="fa-solid fa-cloud-arrow-up"></i> 保存收款码';
        }
        return;
      }

      if (!fileInput.files || fileInput.files.length === 0) return alert("请先选择一张图片或填入收款码图片链接");

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
      var selectVal = document.getElementById("import-region-select").value;
      var region = selectVal;
      if (selectVal === "__custom__") {
        region = document.getElementById("import-region-custom").value.trim();
        if (!region) return alert("请输入自定义品类名称");
      }

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

    var currentContactQr = "";

    async function uploadContactQrFile() {
      var fileInput = document.getElementById("contact-qr-file");
      var key = document.getElementById("admin-key").value.trim();
      if (!fileInput.files || fileInput.files.length === 0) return alert("请先选择客服二维码图片");

      var file = fileInput.files[0];
      var reader = new FileReader();
      reader.onload = function(e) {
        var img = new Image();
        img.onload = async function() {
          var canvas = document.createElement("canvas");
          var maxDim = 400;
          var w = img.width, h = img.height;
          if (w > maxDim || h > maxDim) {
            if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
            else { w = Math.round(w * maxDim / h); h = maxDim; }
          }
          canvas.width = w;
          canvas.height = h;
          var ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, w, h);
          currentContactQr = canvas.toDataURL("image/jpeg", 0.85);

          var cQrPrev = document.getElementById("contact-qr-preview");
          var noQrTxt = document.getElementById("no-contact-qr-text");
          if (cQrPrev) {
            cQrPrev.src = currentContactQr;
            cQrPrev.classList.remove("hidden");
          }
          if (noQrTxt) noQrTxt.classList.add("hidden");
          alert("二维码已就绪，请点击下方的【保存客服联系配置】生效！");
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    }

    async function saveContactInfo() {
      var key = document.getElementById("admin-key").value.trim();
      var wechat = (document.getElementById("contact-wechat-input") ? document.getElementById("contact-wechat-input").value.trim() : "");
      var tg = (document.getElementById("contact-tg-input") ? document.getElementById("contact-tg-input").value.trim() : "");
      var qq = (document.getElementById("contact-qq-input") ? document.getElementById("contact-qq-input").value.trim() : "");
      var tip = (document.getElementById("contact-tip-input") ? document.getElementById("contact-tip-input").value.trim() : "");
      var cQrPrev = document.getElementById("contact-qr-preview");
      var qrSrc = (cQrPrev && !cQrPrev.classList.contains("hidden")) ? cQrPrev.src : (currentContactQr || "");

      try {
        var res = await fetch("/api/admin/set_contact_info", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: key,
            contact_info: {
              wechat: wechat,
              telegram: tg,
              qq: qq,
              custom_tip: tip,
              wechat_qr: qrSrc
            }
          })
        });
        var json = await res.json();
        alert(json.msg || "客服配置保存成功");
        loadAdminData();
      } catch (e) {
        alert("保存失败");
      }
    }

    function renderCouponsTable(coupons) {
      var container = document.getElementById("coupon-list-container");
      if (!container) return;

      if (!coupons || coupons.length === 0) {
        container.innerHTML = '<div class="text-xs text-slate-500 text-center py-4 bg-slate-950/60 rounded-xl border border-slate-800">暂无已创建优惠券</div>';
        return;
      }

      var html = coupons.map(function(c) {
        var discountDesc = c.discount_type === 'percent' ? (c.discount_val + '% OFF (打 ' + ((100 - c.discount_val) / 10).toFixed(1) + ' 折)') : ('立减 ￥' + Number(c.discount_val).toFixed(2));
        var usesDesc = (c.max_uses === -1 || c.max_uses === null) ? (c.used_count + ' / 无限次') : (c.used_count + ' / ' + c.max_uses + ' 次');
        var minDesc = (c.min_amount && c.min_amount > 0) ? ('满 ￥' + c.min_amount) : '无门槛';
        var isExhausted = (c.max_uses > 0 && c.used_count >= c.max_uses);

        return '<div class="p-3 bg-slate-800/80 rounded-xl border border-slate-700 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2">' +
          '<div class="space-y-1">' +
            '<div class="flex items-center gap-2">' +
              '<span class="font-mono font-bold text-amber-300 text-sm px-2 py-0.5 bg-amber-500/10 rounded border border-amber-500/30">' + c.code + '</span>' +
              '<span class="font-bold text-emerald-400">' + discountDesc + '</span>' +
              (isExhausted ? '<span class="text-[10px] px-1.5 py-0.5 bg-rose-500/20 text-rose-300 rounded">已领完</span>' : '<span class="text-[10px] px-1.5 py-0.5 bg-emerald-500/20 text-emerald-300 rounded">生效中</span>') +
            '</div>' +
            '<div class="text-[11px] text-slate-400 flex items-center gap-3">' +
              '<span>门槛: <b class="text-slate-300">' + minDesc + '</b></span>' +
              '<span>已用: <b class="text-slate-300">' + usesDesc + '</b></span>' +
              '<span>创建: ' + (c.created_at || '') + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="flex items-center gap-2 self-end sm:self-center">' +
            '<button data-id="' + c.id + '" onclick="deleteAdminCoupon(this.dataset.id)" class="px-2.5 py-1 bg-rose-950/70 hover:bg-rose-900 text-rose-300 rounded text-xs border border-rose-800/80 transition flex items-center gap-1">' +
              '<i class="fa-solid fa-trash-can"></i> 删除' +
            '</button>' +
          '</div>' +
        '</div>';
      }).join("");

      container.innerHTML = html;
    }

    async function createAdminCoupon() {
      var key = document.getElementById("admin-key").value.trim();
      var code = (document.getElementById("new-coupon-code").value || "").trim().toUpperCase();
      var type = document.getElementById("new-coupon-type").value;
      var val = parseFloat(document.getElementById("new-coupon-val").value || 0);
      var min = parseFloat(document.getElementById("new-coupon-min").value || 0);
      var maxStr = document.getElementById("new-coupon-max").value.trim();
      var max = maxStr === "" ? -1 : parseInt(maxStr);

      if (!code) return alert("请输入优惠券代码（如 VIP888）");
      if (isNaN(val) || val <= 0) return alert("请输入有效的优惠面额");

      try {
        var res = await fetch("/api/admin/create_coupon", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: key,
            code: code,
            discount_type: type,
            discount_val: val,
            min_amount: min,
            max_uses: max
          })
        });
        var json = await res.json();
        alert(json.msg || "优惠券创建成功");
        if (json.code === 0) {
          document.getElementById("new-coupon-code").value = "";
          document.getElementById("new-coupon-val").value = "";
          document.getElementById("new-coupon-min").value = "";
          document.getElementById("new-coupon-max").value = "";
          loadAdminData();
        }
      } catch (e) {
        alert("创建失败");
      }
    }

    async function deleteAdminCoupon(id) {
      var key = document.getElementById("admin-key").value.trim();
      if (!confirm("确定要删除该优惠券吗？")) return;

      try {
        var res = await fetch("/api/admin/delete_coupon", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: key, id: id })
        });
        var json = await res.json();
        alert(json.msg || "优惠券已删除");
        loadAdminData();
      } catch (e) {
        alert("删除失败");
      }
    }

    function startAdminPolling() {
      if (adminPollTimer) clearInterval(adminPollTimer);
      adminPollTimer = setInterval(loadAdminData, 4000);
    }

    async function initAdminPage() {
      var urlParams = new URLSearchParams(window.location.search);
      var urlKey = urlParams.get("key");
      var savedKey = localStorage.getItem("faka_admin_key") || sessionStorage.getItem("faka_admin_key");
      var targetKey = urlKey || savedKey;

      if (targetKey) {
        var keyInput = document.getElementById("admin-key");
        if (keyInput) keyInput.value = targetKey;
        try {
          var res = await fetch("/api/admin/orders?key=" + encodeURIComponent(targetKey));
          var json = await res.json();
          if (json.code === 0) {
            localStorage.setItem("faka_admin_key", targetKey);
            document.getElementById("admin-login-modal").classList.add("hidden");
            loadAdminData();
            startAdminPolling();
            return;
          }
        } catch(e) {}
      }

      // 未登录或密码不正确，展示安全锁屏门禁
      document.getElementById("admin-login-modal").classList.remove("hidden");
    }

    initAdminPage();

    // 智能节流：离开页面/锁屏时自动停止请求，切回页面时立即刷新并恢复
    document.addEventListener("visibilitychange", function() {
      if (document.hidden) {
        if (adminPollTimer) clearInterval(adminPollTimer);
      } else {
        var key = document.getElementById("admin-key").value.trim();
        if (key) {
          loadAdminData();
          startAdminPolling();
        }
      }
    });
  </script>
</body>
</html>`;
}
