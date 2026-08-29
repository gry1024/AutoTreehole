#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AutoTreehole 爬虫外部监控脚本
============================
每 N 分钟被 cron 调用一次，做以下事情：
1. 检查 holes 表的 MAX(updated_at)，判断距当前时间是否超过阈值
2. 若超时：
   a. 重启 treehole-crawler 服务
   b. 发送邮件通知 SITE_OWNER_EMAIL
   c. 记录报警状态到本地文件，避免连续报警（同一故障只发一次）
3. 若恢复正常：清除报警状态，补发"恢复通知"邮件

配置文件：同目录 .env（读取 MAIL_USER / MAIL_PASS / MAIL_HOST / MAIL_PORT / SITE_OWNER_EMAIL）
运行：python3 monitor_crawler.py
cron 示例（每 5 分钟执行一次）：
    */5 * * * * /usr/bin/python3 /opt/treehole/monitor_crawler.py >> /var/log/treehole/monitor.log 2>&1
"""

import json
import os
import smtplib
import sqlite3
import ssl
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.header import Header
from pathlib import Path

# ========== 可调参数 ==========
# 距最后一次 DB 更新多少秒视为异常（默认 30 分钟 = 1800s；可通过 MONITOR_STALE_SEC 覆盖）
STALE_THRESHOLD_SEC = int(os.environ.get("MONITOR_STALE_SEC", "1800"))
# 异常告警邮件推送开关：false=停止邮件推送（仍会检测异常、自动重启、写日志）
ALERT_MAIL_ENABLED = os.environ.get("ALERT_MAIL_ENABLED", "false").lower() not in ("false", "0", "no", "off", "")
# 报警文件（记录同一故障是否已发过邮件，避免重复刷屏）
STATE_FILE = Path("/var/log/treehole/monitor_state.json")
# 监控日志目录
LOG_DIR = Path("/var/log/treehole")
LOG_DIR.mkdir(parents=True, exist_ok=True)
# .env 路径（优先读环境变量指定的路径，默认 /opt/treehole/.env）
ENV_PATH = Path(os.environ.get("MONITOR_ENV_PATH", "/opt/treehole/.env"))
# DB 路径
DB_PATH = os.environ.get("TREEHOLE_DB_PATH", "/opt/treehole/treehole.db")


def log(msg: str) -> None:
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def load_env() -> None:
    """从 .env 加载环境变量（已存在的环境变量不覆盖）。"""
    if not ENV_PATH.exists():
        return
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k, v = k.strip(), v.strip()
        # 去掉首尾引号
        if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
            v = v[1:-1]
        os.environ.setdefault(k, v)


def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_state(s: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(s, ensure_ascii=False, indent=2), encoding="utf-8")


def get_db_last_update() -> int:
    """返回 holes 表 MAX(updated_at) 的 unix 秒时间戳。
    DB 不可达时返回 0（当作异常处理）。"""
    try:
        conn = sqlite3.connect(DB_PATH, timeout=5)
        row = conn.execute("SELECT MAX(updated_at) FROM holes").fetchone()
        conn.close()
        if row and row[0]:
            return int(row[0])
        return 0
    except Exception as e:
        log(f"[error] 读取DB失败: {e}")
        return 0


def check_pku_token() -> tuple[bool, str]:
    """探测树洞 API 是否能正常访问。
    关键：PKU 树洞 API 接受 Authorization: Bearer <token> 而非 Cookie。
    之前用 Cookie 一直误报 401，这次改用 Bearer + 真实 UA。
    """
    pku_token = os.environ.get("PKU_TOKEN", "")
    pku_uuid = os.environ.get("PKU_UUID", "")
    if not pku_token or not pku_uuid:
        return False, "PKU_TOKEN / PKU_UUID 未配置"
    try:
        import urllib.request
        req = urllib.request.Request(
            "https://treehole.pku.edu.cn/api/pku_hole?page=1&limit=5",
            headers={
                "authorization": "Bearer " + pku_token,
                "uuid": pku_uuid,
                "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
                "referer": "https://treehole.pku.edu.cn/web/?from=hot",
                "accept": "application/json, text/plain, */*",
                "accept-language": "zh-CN,zh;q=0.9",
            }
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            status = r.getcode()
            body = r.read(500).decode("utf-8", errors="ignore")
            if status == 200 and body.strip().startswith("{"):
                return True, "OK"
            return False, f"HTTP {status}: {body[:120]}"
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}: {e.reason}"
    except Exception as e:
        return False, f"网络异常: {type(e).__name__}: {e}"


def restart_crawler() -> bool:
    """重启 treehole-crawler systemd 服务。返回是否成功。"""
    try:
        # 先尝试温和重启，失败再强杀
        subprocess.run(["systemctl", "restart", "treehole-crawler"],
                       check=True, capture_output=True, text=True, timeout=30)
        log("[action] systemctl restart treehole-crawler 执行成功")
        return True
    except subprocess.CalledProcessError as e:
        log(f"[action] restart 失败，尝试 kill+start: {e.stderr.strip()}")
    except Exception as e:
        log(f"[action] restart 异常: {e}")

    # 兜底：强杀进程 + start
    try:
        subprocess.run(["pkill", "-f", "crawler.py"], capture_output=True, timeout=10)
        time.sleep(3)
        subprocess.run(["systemctl", "start", "treehole-crawler"],
                       check=True, capture_output=True, text=True, timeout=30)
        log("[action] 强杀后重新启动爬虫服务成功")
        return True
    except Exception as e:
        log(f"[action] 兜底重启也失败: {e}")
        return False


def send_email(subject: str, body_html: str) -> bool:
    """使用阿里云 DirectMail 发送 HTML 邮件给 SITE_OWNER_EMAIL。
    当 ALERT_MAIL_ENABLED=False（当前默认）时直接跳过，不发送任何邮件。"""
    if not ALERT_MAIL_ENABLED:
        log(f"[mail] 邮件推送已关闭，跳过: {subject}")
        return False
    mail_user = os.environ.get("MAIL_USER", "")
    mail_pass = os.environ.get("MAIL_PASS", "")
    mail_host = os.environ.get("MAIL_HOST", "smtpdm.aliyun.com")
    mail_port = int(os.environ.get("MAIL_PORT", "465"))
    to_addr = os.environ.get("SITE_OWNER_EMAIL", "")

    if not mail_user or not mail_pass or not to_addr:
        log(f"[mail] 缺少邮件配置: MAIL_USER={'有' if mail_user else '无'} "
            f"MAIL_PASS={'有' if mail_pass else '无'} SITE_OWNER={'有' if to_addr else '无'}")
        return False

    msg = MIMEMultipart("alternative")
    msg["From"] = f"AutoTreehole Monitor <{mail_user}>"
    msg["To"] = to_addr
    msg["Subject"] = Header(subject, "utf-8")
    msg.attach(MIMEText(body_html, "html", "utf-8"))

    try:
        context = ssl.create_default_context()
        with smtplib.SMTP_SSL(mail_host, mail_port, context=context, timeout=30) as smtp:
            smtp.login(mail_user, mail_pass)
            smtp.sendmail(mail_user, [to_addr], msg.as_string())
        log(f"[mail] 邮件发送成功 -> {to_addr}")
        return True
    except Exception as e:
        log(f"[mail] 发送失败: {e}")
        return False


def build_alert_mail_body(stale_min: int, last_update: str, restart_result: bool,
                          now_str: str) -> str:
    return f"""
