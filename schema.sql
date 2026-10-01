-- Cloudflare D1 数据库初始化表结构

-- 1. 卡密库存表
CREATE TABLE IF NOT EXISTS carmis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  region TEXT NOT NULL,          -- 地区，如：美国、香港、日本、台湾、通用
  account TEXT NOT NULL,         -- 账号（邮箱）
  password TEXT NOT NULL,        -- 密码
  carmi TEXT UNIQUE NOT NULL,    -- 完整卡密字符串
  status INTEGER DEFAULT 0,      -- 状态: 0=未售, 1=已售
  order_no TEXT DEFAULT NULL,    -- 绑定的订单号
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  sold_at DATETIME DEFAULT NULL
);

-- 索引提升查询速度
CREATE INDEX IF NOT EXISTS idx_carmis_region_status ON carmis(region, status);
CREATE INDEX IF NOT EXISTS idx_carmis_carmi ON carmis(carmi);

-- 2. 订单记录表
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT UNIQUE NOT NULL, -- 唯一订单号
  region TEXT NOT NULL,          -- 购买地区
  contact TEXT,                  -- 客户联系方式（邮箱/手机）
  price REAL DEFAULT 0.00,       -- 订单金额
  status INTEGER DEFAULT 0,      -- 状态: 0=待支付, 1=已完成/已发卡
  carmi TEXT DEFAULT NULL,       -- 发放的卡密
  pay_type TEXT DEFAULT 'free',  -- 支付方式: epay/alipay/wxpay/free
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  paid_at DATETIME DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_order_no ON orders(order_no);
CREATE INDEX IF NOT EXISTS idx_orders_contact ON orders(contact);
