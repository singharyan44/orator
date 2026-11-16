#!/usr/bin/env python3
# Owner traffic stats for Orator — reads the live site's /api/stats.
# Counts only, no secrets needed, standard library only.
#
#   python orator_stats.py              one snapshot
#   python orator_stats.py --watch 15   refresh every 15 s (Ctrl+C to stop)
#
# The tracker itself must be configured once in Vercel (see README,
# "Owner traffic stats"); until then this prints the not-configured note.

import argparse
import json
import time
import urllib.request

DEFAULT_URL = "https://learnwithorator.vercel.app/api/stats"

LABELS = {
    "connect": "Connect (started a mic session)",
    "attempt_start": "Start attempt (speech)",
    "retry": "Try again (retry)",
    "sample_play": "Play sample",
    "debate_start": "Start debate (text or voice)",
    "debate_round_start": "Speak argument (debate round)",
    "diagnose_debate": "Diagnose debate",
    "interview_start": "Start interview",
    "interview_answer_start": "Speak answer (interview)",
    "diagnose_interview": "Diagnose interview",
}


def fetch(url, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": "orator-stats/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fmt_day(day):
    d = str(day)
    if len(d) == 8:
        return d[0:4] + "-" + d[4:6] + "-" + d[6:8]
    return d


def show(data, watch_note=""):
    if not data.get("enabled"):
        print("Tracker not configured yet.")
        print("Add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in")
        print("Vercel -> your project -> Settings -> Environment Variables,")
        print("then redeploy. Until then the site stays tracker-free.")
        return
    if data.get("error"):
        print("Stats endpoint could not read its counter store (%s)." % data["error"])
        return
    print("Orator live stats%s" % watch_note)
    print("  Viewers right now (active in last %ss): %d"
          % (data.get("liveWindowSec", 60), data.get("liveViewers", 0)))
    print("")
    print("Today (UTC %s):" % fmt_day(data.get("day", "")))
    today = data.get("today", {}) or {}
    print("  Page views: %d    Unique tabs: %d"
          % (today.get("views", 0), today.get("uniques", 0)))
    print("  Presses:")
    for name, count in (today.get("presses") or {}).items():
        print("    %-42s %6d" % (LABELS.get(name, name), count))
    print("")
    print("All time:")
    all_time = data.get("allTime", {}) or {}
    print("  Page views: %d    Unique tabs: %d"
          % (all_time.get("views", 0), all_time.get("uniques", 0)))
    print("  Presses:")
    for name, count in (all_time.get("presses") or {}).items():
        print("    %-42s %6d" % (LABELS.get(name, name), count))


def main():
    ap = argparse.ArgumentParser(description="Owner traffic stats for Orator.")
    ap.add_argument("--url", default=DEFAULT_URL, help="stats endpoint (default: live site)")
    ap.add_argument("--watch", type=int, default=0, metavar="SECONDS",
                    help="refresh every SECONDS until Ctrl+C")
    args = ap.parse_args()
    while True:
        try:
            show(fetch(args.url), "  (refreshing every %ss)" % args.watch if args.watch > 0 else "")
        except Exception as e:
            print("Could not read stats: %s" % e)
        if args.watch <= 0:
            return
        try:
            time.sleep(args.watch)
        except KeyboardInterrupt:
            return
        print("")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