<html><body style="font-family:-apple-system,Segoe UI,Roboto,'PingFang SC','Microsoft YaHei',sans-serif;line-height:1.7;color:#212529;max-width:640px;margin:24px auto;padding:0 16px;">
<h2 style="color:#dc2626;margin:0 0 16px;">⚠️ AutoTreehole 爬虫异常报警</h2>
<p>检测到树洞数据库超过 <b>{stale_min}</b> 分钟没有新数据写入，爬虫可能已经卡死。</p>
<table style="border-collapse:collapse;width:100%;margin:16px 0;font-size:14px;">
  <tr><td style="padding:8px 12px;border:1px solid #e5e7eb;background:#f3f4f6;width:160px;">最后一次 DB 更新</td><td style="padding:8px 12px;border:1px solid #e5e7eb;">{last_update}</td></tr>
  <tr><td style="padding:8px 12px;border:1px solid #e5e7eb;background:#f3f4f6;">报警触发时间</td><td style="padding:8px 12px;border:1px solid #e5e7eb;">{now_str}</td></tr>
  <tr><td style="padding:8px 12px;border:1px solid #e5e7eb;background:#f3f4f6;">自动重启结果</td><td style="padding:8px 12px;border:1px solid #e5e7eb;"><span style="color:{'#059669' if restart_result else '#dc2626'};">{'✅ 已执行重启' if restart_result else '❌ 重启失败，请手动处理'}</span></td></tr>
