# Changing the format

Edit `assets/base.css`, `assets/page.js`, or `scripts/build.py`, then check the change in this order.

1. **Old templates still build the same.** Before the change, build every template in
   `~/.claude/story-reviews/*/pr-*/` (and their `v*/` folders) into a scratch folder with
   `--no-check`. After it, build them again and compare the pages with the `<style>` and `<script>`
   blocks removed. Only the changes you meant should show. A template from an earlier format must
   keep building: the build accepts the hand-written scaffolding older templates have.
2. **The render check passes** on a few pages, including one with walkthroughs and one with a flow:
   build without `--no-check`. `scripts/check.mjs` also lights the first walkthrough step in unified
   and split view and fails if its lines don't change colour, so a `page.js` or `base.css` change
   that breaks the step highlight shows up there.
3. **Recovery round-trips:** run `scripts/recover_template.py` on a built page and confirm it
   reports matching hunks, findings, and paragraphs.
4. Rebuild the existing reviews from their templates and republish them to the same URLs, if the
   user wants the published pages updated. Add a line to [../CHANGELOG.md](../CHANGELOG.md).

## Couplings to keep

- `page.js` builds the view buttons and the split tables in the browser from the unified
  `table.diff` rows the build writes: `tr.ctx`, `tr.add`, `tr.del` with four cells, and `tr.pin`
  under its line. A row a walkthrough step covers has `data-ws="walk-n"`, and the step's first line
  holds an `a.wmark` in its code cell. In split view `data-ws` moves onto the cells of the half the
  step covers. If you change the row markup in `build.py`, change `splitTable` to match.
- Generated wrappers carry `data-gen` and close with `<!--/gen-->`, so `recover_template.py` can
  flatten them. Markup a template author writes, such as a flow's HTML, must not use `data-gen`.
- `base.css` is inlined into the page, so a comment in it must not contain a placeholder such as
  `<!--@flow-->`: the build would report it as unfilled.
- `check.mjs` copies the page beside the output, not into `/tmp`, because snap Chromium has a
  private `/tmp` and would load a blank page. It refuses to pass a page that didn't load.

- The Story Review VS Code extension (https://github.com/nicholasm185/vscode-story-review, the
  repository this skill ships from) reads the page's markup. Its README's "The page contract"
  section lists the classes, attributes and storage keys it relies on. Keep them, or change the
  extension's `media/bridge.js` in step.

## Releasing

The skill's source is `plugin/skills/story-review/` in that repository, which is also a Claude Code
plugin marketplace. After a format change, run `npm run fixture` and `npm test` there: the
extension's test reads a page this skill built, so a broken contract fails it. Then bump `version`
in `plugin/.claude-plugin/plugin.json`, add a line to the CHANGELOG, and push. Users pick the new
version up with `claude plugin marketplace update story-review`, then
`claude plugin update story-review@story-review`, and a restart of Claude Code.
