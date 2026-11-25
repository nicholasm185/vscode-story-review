# Story review format history

- 2026-11-18: first version, from three real reviews. It has
  chapters, pinned findings with copy-as-PR-comment, a checked-and-fine list, a stack strip, and
  chapter read marks.
- 2026-11-18: file checklist with per-file Viewed boxes, part tags for split files, and a hunk
  coverage line. The build fails on missing or repeated hunks. Added `recover_template.py`, and
  non-Markdown files render in monospace with word-level diffs.
- 2026-11-18: the checklist became a file tree. Single-child folders are merged into one row, each
  folder shows its viewed count and turns green when done, and folders can be collapsed. The rail
  is 260px wide.
- 2026-11-18: steps. The build pairs each run of chapter notes with the diffs after it, and on wide
  screens the notes stick in a right-hand column, so a chapter reads without scrolling back up.
  File headers are sticky too (`.file` uses `overflow: clip`, since `hidden` would stop the header
  sticking). Generated wrappers carry `data-gen` and close with `<!--/gen-->`, so
  `recover_template.py` can flatten them again.
- 2026-11-18: compact templates, to cut tokens per review. The build now generates the header
  chips (from `pr.json`), the rail's chapter and findings lists, the verdict table, the chapter
  heads, and the finding cards (from `<!--@finding … sev= cat= short=-->` with scenario, fix and
  comment sections), and turns backticks in prose into code. Markup was about 45% of a
  hand-written template. Added "Copy path" in file headers and `path:line` copy on line numbers.
- 2026-11-18: `.flow` and `.checked` list items place their number or check mark with absolute
  positioning, not a two-column grid. In a grid, an item with bare text and inline `<code>` split
  every text run and code span into its own cell, one per line. Any markup now works inside them.
- 2026-11-18: explainer section (`section.explain`) before the verdict, for data flow diagrams,
  before/after tables and worked examples, with theme-aware `.dg` SVG classes.
- 2026-11-18: refinements from an `/impeccable critique` (26/40). Viewed per part; GitHub links;
  wrapped code hangs under its own indent (leading whitespace becomes `data-ind` padding); the
  verdict heading carries the decision in colour; unverified checks lead the checked list; finding
  titles are `h3`; added/removed lines are announced to screen readers; a skip link, a current-chapter
  highlight in the rail, remembered "Copied" state, and a collapsed file list on narrow screens;
  line-number and comment contrast, 11.5px minimum in the file tree, a 62ch prose measure, and a
  wider code column at 1360px and up.
- 2026-11-18: keyboard shortcuts (j/k, n/p, v) with an off switch, and a closing card that tracks
  what's left. "Mark as read" and "Viewed" stay independent, and notes stay on the right, by the
  user's choice.
- 2026-11-18: part links for split files, in the rail and in each part's header. The closing card
  links a partly viewed file to its first unviewed part. The rail's Keys box is now
  `div.shortcuts`, because `.flow` uses `div.keys` for key chips and the build skipped the box
  in one review.
- 2026-11-18: the skill covers only the flow and the page. What to look for, severity meanings,
  finding rows, chapter order, and voice moved to a style file: the repository's
  `.claude/story-review-style.md`, then the reviewer's `~/.claude/story-reviews/style.md`, with
  `references/default-style.md` as the fallback. Paths use `${CLAUDE_SKILL_DIR}`, the build has
  `--standalone` for viewing without an Artifact tool, and this history moved out of SKILL.md.
- 2026-11-19: view controls. Three buttons at the top of the rail, with keys c, t and s, hide the
  rail, hide the notes column, and switch the diffs to a split view. `page.js` builds the split
  tables in the browser from the unified rows, so templates, the build's checks and
  `recover_template.py` are unchanged. The choices are remembered per viewer, and the reading
  position is kept when the layout changes. Split needs a 900px code column and falls back to
  unified below that. Also fixed the indent of tab-indented code: tabs kept their tab stops at
  `font-size: 0`, so each level drew about 8 columns, not 4, and a long first word wrapped to the
  second line.
