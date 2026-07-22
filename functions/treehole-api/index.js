/**
 * AutoTreehole 分析 API — HTTP 服务
 *
 * 功能：直接读取本地 treehole.db，提供帖子查询、搜索、详情、统计、AI报告接口。
 * 安全：CORS、请求频率限制、输入校验、SQL 参数化、Markdown XSS 防护。
 * 数据库：better-sqlite3（原生模块，直读本地 SQLite 文件）。
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../../.env") });

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
// 站点公开地址（用于邮件内链接，如 https://autoth.example.com）
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
// 留言频率限制（防邮箱轰炸，但不过严以免误伤正常用户）
const MESSAGE_IP_HOURLY_LIMIT = 3;   // 每 IP 每小时最多 3 条
const MESSAGE_IP_DAILY_LIMIT = 8;    // 每 IP 每天最多 8 条
const MESSAGE_GLOBAL_HOURLY_LIMIT = 50; // 全局每小时最多 50 条（避免大批正常用户同时留言被误限）

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

// Agent 接入：个人 API Token 限流（独立桶，按 token）
const AGENT_RATE_PER_MIN = 20;    // 每 token 每分钟
const AGENT_RATE_PER_DAY = 500;   // 每 token 每天
const AGENT_GLOBAL_PER_MIN = 60;  // 全局每分钟（保护小机器）
const AGENT_MAX_TOKENS_PER_USER = 3;  // 每账号最多 Token 数
const AGENT_LIST_LIMIT = 30;      // 列表接口单次最大返回数
const AGENT_DIGEST_DEFAULT_DAYS = 3;  // digest 默认回看天数

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
  qwen:      { key: "DASHSCOPE_API_KEY", url: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", model: "qwen-flash",        fmt: "openai", public: true,
    models: ["qwen-flash", "qwen-turbo", "qwen-plus", "qwen-max"] },
  glm:       { key: "GLM_API_KEY",       url: "https://open.bigmodel.cn/api/paas/v4/chat/completions",              model: "glm-4.6",          fmt: "openai", public: false,
    models: ["glm-4.6", "glm-4.5", "glm-4.5-flash"] },
};

// ==================== 频率限制 ====================
const rateBuckets = new Map();
// Agent Token 限流桶：token_hash -> { min:[ts], day:[ts] }
const agentRateBuckets = new Map();
let agentGlobalMin = []; // 全局每分钟计数
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

/**
 * Agent Token 限流（独立桶，按 token_hash 计量）
 * @returns {boolean} true=允许，false=超限
 */
function agentRateLimit(tokenHash) {
  const now = Date.now();
  let b = agentRateBuckets.get(tokenHash);
  if (!b) { b = { min: [], day: [] }; agentRateBuckets.set(tokenHash, b); }
  // 每 token 每分钟
  b.min = b.min.filter((t) => now - t < RATE_WINDOW_MS);
  if (b.min.length >= AGENT_RATE_PER_MIN) return false;
  // 每 token 每天
  b.day = b.day.filter((t) => now - t < DAY_MS);
  if (b.day.length >= AGENT_RATE_PER_DAY) return false;
  // 全局每分钟
  agentGlobalMin = agentGlobalMin.filter((t) => now - t < RATE_WINDOW_MS);
  if (agentGlobalMin.length >= AGENT_GLOBAL_PER_MIN) return false;
  // 通过，记录
  b.min.push(now); b.day.push(now); agentGlobalMin.push(now);
  return true;
}

// 清理 Agent 限流桶
setInterval(() => {
  const now = Date.now();
  for (const [h, b] of agentRateBuckets) {
    if (b.min.every((t) => now - t >= RATE_WINDOW_MS) && b.day.every((t) => now - t >= DAY_MS)) {
      agentRateBuckets.delete(h);
    }
  }
}, RATE_WINDOW_MS);

// ==================== 安全告警系统 ====================
// 任何报错/超频/攻击/服务失败/可疑用户事件 → 入库 alert_logs + 邮件通知站长
// 节流：同 type 事件 ALERT_THROTTLE_MS 内只发一封邮件（但每次都入库，保证日志完整）
const ALERT_THROTTLE_MS = 10 * 60_000; // 10 分钟
const alertLastNotify = new Map(); // type -> 上次发邮件时间戳

// 告警级别 → 邮件主题前缀 + emoji
const ALERT_LEVEL_META = {
  info:    { tag: "[告警-信息]", emoji: "ℹ️" },
  warn:    { tag: "[告警-警告]", emoji: "⚠️" },
  error:   { tag: "[告警-严重]", emoji: "🚨" },
};

/**
 * 记录安全告警：入库 + 邮件通知（带节流）
 * @param {string} level   - info / warn / error
 * @param {string} type    - rate_limit / ssrf / brute_force / server_error / suspicious / token_warn
 * @param {string} subject - 一句话概述
 * @param {string} detail  - 详细信息（可选）
 * @param {string} ip      - 来源 IP（可选）
 */
