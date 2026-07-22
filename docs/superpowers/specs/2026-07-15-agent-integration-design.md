# AutoTreehole Agent 接入功能设计文档

> 日期：2026-07-15
> 状态：已确认，待实现

## 背景与目标

AutoTreehole 当前是一个"人看网页"的站点。本项目要让它变得更 AI Native——让用户能对着自己的 Claude Code / Codex 等 AI 编程助手提问（如"最近有什么新鲜的树洞"），AI 即可自动查询树洞并回答。

核心价值：让用户的智能体拥有对树洞的**全局实时记忆**，无需手动刷网页、粘贴内容。

### 约束（已与用户确认）

- **面向对象**：仅 PKU 校园邮箱认证用户可用，**邀请码用户不开放**（与现有"邀请码用户不具备订阅推送资格"规则一致）
- **能力范围**：只读查询，无写操作
- **接入形式**：方案 A — 本地 stdio MCP Server（服务端只加 REST 接口，MCP 包是本地薄封装）

---

## 第 1 节：整体架构与组件

```
用户 Claude Code / Codex（本地）
        │  MCP (stdio)
        ▼
autothole-mcp（本地 Node 进程，npx 运行，读 Token 与站点 URL）
        │  HTTPS REST + Authorization: Bearer <token>
        ▼
Nginx :80  ──反代──▶  Node API (127.0.0.1:9000)  /api/agent/*
                              │
                              ▼  复用现有查询函数
                        SQLite (treehole.db)
```

### 三个新增组件

1. **后端 Agent REST 接口**（`functions/treehole-api/index.js` 内新增 `/api/agent/*` 路由组）
   - 只读，Bearer Token 鉴权，复用现有 `querySearch / queryHot / queryShow` 等函数
   - 独立限流桶（按 token），复用 `alertAdmin` 告警体系

2. **前端"MCP"页面**（`frontend/index.html`，导航栏新增 tab）
   - 完整详细的小白友好配置指南 + 使用示例
   - 集成 Token 管理面板（生成 / 一次性查看明文 / 撤销）
   - 仅 PKU 用户可操作 Token；邀请码用户显示提示

3. **MCP 包**（仓库新增 `mcp-server/` 目录，单文件，可 `npx` 运行）
   - 从环境变量读 `AUTOTREEHOLE_TOKEN` 和 `AUTOTREEHOLE_URL`，不硬编码 IP
   - 把 MCP 工具调用翻译成对 `/api/agent/*` 的 REST 请求

### 数据流示例

用户问 Claude Code "最近有什么新鲜的树洞" → Claude 决定调 `get_latest_posts` → 本地 MCP 进程带 Token 请求 `/api/agent/latest` → Node 验 Token + 限流 + 查库返回 → MCP 回传 → Claude 汇总给用户。

---

## 第 2 节：后端 Agent REST 接口

### 2.1 接口列表（全部只读，`/api/agent/*` 前缀）

| 路径 | 工具名 | 入参 | 返回 | 复用 |
|------|--------|------|------|------|
| `GET /latest` | `get_latest_posts` | `limit`(1-30,默认15) | 最新帖子列表（pid/时间/分类/正文前140字/收藏/评论数） | 改造自 `querySearch` 取最新 |
| `GET /hot` | `get_hot_posts` | `days`(1-14,默认7) `limit`(1-30,默认15) | 热帖列表（同上字段+排序依据） | `queryHot` |
| `GET /search` | `search_posts` | `keyword`(必填,≤80字) `limit`(1-30,默认15) | 搜索结果列表 | `querySearch` |
| `GET /post/:pid` | `get_post` | `pid` | 帖子详情（正文全文/时间/分类/收藏/评论数）+ 评论数组 | `queryShow` |
| `GET /weekly` | `get_weekly_reports` | 无 | 周报列表（期号/标题/时间/摘要前200字/内容全文） | `handleWeeklyReport` |
| `GET /weekly/:id` | `get_weekly_report` | `id` | 单期周报全文 | `handleWeeklyReport` |
| `GET /digest` | `get_digest` | `since`(时间戳或天数,可选) | 增量摘要：自该时间点以来的热帖+新帖+已生成周报 | 组合查询，模拟"记忆" |

