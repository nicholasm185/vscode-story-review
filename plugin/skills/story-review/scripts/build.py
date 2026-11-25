import argparse
import difflib
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path

ASSETS = Path(__file__).resolve().parent.parent / "assets"

HUNK_RE = re.compile(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$")
GO_TOK = re.compile(
    r'(//.*$)|("(?:[^"\\]|\\.)*")|(`[^`]*`)|\b(func|return|if|else|for|range|switch|case|default|var|'
    r"const|type|struct|defer|go|nil|true|false|package|import)\b"
)
WORD = re.compile(r"\s+|\w+|[^\w\s]")
ATTR = re.compile(r'(\w+)="([^"]*)"')
TAG = re.compile(r"<!--.*?-->|<script\b[^>]*>.*?</script>|<(/?)([a-zA-Z][\w-]*)\b[^>]*?(/?)>", re.S)
VOID = {"br", "img", "input", "meta", "link", "hr", "col", "source", "wbr"}
HEADER_NODE = re.compile(r'<(?:div class="ch-head"|h2\b|p class="lede"|div class="files-in")')
CODE_NODE = re.compile(r'<!--@(?:diff|context) |<details class="more"')
GEN_CLOSE = "<!--/gen-->"
FINDING = re.compile(r"<!--@finding (\w+)((?:[^-]|-(?!->))*?)-->(.*?)<!--@end-->", re.S)
PLACEHOLDER_OR_FINDING = re.compile(r"<!--@(diff|context) (?:[^-]|-(?!->))*?-->|<!--@finding (\w+)((?:[^-]|-(?!->))*?)-->")
WALK = re.compile(r"<!--@walk ([\w-]+)-->(.*?)<!--@end-->", re.S)
STEP = re.compile(r"<!--@step ((?:[^-]|-(?!->))*?)-->")
FLOW = re.compile(r"<!--@flow([^>]*?)-->(.*?)<!--@end-->", re.S)
FLOW_BOX = re.compile(r"box((?: [a-z]+)*)\s*:\s*(.+)$")
FLOW_STATES = {"hot", "blocked", "open", "chip", "faded"}
WALK_ATTR = re.compile(r'<!--@(?:diff|context) [^>]*?\bwalk="([\w-]+)"')
SEVERITY = {"high": "High", "med": "Medium", "low": "Low", "nit": "Nit"}
SHORT_SEV = {"high": "High", "med": "Med", "low": "Low", "nit": "Nit"}
SECTION = re.compile(r"<!--@(scenario|fix|comment)-->")
KEYS_HINT = (
    '<div class="shortcuts"><h2>Keys</h2><p><kbd>j</kbd> <kbd>k</kbd> next or previous file<br>'
    '<kbd>n</kbd> <kbd>p</kbd> next or previous finding<br><kbd>v</kbd> Viewed for the file at the top<br>'
    '<kbd>c</kbd> hide or show the contents<br><kbd>t</kbd> hide or show the notes<br>'
    '<kbd>w</kbd> hide or show the walkthrough<br><kbd>s</kbd> split or unified diff</p>'
    '<label class="keys-toggle"><input type="checkbox" checked> Single-key shortcuts</label></div>'
)
WALK_KEY = "<kbd>w</kbd> hide or show the walkthrough<br>"
CODE_SPAN = re.compile(r"`([^`\n]+)`")
SKIP_ZONE = re.compile(r"<!--.*?-->|<(/?)(pre|script|code)\b[^>]*>", re.S)


def backticks(s):
    """Turns `x` in prose into <code>x</code>; pre, script, code, and comments stay as written."""
    out, pos, skip = [], 0, 0
    for m in SKIP_ZONE.finditer(s):
        chunk = s[pos : m.start()]
        out.append(chunk if skip else CODE_SPAN.sub(r"<code>\1</code>", chunk))
        out.append(m.group(0))
        if m.group(2):
            skip = max(0, skip + (-1 if m.group(1) else 1))
        pos = m.end()
    out.append(s[pos:] if skip else CODE_SPAN.sub(r"<code>\1</code>", s[pos:]))
    return "".join(out)


def flow_box(states, spec, where):
    states = states.split()
    bad = [s for s in states if s not in FLOW_STATES]
    if bad:
        raise SystemExit(f"flow {where}: unknown box state {bad}; use {sorted(FLOW_STATES)}")
    title, *lines = [esc(p.strip()) for p in spec.split("|")]
    return f'<div class="{" ".join(["fl-box", *("fl-" + st for st in states)])}"><b>{title}</b>' + "".join(f"<span>{p}</span>" for p in lines) + "</div>"


def render_flow(attr_text, body):
    """Expands a <!--@flow--> spec into HTML boxes and arrows that wrap instead of overflowing."""
    attrs = {k: html.unescape(v) for k, v in ATTR.findall(attr_text)}
    cols, gaps, gap = [], [], ("", "->")
    for raw in body.split("\n"):
        line = raw.strip()
        if not line:
            continue
        if raw[:1].isspace() and cols:
            m = re.fullmatch(r"(?:(.*?)\s+)?(->|=>)\s*(box.*)", line) or re.fullmatch(r"()(->|=>)\s*(box.*)", line)
            box = m and FLOW_BOX.fullmatch(m.group(3))
            if not box:
                raise SystemExit(f'flow: a branch reads "label -> box state: Title | line", not "{line}"')
            hot = " hot" if m.group(2) == "=>" else ""
            label = f"<span>{esc(m.group(1))}</span>" if m.group(1) else ""
            cols[-1].append(f'<div class="fl-branch"><div class="fl-down{hot}">{label}</div>' + flow_box(box.group(1), box.group(2), line) + "</div>")
            continue
        box = FLOW_BOX.fullmatch(line)
        if box:
            if cols:
                gaps.append(gap)
            cols.append([flow_box(box.group(1), box.group(2), line)])
            gap = ("", "->")
            continue
        m = re.fullmatch(r"(->|=>|--)\s*(.*)", line)
        if not m or not cols:
            raise SystemExit(f'flow: start with a "box: Title | line" line; then "-> label", "=> label" or "--" between boxes, not "{line}"')
        gap = (m.group(2), m.group(1))
    if not cols:
        raise SystemExit("flow: no boxes")
    parts = []
    for k, col in enumerate(cols):
        if k:
            label, kind = gaps[k - 1]
            if kind == "--":
                parts.append('<div class="fl-gap"></div>')
            else:
                hot = " hot" if kind == "=>" else ""
                parts.append(f'<div class="fl-arrow{hot}">' + (f"<span>{esc(label)}</span>" if label else "") + "</div>")
        parts.append(f'<div class="fl-col">{"".join(col)}</div>')
    down = " down" if attrs.get("dir") == "down" else ""
    cap = f"<figcaption>{esc(attrs['caption'])}</figcaption>" if attrs.get("caption") else ""
    return f'<figure class="flow-fig"><div class="fl{down}">{"".join(parts)}</div>{cap}</figure>'


def to_markdown(fragment):
    """Turns a finding's HTML (with backtick code still as written) into GitHub Markdown."""
    s = re.sub(
        r"<pre\b[^>]*>(.*?)</pre>",
        lambda m: "\n\n```\n" + html.unescape(re.sub(r"<[^>]+>", "", m.group(1))).strip("\n") + "\n```\n\n",
        fragment, flags=re.S,
    )
    s = re.sub(r"<code>(.*?)</code>", r"`\1`", s, flags=re.S)
    s = re.sub(r"<(b|strong)>(.*?)</\1>", r"**\2**", s, flags=re.S)
    s = re.sub(r"<(i|em)>(.*?)</\1>", r"*\2*", s, flags=re.S)
    s = re.sub(r'<a\b[^>]*href="([^"]+)"[^>]*>(.*?)</a>', r"[\2](\1)", s, flags=re.S)
    s = re.sub(r"<li\b[^>]*>", "\n- ", s)
    s = re.sub(r"<br\s*/?>", "\n", s)
    s = re.sub(r"</?(p|ul|ol|div|h\d)\b[^>]*>", "\n\n", s)
    s = html.unescape(re.sub(r"<[^>]+>", "", s))
    blocks, out = re.split(r"(```.*?```)", s, flags=re.S), []
    for b in blocks:
        out.append(b if b.startswith("```") else re.sub(r"[ \t]*\n[ \t]*\n\s*", "\n\n", re.sub(r"[ \t]+", " ", b)))
    return re.sub(r"\n{3,}", "\n\n", "".join(out)).strip()


def default_comment(attrs, lead, sections):
    """The PR comment a finding gets when the template writes none: title, body, scenario, fix."""
    title = re.search(r"<h4\b[^>]*>(.*?)</h4>", lead, re.S)
    body = re.sub(r"<h4\b[^>]*>.*?</h4>", "", lead, count=1, flags=re.S)
    cat = f'**[{attrs["cat"]}]** ' if attrs.get("cat") else ""
    out = [cat + (to_markdown(title.group(1)) if title else "")]
    out.append(to_markdown(body))
    for key, label in (("scenario", "Failure scenario"), ("fix", "Suggested fix")):
        if key in sections:
            out.append(f"**{label}:** " + to_markdown(sections[key]))
    return "\n\n".join(p for p in out if p.strip())


def expand_finding(fid, attrs, body):
    sev = attrs.get("sev", "")
    if sev not in SEVERITY:
        raise SystemExit(f"finding {fid} needs sev= one of {sorted(SEVERITY)}")
    parts = SECTION.split(body)
    sections = dict(zip(parts[1::2], parts[2::2]))
    rows = "".join(
        f'<div class="f-row"><span class="lbl">{label}</span><div>{sections[key].strip()}</div></div>'
        for key, label in (("scenario", "Failure scenario"), ("fix", "Suggested fix"))
        if key in sections
    )
    comment = sections.get("comment", "").strip() or default_comment(attrs, parts[0], sections)
    head = f'<span class="sev s-{sev}">{SEVERITY[sev]}</span>'
    if attrs.get("cat"):
        head += f'<span class="cat">{attrs["cat"]}</span>'
    if comment:
        head += '<span class="spacer"></span><button class="copy" type="button">Copy as PR comment</button>'
    script = f'<script type="text/markdown" class="md">{comment}</script>' if comment else ""
    return (
        f'<div class="finding s-{sev}-b" id="{fid}" data-short="{attrs.get("short", "")}">'
        f'<div class="f-head">{head}</div>{parts[0].strip()}{rows}{script}</div>'
    )


def classify(path):
    name = path.rpartition("/")[2]
    if re.search(r"(_test\.\w+|\.test\.\w+|\.spec\.\w+)$|(^|/)(tests?|__tests__)/", path) or name.startswith("test_"):
        return "Tests"
    if name.endswith((".md", ".mdx", ".rst", ".txt")) or path.startswith("docs/"):
        return "Docs"
    return "Code"


def ci_state(checks):
    if not checks:
        return "No CI checks", ""
    bad = {"FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"}
    if any((c.get("conclusion") or c.get("state") or "").upper() in bad for c in checks):
        return "CI failing", "warn"
    if any((c.get("status") or "COMPLETED").upper() != "COMPLETED" or (c.get("state") or "").upper() == "PENDING" for c in checks):
        return "CI running", ""
    return "CI passing", "ok"


def review_state(pr):
    latest = {}
    for r in pr.get("reviews") or []:
        if r.get("state") in ("APPROVED", "CHANGES_REQUESTED", "DISMISSED"):
            latest[r["author"]["login"]] = r["state"]
    approvers = [login for login, state in latest.items() if state == "APPROVED"]
    if approvers:
        return "Approved by " + ", ".join(approvers), "ok"
    if pr.get("reviewDecision") == "CHANGES_REQUESTED":
        return "Changes requested", "warn"
    return ("No approval yet" if pr.get("reviews") else "No reviews yet"), ""


def top_nodes(s):
    """Splits HTML into its top-level elements, comments, and text, in order."""
    nodes, depth, start, pos = [], 0, 0, 0
    for m in TAG.finditer(s):
        if depth == 0 and s[pos : m.start()].strip():
            nodes.append(s[pos : m.start()].strip())
        tok = m.group(0)
        if tok.startswith(("<!--", "<script")) or m.group(2).lower() in VOID or m.group(3):
            if depth == 0:
                nodes.append(tok)
                pos = m.end()
            continue
        if not m.group(1):
            if depth == 0:
                start = m.start()
            depth += 1
            continue
        depth -= 1
        if depth == 0:
            nodes.append(s[start : m.end()])
            pos = m.end()
    if s[pos:].strip():
        nodes.append(s[pos:].strip())
    return nodes


def plain(fragment):
    return html.unescape(re.sub(r"<[^>]+>", "", fragment)).strip()


def lay_out_chapter(m, number, total):
    """Pairs each run of notes with the diffs after it, so the notes can stick beside their code."""
    open_tag, inner = m.group(1), m.group(2)
    nodes = top_nodes(inner)
    header = []
    while nodes and HEADER_NODE.match(nodes[0]):
        header.append(nodes.pop(0))
    if not any("ch-head" in n for n in header):
        cid = re.search(r'id="([\w-]+)"', open_tag).group(1)
        header.insert(
            0,
            f'<div class="ch-head"><span class="ch-num">Chapter {number} of {total}</span>'
            f'<label class="seen-toggle"><input type="checkbox" id="seen-{cid}" data-ch="{cid}"> Mark as read</label></div>',
        )
    if not any(n.startswith('<div class="files-in"') for n in header):
        files = dict.fromkeys(re.findall(r'<!--@diff [^>]*?\bfile="([^"]+)"', inner))
        if files:
            header.append('<div class="files-in">' + "".join(f"<span>{esc(f)}</span>" for f in files) + "</div>")
    title = next((plain(n) for n in header if n.startswith("<h2")), "")
    num = next((re.search(r"Chapter \d+", plain(n)) for n in header if "ch-num" in n), None)
    label = esc(" · ".join(filter(None, [num.group(0) if num else "", title])))

    steps, notes, code = [], [], []
    for node in nodes:
        if CODE_NODE.match(node):
            code.append(node)
            continue
        if code:
            steps.append((notes, code))
            notes, code = [], []
        notes.append(node)
    if code:
        steps.append((notes, code))
    elif notes and steps:
        steps[-1][0].extend(notes)
    elif notes:
        steps.append((notes, []))

    out = []
    for step_notes, step_code in steps:
        kind = "step" if step_code else "step solo"
        walks = WALK_ATTR.findall("".join(step_code))
        col = ""
        if walks:
            kind += " has-walk"
            col = '<div class="wcol" data-gen="wcol">' + "".join(f"<!--@walknotes {w}-->" for w in walks) + f"</div>{GEN_CLOSE}"
        out.append(
            f'<div class="{kind}" data-gen="step"><aside class="step-notes" data-gen="notes">'
            f'<div class="notes-in" data-gen="notes-in"><div class="notes-ch" data-gen="label">{label}</div>'
            f"{chr(10).join(step_notes)}</div>{GEN_CLOSE}{col}</aside>{GEN_CLOSE}"
            f'<div class="step-code" data-gen="code">{chr(10).join(step_code)}</div>{GEN_CLOSE}</div>{GEN_CLOSE}'
        )
    body = f'<div class="steps" data-gen="steps">{"".join(out)}</div>{GEN_CLOSE}' if out else ""
    return f"{open_tag}\n  " + "\n  ".join(header) + f"\n  {body}\n</section>"


class Diff:
    """The PR's diff from base to head, read from git."""

    def __init__(self, repo, base, head):
        self.repo, self.base, self.head = repo, base, head
        self.numstat = {}
        for row in self.git("diff", "--no-renames", "--numstat", base, head).splitlines():
            adds, dels, path = row.split("\t", 2)
            self.numstat[path] = (None, None) if adds == "-" else (int(adds), int(dels))
        self._hunks = {}

    def git(self, *args):
        return subprocess.run(
            ["git", "-C", self.repo, *args], capture_output=True, text=True, check=True
        ).stdout

    def hunks(self, path):
        if path not in self._hunks:
            self._hunks[path] = parse_hunks(
                self.git("diff", "--no-renames", "-U3", self.base, self.head, "--", path)
            )
        return self._hunks[path]

    def head_lines(self, path):
        return self.git("show", f"{self.head}:{path}").split("\n")


def parse_hunks(text):
    hunks, cur = [], None
    for line in text.split("\n"):
        m = HUNK_RE.match(line)
        if m:
            cur = {"old": int(m.group(1)), "new": int(m.group(2)), "ctx": m.group(3), "raw": []}
            hunks.append(cur)
            continue
        if cur is None or line.startswith("\\") or line == "":
            continue
        cur["raw"].append((line[0], line[1:]))
    for h in hunks:
        o, n, rows = h["old"], h["new"], []
        for kind, text in h["raw"]:
            if kind == " ":
                rows.append(["ctx", o, n, text, None])
                o += 1
                n += 1
            elif kind == "-":
                rows.append(["del", o, None, text, None])
                o += 1
            else:
                rows.append(["add", None, n, text, None])
                n += 1
        h["rows"] = rows
    return hunks


def esc(s):
    return html.escape(s, quote=True)


def hl_go(s):
    out, pos = [], 0
    for m in GO_TOK.finditer(s):
        out.append(esc(s[pos : m.start()]))
        cls = "cm" if m.group(1) else "st" if (m.group(2) or m.group(3)) else "kw"
        out.append(f'<span class="{cls}">{esc(m.group(0))}</span>')
        pos = m.end()
    out.append(esc(s[pos:]))
    return "".join(out)


def word_marks(old_lines, new_lines):
    def toks(lines):
        t = []
        for i, line in enumerate(lines):
            t.extend([i, w, False] for w in WORD.findall(line))
            t.append([i, "\n", False])
        return t

    a, b = toks(old_lines), toks(new_lines)
    norm = lambda t: " " if t[1].isspace() else t[1]
    sm = difflib.SequenceMatcher(None, [norm(x) for x in a], [norm(x) for x in b], autojunk=False)
    if sm.ratio() < 0.35:
        return None, None
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag != "equal":
            for x in a[i1:i2] + b[j1:j2]:
                x[2] = not x[1].isspace()

    def per_line(t, count):
        lines = [[] for _ in range(count)]
        for i, w, ch in t:
            if w != "\n":
                lines[i].append([w, ch])
        for segs in lines:
            for k in range(1, len(segs) - 1):
                if segs[k][0].isspace() and segs[k - 1][1] and segs[k + 1][1]:
                    segs[k][1] = True
        return lines

    return per_line(a, len(old_lines)), per_line(b, len(new_lines))


def render_words(segs):
    out, run, flag = [], [], None
    for w, ch in segs + [["", None]]:
        if ch != flag and run:
            text = esc("".join(run))
            out.append(f'<span class="wd">{text}</span>' if flag else text)
            run = []
        flag = ch
        run.append(w)
    return "".join(out)


def mark_words(rows):
    i = 0
    while i < len(rows):
        if rows[i][0] != "del":
            i += 1
            continue
        j = i
        while j < len(rows) and rows[j][0] == "del":
            j += 1
        k = j
        while k < len(rows) and rows[k][0] == "add":
            k += 1
        if k > j:
            old, new = word_marks([r[3] for r in rows[i:j]], [r[3] for r in rows[j:k]])
            if old is not None:
                for r, segs in zip(rows[i:k], old + new):
                    r[4] = render_words(segs)
        i = k


def lang_of(path):
    if path.endswith(".go"):
        return "go"
    return "md" if path.endswith((".md", ".mdx", ".txt", ".rst")) else "plain"


def cell(row, lang):
    if row[4] is not None:
        return row[4]
    return hl_go(row[3]) if lang == "go" else esc(row[3])


def chnum(chapter_id):
    return re.sub(r"\D", "", chapter_id) or chapter_id


def lead_cols(lead):
    col = 0
    for c in lead:
        col += 4 - col % 4 if c == "\t" else 1
    return col


def code_td(row, lang):
    """The code cell. Leading whitespace becomes padding, so a wrapped line keeps its indent."""
    body = cell(row, lang)
    lead = re.match(r"[ \t]*", row[3]).group(0)
    if lead and body.startswith(lead):
        return f'<td class="code" data-ind="{lead_cols(lead)}"><span class="lead">{lead}</span>{body[len(lead):]}</td>'
    return f'<td class="code">{body}</td>'


SIGN = {"ctx": ("", ""), "del": ("−", "Removed"), "add": ("+", "Added")}


def sign_td(kind):
    mark, word = SIGN[kind]
    if not word:
        return '<td class="sg"></td>'
    return f'<td class="sg"><span aria-hidden="true">{mark}</span><span class="vh">{word}</span></td>'


def parse_pins(spec):
    pins = {}
    for part in filter(None, (spec or "").split(",")):
        line, fid = part.split(":")
        pins.setdefault(int(line), []).append(fid)
    return pins


def one_line(blocks, needle, what, where):
    """Finds the one shown new-side line containing needle: (block, row)."""
    hits = [(b, i) for b, rows in enumerate(blocks) for i, r in enumerate(rows) if r[2] is not None and needle in r[3]]
    if len(hits) != 1:
        lines = ", ".join(str(blocks[b][i][2]) for b, i in hits[:6]) or "none"
        raise SystemExit(f'{what}"{needle}" must match one shown line of {where}; it matches {len(hits)} (lines {lines})')
    return hits[0]


def head_range(lines, start, end, path):
    """A context block's lines at head: from= and to= are line numbers, text to find, or (to= only) +N."""
    start, end = html.unescape(start).strip(), html.unescape(end).strip()
    if start.isdigit():
        lo = int(start)
    else:
        hits = [n for n, line in enumerate(lines, 1) if start and start in line]
        if len(hits) != 1:
            shown = ", ".join(map(str, hits[:6])) or "none"
            raise SystemExit(f'context from="{start}" must match one line of {path} at head; it matches {len(hits)} (lines {shown})')
        lo = hits[0]
    if end.isdigit():
        hi = int(end)
    elif re.fullmatch(r"\+\d+", end):
        hi = lo + int(end[1:])
    else:
        hi = next((n for n in range(lo, len(lines) + 1) if end and end in lines[n - 1]), None)
        if hi is None:
            raise SystemExit(f'context to="{end}" matches no line of {path} at or after line {lo}')
    if not 1 <= lo <= hi <= len(lines):
        raise SystemExit(f"context lines {lo}-{hi} fall outside {path}, which has {len(lines)} lines at head")
    return lo, hi


def until_line(rows, start, needle, what, where):
    """The new-side line that ends a range starting at rows[start]: the first at or after it containing needle, or +N lines."""
    lo = rows[start][2]
    if not needle:
        return lo
    if re.fullmatch(r"\+\d+", needle):
        return lo + int(needle[1:])
    for r in rows[start:]:
        if r[2] is not None and needle in r[3]:
            return r[2]
    raise SystemExit(f'{what}"{needle}" matches no line at or after line {lo} in that hunk of {where}')


class Page:
    def __init__(self, diff, template, allow_incomplete, pr=None):
        self.diff = diff
        self.pr = pr
        self.allow_incomplete = allow_incomplete
        self.findings = {}
        self.pinned = {}
        self.used = set()
        self.walks = {}
        self.walks_used = set()
        self.walk_where = {}
        self.warnings = []
        self.anchors = {}
        self.contexts = []
        self.rendered = Counter()
        self.source = template
        text = WALK.sub(self._grab_walk, self._anchor_findings(template))
        text = FLOW.sub(lambda m: render_flow(m.group(1), m.group(2)), FINDING.sub(self._grab, text))
        self.text = backticks(text)
        if 'data-gen="steps"' in self.text:
            raise SystemExit("the template already holds built step markup; recover it first")
        total = self.text.count('<section class="chapter"')
        numbers = iter(range(1, total + 1))
        self.text = re.sub(
            r'(<section class="chapter"[^>]*>)(.*?)</section>',
            lambda m: lay_out_chapter(m, next(numbers), total),
            self.text,
            flags=re.S,
        )
        self.files = {}

    def _anchor_findings(self, text):
        """Hands each finding's at= text to the diff or context block written just before it, as atpins=."""
        adds, last = {}, None
        for m in PLACEHOLDER_OR_FINDING.finditer(text):
            if m.group(1):
                last = m.end() - 3
                continue
            attrs = dict(ATTR.findall(m.group(3)))
            if "at" not in attrs:
                continue
            if last is None:
                raise SystemExit(f"finding {m.group(2)} has at= but no diff or context block before it")
            self.anchors[m.group(2)] = html.unescape(attrs["at"]).strip()
            adds.setdefault(last, []).append(m.group(2))
        for pos in sorted(adds, reverse=True):
            text = text[:pos] + f' atpins="{",".join(adds[pos])}"' + text[pos:]
        return text

    def _at_pins(self, attrs, blocks, pins, where):
        for fid in filter(None, attrs.get("atpins", "").split(",")):
            b, i = one_line(blocks, self.anchors[fid], f"finding {fid} at=", where)
            pins.setdefault(blocks[b][i][2], []).append(fid)

    def _grab(self, m):
        fid, attrs, body = m.group(1), dict(ATTR.findall(m.group(2))), m.group(3).strip()
        card = body if body.startswith('<div class="finding') else expand_finding(fid, attrs, body)
        self.findings[fid] = backticks(re.sub(r"<(/?)h4\b", r"<\1h3", card))
        return ""

    def _grab_walk(self, m):
        wid, parts = m.group(1), STEP.split(m.group(2))
        if wid in self.walks:
            raise SystemExit(f"walk {wid} is defined twice")
        if parts[0].strip():
            raise SystemExit(f"walk {wid} has text before its first <!--@step-->")
        steps = []
        for k in range(1, len(parts), 2):
            spec, text = parts[k].strip(), parts[k + 1].strip()
            st = {"n": len(steps) + 1, "lo": None, "hi": None, "at": None, "to": None, "html": backticks(text)}
            nums = re.fullmatch(r"(\d+)(?:-(\d+))?", spec)
            if nums:
                st["lo"], st["hi"] = int(nums.group(1)), int(nums.group(2) or nums.group(1))
            else:
                attrs = {k: html.unescape(v) for k, v in ATTR.findall(spec)}
                if not attrs.get("at"):
                    raise SystemExit(f'walk {wid} step {st["n"]}: write <!--@step LO-HI--> or <!--@step at="text" to="text"-->')
                st["at"], st["to"] = attrs["at"].strip(), (attrs.get("to") or "").strip() or None
            if not text:
                raise SystemExit(f"walk {wid} step {st['n']} has no text")
            steps.append(st)
        if not steps:
            raise SystemExit(f"walk {wid} has no <!--@step--> markers")
        self.walks[wid] = steps
        return ""

    def _place_walk(self, wid, blocks, where):
        """Maps walk wid onto the shown rows: cover[(block, row)] is the step covering it, marks[(block, row)] starts one."""
        if not wid:
            return {}, {}
        if wid not in self.walks:
            raise SystemExit(f"{where} names an unknown walk: {wid}")
        if wid in self.walks_used:
            raise SystemExit(f"walk {wid} is attached to two blocks")
        self.walks_used.add(wid)
        prev = 0
        for st in self.walks[wid]:
            if st["at"] is not None:
                b, i = one_line(blocks, st["at"], f"walk {wid} step {st['n']} at=", where)
                st["lo"] = blocks[b][i][2]
                st["hi"] = until_line(blocks[b], i, st["to"], f"walk {wid} step {st['n']} to=", where)
            if st["hi"] < st["lo"]:
                raise SystemExit(f"walk {wid} step {st['n']}: lines {st['lo']}-{st['hi']} run upward")
            if st["lo"] <= prev:
                raise SystemExit(f"walk {wid} step {st['n']} (line {st['lo']}) overlaps the step above; list steps top to bottom")
            prev = st["hi"]
        self.walk_where[wid] = where
        cover, marks = {}, {}
        for st in self.walks[wid]:
            for b, rows in enumerate(blocks):
                at = {r[2]: i for i, r in enumerate(rows) if r[2] is not None}
                if st["lo"] not in at:
                    continue
                if st["hi"] not in at:
                    raise SystemExit(f"walk {wid} step {st['n']}: lines {st['lo']}-{st['hi']} must sit in one shown hunk of {where}")
                first, end = at[st["lo"]], at[st["hi"]]
                # Removed lines just above the first new line are what that line replaces, so the step covers them.
                while first > 0 and rows[first - 1][0] == "del" and (b, first - 1) not in cover:
                    first -= 1
                cover.update(((b, i), st["n"]) for i in range(first, end + 1))
                marks[(b, at[st["lo"]])] = st
                break
            else:
                raise SystemExit(f"walk {wid} step {st['n']} starts at line {st['lo']}, which {where} does not show")
        return cover, marks

    def _walk_row(self, wid, cover, marks, key, code):
        """The row's class and attributes, and its code cell with the step's marker when a step starts here."""
        attrs = f' data-ws="{wid}-{cover[key]}"' if key in cover else ""
        st = marks.get(key)
        if st:
            mark = (
                f'<a class="wmark" href="#{wid}-{st["n"]}" data-ws="{wid}-{st["n"]}" '
                f'aria-label="Step {st["n"]} note">{st["n"]}</a>'
            )
            code = code.replace('<td class="code"', '<td class="code wm"', 1)[: -len("</td>")] + mark + "</td>"
        return attrs, code

    def _walk_notes(self, wid):
        items = []
        for st in self.walks[wid]:
            span = f"{st['lo']}-{st['hi']}" if st["hi"] != st["lo"] else str(st["lo"])
            items.append(
                f'<li class="wnote" id="{wid}-{st["n"]}" data-ws="{wid}-{st["n"]}" data-lines="{span}">'
                f'<button class="wnum" type="button" aria-label="Step {st["n"]}: show lines {span.replace("-", " to ")}">'
                f'{st["n"]}</button><div class="wbody">{st["html"]}</div></li>'
            )
        return f'<ol class="wnotes" data-walk="{wid}" data-gen="walk">{"".join(items)}</ol>{GEN_CLOSE}'

    def _gh(self):
        url = (self.pr or {}).get("url", "")
        m = re.match(r"(https://github\.com/[^/]+/[^/]+)/pull/\d+", url)
        return (url, m.group(1)) if m else ("", "")

    def _gh_file(self, path, line=None):
        url, _ = self._gh()
        if not url:
            return ""
        return f"{url}/files#diff-{hashlib.sha256(path.encode()).hexdigest()}" + (f"R{line}" if line else "")

    def _gh_blob(self, path, lo, hi=None):
        _, repo = self._gh()
        if not repo:
            return ""
        return f"{repo}/blob/{self.diff.head}/{path}#L{lo}" + (f"-L{hi}" if hi and hi != lo else "")

    def _pin_rows(self, fids, path, line, gh=""):
        out = []
        for fid in fids:
            if fid not in self.findings:
                raise SystemExit(f"pin names an unknown finding: {fid}")
            self.used.add(fid)
            self.pinned[fid] = (path, line)
            card = self.findings[fid]
            if gh and 'class="gh"' not in card:
                link = f'<a class="gh" href="{esc(gh)}">Open line on GitHub</a>'
                if '<span class="spacer"></span>' in card:
                    card = card.replace('<span class="spacer"></span>', '<span class="spacer"></span>' + link, 1)
                else:
                    card = re.sub(
                        r'(<div class="f-head">.*?)(</div>)',
                        lambda m: m.group(1) + '<span class="spacer"></span>' + link + m.group(2),
                        card, count=1, flags=re.S,
                    )
            out.append(f'<tr class="pin"><td colspan="4">{card}</td></tr>')
        return "".join(out)

    def _header(self, path, extra="", part_id=None, part_label="", gh="", stat=True):
        fstat = ""
        if stat and path in self.diff.numstat and self.diff.numstat[path][0] is not None:
            a, d = self.diff.numstat[path]
            fstat = f'<span class="fstat"><b class="a">+{a}</b> <b class="d">−{d}</b></span>'
        copy = (
            f'<button class="copy-path" type="button" data-copy="{esc(path)}" aria-label="Copy path {esc(path)}" '
            f'title="Copy the path. Click a line number to copy path:line.">Copy path</button>'
        )
        link = f'<a class="gh" href="{esc(gh)}" aria-label="Open {esc(path)} on GitHub">GitHub</a>' if gh else ""
        box = (
            f'<label class="viewed-toggle"><input type="checkbox" data-path="{esc(path)}" data-part="{part_id}" '
            f'aria-label="Viewed {esc(path)}{part_label}"> Viewed</label>'
            if part_id
            else ""
        )
        return f'<div class="file-h"><span class="path">{esc(path)}</span>{extra}{fstat}{copy}{link}{box}</div>'

    def _survey(self):
        """Records, for each diff placeholder in page order, its file, part number, chapter, and collapsed state."""
        chapters = [(m.start(), m.group(1)) for m in re.finditer(r'<section class="chapter" id="([\w-]+)"', self.text)]
        plan = []
        for m in re.finditer(r"<!--@diff (.*?)-->", self.text):
            attrs = dict(ATTR.findall(m.group(1)))
            path = attrs["file"]
            if path not in self.diff.numstat:
                raise SystemExit(f"{path} is not in the diff between base and head")
            before = self.text[: m.start()]
            collapsed = before.count("<details") > before.count("</details>")
            chapter = next((cid for pos, cid in reversed(chapters) if pos < m.start()), "")
            info = self.files.setdefault(
                path, {"index": len(self.files) + 1, "parts": 0, "chapters": [], "collapsed": []}
            )
            info["parts"] += 1
            info["chapters"].append(chapter)
            info["collapsed"].append(collapsed)
            plan.append((path, info["parts"], collapsed))
        return plan

    def _diff_block(self, attrs, part):
        path = attrs["file"]
        lang = lang_of(path)
        hunks = self.diff.hunks(path)
        spec = attrs.get("hunks", "all")
        sel = range(len(hunks)) if spec == "all" else [int(x) for x in spec.split(",")]
        pins = parse_pins(attrs.get("pin"))
        info = self.files[path]
        for idx in sel:
            if idx >= len(hunks):
                raise SystemExit(f"{path} has {len(hunks)} hunks; the template asks for hunk {idx}")
        wid = attrs.get("walk")
        blocks = [hunks[idx]["rows"] for idx in sel]
        self._at_pins(attrs, blocks, pins, path)
        cover, marks = self._place_walk(wid, blocks, path)
        parts = []
        for b, idx in enumerate(sel):
            self.rendered[(path, idx)] += 1
            h = hunks[idx]
            if lang != "go" and not h.get("marked"):
                mark_words(h["rows"])
                h["marked"] = True
            body = []
            for i, r in enumerate(h["rows"]):
                o = "" if r[1] is None else r[1]
                n = "" if r[2] is None else r[2]
                ws, code = self._walk_row(wid, cover, marks, (b, i), code_td(r, lang))
                body.append(
                    f'<tr class="{r[0]}"{ws}><td class="ln">{o}</td><td class="ln">{n}</td>'
                    f"{sign_td(r[0])}{code}</tr>"
                )
                if r[2] is not None and r[2] in pins:
                    body.append(self._pin_rows(pins.pop(r[2]), path, r[2], self._gh_file(path, r[2])))
            ctx = f' <span class="hctx">{esc(h["ctx"])}</span>' if h["ctx"] else ""
            parts.append(
                f'<div class="hunk-h">@@ −{h["old"]} +{h["new"]} @@{ctx}</div>'
                f'<div class="scroll"><table class="diff {lang}"><tbody>{"".join(body)}</tbody></table></div>'
            )
        if pins:
            raise SystemExit(f"pins on lines outside the shown hunks of {path}: {pins}")
        ptag = (
            f'<span class="ptag" role="group" aria-label="Parts of {esc(path)}">Part'
            f'{self._part_links(path, here=part)}</span>'
            if info["parts"] > 1
            else ""
        )
        block_id = f'file-{info["index"]}-{part}'
        label = f', part {part} of {info["parts"]}' if info["parts"] > 1 else ""
        head = self._header(path, ptag, part_id=block_id, part_label=label, gh=self._gh_file(path))
        return (
            f'<div class="file" id="{block_id}" data-path="{esc(path)}" data-file="{esc(path)}">'
            f'{head}{"".join(parts)}</div>'
        )

    def _context_block(self, attrs):
        path = attrs["file"]
        lang = lang_of(path)
        lines = self.diff.head_lines(path)
        lo, hi = head_range(lines, attrs.get("from", ""), attrs.get("to", ""), path)
        pins = parse_pins(attrs.get("pin"))
        rows = [["ctx", n, n, lines[n - 1], None] for n in range(lo, hi + 1)]
        self._at_pins(attrs, [rows], pins, f"the context block of {path}")
        self.contexts.append((path, lo, hi))
        wid = attrs.get("walk")
        cover, marks = self._place_walk(wid, [rows], f"the context block of {path}")
        body = []
        for i, r in enumerate(rows):
            n = r[2]
            ws, code = self._walk_row(wid, cover, marks, (0, i), code_td(r, lang))
            body.append(
                f'<tr class="ctx"{ws}><td class="ln"></td><td class="ln">{n}</td><td class="sg"></td>'
                f"{code}</tr>"
            )
            if n in pins:
                body.append(self._pin_rows(pins.pop(n), path, n, self._gh_blob(path, n)))
        if pins:
            raise SystemExit(f"pins outside lines {lo}-{hi} of {path}: {pins}")
        note = f'<span class="ftag">{esc(attrs.get("note", "unchanged"))}</span>'
        return (
            f'<div class="file context" data-file="{esc(path)}">'
            f'{self._header(path, note, gh=self._gh_blob(path, lo, hi), stat=False)}'
            f'<div class="hunk-h">lines {lo}–{hi} at {self.diff.head[:9]}</div>'
            f'<div class="scroll"><table class="diff {lang}"><tbody>{"".join(body)}</tbody></table></div></div>'
        )

    def _count_more(self, m):
        """Fills {n} in a collapsed section's summary with its hunk count, and flags a count that disagrees."""
        n = m.group(4).count('<div class="hunk-h">@@')
        summary = m.group(2).replace("{n}", str(n))
        said = re.search(r"\b(\d+)\b[^<\d]*?\bhunks?\b", plain(summary))
        if said and int(said.group(1)) != n:
            self.warnings.append(f'collapsed section "{plain(summary)[:60]}" says {said.group(1)} hunks but holds {n}; write {{n}}')
        return m.group(1) + summary + m.group(3) + m.group(4)

    def _coverage(self):
        missing, repeated, total = [], [], 0
        for path in self.diff.numstat:
            n = len(self.diff.hunks(path))
            total += n
            for idx in range(n):
                seen = self.rendered[(path, idx)]
                if seen == 0:
                    missing.append(f"{path} hunk {idx}")
                elif seen > 1:
                    repeated.append(f"{path} hunk {idx} ({seen} times)")
        if (missing or repeated) and not self.allow_incomplete:
            raise SystemExit(
                "the page does not show every hunk exactly once:\n  "
                + "\n  ".join(missing + repeated)
                + "\npass --allow-incomplete to build anyway"
            )
        return total, missing, repeated

    def _checklist(self, total, missing, repeated):
        collapsed_hunks = 0
        for m in re.finditer(r'<details.*?</details>', self.text, re.S):
            collapsed_hunks += m.group(0).count('<div class="hunk-h">@@')
        count = len(self.diff.numstat)
        if missing or repeated:
            cover = (
                f'<p class="fcover warn">{len(missing)} hunks are missing from this page and '
                f"{len(repeated)} appear more than once.</p>"
            )
        elif collapsed_hunks:
            cover = (
                f'<p class="fcover">All {total} hunks of the {count} changed files are on this page. '
                f"{collapsed_hunks} are in collapsed sections; a file's link opens them.</p>"
            )
        else:
            cover = f'<p class="fcover">All {total} hunks of the {count} changed files are on this page.</p>'
        return (
            f'<details class="files-box" open><summary>Files<span class="fcount">0 / {count} viewed</span>'
            f'</summary><div class="fbar"><span></span></div>{cover}{self._tree(self.diff.numstat)}</details>'
        )

    def _leaf(self, path):
        info = self.files.get(path)
        a, d = self.diff.numstat[path]
        meta = [f'<span><b class="a">+{a}</b> <b class="d">−{d}</b></span>' if a is not None else "<span>binary</span>"]
        if info:
            chapters = ", ".join(dict.fromkeys(c for c in map(chnum, info["chapters"]) if c))
            if chapters:
                meta.append(f"<span>ch {esc(chapters)}</span>")
            if all(info["collapsed"]):
                meta.append("<span>collapsed</span>")
            elif any(info["collapsed"]):
                meta.append("<span>part collapsed</span>")
            link = f'<a href="#file-{info["index"]}-1" title="{esc(path)}">'
        else:
            meta.append('<span class="warn">not on this page</span>')
            link = f'<a title="{esc(path)}">'
        jumps = ""
        if info and info["parts"] > 1:
            jumps = (
                f'<span class="fjump" role="group" aria-label="Parts of {esc(path)}">'
                f'{self._part_links(path)}<span class="fparts">{info["parts"]} parts</span></span>'
            )
        return (
            f'<li class="tfile" data-path="{esc(path)}"><input type="checkbox" data-path="{esc(path)}" '
            f'aria-label="Viewed {esc(path)}"><div>{link}<span class="fname">{esc(path.rpartition("/")[2])}</span>'
            f'</a><span class="fmeta">{"".join(meta)}</span>{jumps}</div></li>'
        )

    def _part_links(self, path, here=None):
        """One numbered link per part of a split file; page.js marks the viewed ones."""
        info = self.files[path]
        links = []
        for p, cid in enumerate(info["chapters"], 1):
            jump = f'file-{info["index"]}-{p}'
            label = f'Part {p} of {info["parts"]}' + (f", chapter {chnum(cid)}" if chnum(cid) else "")
            cur = ' aria-current="true"' if p == here else ""
            cls = "pj is-here" if p == here else "pj"
            links.append(
                f'<a class="{cls}" href="#{jump}" data-jump="{jump}" data-label="{label}" '
                f'aria-label="{label}" title="{label}"{cur}>{p}</a>'
            )
        return "".join(links)

    def _tree(self, paths):
        root = {}
        for path in paths:
            node = root
            for part in path.split("/")[:-1]:
                node = node.setdefault(part, {})
            node[path.rpartition("/")[2]] = path

        def leaves(node):
            return sum(1 if isinstance(v, str) else leaves(v) for v in node.values())

        def render(node):
            out = []
            for name, child in sorted((k, v) for k, v in node.items() if isinstance(v, dict)):
                while len(child) == 1 and isinstance(next(iter(child.values())), dict):
                    sub, child = next(iter(child.items()))
                    name = f"{name}/{sub}"
                out.append(
                    f'<li class="tdir"><details open><summary><span class="dname">{esc(name)}</span>'
                    f'<span class="dprog">0/{leaves(child)}</span></summary><ul>{render(child)}</ul></details></li>'
                )
            out.extend(self._leaf(p) for _, p in sorted((k, v) for k, v in node.items() if isinstance(v, str)))
            return "".join(out)

        return f'<ul class="ftree">{render(root)}</ul>'

    def _finding_list(self):
        rank = list(SEVERITY)
        items = []
        for fid, card in self.findings.items():
            sev = re.search(r'class="finding s-(\w+)-b"', card)
            title = re.search(r"<h[34]\b[^>]*>(.*?)</h[34]>", card, re.S)
            short = re.search(r'data-short="([^"]+)"', card)
            items.append({
                "id": fid,
                "sev": sev.group(1) if sev else "nit",
                "title": title.group(1).strip() if title else fid,
                "short": short.group(1) if short else plain(title.group(1)) if title else fid,
                "pos": self.text.find(f'id="{fid}"'),
            })
        return sorted(items, key=lambda f: (rank.index(f["sev"]) if f["sev"] in rank else 9, f["pos"]))

    def _toc(self, findings):
        rows = []
        for m in re.finditer(r'<section class="explain" id="([\w-]+)"[^>]*>.*?<h2\b[^>]*>(.*?)</h2>', self.text, re.S):
            rows.append(
                f'<li><a href="#{m.group(1)}"><span class="n"></span>'
                f'<span class="t">{esc(plain(m.group(2)))}</span><span></span></a></li>'
            )
        tail = []
        for m in re.finditer(r'<section class="closing" id="([\w-]+)"[^>]*>.*?<h2\b[^>]*>(.*?)</h2>', self.text, re.S):
            tail.append(
                f'<li><a href="#{m.group(1)}"><span class="n"></span>'
                f'<span class="t">{esc(plain(m.group(2)))}</span><span></span></a></li>'
            )
        for m in re.finditer(r'<section class="chapter" id="([\w-]+)"[^>]*>(.*?)</section>', self.text, re.S):
            cid, inner = m.groups()
            h2 = re.search(r"<h2\b[^>]*>(.*?)</h2>", inner, re.S)
            num = re.search(r"Chapter (\d+)", inner)
            here = [f for f in findings if f'id="{f["id"]}"' in inner]
            dot = f'<span class="dot s-{here[0]["sev"]}">{len(here)}</span>' if here else "<span></span>"
            rows.append(
                f'<li data-ch="{cid}"><a href="#{cid}"><span class="n">{num.group(1) if num else ""}</span>'
                f'<span class="t">{esc(plain(h2.group(1))) if h2 else cid}</span>{dot}</a></li>'
            )
        return f'<h2>Read in this order</h2>\n  <ol id="toc">{"".join(rows + tail)}</ol>'

    def _rail_findings(self, findings):
        if not findings:
            return '<h2>Findings</h2>\n  <p class="none">None</p>'
        rows = "".join(
            f'<li><a href="#{f["id"]}"><span class="sev s-{f["sev"]}">{SHORT_SEV.get(f["sev"], f["sev"])}</span>'
            f'<span>{f["short"]}</span></a></li>'
            for f in findings
        )
        return f'<h2>Findings</h2>\n  <ol class="fl">{rows}</ol>'

    def _findings_table(self, findings):
        if not findings:
            return '<div class="nofind">No findings.</div>'
        rows = []
        for f in findings:
            path, line = self.pinned.get(f["id"], ("", ""))
            loc = f'{esc(path.rpartition("/")[2])}:{line}' if path else ""
            rows.append(
                f'<tr><td><span class="sev s-{f["sev"]}">{SEVERITY.get(f["sev"], f["sev"])}</span></td>'
                f'<td><a href="#{f["id"]}">{f["title"]}</a></td><td class="loc" title="{esc(path)}">{loc}</td></tr>'
            )
        return f'<table class="ftable"><tbody>{"".join(rows)}</tbody></table>'

    def _meta(self):
        pr = self.pr
        if not pr:
            raise SystemExit("<!--@meta--> needs the PR's JSON: save it as pr.json beside the template, or pass --pr-json")
        split = {"Code": [0, 0], "Tests": [0, 0], "Docs": [0, 0]}
        for path, (a, d) in self.diff.numstat.items():
            if a is not None:
                split[classify(path)][0] += a
                split[classify(path)][1] += d
        adds = sum(a for a, _ in split.values())
        dels = sum(d for _, d in split.values())
        parts = " · ".join(
            f'{k} <b class="a">+{a}</b><b class="d">−{d}</b>' for k, (a, d) in split.items() if a or d
        )
        author = pr.get("author") or {}
        name = author.get("name") or author.get("login", "")
        ci, ci_cls = ci_state(pr.get("statusCheckRollup") or [])
        review, review_cls = review_state(pr)
        url = pr.get("url", "")
        chips = [
            f'<a class="chip gh" href="{esc(url)}">#{pr.get("number", "")} on GitHub</a>' if url else "",
            f'<span class="chip">By {esc(name)} <span class="mono">{esc(author.get("login", ""))}</span></span>',
            f'<span class="chip"><span class="mono">{esc(pr.get("baseRefName", "base"))} @ {self.diff.base[:9]}</span>'
            f' ← <span class="mono">{esc(pr.get("headRefName", "head"))} @ {self.diff.head[:9]}</span></span>',
            f'<span class="chip"><b class="a">+{adds}</b><b class="d">−{dels}</b> in {len(self.diff.numstat)} files</span>',
            f'<span class="chip">{parts}</span>' if parts else "",
            f'<span class="chip {ci_cls}">{ci} on {self.diff.head[:9]}</span>',
            f'<span class="chip {review_cls}">{esc(review)}</span>',
        ]
        return f'<div class="meta">{"".join(chips)}</div>'

    def _closing(self, findings):
        """The end-of-page card; page.js fills in what is viewed, copied, and read."""
        files = "".join(
            f'<li data-path="{esc(p)}"><a href="#file-{self.files[p]["index"]}-1">{esc(p)}</a> '
            f'<span class="cl-parts"></span></li>'
            if p in self.files
            else f'<li data-path="{esc(p)}">{esc(p)}</li>'
            for p in self.diff.numstat
        )
        finds = "".join(
            f'<li data-fid="{f["id"]}"><span class="sev s-{f["sev"]}">{SHORT_SEV.get(f["sev"], f["sev"])}</span> '
            f'<a href="#{f["id"]}">{f["short"]}</a> <span class="cl-state">not copied yet</span></li>'
            for f in findings
        )
        finds_row = f'<ul class="cl-finds">{finds}</ul>' if finds else "<p>No findings to post.</p>"
        nxt = ""
        m = re.search(
            r'<span class="node here">.*?</span>\s*<span class="arrow">[^<]*</span>\s*(<(a|span) class="node"[^>]*>.*?</\2>)',
            self.text, re.S,
        )
        if m:
            node = m.group(1).replace(' class="node"', "", 1)
            nxt = f'<div class="cl-row"><h3>Next in the stack</h3><p>{node}</p></div>'
        chapters = self.text.count('<section class="chapter"')
        return (
            '<section class="closing" id="end" aria-labelledby="end-h">'
            '<h2 id="end-h">Where this review stands</h2>'
            f'<div class="cl-row"><h3>Files</h3><p data-sum="files">{len(self.diff.numstat)} files changed.</p>'
            f'<ul class="cl-files">{files}</ul></div>'
            f'<div class="cl-row"><h3>Findings to post</h3>{finds_row}</div>'
            f'<div class="cl-row"><h3>Chapters</h3><p data-sum="chapters">{chapters} chapters.</p></div>'
            f'{nxt}<p class="cl-top"><a href="#main">Back to the top</a></p></section>'
        )

    def _verdict(self, text):
        """Puts "Verdict" inside the heading, and tags the section with the decision for its colour."""
        text = re.sub(
            r'<div class="label">Verdict</div>\s*<h2 id="verdict-h">(.*?)</h2>',
            lambda m: f'<h2 id="verdict-h"><span class="vlabel">Verdict</span> <span class="decision">{m.group(1).strip()}</span></h2>',
            text, count=1, flags=re.S,
        )
        m = re.search(r'<span class="decision">(.*?)</span>', text, re.S)
        if m and "data-decision=" not in text:
            d = plain(m.group(1)).lower()
            kind = "block" if d.startswith("request") else "changes" if "after" in d else "approve" if d.startswith("approve") else ""
            if kind:
                text = text.replace('<section class="verdict"', f'<section class="verdict" data-decision="{kind}"', 1)
        return text

    def _checked(self, text):
        """Moves what wasn't verified to the top of the checked list."""
        m = re.search(r'<section class="checked"[^>]*>.*?<ul>(.*?)</ul>', text, re.S)
        if not m:
            return text
        items = top_nodes(m.group(1))
        no = [n for n in items if n.startswith('<li class="no"')]
        if not no:
            return text
        rest = [n for n in items if not n.startswith('<li class="no"')]
        return text[: m.start(1)] + "\n    " + "\n    ".join(no + rest) + "\n  " + text[m.end(1) :]

    def render(self):
        plan = iter(self._survey())

        def diff_sub(m):
            _, part, _ = next(plan)
            return self._diff_block(dict(ATTR.findall(m.group(1))), part)

        self.text = re.sub(r"<!--@diff (.*?)-->", diff_sub, self.text)
        self.text = re.sub(
            r"<!--@context (.*?)-->", lambda m: self._context_block(dict(ATTR.findall(m.group(1)))), self.text
        )
        unused = set(self.findings) - self.used
        if unused:
            raise SystemExit(f"findings never pinned to a line: {sorted(unused)}")
        idle = set(self.walks) - self.walks_used
        if idle:
            raise SystemExit(f'walks never attached with walk="…" on a diff or context block: {sorted(idle)}')
        self.text = re.sub(r"<!--@walknotes ([\w-]+)-->", lambda m: self._walk_notes(m.group(1)), self.text)
        self.text = re.sub(
            r'(<details class="more"[^>]*>\s*<summary>)(.*?)(</summary>)(.*?</details>)', self._count_more, self.text, flags=re.S
        )
        total, missing, repeated = self._coverage()
        if "<!--@files-->" not in self.text:
            raise SystemExit("the template has no <!--@files--> placeholder for the file checklist")
        self.text = self.text.replace("<!--@files-->", self._checklist(total, missing, repeated))
        findings = self._finding_list()
        if 'class="closing"' not in self.text:
            self.text = self.text.replace("</main>", self._closing(findings) + "\n</main>", 1)
        if 'class="shortcuts"' not in self.text:
            hint = KEYS_HINT if self.walks else KEYS_HINT.replace(WALK_KEY, "")
            self.text = self.text.replace("</nav>", hint + "\n</nav>", 1)
        for name, make in (
            ("toc", lambda: self._toc(findings)),
            ("findings", lambda: self._rail_findings(findings)),
            ("findings-table", lambda: self._findings_table(findings)),
            ("meta", self._meta),
        ):
            if f"<!--@{name}-->" in self.text:
                self.text = self.text.replace(f"<!--@{name}-->", make())
        self.text = self._verdict(self._checked(self.text))
        url = (self.pr or {}).get("url", "")
        if url and 'class="chip gh"' not in self.text:
            chip = f'<a class="chip gh" href="{esc(url)}">#{self.pr.get("number", "")} on GitHub</a>'
            self.text = self.text.replace('<div class="meta">', f'<div class="meta">{chip}', 1)
        if 'class="skip"' not in self.text:
            self.text = self.text.replace(
                '<div class="page">', '<a class="skip" href="#main">Skip to the review</a>\n<div class="page">', 1
            )
        self.text = self.text.replace("<main>", '<main id="main">', 1)
        self.text = self.text.replace('<nav class="rail" aria-label="Chapters">', '<nav class="rail" aria-label="Review contents">', 1)
        css = (ASSETS / "base.css").read_text(encoding="utf-8")
        inds = sorted({int(n) for n in re.findall(r'data-ind="(\d+)"', self.text)})
        css += "".join(f'table.diff .code[data-ind="{n}"] {{ --ind: {n}; }}\n' for n in inds)
        self.text = self.text.replace("<!--@style-->", f"<style>\n{css}</style>")
        js = (ASSETS / "page.js").read_text(encoding="utf-8")
        self.text = re.sub(
            r'<!--@script key="([\w-]+)"-->',
            lambda m: f'<script data-key="{m.group(1)}">\n{js}</script>',
            self.text,
        )
        leftover = re.findall(r"<!--@\w+[^>]*-->", self.text)
        if leftover:
            raise SystemExit(f"placeholders left unfilled: {leftover}")
        return self.text, total, missing, repeated


HTML_TAGS = set(
    "a abbr aside b blockquote br button caption code col colgroup dd del details dfn div dl dt em figcaption figure "
    "footer h1 h2 h3 h4 h5 h6 header hr i img input ins kbd label li link main mark meta nav ol p pre q s samp section "
    "small span strong style sub summary sup table tbody td tfoot th thead time title tr u ul var wbr script svg "
    "defs marker path rect line polyline polygon circle ellipse text tspan g title desc".split()
)


def known_classes():
    """Every class the stylesheet styles, the build writes, or page.js looks up."""
    css = (ASSETS / "base.css").read_text(encoding="utf-8")
    js = (ASSETS / "page.js").read_text(encoding="utf-8")
    me = Path(__file__).read_text(encoding="utf-8")
    known = set(re.findall(r"\.([a-zA-Z][\w-]*)", css)) | set(re.findall(r"\.([a-zA-Z][\w-]*)", js))
    known.update(re.findall(r'classList\.\w+\("([\w-]+)"', js))
    for s in re.findall(r'class="([^"{]+)"', me) + re.findall(r'className \+?= "([^"]+)"', js):
        known.update(s.split())
    known.update(f"s-{k}" for k in SEVERITY)
    known.update(f"s-{k}-b" for k in SEVERITY)
    return known


def style_lint_rules(repo, head):
    """Lint rules from the "## Lint" sections of the style files: lines like - `regex` what it means."""
    texts = []
    team = subprocess.run(
        ["git", "-C", repo, "show", f"{head}:.claude/story-review-style.md"], capture_output=True, text=True
    )
    if team.returncode == 0:
        texts.append(team.stdout)
    own = Path.home() / ".claude/story-reviews/style.md"
    texts.append(own.read_text(encoding="utf-8") if own.exists() else "")
    if not any(texts):
        texts.append((ASSETS.parent / "references/default-style.md").read_text(encoding="utf-8"))
    rules = []
    for t in texts:
        sec = re.search(r"^## Lint\s*$(.*?)(?=^## |\Z)", t, re.M | re.S)
        for rx, why in re.findall(r"^- `([^`]+)`\s*(.*)$", sec.group(1) if sec else "", re.M):
            rules.append((re.compile(rx), why.strip() or rx))
    return rules


def visible_prose(text):
    """The page's reader-facing words: no code, diffs, styles, scripts, or diagrams; PR comments included."""
    md = " ".join(re.findall(r'<script type="text/markdown" class="md">(.*?)</script>', text, re.S))
    md = re.sub(r"```.*?```|`[^`\n]*`", " ", md, flags=re.S)
    s = re.sub(r'<table class="diff.*?</table>', " ", text, flags=re.S)
    s = re.sub(r"<(style|script|svg|pre|code)\b.*?</\1>", " ", s, flags=re.S)
    return html.unescape(re.sub(r"<[^>]+>", " ", s)) + " " + md


def lint(page, text, rules):
    out = list(page.warnings)
    prose = visible_prose(text)
    for rx, why in rules:
        hits = [m for m in rx.finditer(prose)]
        if hits:
            m = hits[0]
            near = re.sub(r"\s+", " ", prose[max(0, m.start() - 30) : m.end() + 30]).strip()
            out.append(f'{why}: {len(hits)} in the prose, first near "{near}"')
    src = re.sub(r"<!--@comment-->.*?<!--@end-->", "", FLOW.sub("", page.source), flags=re.S)
    src = re.sub(r"<!--.*?-->|<(pre|script|style|code)\b.*?</\1>", "", src, flags=re.S)
    unknown = sorted(set(" ".join(re.findall(r'class="([^"]+)"', re.sub(r"<svg\b.*?</svg>", "", src, flags=re.S))).split()) - known_classes())
    if unknown:
        out.append(f"classes no stylesheet rule or script knows (typos?): {unknown}")
    for m in re.finditer(r"<([a-zA-Z][\w-]*)", src):
        if m.group(1).lower() not in HTML_TAGS:
            out.append(f'"<{m.group(1)}" is read as an HTML tag and hides its text; write &lt;{m.group(1)}')
    ids = re.findall(r'\bid="([^"]+)"', text)
    dup = sorted({i for i in ids if ids.count(i) > 1})
    if dup:
        out.append(f"ids used more than once: {dup[:8]}")
    dead = sorted({h for h in re.findall(r'href="#([^"]+)"', text) if h not in set(ids)})
    if dead:
        out.append(f"in-page links to nothing: {dead[:8]}")
    for k, svg in enumerate(re.findall(r"<svg\b.*?</svg>", text, re.S)):
        if re.search(r'(fill|stroke)="(?!none|currentColor|url\()|style="[^"]*(fill|stroke|color)\s*:', svg):
            out.append(f"diagram {k + 1} sets a literal colour; use the .dg classes so both themes work")
    for k, t in enumerate(re.findall(r'<table class="trace">.*?</table>', text, re.S)):
        first = re.search(r"<tr>(.*?)</tr>", t, re.S)
        if first and len(re.findall(r"<t[hd]\b", first.group(1))) > 3:
            out.append(f"trace table {k + 1} has more than 3 columns")
    return out


def report(page, text):
    """What the build made, so nobody greps the page to check it."""
    lines = []
    d = re.search(r'<span class="decision">(.*?)</span>', text, re.S)
    lines.append(f"verdict: {plain(d.group(1)) if d else '(no verdict heading)'}")
    chapters = [(m.group(1), m.group(2)) for m in re.finditer(r'<section class="chapter" id="([\w-]+)"[^>]*>(.*?)</section>', text, re.S)]
    where = {}
    for n, (cid, inner) in enumerate(chapters, 1):
        for fid in re.findall(r'<div class="finding[^"]*" id="([\w-]+)"', inner):
            where[fid] = n
    for f in page._finding_list():
        path, line = page.pinned.get(f["id"], ("?", "?"))
        lines.append(f'  {f["id"]} {f["sev"]:4s} {path.rpartition("/")[2]}:{line} ch {where.get(f["id"], "?")}  {plain(f["short"])}')
    for n, (cid, inner) in enumerate(chapters, 1):
        h2 = re.search(r"<h2\b[^>]*>(.*?)</h2>", inner, re.S)
        blocks = len(re.findall(r'<div class="file" id=', inner))
        bits = [f"{blocks} diff block" + ("" if blocks == 1 else "s")]
        ctx = len(re.findall(r'<div class="file context"', inner))
        if ctx:
            bits.append(f"{ctx} context")
        for wid in re.findall(r'data-walk="([\w-]+)"', inner):
            st = page.walks[wid]
            bits.append(f"walk {wid}: {len(st)} steps, lines {st[0]['lo']}-{st[-1]['hi']}")
        for s in re.findall(r'<details class="more"[^>]*>\s*<summary>(.*?)</summary>', inner, re.S):
            bits.append(f'collapsed "{plain(s)[:50]}"')
        lines.append(f"ch {n} {plain(h2.group(1)) if h2 else cid}: " + "; ".join(bits))
    return lines


def update_meta(meta_path, page, text, diff):
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    d = re.search(r'<span class="decision">(.*?)</span>', text, re.S)
    meta.update(base=diff.base, head=diff.head, verdict=plain(d.group(1)) if d else "")
    meta["findings"] = [
        {"id": f["id"], "sev": f["sev"], "short": plain(f["short"]), "at": "{}:{}".format(*page.pinned.get(f["id"], ("", "")))}
        for f in page._finding_list()
    ]
    meta_path.write_text(json.dumps(meta, indent=1) + "\n", encoding="utf-8")


def find_chrome():
    for env in ("STORY_REVIEW_CHROME", "CHROME"):
        if os.environ.get(env) and Path(os.environ[env]).exists():
            return os.environ[env]
    for name in ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "microsoft-edge"):
        if shutil.which(name):
            return shutil.which(name)
    mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    return mac if Path(mac).exists() else None