function alertAdmin(level, type, subject, detail = "", ip = "") {
  const now = Date.now();
  const ts = new Date(now).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  // 1) 入库（每次都记，保证日志完整）
  let notified = 0;
  try {
    if (db) {
      db.prepare(
        "INSERT INTO alert_logs (level, type, subject, detail, ip, notified, created_at) VALUES (?,?,?,?,?,?,?)"
      ).run(level, type, subject, detail.slice(0, 4000), ip, 0, Math.floor(now / 1000));
    }
  } catch (e) { /* 入库失败不阻断主流程 */ }

  // 2) 节流：同 type 10 分钟内只发一封邮件
  const last = alertLastNotify.get(type) || 0;
  if (now - last < ALERT_THROTTLE_MS) {
    return; // 节流期内，仅入库不发邮件
  }
  alertLastNotify.set(type, now);
  notified = 1;
  try {
    if (db) {
      db.prepare("UPDATE alert_logs SET notified = 1 WHERE id = last_insert_rowid()").run();
    }
  } catch (e) { /* ignore */ }

  // 3) 发邮件
  if (!SITE_OWNER_EMAIL || !MAIL_USER) return;
  const meta = ALERT_LEVEL_META[level] || ALERT_LEVEL_META.warn;
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#F5F5F7;border-radius:12px;">
    <h2 style="color:#1D1D1F;font-size:18px;font-weight:600;margin-bottom:20px;">${meta.emoji} AutoTreehole 安全告警</h2>
    <table style="width:100%;font-size:14px;color:#1D1D1F;line-height:1.8;margin-bottom:20px;">
      <tr><td style="color:#86868B;width:90px;vertical-align:top;">级别</td><td><b>${level.toUpperCase()}</b></td></tr>
      <tr><td style="color:#86868B;vertical-align:top;">类型</td><td>${type}</td></tr>
      <tr><td style="color:#86868B;vertical-align:top;">事件</td><td>${esc(subject)}</td></tr>
      <tr><td style="color:#86868B;vertical-align:top;">来源 IP</td><td>${esc(ip) || "未知"}</td></tr>
      <tr><td style="color:#86868B;vertical-align:top;">时间</td><td>${ts}</td></tr>
    </table>
    ${detail ? `<div style="background:#fff;border-radius:8px;padding:20px 24px;"><p style="color:#1D1D1F;font-size:13px;line-height:1.8;white-space:pre-wrap;">${esc(detail)}</p></div>` : ""}
    <p style="color:#86868B;font-size:12px;margin-top:16px;">此邮件由 AutoTreehole 告警系统自动发送 · 同类事件 10 分钟内仅通知一次，完整日志见数据后台</p>
  </div>`;
  getMailer().sendMail({
    from: MAIL_FROM,
    to: SITE_OWNER_EMAIL,
    subject: `${meta.tag} ${subject.slice(0, 60)}`,
    html,
  }).then(() => {
    console.log(`[alert] 已通知站长: [${level}] ${type} - ${subject}`);
  }).catch(e => {
    console.error(`[alert] 邮件发送失败: ${e.message}`);
    alertLastNotify.delete(type); // 发送失败则重置节流，允许下次重试
  });
}

// 定时清理节流记录，避免内存泄漏
setInterval(() => {
  const now = Date.now();
  for (const [type, t] of alertLastNotify) {
    if (now - t >= ALERT_THROTTLE_MS) alertLastNotify.delete(type);
  }
}, 3600_000);

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
  // 仅信任 nginx 设置的 X-Real-IP（nginx 用 $remote_addr 覆盖，客户端无法伪造）
  // 不信任 X-Forwarded-For（nginx 用 $proxy_add_x_forwarded_for 追加，客户端可伪造）
  const real = req.headers["x-real-ip"];
  if (real && typeof real === "string") return real.trim();
  const raw = req.socket.remoteAddress || "unknown";
  return raw.replace(/^::ffff:/, "");
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

/** 退订确认 HTML 页（邮件链接点击后展示） */
function sendUnsubHtml(res, message) {
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>退订确认</title></head>
  <body style="font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;background:#F5F5F7;margin:0;padding:48px 24px;">
    <div style="max-width:420px;margin:0 auto;background:#fff;border-radius:12px;padding:40px 32px;text-align:center;">
      <div style="font-size:40px;margin-bottom:16px;">✓</div>
      <h1 style="color:#1D1D1F;font-size:20px;font-weight:600;margin:0 0 12px;">退订成功</h1>
      <p style="color:#86868B;font-size:14px;line-height:1.6;margin:0;">${message}</p>
      <p style="color:#86868B;font-size:12px;margin-top:24px;">你将不再收到该关键词的推送邮件。如需重新订阅，请前往 AutoTreehole 网站订阅页。</p>
    </div>
  </body></html>`;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

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

/** HTML 转义（用于邮件正文，防止帖子内容破坏 HTML / 注入） */
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function validateInt(val, min, max, def) {
  const n = parseInt(val, 10);
  if (isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}

/** 判断 IP 字符串是否为内网/本地/链路本地地址（IPv4 + IPv6） */
function isPrivateIP(ip) {
  const s = String(ip).toLowerCase();
  // IPv4
  if (/^127\./.test(s) || /^10\./.test(s) || /^192\.168\./.test(s)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(s)) return true;
  if (/^169\.254\./.test(s)) return true;
  if (/^0\./.test(s) || s === "0.0.0.0") return true;
  // IPv4-mapped IPv6
  if (/^::ffff:/.test(s)) {
    const v4 = s.replace(/^::ffff:/, "");
    return isPrivateIP(v4);
  }
  // IPv6 本地回环 / ULA / link-local
  if (s === "::1" || s === "localhost") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(s)) return true;   // fc00::/7 ULA
  if (/^fe[89ab][0-9a-f]:/.test(s)) return true;    // fe80::/10 link-local
  return false;
}

/** 安全校验：禁止 LLM 请求指向内网/本地/元数据地址（防 SSRF）
 *  异步版本：先做字符串黑名单快检，再 DNS 解析后校验所有返回 IP（防 DNS rebinding） */
async function assertSafeUrl(rawUrl) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw new Error("API URL 格式无效"); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("API URL 协议无效（仅允许 http/https）");
  }
  const host = parsed.hostname.toLowerCase();
  // 第一层：字符串黑名单快检（拦截字面量内网地址）
  if (host === "localhost" || host === "::1" || host === "0.0.0.0" || isPrivateIP(host)) {
    throw new Error("不允许指向本地/内网地址");
  }
  // 第二层：DNS 解析后校验所有返回的 IP（防 DNS rebinding：域名解析到内网）
  const dns = require("dns").promises;
  try {
    const addrs = await dns.lookup(host, { all: true });
    for (const { address } of addrs) {
      if (isPrivateIP(address)) {
        throw new Error(`不允许指向内网地址（${host} → ${address}）`);
      }
    }
  } catch (e) {
    // DNS 解析失败：若 host 是 IP 字面量则已被第一层拦截；若是域名解析失败则放行让 fetch 自行报错
    if (e.message && e.message.includes("不允许指向")) throw e;
    // 其他 DNS 错误（ENOTFOUND 等）不拦截，交给 fetch 处理
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
    CREATE TABLE IF NOT EXISTS favorites (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_email TEXT NOT NULL,
      pid        INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(user_email, pid)
    );
    CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_email);
    CREATE INDEX IF NOT EXISTS idx_favorites_pid ON favorites(pid);
    CREATE TABLE IF NOT EXISTS subscriptions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_email   TEXT NOT NULL,
      notify_email TEXT NOT NULL,
      keyword      TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      UNIQUE(user_email, keyword)
    );
    CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_email);
    CREATE INDEX IF NOT EXISTS idx_subs_keyword ON subscriptions(keyword);
    CREATE TABLE IF NOT EXISTS subscription_sent (
      sub_id  INTEGER NOT NULL,
      pid     INTEGER NOT NULL,
      sent_at INTEGER NOT NULL,
      PRIMARY KEY(sub_id, pid)
    );
    CREATE INDEX IF NOT EXISTS idx_sub_sent_sub ON subscription_sent(sub_id);
    CREATE TABLE IF NOT EXISTS sub_meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS alert_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      level      TEXT NOT NULL,        -- info / warn / error
      type       TEXT NOT NULL,        -- rate_limit / ssrf / brute_force / server_error / suspicious / token_warn
      subject    TEXT NOT NULL,
      detail     TEXT,
      ip         TEXT,
      notified   INTEGER DEFAULT 0,    -- 是否已发邮件（1=已发，0=节流未发）
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alert_logs_created ON alert_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_alert_logs_type ON alert_logs(type, created_at);
    CREATE TABLE IF NOT EXISTS weekly_reports (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      week_start INTEGER NOT NULL,   -- 上周一 00:00（上海时间）的时间戳（秒）
      week_end   INTEGER NOT NULL,   -- 本周一 00:00（上海时间）的时间戳（秒）
      content    TEXT NOT NULL,      -- 已 enrich 的 Markdown 周报
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_weekly_reports_start ON weekly_reports(week_start);

    -- 树洞周报邮件订阅：每周一生成周报后自动发送给订阅用户
    CREATE TABLE IF NOT EXISTS weekly_report_subscriptions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_email  TEXT NOT NULL,
      notify_email TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      UNIQUE(user_email)
    );
    CREATE INDEX IF NOT EXISTS idx_weekly_report_subs_user ON weekly_report_subscriptions(user_email);

    -- Agent 接入：用户个人 API Token（仅 PKU 邮箱用户可用）
    CREATE TABLE IF NOT EXISTS agent_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_email TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,   -- 存 SHA-256 hash，不存明文
      label TEXT DEFAULT '',
      last_used_at INTEGER DEFAULT 0,
      call_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER DEFAULT 0       -- 0=有效，>0=已撤销
    );
    CREATE INDEX IF NOT EXISTS idx_agent_tokens_hash ON agent_tokens(token_hash);
    CREATE INDEX IF NOT EXISTS idx_agent_tokens_user ON agent_tokens(user_email);
  `);
  // 兼容已存在的表：补充 pledged 字段
  try {
    db.exec("ALTER TABLE users ADD COLUMN pledged INTEGER DEFAULT 0");
  } catch (e) { /* 字段已存在则忽略 */ }
  // 兼容已存在的表：补充 verify_codes.ip 字段（用于每 IP 每日验证次数限制）
  try {
    db.exec("ALTER TABLE verify_codes ADD COLUMN ip TEXT DEFAULT ''");
    db.exec("CREATE INDEX IF NOT EXISTS idx_verify_codes_ip ON verify_codes(ip, sent_at)");
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

async function callLlm(system, user, provider, customConfig, ip = "") {
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
    // 安全：阻断 SSRF —— 禁止指向内网/本地地址（含 DNS rebinding 防护）
    try {
      await assertSafeUrl(url);
    } catch (ssrfErr) {
      alertAdmin("error", "ssrf", "检测到 SSRF 攻击尝试", `用户提交的 LLM URL 被安全策略拦截: ${url}\n原因: ${ssrfErr.message}`, ip);
      throw ssrfErr;
    }
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
    // 识别限额/速率限制：HTTP 429 或错误体含 quota/rate_limit/exceeded 等
    if (resp.status === 429 || /quota|rate.?limit|exceeded|too many|余额不足|频率|limit reached/i.test(text)) {
      const e = new Error(`模型繁忙或已达限额（${resp.status}），请稍后再试或更换模型`);
      e.code = "QUOTA";
      throw e;
    }
    throw new Error(`LLM HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  const data = await resp.json();
  // minimax 限额时 HTTP 可能 200，但 base_resp.status_code 非 0
  if (data && data.base_resp && data.base_resp.status_code && data.base_resp.status_code !== 0) {
    const msg = data.base_resp.status_msg || "";
    if (/quota|limit|exceeded|余额|频率/i.test(msg)) {
      const e = new Error(`模型繁忙或已达限额，请稍后再试或更换模型`);
      e.code = "QUOTA";
      throw e;
    }
  }
  if (isAnthropic) return data.content[0].text;
  return data.choices[0].message.content;
}

/**
 * 带 fallback 的 LLM 调用：public 模式下 minimax 达限额时自动改用 qwen 重试。
 * 仅在服务器 Key 代理（非自定义 customConfig）且 provider 为 minimax 时触发 fallback。
 * customConfig 模式（用户自带 Key）不 fallback，直接抛出由前端提示。
 */
async function callLlmWithFallback(system, user, provider, customConfig, ip = "") {
  try {
    return await callLlm(system, user, provider, customConfig, ip);
  } catch (e) {
    const canFallback = !customConfig
      && provider === "minimax"
      && e.code === "QUOTA"
      && LLM_PROVIDERS.qwen
      && process.env[LLM_PROVIDERS.qwen.key];
    if (!canFallback) throw e;
    console.log(`[llm] minimax 限额，自动 fallback 到 qwen`);
    return await callLlm(system, user, "qwen", null, ip);
  }
}

