#!/usr/bin/env node
/**
 * 北大树洞自动登录脚本（零依赖，仅需 Node.js 22+ 与本机 Chrome）
 *
 * 原理：
 *   树洞网页登录态 = cookie 里的 pku_token + localStorage 里的 pku-uuid，
 *   两者必须来自同一会话（服务器按 uuid 校验 token，不匹配会触发短信验证 40002）。
 *   本脚本用 Chrome DevTools Protocol (CDP) 启动一个独立配置文件的 Chrome，
 *   直接注入 .env 里爬虫在用的这对凭证，然后打开树洞首页即自动登录。
 *
 * 用法：node login_treehole.js   （或双击 login_treehole.bat）
 *
 * 说明：
 *   - 使用独立浏览器配置文件（不影响你日常的 Chrome 窗口，两者可同时开）
 *   - Chrome 窗口会保留，脚本退出不影响浏览
 *   - token 过期后需更新 .env 里的 PKU_TOKEN（JWT exp 约 30 天）
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ==================== 配置 ====================
const DEBUG_PORT = 9333; // CDP 调试端口（避开常用端口）
const PROFILE_DIR = path.join(process.env.LOCALAPPDATA || process.env.TMP, 'treehole-login-profile');
const CHROME_CANDIDATES = [
  path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', // 兜底：Edge 同为 Chromium
];

// ==================== 工具函数 ====================
const log = (msg) => console.log(`  ${msg}`);
const ok = (msg) => console.log(`  [OK] ${msg}`);
const bad = (msg) => console.error(`  [!!] ${msg}`);

/** 从脚本同目录的 .env 读取 PKU_TOKEN / PKU_UUID */
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) throw new Error(`找不到 ${envPath}`);
  const env = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(PKU_TOKEN|PKU_UUID)\s*=\s*(.+?)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  if (!env.PKU_TOKEN) throw new Error('.env 中缺少 PKU_TOKEN');
  if (!env.PKU_UUID) throw new Error('.env 中缺少 PKU_UUID');
  return env;
}

/** 解码 JWT payload 检查过期时间（不验签，仅提示用） */
function tokenInfo(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    const exp = payload.exp || 0;
    const remainHours = Math.round((exp * 1000 - Date.now()) / 3600000);
    return { valid: remainHours > 0, remainHours, sub: payload.sub };
  } catch { return { valid: true, remainHours: null }; }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 等待 CDP 调试端口就绪（Chrome 启动需要一两秒） */
async function waitDebugPort(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (res.ok) return await res.json();
    } catch { /* 端口未就绪，继续等 */ }
    await sleep(400);
  }
  throw new Error(`等待 Chrome 调试端口 ${DEBUG_PORT} 超时`);
}

/** 极简 CDP 客户端：全局 WebSocket（Node 22+ 内置）+ 递增 id 匹配响应 */
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;
  ws.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    } catch { /* 忽略事件通知 */ }
  });
  return {
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => ws.close(),
    ready: new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    }),
  };
}

// ==================== 主流程 ====================
async function main() {
  console.log('\n===== 北大树洞自动登录 =====\n');

  // 1. 读取并校验凭证
  const env = loadEnv();
  const info = tokenInfo(env.PKU_TOKEN);
  if (info.remainHours !== null) {
    if (!info.valid) {
      bad(`PKU_TOKEN 已过期！请登录 treehole.pku.edu.cn 后从浏览器 F12 取新 token 更新 .env`);
      process.exit(1);
    }
    log(`token 剩余有效期约 ${info.remainHours} 小时（账号 ${info.sub}）`);
  }
  log(`uuid: ${env.PKU_UUID.slice(0, 30)}…`);

  // 2. 定位浏览器
  const chrome = CHROME_CANDIDATES.find(p => p && fs.existsSync(p));
  if (!chrome) throw new Error('未找到 Chrome/Edge，请确认安装路径');
  log(`浏览器: ${chrome}`);

  // 3. 若调试端口未开，则启动 Chrome（独立配置文件，不影响日常窗口）
  let version;
  try {
    version = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json();
    log('检测到已有登录实例，直接复用');
  } catch {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    const child = spawn(chrome, [
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      '--no-first-run', '--no-default-browser-check',
      '--restore-last-session=false',
      'about:blank',
    ], { detached: true, stdio: 'ignore' });
    child.unref(); // 脱离父进程：本脚本退出后 Chrome 继续运行
    version = await waitDebugPort();
  }
  log(`已启动: ${version.Browser}`);

  // 4. 取一个页面标签（没有就新建）
  let targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  let page = targets.find(t => t.type === 'page');
  if (!page) {
    await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method: 'PUT' });
    targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    page = targets.find(t => t.type === 'page');
  }

  // 5. 建立页面级 CDP 连接（Network / DOMStorage / Page / Runtime 都在页面会话上）
  const pageClient = cdp(page.webSocketDebuggerUrl);
  await pageClient.ready;

  try {
    // 5a. 先导航到树洞域下的静态资源（favicon）：
    //     建立该源的 frame，供 localStorage 写入定位；不触发 SPA 的登录跳转
    await pageClient.call('Page.navigate', { url: 'https://treehole.pku.edu.cn/web/favicon.ico' });
    await sleep(1500);

    // 5b. cookie：pku_token（与树洞前端 $cookies.set 行为一致，2 天有效）
    await pageClient.call('Network.setCookie', {
      name: 'pku_token',
      value: env.PKU_TOKEN,
      domain: 'treehole.pku.edu.cn',
      path: '/',
      expires: Math.floor(Date.now() / 1000) + 2 * 86400,
    });
    ok('cookie pku_token 已注入');

    // 5c. localStorage：pku-uuid（必须与 token 同会话，否则触发短信验证）
    await pageClient.call('DOMStorage.setDOMStorageItem', {
      storageId: { securityOrigin: 'https://treehole.pku.edu.cn', isLocalStorage: true },
      key: 'pku-uuid',
      value: env.PKU_UUID,
    });
    ok('localStorage pku-uuid 已注入');

    // 6. 打开树洞首页
    await pageClient.call('Page.navigate', { url: 'https://treehole.pku.edu.cn/web/' });
    log('正在打开树洞…');

    // 7. 等待页面加载并验证登录态（若被重定向到 iaaa 即登录失败）
    await sleep(5000);
    const result = await pageClient.call('Runtime.evaluate', {
      expression: 'JSON.stringify({href: location.href, hasCookie: document.cookie.includes("pku_token=")})',
      returnByValue: true,
    });
    const state = JSON.parse(result.result.value);

    console.log('');
    if (state.href.includes('iaaa.pku.edu.cn')) {
      bad('登录失败：页面被重定向到统一身份认证（token 可能已在服务器端失效）');
      bad('请浏览器登录树洞 → F12 → Application → Cookies 取新 pku_token，更新 .env 后重试');
      process.exitCode = 1;
    } else {
      ok(`登录成功！页面: ${state.href}`);
      console.log('\n浏览器窗口已保留，可直接浏览。\n');
    }
  } finally {
    // 正常关闭连接，避免进程退出时 libuv 断言崩溃
    pageClient.close();
    await sleep(300);
  }
}

main().catch(e => { console.error(`\n  [!!] ${e.message}\n`); process.exitCode = 1; });
