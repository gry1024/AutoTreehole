#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
北大树洞 7x24 增量爬虫（精简直连版）

依赖：pip install requests   （sqlite3 为标准库）
运行：python crawler.py

技术要点
--------
1. 认证：树洞已强制 CAS+短信验证，无法用账密自动登录。
   本脚本使用浏览器登录后获取的 JWT(pku_token) + web uuid 直连 API。
   - TOKEN：浏览器 F12 → Application → Cookies → pku_token
   - UUID  ：浏览器 F12 → Network → 任一请求头 → uuid
   token 有效期约 30 天（见 JWT 的 exp 字段），过期需重新填入。
2. 接口：
   - 帖子列表 GET /api/pku_hole?page=N&limit=25  返回最新 25 条（pid 降序）
   - 帖子字段含 pid/text/timestamp/reply(评论数)/likenum(收藏量)/type 等，无需再调详情
   - 评论列表 GET /api/pku_comment_v3/{pid}?page=N&limit=15&sort=asc
   - 评论字段含 cid/text/timestamp/name(匿名名)/comment_id(回复目标)/quote 等
3. 增量：以 max(pid) 为高水位，每轮只处理 pid>水位 的新帖；每条新帖抓取后顺带抓其评论；
   重启时从数据库恢复水位。评论按 cid 主键去重，重复抓取自动跳过。
4. 速率：每入库一条帖子休眠 SLEEP_PER_ITEM 秒（默认 5 秒/条）；抓评论按 COMMENT_SLEEP 间隔；
   时段由 ACTIVE_HOURS 控制。