// ==================== 报告后处理 ====================
function enrichReport(content) {
  const HOLE_PID_MIN = 10000;
  // 报告中的原洞链接指向本站内部详情页（/?pid=PID#detail），不跳转外部树洞平台
  const URL_TPL = "/?pid=";

  // 提取所有被引用的洞号（去重保序）
  const pids = [];
  const seen = new Set();
  for (const m of content.matchAll(/#(\d+)/g)) {
    const pid = parseInt(m[1], 10);
    if (pid >= HOLE_PID_MIN && !seen.has(pid)) { seen.add(pid); pids.push(pid); }
  }

  // 超链接化（指向本站详情页）
  const enriched = content.replace(/#(\d+)/g, (match, num) => {
    const pid = parseInt(num, 10);
    return pid >= HOLE_PID_MIN ? `[#${pid}](${URL_TPL}${pid}#detail)` : match;
  });

  if (!pids.length) return enriched;

  // 查库取原文
  const rows = queryPostsByPids(pids);
  const rowMap = new Map(rows.map((r) => [r.pid, r]));

  let appendix = "\n\n---\n\n## 被引用帖子原文\n\n";
  for (const pid of pids) {
    const r = rowMap.get(pid);
    if (r) {
      appendix += `### [#${pid}](${URL_TPL}${pid}#detail)\n- 时间：${fmtTime(r.timestamp)}　收藏：${r.likenum}　评论：${r.reply}\n- 原文：\n\n> ${(r.text || "").trim()}\n\n`;
    } else {
      appendix += `### [#${pid}](${URL_TPL}${pid}#detail)\n\n> （数据库中未找到该帖子）\n\n`;
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
    if (!posts.length) throw new Error("未找到与该关键词相关的帖子");
    promptData = buildKeywordPrompt(posts, keywords, useful.length);
  } else {
    const useful = filterUseful(queryWeekPosts(days));
    posts = sampleForLlm(useful).posts;
    if (!posts.length) throw new Error(`最近 ${days} 天无有效帖子`);
    promptData = buildWeekPrompt(posts, days, useful.length);
  }

  try {
    const content = await callLlmWithFallback(promptData.system, promptData.user, provider, customConfig, ip);
    logReportCall(ip, provider, mode, true);
    return { content: enrichReport(content) };
  } catch (e) {
    logReportCall(ip, provider, mode, false, e.message);
    throw e;
  }
}

// ==================== 树洞周报（每周一自动生成，所有用户可读） ====================
/**
 * 计算上周（上海时区 UTC+8，周一起算）的 [week_start, week_end) 时间戳（秒）。
 * week_start = 上周一 00:00（上海），week_end = 本周一 00:00（上海）。
 */
function lastWeekRangeShanghai() {
  const SH_OFFSET_MS = 8 * 3600_000;
  const shNow = new Date(Date.now() + SH_OFFSET_MS); // UTC 字段即上海墙上时间
  const day = shNow.getUTCDay(); // 0=周日, 1=周一, ..., 6=周六
  const monIdx = (day + 6) % 7;   // 周一=0, 周二=1, ..., 周日=6
  // 上海本周一 00:00 的绝对时刻 = Date.UTC(本周一日期) - 8h
  const thisMonMs = Date.UTC(shNow.getUTCFullYear(), shNow.getUTCMonth(), shNow.getUTCDate() - monIdx) - SH_OFFSET_MS;
  const lastMonMs = thisMonMs - 7 * 86_400_000;
  return { week_start: Math.floor(lastMonMs / 1000), week_end: Math.floor(thisMonMs / 1000) };
}

function buildWeeklyReportPrompt(rows, weekStart, weekEnd, totalUseful, sampled) {
  const startStr = fmtTime(weekStart);
  const endStr = fmtTime(weekEnd - 1);
  const sampleNote = sampled
    ? `\n注：上周有效帖 ${totalUseful} 条过多，已按热度取前 ${rows.length} 条传入分析。` : "";
  const system = "你是资深高校校园动态分析师。基于北京大学树洞（匿名论坛）上周的帖子，撰写一份面向全体用户的「树洞周报」。结构清晰、观点中肯、语言自然、可读性强。帖子为匿名内容，含口语与情绪表达，需客观提炼而非照搬。对明显不实或极端信息，理性提示不扩散。";
  const user = `以下是北京大学树洞上周（${startStr} 至 ${endStr}）的 ${rows.length} 条帖子（已过滤无意义内容）。${sampleNote}

${formatPostsBlock(rows)}

请撰写一份面向全体用户的「树洞周报」，使用 Markdown 格式，严格包含以下结构：

## 一、本周热点回顾
按主题分类归纳上周最受关注的讨论，每个主题用 1-2 段详述，概括帖子实际内容，并在每条信息后标注来源洞号，格式「(#pid)」。

## 二、值得关注的时事
上周与校园政策、社会热点、新闻事件相关的内容；如无明显时事，说明话题以日常为主并简述倾向。

## 三、实用信息汇总
对北大学生有实际参考价值的信息（如选课、考试、活动、招聘、生活服务等），逐条列出并标注来源洞号「(#pid)」。

## 四、社区情绪与氛围
分析上周整体情绪基调，引用代表性帖子洞号佐证。

## 五、本周小结
2-3 句话概括上周树洞趋势。

要求：
- 全程中文，客观不编造帖子中不存在的内容
- 所有实质性内容必须标注来源洞号「(#pid)」，不得虚构洞号
- 概括实际内容，不要只列编号
- 篇幅充实，重点突出，避免空话套话，适合一般用户快速阅读
- 不要在最前面加「# 北大树洞周报」之类的总标题，直接从「## 一、本周热点回顾」开始；文中也不得出现「北大树洞周报」字样，统一用「树洞周报」`;
  return { system, user };
}

/**
 * 生成上周树洞周报并入库（幂等：同一周只生成一次）。
 * 由定时器每周一凌晨触发，启动时也会补跑漏掉的最近一周。
 */
async function generateWeeklyReport() {
  await ensureDb();
  const { week_start, week_end } = lastWeekRangeShanghai();
  // 幂等：该周周报已存在则跳过
  if (queryOne("SELECT id FROM weekly_reports WHERE week_start = ?", [week_start])) {
    console.log(`[weekly] 上周周报已存在 (week_start=${week_start})，跳过生成`);
    return;
  }
  const rows = queryAll(
    "SELECT pid, text, timestamp, likenum, reply, COALESCE(deleted,0) as deleted FROM holes WHERE timestamp >= ? AND timestamp < ? ORDER BY pid ASC",
    [week_start, week_end]
  );
  if (!rows.length) { console.log("[weekly] 上周无帖子，跳过周报生成"); return; }
  const useful = filterUseful(rows);
  if (!useful.length) { console.log("[weekly] 上周无有效帖子，跳过周报生成"); return; }
  const { posts, sampled } = sampleForLlm(useful);
  const promptData = buildWeeklyReportPrompt(posts, week_start, week_end, useful.length, sampled);
  console.log(`[weekly] 开始生成周报：上周有效帖 ${useful.length} 条，传入 ${posts.length} 条`);
  try {
    const content = await callLlmWithFallback(promptData.system, promptData.user, "minimax", null, "system-weekly");
    const enriched = enrichReport(content);
    db.prepare(
      "INSERT INTO weekly_reports (week_start, week_end, content, created_at) VALUES (?,?,?,?)"
    ).run(week_start, week_end, enriched, Math.floor(Date.now() / 1000));
    console.log(`[weekly] 周报生成成功并入库 (week_start=${week_start})`);
    // 异步推送给订阅者，失败不影响主流程
    const reportRow = { week_start, week_end, content: enriched };
    sendWeeklyReportToSubscribers(reportRow).catch(e => console.error("[weekly] 订阅邮件发送失败:", e.message));
  } catch (e) {
    console.error(`[weekly] 周报生成失败: ${e.message}`);
  }
}

/** 返回树洞周报：不带 week_start 时返回最近若干期列表（含摘要），带 week_start 返回单期全文 */
function handleWeeklyReport(query) {
  // 单期详情
  if (query && query.week_start) {
    const ws = parseInt(query.week_start, 10);
    if (!ws) return { available: false };
    const row = queryOne(
      "SELECT week_start, week_end, content, created_at FROM weekly_reports WHERE week_start = ?", [ws]
    );
    if (!row) return { available: false };
    return { available: true, week_start: row.week_start, week_end: row.week_end, content: row.content, created_at: row.created_at };
  }
  // 列表（最近 4 期，含摘要不含全文，避免传输过大）
  const rows = queryAll(
    "SELECT week_start, week_end, content, created_at FROM weekly_reports ORDER BY week_start DESC LIMIT 4"
  );
  if (!rows.length) return { available: false, reports: [] };
  const reports = rows.map((r) => {
    const plain = (r.content || "")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/[#*`>\[\]()_]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return {
      week_start: r.week_start,
      week_end: r.week_end,
      created_at: r.created_at,
      summary: plain.slice(0, 120),
    };
  });
  return { available: true, reports };
}

// ==================== 树洞周报邮件订阅 ====================

function handleWeeklyReportSubStatus(req) {
  const payload = verifyToken(getCookie(req, "treehole_token"));
  if (!payload) return { loggedIn: false, subscribed: false };
  const email = payload.email;
  const row = queryOne("SELECT id FROM weekly_report_subscriptions WHERE user_email = ?", [email]);
  return { loggedIn: true, subscribed: !!row };
}

function handleWeeklyReportSubscribe(req) {
  const payload = verifyToken(getCookie(req, "treehole_token"));
  if (!payload) throw new Error("未登录");
  const email = payload.email;
  // 邀请码为一次性凭证，不具备周报订阅资格（仅校园邮箱登录用户可订阅）
  if (isInviteUser(email)) throw new Error("周报订阅仅对校园邮箱登录用户开放");
  const notifyEmail = email;
  const now = Math.floor(Date.now() / 1000);
  try {
    db.prepare("INSERT INTO weekly_report_subscriptions (user_email, notify_email, created_at) VALUES (?, ?, ?)")
      .run(email, notifyEmail, now);
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) throw new Error("你已经订阅了周报");
    throw e;
  }
  return { success: true };
}

function handleWeeklyReportUnsubscribe(req) {
  const payload = verifyToken(getCookie(req, "treehole_token"));
  if (!payload) throw new Error("未登录");
  const email = payload.email;
  db.prepare("DELETE FROM weekly_report_subscriptions WHERE user_email = ?").run(email);
  return { success: true };
}

async function sendWeeklyReportToSubscribers(report) {
  if (!db) return;
  try {
    const subs = queryAll("SELECT user_email, notify_email FROM weekly_report_subscriptions");
    if (!subs.length) {
      console.log("[weekly] 无周报订阅用户，跳过邮件发送");
      return;
    }
    const weekRange = `${fmtTime(report.week_start).slice(0, 10)} ~ ${fmtTime(report.week_end - 1).slice(0, 10)}`;
    const siteLink = PUBLIC_BASE_URL
      ? `<a href="${PUBLIC_BASE_URL}/" style="color:#86868B;">前往 AutoTreehole 阅读全文</a>`
      : `<span style="color:#86868B;">前往 AutoTreehole 阅读全文</span>`;
    const plainSummary = (report.content || "")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/[#*`>\[\]()_]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
    const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#F5F5F7;border-radius:12px;">
      <h2 style="color:#1D1D1F;font-size:18px;font-weight:600;margin-bottom:6px;">树洞周报 · ${esc(weekRange)}</h2>
      <p style="color:#86868B;font-size:12px;margin-bottom:20px;">本周树洞周报已生成，为你自动推送。</p>
      <div style="background:#fff;border-radius:8px;padding:20px 24px;margin-bottom:16px;">
        <p style="color:#1D1D1F;font-size:14px;line-height:1.8;margin:0;">${esc(plainSummary)}……</p>
      </div>
      <p style="color:#86868B;font-size:11px;margin-top:20px;text-align:center;">
        ${siteLink}
      </p>
      <p style="color:#86868B;font-size:11px;margin-top:12px;text-align:center;">
        如需取消订阅，请在网站「AI 报告」页点击「已订阅」按钮退订。
      </p>
    </div>`;
    for (const sub of subs) {
      try {
        await getMailer().sendMail({
          from: MAIL_FROM,
          to: sub.notify_email,
          subject: `树洞周报 · ${weekRange}`,
          html,
        });
        console.log(`[weekly] 已发送周报到 ${sub.notify_email}`);
      } catch (e) {
        console.error(`[weekly] 发送周报邮件失败 ${sub.notify_email}: ${e.message}`);
      }
    }
  } catch (e) {
    console.error(`[weekly] 发送周报邮件异常: ${e.message}`);
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
    if (!posts.length) throw new Error("未找到与该关键词相关的帖子");
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
  // 恒时比较，防计时攻击
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
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

/**
 * 数据接口鉴权：校验登录令牌 + 承诺状态，防匿名爬取帖子内容。
 * @returns {string|null} 已登录且已承诺的用户 email，否则 null
 */
function requireAuth(req) {
  const payload = verifyToken(getCookie(req, "treehole_token"));
  if (!payload) return null;
  const user = queryOne("SELECT pledged FROM users WHERE email = ?", [payload.email]);
  if (!user || !user.pledged) return null;
  return payload.email;
}

// ==================== Agent 接入 ====================

/** 生成 Agent API Token 明文：ath_<22位 base64url 随机> */
function generateAgentToken() {
  return "ath_" + crypto.randomBytes(16).toString("base64url").slice(0, 22);
}

/** Token 明文 → SHA-256 hash（只存 hash） */
function hashAgentToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** 邀请码用户不开放 Agent 功能 */
function canUseAgent(user_email) {
  return !!(user_email && !user_email.startsWith("invite:"));
}

/**
 * Agent 接口 Bearer Token 鉴权
 * @returns {{email:string, tokenId:number, tokenHash:string}|null}
 */
function authAgent(req) {
  const auth = req.headers["authorization"] || "";
  const m = auth.match(/^Bearer\s+(ath_\S+)$/i);
  if (!m) return null;
  const tokenHash = hashAgentToken(m[1]);
  const row = queryOne(
    "SELECT id, user_email, revoked_at FROM agent_tokens WHERE token_hash = ?", [tokenHash]
  );
  if (!row || row.revoked_at > 0) return null;
  if (!canUseAgent(row.user_email)) return null;
  // 异步更新使用统计（不阻塞响应）
  const now = Math.floor(Date.now() / 1000);
  try {
    db.prepare("UPDATE agent_tokens SET last_used_at = ?, call_count = call_count + 1 WHERE id = ?")
      .run(now, row.id);
  } catch (e) { /* ignore */ }
  return { email: row.user_email, tokenId: row.id, tokenHash };
}

/** 帖子列表字段精简（正文截断 140 字，省 Agent token） */
function slimPost(p) {
  const text = (p.text || "").replace(/[\x00-\x1f\x7f]/g, "").trim();
  return {
    pid: p.pid,
    timestamp: p.timestamp,
    category: p.category || p.type || "其他",
    preview: text.slice(0, 140),
    likenum: p.likenum,
    reply: p.reply,
  };
}

/** Agent 查询函数：最新帖 */
function agentLatest(limit) {
  return queryAll(
    "SELECT pid, text, timestamp, likenum, reply, type, COALESCE(category,'其他') as category FROM holes ORDER BY pid DESC LIMIT ?",
    [limit]
  ).map(slimPost);
}

/** Agent 查询函数：热帖 */
function agentHot(days, limit) {
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  return queryAll(
    "SELECT pid, text, timestamp, likenum, reply, type, COALESCE(category,'其他') as category FROM holes WHERE timestamp >= ? ORDER BY likenum DESC, pid DESC LIMIT ?",
    [since, limit]
  ).map(slimPost);
}

/** Agent 查询函数：搜索 */
function agentSearch(keyword, limit) {
  const like = `%${keyword}%`;
  return queryAll(
    "SELECT pid, text, timestamp, likenum, reply, type, COALESCE(category,'其他') as category FROM holes WHERE text LIKE ? ORDER BY likenum DESC, pid DESC LIMIT ?",
    [like, limit]
  ).map(slimPost);
}

/** Agent 查询函数：帖子详情（含评论全文） */
function agentPost(pid) {
  const post = queryOne(
    "SELECT pid, text, type, timestamp, reply, likenum, tag, COALESCE(category,'其他') as category FROM holes WHERE pid = ?",
    [pid]
  );
  if (!post) return null;
  const comments = queryAll(
    "SELECT cid, text, timestamp, name, comment_id, quote FROM comments WHERE pid = ? ORDER BY cid ASC",
    [pid]
  ).map((c) => ({
    cid: c.cid,
    timestamp: c.timestamp,
    name: c.name,
    text: (c.text || "").replace(/[\x00-\x1f\x7f]/g, ""),
    quote: c.quote || null,
  }));
  return {
    post: {
      pid: post.pid,
      timestamp: post.timestamp,
      category: post.category,
      text: (post.text || "").replace(/[\x00-\x1f\x7f]/g, ""),
      likenum: post.likenum,
      reply: post.reply,
    },
    comments,
  };
}

/** Agent 查询函数：周报列表 */
function agentWeeklyList() {
  const rows = queryAll(
    "SELECT week_start, week_end, content, created_at FROM weekly_reports ORDER BY week_start DESC"
  );
  return rows.map((r) => {
    const plain = (r.content || "")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/[#*`>\[\]()_]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return {
      week_start: r.week_start,
      week_end: r.week_end,
      created_at: r.created_at,
      summary: plain.slice(0, 200),
      content: r.content,
    };
  });
}

