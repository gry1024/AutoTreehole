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

# --- LLM 分类（MiniMax + Qwen fallback，可选）---
MINIMAX_API_KEY = _os.environ.get("MINIMAX_API_KEY", "")
MINIMAX_API_URL = "https://api.minimax.chat/v1/text/chatcompletion_v2"
MINIMAX_MODEL = _os.environ.get("MINIMAX_MODEL", "MiniMax-M3")
# 通义千问：MiniMax 限额时的备用分类模型
QWEN_API_KEY = _os.environ.get("DASHSCOPE_API_KEY", "")
QWEN_API_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
QWEN_MODEL = _os.environ.get("QWEN_MODEL", "qwen-flash")
LLM_CLASSIFY_TIMEOUT = 8        # LLM 分类请求超时秒数
LLM_CLASSIFY_MAX_TEXT = 500     # 传给 LLM 的正文最大字符数（省 token）
LLM_RETRY_INTERVAL = 10         # 每隔多少轮检查一次 LLM 是否恢复（重试失败队列）
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
            deleted     INTEGER DEFAULT 0,
            category    TEXT
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
    # 迁移：为旧表添加 category 列（帖子内容分类）
    try:
        conn.execute("ALTER TABLE holes ADD COLUMN category TEXT")
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
    # LLM 分类失败的重试队列
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS llm_retry_queue (
            pid         INTEGER PRIMARY KEY,
            text        TEXT,
            enqueued_at INTEGER,
            attempts    INTEGER DEFAULT 0
        )
        """
    )
    conn.commit()
    return conn


def db_max_pid(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT MAX(pid) FROM holes").fetchone()
    return row[0] or 0


# ==================== 帖子分类（关键词词典法） ====================
CATEGORY_KEYWORDS = {
    "学习": ["考试", "期末", "期中", "课程", "选课", "学分", "绩点", "成绩", "论文", "作业",
             "复习", "预习", "专业", "信科", "数学", "物理", "化学", "答辩", "毕业", "实习",
             "考研", "保研", "出国", "gpa", "教授", "老师", "课", "实验", "报告", "quiz",
             "midterm", "final", "论文", "开题", "导师", "实验室", "算法", "编程", "代码"],
    "情感": ["喜欢", "表白", "恋爱", "分手", "暗恋", "crush", "男友", "女友", "单身",
             "爱情", "心动", "告白", "ex", "对象", "脱单", "暧昧", "异地", "追",
             "心动", "失恋", "情感", "树洞"],
    "生活": ["食堂", "宿舍", "外卖", "快递", "天气", "睡眠", "作息", "健身", "运动",
             "跑步", "日常", "洗澡", "空调", "暖气", "网", "校园卡", "充值", "洗衣",
             "室友", "邻居", "校门", "自行车", "电动车"],
    "时事": ["新闻", "政策", "社会", "疫情", "国际", "美国", "中国", "北京", "热点",
             "事件", "争议", "讨论", "热搜", "时政", "经济", "就业", "失业"],
    "娱乐": ["游戏", "电影", "音乐", "追剧", "动漫", "小说", "综艺", "演唱会",
             "剧", "番", "抽卡", "开黑", "王者", "原神", "lol", "steam", "追星",
             "偶像", "饭圈", "b站", "抖音"],
    "求助": ["求助", "请问", "怎么办", "帮忙", "求推荐", "有没有", "怎么", "哪里",
             "如何", "能不能", "可以吗", "求问", "急", "在线等"],
}


def classify_post(text: str) -> str:
    """根据关键词词典对帖子正文进行分类，返回类别名称。"""
    if not text:
        return "其他"
    s = text.lower()
    scores = {}
    for cat, keywords in CATEGORY_KEYWORDS.items():
        score = 0
        for kw in keywords:
            if kw in s:
                score += 1
        if score > 0:
            scores[cat] = score
    if not scores:
        return "其他"
    return max(scores, key=scores.get)


# ==================== LLM 分类（MiniMax） ====================
VALID_CATEGORIES = {"学习", "情感", "生活", "时事", "娱乐", "求助", "其他"}

_llm_healthy = True  # LLM 服务健康标记，失败后临时降级


def _classify_with_api(api_url: str, api_key: str, model: str, snippet: str) -> Optional[str]:
    """通用 LLM 分类请求：调用指定 API，返回有效类别名；失败返回 None。"""
    payload = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": "你是帖子内容分类器。只返回一个类别名，从以下选项中选择：学习、情感、生活、时事、娱乐、求助、其他。不要输出任何解释、标点或其他内容。"
            },
            {
                "role": "user",
                "content": snippet
            }
        ],
        "temperature": 0,
        "max_tokens": 200,
    }
    try:
        resp = requests.post(
            api_url,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=LLM_CLASSIFY_TIMEOUT,
        )
        if resp.status_code != 200:
            return None
        data = resp.json()
        content = data.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
        # 提取有效分类名（LLM 可能附带标点或多余文字）
        for cat in VALID_CATEGORIES:
            if cat in content:
                return cat
        print(f"[llm] 无法识别返回内容: {content!r}", flush=True)
        return None
    except (requests.Timeout, requests.ConnectionError, requests.RequestException) as e:
        print(f"[llm] 请求异常: {type(e).__name__}", flush=True)
        return None


def classify_post_llm(text: str) -> Optional[str]:
    """调用 LLM 对帖子正文进行分类，返回类别名称；失败返回 None。
    优先 MiniMax，限额/失败时自动 fallback 到 Qwen。
    """
    global _llm_healthy
    if not MINIMAX_API_KEY and not QWEN_API_KEY:
        return None
    if not text or not text.strip():
        return "其他"
    # 截断超长文本，省 token
    snippet = text.strip()[:LLM_CLASSIFY_MAX_TEXT]
    # 1) 先试 MiniMax
    if MINIMAX_API_KEY:
        cat = _classify_with_api(MINIMAX_API_URL, MINIMAX_API_KEY, MINIMAX_MODEL, snippet)
        if cat is not None:
            _llm_healthy = True
            return cat
        print("[llm] MiniMax 分类失败，尝试 fallback 到 Qwen", flush=True)
    # 2) MiniMax 失败，fallback 到 Qwen
    if QWEN_API_KEY:
        cat = _classify_with_api(QWEN_API_URL, QWEN_API_KEY, QWEN_MODEL, snippet)
        if cat is not None:
            _llm_healthy = True
            print("[llm] Qwen fallback 分类成功", flush=True)
            return cat
    # 两个都失败，降级到关键词分类
    print("[llm] MiniMax 与 Qwen 均失败，降级到关键词分类", flush=True)
    _llm_healthy = False
    return None


def classify_post_hybrid(text: str) -> tuple:
    """混合分类策略：优先 LLM，失败回退关键词法。
    返回 (category, used_llm) 二元组。
    used_llm=True 表示用了 LLM；False 表示用了关键词兜底。
    """
    cat = classify_post_llm(text)
    if cat is not None:
        return cat, True
    return classify_post(text), False


def db_insert(conn: sqlite3.Connection, h: dict) -> bool:
    """插入一条树洞；pid 重复则忽略。返回是否为新插入。"""
    text = h.get("text") or ""
    category, used_llm = classify_post_hybrid(text)
    cur = conn.execute(
        """
        INSERT OR IGNORE INTO holes
        (pid, text, type, timestamp, reply, likenum, extra, anonymous, tag, image_size, raw, crawled_at, category)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        (
            h.get("pid"), h.get("text"), h.get("type"), h.get("timestamp"),
            h.get("reply"), h.get("likenum"), h.get("extra"), h.get("anonymous"),
            json.dumps(h.get("tag"), ensure_ascii=False) if h.get("tag") is not None else None,
            json.dumps(h.get("image_size"), ensure_ascii=False) if h.get("image_size") else None,
            json.dumps(h, ensure_ascii=False),
            int(time.time()),
            category,
        ),
    )
    conn.commit()
    is_new = cur.rowcount > 0
    # LLM 分类失败时，将帖子加入重试队列
    if is_new and not used_llm:
        pid = h.get("pid")
        conn.execute(
            "INSERT OR IGNORE INTO llm_retry_queue (pid, text, enqueued_at, attempts) VALUES (?,?,?,0)",
            (pid, text, int(time.time()))
        )
        conn.commit()
        print(f"  └─ [llm] pid={pid} 关键词兜底分类={category}，已入重试队列", flush=True)
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
def api_get(path: str, params: Optional[dict] = None) -> Optional[dict]:
    """GET 一个 API，返回解析后的 JSON；鉴权失效返回 None。"""
    try:
        r = requests.get(BASE + path, params=params, headers=HEADERS, timeout=15)
    except Exception as e:
        print(f"[net] 请求异常 {path}: {e}", flush=True)
        return None
    if r.status_code == 401:
        return None
    try:
        d = r.json()
    except Exception:
        print(f"[net] 非 JSON 响应 {path}: {r.status_code} {r.text[:120]}", flush=True)
        return None
    if not d.get("success"):
        # 40001/40002 表示 token/uuid 失效或需短信验证
        print(f"[auth] 接口拒绝: code={d.get('code')} msg={d.get('message')}", flush=True)
        return None
    return d


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