### 2.2 设计要点

- 所有列表接口字段精简（正文截断 140 字，评论数不展开评论），控制返回体积省 Agent token；`get_post` 才返回全文+评论
- `get_digest` 是"全局记忆"的核心：Agent 传上次查询的时间水位线，服务端返回"自那以后变了什么"，单次调用即可补全认知，而非让 Agent 逐个工具轮询

### 2.3 返回格式

统一 JSON 信封：

```json
{ "ok": true, "data": { ... }, "server_time": 1784654321 }
```

错误时：

```json
{ "ok": false, "error": "rate_limited", "message": "请求过于频繁，请稍后再试" }
```

### 2.4 与前端现有接口的关系

Agent 接口与前端 `/api/hot`、`/api/search` 等**完全独立**，不共享路由。原因：

- 鉴权方式不同（Bearer Token vs Cookie + pledged 校验）
- 返回字段精简度不同（Agent 要省 token，前端要完整渲染）
- 限流桶不同（按 token 计量，与 IP 限流隔离）

但底层复用同一批查询函数（`queryHot / querySearch / queryShow` 等），保证数据一致性。

---

## 第 3 节：鉴权与安全

### 3.1 Token 格式

`ath_<22位随机>`（前缀 `ath_` 标识来源，便于日志识别；22 位 base64url 随机 ≈ 131 bit 熵，不可爆破）

### 3.2 存储：新建 `agent_tokens` 表

```sql
CREATE TABLE agent_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email TEXT NOT NULL,          -- 关联 users 表
  token_hash TEXT NOT NULL UNIQUE,   -- 存 SHA-256 hash，不存明文
  label TEXT DEFAULT '',             -- 用户自命名，如 "我的Claude Code"
  last_used_at INTEGER DEFAULT 0,    -- 最近调用时间
  call_count INTEGER DEFAULT 0,      -- 累计调用次数
  created_at INTEGER NOT NULL,
  revoked_at INTEGER DEFAULT 0,      -- 撤销时间戳，0=有效
  FOREIGN KEY (user_email) REFERENCES users(email)
);
CREATE INDEX idx_agent_tokens_hash ON agent_tokens(token_hash);
```

**关键决策**：只存 hash 不存明文 → 创建时一次性展示明文，之后无法再查看。泄露后只能撤销重建。

### 3.3 资格校验（邀请码用户拦截）

在 Token 生成和每次调用时都校验：

```javascript
function canUseAgent(user_email) {
  // 邀请码用户邮箱形如 'invite:XXXXXX'，不开放 Agent 功能
  if (user_email.startsWith('invite:')) return false;
  return true;
}
```

前端隐藏入口 + 后端二次拦截。

### 3.4 Bearer Token 鉴权流程

```
请求: GET /api/agent/latest
     Authorization: Bearer ath_xxxxxxxxxxxxxxxxxxxxxx

  1. 提取 token → SHA-256 → 查 agent_tokens 表
  2. 未找到 / 已撤销 → 401 { ok:false, error:"invalid_token" }
  3. user_email 以 'invite:' 开头 → 403 { ok:false, error:"forbidden" }
  4. 异步更新 last_used_at + call_count（不阻塞响应）
  5. 进入限流检查 → 限流桶按 token_hash 计量
  6. 通过 → 执行查询返回
```

### 3.5 限流（独立桶，按 token）

| 维度 | 限制 | 说明 |
|------|------|------|
| 每 token 每分钟 | 20 次 | Agent 正常对话远低于此 |
| 每 token 每天 | 500 次 | 防失控 Agent 无限轮询 |
| 全局每分钟 | 60 次 | 保护小机器，防多用户同时高频 |

超限返回 `429 { ok:false, error:"rate_limited" }`，触发 `alertAdmin('warn', 'rate_limit', ...)`（复用现有告警体系，10 分钟节流）。

### 3.6 安全清单（复用现有措施）