/** Agent 查询函数：单期周报 */
function agentWeeklyOne(weekStart) {
  return queryOne(
    "SELECT week_start, week_end, content, created_at FROM weekly_reports WHERE week_start = ?",
    [weekStart]
  );
}

/** Agent 查询函数：增量摘要（自某时间点以来的热帖+新帖+周报），模拟全局记忆 */
function agentDigest(sinceTs) {
  const since = sinceTs || (Math.floor(Date.now() / 1000) - AGENT_DIGEST_DEFAULT_DAYS * 86400);
  const newPosts = queryAll(
    "SELECT pid, text, timestamp, likenum, reply, type, COALESCE(category,'其他') as category FROM holes WHERE timestamp >= ? ORDER BY pid DESC LIMIT ?",
    [since, AGENT_LIST_LIMIT]
  ).map(slimPost);
  const hotPosts = queryAll(
    "SELECT pid, text, timestamp, likenum, reply, type, COALESCE(category,'其他') as category FROM holes WHERE timestamp >= ? ORDER BY likenum DESC, pid DESC LIMIT ?",
    [since, AGENT_LIST_LIMIT]
  ).map(slimPost);
  const weekly = queryAll(
    "SELECT week_start, week_end, created_at FROM weekly_reports WHERE created_at >= ? ORDER BY week_start DESC",
    [since]
  ).map((r) => ({ week_start: r.week_start, week_end: r.week_end, created_at: r.created_at }));
  return {
    since,
    server_time: Math.floor(Date.now() / 1000),
    new_posts: newPosts,
    hot_posts: hotPosts,
    weekly_reports: weekly,
  };
}

/** Agent 统一 JSON 响应 */
function agentJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  });
  res.end(body);
}

/** Agent 统一错误响应 */
function agentError(res, status, error, message) {
  agentJson(res, status, { ok: false, error, message, server_time: Math.floor(Date.now() / 1000) });
}

/** Agent Token 管理：列出当前用户的有效 Token（不含明文） */
function handleAgentTokenList(email) {
  const rows = queryAll(
    "SELECT id, label, created_at, last_used_at, call_count FROM agent_tokens WHERE user_email = ? AND revoked_at = 0 ORDER BY created_at DESC",
    [email]
  );
  return { ok: true, tokens: rows };
}

/** Agent Token 管理：创建新 Token，返回明文一次 */
function handleAgentTokenCreate(email, label) {
  if (!canUseAgent(email)) throw new Error("此功能仅校园邮箱用户可用");
  const count = queryOne(
    "SELECT COUNT(*) as c FROM agent_tokens WHERE user_email = ? AND revoked_at = 0", [email]
  ).c;
  if (count >= AGENT_MAX_TOKENS_PER_USER) {
    throw new Error(`每个账号最多 ${AGENT_MAX_TOKENS_PER_USER} 个 Token`);
  }
  const cleanLabel = (label || "").trim().slice(0, 20);
  const plain = generateAgentToken();
  const hash = hashAgentToken(plain);
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    "INSERT INTO agent_tokens (user_email, token_hash, label, created_at) VALUES (?,?,?,?)"
  ).run(email, hash, cleanLabel, now);
  return { ok: true, token: plain, label: cleanLabel, config_snippet: buildMcpConfig(plain) };
}

/** Agent Token 管理：撤销 */
function handleAgentTokenRevoke(email, tokenId) {
  const row = queryOne(
    "SELECT id FROM agent_tokens WHERE id = ? AND user_email = ? AND revoked_at = 0",
    [tokenId, email]
  );
  if (!row) throw new Error("Token 不存在或已撤销");
  db.prepare("UPDATE agent_tokens SET revoked_at = ? WHERE id = ?")
    .run(Math.floor(Date.now() / 1000), tokenId);
  return { ok: true };
}

/** 生成 MCP 配置片段（站点地址取自 PUBLIC_BASE_URL，不硬编码 IP） */
function buildMcpConfig(token) {
  return {
    mcpServers: {
      autothole: {
        command: "npx",
        args: ["-y", "autothole-mcp"],
        env: {
          AUTOTREEHOLE_URL: PUBLIC_BASE_URL || "",
          AUTOTREEHOLE_TOKEN: token,
        },
      },
    },
  };
}