- 2026-11-19: the chapter bar ("Chapter N of M" and "Mark as read") sticks for the whole chapter,
  above the file headers, and shows the chapter title once the heading scrolls under it. File
  headers and the notes column sit 34px lower inside a chapter (`--chh`). The label above each
  notes block is hidden, since the bar now says the same thing. The collapsed rail keeps the
  reading list as a column of chapter numbers. Both are CSS and `page.js` only.
- 2026-11-19: walkthroughs. A `<!--@walk id-->` block of `<!--@step LO-HI-->` steps, attached with
  `walk="id"` on a diff or context block, renders each step as a numbered row right above the lines
  it explains, with a bar down the lines it covers (`tr.walk`, `tr.ws`). A step that starts at an
  added line also covers the removed lines just above it. `table.trace` shows a loop pass by pass.
  The build fails on overlapping steps, steps outside the shown lines or across hunks, and unused
  walks. Split view keeps each step above its paired line, a Steps button and the `w` key hide the
  walkthrough, and `recover_template.py` recovers walks. The user found the notes column too far
  from the code to help, so the reviewer's style now makes the walkthrough the main explanation and
  keeps notes to the question, the idea, and the example's values.
- 2026-11-19: walkthrough steps moved out of the diff. The user found rows between code lines too
  distracting, so a step is now a small numbered marker at the end of its first line, and its note
  sits in the side column, level with the marker (`page.js` lays the notes out and pushes one down
  only when the note above needs the room). Hovering a note or marker highlights the step's lines,
  and clicking a note's number scrolls to them. In a step with a walkthrough the chapter notes stop
  sticking. Below 1360px the notes are a list above the code. Steps and `w` still hide it all. Steps
  are written as one or two plain sentences.
- 2026-11-20: fewer tokens and no screenshots per review. An audit of four reviews found 23-32% of
  each review's model calls went to running the skill (setup, line numbers, peeking at old
  templates, grepping the page, screenshots). `scripts/prep.py` does the setup in one call (PR,
  stack, threads, CI, earlier reviews that changed, hunk map, `pr.json`, `meta.json`). Findings
  (`at=`), steps (`at=`/`to=`) and context blocks (`from=`/`to=`) can name a line by its text, so
  no line numbers are looked up and a rebuild survives a rebase. The build prints a report
  (verdict, findings with `file:line`, chapters, walks), fills `{n}` in collapsed summaries, writes
  `files-in` lines and default PR comments, records `verdict` and `findings` in `meta.json`, and
  runs checks: the style's `## Lint` rules, unknown classes, unescaped tags, dead links, and
  `scripts/check.mjs` in headless Chromium (diagram labels, sideways scroll, walk notes pushed
  from their lines, script errors, and a self-test of the step highlight). `<!--@flow-->` draws
  box-and-arrow diagrams in HTML that wrap instead of overflowing and stack on a phone. Fixed: in
  split view a step's highlight missed every changed line (the split cells' `background` shorthand
  cleared it) and its bar sat on the old side; now each half the step covers lights with its own
  bar. SKILL.md moved the reader features and maintenance notes to `references/`.
- 2026-11-21: the Story Review VS Code extension. Step 7 skips the Artifact publish when the style
  says the reader uses the extension, and `maintaining.md` points at the extension's page contract.
  Fixed: the render check reported "marks no cells in split view" for a walkthrough on a new or
  deleted file, which split view keeps single-column; it now checks that file's unified rows.
- 2026-11-23: plugin 1.2.0. The skill ships from https://github.com/nicholasm185/vscode-story-review
  as a Claude Code plugin marketplace, so it no longer depends on an organization's plugin library.
  The default style gained a `## Reading` section, and `maintaining.md` gained the release steps.
- 2026-11-24: plugin 1.3.0, re-reviews. Prep now prints what changed since the last review: the
  commits, the files whose own change differs, and the earlier findings at their new lines. It
  moves the carried template's `file:N` references and flow-map `:N` keys to the new head and lists
  the ones whose lines changed. In #4032's seven re-reviews, the agent shifted 12 to 33 of these by
  hand each round. The build stamps the page with the base and head it was built from, for the
  extension's checkout check. SKILL.md has a Re-review section, and `fixed` and `accepted` are
  `meta.json` keys.
