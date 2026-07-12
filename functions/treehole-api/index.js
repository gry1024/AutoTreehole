/**
 * AutoTreehole 分析 API — HTTP 服务
 *
 * 功能：直接读取本地 treehole.db，提供帖子查询、搜索、详情、统计、AI报告接口。
 * 安全：CORS、请求频率限制、输入校验、SQL 参数化、Markdown XSS 防护。
 * 数据库：better-sqlite3（原生模块，直读本地 SQLite 文件）。
 */

require("dotenv").config();

const http = require("http");
const https = require("https");
const url = require("url");
const fs = require("fs");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

// ==================== 配置 ====================
const DB_PATH = process.env.TREEHOLE_DB_PATH || "./treehole.db";
const PORT = process.env.PORT || 9000;
// 树洞 API Token（用于图片代理）
const PKU_TOKEN = process.env.PKU_TOKEN || "";
const PKU_UUID = process.env.PKU_UUID || "";
const PKU_API_BASE = "https://treehole.pku.edu.cn/api/";

// 邮箱验证配置（全部从环境变量读取，详见 .env.example）
const MAIL_USER = process.env.MAIL_USER || "";
const MAIL_PASS = process.env.MAIL_PASS || "";
const MAIL_FROM = `"AutoTreehole" <${MAIL_USER}>`;
const ALLOWED_EMAIL_DOMAINS = ["pku.edu.cn", "stu.pku.edu.cn"];
const TOKEN_SECRET = process.env.TOKEN_SECRET || "";
const TOKEN_MAX_AGE = 30 * 24 * 3600; // 令牌有效期 30 天（秒）
const CODE_TTL = 5 * 60;              // 验证码 5 分钟有效
const CODE_RESEND_INTERVAL = 60;       // 同一邮箱 60 秒才能重发
const CODE_MAX_ATTEMPTS = 5;           // 验证码最多尝试 5 次
const VERIFY_IP_DAILY_LIMIT = 10;      // 每 IP 每天最多 10 次验证请求

// 数据后台密码
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

// 站长邮箱（接收用户留言，绝不暴露给前端）
const SITE_OWNER_EMAIL = process.env.SITE_OWNER_EMAIL || "";
// 留言频率限制（防邮箱轰炸）
const MESSAGE_IP_HOURLY_LIMIT = 2;   // 每 IP 每小时最多 2 条
const MESSAGE_IP_DAILY_LIMIT = 3;    // 每 IP 每天最多 3 条
const MESSAGE_GLOBAL_HOURLY_LIMIT = 10; // 全局每小时最多 10 条

// 频率限制：每 IP 每分钟最多 30 次普通请求、2 次报告请求
const RATE_LIMIT_NORMAL = 30;
const RATE_LIMIT_REPORT = 2;
const RATE_WINDOW_MS = 60_000;
// 全局报告频率：所有用户合计每分钟最多 10 次、每天最多 200 次（防止分布式滥用 MiniMax Key）
const GLOBAL_REPORT_LIMIT_PER_MIN = 10;
const GLOBAL_REPORT_LIMIT_PER_DAY = 200;
// 每 IP 每天最多 15 次报告
const IP_DAILY_REPORT_LIMIT = 15;
const DAY_MS = 86_400_000;

// 输入限制
const MAX_KEYWORD_LEN = 80;
const MAX_LIMIT = 100;
const MAX_DAYS = 90;
const MAX_POSTS_FOR_LLM = 200;
const MIN_USEFUL_LEN = 4;

// LLM 服务配置（MiniMax 为服务器提供的默认服务，其余需网友自行提供 Key）
const LLM_PROVIDERS = {
  deepseek:  { key: "DEEPSEEK_API_KEY",  url: "https://api.deepseek.com/chat/completions",                           model: "deepseek-v4-flash", fmt: "openai", public: false,
    models: ["deepseek-v4-pro", "deepseek-v4-flash"] },
  minimax:   { key: "MINIMAX_API_KEY",   url: "https://api.minimax.chat/v1/text/chatcompletion_v2",                 model: "MiniMax-M3",       fmt: "openai", public: true,
    models: ["MiniMax-M3"] },
  openai:    { key: "OPENAI_API_KEY",    url: "https://api.openai.com/v1/chat/completions",                        model: "gpt-5.4-mini",     fmt: "openai", public: false,
    models: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"] },
  anthropic: { key: "ANTHROPIC_API_KEY", url: "https://api.anthropic.com/v1/messages",                             model: "claude-sonnet-5",  fmt: "anthropic", public: false,
    models: ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"] },
  kimi:      { key: "MOONSHOT_API_KEY",  url: "https://api.moonshot.cn/v1/chat/completions",                       model: "kimi-k2.5",        fmt: "openai", public: false,
    models: ["kimi-k2.5", "kimi-k2-0905-preview", "kimi-k2-turbo-preview"] },
  qwen:      { key: "DASHSCOPE_API_KEY", url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", model: "qwen3.6-plus",     fmt: "openai", public: false,
    models: ["qwen3.6-max-preview", "qwen3.6-plus", "qwen3.6-flash"] },
  glm:       { key: "GLM_API_KEY",       url: "https://open.bigmodel.cn/api/paas/v4/chat/completions",              model: "glm-4.6",          fmt: "openai", public: false,
    models: ["glm-4.6", "glm-4.5", "glm-4.5-flash"] },
};

// ==================== 频率限制 ====================
const rateBuckets = new Map();
// 全局报告计数（分钟级 + 日级）
let globalReportMin = [];
let globalReportDay = [];
// 留言计数：按 IP（小时级 + 日级）+ 全局小时级
const messageIpHourly = new Map(); // ip -> [timestamps]
const messageIpDaily = new Map();  // ip -> [timestamps]
let messageGlobalHourly = [];

function messageRateCheck(ip) {
  const now = Date.now();
  const HOUR = 3600_000;
  const DAY = 86_400_000;
  // IP 小时级
  let h = messageIpHourly.get(ip) || [];
  h = h.filter(t => now - t < HOUR);
  if (h.length >= MESSAGE_IP_HOURLY_LIMIT) return false;
  // IP 日级
  let d = messageIpDaily.get(ip) || [];
  d = d.filter(t => now - t < DAY);
  if (d.length >= MESSAGE_IP_DAILY_LIMIT) return false;
  // 全局小时级
  messageGlobalHourly = messageGlobalHourly.filter(t => now - t < HOUR);
  if (messageGlobalHourly.length >= MESSAGE_GLOBAL_HOURLY_LIMIT) return false;
  // 通过，记录
  h.push(now); d.push(now); messageGlobalHourly.push(now);
  messageIpHourly.set(ip, h);
  messageIpDaily.set(ip, d);
  return true;
}

// 定时清理过期计数
setInterval(() => {
  const now = Date.now();
  const HOUR = 3600_000;
  const DAY = 86_400_000;
  for (const [ip, arr] of messageIpHourly) {
    if (arr.every(t => now - t >= HOUR)) messageIpHourly.delete(ip);
  }
  for (const [ip, arr] of messageIpDaily) {
    if (arr.every(t => now - t >= DAY)) messageIpDaily.delete(ip);
  }
}, 3600_000);

function rateLimit(ip, isReport) {
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket) { bucket = { normal: [], report: [], reportDay: [] }; rateBuckets.set(ip, bucket); }
  // 普通请求：每 IP 每分钟 N 次
  if (!isReport) {
    bucket.normal = bucket.normal.filter((t) => now - t < RATE_WINDOW_MS);
    if (bucket.normal.length >= RATE_LIMIT_NORMAL) return false;
    bucket.normal.push(now);
    return true;
  }
  // 报告请求：多重限制
  // 1) 每 IP 每分钟
  bucket.report = bucket.report.filter((t) => now - t < RATE_WINDOW_MS);
  if (bucket.report.length >= RATE_LIMIT_REPORT) return false;
  // 2) 每 IP 每天
  bucket.reportDay = bucket.reportDay.filter((t) => now - t < DAY_MS);
  if (bucket.reportDay.length >= IP_DAILY_REPORT_LIMIT) return false;
  // 3) 全局每分钟
  globalReportMin = globalReportMin.filter((t) => now - t < RATE_WINDOW_MS);
  if (globalReportMin.length >= GLOBAL_REPORT_LIMIT_PER_MIN) return false;
  // 4) 全局每天
  globalReportDay = globalReportDay.filter((t) => now - t < DAY_MS);
  if (globalReportDay.length >= GLOBAL_REPORT_LIMIT_PER_DAY) return false;
  // 全部通过，记录
  bucket.report.push(now);
  bucket.reportDay.push(now);
  globalReportMin.push(now);
  globalReportDay.push(now);
  return true;
}

// 报告调用日志（审计用，只记录元信息，不含 Key）
function logReportCall(ip, provider, mode, success, errMsg) {
  const ts = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  console.log(`[report] ${ts} ip=${ip} provider=${provider} mode=${mode} ${success ? "OK" : "FAIL:" + (errMsg || "")}`);
  // 入库（异步，失败不影响主流程）
  try {
    if (db) {
      db.prepare(
        "INSERT INTO report_logs (ip, provider, mode, success, err_msg, created_at) VALUES (?,?,?,?,?,?)"
      ).run(ip || "", provider || "", mode || "", success ? 1 : 0, errMsg || "", Math.floor(Date.now() / 1000));
    }
  } catch (e) { /* 入库失败忽略 */ }
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of rateBuckets) {
    const normalEmpty = b.normal.every((t) => now - t >= RATE_WINDOW_MS);
    const reportEmpty = b.report.every((t) => now - t >= RATE_WINDOW_MS);
    const dayEmpty = (!b.reportDay || b.reportDay.every((t) => now - t >= DAY_MS));
    if (normalEmpty && reportEmpty && dayEmpty) {
      rateBuckets.delete(ip);
    }
  }
}, RATE_WINDOW_MS);

