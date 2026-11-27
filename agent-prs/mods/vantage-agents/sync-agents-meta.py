#!/usr/bin/env python3
"""
Vantage metadata sync engine for Herdr App.
Resolves real task titles and GitHub PR status for live coding-agent terminals:
- Claude Code: reads `pr-link`, `custom-title`, and `ai-title` from ~/.claude/projects/*/*.jsonl.
- Antigravity (`agy`): maps foreground PID via presence/*.lock -> conversation_id -> title
  from conversation_summaries.db (read-only) and created/merged PR URLs from transcript.jsonl.
- Generic/branch fallback: checks non-default git branch PRs via `gh pr list`.
- Fetches live PR state, draft flag, title, and CI rollup in a single batched `gh api graphql` call.
"""
from __future__ import annotations

import concurrent.futures
import glob
import json
import os
import re
import sqlite3
import subprocess
import time
from typing import Any

PR_URL_RE = re.compile(r"https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/pull/(\d+)")
PR_ACTION_RE = re.compile(
    r"(?:Creating pull request|Squashed and merged pull request|Merged pull request|gh pr create|gh pr merge)",
    re.IGNORECASE,
)
PR_SHORTHAND_RE = re.compile(r"(?:pull request |merged )([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)#(\d+)", re.IGNORECASE)
GH_REMOTE_RE = re.compile(r"github\.com[:/]([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?$")
DEFAULT_BRANCHES = {"", "HEAD", "main", "master", "staging", "develop", "dev"}
HOME = os.path.expanduser("~")
ENV = {
    **os.environ,
    "PATH": f"{HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + os.environ.get("PATH", ""),
}


def run_cmd(args: list[str], cwd: str | None = None, timeout: float = 8.0) -> tuple[int, str]:
    try:
        res = subprocess.run(args, cwd=cwd, env=ENV, capture_output=True, text=True, timeout=timeout)
        return res.returncode, res.stdout
    except Exception:
        return 1, ""


def strip_leading_glyphs(text: str | None) -> str:
    if not text:
        return ""
    return re.sub(r"^[^\w]+", "", text, flags=re.UNICODE).strip()


def encode_claude_cwd(path: str) -> str:
    return re.sub(r"[^A-Za-z0-9]", "-", path)


def get_live_agents() -> list[dict[str, Any]]:
    code, out = run_cmd(["hc", "ls", "--json"], timeout=5.0)
    if code != 0 or not out.strip():
        return []
    try:
        terms = json.loads(out).get("terminals", [])
    except Exception:
        return []

    candidates = [t for t in terms if t.get("state") == "live" and t.get("address") and not t.get("parent")]

    def fetch_detail(addr: str) -> dict[str, Any] | None:
        rc, raw = run_cmd(["hc", "get", addr, "--json"], timeout=4.0)
        if rc != 0 or not raw.strip():
            return None
        try:
            return json.loads(raw)
        except Exception:
            return None

    details: list[dict[str, Any]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        for f in concurrent.futures.as_completed([pool.submit(fetch_detail, t["address"]) for t in candidates]):
            d = f.result()
            if d:
                details.append(d)
    return details


def get_agy_pid_to_conv() -> dict[int, str]:
    locks = glob.glob(os.path.join(HOME, ".gemini", "antigravity-cli", "presence", "*.lock"))
    if not locks:
        return {}
    # lsof exits 1 when some listed files are not open by any process; stdout still lists open ones.
    _, out = run_cmd(["lsof", "-F", "pn", *locks], timeout=4.0)
    if not out:
        return {}
    mapping: dict[int, str] = {}
    current_pid: int | None = None
    for line in out.splitlines():
        if line.startswith("p"):
            try:
                current_pid = int(line[1:])
            except ValueError:
                current_pid = None
        elif line.startswith("n") and current_pid is not None:
            base = os.path.basename(line[1:])
            if base.endswith(".lock"):
                mapping[current_pid] = base[:-5]
    return mapping


def get_agy_titles(conv_ids: list[str]) -> dict[str, str]:
    if not conv_ids:
        return {}
    db_path = os.path.join(HOME, ".gemini", "antigravity-cli", "conversation_summaries.db")
    if not os.path.exists(db_path):
        return {}
    titles: dict[str, str] = {}
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=1.0)
        cur = conn.cursor()
        placeholders = ",".join("?" for _ in conv_ids)
        cur.execute(
            f"SELECT conversation_id, title FROM conversation_summaries WHERE conversation_id IN ({placeholders})",
            conv_ids,
        )
        for cid, title in cur.fetchall():
            if title and title.strip():
                titles[cid] = title.strip()
        conn.close()
    except Exception:
        pass
    return titles


