"""Gathers everything a story review needs before reading code, in one call.

Writes pr.json and meta.json in the review folder, backs up an earlier review of this PR when its head moved,
and prints the PR, its stack, threads, CI, earlier reviews that changed since, and the hunk map.
"""

import argparse
import json
import re
import shutil
import subprocess
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from build import Diff, classify  # noqa: E402

BOTS = {"github-actions", "dependabot", "codecov", "sonarcloud", "vercel"}
PR_FIELDS = (
    "number,title,url,author,body,baseRefName,headRefName,headRefOid,additions,deletions,changedFiles,"
    "state,isDraft,mergedAt,mergeCommit,reviewDecision,reviews,statusCheckRollup"
)
EARLIER = """{alias}: pullRequest(number: {n}) {{ number state headRefOid baseRefName mergedAt mergeCommit {{ oid }} }}"""
QUERY = """query($owner: String!, $name: String!, $n: Int!, $head: String!, $base: String!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    pullRequest(number: $n) {
      reviewThreads(first: 100) { nodes { isResolved isOutdated path line originalLine
        comments(first: 30) { nodes { author { login } body } } } }
      comments(first: 100) { nodes { author { login } body } }
    }
    children: pullRequests(baseRefName: $head, first: 10, states: [OPEN, MERGED], orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { number title state headRefName } }
    parent: pullRequests(headRefName: $base, first: 5, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { number title state baseRefName } }
    %s
  }
}"""


def sh(*args, cwd=None, check=True):
    run = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    if check and run.returncode != 0:
        raise SystemExit(f"{' '.join(args[:4])} failed: {run.stderr.strip()[:400]}")
    return run.stdout if check else run


def git(repo, *args, check=True):
    return sh("git", "-C", repo, *args, check=check)


def clip(text, n):
    text = re.sub(r"\s+", " ", text or "").strip()
    return text if len(text) <= n else text[: n - 1] + "…"


def ci_summary(checks):
    groups = {"failing": [], "running": [], "passing": [], "skipped": []}
    for c in checks or []:
        name = c.get("name") or c.get("context") or "?"
        state = (c.get("conclusion") or c.get("state") or "").upper()
        status = (c.get("status") or "COMPLETED").upper()
        if state in {"FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"}:
            groups["failing"].append(name)
        elif status != "COMPLETED" or state == "PENDING":
            groups["running"].append(name)
        elif state in {"SKIPPED", "NEUTRAL"}:
            groups["skipped"].append(name)
        else:
            groups["passing"].append(name)
    if not checks:
        return "no CI checks"
    line = ", ".join(f"{len(v)} {k}" for k, v in groups.items() if v)
    for k in ("failing", "running"):
        if groups[k]:
            line += f"\n    {k}: " + ", ".join(groups[k][:6]) + (" …" if len(groups[k]) > 6 else "")
    return line


def review_summary(pr):
    latest = {}
    for r in pr.get("reviews") or []:
        latest[r["author"]["login"]] = r["state"]
    people = ", ".join(f"{who} {state.lower().replace('_', ' ')}" for who, state in latest.items())
    return f"{pr.get('reviewDecision') or 'no decision'}" + (f" ({people})" if people else "")


def patch_id(repo, base, head):
    diff = git(repo, "diff", "--no-renames", base, head, check=False)
    if diff.returncode != 0:
        return None
    pid = subprocess.run(["git", "-C", repo, "patch-id", "--stable"], input=diff.stdout, capture_output=True, text=True)
    return (pid.stdout.split() or [""])[0]


def earlier_reviews(root, current):
    """The latest meta.json per earlier PR in this repo's review folder, newest first."""
    best = {}
    for meta in list(root.glob("pr-*/meta.json")) + list(root.glob("pr-*/v*/meta.json")):
        try:
            m = json.loads(meta.read_text(encoding="utf-8"))
        except ValueError:
            continue
        n = m.get("pr")
        if not n or n == current or not m.get("head"):
            continue
        key = (m.get("reviewed", ""), len(meta.parts))
        if n not in best or key > best[n][0]:
            best[n] = (key, m, meta.parent)
    rows = sorted(best.values(), key=lambda r: r[0], reverse=True)
    return [(m, folder) for _, m, folder in rows[:8]]


