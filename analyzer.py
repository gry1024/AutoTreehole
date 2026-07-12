#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
北大树洞 分析与报告工具

只读 treehole.db，提供热帖浏览、关键词搜索、帖子详情、统计与 AI 总结报告。
报告支持「最近一周全量分析」与「关键词专题分析」两种模式，
并兼容 DeepSeek / OpenAI / Anthropic / Kimi / Qwen / MiniMax 六类大模型。
"""

import argparse
import os
import re
import sqlite3
import sys
import time
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import requests

# Windows 控制台 UTF-8 兼容
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# ==================== 配置 ====================
DB_PATH = os.environ.get("TREEHOLE_DB_PATH", "./treehole.db")
ENV_PATH = os.environ.get("TREEHOLE_ENV_PATH", ".env")
REPORT_DIR = "reports"
PREVIEW_LEN = 80                 # 列表展示正文截断长度
WEEK_DEFAULT = 7                 # 报告默认时间窗口（天）
MAX_POSTS_FOR_LLM = 200          # 单次传入 LLM 的帖子上限（token 约束）
MIN_USEFUL_LEN = 4               # 帖子正文最小有效长度（字符）
HOLE_PID_MIN = 10000             # 合法洞号下限，用于识别报告中的洞号引用（避免误匹配小数字）
HOLE_URL_TEMPLATE = "https://treehole.pku.edu.cn/web/#/hole/{pid}"  # 树洞 web 端帖子链接模板

# LLM 服务配置表
#   key   : 存放 API Key 的环境变量名
#   url   : Chat 接口地址
#   model : 默认模型名（可被同名环境变量覆盖）
#   fmt   : 协议格式，openai 兼容 / anthropic 原生
LLM_PROVIDERS: Dict[str, Dict[str, str]] = {
    "deepseek":  {"key": "DEEPSEEK_API_KEY",  "url": "https://api.deepseek.com/chat/completions",                              "model": "deepseek-chat",                  "fmt": "openai"},
    "openai":    {"key": "OPENAI_API_KEY",    "url": "https://api.openai.com/v1/chat/completions",                             "model": "gpt-4o-mini",                    "fmt": "openai"},
    "anthropic": {"key": "ANTHROPIC_API_KEY", "url": "https://api.anthropic.com/v1/messages",                                  "model": "claude-3-5-sonnet-20241022",     "fmt": "anthropic"},
    "kimi":      {"key": "MOONSHOT_API_KEY",  "url": "https://api.moonshot.cn/v1/chat/completions",                            "model": "moonshot-v1-32k",                "fmt": "openai"},
    "qwen":      {"key": "DASHSCOPE_API_KEY", "url": "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",    "model": "qwen-plus",                      "fmt": "openai"},
    "minimax":   {"key": "MINIMAX_API_KEY",   "url": "https://api.minimax.chat/v1/text/chatcompletion_v2",                     "model": "MiniMax-M3",                     "fmt": "openai"},
}
DEFAULT_PROVIDER = "minimax"


# ==================== 环境变量 ====================
def load_env(path: str = ENV_PATH) -> None:
    """极简 .env 解析：逐行 KEY=VALUE 写入 os.environ，系统变量优先不覆盖。"""
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            k, v = k.strip(), v.strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
                v = v[1:-1]
            if k and k not in os.environ:
                os.environ[k] = v


def get_llm_config(provider: str) -> Dict[str, str]:
    """组装指定 provider 的完整调用配置；url/model 允许被环境变量覆盖。"""
    p = LLM_PROVIDERS.get(provider)
    if not p:
        print(f"[错误] 未知 LLM provider: {provider}，可选: {', '.join(LLM_PROVIDERS)}")
        sys.exit(1)
    upper = provider.upper()
    return {
        "provider": provider,
        "keyname": p["key"],
        "key": os.environ.get(p["key"], ""),
        "url": os.environ.get(f"{upper}_API_URL", p["url"]),
        "model": os.environ.get(f"{upper}_MODEL", p["model"]),
        "fmt": p["fmt"],
    }


# ==================== 数据库 ====================
def db_connect() -> sqlite3.Connection:
    """连接只读数据库，行结果支持列名访问。"""
    if not os.path.exists(DB_PATH):
        print(f"[错误] 找不到数据库 {DB_PATH}，请先运行 crawler.py 采集。")
        sys.exit(1)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def fmt_time(ts: Optional[int]) -> str:
    """Unix 时间戳 → 本地时间字符串。"""
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M") if ts else "未知时间"


def is_useful(text: str) -> bool:
    """帖子有效性判定：去空白后长度达标，且含至少 2 个字母或汉字（排除纯数字/标点/emoji）。"""
    s = (text or "").strip()
    if len(s) < MIN_USEFUL_LEN:
        return False
    alpha = sum(1 for c in s if c.isalnum() and not c.isdigit())
    return alpha >= 2


def filter_useful(rows: List[sqlite3.Row]) -> List[sqlite3.Row]:
    """过滤无意义帖子，返回有效子集。"""
    return [r for r in rows if is_useful(r["text"])]


def sample_for_llm(rows: List[sqlite3.Row]) -> Tuple[List[sqlite3.Row], bool]:
    """
    按 (收藏 + 评论×2) 热度降序采样到 MAX_POSTS_FOR_LLM 条。
    返回 (采样结果, 是否发生过截断)。
    """
    if len(rows) <= MAX_POSTS_FOR_LLM:
        return rows, False
    ranked = sorted(rows, key=lambda r: (r["likenum"] or 0) + (r["reply"] or 0) * 2, reverse=True)
    return ranked[:MAX_POSTS_FOR_LLM], True


def fetch_week_posts(conn: sqlite3.Connection, days: int) -> List[sqlite3.Row]:
    """取最近 days 天全部帖子（按 pid 降序）。"""
    since = int(time.time()) - days * 86400
    return conn.execute(
        "SELECT pid,text,timestamp,likenum,reply FROM holes WHERE timestamp>=? ORDER BY pid DESC",
        (since,),
    ).fetchall()


def fetch_keyword_posts(conn: sqlite3.Connection, keywords: List[str]) -> List[sqlite3.Row]:
    """全库搜索正文命中任一关键词的帖子（OR 匹配，按热度降序）。"""
    conds = " OR ".join(["text LIKE ?"] * len(keywords))
    params = [f"%{k}%" for k in keywords]
    return conn.execute(
        f"SELECT pid,text,timestamp,likenum,reply FROM holes WHERE {conds} ORDER BY likenum DESC, pid DESC",
        params,
    ).fetchall()


def get_hot_posts(conn: sqlite3.Connection, days: int, limit: int) -> List[sqlite3.Row]:
    """最近 days 天按收藏量降序的热帖。"""
    since = int(time.time()) - days * 86400
    return conn.execute(
        "SELECT pid,text,timestamp,likenum,reply,type FROM holes WHERE timestamp>=? ORDER BY likenum DESC, pid DESC LIMIT ?",
        (since, limit),
    ).fetchall()


def search_posts(conn: sqlite3.Connection, keyword: str, limit: int, days: Optional[int]) -> List[sqlite3.Row]:
    """关键词模糊搜索帖子（按收藏量降序）。"""
    like = f"%{keyword}%"
    if days is not None:
        since = int(time.time()) - days * 86400
        return conn.execute(
            "SELECT pid,text,timestamp,likenum,reply,type FROM holes WHERE text LIKE ? AND timestamp>=? ORDER BY likenum DESC, pid DESC LIMIT ?",
            (like, since, limit),
        ).fetchall()
    return conn.execute(
        "SELECT pid,text,timestamp,likenum,reply,type FROM holes WHERE text LIKE ? ORDER BY likenum DESC, pid DESC LIMIT ?",
        (like, limit),
    ).fetchall()


def get_post_detail(conn: sqlite3.Connection, pid: int) -> Optional[Tuple[sqlite3.Row, List[sqlite3.Row]]]:
    """取单帖完整信息 + 全部评论（按楼层升序）。"""
    post = conn.execute("SELECT pid,text,type,timestamp,reply,likenum,tag FROM holes WHERE pid=?", (pid,)).fetchone()
    if post is None:
        return None
    comments = conn.execute(
        "SELECT cid,pid,text,timestamp,name,comment_id,quote FROM comments WHERE pid=? ORDER BY cid ASC",
        (pid,),
    ).fetchall()
    return post, comments


def get_stats(conn: sqlite3.Connection) -> Dict[str, Any]:
    """数据库统计指标。"""
    hc = conn.execute("SELECT COUNT(*) FROM holes").fetchone()[0]
    cc = conn.execute("SELECT COUNT(*) FROM comments").fetchone()[0]
    tr = conn.execute("SELECT MIN(timestamp),MAX(timestamp) FROM holes").fetchone()
    avg = conn.execute("SELECT AVG(likenum),AVG(reply) FROM holes").fetchone()
    since = int(time.time()) - 7 * 86400
    wc = conn.execute("SELECT COUNT(*) FROM holes WHERE timestamp>=?", (since,)).fetchone()[0]
    return {"holes": hc, "comments": cc, "min_ts": tr[0], "max_ts": tr[1],
            "avg_like": avg[0] or 0, "avg_reply": avg[1] or 0, "week": wc}


# ==================== 展示 ====================
def truncate(text: str, n: int = PREVIEW_LEN) -> str:
    """截断为单行预览文本。"""
    if not text:
        return ""
    t = text.replace("\r", " ").replace("\n", " ⏎ ")
    return t[:n] + "…" if len(t) > n else t


def print_post_list(rows: List[sqlite3.Row], full: bool = False) -> None:
    """打印帖子列表。"""
    if not rows:
        print("（无匹配结果）")
        return
    print(f"\n共 {len(rows)} 条：\n")
    for i, r in enumerate(rows, 1):
        body = (r["text"] or "") if full else truncate(r["text"] or "")
        print(f"{i:>3}. [{fmt_time(r['timestamp'])}] #{r['pid']} ❤{r['likenum']} 💬{r['reply']}")
        print(f"     {body}")
    if not full:
        print("\n提示：--full 查看完整正文；show <pid> 查看帖子+评论。")


def print_post_detail(post: sqlite3.Row, comments: List[sqlite3.Row]) -> None:
    """打印单帖完整正文与评论树。"""
    print("\n" + "=" * 60)
    print(f"#{post['pid']}  类型={post['type'] or '未知'}  时间={fmt_time(post['timestamp'])}")
    print(f"❤收藏={post['likenum']}  💬评论={post['reply']}" + (f"  标签={post['tag']}" if post["tag"] else ""))
    print("-" * 60 + "\n【正文】\n" + (post["text"] or "（空）"))
    print("-" * 60)
    if not comments:
        print("【评论】暂无")
    else:
        print(f"【评论】共 {len(comments)} 条：")
        for c in comments:
            ref = f" ↩#{c['comment_id']}" if c["comment_id"] else ""
            print(f"\n  #{c['cid']} [{c['name']}]{ref} {fmt_time(c['timestamp'])}")
            if c["quote"]:
                print(f"     引用：{truncate(c['quote'], 60)}")
            print(f"     {c['text'] or ''}")
    print("=" * 60)


# ==================== LLM 调用 ====================
def call_llm(system: str, user: str, cfg: Dict[str, str]) -> Optional[str]:
    """
    统一大模型调用入口。
    - openai 格式：Authorization: Bearer，messages 含 system 角色
    - anthropic 格式：x-api-key + anthropic-version，system 独立字段
    """
    if not cfg["key"]:
        print(f"[错误] 未配置 {cfg['keyname']}（provider={cfg['provider']}）")
        return None
    headers = {"Content-Type": "application/json"}
    if cfg["fmt"] == "anthropic":
        headers.update({"x-api-key": cfg["key"], "anthropic-version": "2023-06-01"})
        payload = {"model": cfg["model"], "max_tokens": 4096, "system": system,
                   "messages": [{"role": "user", "content": user}]}
    else:
        headers["Authorization"] = f"Bearer {cfg['key']}"
        payload = {"model": cfg["model"], "temperature": 0.7, "stream": False,
                   "messages": [{"role": "system", "content": system},
                                {"role": "user", "content": user}]}
    print(f"[llm] 调用 {cfg['provider']}({cfg['model']})…", flush=True)
    try:
        resp = requests.post(cfg["url"], headers=headers, json=payload, timeout=180)
    except Exception as e:
        print(f"[llm] 网络异常：{e}")
        return None
    if resp.status_code != 200:
        print(f"[llm] HTTP {resp.status_code}：{resp.text[:300]}")
        return None
    data = resp.json()
    try:
        if cfg["fmt"] == "anthropic":
            return data["content"][0]["text"]
        usage = data.get("usage", {})
        if usage:
            print(f"[llm] token：prompt={usage.get('prompt_tokens')} completion={usage.get('completion_tokens')} total={usage.get('total_tokens')}")
        return data["choices"][0]["message"]["content"]
    except Exception as e:
        print(f"[llm] 解析失败：{e}\n{resp.text[:300]}")
        return None


# ==================== 报告 Prompt ====================
def format_posts_block(rows: List[sqlite3.Row]) -> str:
    """把帖子列表格式化为带洞号的文本块，供 LLM 阅读。"""
    lines = []
    for r in rows:
        lines.append(
            f"[#{r['pid']}] {fmt_time(r['timestamp'])} 收藏={r['likenum']} 评论={r['reply']}\n"
            f"正文：{(r['text'] or '').strip()}"
        )
    return "\n\n".join(lines)


def build_week_prompt(rows: List[sqlite3.Row], days: int, total_useful: int) -> Tuple[str, str]:
    """全周分析报告 prompt。total_useful 为过滤后有效帖总数（可能大于 len(rows)）。"""
    sample_note = f"\n注：原始有效帖 {total_useful} 条过多，已按热度取前 {len(rows)} 条传入分析。" if total_useful > len(rows) else ""
    system = (
        "你是资深高校校园动态分析师。基于北京大学树洞（匿名论坛）最近一段时间的帖子，"
        "撰写结构清晰、观点中肯、语言自然的中文分析报告。"
        "帖子为匿名内容，含口语与情绪表达，需客观提炼而非照搬。"
        "对明显不实或极端信息，理性提示不扩散。"
    )
    user = f"""以下是北京大学树洞最近 {days} 天内的 {len(rows)} 条帖子（已过滤无意义内容）。{sample_note}

