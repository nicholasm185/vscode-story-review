"""Usage: python3 -I test/carry_test.py. Checks that prep moves a template's line references to a new head."""

import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "plugin/skills/story-review/scripts"))
from prep import LineMap, carry_line_refs  # noqa: E402

results = []


def check(name, ok, detail=""):
    results.append(f"{'PASS' if ok else 'FAIL'} {name}{': ' + str(detail) if detail else ''}")


def git(cwd, *args):
    return subprocess.run(["git", "-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t", *args],
                          cwd=cwd, capture_output=True, text=True, check=True).stdout.strip()


with tempfile.TemporaryDirectory() as tmp:
    repo = Path(tmp)
    git(repo, "init", "-q")
    (repo / "pkg").mkdir()
    lines = [f"line {i}" for i in range(1, 41)]
    (repo / "pkg/a.go").write_text("\n".join(lines) + "\n")
    (repo / "pkg/same.go").write_text("x\n" * 30)
    git(repo, "add", ".")
    git(repo, "commit", "-q", "-m", "old")
    old = git(repo, "rev-parse", "HEAD")
    # Three lines added above line 10, and line 30 rewritten.
    new_lines = lines[:9] + ["new a", "new b", "new c"] + lines[9:29] + ["line 30 changed"] + lines[30:]
    (repo / "pkg/a.go").write_text("\n".join(new_lines) + "\n")
    git(repo, "commit", "-q", "-am", "new")
    new = git(repo, "rev-parse", "HEAD")

    template = "\n".join([
        "<p>Before the insert (`a.go:5`), after it (`a.go:20-22`), and on the rewrite (`pkg/a.go:29-31`).</p>",
        "<p>An unchanged file keeps its numbers (`same.go:12`), and so does a host (`example.com:443`).</p>",
        "<!--@context file=\"pkg/a.go\" from=\"15\" to=\"18\"-->",
        "<li><b>Stage</b><div>a.go</div>",
        '<div class="keys"><span class="k">:20</span> a call</div></li>',
        '<li><div>same.go</div><div class="keys"><span class="k">:20</span> untouched</div></li>',
    ])
    lm = LineMap(str(repo), old, new, ["pkg/a.go", "pkg/same.go"])
    text, moved, checks, unsure = carry_line_refs(template, lm)

    check("a line above the insert stays", "`a.go:5`" in text)
    check("a range below the insert moves by three", "`a.go:23-25`" in text, text.splitlines()[0])
    check("a range over the rewritten line moves and is flagged", "`pkg/a.go:32-34`" in text and any("pkg/a.go:29-31" in c for c in checks), checks)
    check("an unchanged file and a host name stay", "`same.go:12`" in text and "example.com:443" in text)
    check("directives are left alone", 'from="15" to="18"' in text)
    check("a flow-map key moves with its stage's file", '<div>a.go</div>\n<div class="keys"><span class="k">:23</span>' in text, text.splitlines()[4])
    check("a flow-map key in another file's stage stays", '<div>same.go</div><div class="keys"><span class="k">:20</span>' in text)
    check("only the rewrite is flagged", len(checks) == 1 and not unsure, (checks, unsure))
    check("the report counts the moves", len(moved) == 2, moved)

print("\n".join(results))
failed = sum(r.startswith("FAIL") for r in results)
print(f"{len(results) - failed}/{len(results)} passed")
sys.exit(1 if failed else 0)