def describe_change(repo, m, now):
    """One line on how an earlier review's PR moved since it was reviewed."""
    old, new = m["head"], now.get("headRefOid", "")
    merge = (now.get("mergeCommit") or {}).get("oid")
    where = f"merged at {merge[:9]}" if now.get("state") == "MERGED" and merge else f"{now.get('state', '?').lower()} at {new[:9]}"
    if new == old:
        return f"unchanged since the review ({where})"
    if git(repo, "merge-base", "--is-ancestor", old, new, check=False).returncode == 0:
        log = git(repo, "log", "--format=%h %s", f"{old}..{new}").splitlines()
        more = "; ".join(clip(line, 70) for line in log[:4]) + (" …" if len(log) > 4 else "")
        return f"{len(log)} commit(s) after the review, {where}: {more}"
    if merge:
        base_now, head_now = f"{merge}^1", merge
    else:
        base_ref = f"origin/{now.get('baseRefName', '')}"
        base_now = git(repo, "merge-base", base_ref, new, check=False).stdout.strip()
        head_now = new
    same = base_now and patch_id(repo, m["base"], m["head"]) == patch_id(repo, base_now, head_now)
    return f"rebased, {where}; " + ("same patch" if same else f"patch changed: git range-diff {m['base'][:9]}..{old[:9]} {base_now[:12]}..{head_now[:9]}")


HUNK0 = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@", re.M)
REF = re.compile(r"(?<![\w/.-])((?:[\w.-]+/)*[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{1,5}):(\d+)(?:-(\d+))?(?![\d-])")
FLOW_TOKENS = re.compile(r'<li\b|</li>|<div>([\w./-]+\.[A-Za-z]{1,5})</div>|<span class="k">:(\d+)(?:-(\d+))?</span>')
DIRECTIVE = re.compile(r"<!--@.*?-->", re.S)


class LineMap:
    """Maps line numbers at one head to the next head, through git diff -U0 between them."""

    def __init__(self, repo, old, new, pr_files):
        self.repo, self.old, self.new = repo, old, new
        self.changed = set(git(repo, "diff", "--no-renames", "--name-only", old, new).split())
        self.pr_files = list(pr_files)
        self._tree = None
        self._hunks = {}

    def resolve(self, ref):
        """The repository path a reference like deadletter.go or pkg/x.go names, or a list when it is ambiguous."""
        def match(paths):
            return sorted({p for p in paths if p == ref or p.endswith("/" + ref)})
        hits = match(self.pr_files)
        if not hits:
            if self._tree is None:
                self._tree = git(self.repo, "ls-tree", "-r", "--name-only", self.new).split("\n")
            hits = match(self._tree)
        return hits[0] if len(hits) == 1 else hits

    def hunks(self, path):
        if path not in self._hunks:
            text = git(self.repo, "diff", "--no-renames", "-U0", self.old, self.new, "--", path)
            count = lambda g: 1 if g is None else int(g)
            self._hunks[path] = [
                (int(m.group(1)), count(m.group(2)), int(m.group(3)), count(m.group(4))) for m in HUNK0.finditer(text)
            ]
        return self._hunks[path]

    def line(self, path, n):
        """(line at the new head, whether git changed that line)."""
        shift = 0
        for os_, oc, ns, nc in self.hunks(path):
            if oc == 0:
                if os_ >= n:
                    break
                shift += nc
                continue
            if n < os_:
                break
            if n < os_ + oc:
                return max(1, ns + min(n - os_, nc - 1) if nc else ns), True
            shift += nc - oc
        return n + shift, False

    def span(self, path, a, b):
        """(new a, new b, touched) for lines a..b; touched when any line in it changed or lines were added inside it."""
        na, ta = self.line(path, a)
        nb, tb = self.line(path, b)
        inside = any((oc and os_ <= b and os_ + oc - 1 >= a) or (not oc and a <= os_ < b) for os_, oc, _, _ in self.hunks(path))
        return na, nb, ta or tb or inside