{format_posts_block(rows)}

请撰写一份详细的 Markdown 分析报告，严格包含以下结构：

## 一、近期关注热点
按主题分类归纳（如生活服务、学业课程、情感社交、校园民生、求职升学等），每个主题用 1-2 段详述，概括帖子实际内容，并在每条信息后标注来源洞号，格式「(#pid)」。

## 二、正在讨论的时事
与近期事件、政策、校园新闻、社会热点相关的内容；如无明显时事，说明话题以日常为主并简述倾向。

## 三、值得关注的信息
对北大学生有实际参考价值的信息（攻略、避坑、资源、提醒等），逐条列出并标注来源洞号「(#pid)」。

## 四、社区情绪与氛围
分析整体情绪基调（焦虑/轻松/吐槽/倾诉/愤怒/期待等），引用代表性帖子洞号佐证。

## 五、总体观察
2-3 句话概括近期树洞趋势。

要求：
- 全程中文，客观不编造帖子中不存在的内容
- 所有实质性内容必须标注来源洞号「(#pid)」，不得虚构洞号
- 概括实际内容，不要只列编号
- 篇幅充实，重点突出，避免空话套话"""
    return system, user


def build_keyword_prompt(rows: List[sqlite3.Row], keywords: List[str], total_useful: int) -> Tuple[str, str]:
    """关键词专题报告 prompt。total_useful 为命中有效帖总数。"""
    kw_str = " / ".join(keywords)
    sample_note = f"\n注：命中有效帖 {total_useful} 条过多，已按热度取前 {len(rows)} 条传入分析。" if total_useful > len(rows) else ""
    system = (
        "你是资深信息分析师。用户给出关键词（可能含拼音缩写，如 xk=信科），"
        "需理解其可能含义，从帖子中识别所有相关内容并深入分析。"
    )
    user = f"""关键词：{kw_str}
说明：关键词可能包含拼音缩写（首字母缩写），请结合上下文理解其指代（如 xk→信科/信息科学，bm→保研/报名等），识别所有语义相关的内容。

以下是命中关键词的 {len(rows)} 条帖子。{sample_note}

{format_posts_block(rows)}

请围绕关键词撰写详细的 Markdown 专题分析报告：

## 一、相关内容汇总
梳理所有与关键词主题相关的帖子，按子话题分组，概括实际内容并标注来源洞号「(#pid)」。

## 二、关键信息提炼
提取有价值的事实性信息（时间、地点、规则、经验、数据等），逐条列出并标注洞号「(#pid)」。

## 三、态度与讨论
分析发帖者及评论者的立场、情绪、共识与分歧，引用洞号佐证。

## 四、实用信息与建议
对关注该主题的同学给出可操作的建议，标注信息来源洞号「(#pid)」。

要求：
- 全程中文，客观不编造
- 所有实质性内容必须标注来源洞号「(#pid)」
- 概括实际内容，不要只列编号
- 篇幅充实，信息密度高"""
    return system, user


def enrich_report(content: str, conn: sqlite3.Connection) -> str:
    """
    报告后处理：
    1. 将正文中所有形如 #pid 的洞号替换为指向树洞 web 端的 Markdown 超链接；
    2. 在报告末尾追加「被引用帖子原文」附录，按首次出现顺序列出所有被引用帖子的完整原文。
    未在数据库中找到的洞号在附录中标注缺失。
    """
    # 提取所有被引用的洞号（去重保序），仅保留 >= HOLE_PID_MIN 的合法编号
    pids: List[int] = []
    seen = set()
    for m in re.finditer(r"#(\d+)", content):
        pid = int(m.group(1))
        if pid >= HOLE_PID_MIN and pid not in seen:
            seen.add(pid)
            pids.append(pid)
    if not pids:
        return content

    # 将 #pid 替换为超链接 [pid](url)
    def _link(pid: int) -> str:
        return f"[#{pid}]({HOLE_URL_TEMPLATE.format(pid=pid)})"

    def _repl(m: re.Match) -> str:
        pid = int(m.group(1))
        return _link(pid) if pid >= HOLE_PID_MIN else m.group(0)

    enriched = re.sub(r"#(\d+)", _repl, content)

    # 查库取原文
    placeholders = ",".join("?" * len(pids))
    rows = conn.execute(
        f"SELECT pid,text,timestamp,likenum,reply FROM holes WHERE pid IN ({placeholders})",
        pids,
    ).fetchall()
    row_map = {r["pid"]: r for r in rows}

    appendix = "\n\n---\n\n## 被引用帖子原文\n\n"
    for pid in pids:
        r = row_map.get(pid)
        if r:
            text = (r["text"] or "").strip()
            appendix += (
                f"### {_link(pid)}\n"
                f"- 时间：{fmt_time(r['timestamp'])}　收藏：{r['likenum']}　评论：{r['reply']}\n"
                f"- 原文：\n\n> {text}\n\n"
            )
        else:
            appendix += f"### {_link(pid)}\n\n> （数据库中未找到该帖子）\n\n"
    return enriched + appendix


def save_report(content: str, out: Optional[str], meta: str) -> str:
    """保存报告到文件，返回路径。"""
    if out:
        path = out
    else:
        os.makedirs(REPORT_DIR, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d_%H%M")
        path = os.path.join(REPORT_DIR, f"report_{stamp}_{meta}.md")
    header = (
        f"# 北大树洞分析报告\n\n"
        f"> 生成时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n"
        f"> {meta}\n\n---\n\n"
    )
    with open(path, "w", encoding="utf-8") as f:
        f.write(header + content + "\n")
    return path


# ==================== 命令实现 ====================
def cmd_hot(args: argparse.Namespace) -> None:
    conn = db_connect()
    rows = get_hot_posts(conn, args.days, args.limit)
    print(f"\n最近 {args.days} 天、收藏量前 {args.limit} 的热帖（共 {len(rows)} 条）：")
    print_post_list(rows, args.full)
    conn.close()


def cmd_search(args: argparse.Namespace) -> None:
    conn = db_connect()
    rows = search_posts(conn, args.keyword, args.limit, args.days)
    scope = f"最近 {args.days} 天内、" if args.days else "全库、"
    print(f"\n关键词「{args.keyword}」{scope}按收藏量排序（共 {len(rows)} 条）：")
    print_post_list(rows, args.full)
    conn.close()


def cmd_show(args: argparse.Namespace) -> None:
    conn = db_connect()
    res = get_post_detail(conn, args.pid)
    if res is None:
        print(f"[错误] 不存在 pid={args.pid}")
        conn.close()
        sys.exit(1)
    print_post_detail(*res)
    conn.close()


def cmd_stats(args: argparse.Namespace) -> None:
    conn = db_connect()
    s = get_stats(conn)
    conn.close()
    print("\n" + "=" * 40 + "\n 北大树洞数据库统计\n" + "=" * 40)
    print(f"帖子总数        : {s['holes']}")
    print(f"评论总数        : {s['comments']}")
    print(f"最近7天帖子数   : {s['week']}")
    print(f"平均收藏量      : {s['avg_like']:.2f}")
    print(f"平均评论数      : {s['avg_reply']:.2f}")
    print(f"最早帖子时间    : {fmt_time(s['min_ts'])}")
    print(f"最新帖子时间    : {fmt_time(s['max_ts'])}")
    print("=" * 40)


def cmd_report(args: argparse.Namespace) -> None:
    """报告命令：无关键词→全周分析；有关键词→全库专题分析。"""
    load_env(ENV_PATH)
    cfg = get_llm_config(args.provider)
    if not cfg["key"]:
        print(f"[错误] 未配置 {cfg['keyname']}，请在 .env 设置。")
        sys.exit(1)

    conn = db_connect()
    if args.keyword:
        # 关键词模式：空格分词，全库 OR 检索
        keywords = args.keyword.split()
        raw = fetch_keyword_posts(conn, keywords)
        useful = filter_useful(raw)
        posts, sampled = sample_for_llm(useful)
        mode = f"关键词专题「{args.keyword}」"
        if not posts:
            print(f"[错误] 未找到与「{args.keyword}」相关的帖子。")
            conn.close()
            sys.exit(1)
        system, user = build_keyword_prompt(posts, keywords, len(useful))
        meta = f"keyword_{args.keyword.replace(' ', '_')}_top{len(posts)}"
    else:
        # 全周模式
        raw = fetch_week_posts(conn, args.days)
        useful = filter_useful(raw)
        posts, sampled = sample_for_llm(useful)
        mode = f"最近{args.days}天全量"
        if not posts:
            print(f"[错误] 最近 {args.days} 天无有效帖子。")
            conn.close()
            sys.exit(1)
        system, user = build_week_prompt(posts, args.days, len(useful))
        meta = f"{args.days}d_top{len(posts)}"

    print(f"\n模式：{mode} | 有效帖 {len(useful)} 条" +
          (f"（采样 {len(posts)} 条）" if sampled else f"（全部传入）") +
          f" | 模型：{cfg['provider']}/{cfg['model']}")

    content = call_llm(system, user, cfg)
    if content is None:
        conn.close()
        print("[错误] 报告生成失败。")
        sys.exit(1)

    # 报告后处理：洞号超链接 + 被引用帖子原文附录（需读库，故 close 前执行）
    content = enrich_report(content, conn)
    conn.close()
    path = save_report(content, args.out, meta)
    print("\n" + "=" * 60 + "\n报告内容：\n" + "=" * 60)
    print(content)
    print("=" * 60 + f"\n报告已保存：{path}")


# ==================== CLI ====================
def build_parser() -> argparse.ArgumentParser:
    """构造命令行解析器。"""
    parser = argparse.ArgumentParser(
        description="北大树洞 分析与报告工具（只读 treehole.db）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""示例：
  python analyzer.py hot
  python analyzer.py hot --days 3 --limit 10 --full
  python analyzer.py search 期末
  python analyzer.py search 选课 --days 30
  python analyzer.py report                          # 最近一周全量分析
  python analyzer.py report --days 14                # 最近两周
  python analyzer.py report --keyword "信科 保研"     # 关键词专题
  python analyzer.py report --keyword "xk 保研" --provider openai
  python analyzer.py show 8390193
  python analyzer.py stats""",
    )
    sub = parser.add_subparsers(dest="command", help="可用命令")

    p = sub.add_parser("hot", help="最近 N 天按收藏量排序的热门帖子")
    p.add_argument("--days", type=int, default=7, help="时间窗口天数（默认7）")
    p.add_argument("--limit", type=int, default=20, help="返回条数（默认20）")
    p.add_argument("--full", action="store_true", help="打印完整正文")
    p.set_defaults(func=cmd_hot)

    p = sub.add_parser("search", help="按关键词搜索最热帖子")
    p.add_argument("keyword", help="搜索关键词")
    p.add_argument("--limit", type=int, default=20, help="返回条数（默认20）")
    p.add_argument("--days", type=int, default=None, help="限定最近N天（默认不限）")
    p.add_argument("--full", action="store_true", help="打印完整正文")
    p.set_defaults(func=cmd_search)

    p = sub.add_parser("report", help="AI 总结报告")
    p.add_argument("--keyword", type=str, default=None,
                   help="关键词专题（空格分词支持多个；不填则全周分析）")
    p.add_argument("--days", type=int, default=WEEK_DEFAULT, help="全周模式时间窗口（默认7）")
    p.add_argument("--provider", type=str, default=DEFAULT_PROVIDER,
                   choices=list(LLM_PROVIDERS), help="LLM 服务（默认deepseek）")
    p.add_argument("--out", type=str, default=None, help="报告输出路径（默认reports/）")
    p.set_defaults(func=cmd_report)

    p = sub.add_parser("show", help="查看帖子完整正文+评论")
    p.add_argument("pid", type=int, help="帖子编号")
    p.set_defaults(func=cmd_show)

    p = sub.add_parser("stats", help="数据库统计")
    p.set_defaults(func=cmd_stats)

    return parser


def main() -> None:
    args = build_parser().parse_args()
    if not getattr(args, "command", None):
        build_parser().print_help()
        sys.exit(0)
    args.func(args)


if __name__ == "__main__":
    main()
