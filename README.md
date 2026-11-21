# Story Review for VS Code

Read a story review page inside VS Code, next to the pull request's real code. The page keeps its
chapters, walkthroughs and Viewed boxes, and the code on it gets your editor's language features:
hover a name for its type and docs, ⌘-click to go to its definition, ⇧⌘-click to find references.

The pages come from the `story-review` skill for Claude Code. This extension doesn't write reviews;
it opens the ones the skill builds. In Claude Code, install the skill with
`/plugin install story-review@claudeai-organization-library` if your organization publishes it.

## What you get

- **The review in an editor tab.** The page you'd publish, rendered in a panel.
- **Language features on the diff.** Hover, go to definition (⌘ or Ctrl-click) and find references
  (⇧⌘ or ⇧Ctrl-click) work on added and unchanged lines. Removed lines have no file to ask about.
- **Code beside the review.** Clicking a line number or a file name opens that file in an editor
  next to the panel. ⌥-click on a line number copies `path:line` instead.
- **Contents in the side bar.** The Story Review view lists the chapters (with read marks), the
  findings, and the files (with Viewed marks). Clicking an item moves the page there. The page's own
  contents column stays hidden in VS Code.
- **Keyboard shortcuts.** The keyboard button in the Chapters view lists the page's keys and mouse
  actions, and turns the page's single-key shortcuts on or off.
- **Notes in the other side bar.** The Notes view shows the prose and walkthrough notes for the code
  in view. Hovering a note lights its lines on the page.
- **Viewed marks synced with GitHub.** Ticking a file marks it viewed on the pull request's Files
  tab, and marks you make on GitHub show up on the page.
- **The real branch.** Opening a review checks out the pull request with `gh pr checkout`.

## Requirements

