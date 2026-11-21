# Changelog

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
