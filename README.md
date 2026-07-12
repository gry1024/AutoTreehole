<div align="center">

<img width="72" height="72" src="assets/logo.svg" alt="AutoTreehole"/>

# AutoTreehole

**不再错过每一条有价值的树洞**

</div>

---

## 理念

树洞是校园最真实的回响，但许多有价值的讨论转瞬即逝。AutoTreehole 希望把这些散落的声音留存下来，让你不必成天刷着树洞也不会错过有用的信息，也让校园里那些值得被听见的声音，能够被听见得更久一点。

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

### 1. 克隆与配置

```bash
git clone https://github.com/gry1024/AutoTreehole.git
cd AutoTreehole
cp .env.example .env
# 编辑 .env，填入你自己的凭证（见下方说明）
```

### 2. 启动爬虫

```bash
pip install requests
python crawler.py
```

### 3. 启动后端

```bash
cd functions/treehole-api
npm install
node index.js   # 默认监听 :9000
```

### 4. 启动前端

```bash
npx http-server frontend -p 8080
# 浏览器访问 http://localhost:8080
```

本地调试时，可将 `frontend/index.html` 中的 `API_BASE` 改为 `http://localhost:9000/api`。

### 关于树洞凭证

树洞强制 CAS + 短信验证，无法自动登录。爬虫依赖浏览器登录后获取的两个凭证（约 30 天有效期）：

| 变量 | 获取方式 |
|------|----------|
| `PKU_TOKEN` | 登录树洞 → F12 → Application → Cookies → `pku_token` |
| `PKU_UUID`  | F12 → Network → 任一请求头 → `uuid` |

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

本项目代码仅供学习交流使用。请勿将本系统用于采集并在公共平台传播他人的匿名发言。
