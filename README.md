<div align="center">

<img width="72" height="72" src="assets/logo.svg" alt="AutoTreehole"/>

# AutoTreehole

**不再错过每一条有价值的树洞**

</div>

---

## 理念

本项目服务于北大师生。树洞是校园最真实的回响，但许多有价值的讨论转瞬即逝。AutoTreehole 希望把这些散落的声音留存下来，让你不必成天刷着树洞也不会错过有用的信息，也让校园里那些值得被听见的声音，能够被听见得更久一点。

---

## 板块

| 板块 | 功能 |
|------|------|
| **数据概览** | 帖子总数、近 7 天新增、平均收藏与评论，配话题分布环形图 |
| **最新热点** | 近 24 小时内收藏 ≥ 10 的帖子 |
| **近 7 天热点** | 一周内收藏 ≥ 10 的帖子 |
| **热帖** | 按天数/数量筛选高收藏帖子，或用关键词模糊搜索正文 |
| **AI 报告** | 调用大模型生成结构化分析报告（全周综述 / 关键词专题），报告内洞号可点击跳转 |
| **详情** | 查看单帖完整正文、图片与评论树，支持楼层引用缩进与洞主标记 |
| **我的收藏** | 收藏感兴趣的帖子，跨设备同步（绑定账户而非浏览器） |
| **订阅推送** | 订阅关心的关键词（如 xk / 羽毛球场 / llm），爬虫发现新匹配帖时自动邮件提醒（仅校园邮箱用户） |
| **关于** | 了解站点理念，或通过站长信箱留言 |

> 概览页每 60 秒自动刷新数据，也可手动点击刷新按钮。

---

## 技术栈

| 层 | 技术 |
|----|------|
| 爬虫 | Python + requests，增量采集，SQLite 落库 |
| 后端 | Node.js + better-sqlite3 + nodemailer |
| 前端 | 原生 HTML/CSS/JS（无框架），Marked.js + DOMPurify |
| 设计 | Apple 极简风格，Noto Serif SC 字体 |

> 完整的设计逻辑、接口契约、数据架构、安全措施见 [TECH.md](./TECH.md)。

---

## 本地复现

本仓库仅提供用于学习与复现的代码，不含任何运行中的数据或凭证。

### 方式一：交给 Coding Agent 重建（最简单）

> 把本仓库地址丢给你的 AI 编程助手（如 Trae / Cursor / Claude Code），说一句：
>
> **"Clone https://github.com/gry1024/AutoTreehole ，阅读 README.md 与 TECH.md，在本机从零把这个网站跑起来。"**
>
> Agent 会自动完成下方"方式二"的全部步骤：装依赖、配 `.env`、起后端、起爬虫、起前端，并在浏览器里打开页面。你只需按它提示填入树洞凭证与邮箱配置即可。

### 方式二：手动逐步运行

#### 环境准备

| 工具 | 版本要求 | 用途 |
|------|----------|------|
| Node.js | ≥ 18 | 后端 API |
| Python | ≥ 3.8 | 爬虫 |
| Git | 任意 | 克隆仓库 |

#### 1. 克隆仓库并配置环境变量

```bash
git clone https://github.com/gry1024/AutoTreehole.git
cd AutoTreehole
cp .env.example .env
```

编辑 `.env`，至少填入以下几项（其余可按需补）：

```ini
# 树洞登录凭证（获取方式见下方"关于树洞凭证"）
PKU_TOKEN=你的_pku_token
PKU_UUID=你的_uuid

# 用户登录令牌签名密钥（随意一串长随机字符，务必修改）
TOKEN_SECRET=随便改成一串随机字符串

# 数据后台密码（admin.html 登录用）
ADMIN_PASSWORD=改成你自己的密码

# 邮件服务（QQ 邮箱 SMTP，用于邮箱验证码与留言转发）
MAIL_USER=你的@qq.com
MAIL_PASS=你的SMTP授权码

# 站长收件邮箱（用户留言会转发到这里）
SITE_OWNER_EMAIL=你的邮箱

# 站点地址（订阅邮件内链接用，本地可留空）
PUBLIC_BASE_URL=

# 可选：服务器默认 LLM Key（不填则 AI 报告的 Public 模式不可用，直连/代理模式仍可用）
MINIMAX_API_KEY=
```