5. 存储：sqlite3，holes 与 comments 两表，pid/cid 主键去重，同时保留原始 JSON 便于后续扩展。
"""

import json
import sqlite3
import sys
import time
from datetime import datetime
from typing import List, Optional
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError

import requests

# Windows 控制台中文/emoji 兼容
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# ==================== 配置区 ====================
# 树洞 API 凭证（需自行登录 treehole.pku.edu.cn 后从浏览器获取，填入 .env）
# 详见 README 与 .env.example
import os as _os
from pathlib import Path as _Path

def _load_env():
    """从 .env 加载环境变量（同目录优先，便于本地复现）。"""
    for p in [_os.environ.get("TREEHOLE_ENV_PATH", ".env"), ".env"]:
        if not p:
            continue
        f = _Path(p)
        if f.exists():
            for line in f.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                _os.environ.setdefault(k.strip(), v.strip())
            break
_load_env()

TOKEN = _os.environ.get("PKU_TOKEN", "")
UUID = _os.environ.get("PKU_UUID", "")

BASE = "https://treehole.pku.edu.cn/api/"
PAGE_SIZE = 25                 # 帖子列表每页条数（服务端上限 25）
COMMENT_PAGE_SIZE = 15         # 评论列表每页条数（服务端上限 15）
SLEEP_PER_ITEM = 5.0           # 每条帖子入库后的休眠秒数（速率控制：5 秒/条）
COMMENT_SLEEP = 2.0            # 每次评论请求间隔秒数（评论分页用）
ROUND_SLEEP = 60.0             # 每轮发现无新帖后的休眠秒数
ACTIVE_HOURS = (0, 24)         # 允许爬取时段，24h 制，如 (8, 23) = 8点~23点
INITIAL_PAGES = 1              # 首次运行回抓的历史页数（仅抓最新这么多页作种子，避免回爬全部历史）
MAX_DISCOVER_PAGES = 20        # 单轮发现最多翻页数（防突发更新过多时失控）

# --- 帖子元数据回刷（保持收藏量/评论数与线上同步）---
REFRESH_INTERVAL = 5           # 每 N 轮触发一次浅度回刷
REFRESH_PAGES = 10             # 浅度回刷翻页数（10 页 = 最近 ~250 条）
REFRESH_SLEEP = 3.0            # 回刷翻页间隔秒数

# --- 每日凌晨 3 点全量回刷最近 5000 条 ---
DAILY_REFRESH_TARGET = 5000    # 每日回刷目标帖子数
DAILY_REFRESH_SLEEP = 3.0      # 每日回刷翻页间隔秒数
DAILY_REFRESH_HOUR = 3         # 触发小时（凌晨 3 点）
DB_PATH = _os.environ.get("TREEHOLE_DB_PATH", "./treehole.db")  # 数据库文件路径
UA = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36"
# ====================================================================================

HEADERS = {
    "authorization": "Bearer " + TOKEN,
    "uuid": UUID,
    "referer": "https://treehole.pku.edu.cn/web/",
    "accept": "application/json, text/plain, */*",
    "user-agent": UA,
}


# ------------------- 数据库 -------------------
def db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS holes (
            pid         INTEGER PRIMARY KEY,
            text        TEXT,
            type        TEXT,
            timestamp   INTEGER,
            reply       INTEGER,
            likenum     INTEGER,
            extra       INTEGER,
            anonymous   INTEGER,
            tag         TEXT,
            image_size  TEXT,
            raw         TEXT,
            crawled_at  INTEGER,
            updated_at  INTEGER,
            deleted     INTEGER DEFAULT 0
        )
        """
    )
    # 迁移：为旧表添加 updated_at 列
    try:
        conn.execute("ALTER TABLE holes ADD COLUMN updated_at INTEGER")
    except sqlite3.OperationalError:
        pass  # 列已存在
    # 迁移：为旧表添加 deleted 列（0=正常，1=已被平台删除）
    try:
        conn.execute("ALTER TABLE holes ADD COLUMN deleted INTEGER DEFAULT 0")
    except sqlite3.OperationalError:
        pass  # 列已存在
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS comments (
            cid         INTEGER PRIMARY KEY,
            pid         INTEGER,
            text        TEXT,
            timestamp   INTEGER,
            name        TEXT,
            comment_id  INTEGER,
            quote       TEXT,
            mention     TEXT,
            tag         TEXT,
            raw         TEXT,
            crawled_at  INTEGER
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_comments_pid ON comments(pid)")
    conn.commit()
    return conn


def db_max_pid(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT MAX(pid) FROM holes").fetchone()
    return row[0] or 0


def db_insert(conn: sqlite3.Connection, h: dict) -> bool:
    """插入一条树洞；pid 重复则忽略。返回是否为新插入。"""
    cur = conn.execute(
        """
        INSERT OR IGNORE INTO holes
        (pid, text, type, timestamp, reply, likenum, extra, anonymous, tag, image_size, raw, crawled_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        (
            h.get("pid"), h.get("text"), h.get("type"), h.get("timestamp"),
            h.get("reply"), h.get("likenum"), h.get("extra"), h.get("anonymous"),
            json.dumps(h.get("tag"), ensure_ascii=False) if h.get("tag") is not None else None,
            json.dumps(h.get("image_size"), ensure_ascii=False) if h.get("image_size") else None,
            json.dumps(h, ensure_ascii=False),
            int(time.time()),
        ),
    )
    conn.commit()
    is_new = cur.rowcount > 0
    return is_new


def db_insert_comment(conn: sqlite3.Connection, c: dict) -> bool:
    """插入一条评论；cid 重复则忽略。返回是否为新插入。"""
    cur = conn.execute(
        """
        INSERT OR IGNORE INTO comments
        (cid, pid, text, timestamp, name, comment_id, quote, mention, tag, raw, crawled_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
        """,
        (
            c.get("cid"), c.get("pid"), c.get("text"), c.get("timestamp"),
            c.get("name"), c.get("comment_id"),
            json.dumps(c.get("quote"), ensure_ascii=False) if c.get("quote") is not None else None,
            c.get("mention"),
            json.dumps(c.get("tag"), ensure_ascii=False) if c.get("tag") is not None else None,
            json.dumps(c, ensure_ascii=False),
            int(time.time()),
        ),
    )
    conn.commit()
    return cur.rowcount > 0


def db_update_meta(conn: sqlite3.Connection, h: dict) -> bool:
    """更新已有帖子的收藏量/评论数等元数据（不覆盖正文和原始 JSON）。"""
    cur = conn.execute(
        """
        UPDATE holes SET likenum=?, reply=?, updated_at=? WHERE pid=?
        """,
        (h.get("likenum"), h.get("reply"), int(time.time()), h.get("pid")),
    )
    conn.commit()
    return cur.rowcount > 0


# ------------------- API -------------------
# 硬超时秒数：即使底层 socket select 卡死，也强制放弃整个请求线程。
# requests 的 timeout 参数在连接建立/TLS 协商阶段不总是可靠，
# 这里用线程级 future.result(timeout) 兜底，防止爬虫永久挂起。
HARD_TIMEOUT = 30
_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="api")


def _do_request(path: str, params: Optional[dict]) -> Optional[dict]:
    """实际执行 requests.get 的内部函数（在线程池中运行）。"""
    r = requests.get(BASE + path, params=params, headers=HEADERS, timeout=15)
    if r.status_code == 401:
        return None
    try:
        d = r.json()
    except Exception:
        print(f"[net] 非 JSON 响应 {path}: {r.status_code} {r.text[:120]}", flush=True)
        return None
    if not d.get("success"):
        print(f"[auth] 接口拒绝: code={d.get('code')} msg={d.get('message')}", flush=True)
        return None
    return d


def api_get(path: str, params: Optional[dict] = None) -> Optional[dict]:
    """GET 一个 API，返回解析后的 JSON；鉴权失效或超时返回 None。

    使用线程池 + future.result(HARD_TIMEOUT) 做硬超时保护，
    防止 requests 在 DNS/TCP/TLS 阶段卡死导致整个爬虫挂起。
    """
    try:
        fut = _executor.submit(_do_request, path, params)
        return fut.result(timeout=HARD_TIMEOUT)
    except FuturesTimeoutError:
        print(f"[net] 硬超时 {HARD_TIMEOUT}s {path}（底层 socket 可能卡死，已放弃）", flush=True)
        return None
    except Exception as e:
        print(f"[net] 请求异常 {path}: {e}", flush=True)
        return None


def discover_new(max_seen: int, max_pages: int, conn=None) -> List[dict]:
    """从第 1 页向后翻，收集 pid>max_seen 的新帖，按 pid 升序返回。

    如果传入 conn，遇到已入库的帖子时会顺带更新其元数据（收藏量/评论数）。
    """
    fresh: List[dict] = []
    meta_updated = 0
    for page in range(1, max_pages + 1):
        d = api_get("pku_hole", {"page": page, "limit": PAGE_SIZE})
        if not d:
            break
        holes = d["data"]["data"]
        if not holes:
            break
        for h in holes:
            pid = h.get("pid", 0)
            if pid > max_seen:
                fresh.append(h)
            elif conn:
                # 已有帖子：顺带更新元数据
                db_update_meta(conn, h)
                meta_updated += 1
        # 当前页最旧的 pid 已 <= 水位 → 与历史重叠，无需再翻
        if holes[-1].get("pid", 0) <= max_seen:
            break
    fresh.sort(key=lambda h: h["pid"])
    if meta_updated:
        print(f"[discover] 顺带更新 {meta_updated} 条已有帖子的元数据", flush=True)
    return fresh


def fetch_comments(pid: int) -> List[dict]:
    """抓取某帖子的全部评论，自动翻页，按时间升序返回。"""
    comments: List[dict] = []
    page = 1
    while True:
        d = api_get(f"pku_comment_v3/{pid}",
                    {"page": page, "limit": COMMENT_PAGE_SIZE, "sort": "asc"})
        if not d:
            break
        data = d["data"]
        batch = data.get("data") or []
        comments.extend(batch)
        last_page = data.get("last_page", 1)
        if page >= last_page or not batch:
            break
        page += 1
        time.sleep(COMMENT_SLEEP)
    return comments


def _do_check_deleted(pid: int) -> Optional[dict]:
    """实际执行删除检测请求的内部函数（在线程池中运行）。"""
    r = requests.get(BASE + f"pku_comment_v3/{pid}",
                     params={"page": 1, "limit": 1, "sort": "asc"},
                     headers=HEADERS, timeout=15)
    if r.status_code == 401:
        return None
    try:
        return r.json()
    except Exception:
        return None


def is_post_deleted(pid: int) -> bool:
    """通过评论 API 检测帖子是否已被平台删除。

    逻辑：请求评论列表，若 success=false 且非 token 失效（40001/40002），
    则判定为帖子已被删除。正常返回或网络异常时返回 False（不误判）。
    使用线程池 + 硬超时保护，防止 socket 卡死。
    """
    try:
        fut = _executor.submit(_do_check_deleted, pid)
        d = fut.result(timeout=HARD_TIMEOUT)
    except (FuturesTimeoutError, Exception):
        return False  # 超时或异常，不确定，不标记
    if d is None:
        return False  # 鉴权失效或解析失败
    if d.get("success"):
        return False  # 正常返回，帖子存在
    # success=false：区分 token 失效与帖子不存在
    code = d.get("code")
    if code in (40001, 40002):
        return False  # token/uuid 失效
    # 其他 code → 帖子不存在或已被删除
    return True


def scan_deleted_posts(conn: sqlite3.Connection, days: int = 7,
                       seen_pids: Optional[set] = None) -> None:
    """扫描最近 N 天内可能被删除的帖子并标记。

    seen_pids: 本次回刷中在列表 API 里见过的 pid 集合（这些帖子一定存在）。
    只检查不在 seen_pids 中且 deleted=0 的近期帖子。
    """
    since = int(time.time()) - days * 86400
    rows = conn.execute(
        "SELECT pid FROM holes WHERE timestamp >= ? AND (deleted IS NULL OR deleted=0)",
        (since,)
    ).fetchall()
    to_check = [r[0] for r in rows if not seen_pids or r[0] not in seen_pids]
    if not to_check:
        print(f"[scan] 无需检测删除的帖子", flush=True)
        return
    print(f"[scan] 检测 {len(to_check)} 条近期帖子是否被删除…", flush=True)
    deleted_count = 0
    for pid in to_check:
        if is_post_deleted(pid):
            conn.execute("UPDATE holes SET deleted=1 WHERE pid=?", (pid,))
            conn.commit()
            deleted_count += 1
            print(f"  ✗ pid={pid} 已被删除（标记保留）", flush=True)
        time.sleep(3)
    print(f"[scan] 删除检测完成：检查 {len(to_check)} 条，标记 {deleted_count} 条已删除", flush=True)


def refresh_recent_posts(conn: sqlite3.Connection) -> None:
    """回刷最近帖子的元数据（收藏量/评论数），保持与线上同步。

    策略：翻阅前 REFRESH_PAGES 页（~250 条），对 DB 中已有的帖子更新元数据；
    如果评论数增长，则重新抓取该帖评论补充新增的。
    """
    existing_pids = set()
    updated = 0
    for page in range(1, REFRESH_PAGES + 1):
        d = api_get("pku_hole", {"page": page, "limit": PAGE_SIZE})
        if not d:
            break
        holes = d["data"]["data"]
        if not holes:
            break
        for h in holes:
            pid = h.get("pid")
            if not pid:
                continue
            # 只更新 DB 中已存在的帖子
            row = conn.execute("SELECT reply FROM holes WHERE pid=?", (pid,)).fetchone()
            if row:
                old_reply = row[0] or 0
                new_reply = h.get("reply", 0)
                db_update_meta(conn, h)
                updated += 1
                # 评论数增长 → 补抓新评论
                if new_reply > old_reply:
                    cmts = fetch_comments(pid)
                    new_cmts = 0
                    for c in cmts:
                        if db_insert_comment(conn, c):
                            new_cmts += 1
                    if new_cmts:
                        print(f"  ↻ pid={pid} 评论 {old_reply}→{new_reply}，新增 {new_cmts} 条", flush=True)
                # 收藏量变化时打印
                old_like = conn.execute("SELECT likenum FROM holes WHERE pid=?", (pid,)).fetchone()[0] or 0
                if h.get("likenum", 0) != old_like:
                    print(f"  ↻ pid={pid} 收藏 {old_like}→{h.get('likenum')}", flush=True)
        time.sleep(REFRESH_SLEEP)
    print(f"[refresh] 回刷完成：更新 {updated} 条帖子的元数据", flush=True)


def daily_refresh(conn: sqlite3.Connection) -> None:
    """每日全量回刷最近 5000 条帖子的元数据。

    翻页直到覆盖 DAILY_REFRESH_TARGET 条帖子，更新收藏量/评论数；
    评论数增长的帖子补抓新评论。
    回刷完成后，对近期未出现在列表中的帖子进行删除检测。
    """
    pages_needed = (DAILY_REFRESH_TARGET + PAGE_SIZE - 1) // PAGE_SIZE
    updated = 0
    total_seen = 0
    seen_pids = set()
    print(f"[daily] 开始每日回刷：翻 {pages_needed} 页，目标 {DAILY_REFRESH_TARGET} 条", flush=True)
    for page in range(1, pages_needed + 1):
        d = api_get("pku_hole", {"page": page, "limit": PAGE_SIZE})
        if not d:
            print(f"[daily] 第 {page} 页请求失败，跳过", flush=True)
            time.sleep(DAILY_REFRESH_SLEEP)
            continue
        holes = d["data"]["data"]
        if not holes:
            print(f"[daily] 第 {page} 页无数据，结束", flush=True)
            break
        for h in holes:
            pid = h.get("pid")
            if not pid:
                continue
            seen_pids.add(pid)
            total_seen += 1
            row = conn.execute("SELECT reply FROM holes WHERE pid=?", (pid,)).fetchone()
            if row:
                old_reply = row[0] or 0
                new_reply = h.get("reply", 0)
                db_update_meta(conn, h)
                updated += 1
                if new_reply > old_reply:
                    cmts = fetch_comments(pid)
                    new_cmts = 0
                    for c in cmts:
                        if db_insert_comment(conn, c):
                            new_cmts += 1
                    if new_cmts:
                        print(f"  ↻ pid={pid} 评论 {old_reply}→{new_reply}，新增 {new_cmts} 条", flush=True)
        if page % 10 == 0:
            print(f"[daily] 进度：已翻 {page}/{pages_needed} 页，更新 {updated} 条", flush=True)
        time.sleep(DAILY_REFRESH_SLEEP)
    print(f"[daily] 完成：共翻 {min(page, pages_needed)} 页，更新 {updated}/{total_seen} 条帖子的元数据", flush=True)
    # 回刷后检测被删除的帖子
    scan_deleted_posts(conn, days=7, seen_pids=seen_pids)


# ------------------- 工具 -------------------
def in_window() -> bool:
    a, b = ACTIVE_HOURS
    return a <= datetime.now().hour < b


def token_expiry() -> Optional[float]:
    """解析 JWT 的 exp（不验签），返回到期时间戳；失败返回 None。"""
    try:
        payload = TOKEN.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(__import__("base64").urlsafe_b64decode(payload))["exp"]
    except Exception:
        return None


def fmt_time(ts: int) -> str:
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")


# ------------------- 主流程 -------------------
def main() -> None:
    if not TOKEN or not UUID:
        print("未检测到 PKU_TOKEN / PKU_UUID，请在 .env 中配置（详见 README）。", flush=True)
        sys.exit(1)

    exp = token_expiry()
    if exp:
        days_left = (exp - time.time()) / 86400
        print(f"[auth] token 剩余有效期约 {days_left:.1f} 天"
              + ("（即将过期，请尽快刷新）" if days_left < 3 else ""), flush=True)

    conn = db_connect()
    max_seen = db_max_pid(conn)
    first_run = max_seen == 0
    hole_count = conn.execute("SELECT COUNT(*) FROM holes").fetchone()[0]
    cmt_count = conn.execute("SELECT COUNT(*) FROM comments").fetchone()[0]
    print(f"[start] 已有 帖子 {hole_count} 条 / 评论 {cmt_count} 条，"
          f"水位 pid={max_seen}，时段 {ACTIVE_HOURS}，"
          f"{'首次运行' if first_run else '增量模式'}，开始 7x24 爬取", flush=True)

    round_count = 0
    last_daily_date = None  # 记录上次每日回刷的日期，确保每天只触发一次
    while True:
        if not in_window():
            print(f"[{datetime.now():%H:%M:%S}] 非活跃时段，等待 60s", flush=True)
            time.sleep(60)
            continue

        # 每日凌晨 3 点触发全量回刷最近 5000 条
        now = datetime.now()
        today_str = now.strftime("%Y-%m-%d")
        if now.hour == DAILY_REFRESH_HOUR and last_daily_date != today_str:
            print(f"[daily] {today_str} 凌晨回刷启动，更新最近 {DAILY_REFRESH_TARGET} 条帖子…", flush=True)
            daily_refresh(conn)
            last_daily_date = today_str

        round_count += 1

        # 每 REFRESH_INTERVAL 轮触发一次浅度回刷（更新最近 ~250 条帖子的元数据）
        if not first_run and round_count % REFRESH_INTERVAL == 0:
            print(f"[refresh] 第 {round_count} 轮，开始回刷最近帖子元数据…", flush=True)
            refresh_recent_posts(conn)

        # 首次运行只回抓 INITIAL_PAGES 页作种子；后续按 MAX_DISCOVER_PAGES 防突发
        pages = INITIAL_PAGES if first_run else MAX_DISCOVER_PAGES
        new = discover_new(max_seen, pages, conn=conn)

        if not new:
            print(f"[{datetime.now():%H:%M:%S}] 暂无新帖，休眠 {ROUND_SLEEP}s", flush=True)
            time.sleep(ROUND_SLEEP)
            continue

        print(f"[round] 发现 {len(new)} 条新帖，开始逐条入库+抓评论（{SLEEP_PER_ITEM}s/条）", flush=True)
        for h in new:
            is_new = db_insert(conn, h)
            if is_new:
                max_seen = max(max_seen, h["pid"])
                pid = h.get("pid")
                text_preview = (h.get("text") or "")[:40].replace("\n", " ")
                print(
                    f"\n[{fmt_time(h.get('timestamp', 0))}] pid={pid} "
                    f"收藏={h.get('likenum')} 评论={h.get('reply')} "
                    f"| {text_preview}",
                    flush=True,
                )
                # 抓取该帖评论（reply=0 时跳过，省请求）
                if h.get("reply", 0) > 0:
                    cmts = fetch_comments(pid)
                    for c in cmts:
                        db_insert_comment(conn, c)
                    cmt_new = len(cmts)
                    if cmt_new:
                        print(f"  └─ 评论 {cmt_new} 条：", flush=True)
                        for c in cmts:
                            ct = (c.get("text") or "")[:50].replace("\n", " ")
                            print(f"     [{c.get('name')}] {ct}", flush=True)
            time.sleep(SLEEP_PER_ITEM)

        first_run = False
        print(f"\n[round] 本轮完成，水位 pid={max_seen}，休眠 {ROUND_SLEEP}s", flush=True)
        time.sleep(ROUND_SLEEP)


if __name__ == "__main__":
    main()