</table>
<p style="background:#fffbeb;border-left:4px solid #f59e0b;padding:10px 14px;border-radius:4px;">
<b>处理建议：</b>如果短时间内多次收到此邮件，请登录服务器查看 /var/log/treehole/crawler.log，排查网络或 token 问题。
</p>
<p style="color:#86868b;font-size:12px;margin-top:24px;">AutoTreehole Monitor · {now_str}</p>
</body></html>
"""


def build_recover_mail_body(stale_min_at_peak: int, recovered_after_min: int,
                            recover_time: str) -> str:
    return f"""
<html><body style="font-family:-apple-system,Segoe UI,Roboto,'PingFang SC','Microsoft YaHei',sans-serif;line-height:1.7;color:#212529;max-width:640px;margin:24px auto;padding:0 16px;">
<h2 style="color:#059669;margin:0 0 16px;">✅ AutoTreehole 爬虫已恢复</h2>
<p>之前的报警问题已自动恢复，数据库现在有新数据持续写入。</p>
<table style="border-collapse:collapse;width:100%;margin:16px 0;font-size:14px;">
  <tr><td style="padding:8px 12px;border:1px solid #e5e7eb;background:#f3f4f6;width:160px;">故障时最长无更新</td><td style="padding:8px 12px;border:1px solid #e5e7eb;">{stale_min_at_peak} 分钟</td></tr>
  <tr><td style="padding:8px 12px;border:1px solid #e5e7eb;background:#f3f4f6;">从报警到恢复用时</td><td style="padding:8px 12px;border:1px solid #e5e7eb;">{recovered_after_min} 分钟</td></tr>
  <tr><td style="padding:8px 12px;border:1px solid #e5e7eb;background:#f3f4f6;">恢复确认时间</td><td style="padding:8px 12px;border:1px solid #e5e7eb;">{recover_time}</td></tr>
</table>
<p style="color:#86868b;font-size:12px;margin-top:24px;">AutoTreehole Monitor · {recover_time}</p>
</body></html>
"""


def main() -> int:
    load_env()
    state = load_state()
    now_ts = int(time.time())
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # ========== PKU Token 健康检查（独立分支）==========
    # Token 401 表现为：DB 长时间无更新（爬虫拿到 401 不会写库）。
    # 仅靠 DB 阈值告警无法区分"爬虫卡死" vs "Token 失效"，需主动探测 API。
    token_ok, token_detail = check_pku_token()
    log(f"[token] PKU API 探测: {'OK' if token_ok else 'FAIL'} ({token_detail})")
    if not token_ok:
        # 不重启（重启无效），但立即告警
        subject = f"🔑 AutoTreehole PKU Token 失效：{token_detail[:60]}"
        body = f"""
