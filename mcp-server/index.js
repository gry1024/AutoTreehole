#!/usr/bin/env node
/**
 * AutoTreehole MCP Server（stdio 传输）
 *
 * 让 Claude Code / Cursor / Codex 等 AI 助手通过 MCP 协议查询树洞数据。
 * 从环境变量读取配置，不硬编码任何地址或密钥：
 *   AUTOTREEHOLE_URL   站点地址（如 http://118.178.145.162）
 *   AUTOTREEHOLE_TOKEN 用户的个人 API Token（ath_ 开头）
 *
 * 配置示例（粘贴到 Claude Code 的 MCP 设置）：
 * {
 *   "mcpServers": {
 *     "autothole": {
 *       "command": "npx",
 *       "args": ["-y", "autothole-mcp"],
 *       "env": {
 *         "AUTOTREEHOLE_URL": "<站点地址>",
 *         "AUTOTREEHOLE_TOKEN": "<你的 Token>"
 *       }
 *     }
 *   }
 * }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BASE_URL = (process.env.AUTOTREEHOLE_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.AUTOTREEHOLE_TOKEN || "";

if (!BASE_URL || !TOKEN) {
  console.error("[autothole-mcp] 缺少配置：请设置 AUTOTREEHOLE_URL 和 AUTOTREEHOLE_TOKEN 环境变量。");
  console.error("在 Claude Code 的 MCP 配置中 env 块内填写，详见 AutoTreehole 网站的 MCP 页面。");
  process.exit(1);
}

if (!TOKEN.startsWith("ath_")) {
  console.error("[autothole-mcp] AUTOTREEHOLE_TOKEN 格式错误，应以 ath_ 开头。");
  process.exit(1);
}

// ==================== 工具定义 ====================
const TOOLS = [
  {
    name: "get_latest_posts",
    description: "获取北大树洞最新发布的帖子列表。",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 30, default: 15, description: "返回数量（1-30，默认15）" },
      },
    },
  },
  {
    name: "get_hot_posts",
    description: "获取近期热帖（按收藏数降序排列）。",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "integer", minimum: 1, maximum: 14, default: 7, description: "回看天数（1-14，默认7）" },
        limit: { type: "integer", minimum: 1, maximum: 30, default: 15, description: "返回数量（1-30，默认15）" },
      },
    },
  },
  {
    name: "search_posts",
    description: "按关键词搜索树洞帖子。",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "搜索关键词（必填，最长80字）" },
        limit: { type: "integer", minimum: 1, maximum: 30, default: 15, description: "返回数量（1-30，默认15）" },
      },
      required: ["keyword"],
    },
  },
  {
    name: "get_post",
    description: "查看指定帖子的全文与评论。",
    inputSchema: {
      type: "object",
      properties: {
        pid: { type: "integer", description: "帖子 ID（纯数字）" },
      },
      required: ["pid"],
    },
  },
  {
    name: "get_weekly_reports",
    description: "列出所有树洞周报（每期含摘要与全文）。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_weekly_report",
    description: "查看指定一期周报的全文。",
    inputSchema: {
      type: "object",
      properties: {
        week_start: { type: "integer", description: "周报起始时间戳（秒），可从 get_weekly_reports 获取" },
      },
      required: ["week_start"],
    },
  },
  {
    name: "get_digest",
    description: "获取自某时间点以来的树洞动态摘要（热帖+新帖+周报），用于模拟对树洞的全局记忆。可传 since 参数指定起始点，不传则默认最近3天。",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "number", description: "起始点：≤365 视为天数（如 3 = 最近3天），>365 视为 Unix 时间戳（秒）" },
      },
    },
  },
];

// ==================== 请求封装 ====================
async function callApi(path) {
  const url = `${BASE_URL}/api/agent/${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      signal: controller.signal,
    });
    const json = await resp.json();
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// ==================== 工具调度 ====================
async function handleTool(name, args) {
  args = args || {};
  let path = "";
  switch (name) {
    case "get_latest_posts":
      path = `latest?limit=${args.limit ?? 15}`;
      break;
    case "get_hot_posts":
      path = `hot?days=${args.days ?? 7}&limit=${args.limit ?? 15}`;
      break;
    case "search_posts":
      path = `search?keyword=${encodeURIComponent(args.keyword || "")}&limit=${args.limit ?? 15}`;
      break;
    case "get_post":
      path = `post/${parseInt(args.pid, 10)}`;
      break;
    case "get_weekly_reports":
      path = "weekly";
      break;
    case "get_weekly_report":
      path = `weekly/${parseInt(args.week_start, 10)}`;
      break;
    case "get_digest":
      path = args.since != null ? `digest?since=${args.since}` : "digest";
      break;
    default:
      throw new Error(`未知工具: ${name}`);
  }
  const result = await callApi(path);
  if (!result.ok) {
    throw new Error(`[${result.error}] ${result.message || "请求失败"}`);
  }
  // 返回 data 字段（digest 接口本身就是 data 结构）
  return result.data || result;
}

// ==================== MCP Server ====================
const server = new Server(
  { name: "autothole-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const data = await handleTool(name, args);
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    };
  } catch (e) {
    return {
      isError: true,
      content: [{ type: "text", text: `工具调用失败: ${e.message}` }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[autothole-mcp] 已启动，连接到 " + BASE_URL);