// ==================== 认证 API ====================
function handleAuthSendCode(body, ip) {
  const email = (body.email || "").trim().toLowerCase();
  if (!isAllowedEmail(email)) {
    throw new Error("请使用北大校园邮箱（@pku.edu.cn 或 @stu.pku.edu.cn）");
  }
  const now = Math.floor(Date.now() / 1000);
  const todayStart = new Date().setHours(0, 0, 0, 0) / 1000;

  // 每 IP 每日验证请求上限（防邮箱轰炸：攻击者无法用同一 IP 向大量校园邮箱发验证码）
  const ipCount = queryOne(
    "SELECT COUNT(*) as c FROM verify_codes WHERE ip = ? AND sent_at >= ?",
    [ip, todayStart]
  )?.c || 0;
  if (ipCount >= VERIFY_IP_DAILY_LIMIT) {
    throw new Error(`今日验证请求次数已达上限（${VERIFY_IP_DAILY_LIMIT} 次/天）`);
  }

  // 检查重发间隔
  const existing = queryOne("SELECT * FROM verify_codes WHERE email = ?", [email]);
  if (existing && now - existing.sent_at < CODE_RESEND_INTERVAL) {
    throw new Error(`发送过于频繁，请 ${CODE_RESEND_INTERVAL - (now - existing.sent_at)} 秒后重试`);
  }

  // 生成 6 位验证码
  const code = String(Math.floor(Math.random() * 900000) + 100000);

  // 存储/更新验证码（同时记录 IP，用于每 IP 每日限额）
  db.prepare(
    `INSERT INTO verify_codes (email, code, expires_at, sent_at, attempts, ip)
     VALUES (?, ?, ?, ?, 0, ?)
     ON CONFLICT(email) DO UPDATE SET code=excluded.code, expires_at=excluded.expires_at, sent_at=excluded.sent_at, attempts=0, ip=excluded.ip`
  ).run(email, code, now + CODE_TTL, now, ip);

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
    alertAdmin("warn", "brute_force", "验证码尝试次数耗尽", `邮箱: ${email}（连续 ${CODE_MAX_ATTEMPTS} 次错误，可能暴力破解）`, ip);
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
  const ip = getClientIp(req);
  // 复用未登录留言的三层限流（IP 小时级 / 日级 / 全局小时级），防止登录用户轰炸站长邮箱
  if (!messageRateCheck(ip)) {
    alertAdmin("warn", "rate_limit", "已登录用户留言触发频率限制", `用户: ${payload.email}（疑似邮箱轰炸）`, ip);
    throw new Error("留言过于频繁，请稍后再试");
  }
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
        <tr><td style="color:#86868B;width:80px;vertical-align:top;">注册邮箱</td><td>${esc(userEmail)}</td></tr>
        ${contact ? `<tr><td style="color:#86868B;vertical-align:top;">联系方式</td><td>${esc(contact)}</td></tr>` : ""}
      </table>
      <div style="background:#fff;border-radius:8px;padding:20px 24px;">
        <p style="color:#1D1D1F;font-size:14px;line-height:1.8;white-space:pre-wrap;">${esc(content)}</p>
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
    alertAdmin("warn", "rate_limit", "访客留言触发频率限制", `来源: ${source || "未标注"}（疑似邮箱轰炸）`, ip);
    throw new Error("留言过于频繁，请稍后再试");
  }

  const mailOptions = {
    from: MAIL_FROM,
    to: SITE_OWNER_EMAIL,
    subject: `AutoTreehole 站长信箱 · 访客留言${source ? "（" + source + "）" : ""}`,
    html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;max-width:500px;margin:0 auto;padding:32px 24px;background:#F5F5F7;border-radius:12px;">
      <h2 style="color:#1D1D1F;font-size:18px;font-weight:600;margin-bottom:20px;">📬 站长信箱新留言（访客）</h2>
      <table style="width:100%;font-size:14px;color:#1D1D1F;line-height:1.8;margin-bottom:20px;">
        <tr><td style="color:#86868B;width:80px;vertical-align:top;">来源</td><td>未登录访客${source ? " · " + esc(source) : ""}</td></tr>
        <tr><td style="color:#86868B;vertical-align:top;">联系方式</td><td>${esc(contact)}</td></tr>
      </table>
      <div style="background:#fff;border-radius:8px;padding:20px 24px;">
        <p style="color:#1D1D1F;font-size:14px;line-height:1.8;white-space:pre-wrap;">${esc(content)}</p>
      </div>
      <p style="color:#86868B;font-size:12px;margin-top:16px;">此邮件由 AutoTreehole 系统自动发送 · IP: ${esc(ip)}</p>
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
  const ip = getClientIp(req);
  const code = (body.code || "").trim().toUpperCase();
  if (!code) throw new Error("请输入邀请码");
  if (!/^[A-Z0-9]{4,20}$/.test(code)) throw new Error("邀请码格式无效");
  const row = queryOne("SELECT * FROM invite_codes WHERE code = ?", [code]);
  if (!row) {
    alertAdmin("warn", "brute_force", "邀请码登录失败", `尝试的邀请码: ${code}（不存在，可能暴力破解）`, ip);
    throw new Error("邀请码不存在");
  }
  if (row.used_at) throw new Error("邀请码已被使用");
  const now = Math.floor(Date.now() / 1000);
  const userId = `invite:${code}`;
  // 注册用户
  db.prepare("INSERT OR IGNORE INTO users (email, verified_at, pledged) VALUES (?, ?, 0)").run(userId, now);
  db.prepare("UPDATE users SET last_visit = ? WHERE email = ?").run(now, userId);
  // 标记邀请码已使用
  db.prepare("UPDATE invite_codes SET used_at = ?, used_by = ? WHERE code = ?").run(now, userId, code);
  // 访问日志
  db.prepare("INSERT INTO visit_logs (user_email, ip, entered_at) VALUES (?, ?, ?)").run(userId, ip, now);
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

// ==================== 帖子收藏 ====================
function handleFavoriteToggle(body, req) {
  const payload = verifyToken(getCookie(req, "treehole_token"));
  if (!payload) throw new Error("未登录");
  const pid = parseInt(body.pid, 10);
  if (!pid || pid < 1) throw new Error("无效的帖子 ID");
  const email = payload.email;
  const now = Math.floor(Date.now() / 1000);
  // 查是否已收藏
  const exist = queryOne("SELECT id FROM favorites WHERE user_email = ? AND pid = ?", [email, pid]);
  let favorited;
  if (exist) {
    db.prepare("DELETE FROM favorites WHERE user_email = ? AND pid = ?").run(email, pid);
    favorited = false;
  } else {
    db.prepare("INSERT INTO favorites (user_email, pid, created_at) VALUES (?, ?, ?)").run(email, pid, now);
    favorited = true;
  }
  return { success: true, favorited };
}

function handleFavoriteList(req) {
  const payload = verifyToken(getCookie(req, "treehole_token"));
  if (!payload) throw new Error("未登录");
  const email = payload.email;
  // 联查 holes 表获取帖子详情，按收藏时间倒序
  const rows = queryAll(
    `SELECT f.pid, f.created_at as favorited_at, h.text, h.timestamp, h.likenum, h.reply, h.type, h.image_size
     FROM favorites f
     LEFT JOIN holes h ON h.pid = f.pid
     WHERE f.user_email = ?
     ORDER BY f.created_at DESC`,
    [email]
  );
  return { success: true, favorites: rows };
}

function handleFavoriteStatus(pids, req) {
  const payload = verifyToken(getCookie(req, "treehole_token"));
  if (!payload) return { success: true, favorited: {} };
  const email = payload.email;
  const idList = (Array.isArray(pids) ? pids : []).map(p => parseInt(p, 10)).filter(p => p > 0);
  if (idList.length === 0) return { success: true, favorited: {} };
  if (idList.length > 100) idList.length = 100; // 防止超大 IN 查询
  const placeholders = idList.map(() => "?").join(",");
  const rows = queryAll(
    `SELECT pid FROM favorites WHERE user_email = ? AND pid IN (${placeholders})`,
    [email, ...idList]
  );
  const map = {};
  rows.forEach(r => { map[r.pid] = true; });
  return { success: true, favorited: map };
}

// ==================== 关键词订阅 ====================
const MAX_SUBS_PER_USER = 3;       // 每人最多 3 个关键词
const SUB_KEYWORD_MIN = 1;
const SUB_KEYWORD_MAX = 30;
const SUB_SCAN_INTERVAL_MS = 2 * 60_000; // 每 2 分钟扫描一次
const SUB_DIGEST_MAX_POSTS = 20;   // 单封摘要最多列 20 条，超出提示
const SUB_DAILY_CAP = 30;          // 每用户每日最多 30 封（防异常）

function isInviteUser(email) { return email && email.startsWith("invite:"); }

function unsubToken(subId) {
  const sig = crypto.createHmac("sha256", TOKEN_SECRET).update(`unsub:${subId}`).digest("hex").slice(0, 24);
  return `${subId}.${sig}`;
}

function verifyUnsubToken(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const subId = parseInt(parts[0], 10);
  if (isNaN(subId)) return null;
  const expected = crypto.createHmac("sha256", TOKEN_SECRET).update(`unsub:${subId}`).digest("hex").slice(0, 24);
  if (parts[1] !== expected) return null;
  return subId;
}

// 用户级一键退订（退订该用户全部关键词）
function unsubUserToken(email) {
  const sig = crypto.createHmac("sha256", TOKEN_SECRET).update(`unsuball:${email}`).digest("hex").slice(0, 24);
  return `${Buffer.from(email).toString("base64url")}.${sig}`;
}

function verifyUnsubUserToken(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  let email;
  try { email = Buffer.from(parts[0], "base64url").toString("utf-8"); } catch { return null; }
  if (!email) return null;
  const expected = crypto.createHmac("sha256", TOKEN_SECRET).update(`unsuball:${email}`).digest("hex").slice(0, 24);
  if (parts[1] !== expected) return null;
  return email;
}

function handleSubscribeList(req) {
  const payload = verifyToken(getCookie(req, "treehole_token"));
  if (!payload) throw new Error("未登录");
  const email = payload.email;
  // LEFT JOIN subscription_sent + holes：统计每个订阅的推送次数 + 平均延迟（帖子发布到邮件发出的秒数）
  const rows = queryAll(
    `SELECT s.id, s.keyword, s.notify_email, s.created_at,
            COUNT(ss.pid) AS push_count,
            AVG(ss.sent_at - h.timestamp) AS avg_delay
     FROM subscriptions s
     LEFT JOIN subscription_sent ss ON ss.sub_id = s.id
     LEFT JOIN holes h ON h.pid = ss.pid
     WHERE s.user_email = ?
     GROUP BY s.id
     ORDER BY s.created_at ASC`,
    [email]
  );
  return { success: true, subscriptions: rows, max: MAX_SUBS_PER_USER, isInvite: isInviteUser(email) };
}

function handleSubscribeAdd(body, req) {
  const payload = verifyToken(getCookie(req, "treehole_token"));
  if (!payload) throw new Error("未登录");
  const email = payload.email;
  // 邀请码为一次性凭证，不具备订阅推送资格（仅校园邮箱登录用户可订阅）
  if (isInviteUser(email)) {
    throw new Error("订阅推送仅对校园邮箱登录用户开放");
  }
  const keyword = String(body.keyword || "").trim().replace(/[\x00-\x1f\x7f]/g, "");
  if (keyword.length < SUB_KEYWORD_MIN || keyword.length > SUB_KEYWORD_MAX) {
    throw new Error(`关键词长度需在 ${SUB_KEYWORD_MIN}-${SUB_KEYWORD_MAX} 字之间`);
  }
  // 收信邮箱：强制使用用户注册邮箱（忽略前端传入的 notifyEmail，防止借订阅向他人邮箱轰炸）
  const notifyEmail = email;
  // 数量上限
  const cnt = queryOne("SELECT COUNT(*) as c FROM subscriptions WHERE user_email = ?", [email]).c;
  if (cnt >= MAX_SUBS_PER_USER) {
    throw new Error(`每人最多订阅 ${MAX_SUBS_PER_USER} 个关键词`);
  }
  const now = Math.floor(Date.now() / 1000);
  try {
    db.prepare("INSERT INTO subscriptions (user_email, notify_email, keyword, created_at) VALUES (?, ?, ?, ?)")
      .run(email, notifyEmail, keyword, now);
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) throw new Error("该关键词已订阅");
    throw e;
  }
  return { success: true, max: MAX_SUBS_PER_USER };
}

function handleSubscribeRemove(body, req) {
  const payload = verifyToken(getCookie(req, "treehole_token"));
  if (!payload) throw new Error("未登录");
  const email = payload.email;
  const id = parseInt(body.id, 10);
  if (!id) throw new Error("无效的订阅 ID");
  db.prepare("DELETE FROM subscriptions WHERE id = ? AND user_email = ?").run(id, email);
  // 清理该订阅的已发送记录（已无意义）
  try { db.prepare("DELETE FROM subscription_sent WHERE sub_id = ?").run(id); } catch (e) {}
  return { success: true };
}

function handleSubscribeUnsubscribe(query) {
  // 公开接口（邮件内一键退订，无需登录）
  const subId = verifyUnsubToken(query.token);
  if (!subId) throw new Error("退订链接无效或已过期");
  const row = queryOne("SELECT user_email, keyword FROM subscriptions WHERE id = ?", [subId]);
  if (!row) return { success: true, already: true };
  db.prepare("DELETE FROM subscriptions WHERE id = ?").run(subId);
  try { db.prepare("DELETE FROM subscription_sent WHERE sub_id = ?").run(subId); } catch (e) {}
  console.log(`[subscribe] 用户 ${row.user_email} 一键退订关键词「${row.keyword}」`);
  return { success: true, keyword: row.keyword };
}

function handleSubscribeUnsubscribeAll(query) {
  // 公开接口（邮件内一键退订全部，无需登录）
  const email = verifyUnsubUserToken(query.token);
  if (!email) throw new Error("退订链接无效或已过期");
  const rows = queryAll("SELECT id, keyword FROM subscriptions WHERE user_email = ?", [email]);
  if (rows.length === 0) return { success: true, already: true };
  const ids = rows.map(r => r.id);
  db.prepare("DELETE FROM subscriptions WHERE user_email = ?").run(email);
  try {
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(`DELETE FROM subscription_sent WHERE sub_id IN (${placeholders})`).run(...ids);
  } catch (e) {}
  console.log(`[subscribe] 用户 ${email} 一键退订全部 ${rows.length} 个关键词`);
  return { success: true, count: rows.length };
}