> **`.env` 已被 `.gitignore` 忽略，永远不会被提交，请放心填入真实凭证。**

#### 2. 启动后端 API

```bash
cd functions/treehole-api
npm install
node index.js
```

看到 `[treehole-api] 服务启动，监听 127.0.0.1:9000` 即成功。后端会自动创建 `treehole.db` 与所需数据表。

#### 3. 启动爬虫（采集数据）

新开一个终端：

```bash
pip install requests
python crawler.py
```

爬虫会以 `MAX(pid)` 为高水位线增量采集帖子与评论，写入 `treehole.db`。首次运行约几秒后开始有数据，之后 7×24 持续运行。

> 没有树洞凭证也能启动后端与前端，只是数据库为空；凭证填好后爬虫才会写入真实数据。

#### 4. 启动前端

前端是纯静态文件，任意静态服务器即可。新开一个终端：

```bash
npx http-server frontend -p 8080
```

浏览器打开 `http://localhost:8080` 即可访问。

#### 5. 本地调试的接口对接说明

前端默认 `API_BASE = location.origin + '/api'`，即与页面同源。本地分端口运行时（前端 8080、后端 9000）有两种对接方式：

**A. 仅浏览数据（无需登录功能）**

把 `frontend/index.html` 里的：

```javascript
const API_BASE = location.origin + '/api';
```

改为：

```javascript
const API_BASE = 'http://localhost:9000/api';
```

查询、搜索、详情、AI 报告等接口即可正常调用（后端已开 CORS）。

**B. 完整功能（含邮箱登录、收藏、订阅，需同源 Cookie）**

登录令牌通过 HttpOnly Cookie 传递，需前后端同源。本地推荐用 Nginx 反代（与生产环境一致）：

```nginx
server {
    listen 8080;
    root /path/to/AutoTreehole/frontend;   # 改成你的 frontend 绝对路径
    location / { try_files $uri /index.html; }
    location /api/ { proxy_pass http://127.0.0.1:9000; }
}
```

这样 `http://localhost:8080` 同时托管前端与代理后端，Cookie 同源，全部功能可用。

### 关于树洞凭证

树洞强制 CAS + 短信验证，无法自动登录。爬虫使用浏览器登录后获取的两个凭证直连 API（约 30 天有效期）：

| 变量 | 获取方式 |
|------|----------|
| `PKU_TOKEN` | 登录 `treehole.pku.edu.cn` → F12 → Application → Cookies → `pku_token` |
| `PKU_UUID`  | F12 → Network → 任一请求 → Request Headers → `uuid` |

填入 `.env` 即可，过期后重新获取。

---

## 项目结构

```
AutoTreehole/
├── crawler.py                    # 爬虫：增量采集帖子 + 评论
├── analyzer.py                   # 命令行报告生成工具（独立）
├── functions/
│   └── treehole-api/
│       ├── index.js              # 后端 API
│       └── package.json
├── frontend/
│   ├── index.html                # 前端单文件应用
│   └── admin.html                # 数据后台（独立）
├── assets/
│   └── logo.svg                  # 袋鼠 logo
├── .env.example                  # 环境变量模板
└── TECH.md                       # 技术文档
```

---

## 安全设计

- 所有 API Key / 凭证 / 密码存于 `.env`（已被 `.gitignore` 忽略）
- SQL 全部参数化；Markdown 渲染强制 XSS 过滤，失败降级纯文本
- 多层频率限制（普通接口 / 报告接口 / 留言接口分别限流）
- LLM 直连模式下，用户的 API Key 仅存于浏览器内存，不经过服务器
- LLM 自定义 URL 需通过 SSRF 校验，禁止指向内网/本地/元数据地址

---

## 许可

本项目代码仅供学习交流使用。请勿将本系统用于采集并在公共平台传播他人的匿名发言。有任何意见可在网页中的“关于”栏目下方向我留言。