def carry_line_refs(text, lm):
    """Moves file:line references in a template from the old head to the new one; returns the text and a report."""
    skip = [m.span() for m in DIRECTIVE.finditer(text)]
    in_directive = lambda pos: any(a <= pos < b for a, b in skip)
    edits, moved, check, unsure = [], [], [], []

    def carry(start, end, label, ref, a, b, fmt):
        path = lm.resolve(ref)
        if isinstance(path, list):
            if path and any(p in lm.changed for p in path):
                unsure.append(f"{label} names {len(path)} files")
            return
        if path not in lm.changed:
            return
        na, nb, touched = lm.span(path, a, b)
        new = fmt(na, nb)
        note = f"{label} -> {new}" if (na, nb) != (a, b) else label
        if touched:
            check.append(note)
        elif (na, nb) != (a, b):
            moved.append(note)
        if (na, nb) != (a, b):
            edits.append((start, end, new))

    for m in REF.finditer(text):
        if in_directive(m.start()):
            continue
        ref, a = m.group(1), int(m.group(2))
        b = int(m.group(3)) if m.group(3) else a
        carry(m.start(), m.end(), m.group(0), ref, a, b,
              lambda x, y, r=ref, rng=bool(m.group(3)): f"{r}:{x}-{y}" if rng and y != x else f"{r}:{x}")
    current = None
    for m in FLOW_TOKENS.finditer(text):
        tok = m.group(0)
        if tok.startswith("<li") or tok == "</li>":
            current = None
        elif m.group(1):
            current = m.group(1)
        elif current and not in_directive(m.start()):
            a = int(m.group(2))
            b = int(m.group(3)) if m.group(3) else a
            carry(m.start(), m.end(), f"{current} :{m.group(2)}" + (f"-{m.group(3)}" if m.group(3) else ""), current, a, b,
                  lambda x, y, rng=bool(m.group(3)): f'<span class="k">:{x}' + (f"-{y}" if rng and y != x else "") + "</span>")
    for start, end, new in sorted(edits, reverse=True):
        text = text[:start] + new + text[end:]
    return text, moved, check, unsure


def file_patch_id(repo, base, head, path):
    diff = git(repo, "diff", "--no-renames", base, head, "--", path, check=False).stdout
    if not diff:
        return ""
    pid = subprocess.run(["git", "-C", repo, "patch-id", "--stable"], input=diff, capture_output=True, text=True)
    return (pid.stdout.split() or [""])[0]


