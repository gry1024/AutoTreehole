# AutoTreehole 技术文档

本文档记录 AutoTreehole 的设计逻辑与实现细节，供学习与复现参考。

---

## 一、系统架构

### 整体拓扑

```
                    用户浏览器
                        │
                        ▼  HTTP
                 ┌──────────────┐
                 │   静态托管    │  index.html / admin.html
                 └──────┬───────┘
                        │  /api/  反代
                        ▼
                 ┌──────────────┐
                 │  Node.js API │  better-sqlite3
                 │  (index.js)  │  nodemailer
                 └──────┬───────┘
                        │
                        ▼
                 ┌──────────────┐
                 │   SQLite DB  │  treehole.db
                 └──────▲───────┘
                        │
                 ┌──────┴───────┐
                 │ Python 爬虫  │  requests，长驻进程
                 │ (crawler.py) │
                 └──────┬───────┘
                        │
                        ▼
              https://treehole.pku.edu.cn/api/
```

三个模块通过 SQLite 文件解耦：爬虫只写库，API 只读库（用户系统部分可写），前端只调 API。任一模块可独立替换。

### 模块职责

| 模块 | 语言 | 职责 |
|------|------|------|
| `crawler.py` | Python | 7×24 增量采集帖子 + 评论，LLM 自动分类 |
| `index.js` | Node.js | 查询/搜索/详情/AI 报告/认证/数据上报 |
| `index.html` | 原生 JS | 单文件前端应用 |
| `admin.html` | 原生 JS | 数据后台（统计/用户/邀请码管理） |

---

## 二、爬虫模块（`crawler.py`）

### 认证机制

树洞强制 CAS + 短信验证，无法自动登录。爬虫使用浏览器登录后获取的两个凭证直连 API：

- `PKU_TOKEN`：JWT 令牌（Cookies 中的 `pku_token`），有效期约 30 天
- `PKU_UUID`：浏览器标识（请求头 `uuid`）

两者从 `.env` 读取。令牌临近过期时，API 的 `/api/status` 会返回剩余天数，前端据此给出视觉提示。

### 数据采集策略

爬虫采用三层采集策略，兼顾实时性与数据完整性：

#### 1. 增量发现（`discover_new`）

- 以数据库 `MAX(pid)` 为高水位线
- 每轮请求最新一页（25 条），筛选 `pid > 水位` 的新帖
- 新帖按 pid 升序逐条入库，每条休眠 5 秒（速率控制）
- 无新帖时休眠 60 秒后重试
- 单轮最多翻 20 页（500 条），防止突发更新失控

#### 2. 浅度回刷（`refresh_recent_posts`）

- 每 5 轮触发一次
- 翻 10 页（~250 条），更新已入库帖子的收藏量 / 评论数
- 评论数增长的帖子自动补抓新评论
- 翻页间隔 3 秒

#### 3. 每日全量回刷（`daily_refresh`）

- 每天凌晨 3:00 触发
- 翻 200 页（~5000 条），更新元数据 + 补抓新评论
- 同时扫描最近 7 天帖子是否被平台删除（`scan_deleted_posts`）
- 翻页间隔 3 秒

### 速率控制参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `SLEEP_PER_ITEM` | 5 秒 | 每条新帖入库后休眠 |
| `COMMENT_SLEEP` | 2 秒 | 评论分页请求间隔 |
| `ROUND_SLEEP` | 60 秒 | 无新帖时休眠 |
| `REFRESH_SLEEP` | 3 秒 | 回刷翻页间隔 |
| `ACTIVE_HOURS` | (0, 24) | 允许爬取时段 |

### LLM 自动分类

爬虫在入库时调用 MiniMax 对帖子正文分类（学习/情感/生活/时事/娱乐/求助/其他）：

- 截取正文前 500 字送入 LLM，超时 8 秒
- LLM 不可用时降级为关键词匹配兜底
- 分类失败的帖子进入重试队列，每 10 轮重试一次
- 分类结果写入 `holes.category` 字段，供趋势图与后台统计使用

---

## 三、后端 API（`index.js`）

### 运行环境