// ==================== 工具函数 ====================

/** 解析 JWT 的 exp 字段（不验签），返回剩余天数；失败返回 null */
function tokenDaysLeft(token) {
  if (!token) return null;
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
    if (!payload.exp) return null;
    return (payload.exp - Date.now() / 1000) / 86400;
  } catch {
    return null;
  }
}

function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  return fwd ? fwd.split(",")[0].trim() : (req.socket.remoteAddress || "unknown");
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  });
  res.end(body);
}

function sendError(res, status, message) { sendJson(res, status, { error: message }); }

function fmtTime(ts) {
  if (!ts) return "未知时间";
  return new Date(ts * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}

function isUseful(text) {
  const s = (text || "").trim();
  if (s.length < MIN_USEFUL_LEN) return false;
  let alpha = 0;
  for (const c of s) { if (/[a-zA-Z\u4e00-\u9fff]/.test(c)) { alpha++; if (alpha >= 2) return true; } }
  return false;
}

function validateInt(val, min, max, def) {
  const n = parseInt(val, 10);
  if (isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}

/** 安全校验：禁止 LLM 请求指向内网/本地/元数据地址（防 SSRF） */
function assertSafeUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw new Error("API URL 格式无效"); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("API URL 协议无效（仅允许 http/https）");
  }
  const host = parsed.hostname.toLowerCase();
  // 禁止本地/内网/链路本地/元数据地址
  if (host === "localhost" || host === "::1" || host === "0.0.0.0") {
    throw new Error("不允许指向本地地址");
  }
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) {
    throw new Error("不允许指向内网地址");
  }
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    throw new Error("不允许指向内网地址");
  }
  if (/^169\.254\./.test(host)) {
    throw new Error("不允许指向链路本地地址");
  }
  if (/^::ffff:/i.test(host)) {
    // IPv4-mapped IPv6，提取 IPv4 部分再查
    const v4 = host.slice(7);
    if (/^127\./.test(v4) || /^10\./.test(v4) || /^192\.168\./.test(v4) || /^169\.254\./.test(v4)) {
      throw new Error("不允许指向内网地址");
    }
  }
}

// ==================== 数据库（better-sqlite3 直读本地文件） ====================
let Database = null;
let db = null;

