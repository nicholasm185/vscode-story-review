import argparse
import html
import re
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from build import ATTR, Diff, Page  # noqa: E402

HUNK_H = re.compile(r'<div class="hunk-h">@@ −(\d+) \+(\d+) @@(?: <span class="hctx">(.*?)</span>)?</div>')
TOKEN = re.compile(r"<script\b[^>]*>.*?</script>|<div\b|</div>", re.S)
ROW_LN = re.compile(r'<td class="ln">\d*</td><td class="ln">(\d+)</td>')


def div_end(s, start):
    """Returns the index just past the </div> that closes the <div at start, skipping script bodies."""
    depth = 0
    for m in TOKEN.finditer(s, start):
        tok = m.group(0)
        if tok.startswith("<script"):
            continue
        depth += 1 if tok == "<div" else -1
        if depth == 0:
            return m.end()
    raise SystemExit(f"unclosed <div> at offset {start}")


def details_end(s, start):
    depth = 0
    for m in re.finditer(r"<details\b|</details>", s[start:]):
        depth += 1 if m.group(0) == "<details" else -1
        if depth == 0:
            return start + m.end()
    raise SystemExit(f"unclosed <details> at offset {start}")


def strip_skeleton(s):
    if s.lstrip().lower().startswith("<!doctype"):
        s = s[s.index("<body>") + len("<body>") :].lstrip("\n")
        s = re.sub(r"</body>\s*</html>\s*$", "", s)
    return s


def pins_in(block):
    """Finds each pinned finding in a rendered block: (new line above it, finding id, finding html)."""
    out = []
    for m in re.finditer(r'<tr class="pin"><td colspan="4">', block):
        start = m.end()
        end = div_end(block, start)
        card = block[start:end]
        fid = re.search(r'<div class="finding[^"]*" id="([\w-]+)"', card).group(1)
        line = ROW_LN.findall(block[: m.start()])[-1]
        out.append((int(line), fid, card))
    return out


def take_walks(s):
    """Removes each walkthrough's note list from the page: {walk id: [(line range, step html)]}."""
    walks = {}
    for m in reversed(list(re.finditer(r'<ol class="wnotes" data-walk="([\w-]+)" data-gen="walk">(.*?)</ol><!--/gen-->', s, re.S))):
        steps, body = [], m.group(2)
        for li in re.finditer(r'<li class="wnote" id="[\w-]+" data-ws="[\w-]+" data-lines="([\d-]+)">', body):
            start = body.index('<div class="wbody">', li.end())
            end = div_end(body, start)
            steps.append((li.group(1), body[start + len('<div class="wbody">') : end - len("</div>")]))
        walks[m.group(1)] = steps
        s = s[: m.start()] + s[m.end() :]
    return s, walks