- Node.js + better-sqlite3（原生模块，直读 SQLite 文件）
- 数据库以 WAL 模式打开，支持并发读写
- 通过 `dotenv` 从 `.env` 加载所有密钥

### 接口列表

#### 数据查询

| 路由 | 方法 | 说明 |
|------|------|------|
| `/api/stats` | GET | 统计数据 + 话题分布 |
| `/api/hot` | GET | 热帖列表（近 N 天，收藏 ≥ 阈值） |
| `/api/search` | GET | 关键词模糊搜索 |
| `/api/show` | GET | 帖子详情 + 评论树 |
| `/api/weekPosts` | GET | 近 7 天每日帖子数 |
| `/api/trend` | GET | 话题趋势（每日分类占比） |
| `/api/keywordPosts` | GET | 关键词聚合帖子 |
| `/api/image` | GET | 图片代理（需树洞鉴权） |
| `/api/providers` | GET | LLM 服务列表 |
| `/api/status` | GET | 服务状态 + 令牌剩余天数 |

#### AI 报告

| 路由 | 方法 | 说明 |
|------|------|------|
| `/api/report` | POST | 服务器侧生成报告 |
| `/api/report/prepare` | POST | 直连模式：取 prompt |
| `/api/report/enrich` | POST | 直连模式：后处理（链接化 + 附录） |

#### 认证与访问控制

| 路由 | 方法 | 说明 |
|------|------|------|
| `/api/auth/sendCode` | POST | 发送邮箱验证码 |
| `/api/auth/verify` | POST | 验证码校验，签发令牌（HttpOnly Cookie） |
| `/api/auth/check` | GET | 校验登录态 + 是否已承诺 |
| `/api/auth/pledge` | POST | 记录"不传播本站"承诺 |
| `/api/auth/invite` | POST | 邀请码登录 |

#### 站长信箱

| 路由 | 方法 | 说明 |
|------|------|------|
| `/api/message` | POST | 已登录用户留言（转发站长邮箱） |
| `/api/public/message` | POST | 未登录访客留言（严格限流） |

#### 数据上报

| 路由 | 方法 | 说明 |
|------|------|------|
| `/api/track/view` | POST | 帖子浏览记录 |
| `/api/track/duration` | POST | 停留时长 |
| `/api/track/heartbeat` | POST | 心跳（每 60 秒） |

#### 数据后台

| 路由 | 方法 | 说明 |
|------|------|------|
| `/api/admin/stats` | GET | 全量统计（需管理密码） |
| `/api/admin/invite/list` | GET | 邀请码列表 |
| `/api/admin/invite/create` | POST | 生成邀请码（自定义/随机/批量） |
| `/api/admin/invite/delete` | POST | 删除未使用的邀请码 |

### 频率限制（多重防护）

| 层级 | 限制 |
|------|------|
| 单 IP 普通接口 | 30 次/分钟 |
| 单 IP 报告接口 | 2 次/分钟 + 15 次/天 |
| 全局报告接口 | 10 次/分钟 + 200 次/天 |
| 单 IP 留言（未登录） | 2 次/小时 + 3 次/天 |
| 全局留言（未登录） | 10 次/小时 |
| 邮箱验证 | 60 秒重发间隔 + 5 次/天/IP |

频率计数器定期清理，避免内存泄漏。

### 图片代理

树洞图片需要鉴权才能访问。后端代理 `/api/image?pid=X&idx=N`：

1. 用服务器持有的 `PKU_TOKEN` 请求树洞图片接口
2. 流式 pipe 返回图片，设置 24 小时缓存
3. 前端 `<img src="/api/image?pid=X&idx=N">` 直接渲染

### LLM 调用三种模式

```
模式 1：Public（服务器提供默认模型）
浏览器 → /api/report → 服务器用 env Key 调 LLM → 返回报告

模式 2：直连（用户自带 Key，Key 不离开浏览器）
浏览器 → /api/report/prepare → 获取 prompt
浏览器 → 直接调 LLM API（Key 仅存浏览器内存）
浏览器 → /api/report/enrich → 服务器做链接化 + 附录

模式 3：服务器代理（用户自带 Key，经服务器转发）
浏览器 → /api/report（带 customConfig）→ 服务器用用户 Key 调 LLM → 返回报告
```