function ensureDb() {
  if (db) return db;
  Database = require("better-sqlite3");
  db = new Database(DB_PATH, { readonly: false, fileMustExist: true });
  // 开启 WAL 模式，支持并发读写
  db.pragma("journal_mode = WAL");
  // 创建用户认证与数据统计相关表
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      email         TEXT UNIQUE NOT NULL,
      verified_at   INTEGER NOT NULL,
      last_visit    INTEGER,
      visit_count   INTEGER DEFAULT 0,
      total_duration INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS verify_codes (
      email     TEXT PRIMARY KEY,
      code      TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      sent_at   INTEGER NOT NULL,
      attempts  INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS post_views (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      pid        INTEGER NOT NULL,
      user_email TEXT,
      user_ip    TEXT,
      viewed_at  INTEGER NOT NULL,
      duration   INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS visit_logs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_email  TEXT,
      ip          TEXT,
      entered_at  INTEGER NOT NULL,
      last_active INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_post_views_pid ON post_views(pid);
    CREATE INDEX IF NOT EXISTS idx_post_views_viewed_at ON post_views(viewed_at);
    CREATE INDEX IF NOT EXISTS idx_users_verified_at ON users(verified_at);
    CREATE INDEX IF NOT EXISTS idx_visit_logs_entered_at ON visit_logs(entered_at);
    CREATE TABLE IF NOT EXISTS invite_codes (
      code        TEXT PRIMARY KEY,
      note        TEXT,
      created_at  INTEGER NOT NULL,
      used_at     INTEGER,
      used_by     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_invite_codes_used ON invite_codes(used_at);
    CREATE TABLE IF NOT EXISTS report_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ip         TEXT,
      provider   TEXT,
      mode       TEXT,
      success    INTEGER NOT NULL,
      err_msg    TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_report_logs_created ON report_logs(created_at);
  `);
  // 兼容已存在的表：补充 pledged 字段
  try {
    db.exec("ALTER TABLE users ADD COLUMN pledged INTEGER DEFAULT 0");
  } catch (e) { /* 字段已存在则忽略 */ }
  console.log("[db] 数据库已连接（可写模式）:", DB_PATH);
  return db;
}

/**
 * 执行参数化查询，返回对象数组。
 */
function queryAll(sqlStr, params = []) {
  const stmt = db.prepare(sqlStr);
  return stmt.all(...params);
}

function queryOne(sqlStr, params = []) {
  const stmt = db.prepare(sqlStr);
  return stmt.get(...params) || null;
}

// ==================== 查询函数 ====================
function queryStats() {
  const holes = queryOne("SELECT COUNT(*) as c FROM holes").c;
  const comments = queryOne("SELECT COUNT(*) as c FROM comments").c;
  const tr = queryOne("SELECT MIN(timestamp) as min, MAX(timestamp) as max FROM holes");
  const avg = queryOne("SELECT AVG(likenum) as l, AVG(reply) as r FROM holes");
  const since = Math.floor(Date.now() / 1000) - 7 * 86400;
  const week = queryOne("SELECT COUNT(*) as c FROM holes WHERE timestamp >= ?", [since]).c;
  // 话题分布（近 7 天各分类帖子数 + 占比）
  const catRows = queryAll(
    "SELECT COALESCE(category,'其他') as category, COUNT(*) as count FROM holes WHERE timestamp >= ? GROUP BY category ORDER BY count DESC",
    [since]
  );
  const total7d = catRows.reduce((s, r) => s + r.count, 0);
  const categories = catRows.map(r => ({
    name: r.category,
    count: r.count,
    percent: total7d > 0 ? Math.round(r.count / total7d * 1000) / 10 : 0
  }));
  return { holes, comments, week, avg_like: avg.l || 0, avg_reply: avg.r || 0, min_ts: tr.min, max_ts: tr.max, categories, total_7d: total7d };
}

function queryHot(days, limit, minLike) {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  if (minLike && minLike > 0) {
    return queryAll(
      "SELECT pid, text, timestamp, likenum, reply, type, image_size, COALESCE(deleted,0) as deleted FROM holes WHERE timestamp >= ? AND likenum >= ? ORDER BY likenum DESC, pid DESC LIMIT ?",
      [since, minLike, limit]
    );
  }
  return queryAll(
    "SELECT pid, text, timestamp, likenum, reply, type, image_size, COALESCE(deleted,0) as deleted FROM holes WHERE timestamp >= ? ORDER BY likenum DESC, pid DESC LIMIT ?",
    [since, limit]
  );
}

function querySearch(keyword, limit, days) {
  const like = `%${keyword}%`;
  if (days) {
    const since = Math.floor(Date.now() / 1000) - days * 86400;
    return queryAll(
      "SELECT pid, text, timestamp, likenum, reply, type, image_size, COALESCE(deleted,0) as deleted FROM holes WHERE text LIKE ? AND timestamp >= ? ORDER BY likenum DESC, pid DESC LIMIT ?",
      [like, since, limit]
    );
  }
  return queryAll(
    "SELECT pid, text, timestamp, likenum, reply, type, image_size, COALESCE(deleted,0) as deleted FROM holes WHERE text LIKE ? ORDER BY likenum DESC, pid DESC LIMIT ?",
    [like, limit]
  );
}

function queryShow(pid) {
  const post = queryOne(
    "SELECT pid, text, type, timestamp, reply, likenum, tag, image_size, COALESCE(deleted,0) as deleted, COALESCE(category,'其他') as category FROM holes WHERE pid = ?", [pid]
  );
  if (!post) return null;
  const comments = queryAll(
    "SELECT cid, pid, text, timestamp, name, comment_id, quote FROM comments WHERE pid = ? ORDER BY cid ASC",
    [pid]
  );
  return { post, comments };
}

function queryWeekPosts(days) {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  return queryAll(
    "SELECT pid, text, timestamp, likenum, reply, COALESCE(deleted,0) as deleted FROM holes WHERE timestamp >= ? ORDER BY pid DESC", [since]
  );
}

function queryKeywordPosts(keywords) {
  const conds = keywords.map(() => "text LIKE ?").join(" OR ");
  const params = keywords.map((k) => `%${k}%`);
  return queryAll(
    `SELECT pid, text, timestamp, likenum, reply, COALESCE(deleted,0) as deleted FROM holes WHERE ${conds} ORDER BY likenum DESC, pid DESC`,
    params
  );
}

function queryPostsByPids(pids) {
  if (!pids.length) return [];
  const placeholders = pids.map(() => "?").join(",");
  return queryAll(
    `SELECT pid, text, timestamp, likenum, reply FROM holes WHERE pid IN (${placeholders})`, pids
  );
}

// ==================== 采样 ====================
function sampleForLlm(rows) {
  if (rows.length <= MAX_POSTS_FOR_LLM) return { posts: rows, sampled: false };
  const ranked = [...rows].sort((a, b) => (b.likenum + b.reply * 2) - (a.likenum + a.reply * 2));
  return { posts: ranked.slice(0, MAX_POSTS_FOR_LLM), sampled: true };
}

function filterUseful(rows) { return rows.filter((r) => isUseful(r.text)); }

// ==================== LLM 调用 ====================
function formatPostsBlock(rows) {
  return rows.map((r) =>
    `[#${r.pid}] ${fmtTime(r.timestamp)} 收藏=${r.likenum} 评论=${r.reply}\n正文：${(r.text || "").trim()}`
  ).join("\n\n");
}

function buildWeekPrompt(rows, days, totalUseful) {
  const sampleNote = totalUseful > rows.length
    ? `\n注：原始有效帖 ${totalUseful} 条过多，已按热度取前 ${rows.length} 条传入分析。` : "";
  const system = "你是资深高校校园动态分析师。基于北京大学树洞（匿名论坛）最近一段时间的帖子，撰写结构清晰、观点中肯、语言自然的中文分析报告。帖子为匿名内容，含口语与情绪表达，需客观提炼而非照搬。对明显不实或极端信息，理性提示不扩散。";
  const user = `以下是北京大学树洞最近 ${days} 天内的 ${rows.length} 条帖子（已过滤无意义内容）。${sampleNote}

${formatPostsBlock(rows)}

请撰写一份详细的 Markdown 分析报告，严格包含以下结构：

## 一、近期关注热点
按主题分类归纳，每个主题用 1-2 段详述，概括帖子实际内容，并在每条信息后标注来源洞号，格式「(#pid)」。

## 二、正在讨论的时事
与近期事件、政策、校园新闻、社会热点相关的内容；如无明显时事，说明话题以日常为主并简述倾向。

## 三、值得关注的信息
对北大学生有实际参考价值的信息，逐条列出并标注来源洞号「(#pid)」。

## 四、社区情绪与氛围
分析整体情绪基调，引用代表性帖子洞号佐证。

## 五、总体观察
2-3 句话概括近期树洞趋势。

要求：
- 全程中文，客观不编造帖子中不存在的内容
- 所有实质性内容必须标注来源洞号「(#pid)」，不得虚构洞号
- 概括实际内容，不要只列编号
- 篇幅充实，重点突出，避免空话套话`;
  return { system, user };
}

function buildKeywordPrompt(rows, keywords, totalUseful) {
  const kwStr = keywords.join(" / ");
  const sampleNote = totalUseful > rows.length
    ? `\n注：命中有效帖 ${totalUseful} 条过多，已按热度取前 ${rows.length} 条传入分析。` : "";
  const system = "你是资深信息分析师。用户给出关键词（可能含拼音缩写，如 xk=信科），需理解其可能含义，从帖子中识别所有相关内容并深入分析。";
  const user = `关键词：${kwStr}
说明：关键词可能包含拼音缩写（首字母缩写），请结合上下文理解其指代，识别所有语义相关的内容。

以下是命中关键词的 ${rows.length} 条帖子。${sampleNote}

${formatPostsBlock(rows)}

请围绕关键词撰写详细的 Markdown 专题分析报告：

## 一、相关内容汇总
按子话题分组，概括实际内容并标注来源洞号「(#pid)」。

## 二、关键信息提炼
提取有价值的事实性信息，逐条列出并标注洞号「(#pid)」。

## 三、态度与讨论
分析立场、情绪、共识与分歧，引用洞号佐证。

## 四、实用信息与建议
给出可操作的建议，标注信息来源洞号「(#pid)」。

要求：
- 全程中文，客观不编造
- 所有实质性内容必须标注来源洞号「(#pid)」
- 概括实际内容，不要只列编号
- 篇幅充实，信息密度高`;
  return { system, user };
}

async function callLlm(system, user, provider, customConfig) {
  // 支持自定义 provider 配置（用户在前端填入 api-key / model / url）
  let p;
  if (customConfig && customConfig.apiKey && customConfig.url && customConfig.model) {
    // public provider 用自定义模型时，前端传 apiKey='__public__' 占位符，需替换为服务器 env Key
    let apiKey = customConfig.apiKey;
    let url = customConfig.url;
    let fmt = customConfig.fmt || "openai";
    if (apiKey === "__public__" && provider && LLM_PROVIDERS[provider]) {
      apiKey = process.env[LLM_PROVIDERS[provider].key];
      // 安全：使用服务器 Key 时强制走官方 URL，防止 Key 泄露到任意地址
      url = LLM_PROVIDERS[provider].url;
      fmt = LLM_PROVIDERS[provider].fmt;
    }
    // 安全：阻断 SSRF —— 禁止指向内网/本地地址
    assertSafeUrl(url);
    p = { url, model: customConfig.model, fmt, _apiKey: apiKey };
  } else {
    p = LLM_PROVIDERS[provider];
    if (!p) throw new Error(`未知 provider: ${provider}`);
    p = { ...p, _apiKey: process.env[p.key] };
  }
  if (!p._apiKey) throw new Error(`未配置 API Key（provider: ${provider || "custom"}）`);

  const isAnthropic = p.fmt === "anthropic";
  const headers = { "Content-Type": "application/json" };
  let body;

  if (isAnthropic) {
    headers["x-api-key"] = p._apiKey;
    headers["anthropic-version"] = "2023-06-01";
    body = JSON.stringify({ model: p.model, max_tokens: 4096, system, messages: [{ role: "user", content: user }] });
  } else {
    headers["Authorization"] = `Bearer ${p._apiKey}`;
    body = JSON.stringify({ model: p.model, temperature: 0.7, stream: false,
      messages: [{ role: "system", content: system }, { role: "user", content: user }] });
  }

  const resp = await fetch(p.url, { method: "POST", headers, body, signal: AbortSignal.timeout(170_000) });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`LLM HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = await resp.json();
  if (isAnthropic) return data.content[0].text;
  return data.choices[0].message.content;
}

// ==================== 报告后处理 ====================
function enrichReport(content) {
  const HOLE_PID_MIN = 10000;
  const URL_TPL = "https://treehole.pku.edu.cn/web/#/hole/";

  // 提取所有被引用的洞号（去重保序）
  const pids = [];
  const seen = new Set();
  for (const m of content.matchAll(/#(\d+)/g)) {
    const pid = parseInt(m[1], 10);
    if (pid >= HOLE_PID_MIN && !seen.has(pid)) { seen.add(pid); pids.push(pid); }
  }

  // 超链接化
  const enriched = content.replace(/#(\d+)/g, (match, num) => {
    const pid = parseInt(num, 10);
    return pid >= HOLE_PID_MIN ? `[#${pid}](${URL_TPL}${pid})` : match;
  });

  if (!pids.length) return enriched;

  // 查库取原文
  const rows = queryPostsByPids(pids);
  const rowMap = new Map(rows.map((r) => [r.pid, r]));

  let appendix = "\n\n---\n\n## 被引用帖子原文\n\n";
  for (const pid of pids) {
    const r = rowMap.get(pid);
    if (r) {
      appendix += `### [#${pid}](${URL_TPL}${pid})\n- 时间：${fmtTime(r.timestamp)}　收藏：${r.likenum}　评论：${r.reply}\n- 原文：\n\n> ${(r.text || "").trim()}\n\n`;
    } else {
      appendix += `### [#${pid}](${URL_TPL}${pid})\n\n> （数据库中未找到该帖子）\n\n`;
    }
  }
  return enriched + appendix;
}

// ==================== 路由处理 ====================
function handleStats() { return { ...queryStats() }; }

function handleHot(query) {
  const days = validateInt(query.days, 1, MAX_DAYS, 7);
  const limit = validateInt(query.limit, 1, MAX_LIMIT, 20);
  const minLike = query.min_like ? validateInt(query.min_like, 0, 9999, 0) : 0;
  return { posts: queryHot(days, limit, minLike) };
}

function handleSearch(query) {
  const keyword = (query.keyword || "").trim();
  if (!keyword) throw new Error("关键词不能为空");
  if (keyword.length > MAX_KEYWORD_LEN) throw new Error(`关键词过长（最多 ${MAX_KEYWORD_LEN} 字符）`);
  const limit = validateInt(query.limit, 1, MAX_LIMIT, 20);
  const days = query.days ? validateInt(query.days, 1, MAX_DAYS, null) : null;
  return { posts: querySearch(keyword, limit, days) };
}

function handleShow(query) {
  const pid = validateInt(query.pid, 1, 99_999_999, 0);
  if (!pid) throw new Error("pid 参数无效");
  const result = queryShow(pid);
  if (!result) throw new Error(`不存在 pid=${pid} 的帖子`);
  return result;
}

function handleTrend(query) {
  const days = validateInt(query.days, 1, 30, 7);
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  // 按天 + 分类聚合，使用本地时区
  const rows = queryAll(
    `SELECT date(timestamp, 'unixepoch', 'localtime') as day,
            COALESCE(category, '其他') as category,
            COUNT(*) as count
     FROM holes WHERE timestamp >= ?
     GROUP BY day, category
     ORDER BY day ASC`,
    [since]
  );
  // 整理为 { days: [...], categories: { 学习: [...], 情感: [...], ... } }
  const daySet = [];
  const catMap = {};
  for (const r of rows) {
    if (!daySet.includes(r.day)) daySet.push(r.day);
    if (!catMap[r.category]) catMap[r.category] = {};
    catMap[r.category][r.day] = r.count;
  }
  // 补全缺失天数为 0
  const categories = Object.keys(catMap);
  const series = {};
  for (const cat of categories) {
    series[cat] = daySet.map(d => catMap[cat][d] || 0);
  }
  // 计算每天总量，用于百分比
  const totals = daySet.map(d => {
    let sum = 0;
    for (const cat of categories) sum += (catMap[cat][d] || 0);
    return sum;
  });
  // 转为百分比
  const percentSeries = {};
  for (const cat of categories) {
    percentSeries[cat] = series[cat].map((v, i) => totals[i] > 0 ? Math.round(v / totals[i] * 1000) / 10 : 0);
  }
  return { days: daySet, categories, series: percentSeries };
}

async function handleReport(body, ip) {
  const provider = body.provider || "minimax";
  const customConfig = body.customConfig || null;
  // 判断调用模式：public=站长Key代理，custom=网友Key代理
  const mode = customConfig ? "custom-proxy" : "public";
  // 非自定义模式时校验预设 provider
  if (!customConfig && !LLM_PROVIDERS[provider]) throw new Error(`未知 provider: ${provider}`);
  // 非自定义模式时仅允许 public provider（服务器已配置 Key 的）
  if (!customConfig && !LLM_PROVIDERS[provider].public) {
    throw new Error(`${provider} 需要自行提供 API Key，请在前端配置或使用前端直连模式`);
  }
  const days = validateInt(body.days, 1, MAX_DAYS, 7);

  let posts, promptData;
  if (body.keyword && body.keyword.trim()) {
    const keywords = body.keyword.trim().split(/\s+/);
    if (keywords.length > 20) throw new Error("关键词过多（最多 20 个）");
    if (keywords.some((k) => k.length > MAX_KEYWORD_LEN)) throw new Error("关键词过长");
    const useful = filterUseful(queryKeywordPosts(keywords));
    posts = sampleForLlm(useful).posts;
    if (!posts.length) throw new Error(`未找到与「${body.keyword}」相关的帖子`);
    promptData = buildKeywordPrompt(posts, keywords, useful.length);
  } else {
    const useful = filterUseful(queryWeekPosts(days));
    posts = sampleForLlm(useful).posts;
    if (!posts.length) throw new Error(`最近 ${days} 天无有效帖子`);
    promptData = buildWeekPrompt(posts, days, useful.length);
  }

  try {
    const content = await callLlm(promptData.system, promptData.user, provider, customConfig);
    logReportCall(ip, provider, mode, true);
    return { content: enrichReport(content) };
  } catch (e) {
    logReportCall(ip, provider, mode, false, e.message);
    throw e;
  }
}

/** 返回所有支持的 LLM provider 及其预设模型列表（public=true 表示服务器已配置 Key，可直接使用） */
function handleProviders() {
  const all = Object.entries(LLM_PROVIDERS).map(([name, p]) => ({
    name,
    label: name.charAt(0).toUpperCase() + name.slice(1),
    model: p.model,
    models: p.models || [p.model],
    fmt: p.fmt || "openai",
    url: p.url,
    public: !!p.public,
  }));
  return { providers: all };
}

/**
 * 报告预处理：只构建 prompt，不调用 LLM。
 * 用于前端直连模式 — 网友的 API Key 只在浏览器中使用，不经过服务器。
 */
function handleReportPrepare(body) {
  const days = validateInt(body.days, 1, MAX_DAYS, 7);
  let posts, promptData;
  if (body.keyword && body.keyword.trim()) {
    const keywords = body.keyword.trim().split(/\s+/);
    if (keywords.length > 20) throw new Error("关键词过多（最多 20 个）");
    if (keywords.some((k) => k.length > MAX_KEYWORD_LEN)) throw new Error("关键词过长");
    const useful = filterUseful(queryKeywordPosts(keywords));
    posts = sampleForLlm(useful).posts;
    if (!posts.length) throw new Error(`未找到与「${body.keyword}」相关的帖子`);
    promptData = buildKeywordPrompt(posts, keywords, useful.length);
  } else {
    const useful = filterUseful(queryWeekPosts(days));
    posts = sampleForLlm(useful).posts;
    if (!posts.length) throw new Error(`最近 ${days} 天无有效帖子`);
    promptData = buildWeekPrompt(posts, days, useful.length);
  }
  return { system: promptData.system, user: promptData.user, postCount: posts.length };
}

/**
 * 报告后处理：对前端直连模式产生的 LLM 原始输出做链接化 + 附录原文。
 * 网友的 API Key 已在浏览器端使用完毕，此接口只接收纯文本内容，不涉及任何 Key。
 */
function handleReportEnrich(body) {
  if (!body.content || typeof body.content !== "string") throw new Error("content 不能为空");
  if (body.content.length > 200_000) throw new Error("内容过长");
  return { content: enrichReport(body.content) };
}

// ==================== 请求体读取 ====================
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_048_576) { reject(new Error("请求体过大")); req.destroy(); }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// ==================== 邮件发送 ====================
let mailTransporter = null;
function getMailer() {
  if (mailTransporter) return mailTransporter;
  mailTransporter = nodemailer.createTransport({
    host: "smtp.qq.com",
    port: 465,
    secure: true,
    auth: { user: MAIL_USER, pass: MAIL_PASS },
  });
  return mailTransporter;
}

async function sendVerifyCodeEmail(toEmail, code) {
  const mailOptions = {
    from: MAIL_FROM,
    to: toEmail,
    subject: "AutoTreehole 验证码",
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;max-width:400px;margin:0 auto;padding:32px 24px;background:#F5F5F7;border-radius:12px;">
      <h2 style="color:#1D1D1F;font-size:20px;font-weight:600;margin-bottom:16px;">AutoTreehole 验证码</h2>
      <p style="color:#6E6E73;font-size:14px;line-height:1.8;margin-bottom:24px;">您正在验证校园邮箱以访问 AutoTreehole。验证码为：</p>
      <div style="text-align:center;padding:20px;background:#fff;border-radius:8px;margin-bottom:24px;">
        <span style="font-size:32px;font-weight:600;letter-spacing:8px;color:#1D1D1F;font-family:'SF Mono',Menlo,monospace;">${code}</span>
      </div>
      <p style="color:#86868B;font-size:12px;line-height:1.6;">验证码 5 分钟内有效。如非本人操作，请忽略此邮件。</p>
    </div>`,
  };
  await getMailer().sendMail(mailOptions);
}

// ==================== 认证：令牌生成与验证 ====================
function generateToken(email) {
  const ts = Math.floor(Date.now() / 1000);
  const payload = `${email}.${ts}`;
  const sig = crypto.createHmac("sha256", TOKEN_SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 3) return null;
  // email 可能含 . 号，所以用最后两段作为 ts 和 sig
  const sig = parts.pop();
  const ts = parseInt(parts.pop(), 10);
  const email = parts.join(".");
  if (isNaN(ts)) return null;
  const age = Math.floor(Date.now() / 1000) - ts;
  if (age > TOKEN_MAX_AGE) return null;
  const expectedSig = crypto.createHmac("sha256", TOKEN_SECRET).update(`${email}.${ts}`).digest("hex");
  if (sig !== expectedSig) return null;
  return { email, ts, age };
}

function isAllowedEmail(email) {
  if (!email || typeof email !== "string") return false;
  const lower = email.trim().toLowerCase();
  return ALLOWED_EMAIL_DOMAINS.some(d => lower.endsWith("@" + d));
}

function getCookie(req, name) {
  const cookies = req.headers.cookie || "";
  for (const c of cookies.split(";")) {
    const [k, ...v] = c.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

// ==================== 认证 API ====================
function handleAuthSendCode(body, ip) {
  const email = (body.email || "").trim().toLowerCase();
  if (!isAllowedEmail(email)) {
    throw new Error("请使用北大校园邮箱（@pku.edu.cn 或 @stu.pku.edu.cn）");
  }
  const now = Math.floor(Date.now() / 1000);

  // 检查 IP 每日限额
  const ipKey = `verify_ip_${ip}`;
  const todayStart = new Date().setHours(0, 0, 0, 0) / 1000;
  const ipCount = queryOne("SELECT COUNT(*) as c FROM verify_codes WHERE sent_at >= ? AND ? != ''", [todayStart, ip])?.c || 0;
  // 用 visit_logs 粗略记录 IP 发送次数
  const ipSentToday = queryAll("SELECT email FROM verify_codes WHERE sent_at >= ?", [todayStart]);
  const ipFiltered = ipSentToday.length;
  // 不够精确，改为简单全局限制

  // 检查重发间隔
  const existing = queryOne("SELECT * FROM verify_codes WHERE email = ?", [email]);
  if (existing && now - existing.sent_at < CODE_RESEND_INTERVAL) {
    throw new Error(`发送过于频繁，请 ${CODE_RESEND_INTERVAL - (now - existing.sent_at)} 秒后重试`);
  }

  // 生成 6 位验证码
  const code = String(Math.floor(Math.random() * 900000) + 100000);

  // 存储/更新验证码
  db.prepare(
    `INSERT INTO verify_codes (email, code, expires_at, sent_at, attempts)
     VALUES (?, ?, ?, ?, 0)
     ON CONFLICT(email) DO UPDATE SET code=excluded.code, expires_at=excluded.expires_at, sent_at=excluded.sent_at, attempts=0`
  ).run(email, code, now + CODE_TTL, now);

  // 异步发送邮件
  sendVerifyCodeEmail(email, code).then(() => {
    console.log(`[auth] 验证码已发送: ${email} (IP: ${ip})`);
  }).catch(e => {
    console.error(`[auth] 邮件发送失败: ${email}`, e.message);
  });

  return { success: true, message: "验证码已发送，请检查邮箱" };
}

function handleAuthVerify(body, ip) {
  const email = (body.email || "").trim().toLowerCase();
  const code = (body.code || "").trim();
  if (!isAllowedEmail(email)) {
    throw new Error("请使用北大校园邮箱");
  }
  if (!code || code.length !== 6) {
    throw new Error("请输入 6 位验证码");
  }
  const now = Math.floor(Date.now() / 1000);

  const record = queryOne("SELECT * FROM verify_codes WHERE email = ?", [email]);
  if (!record) {
    throw new Error("请先发送验证码");
  }
  if (record.attempts >= CODE_MAX_ATTEMPTS) {
    throw new Error("尝试次数过多，请重新发送验证码");
  }
  if (now > record.expires_at) {
    throw new Error("验证码已过期，请重新发送");
  }
  if (record.code !== code) {
    db.prepare("UPDATE verify_codes SET attempts = attempts + 1 WHERE email = ?").run(email);
    throw new Error("验证码错误");
  }

  // 验证成功，注册或更新用户
  const existingUser = queryOne("SELECT * FROM users WHERE email = ?", [email]);
  if (!existingUser) {
    db.prepare("INSERT INTO users (email, verified_at, last_visit, visit_count) VALUES (?, ?, ?, 1)").run(email, now, now);
    console.log(`[auth] 新用户注册: ${email}`);
  } else {
    db.prepare("UPDATE users SET last_visit = ?, visit_count = visit_count + 1 WHERE email = ?").run(now, email);
  }

  // 清除验证码
  db.prepare("DELETE FROM verify_codes WHERE email = ?").run(email);

  // 记录访问日志
  db.prepare("INSERT INTO visit_logs (user_email, ip, entered_at, last_active) VALUES (?, ?, ?, ?)").run(email, ip, now, now);

  // 生成令牌
  const token = generateToken(email);
  return { success: true, token, email, message: "验证成功" };
}

function handleAuthCheck(req) {
  const token = getCookie(req, "treehole_token");
  const payload = verifyToken(token);
  if (!payload) {
    return { authorized: false };
  }
  const user = queryOne("SELECT pledged FROM users WHERE email = ?", [payload.email]);
  return { authorized: true, email: payload.email, pledged: user ? !!user.pledged : false };
}

// 用户承诺（不传播本站）
function handleAuthPledge(req) {
  const token = getCookie(req, "treehole_token");
  const payload = verifyToken(token);
  if (!payload) throw new Error("未登录");
  db.prepare("UPDATE users SET pledged = 1 WHERE email = ?").run(payload.email);
  console.log(`[auth] 用户承诺: ${payload.email}`);
  return { success: true };
}

// 站长信箱：转发用户留言到站长邮箱
async function handleMessage(body, req) {
  const token = getCookie(req, "treehole_token");
  const payload = verifyToken(token);
  if (!payload) throw new Error("请先登录");
  const content = (body.content || "").trim();
  if (!content) throw new Error("留言内容不能为空");
  if (content.length > 5000) throw new Error("留言内容过长（限 5000 字）");
  const contact = (body.contact || "").trim().slice(0, 200);
  const userEmail = payload.email;

  const mailOptions = {
    from: MAIL_FROM,
    to: SITE_OWNER_EMAIL,
    subject: `AutoTreehole 站长信箱 · 来自 ${userEmail} 的留言`,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;max-width:500px;margin:0 auto;padding:32px 24px;background:#F5F5F7;border-radius:12px;">
      <h2 style="color:#1D1D1F;font-size:18px;font-weight:600;margin-bottom:20px;">📬 站长信箱新留言</h2>
      <table style="width:100%;font-size:14px;color:#1D1D1F;line-height:1.8;margin-bottom:20px;">
        <tr><td style="color:#86868B;width:80px;vertical-align:top;">注册邮箱</td><td>${userEmail}</td></tr>
        ${contact ? `<tr><td style="color:#86868B;vertical-align:top;">联系方式</td><td>${contact}</td></tr>` : ""}
      </table>
      <div style="background:#fff;border-radius:8px;padding:20px 24px;">
        <p style="color:#1D1D1F;font-size:14px;line-height:1.8;white-space:pre-wrap;">${content.replace(/</g,"&lt;")}</p>
      </div>
      <p style="color:#86868B;font-size:12px;margin-top:16px;">此邮件由 AutoTreehole 系统自动发送</p>
    </div>`,
  };
  await getMailer().sendMail(mailOptions);
  console.log(`[message] 站长信箱留言 from ${userEmail}`);
  return { success: true, message: "留言已发送，感谢你的反馈" };
}

// 站长信箱（未登录访客版）：用于"获取邀请码"等场景，联系方式必填，严格频率限制
async function handlePublicMessage(body, req) {
  const ip = getClientIp(req);
  // 先做输入校验（廉价、无副作用），再查频率限制，避免无效请求消耗配额
  const content = (body.content || "").trim();
  if (!content) throw new Error("留言内容不能为空");
  if (content.length > 5000) throw new Error("留言内容过长（限 5000 字）");
  const contact = (body.contact || "").trim();
  if (!contact) throw new Error("请留下你的联系方式，以便站长回复");
  if (contact.length > 200) throw new Error("联系方式过长（限 200 字）");
  // 来源标记（如：获取邀请码），去除控制字符防邮件头注入
  const source = (body.source || "").trim().slice(0, 40).replace(/[\r\n\0]/g, "");
  // 三层频率限制：IP 小时级 / IP 日级 / 全局小时级（防邮箱轰炸）
  if (!messageRateCheck(ip)) {
    throw new Error("留言过于频繁，请稍后再试");
  }

  const mailOptions = {
    from: MAIL_FROM,
    to: SITE_OWNER_EMAIL,
    subject: `AutoTreehole 站长信箱 · 访客留言${source ? "（" + source + "）" : ""}`,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;max-width:500px;margin:0 auto;padding:32px 24px;background:#F5F5F7;border-radius:12px;">
      <h2 style="color:#1D1D1F;font-size:18px;font-weight:600;margin-bottom:20px;">📬 站长信箱新留言（访客）</h2>
      <table style="width:100%;font-size:14px;color:#1D1D1F;line-height:1.8;margin-bottom:20px;">
        <tr><td style="color:#86868B;width:80px;vertical-align:top;">来源</td><td>未登录访客${source ? " · " + source.replace(/</g,"&lt;") : ""}</td></tr>
        <tr><td style="color:#86868B;vertical-align:top;">联系方式</td><td>${contact.replace(/</g,"&lt;")}</td></tr>
      </table>
      <div style="background:#fff;border-radius:8px;padding:20px 24px;">
        <p style="color:#1D1D1F;font-size:14px;line-height:1.8;white-space:pre-wrap;">${content.replace(/</g,"&lt;")}</p>
      </div>
      <p style="color:#86868B;font-size:12px;margin-top:16px;">此邮件由 AutoTreehole 系统自动发送 · IP: ${ip.replace(/</g,"&lt;")}</p>
    </div>`,
  };
  await getMailer().sendMail(mailOptions);
  console.log(`[message] 访客留言 from IP=${ip} source=${source || "none"}`);
  return { success: true, message: "留言已发送，站长会尽快与你联系" };
}

// ==================== 邀请码 ====================
const INVITE_CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 去掉易混淆字符
function generateInviteCode(len = 8) {
  let code;
  let tries = 0;
  do {
    code = "";
    for (let i = 0; i < len; i++) code += INVITE_CODE_CHARS[Math.floor(Math.random() * INVITE_CODE_CHARS.length)];
    tries++;
  } while (queryOne("SELECT code FROM invite_codes WHERE code = ?", [code]) && tries < 10);
  return code;
}

// 邀请码登录
function handleInviteLogin(body, req) {
  const code = (body.code || "").trim().toUpperCase();
  if (!code) throw new Error("请输入邀请码");
  if (!/^[A-Z0-9]{4,20}$/.test(code)) throw new Error("邀请码格式无效");
  const row = queryOne("SELECT * FROM invite_codes WHERE code = ?", [code]);
  if (!row) throw new Error("邀请码不存在");
  if (row.used_at) throw new Error("邀请码已被使用");
  const now = Math.floor(Date.now() / 1000);
  const userId = `invite:${code}`;
  // 注册用户
  db.prepare("INSERT OR IGNORE INTO users (email, verified_at, pledged) VALUES (?, ?, 0)").run(userId, now);
  db.prepare("UPDATE users SET last_visit = ? WHERE email = ?").run(now, userId);
  // 标记邀请码已使用
  db.prepare("UPDATE invite_codes SET used_at = ?, used_by = ? WHERE code = ?").run(now, userId, code);
  // 访问日志
  db.prepare("INSERT INTO visit_logs (user_email, ip, entered_at) VALUES (?, ?, ?)").run(userId, getClientIp(req), now);
  const token = generateToken(userId);
  console.log(`[auth] 邀请码登录: ${code} → ${userId}`);
  return { token, email: userId };
}

// 数据后台：生成邀请码
function handleAdminInviteCreate(body) {
  const count = Math.min(parseInt(body.count, 10) || 1, 50);
  const note = (body.note || "").trim().slice(0, 200);
  const customCode = (body.code || "").trim().toUpperCase();
  const results = [];
  if (customCode) {
    if (!/^[A-Z0-9]{4,20}$/.test(customCode)) throw new Error("自定义邀请码格式无效（4-20位字母数字）");
    if (queryOne("SELECT code FROM invite_codes WHERE code = ?", [customCode])) throw new Error("邀请码已存在");
    db.prepare("INSERT INTO invite_codes (code, note, created_at) VALUES (?, ?, ?)").run(customCode, note, Math.floor(Date.now() / 1000));
    results.push(customCode);
  } else {
    for (let i = 0; i < count; i++) {
      const code = generateInviteCode();
      db.prepare("INSERT INTO invite_codes (code, note, created_at) VALUES (?, ?, ?)").run(code, note, Math.floor(Date.now() / 1000));
      results.push(code);
    }
  }
  console.log(`[admin] 生成邀请码 ${results.length} 个`);
  return { codes: results };
}

// 数据后台：邀请码列表
function handleAdminInviteList(query) {
  const limit = Math.min(parseInt(query.limit, 10) || 100, 500);
  return queryAll("SELECT code, note, created_at, used_at, used_by FROM invite_codes ORDER BY created_at DESC LIMIT ?", [limit]);
}

// 数据后台：删除邀请码（仅未使用的）
function handleAdminInviteDelete(body) {
  const code = (body.code || "").trim().toUpperCase();
  if (!code) throw new Error("缺少邀请码");
  const row = queryOne("SELECT used_at FROM invite_codes WHERE code = ?", [code]);
  if (!row) throw new Error("邀请码不存在");
  if (row.used_at) throw new Error("已使用的邀请码不能删除");
  db.prepare("DELETE FROM invite_codes WHERE code = ?").run(code);
  return { success: true };
}

// ==================== 数据上报 API ====================
function handleTrackView(body, req) {
  const token = getCookie(req, "treehole_token");
  const payload = verifyToken(token);
  const email = payload ? payload.email : null;
  const ip = getClientIp(req);
  const pid = parseInt(body.pid, 10);
  if (!pid || pid < 1) return { success: false };

  const now = Math.floor(Date.now() / 1000);
  db.prepare("INSERT INTO post_views (pid, user_email, user_ip, viewed_at) VALUES (?, ?, ?, ?)").run(pid, email, ip, now);

  // 更新用户活跃
  if (email) {
    db.prepare("UPDATE users SET last_visit = ? WHERE email = ?").run(now, email);
  }
  return { success: true };
}

function handleTrackDuration(body, req) {
  const token = getCookie(req, "treehole_token");
  const payload = verifyToken(token);
  const email = payload ? payload.email : null;
  const pid = parseInt(body.pid, 10);
  const duration = parseInt(body.duration, 10) || 0;
  if (!pid || duration < 1) return { success: false };

  // 更最近一条浏览记录的停留时长
  const last = queryOne("SELECT id FROM post_views WHERE pid = ? AND user_email IS ? ORDER BY id DESC LIMIT 1", [pid, email]);
  if (last) {
    db.prepare("UPDATE post_views SET duration = duration + ? WHERE id = ?").run(duration, last.id);
  }
  // 更新用户累计时长
  if (email) {
    db.prepare("UPDATE users SET total_duration = total_duration + ? WHERE email = ?").run(duration, email);
  }
  return { success: true };
}

function handleTrackHeartbeat(req) {
  const token = getCookie(req, "treehole_token");
  const payload = verifyToken(token);
  if (!payload) return { success: false };
  const now = Math.floor(Date.now() / 1000);
  db.prepare("UPDATE users SET last_visit = ? WHERE email = ?").run(now, payload.email);
  db.prepare("UPDATE visit_logs SET last_active = ? WHERE user_email = ? ORDER BY id DESC LIMIT 1").run(now, payload.email);
  return { success: true };
}

// ==================== 数据后台统计 API ====================
function handleAdminStats() {
  const totalUsers = queryOne("SELECT COUNT(*) as c FROM users").c;
  const todayStart = new Date().setHours(0, 0, 0, 0) / 1000;
  const newToday = queryOne("SELECT COUNT(*) as c FROM users WHERE verified_at >= ?", [todayStart]).c;
  const activeToday = queryOne("SELECT COUNT(*) as c FROM users WHERE last_visit >= ?", [todayStart]).c;
  const totalViews = queryOne("SELECT COUNT(*) as c FROM post_views").c;
  const viewsToday = queryOne("SELECT COUNT(*) as c FROM post_views WHERE viewed_at >= ?", [todayStart]).c;

  // 用户增长曲线（按天累计）
  const growth = queryAll(
    `SELECT date(verified_at, 'unixepoch', 'localtime') as day, COUNT(*) as new_users
     FROM users GROUP BY day ORDER BY day ASC`
  );
  let cumulative = 0;
  const growthSeries = growth.map(g => {
    cumulative += g.new_users;
    return { day: g.day, new_users: g.new_users, cumulative };
  });

  // 日活跃用户（近 30 天）
  const dau = queryAll(
    `SELECT date(last_visit, 'unixepoch', 'localtime') as day, COUNT(DISTINCT email) as active
     FROM users WHERE last_visit >= ?
     GROUP BY day ORDER BY day ASC`,
    [Math.floor(Date.now() / 1000) - 30 * 86400]
  );

  // 热门帖子（浏览量 Top 20）
  const topPosts = queryAll(
    `SELECT pv.pid, COUNT(*) as views, h.text, h.category
     FROM post_views pv LEFT JOIN holes h ON h.pid = pv.pid
     GROUP BY pv.pid ORDER BY views DESC LIMIT 20`
  );

  // 最近注册用户
  const recentUsers = queryAll(
    `SELECT email, verified_at, last_visit, visit_count, total_duration
     FROM users ORDER BY verified_at DESC LIMIT 50`
  );

  // 浏览量趋势（近 30 天）
  const viewsTrend = queryAll(
    `SELECT date(viewed_at, 'unixepoch', 'localtime') as day, COUNT(*) as views
     FROM post_views WHERE viewed_at >= ?
     GROUP BY day ORDER BY day ASC`,
    [Math.floor(Date.now() / 1000) - 30 * 86400]
  );

  // 分类浏览分布
  const categoryViews = queryAll(
    `SELECT COALESCE(h.category, '其他') as category, COUNT(*) as views
     FROM post_views pv LEFT JOIN holes h ON h.pid = pv.pid
     GROUP BY category ORDER BY views DESC`
  );

  // 邀请码统计
  const totalInviteCodes = queryOne("SELECT COUNT(*) as c FROM invite_codes").c;
  const usedInviteCodes = queryOne("SELECT COUNT(*) as c FROM invite_codes WHERE used_at IS NOT NULL").c;
  const inviteUsers = queryAll(
    `SELECT email, verified_at, last_visit, visit_count, total_duration
     FROM users WHERE email LIKE 'invite:%' ORDER BY verified_at DESC LIMIT 50`
  );

  // AI 报告统计
  const totalReports = queryOne("SELECT COUNT(*) as c FROM report_logs").c;
  const successReports = queryOne("SELECT COUNT(*) as c FROM report_logs WHERE success = 1").c;
  const reportsToday = queryOne("SELECT COUNT(*) as c FROM report_logs WHERE created_at >= ?", [todayStart]).c;
  // 按 provider 统计
  const reportsByProvider = queryAll(
    `SELECT provider, COUNT(*) as count, SUM(success) as success_count
     FROM report_logs GROUP BY provider ORDER BY count DESC`
  );
  // 按 mode 统计
  const reportsByMode = queryAll(
    `SELECT mode, COUNT(*) as count, SUM(success) as success_count
     FROM report_logs GROUP BY mode ORDER BY count DESC`
  );
  // 近 30 天报告趋势
  const reportsTrend = queryAll(
    `SELECT date(created_at, 'unixepoch', 'localtime') as day, COUNT(*) as total, SUM(success) as success
     FROM report_logs WHERE created_at >= ?
     GROUP BY day ORDER BY day ASC`,
    [Math.floor(Date.now() / 1000) - 30 * 86400]
  );
  // 最近 50 条报告记录
  const recentReports = queryAll(
    `SELECT ip, provider, mode, success, err_msg, created_at
     FROM report_logs ORDER BY created_at DESC LIMIT 50`
  );

  return {
    overview: { totalUsers, newToday, activeToday, totalViews, viewsToday },
    growth: growthSeries,
    dau,
    topPosts,
    recentUsers,
    viewsTrend,
    categoryViews,
    invite: {
      total: totalInviteCodes,
      used: usedInviteCodes,
      available: totalInviteCodes - usedInviteCodes,
      users: inviteUsers,
    },
    reports: {
      total: totalReports,
      success: successReports,
      fail: totalReports - successReports,
      today: reportsToday,
      byProvider: reportsByProvider.map(r => ({
        provider: r.provider || 'unknown',
        count: r.count,
        success: r.success_count || 0,
        fail: r.count - (r.success_count || 0),
      })),
      byMode: reportsByMode.map(r => ({
        mode: r.mode || 'unknown',
        count: r.count,
        success: r.success_count || 0,
        fail: r.count - (r.success_count || 0),
      })),
      trend: reportsTrend.map(r => ({
        day: r.day,
        total: r.total,
        success: r.success || 0,
        fail: r.total - (r.success || 0),
      })),
      recent: recentReports.map(r => ({
        ip: r.ip,
        provider: r.provider,
        mode: r.mode,
        success: !!r.success,
        errMsg: r.err_msg,
        createdAt: r.created_at,
      })),
    },
  };
}

// ==================== 主服务 ====================
const server = http.createServer(async (req, res) => {
  // CORS 预检
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return;
  }

  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query = parsed.query;
  const ip = getClientIp(req);

  try {
    // 健康检查
    if (pathname === "/" || pathname === "/health") {
      sendJson(res, 200, { status: "ok", time: new Date().toISOString() });
      return;
    }

    if (!pathname.startsWith("/api/")) {
      sendError(res, 404, "Not Found");
      return;
    }

    const route = pathname.slice(5);

    // 服务状态（含 token 剩余天数，用于前端提示）
    if (route === "status") {
      const days = tokenDaysLeft(PKU_TOKEN);
      sendJson(res, 200, {
        status: "ok",
        token_days_left: days !== null ? Math.round(days * 10) / 10 : null,
        token_warning: days !== null && days <= 7,
      });
      return;
    }

    // 报告接口
    if (route === "report") {
      if (req.method !== "POST") { sendError(res, 405, "Method Not Allowed"); return; }
      if (!rateLimit(ip, true)) { sendError(res, 429, "请求过于频繁。限制：每 IP 每分钟 2 次、每天 15 次；全局每天 200 次"); return; }
      const body = JSON.parse((await readBody(req)) || "{}");
      await ensureDb();
      sendJson(res, 200, await handleReport(body, ip));
      return;
    }

    // 报告预处理（前端直连模式：只返回 prompt，不调用 LLM，网友 Key 不经过服务器）
    if (route === "report/prepare") {
      if (req.method !== "POST") { sendError(res, 405, "Method Not Allowed"); return; }
      if (!rateLimit(ip, false)) { sendError(res, 429, "请求过于频繁，每 IP 每分钟限 30 次"); return; }
      const body = JSON.parse((await readBody(req)) || "{}");
      await ensureDb();
      sendJson(res, 200, handleReportPrepare(body));
      return;
    }

    // 报告后处理（前端直连模式：对 LLM 原始输出做链接化 + 附录，不涉及 Key）
    if (route === "report/enrich") {
      if (req.method !== "POST") { sendError(res, 405, "Method Not Allowed"); return; }
      if (!rateLimit(ip, false)) { sendError(res, 429, "请求过于频繁，每 IP 每分钟限 30 次"); return; }
      const body = JSON.parse((await readBody(req)) || "{}");
      await ensureDb();
      sendJson(res, 200, handleReportEnrich(body));
      return;
    }

    // 认证接口（不需要令牌即可访问）
    if (route === "auth/sendCode") {
      if (req.method !== "POST") { sendError(res, 405, "Method Not Allowed"); return; }
      if (!rateLimit(ip, false)) { sendError(res, 429, "请求过于频繁"); return; }
      const body = JSON.parse((await readBody(req)) || "{}");
      await ensureDb();
      try {
        const result = handleAuthSendCode(body, ip);
        sendJson(res, 200, result);
      } catch (e) { sendError(res, 400, e.message); }
      return;
    }
    if (route === "auth/verify") {
      if (req.method !== "POST") { sendError(res, 405, "Method Not Allowed"); return; }
      if (!rateLimit(ip, false)) { sendError(res, 429, "请求过于频繁"); return; }
      const body = JSON.parse((await readBody(req)) || "{}");
      await ensureDb();
      try {
        const result = handleAuthVerify(body, ip);
        // 设置 HttpOnly Cookie
        res.setHeader("Set-Cookie", `treehole_token=${result.token}; HttpOnly; Path=/; Max-Age=${TOKEN_MAX_AGE}; SameSite=Lax`);
        sendJson(res, 200, result);
      } catch (e) { sendError(res, 400, e.message); }
      return;
    }
    if (route === "auth/check") {
      await ensureDb();
      sendJson(res, 200, handleAuthCheck(req));
      return;
    }
    if (route === "auth/pledge") {
      if (req.method !== "POST") { sendError(res, 405, "Method Not Allowed"); return; }
      await ensureDb();
      try {
        sendJson(res, 200, handleAuthPledge(req));
      } catch (e) { sendError(res, 400, e.message); }
      return;
    }
    if (route === "auth/invite") {
      if (req.method !== "POST") { sendError(res, 405, "Method Not Allowed"); return; }
      if (!rateLimit(ip, false)) { sendError(res, 429, "请求过于频繁"); return; }
      const body = JSON.parse((await readBody(req)) || "{}");
      await ensureDb();
      try {
        const result = handleInviteLogin(body, req);
        res.setHeader("Set-Cookie", `treehole_token=${result.token}; HttpOnly; Path=/; Max-Age=${TOKEN_MAX_AGE}; SameSite=Lax`);
        sendJson(res, 200, result);
      } catch (e) { sendError(res, 400, e.message); }
      return;
    }
    if (route === "message") {
      if (req.method !== "POST") { sendError(res, 405, "Method Not Allowed"); return; }
      if (!rateLimit(ip, false)) { sendError(res, 429, "请求过于频繁"); return; }
      const body = JSON.parse((await readBody(req)) || "{}");
      await ensureDb();
      try {
        sendJson(res, 200, await handleMessage(body, req));
      } catch (e) { sendError(res, 400, e.message); }
      return;
    }
    if (route === "public/message") {
      if (req.method !== "POST") { sendError(res, 405, "Method Not Allowed"); return; }
      const body = JSON.parse((await readBody(req)) || "{}");
      await ensureDb();
      try {
        sendJson(res, 200, await handlePublicMessage(body, req));
      } catch (e) { sendError(res, 400, e.message); }
      return;
    }

    // 数据上报接口（需要令牌）
    if (route === "track/view") {
      if (req.method !== "POST") { sendError(res, 405, "Method Not Allowed"); return; }
      const body = JSON.parse((await readBody(req)) || "{}");
      await ensureDb();
      sendJson(res, 200, handleTrackView(body, req));
      return;
    }
    if (route === "track/duration") {
      if (req.method !== "POST") { sendError(res, 405, "Method Not Allowed"); return; }
      const body = JSON.parse((await readBody(req)) || "{}");
      await ensureDb();
      sendJson(res, 200, handleTrackDuration(body, req));
      return;
    }
    if (route === "track/heartbeat") {
      await ensureDb();
      sendJson(res, 200, handleTrackHeartbeat(req));
      return;
    }

    // 数据后台接口（需要管理员密码）
    if (route === "admin/stats") {
      const adminKey = query.key || getCookie(req, "admin_key");
      if (adminKey !== ADMIN_PASSWORD) {
        sendError(res, 403, "无权访问");
        return;
      }
      await ensureDb();
      sendJson(res, 200, handleAdminStats());
      return;
    }
    if (route === "admin/invite/list") {
      const adminKey = query.key || getCookie(req, "admin_key");
      if (adminKey !== ADMIN_PASSWORD) { sendError(res, 403, "无权访问"); return; }
      await ensureDb();
      sendJson(res, 200, handleAdminInviteList(query));
      return;
    }
    if (route === "admin/invite/create") {
      if (req.method !== "POST") { sendError(res, 405, "Method Not Allowed"); return; }
      const adminKey = query.key || getCookie(req, "admin_key");
      if (adminKey !== ADMIN_PASSWORD) { sendError(res, 403, "无权访问"); return; }
      const body = JSON.parse((await readBody(req)) || "{}");
      await ensureDb();
      try {
        sendJson(res, 200, handleAdminInviteCreate(body));
      } catch (e) { sendError(res, 400, e.message); }
      return;
    }
    if (route === "admin/invite/delete") {
      if (req.method !== "POST") { sendError(res, 405, "Method Not Allowed"); return; }
      const adminKey = query.key || getCookie(req, "admin_key");
      if (adminKey !== ADMIN_PASSWORD) { sendError(res, 403, "无权访问"); return; }
      const body = JSON.parse((await readBody(req)) || "{}");
      await ensureDb();
      try {
        sendJson(res, 200, handleAdminInviteDelete(body));
      } catch (e) { sendError(res, 400, e.message); }
      return;
    }

    // 普通接口频率限制
    if (!rateLimit(ip, false)) { sendError(res, 429, "请求过于频繁，每 IP 每分钟限 30 次"); return; }

    // providers 等轻量接口不需要加载数据库，优先快速响应
    if (route === "providers") {
      sendJson(res, 200, handleProviders());
      return;
    }

    // 图片代理（用树洞 Token 抓取图片，流式返回给前端）
    if (route === "image") {
      const pid = parseInt(query.pid, 10);
      const idx = parseInt(query.idx, 10) || 0;
      if (!pid || pid < 1) { sendError(res, 400, "无效的 pid"); return; }
      if (!PKU_TOKEN) { sendError(res, 500, "服务器未配置树洞 Token"); return; }
      const imgUrl = `${PKU_API_BASE}pku_image/${pid}?img_idx=${idx}`;
      const imgReq = https.get(imgUrl, {
        headers: {
          "authorization": "Bearer " + PKU_TOKEN,
          "uuid": PKU_UUID,
          "referer": "https://treehole.pku.edu.cn/web/",
          "user-agent": "Mozilla/5.0",
        }
      }, (imgRes) => {
        if (imgRes.statusCode !== 200) {
          sendError(res, imgRes.statusCode, "图片获取失败");
          imgRes.resume();
          return;
        }
        const contentType = imgRes.headers["content-type"] || "image/jpeg";
        res.writeHead(200, {
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=86400",
          "Access-Control-Allow-Origin": "*",
        });
        imgRes.pipe(res);
      });
      imgReq.on("error", (e) => { sendError(res, 502, "图片代理失败: " + e.message); });
      imgReq.setTimeout(10000, () => { imgReq.destroy(); sendError(res, 504, "图片获取超时"); });
      return;
    }

    await ensureDb();

    let result;
    switch (route) {
      case "stats":     result = handleStats(); break;
      case "hot":       result = handleHot(query); break;
      case "search":    result = handleSearch(query); break;
      case "show":      result = handleShow(query); break;
      case "trend":     result = handleTrend(query); break;
      default:          sendError(res, 404, `未知路由: /api/${route}`); return;
    }
    sendJson(res, 200, result);
  } catch (e) {
    console.error("[error]", e.message);
    const status = e.message.includes("不存在") || e.message.includes("未找到") ? 404
      : e.message.includes("无效") || e.message.includes("不能为空") || e.message.includes("过长") ? 400 : 500;
    sendError(res, status, e.message);
  }
});

// HTTP 服务器入口：监听指定端口
server.listen(PORT, () => { console.log(`[treehole-api] 服务启动，监听端口 ${PORT}`); });