def since_last(repo, prev, base, head, files, lm):
    """Lines describing how this PR moved since the review at prev["head"]."""
    old, old_base = prev["head"], prev.get("base") or base
    out = [f"Since the last review ({old[:9]}, {prev.get('verdict') or 'no verdict'}, {prev.get('reviewed', '?')}):"]
    if git(repo, "merge-base", "--is-ancestor", old, head, check=False).returncode == 0:
        log = git(repo, "log", "--first-parent", "--format=%h %p|%s", f"{old}..{head}").splitlines()
        out.append(f"  {len(log)} commit(s) after it:")
        for row in log[:15]:
            sha_parents, _, subject = row.partition("|")
            sha, *parents = sha_parents.split()
            out.append(f"    {sha} {'(merge) ' if len(parents) > 1 else ''}{clip(subject, 90)}")
        if len(log) > 15:
            out.append(f"    … {len(log) - 15} more")
    else:
        out.append(f"  rebased or force-pushed: git range-diff {old_base[:12]}..{old[:12]} {base[:12]}..{head[:12]}")
    if old_base != base:
        out.append(f"  merge base moved {old_base[:9]} -> {base[:9]}; files below compare the PR's own change per file")
    old_files = set(git(repo, "diff", "--no-renames", "--name-only", old_base, old).split())
    differ, same = [], 0
    for f in files:
        if f in old_files and file_patch_id(repo, old_base, old, f) == file_patch_id(repo, base, head, f):
            same += 1
        else:
            differ.append(f)
    stat = {}
    for row in git(repo, "diff", "--no-renames", "--numstat", old, head, "--", *differ).splitlines() if differ else []:
        a, d, p = row.split("\t", 2)
        stat[p] = f"+{a} -{d}"
    for f in differ:
        what = "new in the PR" if f not in old_files else stat.get(f, "same at both heads; only the base under it moved")
        out.append(f"    {f}  {what}")
    for f in sorted(old_files - set(files)):
        out.append(f"    {f}  left the PR")
    out.append(f"  the PR's own change is the same in {same} other file(s)")
    touched = [f for f in differ if f in stat or f not in old_files]
    if touched:
        out.append(f"  read it: git diff {old[:12]} {head[:12]} -- " + " ".join(touched))
    for fd in prev.get("findings") or []:
        file, _, line = fd.get("at", "").rpartition(":")
        where = fd.get("at", "")
        if file and line.isdigit():
            path = lm.resolve(file)
            if isinstance(path, str) and path in lm.changed:
                n, touched = lm.line(path, int(line))
                where = f"{file}:{n}" + (" (its line changed: re-check)" if touched else "")
        out.append(f"  {fd.get('id')} {fd.get('sev')} {fd.get('short')}  at {where}")
    for key in ("fixed", "accepted", "carry"):
        for item in prev.get(key) or []:
            out.append(f"  {key}: {item}")
    return out


def hunk_map(diff):
    out = []
    for path, (adds, dels) in diff.numstat.items():
        stat = "binary" if adds is None else f"+{adds} -{dels}"
        out.append(f"{path}  {stat}  {classify(path)}")
        for idx, h in enumerate(diff.hunks(path)):
            news = [r[2] for r in h["rows"] if r[2] is not None]
            a = sum(r[0] == "add" for r in h["rows"])
            d = sum(r[0] == "del" for r in h["rows"])
            span = f"{min(news)}-{max(news)}" if news else f"(removed at {h['new']})"
            out.append(f"  {idx:>2}  new {span:<11} +{a} -{d}  {clip(h['ctx'], 70)}")
    return out