模式 3 的 `customConfig.url` 必须通过 `assertSafeUrl()` 校验，禁止指向内网/本地/元数据地址（防 SSRF）。

### 认证与令牌

- 邮箱验证通过后，签发 HMAC-SHA256 签名令牌（格式 `email.timestamp.signature`）
- 令牌通过 HttpOnly Cookie 传递，有效期 30 天
- 邀请码登录后注册 `invite:CODE` 形式的用户标识，复用同一套令牌机制
- 新用户首次进入主页前须确认"不传播本站"承诺（`pledged` 字段记录）

### 邮件服务

- 使用 QQ 邮箱 SMTP 发送验证码 + 转发留言
- 验证码 6 位，5 分钟有效，最多 5 次尝试
- 留言转发到站长邮箱（地址存于 `SITE_OWNER_EMAIL`，绝不暴露给前端）
- 访客留言邮件中携带来源标记（如"获取邀请码"）与 IP，便于审计

---

## 四、前端（`index.html`）

单文件应用，无构建步骤，静态托管即可。

### 技术栈

- 原生 HTML/CSS/JS（无框架）
- Marked.js + DOMPurify（Markdown 渲染 + XSS 防护）
- Google Fonts: Noto Serif SC（思源宋体）

### 设计规范

遵循 Apple 官网现代极简风格：

| 设计令牌 | 值 |
|----------|-----|
| 背景色 | `#F5F5F7` |
| 正文色 | `#1D1D1F` |
| 次要文字 | `#6E6E73` / `#86868B` |
| 分割线 | `#E8E8ED` |
| 字体 | Noto Serif SC |
| 圆角 | 4–6px |
| 阴影 | 极淡或无 |

去除卡片背景/边框/阴影，用细横线与留白分割模块，组件垂直间距 48–80px 增强呼吸感。

### 面板结构

前端共 5 个面板，通过顶部导航切换：

#### 1. 概览（`panel-overview`）

聚合展示社区全景，60 秒自动刷新，也可手动刷新。自上而下由四个子模块组成：

| 子模块 | 数据来源 | 设计逻辑 |
|--------|----------|----------|
| **统计卡片** | `/api/stats` | 5 项指标通栏排列：帖子总数 / 近 7 天新帖 / 平均收藏 / 平均评论 / 数据跨度。桌面端自适应列数，移动端 3+2 紧凑布局，避免单列浪费纵向空间 |
| **话题分布环形图** | `/api/stats` 返回的 `categories` | 内嵌于统计区下方的 SVG 环形图（donut），展示近 7 天帖子按 7 个分类（学习/情感/生活/时事/娱乐/求助/其他）的占比；圆心显示近 7 天帖子总数，右侧图例标注各类百分比。环形图尺寸经过紧凑化处理，与统计卡片形成视觉连贯 |
| **最新热点** | `/api/hot?days=1&min_like=10` | 近 24 小时内收藏量 ≥ 10 的帖子，按收藏降序。用于捕捉当天正在发酵的热点，让用户第一时间看到最新高热内容 |
| **近 7 天热点** | `/api/hot?days=7&min_like=10` | 近 7 天内收藏量 ≥ 10 的帖子，按收藏降序。呈现一周内的持续高热内容 |

两个热点板块采用相同卡片样式（`bubble-card`），并发请求（`Promise.allSettled`），任一失败不影响另一板块渲染。卡片整块可点击跳转详情页。

> 设计意图：双板块拆分让用户能区分"即时热点"与"周内热点"——前者反映此刻正在发生什么，后者反映近期持续被关注的议题。

#### 2. 热帖（`panel-hot`）

支持两种检索模式，通过顶部切换：
- **默认筛选**：按天数 + 数量获取高收藏帖子
- **关键词匹配**：输入关键词模糊搜索正文（支持拼音缩写联想，如 `xk` → 信科）

#### 3. AI 报告（`panel-report`）

