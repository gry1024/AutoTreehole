<div align="center">

<img width="72" height="72" src="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48' fill='none'><ellipse cx='24' cy='20' rx='11' ry='12' fill='%23C8A9A9'/><ellipse cx='15' cy='10' rx='4' ry='6' fill='%23B89898' transform='rotate(-20 15 10)'/><ellipse cx='33' cy='10' rx='4' ry='6' fill='%23B89898' transform='rotate(20 33 10)'/><ellipse cx='15' cy='11' rx='2' ry='3.5' fill='%23D8B8B8' transform='rotate(-20 15 11)'/><ellipse cx='33' cy='11' rx='2' ry='3.5' fill='%23D8B8B8' transform='rotate(20 33 11)'/><circle cx='20' cy='18' r='1.8' fill='%231D1D1F'/><circle cx='28' cy='18' r='1.8' fill='%231D1D1F'/><circle cx='20.5' cy='17.5' r='0.6' fill='%23fff'/><circle cx='28.5' cy='17.5' r='0.6' fill='%23fff'/><ellipse cx='24' cy='24' rx='2.2' ry='1.5' fill='%231D1D1F'/><path d='M22 26.5 Q24 28 26 26.5' stroke='%231D1D1F' stroke-width='1.2' fill='none' stroke-linecap='round'/><circle cx='16' cy='23' r='2' fill='%23E8C8C8' opacity='0.6'/><circle cx='32' cy='23' r='2' fill='%23E8C8C8' opacity='0.6'/><ellipse cx='24' cy='40' rx='14' ry='10' fill='%23C8A9A9'/><ellipse cx='16' cy='42' rx='3' ry='4' fill='%23B89898'/><ellipse cx='32' cy='42' rx='3' ry='4' fill='%23B89898'/></svg>" alt="AutoTreehole"/>

# AutoTreehole

**不再错过每一条有价值的树洞**

北京大学树洞（匿名论坛）数据采集、分析与可视化平台

</div>

---

## 理念

北大树洞是校园里最真实的回响，但它的信息流瞬息万变，许多有价值的讨论转瞬即逝。

AutoTreehole 希望把这些散落的声音留存下来——7×24 小时持续采集，让每一条有价值的树洞都不再被错过。

> 为北大师生服务，让校园里那些值得被听见的声音，能够被听见得更久一点。

🌐 **在线体验**：请自行部署后访问（见下方「快速开始」）

---

## 这是什么

一个完整的数据采集与分析系统，由三个模块组成：

- **爬虫**（`crawler.py`）— 7×24 小时增量采集树洞帖子与评论，落库 SQLite
- **后端 API**（`functions/treehole-api/index.js`）— 读取数据库，提供查询、搜索、AI 报告接口
- **前端**（`frontend/index.html`）— 单文件应用，Apple 极简风格的可视化界面

### 功能一览

| 模块 | 说明 |
|------|------|
| **数据概览** | 帖子/评论总数、近 7 天新增、话题趋势折线图，60 秒自动刷新 |
| **热帖速览** | 近 7 天高收藏帖子，点击卡片直达详情 |
| **关键词搜索** | 模糊匹配正文，定位特定话题 |
| **帖子详情** | 完整正文、图片、评论树（洞主标记、引用缩进、头像配色） |
| **AI 分析报告** | 全周分析或关键词专题，支持 7 家大模型服务商 |

---

## 快速开始（本地复现）

### 1. 准备环境

```bash
git clone https://github.com/gry1024/AutoTreehole.git
cd AutoTreehole
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，填入你的 PKU_TOKEN / PKU_UUID 等（见下方说明）
```

### 3. 启动爬虫（采集数据）

```bash
pip install requests
python crawler.py
```

爬虫会持续运行，增量采集帖子与评论到 `treehole.db`。

### 4. 启动后端 API

```bash
cd functions/treehole-api
npm install
node index.js
# API 默认监听 http://localhost:9000
```

### 5. 启动前端

用任意静态服务器托管 `frontend/` 目录，并将 `/api/` 反代到 `:9000`。最简方式：

```bash
# 在仓库根目录
npx http-server frontend -p 8080
# 然后浏览器访问 http://localhost:8080
```

> 本地调试时，如需让前端命中后端，可将 `frontend/index.html` 中的 `API_BASE` 临时改为 `http://localhost:9000/api`。

### 关于树洞凭证

树洞强制 CAS + 短信验证，无法自动登录。爬虫与图片代理依赖浏览器登录后获取的两个凭证（约 30 天有效期）：

| 变量 | 获取方式 |
|------|----------|
| `PKU_TOKEN` | 登录树洞后，F12 → Application → Cookies → `pku_token` |
| `PKU_UUID`  | F12 → Network → 任一请求头 → `uuid` |

填入 `.env` 即可。凭证过期后重新获取替换。

---

## 技术架构

```
用户浏览器
    │
    ▼
前端 (index.html) ── 静态托管
    │
    ▼  /api/
Node.js API (index.js) ── better-sqlite3 读写
    │
    ▼
SQLite (treehole.db)
    ▲
    │
Python 爬虫 (crawler.py) ── 7×24 增量采集
    │
    ▼
北大树洞 API
```

**技术栈**：Python + requests / Node.js + better-sqlite3 + nodemailer / 原生 HTML·CSS·JS + Marked.js + DOMPurify

> 详细的设计逻辑、数据流、接口契约、安全措施见 [TECH.md](./TECH.md)。

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
├── .env.example                  # 环境变量模板
└── TECH.md                       # 技术文档
```

---

## 安全设计

本仓库仅提供用于学习与复现的代码，所有密钥均通过环境变量注入，不写入仓库：

- 🔑 所有 API Key / 凭证 / 密码存于 `.env`（已被 `.gitignore` 忽略）
- 🛡️ SQL 全部参数化，防注入；Markdown 渲染强制 XSS 过滤
- ⏱️ 多层频率限制（普通接口 / 报告接口 / 留言接口分别限流）
- 🔒 LLM 直连模式下，用户的 API Key 仅存于浏览器内存，不经过服务器
- 📧 留言转发三层限流（IP 小时级 / IP 日级 / 全局小时级），防邮箱轰炸

---

## 许可

本项目代码仅供学习交流使用。请勿将本系统用于采集并在公共平台传播他人的匿名发言。