On the machine where your code lives (for Remote-SSH or WSL, that's the remote machine):

| What | Why |
| --- | --- |
| VS Code 1.90 or later | The extension API it uses. |
| `git` | Finds your checkout and reads its state. |
| GitHub CLI (`gh`), signed in with `gh auth login` and the `repo` scope | Checks out the pull request and syncs Viewed marks. |
| A checkout of the repository the review is for | The language features read its files. Any remote may point at the repository, so a fork with an `upstream` remote works. |
| The language extension for the code, such as Go with `gopls` | Hover and definitions come from it. |
| Reviews built by the `story-review` skill, version 1.1 or later | The extension reads the page's markup. Tested with 1.2. |
| Node.js 20 or later, to build | Only for building the package. Tested with Node 24 on Linux; building on Windows itself is untried. |

The extension also uses two extensions that ship with VS Code: Markdown Language Features (renders
hover text) and Reference Search View (lists references). Leave them enabled.

## Install

To give the extension to someone, hand them the `.vsix` file from `dist/`; they install it with the
last step below or from the Extensions view. To build it yourself, build the package, then install it
into the VS Code that runs next to your code:

```sh
npm ci
npm run package        # writes dist/story-review-<version>.vsix
npm run install-vsix   # installs the newest package in dist/
```

Run `npm run install-vsix` in a VS Code terminal when you can. There, `code` is the CLI of that
window, so a Remote-SSH or WSL window gets the extension on the remote side, where it has to run.
Outside VS Code, the script uses the newest VS Code server in `~/.vscode-server`, then any `code`
on your `PATH`. To pick the CLI yourself, set `VSCODE_CLI`.

You can also install the `.vsix` from the Extensions view: **⋯ > Install from VSIX…**, in a window
connected to the machine that has your code.

After installing, run **Developer: Reload Window**.

## Set up, once

1. **Sign in to GitHub on the code's machine.** Run `gh auth status`. If it isn't signed in, run
   `gh auth login` and include the `repo` scope.
2. **Open your checkout as the window's folder.** The extension looks for a workspace folder with a
   remote that points at the review's repository.
3. **Move the Notes view to the right.** It starts in the bottom panel under **Review Notes**. Drag
   its tab to the secondary side bar. VS Code remembers where you put it.
4. **Point the extension at your reviews, if they live elsewhere.** It reads
   `~/.claude/story-reviews` by default. See [Settings](#settings).

## Review a pull request

1. Build a review with the `story-review` skill. It writes `page.html` and `meta.json` to
   `~/.claude/story-reviews/<owner>-<repo>/pr-<n>/`.
2. In VS Code, run **Story Review: Open Review** (or click the book in the Story Review view) and
   pick the review.
3. If your checkout isn't at the reviewed commit, the extension asks before it runs
   `gh pr checkout <n>`. It stops instead if you have uncommitted changes. When the pull request's
   branch is already checked out in another worktree, it checks the pull request out as
   `review/pr-<n>`.
4. If the pull request has commits after the reviewed one, the extension tells you, and offers to
   check out the reviewed commit so the page's lines match the files.

The first hover in a session can take a few seconds while the language server loads the workspace.

## Viewed marks and GitHub

GitHub's per-file **Viewed** state is the record. When a review opens, and when you come back to its
panel, the page takes your Viewed marks from GitHub. Ticking or unticking a file on the page, in the
Files view, or with the page's `v` key writes the change back.

- Viewed marks on GitHub are yours alone. The author and other reviewers don't see them.
- A tick you made in the last 10 seconds wins over a read from GitHub, so a refresh can't undo it.
- The first time a review syncs, files you had already marked viewed on the page are marked on
  GitHub, not cleared.
- A file split across chapters counts as viewed on GitHub once every part is ticked.
- When a file changes after you viewed it, GitHub clears the mark, and the Files view says the file
  changed since you viewed it.
- Chapter read marks stay in VS Code. GitHub has nothing to sync them with.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `storyReview.reviewsRoot` | `~/.claude/story-reviews` | The folder that holds `<owner>-<repo>/pr-<n>/` review folders. |

## Troubleshooting

- **"GitHub CLI (gh) isn't on the PATH where this extension runs".** Install `gh` on the machine
  that has your code, not only on the machine with the VS Code window, and sign in there.
- **"Couldn't read Viewed marks from GitHub" in the status bar.** Run `gh auth status` on the code's
  machine. The token needs the `repo` scope.
- **The extension asks you to open a checkout.** None of the window's folders has a remote that
  points at the review's repository. Open the right checkout, or add the repository as a remote.
- **Hover shows nothing.** Check that the language extension works in an ordinary editor tab first.
  Hover only works on added and unchanged lines.
- **Line numbers land on the wrong lines.** The checkout isn't at the reviewed commit. Open the
  review again and accept the checkout, or check out the commit in `meta.json`'s `head`.

## Develop

```sh
npm ci
npm run watch          # compile on save
npm run release        # package and install in one step
```

`npm test -- <review folder> <checkout> <chromium>` loads a built page with the page-side scripts and
a stand-in for VS Code in headless Chromium, and checks the messages they send. Its constants are
pinned to one review and its files, so edit them to run it against another review.
`SHOTS=1` also writes screenshots to `test-out/`. The extension host side (language features,
checkout, GitHub calls) has no automated test; try it in VS Code.

Pushing a `v*` tag runs `.github/workflows/build.yml`, which packages the extension and attaches the
`.vsix` to a GitHub release. Every push to `main` keeps the package as a workflow artifact.

### How it fits together

- `src/extension.ts`: the Open Review command, the checkout, the review panel, language features
  for the page, and the GitHub Viewed sync.
- `src/views.ts`: the Chapters, Findings and Files trees, the Notes view, and the hub that passes
  messages between them and the panel.
- `media/bridge.js`: runs in the review panel. It keeps the page's progress in extension storage,
  maps a pointer on the diff to a file position, and reports the page's outline, current chapter
  and notes.
- `media/notes.js`: runs in the Notes view.

### The page contract

The extension reads the markup the `story-review` skill writes. If the skill's format changes, keep
these working or update `media/bridge.js`:

- `[data-file]` on each file block, and `table.diff` rows with the new-side line number in the
  second cell. In split view, the new-side line cell has the class `nl`.
- `.file-h .path` for a file block's name.
- `#toc > li` with `a .n`, `a .t` and `.dot.s-<severity>`, and `li.current` on the chapter in view.
- `.seen-toggle input[data-ch]` for chapter read marks.
- `.rail .fl a` with `.sev.s-<severity>`, and `.ftable` rows with `.loc`, for findings.
- `.ftree li.tfile[data-path]` with `is-viewed` and `is-partial`, its checkbox, and `.fcount`.
- `.viewed-toggle input[data-path]` on file headers.
- `.step`, `.step.solo`, `.step-notes`, `.notes-in`, `.notes-ch`, `.wcol`, and `.wnote` and `.wmark`
  with `data-ws` for walkthrough steps.
- `localStorage` keys the page's script writes. The extension stores them per review.
- A `<script data-key>` page script, and `<style>` as the first style block (the Notes view reuses it).