def render_check(text, near):
    """Runs scripts/check.mjs on a full-document copy; returns (problems, note).

    The copy sits beside the output, not in /tmp: snap Chromium has a private /tmp and would load a blank page.
    """
    node, chrome = shutil.which("node"), find_chrome()
    if not node or not chrome:
        return None, "render check skipped: needs node 22+ and Chromium or Chrome (set STORY_REVIEW_CHROME)"
    with tempfile.TemporaryDirectory(prefix="check-", dir=near, ignore_cleanup_errors=True) as tmp:
        page = Path(tmp) / "page.html"
        page.write_text(standalone(text), encoding="utf-8")
        try:
            run = subprocess.run(
                [node, str(Path(__file__).parent / "check.mjs"), str(page), chrome, tmp],
                capture_output=True, text=True, timeout=180,
            )
        except subprocess.TimeoutExpired:
            return None, "render check skipped: the browser did not answer in 180s"
    if run.returncode not in (0, 1):
        return None, "render check skipped: " + (run.stderr.strip().splitlines() or ["unknown error"])[-1]
    return [line for line in run.stdout.splitlines() if line.strip()], ""


def standalone(text):
    if text.lstrip().lower().startswith("<!doctype"):
        return text
    return (
        '<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n' + text + "\n</html>\n"
    )


