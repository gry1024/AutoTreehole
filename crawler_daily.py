#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
独立每日全量回刷进程。

设计目的
--------
原 crawler.py 在 main() 中同步调用 daily_refresh()，会阻塞主循环 30~90 分钟，
导致外部监控在凌晨把"主循环暂停写库"误判为"爬虫宕机"，每天凌晨准时误报。

本脚本作为独立 systemd 单元运行，由 treehole-daily.timer 每日凌晨 03:00 触发，
与主爬虫解耦，互不阻塞，监控语义干净。

用法
----
直接执行：python3 /opt/treehole/crawler_daily.py
由 systemd 触发：[Unit] Description=Daily Treehole Refresh
"""

import sys
import time

# 复用主爬虫的所有函数与配置
import crawler  # noqa: E402

# Windows 控制台中文/emoji 兼容
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def main() -> int:
    if not crawler.TOKEN or not crawler.UUID:
        print("[daily-svc] 缺少 PKU_TOKEN / PKU_UUID，请检查 /opt/treehole/.env", flush=True)
        return 1

    conn = crawler.db_connect()
    print(f"[daily-svc] DB={crawler.DB_PATH}，开始每日回刷…", flush=True)
    t0 = time.time()
    try:
        crawler.daily_refresh(conn)
    except Exception as e:
        print(f"[daily-svc] daily_refresh 异常：{e!r}", flush=True)
        return 2
    finally:
        try:
            conn.close()
        except Exception:
            pass
    elapsed = time.time() - t0
    print(f"[daily-svc] 完成，耗时 {elapsed/60:.1f} 分钟", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())