def recover(page_html, diff):
    s, walks = take_walks(strip_skeleton(page_html))
    out, pos = [], 0
    for m in re.finditer(r'<div class="file( context)?"[^>]*>', s):
        if m.start() < pos:
            continue
        end = div_end(s, m.start())
        block = s[m.start() : end]
        out.append(s[pos : m.start()])
        pins = pins_in(block)
        pin_attr = ",".join(f"{line}:{fid}" for line, fid, _ in pins)
        mark = re.search(r'<a class="wmark" href="#[\w-]+" data-ws="([\w-]+)-\d+"', block)
        wid = mark.group(1) if mark else None
        steps = walks.pop(wid, []) if wid else []
        walk_attr = f' walk="{wid}"' if wid else ""
        path_m = re.search(r'<span class="path">(.*?)</span>', block)
        path = html.unescape(path_m.group(1)) if path_m else None
        if m.group(1):
            note = html.unescape(re.search(r'<span class="ftag">(.*?)</span>', block).group(1))
            lo, hi = re.search(r'<div class="hunk-h">lines (\d+)–(\d+) at', block).groups()
            attrs = f'file="{path}" from="{lo}" to="{hi}"' + (f' pin="{pin_attr}"' if pins else "") + walk_attr
            out.append(f'<!--@context {attrs} note="{note}"-->')
        else:
            shown = [(int(o), int(n), html.unescape(c or "")) for o, n, c in HUNK_H.findall(block)]
            candidates = [path] if path else list(diff.numstat)
            matches = []
            for p in candidates:
                keys = [(h["old"], h["new"], h["ctx"]) for h in diff.hunks(p)]
                if all(k in keys for k in shown):
                    matches.append((p, [keys.index(k) for k in shown]))
            if len(matches) != 1:
                raise SystemExit(f"cannot tell which file a block belongs to: {shown[:2]} -> {[p for p, _ in matches]}")
            path, idxs = matches[0]
            spec = "all" if idxs == list(range(len(diff.hunks(path)))) else ",".join(map(str, idxs))
            attrs = f'file="{path}" hunks="{spec}"' + (f' pin="{pin_attr}"' if pins else "") + walk_attr
            out.append(f"<!--@diff {attrs}-->")
        if wid:
            body = "".join(f"<!--@step {lines}-->\n{html_}\n" for lines, html_ in steps)
            out.append(f"\n<!--@walk {wid}-->\n{body}<!--@end-->")
        for _, fid, card in pins:
            out.append(f"\n<!--@finding {fid}-->\n{card}\n<!--@end-->")
        pos = end
    out.append(s[pos:])
    t = "".join(out)

    t = re.sub(r'<div class="notes-ch" data-gen="label">.*?</div>', "", t)
    t = re.sub(r'<(?:div|aside)\b[^>]*\bdata-gen="[^"]*"[^>]*>', "", t)
    t = t.replace("</div><!--/gen-->", "").replace("</aside><!--/gen-->", "")

    key = None
    js = re.search(r'<script(?: data-key="([\w-]+)")?>\s*\(function \(\) \{.*?</script>', t, re.S)
    if js:
        key = js.group(1) or (re.search(r'var KEY = "([\w-]+?)-review-seen"', js.group(0)) or [None, None])[1]
        t = t[: js.start()] + f'<!--@script key="{key or "review"}"-->' + t[js.end() :]

    styles = list(re.finditer(r"<style>.*?</style>\n?", t, re.S))
    if styles:
        first = styles[0].start()
        for m in reversed(styles):
            t = t[: m.start()] + t[m.end() :]
        t = t[:first] + "<!--@style-->\n" + t[first:]

    t = re.sub(r'<section class="closing".*?</section>\n?', "", t, flags=re.S)
    for marker in ('<div class="shortcuts">', '<div class="keys"><h2>Keys</h2>'):
        at = t.find(marker)
        if at >= 0:
            t = t[:at] + t[div_end(t, at) :]

    box = t.find('<details class="files-box"')
    if box >= 0:
        t = t[:box] + "<!--@files-->" + t[details_end(t, box) :]
    elif "<h2>Stack</h2>" in t:
        t = t.replace("<h2>Stack</h2>", "<!--@files-->\n  <h2>Stack</h2>", 1)
    else:
        t = t.replace("</nav>", "  <!--@files-->\n</nav>", 1)
    return t


def outline(page_html):
    """The parts of a page a rebuild must keep: hunk headers, findings, and visible prose."""
    s = strip_skeleton(page_html)
    hunks = HUNK_H.findall(s)
    findings = re.findall(r'<div class="finding[^"]*" id="([\w-]+)"', s)
    prose = [re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", p)).strip() for p in re.findall(r"<p\b[^>]*>(.*?)</p>", s, re.S)]
    prose = [p for p in prose if not p.startswith("All ") or "hunks of the" not in p]
    return hunks, findings, prose


def main():
    ap = argparse.ArgumentParser(description="Recover a story-review template from a rendered page.")
    ap.add_argument("--repo", required=True)
    ap.add_argument("--base", required=True)
    ap.add_argument("--head", required=True)
    ap.add_argument("--page", required=True, help="the rendered page, for example an Artifact read's saved file")
    ap.add_argument("--out", required=True, help="where to write the recovered template")
    args = ap.parse_args()

    diff = Diff(args.repo, args.base, args.head)
    page_html = Path(args.page).read_text(encoding="utf-8")
    template = recover(page_html, diff)
    Path(args.out).write_text(template, encoding="utf-8")

    rebuilt, *_ = Page(diff, template, allow_incomplete=True).render()
    want, got = outline(page_html), outline(rebuilt)
    for name, a, b in zip(("hunks", "findings", "paragraphs"), want, got):
        if a != b:
            with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False, encoding="utf-8") as f:
                f.write(rebuilt)
            raise SystemExit(f"rebuilt page differs in {name} ({len(a)} vs {len(b)}); rebuilt copy at {f.name}")
    print(f"wrote {args.out}: {len(want[0])} hunks, {len(want[1])} findings, {len(want[2])} paragraphs match")


if __name__ == "__main__":
    sys.exit(main())