两种报告模式 × 三种 LLM 调用方式：
- **报告模式**：全周分析 / 关键词专题
- **调用方式**：Public（服务器提供）/ 直连（用户 Key 不离开浏览器）/ 代理（用户 Key 经服务器转发）

报告内洞号 `#pid` 可点击跳转详情。

#### 4. 详情（`panel-detail`）

单帖完整视图：正文 + 图片 + 评论树。

#### 5. 关于（`panel-about`）

站点理念 + 站长信箱（留言转发）。

### 评论区特性

- 发言无缩进，被引用内容缩进 20px + 浅灰背景
- 评论者头像按 name 哈希分配 8 种浅色
- 洞主（Alice）独立配色 + "洞主"标记
- `quote` 字段 JSON 解析（提取被引用评论的纯文本）
- Markdown 渲染失败时降级为 `esc()` 纯文本，防 XSS

### 访问控制流程

```
未登录 → 验证入口（邮箱验证码 / 邀请码）
              │
              ▼
        承诺窗口（首次）
              │
              ▼
          主页（开始数据上报）
```

---

## 五、数据库结构

### `holes` 表（帖子）

| 字段 | 类型 | 说明 |
|------|------|------|
| pid | INTEGER PK | 帖子 ID |
| text | TEXT | 正文 |
| timestamp | INTEGER | 发帖时间戳 |
| likenum | INTEGER | 收藏量 |
| reply | INTEGER | 评论数 |
| type | TEXT | 类型（text/image） |
| tag | TEXT | 标签 |
| image_size | TEXT | 图片尺寸 JSON `[w,h,...]` |
| category | TEXT | LLM 分类 |
| deleted | INTEGER | 是否已被平台删除（0/1） |
| created_at | TEXT | 入库时间 |
| updated_at | TEXT | 最后更新时间 |

### `comments` 表（评论）

| 字段 | 类型 | 说明 |
|------|------|------|
| cid | INTEGER PK | 评论 ID |
| pid | INTEGER | 所属帖子 ID |
| text | TEXT | 评论正文 |
| timestamp | INTEGER | 评论时间戳 |
| name | TEXT | 匿名名（Alice/Bob/...） |
| comment_id | INTEGER | 回复目标评论 ID |
| quote | TEXT | 被引用评论（JSON 字符串） |

### 用户与统计表

| 表 | 说明 |
|------|------|
| `users` | 注册用户（邮箱 / 邀请码），含访问统计与 `pledged` 标记 |
| `verify_codes` | 邮箱验证码（带过期与尝试次数） |
| `post_views` | 帖子浏览记录 |
| `visit_logs` | 访问日志 |
| `invite_codes` | 邀请码（码 / 备注 / 使用状态 / 使用者） |

---

## 六、安全措施

### 密钥保护

- 所有 Key / 凭证 / 密码存于 `.env`，不纳入版本控制
- `/api/providers` 接口不返回 key 字段
- 非 public provider 调用时强制校验 customConfig
- `assertSafeUrl()` 阻止 LLM 请求指向内网/本地/元数据地址

### 输入与输出安全

- SQL 全部参数化，防注入
- 关键词长度限制 80 字符，limit 上限 100，防止 SQL DoS
- 请求体大小限制 1MB
- Markdown 渲染强制 DOMPurify 过滤，失败降级为纯文本
- 邮件主题去除控制字符，防邮件头注入

### 频率限制

- 普通接口：30 次/分钟/IP
- 报告接口：2 次/分钟 + 15 次/天/IP，全局 10 次/分钟 + 200 次/天
- 留言接口：三层限流（IP 小时级 / IP 日级 / 全局小时级）
- 邮箱验证：60 秒重发 + 10 次/天/IP

### 审计

- 报告调用记录 IP + provider + 模式 + 成败（不含 Key）
- 访客留言邮件携带 IP，便于追溯

### 访问控制

- 网站仅限 `@pku.edu.cn` / `@stu.pku.edu.cn` 邮箱验证访问
- 邀请码供非校园用户使用，一次性、可追踪
- 数据后台（admin.html）独立密码保护，不对普通用户开放