// 扫描新帖并推送摘要邮件
async function scanAndNotify() {
  if (!db) return;
  try {
    const meta = queryOne("SELECT value FROM sub_meta WHERE key = 'last_scan_pid'");
    let lastPid;
    if (!meta) {
      // 首次启动：水位线设为当前最大 pid，不补推历史
      const maxRow = queryOne("SELECT MAX(pid) as m FROM holes");
      lastPid = (maxRow && maxRow.m) ? maxRow.m : 0;
      db.prepare("INSERT OR REPLACE INTO sub_meta (key, value) VALUES ('last_scan_pid', ?)").run(String(lastPid));
      console.log(`[subscribe] 首次启动，水位线设为 pid=${lastPid}（不补推历史）`);
      return;
    }
    lastPid = parseInt(meta.value, 10) || 0;

    const newPosts = queryAll(
      "SELECT pid, text, timestamp, likenum, reply FROM holes WHERE pid > ? ORDER BY pid ASC",
      [lastPid]
    );
    if (newPosts.length === 0) return;

    const subs = queryAll("SELECT id, user_email, notify_email, keyword FROM subscriptions");
    const maxPid = newPosts[newPosts.length - 1].pid;

    if (subs.length === 0) {
      db.prepare("UPDATE sub_meta SET value = ? WHERE key = 'last_scan_pid'").run(String(maxPid));
      return;
    }

    // 今日每用户发送计数（防异常）
    const dayStart = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
    const now = Math.floor(Date.now() / 1000);
    const insertSent = db.prepare("INSERT OR IGNORE INTO subscription_sent (sub_id, pid, sent_at) VALUES (?, ?, ?)");

    // user_email -> { notifyEmail, posts: Map(pid -> {post, keywords:[]}) }
    const userMap = new Map();

    for (const post of newPosts) {
      const text = post.text || "";
      for (const sub of subs) {
        if (!sub.keyword) continue;
        if (!text.includes(sub.keyword)) continue;
        // 去重：已推送过的 (sub_id, pid) 跳过
        const already = queryOne("SELECT 1 FROM subscription_sent WHERE sub_id = ? AND pid = ?", [sub.id, post.pid]);
        if (already) continue;
        // 记录为已发送（先记录，防重复推送；罕见 SMTP 失败可能漏推，可接受）
        insertSent.run(sub.id, post.pid, now);
        if (!userMap.has(sub.user_email)) {
          userMap.set(sub.user_email, { notifyEmail: sub.notify_email, posts: new Map(), count: 0 });
        }
        const u = userMap.get(sub.user_email);
        u.count++;
        if (!u.posts.has(post.pid)) {
          u.posts.set(post.pid, { pid: post.pid, text: post.text, timestamp: post.timestamp, likenum: post.likenum, reply: post.reply, keywords: [] });
        }
        u.posts.get(post.pid).keywords.push(sub.keyword);
      }
    }

    // 推进水位线
    db.prepare("UPDATE sub_meta SET value = ? WHERE key = 'last_scan_pid'").run(String(maxPid));

    if (userMap.size === 0) return;

    // 每用户发送一封摘要
    for (const [userEmail, data] of userMap) {
      // 每日上限检查
      const sentToday = queryOne(
        "SELECT COUNT(*) as c FROM subscription_sent WHERE sub_id IN (SELECT id FROM subscriptions WHERE user_email = ?) AND sent_at >= ?",
        [userEmail, dayStart]
      );
      const todayCount = sentToday ? sentToday.c : 0;
      if (todayCount > SUB_DAILY_CAP * SUB_DIGEST_MAX_POSTS) {
        console.log(`[subscribe] 用户 ${userEmail} 今日已达上限，跳过推送`);
        continue;
      }
      const posts = Array.from(data.posts.values());
      if (posts.length === 0) continue;
      try {
        await sendSubscriptionDigest(data.notifyEmail, userEmail, posts);
        console.log(`[subscribe] 已向 ${data.notifyEmail} 推送 ${posts.length} 条匹配帖（用户 ${userEmail}）`);
      } catch (e) {
        console.error(`[subscribe] 推送失败 ${data.notifyEmail}: ${e.message}`);
      }
    }
  } catch (e) {
    console.error(`[subscribe] 扫描异常: ${e.message}`);
  }
}