def extract_agy_transcript_prs(conv_id: str) -> set[tuple[str, str, int]]:
    prs: set[tuple[str, str, int]] = set()
    path = os.path.join(
        HOME, ".gemini", "antigravity-cli", "brain", conv_id, ".system_generated", "logs", "transcript.jsonl"
    )
    if not os.path.exists(path):
        return prs
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as fh:
            for line in fh:
                if not PR_ACTION_RE.search(line):
                    continue
                for owner, repo, num in PR_URL_RE.findall(line):
                    prs.add((owner, repo, int(num)))
                for owner, repo, num in PR_SHORTHAND_RE.findall(line):
                    prs.add((owner, repo, int(num)))
    except Exception:
        pass
    return prs


def extract_terminal_scrollback_prs(addr: str) -> set[tuple[str, str, int]]:
    prs: set[tuple[str, str, int]] = set()
    code, out = run_cmd(["hc", "read", "--lines", "600", addr], timeout=4.0)
    if code != 0 or not out:
        return prs
    for owner, repo, num in PR_URL_RE.findall(out):
        prs.add((owner, repo, int(num)))
    return prs


def load_claude_sessions() -> list[dict[str, Any]]:
    cutoff = time.time() - 30 * 86400
    pattern = os.path.join(HOME, ".claude", "projects", "*", "*.jsonl")
    files = []
    for f in glob.glob(pattern):
        try:
            mtime = os.path.getmtime(f)
            if mtime >= cutoff:
                files.append((mtime, f))
        except OSError:
            pass
    files.sort(reverse=True)
    sessions: list[dict[str, Any]] = []
    for mtime, path in files[:120]:
        proj_dir = os.path.basename(os.path.dirname(path))
        titles: list[str] = []
        prs: set[tuple[str, str, int]] = set()
        try:
            with open(path, "r", encoding="utf-8", errors="ignore") as fh:
                for line in fh:
                    if '"pr-link"' not in line and '"custom-title"' not in line and '"ai-title"' not in line:
                        continue
                    try:
                        d = json.loads(line)
                    except Exception:
                        continue
                    t = d.get("type")
                    if t in ("custom-title", "ai-title"):
                        val = d.get("customTitle") or d.get("aiTitle") or d.get("title")
                        if isinstance(val, str) and val.strip():
                            titles.append(val.strip())
                    elif t == "pr-link":
                        repo_full = d.get("prRepository") or ""
                        num = d.get("prNumber")
                        if "/" in repo_full and isinstance(num, int):
                            owner, repo = repo_full.split("/", 1)
                            prs.add((owner, repo, num))
                        elif isinstance(d.get("prUrl"), str):
                            for owner, repo, n in PR_URL_RE.findall(d["prUrl"]):
                                prs.add((owner, repo, int(n)))
        except OSError:
            continue
        if titles or prs:
            sessions.append({
                "mtime": mtime,
                "proj": proj_dir,
                "title": titles[-1] if titles else "",
                "all_titles": set(titles),
                "prs": prs,
            })
    return sessions


