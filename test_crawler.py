#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
北大树洞 API 连通性 + Token 有效性自检（最简版）

只做两件事：
  1. 本机能否连到 treehole.pku.edu.cn（443）
  2. PKU_TOKEN / PKU_UUID 是否还有效（成功拉到首条帖子即视为有效）

运行：python test_crawler.py
"""

import os
import socket
import sys
import base64
import json
import datetime
from pathlib import Path
from urllib.parse import urlparse

import requests

# ---------- 1. 读 .env ----------
_env_path = Path(os.environ.get("TREEHOLE_ENV_PATH", ".env"))
if _env_path.exists():
    for line in _env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        os.environ.setdefault(k.strip(), v.strip())

TOKEN = os.environ.get("PKU_TOKEN", "").strip()
UUID  = os.environ.get("PKU_UUID", "").strip()
BASE  = "https://treehole.pku.edu.cn/api/"


def decode_token_payload(token: str) -> dict:
    """解码 JWT payload（不验签），用于显示 token 元数据。"""
    try:
        parts = token.split(".")
        if len(parts) < 2:
            return {}
        payload_b64 = parts[1] + "=" * (-len(parts[1]) % 4)
        p = json.loads(base64.urlsafe_b64decode(payload_b64))
        out = {"sub": p.get("sub"), "iss": p.get("iss", "")[-30:]}
        if "iat" in p:
            out["iat"] = datetime.datetime.fromtimestamp(p["iat"], tz=datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        if "exp" in p:
            exp = datetime.datetime.fromtimestamp(p["exp"], tz=datetime.timezone.utc)
            out["exp"] = exp.strftime("%Y-%m-%d %H:%M UTC")
            now = datetime.datetime.now(datetime.timezone.utc)
            out["剩余"] = f"{round((exp-now).total_seconds()/3600, 1)} 小时"
        return out
    except Exception as e:
        return {"error": str(e)}

# Windows 终端中文/emoji 兼容
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def ok(msg):  print(f"  ✅ {msg}")
def bad(msg): print(f"  ❌ {msg}")
def info(msg): print(f"  ·  {msg}")


print("=" * 56)
print(" 树洞 API 自检")
print("=" * 56)

# ---------- 2. 检查凭证是否填了 ----------
print("\n[1/3] 读取 .env 凭证")
if not TOKEN:
    bad("PKU_TOKEN 为空，请在 .env 里填入浏览器 cookie 里的 pku_token")
    sys.exit(1)
ok(f"PKU_TOKEN 已读取（{len(TOKEN)} 字符）")
# 显示 token 元数据，方便判断是不是过期/不一致
meta = decode_token_payload(TOKEN)
if meta:
    info(f"Token 元数据: sub={meta.get('sub')} iat={meta.get('iat')} exp={meta.get('exp')} ({meta.get('剩余')})")
if not UUID:
    bad("PKU_UUID 为空，请在 .env 里填入浏览器请求头里的 uuid")
    sys.exit(1)
ok(f"PKU_UUID 已读取（{UUID[:20]}…）")

# ---------- 3. TCP 连通性 ----------
print("\n[2/3] 测试本机 → treehole.pku.edu.cn:443 连通性")
host = urlparse(BASE).hostname
try:
    infos = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    info(f"DNS 解析到 {len(infos)} 个地址，例如 {infos[0][4][0]}")
    s = socket.create_connection((host, 443), timeout=8)
    s.close()
    ok("TCP 443 握手成功（网络可达）")
except Exception as e:
    bad(f"TCP 连接失败：{e}")
    info("可能原因：本机无外网 / 被防火墙拦截 / DNS 污染")
    sys.exit(1)

# ---------- 4. Token 有效性 ----------
print("\n[3/3] 测试 Token 是否有效（拉取首页 1 条帖子）")
# PKU 树洞 API 鉴权用 Authorization: Bearer <token> + uuid headers
# 注意：requests 默认会保留重定向时的 Authorization，所以直接用 sessions 关闭重定向保险
headers = {
    "authorization": "Bearer " + TOKEN,
    "uuid": UUID,
    "referer": "https://treehole.pku.edu.cn/web/",
    "accept": "application/json, text/plain, */*",
    # 用真实的浏览器 UA，避免服务端指纹校验拦截
    "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    "accept-language": "zh-CN,zh;q=0.9",
}
#  关闭重定向：避免重定向到 cas 登录页丢 Bearer
r = requests.get(BASE + "pku_hole",
                 params={"page": 1, "limit": 1},
                 headers=headers,
                 timeout=15,
                 allow_redirects=False)
# 失败兜底：再试一次不限制重定向
if r.status_code in (301, 302, 307, 308):
    r = requests.get(BASE + "pku_hole",
                     params={"page": 1, "limit": 1},
                     headers=headers,
                     timeout=15)

info(f"HTTP 状态码: {r.status_code}")
if r.status_code in (401, 403):
    bad("Token 鉴权失败（401/403）— 重新登录树洞后从浏览器取新的 pku_token")
    info(f"接口返回: {r.text[:200]}")
    sys.exit(1)

if r.status_code != 200:
    bad(f"接口异常 {r.status_code}: {r.text[:200]}")
    sys.exit(1)

try:
    data = r.json()
except Exception:
    bad("响应不是 JSON，Token 可能已被服务端拒绝")
    sys.exit(1)

if not data.get("success"):
    bad(f"接口 success=false：code={data.get('code')} msg={data.get('message')}")
    sys.exit(1)

holes = (data.get("data") or {}).get("data") or []
if not holes:
    warn = "⚠️  接口成功但返回 0 条帖子（罕见，可能服务端维护）"
    print(f"  {warn}")
else:
    h = holes[0]
    pid   = h.get("pid")
    text  = (h.get("text") or "").replace("\n", " ")
    ts    = h.get("timestamp")
    like  = h.get("likenum")
    reply = h.get("reply")
    ok(f"Token 有效！最新一条 pid={pid}  ❤️{like}  💬{reply}")
    print()
    print("    ┌─ 帖子内容 " + "─" * 40)
    for line in text.splitlines() or [text]:
        print(f"    │ {line}")
    print("    └" + "─" * 52)

print("\n" + "=" * 56)
print(" 🎉 全部通过 — 树洞 API 可用、Token 有效")
print("=" * 56)