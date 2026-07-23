# autothole-mcp

> AutoTreehole MCP Server — 让 Claude Code / Cursor / Codex 等 AI 助手直接查询北大树洞

把北大树洞的数据接入你的 AI 编程助手。配置完成后，直接用自然语言提问即可，AI 会自动调用工具查询最新树洞、搜索关键词、阅读周报——你的智能体从此拥有对树洞的全局记忆。

## 快速开始

### 1. 获取 Token

前往 AutoTreehole 网站的 **MCP** 页面，用北大校园邮箱账号登录后生成一个 Token（`ath_` 开头）。

### 2. 配置 AI 客户端

将下方配置粘贴到你的 AI 客户端的 MCP 设置中（以 Claude Code 为例，配置文件通常在 `~/.claude/claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "autothole": {
      "command": "npx",
      "args": ["-y", "autothole-mcp"],
      "env": {
        "AUTOTREEHOLE_URL": "<站点地址>",
        "AUTOTREEHOLE_TOKEN": "<你的 Token>"
      }
    }
  }
}
```

### 3. 开始对话

```
你：最近有什么新鲜的树洞？
AI：（自动调用 get_latest_posts，返回最新帖子）
```

## 可用工具

| 工具 | 作用 | 参数 |
|------|------|------|
| `get_latest_posts` | 获取最新发布的树洞 | `limit`（1-30） |
| `get_hot_posts` | 获取近期热帖（按收藏排序） | `days`（1-14）、`limit` |
| `search_posts` | 按关键词搜索 | `keyword`（必填）、`limit` |
| `get_post` | 查看帖子全文与评论 | `pid` |
| `get_weekly_reports` | 列出所有树洞周报 | — |
| `get_weekly_report` | 查看指定一期周报全文 | `week_start` |
| `get_digest` | 获取自某时间点以来的动态摘要（全局记忆） | `since`（天数或时间戳） |

## 环境变量

| 变量 | 说明 |
|------|------|
| `AUTOTREEHOLE_URL` | AutoTreehole 站点地址（如 `http://118.178.145.162`） |
| `AUTOTREEHOLE_TOKEN` | 你的个人 API Token（`ath_` 开头） |

## 限制

- 仅限北大校园邮箱认证用户使用（邀请码用户不可用）
- 每 Token 每分钟 20 次、每天 500 次请求
- 所有接口均为只读

## 许可证

MIT