- Token 只存 hash，明文仅创建时一次可见
- 邀请码用户前后端双拦截
- SQL 全参数化（复用现有 better-sqlite3 prepare）
- 输入剥控制字符（复用现有 `.replace(/[\x00-\x1f\x7f]/g,"")`）
- 限流入库 + 告警邮件通知站长
- Node 监听仍 `127.0.0.1:9000`，Agent 流量经 Nginx:80 反代，不暴露 9000
- 返回的帖子正文经 `esc()` 处理（Agent 消费纯文本）
- Token 在本地 MCP 配置中，从不经过我们的服务器存储

---

## 第 4 节：前端"MCP"页面

### 4.1 页面位置

导航栏新增 tab"MCP"，与首页/热帖/周报并列。这是独立的配置与使用指南页面，不放在"关于"页。

### 4.2 页面内容（自上而下，小白友好）

**区块 1：简介**
- 标题："让 AI 帮你刷树洞"
- 一句话说明：AutoTreehole 支持把树洞数据接入 Claude Code、Codex 等 AI 编程助手，你只需对 AI 说一句话，它就能自动帮你查询最新树洞、搜索、看周报。

**区块 2：准备工作**
- 需要一个 MCP 客户端（Claude Code / Cursor / Codex 等）
- 需要是 PKU 校园邮箱认证用户（邀请码用户不可用）

**区块 3：第一步 · 生成你的 Token**
- Token 管理面板（生成 / 列表 / 撤销）
- 每账号最多 3 个 Token
- 生成后明文一次性展示

**区块 4：第二步 · 配置你的 AI 助手**
- 完整的配置片段（Token 自动填入）
- 图文步骤说明（安装、粘贴配置、重启客户端）

**区块 5：第三步 · 开始使用**
- 示例对话：
  - "最近有什么新鲜的树洞？" → 调用 `get_latest_posts`
  - "帮我搜一下考试相关的帖子" → 调用 `search_posts`
  - "上周树洞有什么大事？" → 调用 `get_weekly_reports`
  - "看看 #12345 这个帖子说了什么" → 调用 `get_post`
  - "我上次问完之后又有什么新帖？" → 调用 `get_digest`
- 每个示例标注会调用哪个工具

**区块 6：可用工具说明**
- 7 个工具的表格说明（工具名 / 作用 / 参数）

**区块 7：常见问题 FAQ**
- Token 丢了怎么办（撤销重建）
- 提示频率限制怎么办（稍等重试）
- 支持哪些 AI 客户端（任何支持 MCP 的客户端）

### 4.3 Token 管理面板（集成在此页）

**新建 Token 流程**：
1. 点"新建"→ 输入标签名（≤20字）→ 提交
2. 弹窗一次性展示明文 Token + 可一键复制的 Claude Code 配置片段：