def is_post_deleted(pid: int) -> bool:
    """通过评论 API 检测帖子是否已被平台删除。

    逻辑：请求评论列表，若 success=false 且非 token 失效（40001/40002），
    则判定为帖子已被删除。正常返回或网络异常时返回 False（不误判）。
    """
    try:
        r = requests.get(BASE + f"pku_comment_v3/{pid}",
                         params={"page": 1, "limit": 1, "sort": "asc"},
                         headers=HEADERS, timeout=15)
    except Exception:
        return False  # 网络异常，不确定，不标记
    if r.status_code == 401:
        return False  # 鉴权失效
    try:
        d = r.json()
    except Exception:
        return False
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


def retry_failed_llm(conn: sqlite3.Connection, max_items: int = 50) -> None:
    """重试 LLM 分类失败的帖子。

    当 LLM 服务恢复后，从 llm_retry_queue 中取出帖子重新分类。
    成功的从队列移除并更新 holes.category；失败的保留在队列中（增加 attempts）。
    如果 LLM 仍不健康，直接返回不处理。
    """
    if not _llm_healthy:
        # 先用一个轻量探测判断 LLM 是否恢复
        probe = classify_post_llm("测试")
        if probe is None:
            return
        print("[llm] 服务已恢复，开始重试失败队列", flush=True)

    rows = conn.execute(
        "SELECT pid, text FROM llm_retry_queue ORDER BY enqueued_at ASC LIMIT ?",
        (max_items,)
    ).fetchall()
    if not rows:
        return

    print(f"[llm-retry] 队列中有 {len(rows)} 条待重试", flush=True)
    success = 0
    for pid, text in rows:
        cat = classify_post_llm(text or "")
        if cat is not None:
            conn.execute("UPDATE holes SET category=? WHERE pid=?", (cat, pid))
            conn.execute("DELETE FROM llm_retry_queue WHERE pid=?", (pid,))
            conn.commit()
            success += 1
            print(f"  ✓ pid={pid} 重新分类为 {cat}", flush=True)
        else:
            conn.execute("UPDATE llm_retry_queue SET attempts=attempts+1 WHERE pid=?", (pid,))
            conn.commit()
            # LLM 又挂了，停止重试
            print(f"  ✗ pid={pid} 重试失败，LLM 可能又挂了，停止本轮重试", flush=True)
            break
    print(f"[llm-retry] 本轮完成：成功 {success}/{len(rows)} 条", flush=True)


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

        # 每 LLM_RETRY_INTERVAL 轮重试 LLM 分类失败的帖子
        if not first_run and round_count % LLM_RETRY_INTERVAL == 0:
            retry_failed_llm(conn)

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
