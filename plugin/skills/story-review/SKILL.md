---
name: story-review
description: Review a GitHub pull request as a story-order page, in the style of Devin Review. The page has chapters in reading order, diffs rendered from git, findings pinned to their lines with copy-as-PR-comment, a "checked and fine" list, and a file tree with per-file Viewed boxes that proves every hunk is on the page. Use it when the user asks to review a PR "as a story", for a "story review", for a review "like Devin review", or for the next PR in a stack.
---

# Story review

A story review is a page that walks a reviewer through one PR in the order a person needs to
understand it, not in file order. `scripts/build.py` builds the page from a hand-written template
plus the real diff from git, so hunks are never retyped and none can be skipped. The build then
checks the page in a headless browser, so you don't need screenshots.

This skill covers the flow and the page. What to look for, how to grade, how to order chapters, and
how to write come from the reviewer's **style** (see [Review style](#review-style)).

## Workflow

1. **Load the style** (see [Review style](#review-style)), and follow it for steps 3 and 4.
2. **Prep in one call:** `python3 -I ${CLAUDE_SKILL_DIR}/scripts/prep.py --repo <checkout> --pr <n>`.
   It fetches the PR's current head from GitHub (it never trusts a local branch), finds the merge
   base, writes `pr.json` and `meta.json` in the review folder, and keeps an earlier review of this
   PR whose head moved as `template-<head>.html`. It prints the PR, its place in the stack (and
   whether the stack needs a rebase), CI and reviews, every thread and comment, the earlier reviews
   whose PRs changed since (with their verdicts, findings, and `carry` notes), the body, the hunk
   map with each hunk's new-file lines, and the build command. Don't repeat those `gh` and `git`
   calls. Read code with `git show <head>:<path>`. Don't repeat a finding a thread already raised
   or fixed. Tell the user which reviewed PRs gained commits.
3. **Review** the way the style says.
4. **Grade findings** with the style's definitions. The page has four levels: `high`, `med`, `low`,
   and `nit`.
5. **Write `template.html`** in the review folder. Start from
   `${CLAUDE_SKILL_DIR}/assets/template-example.html`, which shows every part in the current format;
   see [Template](#template) and [Page shape](#page-shape). Don't read earlier reviews' templates to
   learn the format. Open one only to carry its cast of example names or a follow-up forward.
6. **Build** with the command prep printed. The build stops on a missing or repeated hunk, a pin or
   step that matches no shown line, or an unfilled placeholder. Otherwise it prints the verdict,
   each finding's `file:line` and chapter, and each chapter's blocks and walks, then checks the
   page: the style's Lint rules, unknown classes, unescaped tags, dead links, diagram labels that
   overflow, sideways scrolling on a phone, and walk notes pushed away from their lines. Fix every
   problem it lists and build again. Trust the report: don't grep `page.html` or take screenshots
   to check it. Take a screenshot only when a problem's message isn't enough to fix it. If the
   render check was skipped (no Chromium), say so in the reply.
7. **Show the page.**
   - If the style says the reader uses the Story Review VS Code extension
     (https://github.com/nicholasm185/vscode-story-review), don't publish unless they ask. The extension reads `page.html` from the review folder: tell them to run **Story Review:
     Open Review** and pick the PR, which also checks the PR out.
   - With an Artifact tool: publish `page.html`. On the first publish, pass `icon: "code"` and a
     one-sentence description, then write the URL into `meta.json`. To update, publish the same
     `file_path` again, or, from another session, pass `url` from `meta.json` (the tool makes you
     read the artifact first). The page is private until its owner shares it.
   - Without one: build with `--standalone` too and open `page.html` in a browser (`open`,
     `xdg-open`, or `wslview`). It needs no server.
8. **Reply in chat** with the verdict, the findings (severity and one line each), the link or path,
   and the PR's place in the stack. Don't post to GitHub unless the user asks; each finding has a
   "Copy as PR comment" button. After posting, set `"posted": true` in `meta.json`. Put anything
   the next review in the stack must check in `meta.json` as `"carry": ["..."]`; prep prints it.

## Review style

The style decides what the review says. The skill reads, in order:

1. `.claude/story-review-style.md` in the repository under review: team conventions, if the team
   committed one.
2. `~/.claude/story-reviews/style.md`: the reviewer's own style. Where it conflicts with the team
   file, it wins.

If neither exists, use [references/default-style.md](references/default-style.md), and say in one
line of the reply that the user can copy it to `~/.claude/story-reviews/style.md`.

A style can set anything about the content: what to check, the bar for keeping a finding, what each
severity means, which finding rows to fill, the chapter order, the voice, how to use reviewer
agents, and where the reader reads the page. A `## Lint` section of lines like ``- `regex` what it means`` becomes build checks on the
page's prose. A style can't change the page itself: the placeholders, the four severity keys, and
the build's checks stay as they are.

## Where files live

Each review lives in `~/.claude/story-reviews/<owner>-<repo>/pr-<n>/`: `template.html` (the source),
`page.html` (the build output), `pr.json` (from prep), and `meta.json`. In `meta.json`, prep writes
`repo`, `pr`, `base`, `head`, `reviewed`, and `previous`; the build writes `verdict` and
`findings`; you write `url`, `posted`, and `carry`. Never keep the only copy in a session
scratchpad. It can be wiped mid-session.

If a template is lost, get the page's HTML (the local `page.html`, or an Artifact `action: "read"`
of the published page, which saves the full HTML), then run
`python3 -I ${CLAUDE_SKILL_DIR}/scripts/recover_template.py --repo <checkout> --base <sha> --head <sha> --page <saved.html> --out template.html`.

## Template

Write only what's yours: the eyebrow, the `h1`, the PR title, the stack strip, the explainer, the
verdict prose, the checked list, the chapters, and the findings. The build writes the rest.

| Placeholder | Becomes |
|---|---|
| `<!--@style-->`, `<!--@script key="pr1234"-->` | The CSS and the page script. The key namespaces the viewer's saved checkmarks. |
| `<!--@toc-->`, `<!--@findings-->`, `<!--@files-->` | The rail: chapters, findings by severity, and the file tree with Viewed boxes. |
| `<!--@meta-->`, `<!--@findings-table-->` | The header chips from `pr.json`, and the verdict's findings table. |
| `<!--@diff file="P" hunks="all\|0,2" walk="w1"-->` | Those hunks of P (indexes from prep's hunk map), with a Viewed box. |
| `<!--@context file="P" from="…" to="…" note="…"-->` | Unchanged lines at head that prove a point. |
| `<!--@finding f1 sev="med" cat="…" short="…" at="…"-->`, `<h4>` and body, optional `<!--@scenario-->`, `<!--@fix-->`, `<!--@comment-->`, then `<!--@end-->` | A finding card under the line whose text contains `at=`, in the diff or context block just before the finding. `pin="LINE:f1"` on that block still works. |
| `<!--@walk w1-->`, then `<!--@step at="…" to="…"-->` and its HTML per step, then `<!--@end-->` | A walkthrough of the block that has `walk="w1"`: a numbered marker on each step's first line and its note in the side column. |
| `<!--@flow caption="…"-->`, its lines, then `<!--@end-->` | A diagram of boxes and arrows that can't overflow (syntax below). |

- **Finding lines by text.** `at=`, `from=` and `to=` match part of one line, so you don't need line
  numbers. Pick a fragment that occurs once in the block (or, for `from=`, once in the file). `to=`
  is the first line at or after the start that contains its text, or `+N` lines. Line numbers still
  work (`<!--@step 12-14-->`, `from="40"`). Write `&quot;` for `"` and `&gt;` for `>` inside them.
- **Steps** run top to bottom without overlapping, each within one shown hunk. A step that starts
  at an added line also covers the removed lines just above it. Step `n`'s note has the anchor
  `#w1-n`. `table.trace` (three columns at most, `tr.pick` on the winning row) shows a loop pass by
  pass.
- **Generated for you:** a finding with no `<!--@comment-->` gets a PR comment built from its title,
  body, scenario, and fix. A chapter with no `files-in` line gets one listing its diff files. In a
  `details.more` summary, `{n}` becomes its hunk count. Each chapter's "Chapter N of M" bar and
  read toggle, the verdict label, and the closing card are built too.
- **Text:** backticks in prose become `<code>`, except inside `pre`, `script`, `code`, and comments.
  Escape `<`, `>` and `&` in HTML text. Text in `<!--@comment-->` stays raw Markdown.

Flow syntax, one item per line:

```
box: Title | a line | another line      a box; after "box", states: hot, blocked, open, chip, faded
-> label                                an arrow to the next box; "=> label" is highlighted, "--" draws none
  all full -> box blocked: Title | line indented: a branch under the box above it
```

`dir="down"` on the flow stacks the boxes. On a phone every flow stacks. Use hand-drawn SVG
(`figure > div.dg-wrap > svg.dg`, styled only with the `.dg` classes in `base.css`, with unique
marker ids) only for a picture that isn't boxes and arrows. The render check measures its labels.

## Page shape

- **Header:** an eyebrow (repo, PR number, work item, date), an `h1` that says what the PR does as a
  plain sentence, the exact PR title, the stack strip (link the earlier reviews), and `<!--@meta-->`.
- **Explainer** (optional, before the verdict): `section.explain` with an `id`, an `h2`, `h3`s, and a
  flow, a before/after `table.combos`, or worked examples. Use it when the PR changes behavior a
  reader must picture.
- **Verdict:** `div.label` "Verdict" and an `h2` with one of "Approve", "Approve after N changes", or
  "Request changes", a few sentences, then `<!--@findings-table-->`.
- **Checked and fine:** what was verified, one topic per `li`. Use `li.no` for what you couldn't
  confirm; the build moves those to the top.
- **Chapters,** in the order the style gives: `section.chapter` with an `id`, an `h2`, a one-sentence
  `p.lede`, then notes followed by the diffs they explain. The build pairs each run of notes with
  the diffs after it into a step, and on wide screens the notes stick beside their code. Put a walk
  and a finding right after the diff they belong to. In a step with a walk, keep the notes before
  the diff short: they share the side column with the step notes and push them down.
- **Routine hunks** go in a `details.more` whose summary counts them with `{n}`, such as signature
  updates and mechanical test changes. Every hunk still appears exactly once.
- **Components** in `base.css`: `.note` with `.tag.ok` or `.tag.info`, `.routes`, `.flow` (numbered
  request steps with `.k.sub` and `.k.ret` chips), `pre.formula`, `table.combos`, `pre.sugg` (fix
  sketches), `table.trace`, and `.stack`.

## More

- [references/page-features.md](references/page-features.md): what a reader can do on the page
  (navigation, progress, view buttons, keys, copying). Read it only to answer a question about them.
- [references/maintaining.md](references/maintaining.md): changing `base.css`, `page.js`, or
  `build.py`, and checking the change. Read it only when changing the format.