async function sendSubscriptionDigest(toEmail, userEmail, posts) {
  const overflow = posts.length > SUB_DIGEST_MAX_POSTS;
  const showPosts = posts.slice(0, SUB_DIGEST_MAX_POSTS);
  // 汇总本次命中的所有关键词，用于邮件标题
  const allKws = [...new Set(posts.flatMap(p => p.keywords || []))].slice(0, 3);
  const kwLabel = allKws.length ? allKws.map(k => `「${k}」`).join("") : "";
  const items = showPosts.map(p => {
    const time = p.timestamp ? new Date(p.timestamp * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
    const summary = (p.text || "").slice(0, 120).replace(/\s+/g, " ");
    const kws = [...new Set(p.keywords)].map(k => `<span style="display:inline-block;background:#FFF0F0;color:#B87878;padding:1px 8px;border-radius:10px;font-size:11px;margin-right:4px;">${esc(k)}</span>`).join("");
    return `<tr>
      <td style="padding:10px 0;border-bottom:1px solid #E8E8ED;">
        <div style="margin-bottom:4px;">${kws}</div>
        <div style="color:#1D1D1F;font-size:13px;line-height:1.6;">${esc(summary)}${p.text && p.text.length > 120 ? "…" : ""}</div>
        <div style="color:#86868B;font-size:11px;margin-top:4px;">#${p.pid} · ${esc(time)} · ♥ ${p.likenum || 0} · 💬 ${p.reply || 0}</div>
      </td>
    </tr>`;
  }).join("");
  const more = overflow ? `<p style="color:#86868B;font-size:12px;text-align:center;margin-top:12px;">还有 ${posts.length - SUB_DIGEST_MAX_POSTS} 条匹配，请前往网站查看</p>` : "";
  // 页脚链接：仅当配置了 PUBLIC_BASE_URL 时生成可点击链接
  const siteLink = PUBLIC_BASE_URL
    ? `<a href="${PUBLIC_BASE_URL}/" style="color:#86868B;">前往 AutoTreehole</a>`
    : `<span style="color:#86868B;">前往 AutoTreehole</span>`;
  const unsubLink = PUBLIC_BASE_URL
    ? `<a href="${PUBLIC_BASE_URL}/api/subscribe/unsubscribe-all?token=${unsubUserToken(userEmail)}" style="color:#86868B;">一键退订全部</a>`
    : `<span style="color:#86868B;">在网站订阅页可退订</span>`;
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#F5F5F7;border-radius:12px;">
    <h2 style="color:#1D1D1F;font-size:18px;font-weight:600;margin-bottom:6px;">关键词订阅推送</h2>
    <p style="color:#86868B;font-size:12px;margin-bottom:20px;">发现 ${posts.length} 条匹配你订阅关键词的新帖</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;padding:4px 20px;">
      ${items}
    </table>
    ${more}
    <p style="color:#86868B;font-size:11px;margin-top:20px;text-align:center;">
      ${siteLink}
      &nbsp;·&nbsp;
      ${unsubLink}
    </p>
  </div>`;
  await getMailer().sendMail({
    from: MAIL_FROM,
    to: toEmail,
    subject: `关键词订阅 ${kwLabel}· ${posts.length} 条新帖匹配`,
    html,
  });
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

  // 收藏统计
  const totalFavorites = queryOne("SELECT COUNT(*) as c FROM favorites").c;
  const favoriteUsers = queryOne("SELECT COUNT(DISTINCT user_email) as c FROM favorites").c;
  // 收藏数 Top 帖子
  const topFavoritedPosts = queryAll(
    `SELECT f.pid, COUNT(*) as fav_count, h.text, h.category
     FROM favorites f LEFT JOIN holes h ON h.pid = f.pid
     GROUP BY f.pid ORDER BY fav_count DESC LIMIT 20`
  );
  // 收藏活跃用户 Top 10
  const topFavoritingUsers = queryAll(
    `SELECT user_email, COUNT(*) as fav_count
     FROM favorites GROUP BY user_email ORDER BY fav_count DESC LIMIT 10`
  );
  // 近 30 天收藏趋势
  const favoritesTrend = queryAll(
    `SELECT date(created_at, 'unixepoch', 'localtime') as day, COUNT(*) as favs
     FROM favorites WHERE created_at >= ?
     GROUP BY day ORDER BY day ASC`,
    [Math.floor(Date.now() / 1000) - 30 * 86400]
  );

  // 订阅统计
  const totalSubs = queryOne("SELECT COUNT(*) as c FROM subscriptions").c;
  const subUsers = queryOne("SELECT COUNT(DISTINCT user_email) as c FROM subscriptions").c;
  const topKeywords = queryAll(
    `SELECT keyword, COUNT(*) as cnt FROM subscriptions GROUP BY keyword ORDER BY cnt DESC LIMIT 20`
  );
  // 按用户聚合：每个用户订阅了哪些关键词（用于数据后台展示）
  const subByUserRows = queryAll(
    `SELECT user_email, notify_email, COUNT(*) as cnt, MAX(created_at) as latest
     FROM subscriptions GROUP BY user_email ORDER BY latest DESC LIMIT 500`
  );
  const subKeywordsByUser = queryAll(
    `SELECT user_email, keyword FROM subscriptions ORDER BY created_at ASC`
  );
  const kwMap = new Map();
  for (const r of subKeywordsByUser) {
    if (!kwMap.has(r.user_email)) kwMap.set(r.user_email, []);
    kwMap.get(r.user_email).push(r.keyword);
  }
  const subsByUser = subByUserRows.map(r => ({
    email: r.user_email,
    notifyEmail: r.notify_email,
    count: r.cnt,
    latest: r.latest,
    keywords: kwMap.get(r.user_email) || [],
  }));
  const totalSubSent = queryOne("SELECT COUNT(*) as c FROM subscription_sent").c;
  const subSentToday = queryOne(
    "SELECT COUNT(*) as c FROM subscription_sent WHERE sent_at >= ?",
    [Math.floor(new Date().setHours(0, 0, 0, 0) / 1000)]
  ).c;

  // 安全告警统计
  const totalAlerts = queryOne("SELECT COUNT(*) as c FROM alert_logs").c;
  const alertsToday = queryOne("SELECT COUNT(*) as c FROM alert_logs WHERE created_at >= ?", [todayStart]).c;
  const alertsNotified = queryOne("SELECT COUNT(*) as c FROM alert_logs WHERE notified = 1").c;
  // 按类型统计
  const alertsByType = queryAll(
    `SELECT type, COUNT(*) as count, SUM(notified) as notified_count
     FROM alert_logs GROUP BY type ORDER BY count DESC`
  );
  // 按级别统计
  const alertsByLevel = queryAll(
    `SELECT level, COUNT(*) as count
     FROM alert_logs GROUP BY level ORDER BY count DESC`
  );
  // 近 30 天告警趋势
  const alertsTrend = queryAll(
    `SELECT date(created_at, 'unixepoch', 'localtime') as day, COUNT(*) as total
     FROM alert_logs WHERE created_at >= ?
     GROUP BY day ORDER BY day ASC`,
    [Math.floor(Date.now() / 1000) - 30 * 86400]
  );
  // 最近 100 条告警记录
  const recentAlerts = queryAll(
    `SELECT id, level, type, subject, detail, ip, notified, created_at
     FROM alert_logs ORDER BY created_at DESC LIMIT 100`
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
    favorites: {
      total: totalFavorites,
      users: favoriteUsers,
      topPosts: topFavoritedPosts.map(p => ({
        pid: p.pid,
        favCount: p.fav_count,
        text: p.text,
        category: p.category,
      })),
      topUsers: topFavoritingUsers.map(u => ({
        email: u.user_email,
        favCount: u.fav_count,
      })),
      trend: favoritesTrend.map(t => ({
        day: t.day,
        favs: t.favs,
      })),
    },
    subscriptions: {
      total: totalSubs,
      users: subUsers,
      sentTotal: totalSubSent,
      sentToday: subSentToday,
      topKeywords: topKeywords.map(k => ({ keyword: k.keyword, count: k.cnt })),
      byUser: subsByUser,
    },
    alerts: {
      total: totalAlerts,
      today: alertsToday,
      notified: alertsNotified,
      byType: alertsByType.map(t => ({ type: t.type, count: t.count, notified: t.notified_count || 0 })),
      byLevel: alertsByLevel.map(l => ({ level: l.level, count: l.count })),
      trend: alertsTrend.map(t => ({ day: t.day, total: t.total })),
      recent: recentAlerts.map(a => ({
        id: a.id,
        level: a.level,
        type: a.type,
        subject: a.subject,
        detail: a.detail,
        ip: a.ip,
        notified: !!a.notified,
        createdAt: a.created_at,
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
  // route 提到 try 外定义，使 catch 块的告警埋点也能访问（避免 ReferenceError）
  const route = pathname.startsWith("/api/") ? pathname.slice(5) : "";

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

    // 服务状态（含 token 剩余天数，用于前端提示；需登录防泄露服务器内部状态）
    if (route === "status") {
      await ensureDb();
      if (!requireAuth(req)) { sendError(res, 401, "请先登录"); return; }
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
      await ensureDb();
      if (!requireAuth(req)) { sendError(res, 401, "请先登录"); return; }
      if (!rateLimit(ip, true)) { alertAdmin("warn", "rate_limit", "AI 报告接口触发频率限制", `路由: /api/report`, ip); sendError(res, 429, "请求过于频繁。限制：每 IP 每分钟 2 次、每天 15 次；全局每天 200 次"); return; }
      const body = JSON.parse((await readBody(req)) || "{}");
      try {
        sendJson(res, 200, await handleReport(body, ip));
      } catch (e) {
        // QUOTA 错误：模型限额/繁忙，返回友好提示 + code 标记供前端识别
        if (e && e.code === "QUOTA") {
          sendJson(res, 503, { error: e.message, code: "QUOTA" });
        } else {
          sendError(res, 500, e.message);
        }
      }
      return;
    }

    // 报告预处理（前端直连模式：只返回 prompt，不调用 LLM，网友 Key 不经过服务器）
    if (route === "report/prepare") {
      if (req.method !== "POST") { sendError(res, 405, "Method Not Allowed"); return; }
      await ensureDb();
      if (!requireAuth(req)) { sendError(res, 401, "请先登录"); return; }
      if (!rateLimit(ip, false)) { sendError(res, 429, "请求过于频繁，每 IP 每分钟限 30 次"); return; }
      const body = JSON.parse((await readBody(req)) || "{}");
      sendJson(res, 200, handleReportPrepare(body));
      return;
    }

    // 报告后处理（前端直连模式：对 LLM 原始输出做链接化 + 附录，不涉及 Key）
    if (route === "report/enrich") {
      if (req.method !== "POST") { sendError(res, 405, "Method Not Allowed"); return; }
      await ensureDb();
      if (!requireAuth(req)) { sendError(res, 401, "请先登录"); return; }
      if (!rateLimit(ip, false)) { sendError(res, 429, "请求过于频繁，每 IP 每分钟限 30 次"); return; }
      const body = JSON.parse((await readBody(req)) || "{}");
      sendJson(res, 200, handleReportEnrich(body));
      return;
    }

    // 树洞周报（每周一自动生成，所有用户可读，只读缓存）
    if (route === "report/weekly") {
      if (req.method !== "GET") { sendError(res, 405, "Method Not Allowed"); return; }
      await ensureDb();
      if (!requireAuth(req)) { sendError(res, 401, "请先登录"); return; }
      if (!rateLimit(ip, false)) { sendError(res, 429, "请求过于频繁"); return; }
      sendJson(res, 200, handleWeeklyReport(query));
      return;
    }

    // 树洞周报邮件订阅状态（未登录也可查询，用于前端展示按钮状态）
    if (route === "weekly-report/status") {
      if (req.method !== "GET") { sendError(res, 405, "Method Not Allowed"); return; }
      await ensureDb();
      if (!rateLimit(ip, false)) { sendError(res, 429, "请求过于频繁"); return; }
      sendJson(res, 200, handleWeeklyReportSubStatus(req));
      return;
    }
    if (route === "weekly-report/subscribe") {
      if (req.method !== "POST") { sendError(res, 405, "Method Not Allowed"); return; }
      await ensureDb();
      if (!requireAuth(req)) { sendError(res, 401, "请先登录"); return; }
      if (!rateLimit(ip, false)) { sendError(res, 429, "请求过于频繁"); return; }
      try {
        sendJson(res, 200, handleWeeklyReportSubscribe(req));
      } catch (e) { sendError(res, 400, e.message); }
      return;
    }
    if (route === "weekly-report/unsubscribe") {
      if (req.method !== "POST") { sendError(res, 405, "Method Not Allowed"); return; }
      await ensureDb();
      if (!requireAuth(req)) { sendError(res, 401, "请先登录"); return; }
      if (!rateLimit(ip, false)) { sendError(res, 429, "请求过于频繁"); return; }
      try {
        sendJson(res, 200, handleWeeklyReportUnsubscribe(req));
      } catch (e) { sendError(res, 400, e.message); }
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
    if (route === "auth/logout") {
      if (req.method !== "POST") { sendError(res, 405, "Method Not Allowed"); return; }
      // 清除 HttpOnly Cookie，使前端令牌立即失效
      res.setHeader("Set-Cookie", "treehole_token=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax");
      sendJson(res, 200, { success: true });
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

    // ==================== Agent 接入 ====================
    // Token 管理（Cookie 鉴权，需登录）
    if (route === "agent/token/list") {
      await ensureDb();
      const email = requireAuth(req);
      if (!email) { sendError(res, 401, "请先登录"); return; }
      sendJson(res, 200, handleAgentTokenList(email));
      return;
    }
    if (route === "agent/token/create") {
      if (req.method !== "POST") { sendError(res, 405, "Method Not Allowed"); return; }
      await ensureDb();
      const email = requireAuth(req);
      if (!email) { sendError(res, 401, "请先登录"); return; }
      const body = JSON.parse((await readBody(req)) || "{}");
      try {
        sendJson(res, 200, handleAgentTokenCreate(email, body.label));
      } catch (e) { sendError(res, 400, e.message); }
      return;
    }
    if (route === "agent/token/revoke") {
      if (req.method !== "POST") { sendError(res, 405, "Method Not Allowed"); return; }
      await ensureDb();
      const email = requireAuth(req);
      if (!email) { sendError(res, 401, "请先登录"); return; }
      const body = JSON.parse((await readBody(req)) || "{}");
      try {
        sendJson(res, 200, handleAgentTokenRevoke(email, parseInt(body.id, 10)));
      } catch (e) { sendError(res, 400, e.message); }
      return;
    }

    // Agent 只读查询接口（Bearer Token 鉴权，独立限流）
    if (route.startsWith("agent/") && !route.startsWith("agent/token/")) {
      await ensureDb();
      const auth = authAgent(req);
      if (!auth) { agentError(res, 401, "invalid_token", "Token 无效或已撤销"); return; }
      if (!agentRateLimit(auth.tokenHash)) {
        alertAdmin("warn", "rate_limit", "Agent 接口触发频率限制", `用户: ${auth.email}\n路由: /api/${route}`, ip);
        agentError(res, 429, "rate_limited", "请求过于频繁，请稍后再试");
        return;
      }
      try {
        const server_time = Math.floor(Date.now() / 1000);
        if (route === "agent/latest") {
          const limit = Math.min(Math.max(parseInt(query.limit, 10) || 15, 1), AGENT_LIST_LIMIT);
          agentJson(res, 200, { ok: true, server_time, data: { posts: agentLatest(limit) } });
          return;
        }
        if (route === "agent/hot") {
          const days = Math.min(Math.max(parseInt(query.days, 10) || 7, 1), 14);
          const limit = Math.min(Math.max(parseInt(query.limit, 10) || 15, 1), AGENT_LIST_LIMIT);
          agentJson(res, 200, { ok: true, server_time, data: { posts: agentHot(days, limit) } });
          return;
        }
        if (route === "agent/search") {
          const keyword = (query.keyword || "").toString().replace(/[\x00-\x1f\x7f]/g, "").trim();
          if (!keyword) { agentError(res, 400, "bad_request", "keyword 不能为空"); return; }
          if (keyword.length > MAX_KEYWORD_LEN) { agentError(res, 400, "bad_request", `关键词最长 ${MAX_KEYWORD_LEN} 字`); return; }
          const limit = Math.min(Math.max(parseInt(query.limit, 10) || 15, 1), AGENT_LIST_LIMIT);
          agentJson(res, 200, { ok: true, server_time, data: { posts: agentSearch(keyword, limit) } });
          return;
        }
        if (route.startsWith("agent/post/")) {
          const pid = parseInt(route.split("/")[2], 10);
          if (!pid) { agentError(res, 400, "bad_request", "pid 无效"); return; }
          const result = agentPost(pid);
          if (!result) { agentError(res, 404, "not_found", "帖子不存在"); return; }
          agentJson(res, 200, { ok: true, server_time, data: result });
          return;
        }
        if (route === "agent/weekly") {
          agentJson(res, 200, { ok: true, server_time, data: { reports: agentWeeklyList() } });
          return;
        }
        if (route.startsWith("agent/weekly/")) {
          const ws = parseInt(route.split("/")[2], 10);
          if (!ws) { agentError(res, 400, "bad_request", "week_start 无效"); return; }
          const row = agentWeeklyOne(ws);
          if (!row) { agentError(res, 404, "not_found", "周报不存在"); return; }
          agentJson(res, 200, { ok: true, server_time, data: row });
          return;
        }
        if (route === "agent/digest") {
          // since 支持时间戳(秒)或天数(<=365)
          let sinceTs = null;
          if (query.since) {
            const s = parseFloat(query.since);
            sinceTs = s <= 365 ? Math.floor(Date.now() / 1000) - s * 86400 : Math.floor(s);
          }
          agentJson(res, 200, { ok: true, data: agentDigest(sinceTs) });
          return;
        }
        agentError(res, 404, "not_found", `未知 Agent 路由: /api/${route}`);
        return;
      } catch (e) {
        alertAdmin("error", "server_error", `Agent 接口错误: ${e.message.slice(0, 80)}`, `路由: /api/${route}\n堆栈: ${e.stack || e.message}`, ip);
        agentError(res, 500, "server_error", e.message);
        return;
      }
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
    // 帖子收藏：toggle / list / status
    if (route === "favorite/toggle") {
      if (req.method !== "POST") { sendError(res, 405, "Method Not Allowed"); return; }
      const body = JSON.parse((await readBody(req)) || "{}");
      await ensureDb();
      try {
        sendJson(res, 200, handleFavoriteToggle(body, req));
      } catch (e) { sendError(res, 400, e.message); }
      return;
    }
    if (route === "favorite/list") {
      await ensureDb();
      try {
        sendJson(res, 200, handleFavoriteList(req));
      } catch (e) { sendError(res, 400, e.message); }
      return;
    }
    if (route === "favorite/status") {
      const body = req.method === "POST" ? JSON.parse((await readBody(req)) || "{}") : query;
      await ensureDb();
      try {
        sendJson(res, 200, handleFavoriteStatus(body.pids, req));
      } catch (e) { sendError(res, 400, e.message); }
      return;
    }
    // 关键词订阅：list / add / remove（需登录）
    if (route === "subscribe/list") {
      await ensureDb();
      try {
        sendJson(res, 200, handleSubscribeList(req));
      } catch (e) { sendError(res, 400, e.message); }
      return;
    }
    if (route === "subscribe/add") {
      if (req.method !== "POST") { sendError(res, 405, "Method Not Allowed"); return; }
      const body = JSON.parse((await readBody(req)) || "{}");
      await ensureDb();
      try {
        sendJson(res, 200, handleSubscribeAdd(body, req));
      } catch (e) { sendError(res, 400, e.message); }
      return;
    }
    if (route === "subscribe/remove") {
      if (req.method !== "POST") { sendError(res, 405, "Method Not Allowed"); return; }
      const body = JSON.parse((await readBody(req)) || "{}");
      await ensureDb();
      try {
        sendJson(res, 200, handleSubscribeRemove(body, req));
      } catch (e) { sendError(res, 400, e.message); }
      return;
    }
    // 邮件内一键退订（公开接口，返回 HTML 确认页）
    if (route === "subscribe/unsubscribe") {
      await ensureDb();
      try {
        const result = handleSubscribeUnsubscribe(query);
        sendUnsubHtml(res, result.already ? "该订阅已不存在" : `已退订关键词「${esc(result.keyword || "")}」`);
      } catch (e) { sendUnsubHtml(res, "退订失败：" + esc(e.message)); }
      return;
    }
    if (route === "subscribe/unsubscribe-all") {
      await ensureDb();
      try {
        const result = handleSubscribeUnsubscribeAll(query);
        sendUnsubHtml(res, result.already ? "你没有任何订阅" : `已一键退订全部 ${result.count} 个关键词`);
      } catch (e) { sendUnsubHtml(res, "退订失败：" + esc(e.message)); }
      return;
    }

    // 数据后台接口（需要管理员密码）
    // admin 端点统一做速率限制（防暴力破解）+ 恒时密码比较（防计时攻击）
    if (route.startsWith("admin/")) {
      if (!rateLimit(ip, false)) { sendError(res, 429, "请求过于频繁"); return; }
      const adminKey = (query.key || getCookie(req, "admin_key") || "").toString();
      const a = Buffer.from(adminKey);
      const b = Buffer.from(ADMIN_PASSWORD || "");
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        sendError(res, 403, "无权访问");
        return;
      }
    }
    if (route === "admin/stats") {
      await ensureDb();
      sendJson(res, 200, handleAdminStats());
      return;
    }
    if (route === "admin/invite/list") {
      await ensureDb();
      sendJson(res, 200, handleAdminInviteList(query));
      return;
    }
    if (route === "admin/invite/create") {
      if (req.method !== "POST") { sendError(res, 405, "Method Not Allowed"); return; }
      const body = JSON.parse((await readBody(req)) || "{}");
      await ensureDb();
      try {
        sendJson(res, 200, handleAdminInviteCreate(body));
      } catch (e) { sendError(res, 400, e.message); }
      return;
    }
    if (route === "admin/invite/delete") {
      if (req.method !== "POST") { sendError(res, 405, "Method Not Allowed"); return; }
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
      await ensureDb();
      if (!requireAuth(req)) { sendError(res, 401, "请先登录"); return; }
      sendJson(res, 200, handleProviders());
      return;
    }

    // 图片代理（用树洞 Token 抓取图片，流式返回给前端）
    if (route === "image") {
      await ensureDb();
      if (!requireAuth(req)) { sendError(res, 401, "请先登录"); return; }
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
    // 数据接口（stats/hot/search/show/trend）需登录 + 承诺，防匿名爬取帖子内容
    if (!requireAuth(req)) { sendError(res, 401, "请先登录"); return; }

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
    // 500 级错误（服务失败）告警；4xx 多为用户输入问题，不告警以免刷屏
    if (status >= 500) {
      alertAdmin("error", "server_error", `服务内部错误: ${e.message.slice(0, 80)}`, `路由: /api/${route}\n堆栈: ${e.stack || e.message}`, ip);
    }
    sendError(res, status, e.message);
  }
});

// ==================== Token 过期告警（≤5天提醒站长） ====================
const TOKEN_WARN_DAYS = 5;
let tokenWarnSent = false; // 同一周期内只发一次

async function checkTokenAndWarn() {
  if (!PKU_TOKEN || !SITE_OWNER_EMAIL) return;
  const days = tokenDaysLeft(PKU_TOKEN);
  if (days === null) return;
  if (days > TOKEN_WARN_DAYS) {
    // 恢复后重置标记，便于下次到期再发
    tokenWarnSent = false;
    return;
  }
  if (tokenWarnSent) return; // 本周期已发过
  tokenWarnSent = true;
  try {
    await getMailer().sendMail({
      from: MAIL_FROM,
      to: SITE_OWNER_EMAIL,
      subject: `【紧急】AutoTreehole Token 将在 ${Math.ceil(days)} 天后过期`,
      html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#F5F5F7;border-radius:12px;">
        <h2 style="color:#FF3B30;font-size:18px;font-weight:600;margin-bottom:20px;">⚠️ 树洞 Token 即将过期</h2>
        <div style="background:#fff;border-radius:8px;padding:20px 24px;color:#1D1D1F;font-size:14px;line-height:1.8;">
          <p>当前 Token 剩余有效时间约 <strong>${Math.ceil(days)} 天</strong>（约 ${Math.ceil(days*24)} 小时）。</p>
          <p>过期后爬虫将无法抓取新帖、图片代理将失效。请尽快登录树洞刷新 Token，并更新服务器 <code style="background:#f5f5f7;padding:2px 6px;border-radius:3px;">.env</code> 中的 <code style="background:#f5f5f7;padding:2px 6px;border-radius:3px;">PKU_TOKEN</code> 与 <code style="background:#f5f5f7;padding:2px 6px;border-radius:3px;">PKU_UUID</code>，然后重启 PM2：<code style="background:#f5f5f7;padding:2px 6px;border-radius:3px;">pm2 restart treehole-api --update-env</code>。</p>
          <p style="color:#86868B;font-size:12px;margin-top:16px;margin-bottom:0;">此邮件由 AutoTreehole 系统自动发送，每过期周期仅发送一次。</p>
        </div>
      </div>`,
    });
    console.log(`[token-warn] 已发送 Token 过期告警邮件（剩余 ${Math.ceil(days)} 天）`);
  } catch (e) {
    console.error(`[token-warn] 告警邮件发送失败: ${e.message}`);
    tokenWarnSent = false; // 发送失败则允许下次重试
  }
}