def get_branch_prs(cwd: str, cache: dict[str, set[tuple[str, str, int]]]) -> set[tuple[str, str, int]]:
    if not cwd or not os.path.isdir(cwd):
        return set()
    if cwd in cache:
        return cache[cwd]
    res: set[tuple[str, str, int]] = set()
    rc, branch_out = run_cmd(
        ["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "rev-parse", "--abbrev-ref", "HEAD"],
        cwd=cwd,
        timeout=3.0,
    )
    branch = branch_out.strip()
    if rc != 0 or branch in DEFAULT_BRANCHES:
        cache[cwd] = res
        return res
    rc2, remote_out = run_cmd(["git", "remote", "get-url", "origin"], cwd=cwd, timeout=3.0)
    m = GH_REMOTE_RE.search(remote_out.strip()) if rc2 == 0 else None
    if not m:
        cache[cwd] = res
        return res
    owner, repo = m.group(1), m.group(2)
    rc3, pr_out = run_cmd(
        ["gh", "pr", "list", "--repo", f"{owner}/{repo}", "--head", branch, "--state", "all", "--json", "number", "--limit", "5"],
        timeout=6.0,
    )
    if rc3 == 0 and pr_out.strip():
        try:
            for item in json.loads(pr_out):
                if isinstance(item.get("number"), int):
                    res.add((owner, repo, item["number"]))
        except Exception:
            pass
    cache[cwd] = res
    return res


def fetch_pr_details_graphql(pr_keys: list[tuple[str, str, int]]) -> dict[tuple[str, str, int], dict[str, Any]]:
    if not pr_keys:
        return {}
    results: dict[tuple[str, str, int], dict[str, Any]] = {}
    chunk_size = 35
    for start in range(0, len(pr_keys), chunk_size):
        chunk = pr_keys[start : start + chunk_size]
        parts = []
        for idx, (owner, repo, num) in enumerate(chunk):
            safe_owner = json.dumps(owner)
            safe_repo = json.dumps(repo)
            parts.append(
                f'p{idx}: repository(owner: {safe_owner}, name: {safe_repo}) {{ '
                f'pullRequest(number: {num}) {{ '
                f'number title state isDraft url '
                f'commits(last: 1) {{ nodes {{ commit {{ statusCheckRollup {{ state }} }} }} }} '
                f'}} }}'
            )
        query = "query { " + " ".join(parts) + " }"
        rc, out = run_cmd(["gh", "api", "graphql", "-f", f"query={query}"], timeout=12.0)
        if rc != 0 or not out.strip():
            continue
        try:
            data = json.loads(out).get("data") or {}
        except Exception:
            continue
        for idx, key in enumerate(chunk):
            repo_obj = data.get(f"p{idx}")
            pr = repo_obj.get("pullRequest") if isinstance(repo_obj, dict) else None
            if not isinstance(pr, dict):
                continue
            ci = None
            nodes = ((pr.get("commits") or {}).get("nodes")) or []
            if nodes:
                rollup = (nodes[0].get("commit") or {}).get("statusCheckRollup")
                if isinstance(rollup, dict):
                    ci = rollup.get("state")
            results[key] = {
                "repo": f"{key[0]}/{key[1]}",
                "shortRepo": key[1],
                "number": pr.get("number", key[2]),
                "title": pr.get("title") or f"PR #{key[2]}",
                "state": pr.get("state") or "OPEN",
                "isDraft": bool(pr.get("isDraft")),
                "ci": ci,
                "url": pr.get("url") or f"https://github.com/{key[0]}/{key[1]}/pull/{key[2]}",
            }
    return results


def main() -> None:
    details = get_live_agents()
    if not details:
        print(json.dumps({"updatedAt": int(time.time() * 1000), "agents": {}}))
        return

    pid_to_conv = get_agy_pid_to_conv()
    matched_conv_ids: list[str] = []
    for d in details:
        fg_pid = (d.get("foreground") or {}).get("pid")
        if isinstance(fg_pid, int) and fg_pid in pid_to_conv:
            matched_conv_ids.append(pid_to_conv[fg_pid])

    agy_titles = get_agy_titles(matched_conv_ids)
    claude_sessions = load_claude_sessions()
    branch_cache: dict[str, set[tuple[str, str, int]]] = {}

    agent_titles: dict[str, str] = {}
    agent_pr_keys: dict[str, set[tuple[str, str, int]]] = {}
    all_pr_keys: set[tuple[str, str, int]] = set()

    for d in details:
        addr = d.get("address")
        if not addr:
            continue
        app = ((d.get("status") or {}).get("app")) or ""
        cwd = d.get("cwd") or ((d.get("foreground") or {}).get("cwd")) or ""
        raw_title = strip_leading_glyphs(d.get("title"))
        fg_pid = (d.get("foreground") or {}).get("pid")

        pr_keys: set[tuple[str, str, int]] = set()
        resolved_title = ""

        if app == "antigravity":
            conv_id = pid_to_conv.get(fg_pid) if isinstance(fg_pid, int) else None
            if conv_id:
                resolved_title = agy_titles.get(conv_id, "")
                pr_keys.update(extract_agy_transcript_prs(conv_id))
            else:
                pr_keys.update(extract_terminal_scrollback_prs(addr))
        elif app == "claude-code":
            if raw_title and raw_title.lower() not in {"claude", "claude code"}:
                resolved_title = raw_title
            encoded = encode_claude_cwd(cwd) if cwd else ""
            best = None
            if raw_title:
                for s in claude_sessions:
                    if raw_title == s["title"] or raw_title in s["all_titles"]:
                        if encoded and s["proj"] == encoded:
                            best = s
                            break
                        if best is None:
                            best = s
            if best:
                pr_keys.update(best["prs"])
        else:
            if raw_title:
                resolved_title = raw_title
            pr_keys.update(extract_terminal_scrollback_prs(addr))

        pr_keys.update(get_branch_prs(cwd, branch_cache))

        if resolved_title:
            agent_titles[addr] = resolved_title
        agent_pr_keys[addr] = pr_keys
        all_pr_keys.update(pr_keys)

    pr_details = fetch_pr_details_graphql(sorted(all_pr_keys))

    state_rank = {"OPEN": 0, "MERGED": 1, "CLOSED": 2}
    agents_out: dict[str, Any] = {}
    for d in details:
        addr = d.get("address")
        if not addr:
            continue
        keys = agent_pr_keys.get(addr, set())
        prs = []
        for k in keys:
            if k in pr_details:
                prs.append(pr_details[k])
            else:
                prs.append({
                    "repo": f"{k[0]}/{k[1]}",
                    "shortRepo": k[1],
                    "number": k[2],
                    "title": f"PR #{k[2]}",
                    "state": "OPEN",
                    "isDraft": False,
                    "ci": None,
                    "url": f"https://github.com/{k[0]}/{k[1]}/pull/{k[2]}",
                })
        prs.sort(key=lambda p: (state_rank.get(p["state"], 9), -p["number"], p["shortRepo"]))
        agents_out[addr] = {
            "title": agent_titles.get(addr) or None,
            "prs": prs,
        }

    print(json.dumps({"updatedAt": int(time.time() * 1000), "agents": agents_out}, ensure_ascii=False))


if __name__ == "__main__":
    main()
