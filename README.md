# CF-Auto-Faka ⚡ 智能自动抓取发卡系统

基于 **Cloudflare Workers + D1 分布式数据库** 构建的 0 成本、免服务器自动化发卡网。

## ✨ 特性

- 🚀 **0 成本免服务器**：完全运行在 Cloudflare 免费边缘网络上，高防 DDoS，全球秒开。
- 🔄 **自动定时抓取同步**：内置 Cron Trigger 定时任务，每小时自动从目标站抓取账号密码入库，无需人工补货。
- 🌍 **多地区分类管理**：支持美区、港区、日区、台区等分类筛选与发卡。
- 📦 **自动去重与随机发卡**：数据库级去重保证，下单自动随机提取有效卡密。
- 🔍 **订单自助查询**：支持买家输入订单号或邮箱随时提取历史卡密。
- 🛠️ **一键手动同步 API**：提供管理员密钥接口，随时一键手动刷新库存。

---

## 🚀 部署教程（GitHub ➔ Cloudflare）

### 第一步：推送到你的 GitHub 仓库

1. 在 [GitHub](https://github.com/new) 新建一个公开或私有仓库，例如 `cf-auto-faka`。
2. 在本地 `cf-faka` 目录下运行：
   ```bash
   git init
   git add .
   git commit -m "feat: init cf-auto-faka system"
   git branch -M main
   git remote add origin https://github.com/你的用户名/你的仓库名.git
   git push -u origin main
   ```

---

### 第二步：在 Cloudflare 创建 D1 数据库

1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/)。
2. 点击左侧菜单 **Storage & Databases** ➔ **D1 SQL Database** ➔ **Create Database**。
3. 数据库名称填写：`faka-db`，点击创建。
4. 创建成功后，复制页面上的 **Database ID**（形如 `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`）。
5. 点击进入该数据库的 **Console** 标签页，将 `schema.sql` 里的建表 SQL 粘贴进去执行一次，初始化数据表。

---

### 第三步：在 Cloudflare 中关联 GitHub 自动部署

#### 方式 A：通过 Cloudflare Workers 控制台部署（推荐最简单）
1. 在 Cloudflare 控制台左侧点击 **Compute (Workers)** ➔ **Create Application** ➔ **Worker**。
2. 名称填写 `cf-auto-faka`，点击保存。
3. 进入该 Worker 的 **Settings** 页面：
   - **Bindings (绑定)**：点击 **Add** ➔ 选择 **D1 Database**：
     - Variable name（变量名）填写：`DB`
     - D1 Database 选择你刚才创建的 `faka-db`。
   - **Triggers (触发器)**：在 **Cron Triggers** 中点击 **Add Cron Trigger**：
     - 填写 `0 * * * *`（表示每整点自动抓取同步一次）。
4. 在 **Build & Deploy** 中连接你的 GitHub 仓库，即可实现每次提交自动更新部署！

---

### 第四步：管理员常用操作

- **立即手动同步一次库存**：
  访问你的 Worker 域名：`https://你的worker域名.workers.dev/api/admin/sync?key=admin123456`
- **修改管理员秘钥**：
  在 `wrangler.toml` 或 CF 控制台环境变量中修改 `ADMIN_KEY`。