// 启动后 30 秒检查一次，之后每 6 小时检查一次
setTimeout(checkTokenAndWarn, 30_000);
setInterval(checkTokenAndWarn, 6 * 3600_000);

// ==================== 关键词订阅扫描定时器 ====================
// 启动后 60 秒首次扫描（首次仅设水位线不补推），之后每 2 分钟扫描一次
// 注意：ensureDb() 是同步函数（返回 db，非 Promise），不能链式调用 .then
setTimeout(() => { try { ensureDb(); scanAndNotify(); } catch (e) { console.error("[subscribe] 启动扫描失败:", e.message); } }, 60_000);
setInterval(() => { try { scanAndNotify(); } catch (e) { console.error("[subscribe] 定时扫描异常:", e.message); } }, SUB_SCAN_INTERVAL_MS);

// ==================== 树洞周报定时器 ====================
// 启动后 3 分钟补跑（幂等，已存在则跳过），之后每小时检查一次，命中每周一 04:00（上海时间）则生成
setTimeout(() => { generateWeeklyReport().catch(e => console.error("[weekly] 启动补跑失败:", e.message)); }, 180_000);
setInterval(() => {
  const sh = new Date(Date.now() + 8 * 3600_000); // 上海墙上时间
  if (sh.getUTCDay() === 1 && sh.getUTCHours() === 4) {
    generateWeeklyReport().catch(e => console.error("[weekly] 定时生成失败:", e.message));
  }
}, 3600_000);

// HTTP 服务器入口：监听指定端口
// 仅监听 127.0.0.1，公网通过 Nginx 反代访问，禁止绕过 Nginx 直连 9000
// 启动前强校验：TOKEN_SECRET 不能为空或默认值（否则任何人可离线伪造登录令牌）
if (!TOKEN_SECRET || TOKEN_SECRET.length < 16 || TOKEN_SECRET.startsWith("please_change")) {
  console.error("[FATAL] TOKEN_SECRET 未设置或过短或仍为默认值，拒绝启动。请生成随机密钥写入 .env");
  process.exit(1);
}
server.listen(PORT, "127.0.0.1", () => { console.log(`[treehole-api] 服务启动，监听 127.0.0.1:${PORT}`); });
