# Story review skill

A skill for Claude Code that reviews a GitHub pull request as a page that reads in the order you
need to understand the change, not in file order. The page has:

- chapters with the real diff from git, so every hunk is on the page exactly once;
- findings pinned under their lines, each with a "Copy as PR comment" button;
- a "Checked and fine" list, a verdict, and a stack strip for stacked pull requests;
- walkthroughs for the hard code: numbered markers on the lines, with a short note beside each
  one in the side column;
- a file tree with Viewed boxes, and keyboard shortcuts (j/k files, n/p findings, v Viewed);
- view buttons that hide the contents or the notes, show the diff side by side, or hide the
  walkthrough (keys c, t, s and w).

## Install

In Claude Code:

```
/plugin marketplace add nicholasm185/vscode-story-review
/plugin install story-review@story-review
```

To update later, run these in a shell, then restart Claude Code:

```sh
claude plugin marketplace update story-review
claude plugin update story-review@story-review
```

Without the plugin system, copy the skill folder into your personal skills instead:

```sh
git clone https://github.com/nicholasm185/vscode-story-review
mkdir -p ~/.claude/skills
cp -r vscode-story-review/plugin/skills/story-review ~/.claude/skills/
```

Install it one way, not both: with both, Claude Code lists two `story-review` skills.

## Requirements

| What | Why |
| --- | --- |
| `git` and Python 3.9 or later | Prep and build read the diff from git. The scripts use only the standard library. |
| GitHub CLI (`gh`), signed in | Prep reads the pull request, its stack, threads and CI. |
| A local checkout of the repository | The build renders hunks from its commits. |
| Node.js 22 or later, and Chrome or Chromium | Optional. The build's render check uses them, and is skipped without them. Set `STORY_REVIEW_CHROME` to pick the browser. |

## Use it

Ask Claude for a "story review of PR 1234", or run `/story-review:story-review 1234` (or
`/story-review 1234` for a copied skill). For a stack, ask for "the next PR in the stack".

With the Artifact tool, the page is published as a private claude.ai page. Without it, the page
opens from disk. To read reviews in VS Code with hover and go to definition on the diff, install the
Story Review extension from this repository (see the [main README](../README.md)), and say so in
your style's `## Reading` section (see below).

## Set your review style

The skill decides the flow and the page. Your style decides what the review checks and how it
reads: what to look for, what each severity means, the chapter order, the voice, and where you
read the page.

1. Start from the default style:

   ```sh
   mkdir -p ~/.claude/story-reviews
   curl -fsSL https://raw.githubusercontent.com/nicholasm185/vscode-story-review/main/plugin/skills/story-review/references/default-style.md \
     -o ~/.claude/story-reviews/style.md
   ```

2. Edit it. Anything you write there applies to your next review.

To read reviews in the Story Review VS Code extension instead of as published pages, set the
style's `## Reading` section to:

```markdown
## Reading

I read reviews in the Story Review VS Code extension. Don't publish the page unless I ask; tell me
to open it with **Story Review: Open Review**.
```

A repository can also commit team conventions to `.claude/story-review-style.md`. Your own file
wins where the two disagree. With neither file, the skill uses the default style.

## Where reviews are kept

Each review lives in `~/.claude/story-reviews/<owner>-<repo>/pr-<n>/`: the template, the built page,
the pull request's metadata, and `meta.json` with the verdict, the findings and the published link.