```json
{
  "mcpServers": {
    "autothole": {
      "command": "npx",
      "args": ["-y", "autothole-mcp"],
      "env": {
        "AUTOTREEHOLE_URL": "<站点地址>",
        "AUTOTREEHOLE_TOKEN": "ath_xxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

3. 提示"明文仅此一次展示，请立即复制保存；遗失只能撤销重建"
4. 关闭弹窗后列表刷新

**Token 列表**：标签 / 创建时间 / 最近使用 / 调用次数 / 撤销按钮

**撤销**：二次确认 → 立即失效（设 `revoked_at`）

### 4.4 访问控制

- MCP 页面需登录可见（与首页等一致）
- 配置指南内容（区块 1/2/4/5/6/7）对所有登录用户可见
- Token 管理面板（区块 3）：PKU 用户可操作；邀请码用户显示"此功能仅校园邮箱用户可用"

### 4.5 后端管理接口（`/api/agent/token/*`，Cookie 鉴权）

| 路径 | 方法 | 作用 |
|------|------|------|
| `/api/agent/token/list` | GET | 列出当前用户的所有有效 Token（不含明文，含统计） |
| `/api/agent/token/create` | POST | 创建新 Token，返回明文一次；校验每账号≤3个 + 非邀请码 |
| `/api/agent/token/revoke` | POST | 撤销指定 id 的 Token |

### 4.6 设计原则

- 不硬编码服务器地址到前端：配置片段中的 `AUTOTREEHOLE_URL` 取自 `PUBLIC_BASE_URL` 环境变量，通过 `/api/agent/token/create` 响应返回给前端拼接
- 明文不入库不入日志：创建时生成明文 → hash 入库 → 明文随响应返回一次 → 服务器不留存
- UI 风格：沿用 Apple 极简（`#F5F5F7` 背景、细横线分隔、微圆角、无卡片阴影），与站点现有视觉一致

---

## 第 5 节：MCP Server 包

### 5.1 包结构

```
mcp-server/
├── index.js          # 单文件 MCP Server（stdio 传输）
├── package.json      # bin: { "autothole-mcp": "index.js" }
└── README.md         # 简要说明（npx 用法 + 配置示例）
```

### 5.2 运行方式

用户无需全局安装，`npx -y autothole-mcp` 即可（若发布到 npm）。不发布也完全可用——配置片段中 `args` 改为指向仓库内文件路径即可：

```json
// 方式A：npx（发布到 npm 后）
"args": ["-y", "autothole-mcp"]

// 方式B：直接用仓库文件（不发布也可用）
"args": ["/path/to/AutoTreehole/mcp-server/index.js"]
```

**决策**：先不发布 npm，配置片段默认给方式 A（`npx`），若用户 clone 仓库也可用方式 B。后续想发布随时可发。

### 5.3 配置读取

从环境变量读，不硬编码任何 IP/Token：

```javascript
const BASE_URL = (process.env.AUTOTREEHOLE_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.AUTOTREEHOLE_TOKEN || "";
// 缺失则 stderr 提示并退出，不启动
```

### 5.4 暴露的 MCP 工具（对应第 2 节接口）

| MCP 工具名 | 对应接口 | 描述（给 AI 看，决定 AI 何时调用） |
|------------|----------|------|
| `get_latest_posts` | `/api/agent/latest` | 获取树洞最新发布的帖子 |
| `get_hot_posts` | `/api/agent/hot` | 获取近期热帖（按收藏数排序） |
| `search_posts` | `/api/agent/search` | 按关键词搜索树洞帖子 |
| `get_post` | `/api/agent/post/:pid` | 查看指定帖子的全文与评论 |
| `get_weekly_reports` | `/api/agent/weekly` | 列出所有树洞周报 |
| `get_weekly_report` | `/api/agent/weekly/:id` | 查看指定一期周报全文 |
| `get_digest` | `/api/agent/digest` | 获取自某时间点以来的树洞动态摘要（模拟全局记忆） |

每个工具的 `inputSchema` 用 JSON Schema 声明参数（类型/范围/必填），AI 据此自动决定如何调用。

### 5.5 返回处理

- 后端返回精简 JSON → MCP Server 原样透传，不做二次加工
- 错误统一处理：`ok:false` 时把 `error` + `message` 作为工具错误返回给 AI，AI 据此调整策略（如限流后等待重试）

### 5.6 依赖

- `@modelcontextprotocol/sdk`（官方 SDK，轻量）
- Node ≥ 18（与服务器一致）
- 零其他依赖

### 5.7 安全

- Token 只从环境变量读，不落盘、不日志输出
- 请求带 `Authorization: Bearer <token>`，不放 URL query（避免日志泄露）
- 仅发起 HTTPS/HTTP 出站请求到 `AUTOTREEHOLE_URL`，不做任何本地文件/命令操作

---

## 第 6 节：错误处理、测试与文档

### 6.1 错误处理

**后端 Agent 接口错误码**（统一 JSON 信封）：

| HTTP | error 字段 | 触发场景 | 处理 |
|------|-----------|----------|------|
| 401 | `invalid_token` | Token 不存在/已撤销 | AI 应提示用户检查 Token |
| 403 | `forbidden` | 邀请码用户尝试调用 | 同上 |
| 429 | `rate_limited` | 超限流 | AI 应等待后重试，触发告警邮件 |
| 400 | `bad_request` | 参数缺失/越界（如 limit>30） | AI 应修正参数重试 |
| 500 | `server_error` | 查询异常 | 入库 alert_logs + 告警邮件 |

**MCP Server 侧**：收到 `ok:false` 时，把 `message` 作为 MCP 工具错误返回（不抛异常中断会话）。网络超时（10s）同样作为工具错误返回。

**Token 管理接口错误**（Cookie 鉴权，复用现有 sendError）：
- 非登录 → 401
- 邀请码用户 → 403
- 超过 3 个 Token → 400 `"每个账号最多 3 个 Token"`
- 标签超长 → 400 `"标签最多 20 字"`

### 6.2 测试策略

不引入测试框架，用手动验证清单（部署后逐项确认）：

**后端接口**（curl 带 Token）：
- [ ] 无 Token → 401 `invalid_token`
- [ ] 错 Token → 401
- [ ] 邀请码用户 Token → 403
- [ ] `/latest`、`/hot`、`/search`、`/post/:pid`、`/weekly`、`/weekly/:id`、`/digest` 各返回有效数据
- [ ] `limit=0` / `limit=100` → 400
- [ ] 高频请求触发 429 + 告警邮件到达站长邮箱
- [ ] 撤销 Token 后立即 401

**前端 MCP 页面**：
- [ ] 导航栏出现"MCP"tab
- [ ] PKU 用户可见 Token 管理面板；邀请码用户显示提示
- [ ] 新建 Token → 明文展示一次 + 配置片段可复制
- [ ] 再次刷新页面明文不再可见
- [ ] 撤销 → 列表移除 + 该 Token 调用立即 401
- [ ] 配置指南、使用示例、FAQ 内容完整显示

**MCP 端到端**：
- [ ] 配置片段粘贴进 Claude Code → 连接成功
- [ ] 问"最近有什么新鲜的树洞" → AI 调 `get_latest_posts` 返回结果
- [ ] 问"帮我搜一下考试相关" → 调 `search_posts`
- [ ] 问"上周树洞有什么大事" → 调 `get_weekly_reports`
- [ ] 多轮对话后问"刚才那些帖子之后还有什么新的" → 调 `get_digest` 带水位线

### 6.3 文档更新

| 文件 | 改动 |
|------|------|
| `README.md` | "功能"区加"Agent 接入：PKU 用户可在 MCP 页生成 Token，让 Claude Code 直接查询树洞" |
| `TECH.md` | 新增"Agent 接口"小节：接口列表、Token 机制、MCP 包位置 |
| `AGENT.md` | 新增"十四、Agent 接入功能"：`agent_tokens` 表结构、限流参数、运维命令（查 Token / 查调用统计） |
| `.env.example` | 加注释说明 `PUBLIC_BASE_URL` 也用于 Agent 配置片段 |
| `mcp-server/README.md` | npx 用法 + 配置示例 + 工具列表 |

### 6.4 新手引导更新

现有 6 步 spotlight 新手引导中，增加一步介绍 MCP 页面（或在某步中提及），引导用户发现 Agent 接入功能。引导完成状态仍存 localStorage。

### 6.5 实现顺序

1. 后端 `agent_tokens` 表 + Token CRUD 接口（Cookie 鉴权）
2. 后端 `/api/agent/*` 只读接口 + Bearer 鉴权 + 限流
3. 前端导航栏"MCP"页面 + Token 管理面板 + 配置指南
4. 新手引导更新
5. `mcp-server/index.js` MCP 包
6. 文档更新（README / TECH.md / AGENT.md / .env.example）
7. 部署 + 手动验证清单

---

## 安全注意事项（实现时遵循）

- 本文档不含服务器 IP、密钥等敏感信息，可安全提交 GitHub
- 实现时 `AUTOTREEHOLE_URL` 在前端配置片段中取自 `PUBLIC_BASE_URL`，不硬编码
- `agent_tokens` 表只存 hash，明文不入库不入日志
- Agent 接口经 Nginx:80 反代到 127.0.0.1:9000，不暴露 9000 端口
- 复用现有 `assertSafeUrl` / SQL 参数化 / 输入过滤 / `alertAdmin` 等安全措施