def main():
    ap = argparse.ArgumentParser(description="Set up a story review: PR metadata, stack, threads, CI, and the hunk map.")
    ap.add_argument("--repo", required=True, help="a checkout of the repository (it is fetched, never checked out)")
    ap.add_argument("--pr", required=True, type=int)
    ap.add_argument("--dir", help="the review folder; defaults to ~/.claude/story-reviews/<owner>-<repo>/pr-<n>")
    ap.add_argument("--body", type=int, default=3000, help="characters of the PR body to print (the full body is in pr.json)")
    args = ap.parse_args()
    repo = str(Path(args.repo).resolve())

    pr = json.loads(sh("gh", "pr", "view", str(args.pr), "--json", PR_FIELDS, cwd=repo))
    owner, name = re.match(r"https://github\.com/([^/]+)/([^/]+)/pull/", pr["url"]).groups()
    root = Path.home() / ".claude/story-reviews" / f"{owner}-{name}"
    folder = Path(args.dir) if args.dir else root / f"pr-{args.pr}"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "pr.json").write_text(json.dumps(pr, indent=1) + "\n", encoding="utf-8")

    earlier = earlier_reviews(root, args.pr)
    aliases = "\n    ".join(EARLIER.format(alias=f"p{m['pr']}", n=m["pr"]) for m, _ in earlier)
    gql = json.loads(sh(
        "gh", "api", "graphql", "-f", f"query={QUERY % aliases}", "-f", f"owner={owner}", "-f", f"name={name}",
        "-F", f"n={args.pr}", "-f", f"head={pr['headRefName']}", "-f", f"base={pr['baseRefName']}", cwd=repo,
    ))["data"]["repository"]

    base_ref, head = pr["baseRefName"], pr["headRefOid"]
    refs = [base_ref, f"pull/{args.pr}/head"] + [f"pull/{m['pr']}/head" for m, _ in earlier]
    fetched = git(repo, "fetch", "-q", "origin", *refs, check=False)
    if fetched.returncode != 0:
        git(repo, "fetch", "-q", "origin", f"pull/{args.pr}/head")
        print(f"note: could not fetch every ref ({clip(fetched.stderr, 160)})")
    if git(repo, "cat-file", "-e", f"{head}^{{commit}}", check=False).returncode != 0:
        raise SystemExit(f"head {head[:9]} is not in {repo} after fetching")
    merge = (pr.get("mergeCommit") or {}).get("oid")
    if pr["state"] == "MERGED" and merge:
        mb = git(repo, "merge-base", f"{merge}^1", head).strip()
    else:
        mb = git(repo, "merge-base", f"origin/{base_ref}", head).strip()
    tip = git(repo, "rev-parse", f"origin/{base_ref}", check=False).stdout.strip()
    behind = int(git(repo, "rev-list", "--count", f"{mb}..{tip}").strip() or 0) if tip else 0
    default = (gql.get("defaultBranchRef") or {}).get("name", "main")

    meta_path = folder / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
    notes = []
    diff = Diff(repo, mb, head)
    carried = None
    if meta.get("head") and meta["head"] != head and (folder / "template.html").exists():
        tag = meta["head"][:9]
        kept = {}
        for kind in ("template", "page"):
            src, dst = folder / f"{kind}.html", folder / f"{kind}-{tag}.html"
            if src.exists() and not dst.exists():
                shutil.copy2(src, dst)
            kept[kind] = dst.name
        meta.setdefault("previous", [])
        if not any(p.get("head") == meta["head"] for p in meta["previous"] if isinstance(p, dict)):
            snapshot = {k: meta[k] for k in ("findings", "fixed", "accepted", "carry") if meta.get(k)}
            meta["previous"].append({"head": meta["head"], "base": meta.get("base"), "reviewed": meta.get("reviewed"),
                                     "verdict": meta.get("verdict"), **kept, **snapshot})
        notes.append(f"re-review: the review at {tag} is kept as template-{tag}.html and page-{tag}.html; template.html is its copy to update")
        if git(repo, "cat-file", "-e", f"{meta['head']}^{{commit}}", check=False).returncode == 0:
            lm = LineMap(repo, meta["head"], head, diff.numstat)
            tpl = folder / "template.html"
            text, moved, check, unsure = carry_line_refs(tpl.read_text(encoding="utf-8"), lm)
            tpl.write_text(text, encoding="utf-8")
            carried = (tag, moved, check, unsure)
    elif meta.get("head") == head and (meta.get("url") or meta.get("verdict")):
        notes.append(f"this head was already reviewed on {meta.get('reviewed')}: {meta.get('url', 'no URL yet')}")
    meta.update(repo=f"{owner}/{name}", pr=args.pr, base=mb, head=head, reviewed=date.today().isoformat())
    meta_path.write_text(json.dumps(meta, indent=1) + "\n", encoding="utf-8")

    p = print
    p(f"#{args.pr} {pr['title']}")
    p(f"  {pr['url']}  by {pr['author'].get('login')}  {pr['state'].lower()}{' draft' if pr.get('isDraft') else ''}")
    p(f"  {base_ref} <- {pr['headRefName']}; head {head[:9]}; merge base {mb[:9]}; +{pr['additions']} -{pr['deletions']} in {pr['changedFiles']} files")
    if base_ref != default and behind:
        p(f"  STACK NEEDS A REBASE: {base_ref} has {behind} commit(s) this PR doesn't")
    elif behind:
        p(f"  {behind} commit(s) behind {base_ref} (fine for a PR on {default})")
    parent = [x for x in gql["parent"]["nodes"] if x["state"] != "CLOSED"][:1] if base_ref != default else []
    kids = [f"#{x['number']} ({x['state'].lower()})" for x in gql["children"]["nodes"]]
    p(f"  stack: parent {('#%d %s' % (parent[0]['number'], parent[0]['state'].lower())) if parent else base_ref}; next up {', '.join(kids) or 'none'}")
    p(f"  CI: {ci_summary(pr.get('statusCheckRollup'))}")
    p(f"  reviews: {review_summary(pr)}")
    for n in notes:
        p(f"  {n}")
    p(f"  folder: {folder}")
    prev = (meta.get("previous") or [None])[-1]
    if isinstance(prev, dict) and prev.get("head") and prev["head"] != head:
        if git(repo, "cat-file", "-e", f"{prev['head']}^{{commit}}", check=False).returncode == 0:
            lm = LineMap(repo, prev["head"], head, diff.numstat)
            p("")
            p("\n".join(since_last(repo, prev, mb, head, list(diff.numstat), lm)))
        else:
            p(f"\nSince the last review: its head {prev['head'][:9]} isn't in {repo}; fetch it to compare")
    if carried:
        tag, moved, check, unsure = carried
        p(f"\nLine references in template.html, carried from {tag} to {head[:9]}:")
        p(f"  moved with the code ({len(moved)}): " + ("; ".join(moved) or "none"))
        if check:
            p(f"  CHECK, their lines changed ({len(check)}): " + "; ".join(check))
        if unsure:
            p(f"  left as is, the name fits several files: " + "; ".join(unsure))

    threads = gql["pullRequest"]["reviewThreads"]["nodes"]
    comments = gql["pullRequest"]["comments"]["nodes"]
    p(f"\nThreads ({len(threads)}) and comments ({len(comments)}):")
    for t in threads:
        cs = t["comments"]["nodes"]
        state = ("resolved" if t["isResolved"] else "OPEN") + (", outdated" if t["isOutdated"] else "")
        first = cs[0] if cs else {"author": {"login": "?"}, "body": ""}
        p(f"  [{state}] {t['path']}:{t.get('line') or t.get('originalLine')} {first['author']['login']}: {clip(first['body'], 300)}")
        for c in cs[1:]:
            p(f"      {c['author']['login']}: {clip(c['body'], 160)}")
    for c in comments:
        who = (c.get("author") or {}).get("login", "?")
        p(f"  [comment] {who}: {clip(c['body'], 90 if who in BOTS or who.endswith('[bot]') else 300)}")
    for r in pr.get("reviews") or []:
        if r.get("body"):
            p(f"  [review {r['state'].lower()}] {r['author']['login']}: {clip(r['body'], 300)}")

    if earlier:
        p("\nEarlier reviews in this folder:")
        for m, mfolder in earlier:
            now = gql.get(f"p{m['pr']}") or {}
            p(f"  #{m['pr']} reviewed {m.get('reviewed')} at {m['head'][:9]}: {describe_change(repo, m, now)}")
            if m.get("verdict"):
                finds = "; ".join(f"{f['sev']} {f['short']}" for f in m.get("findings", []) if f.get("sev") != "nit")
                posted = " (posted)" if m.get("posted") else ""
                p(f"      {m['verdict']}{posted}" + (f": {finds}" if finds else ""))
            for c in m.get("carry", []):
                p(f"      carry: {c}")

    body = pr.get("body") or ""
    p(f"\nBody{' (first %d of %d characters; all of it is in pr.json)' % (args.body, len(body)) if len(body) > args.body else ''}:")
    p(body[: args.body].strip() or "(empty)")

    p("\nHunk map (index, new-file lines, +/-, the hunk's function):")
    p("\n".join(hunk_map(diff)))
    build = Path(__file__).resolve().parent / "build.py"
    p(f"\nBuild: python3 -I {build} --repo {repo} --base {mb} --head {head} --template {folder}/template.html --out {folder}/page.html")


if __name__ == "__main__":
    sys.exit(main())