def stamp(text, diff):
    """Names the commits the page was built from, for readers that check a checkout against it."""
    sha = lambda ref: diff.git("rev-parse", ref).strip()
    line = f"<!-- story-review base={sha(diff.base)} head={sha(diff.head)} -->\n"
    if text.lstrip().lower().startswith("<!doctype"):
        first, _, rest = text.partition("\n")
        return first + "\n" + line + rest
    return line + text


def main():
    ap = argparse.ArgumentParser(description="Render a story-review page from a template and the git diff.")
    ap.add_argument("--repo", required=True, help="path to a checkout that has both commits")
    ap.add_argument("--base", required=True, help="the commit the PR's diff starts from (merge base with its base branch)")
    ap.add_argument("--head", required=True, help="the PR's head commit")
    ap.add_argument("--template", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--allow-incomplete", action="store_true", help="build even when hunks are missing or repeated")
    ap.add_argument("--pr-json", help="gh pr view JSON for <!--@meta-->; defaults to pr.json beside the template")
    ap.add_argument(
        "--standalone",
        action="store_true",
        help="write a full HTML document to open from disk; an Artifact publish adds this skeleton itself",
    )
    ap.add_argument("--no-check", action="store_true", help="skip the headless browser render check")
    args = ap.parse_args()

    template = Path(args.template)
    pr_path = Path(args.pr_json) if args.pr_json else template.parent / "pr.json"
    pr = json.loads(pr_path.read_text(encoding="utf-8")) if pr_path.exists() else None
    diff = Diff(args.repo, args.base, args.head)
    page = Page(diff, template.read_text(encoding="utf-8"), args.allow_incomplete, pr)
    text, total, missing, repeated = page.render()
    out = Path(args.out)
    full = standalone(text) if args.standalone else text
    out.write_text(stamp(full, diff), encoding="utf-8")
    print(
        f"wrote {args.out}: {len(text):,} bytes; {len(diff.numstat)} files, {total} hunks, "
        f"{len(page.findings)} findings; missing {len(missing)}, repeated {len(repeated)}"
    )
    print("\n".join(report(page, text)))
    meta = template.parent / "meta.json"
    if meta.exists() and out.resolve().parent == template.resolve().parent:
        update_meta(meta, page, text, diff)
    problems = lint(page, text, style_lint_rules(args.repo, args.head))
    note = "render check skipped (--no-check)"
    if not args.no_check:
        found, note = render_check(text, out.resolve().parent)
        problems += found or []
        note = note or "render check: ran at 390px, 1100px dark, 1600px and 1920px with split view"
    if note:
        print(note)
    if problems:
        print(f"{len(problems)} problem(s) to fix before publishing:")
        print("\n".join(f"  - {p}" for p in problems))
    else:
        print("checks: clean")


if __name__ == "__main__":
    sys.exit(main())
