# Changelog

## 0.4.4

- The `story-review` skill now lives in this repository under `plugin/`, and the repository is a
  Claude Code plugin marketplace, so anyone can install the skill with
  `/plugin marketplace add nicholasm185/vscode-story-review`. `npm run fixture` builds with that
  copy, and CI fails when the committed fixture page no longer matches it.

## 0.4.3

- Closing a review by accident no longer means picking it again. The Story Review view offers
  **Reopen Last Review** for the review last opened on the branch now checked out, and names it in
  the Chapters header. Open Review lists that review first. A detached checkout is remembered by
  its commit.

## 0.4.2

- Hovers come sooner. The page asks the language server as soon as the pointer settles on a name,
  then shows the card after `editor.hover.delay`, so the server's time overlaps the wait. Moving
  within the same name no longer restarts the wait, and a name you've already hovered answers at
  once until a file in the worktree changes.
- The hover card looks like the editor's: VS Code's hover colours, fonts and row borders, code
  coloured by your theme, and above the line unless `editor.hover.above` is off.
- Each hover's time is logged to the Story Review output channel, split into opening the file,
  the language server and rendering.

## 0.4.1

- VS Code's own themes are bundled, so Dark 2026, Light 2026, Dark Modern, Dark+, the Visual Studio
  themes and the high contrast ones colour code exactly as the editor does. Before, Dark 2026 fell
  back to Dark Modern's colours.
- `storyReview.colorTheme` picks the theme for code colours: a theme name, or the path to any
  theme's `.json` file (comments and `include` work). Changing it recolours an open review.

## 0.4.0

- Code on the page takes the colours of your VS Code theme. Every line is tokenized from the whole
  file at the base or head commit, using the same TextMate grammars as the editor, and added and
  unchanged lines also get the language server's semantic colours. Colours are CSS highlights, so
  hover, definitions and the page's word marks are unchanged.
- About 65 themes are bundled, including Dark Modern, Light Modern, GitHub, One Dark Pro, Monokai,
  Solarized, Dracula and Catppuccin. Others fall back to Dark Modern or Light Modern.
- The extension is now bundled with esbuild into one file.

## 0.3.4

- The test starts Chrome reliably in CI: it prefers Google Chrome over the `chromium` snap wrapper,
  runs without the sandbox in CI, and prints the browser's output when it doesn't start.
- Pushing a tag again updates its release's `.vsix` instead of failing.
- The first release with the 0.3.3 changes. The `v0.3.3` tag has no release, because its test
  failed in CI.

## 0.3.3

- The test runs against a made-up review bundled in `test/fixture`, so it needs no other checkout,
  finds Chrome or Chromium itself, and runs in CI before packaging. `npm run fixture` rebuilds the
  fixture page with the `story-review` skill.
- MIT license.

## 0.3.2

- The page's own contents column never shows in VS Code. Hiding it on the page and then showing VS
  Code's side bar no longer squeezes the page into a narrow column.
- A keyboard button in the Chapters view lists the shortcuts and turns single-key shortcuts on or
  off, since the page's own shortcuts box lived in the hidden column.

## 0.3.1

- File names at the top of each diff, and in the Notes view, open the file beside the review.
- A checkout is found through any remote, so a fork with an `upstream` remote works. A repository
  whose name only starts the same, such as `app-docs` for `app`, no longer matches.
- A missing GitHub CLI gets a message that says where to install it.
- `npm run package` writes `dist/story-review-<version>.vsix`, `npm run install-vsix` installs it,
  and a GitHub workflow packages tags as releases.

## 0.3.0

- Opening a review checks out the pull request with `gh pr checkout`, after asking. It replaces the
  review worktree that reset files to the reviewed head.
- Viewed marks sync with the pull request's per-file Viewed state on GitHub.

## 0.2.0

- Chapters, findings and files in a Story Review side bar view, and a Notes view for the code in
  view. The page drops its own contents and notes while those views are open.

## 0.1.0

- The review page in a VS Code panel, with hover, go to definition and find references on the diff,
  line numbers that open the file beside it, and progress kept per review.