<html><body style="font-family:-apple-system,Segoe UI,Roboto,'PingFang SC','Microsoft YaHei',sans-serif;line-height:1.7;color:#212529;max-width:640px;margin:24px auto;padding:0 16px;">
<h2 style="color:#dc2626;margin:0 0 16px;">🔑 PKU Token 已失效</h2>
<p>树洞 API 返回非 200 响应：<b>{token_detail}</b></p>
<p>爬虫仍在运行但无法写入新数据。<b>请尽快用浏览器登录 https://treehole.pku.edu.cn 获取新的 pku_token 和 uuid，更新服务器 <code>/opt/treehole/.env</code> 后重启爬虫：</b></p>
<pre style="background:#1f2937;color:#f9fafb;padding:14px;border-radius:6px;overflow-x:auto;font-size:13px;">
ssh treehole
sed -i 's|^PKU_TOKEN=.*|PKU_TOKEN=&lt;新token&gt;|' /opt/treehole/.env
sed -i 's|^PKU_UUID=.*|PKU_UUID=&lt;新uuid&gt;|' /opt/treehole/.env
systemctl restart treehole-crawler
pm2 restart treehole-api --update-env</pre>
<p style="background:#fffbeb;border-left:4px solid #f59e0b;padding:10px 14px;border-radius:4px;">
<b>如何获取新 token：</b>浏览器登录树洞 → F12 → Application → Cookies → 复制 <code>pku_token</code>；F12 → Network → 任一请求 → 复制请求头 <code>uuid</code>。
</p>
<p style="color:#86868b;font-size:12px;margin-top:24px;">AutoTreehole Monitor · {now_str}</p>
</body></html>
"""
        # 去重：同一故障 6 小时只发一次（避免邮件刷屏）
        last_token_alert = state.get("last_token_alert", 0)
        if now_ts - last_token_alert >= 6 * 3600:
            send_email(subject, body)
            state["last_token_alert"] = now_ts
            state["token_alert_detail"] = token_detail
            save_state(state)
        # 不 return，继续跑 DB 检查（让 DB 阈值告警也能发出去，互补）
    else:
        # Token 正常 → 清除 token 告警状态
        if state.get("last_token_alert"):
            log("[token] PKU API 已恢复，清除告警状态")
            state.pop("last_token_alert", None)
            state.pop("token_alert_detail", None)

    last_upd = get_db_last_update()
    if last_upd == 0:
        stale_min = STALE_THRESHOLD_SEC // 60 + 9999
        log(f"[check] DB不可读，视为异常（stale={stale_min}min）")
    else:
        stale_min = (now_ts - last_upd) // 60
        last_upd_str = datetime.fromtimestamp(last_upd).strftime("%Y-%m-%d %H:%M:%S")
        log(f"[check] DB最后更新: {last_upd_str}（{stale_min} 分钟前），阈值 {STALE_THRESHOLD_SEC // 60} 分钟")

    is_stale = stale_min * 60 >= STALE_THRESHOLD_SEC

    # ========== 异常分支 ==========
    if is_stale:
        log("[status] 异常：无更新超过阈值")
        last_upd_str = datetime.fromtimestamp(last_upd).strftime("%Y-%m-%d %H:%M:%S") if last_upd else "N/A"

        # 峰值记录（记录看到的最大 stale_min，恢复邮件时用）
        state["peak_stale_min"] = max(state.get("peak_stale_min", 0), stale_min)

        # 执行重启（每轮都尝试重启，避免上次重启没生效）
        restart_ok = restart_crawler()

        # 报警邮件去重：同一故障只发一次
        if not state.get("alert_sent", False):
            mail_ok = send_email(
                subject=f"⚠️ AutoTreehole 爬虫异常：{stale_min}分钟无新数据",
                body_html=build_alert_mail_body(stale_min, last_upd_str, restart_ok, now_str),
            )
            state["alert_sent"] = True
            state["alert_time"] = now_ts
            state["alert_stale_min"] = stale_min
            state["last_mail_sent"] = now_ts
            state["mail_ok"] = mail_ok
            log(f"[mail] 首次报警邮件 {'已发送' if mail_ok else '发送失败'}")
        else:
            # 已报过警 → 每 30 分钟发一次"持续报警"提醒，避免沉默
            last_mail = state.get("last_mail_sent", 0)
            if now_ts - last_mail >= 1800:
                mail_ok = send_email(
                    subject=f"⚠️ AutoTreehole 爬虫仍异常：{stale_min}分钟无新数据",
                    body_html=build_alert_mail_body(stale_min, last_upd_str, restart_ok, now_str),
                )
                state["last_mail_sent"] = now_ts
                log(f"[mail] 持续报警邮件 {'已发送' if mail_ok else '发送失败'}（距上次 {int((now_ts-last_mail)/60)} 分钟）")
            else:
                log("[mail] 报警已发过，暂不重复")

        save_state(state)
        return 1

    # ========== 正常分支 ==========
    log("[status] 正常：有新数据持续写入")
    if state.get("alert_sent", False):
        # 之前处于报警状态，现在恢复了 → 发恢复邮件
        peak = state.get("peak_stale_min", 0)
        alert_time = state.get("alert_time", now_ts)
        recover_min = (now_ts - alert_time) // 60
        mail_ok = send_email(
            subject="✅ AutoTreehole 爬虫已恢复正常",
            body_html=build_recover_mail_body(peak, recover_min, now_str),
        )
        log(f"[recover] 发送恢复邮件: {'OK' if mail_ok else 'FAIL'}")
        # 清除报警状态
        state = {
            "last_check": now_ts,
            "last_normal": now_ts,
        }
    else:
        state["last_check"] = now_ts
        state["last_normal"] = now_ts

    save_state(state)
    return 0


if __name__ == "__main__":
    sys.exit(main())
