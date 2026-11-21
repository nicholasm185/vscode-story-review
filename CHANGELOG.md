# Changelog

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
