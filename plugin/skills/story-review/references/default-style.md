# Default review style

The skill uses this file only when the reviewer has no style file of their own. To set your own,
copy this file to `~/.claude/story-reviews/style.md` and change anything in it. A team can also
commit shared conventions to `.claude/story-review-style.md` in the repository under review.

## What to look for

- Read every hunk, and the unchanged code it depends on.
- Check the PR description's claims against the code.
- Confirm each finding in the code before keeping it. Drop what you can't support.
- A problem the PR didn't cause is a follow-up, not a reason to block.

For a re-review, start a fresh agent rather than resuming the one that wrote the last review: prep
carries the change, the findings, and the line references forward, and a resumed agent re-reads its
whole earlier context every round.

## Severity

- **High:** wrong behavior or lost data in a realistic case.
- **Medium:** change before merge.
- **Low:** follow-up.
- **Nit:** style or wording.

## Findings

Give each finding a title that states the problem, a short body, and the text of a PR comment. Add
a failure scenario and a suggested fix when they help the author act on it. A review with no
findings is a fine outcome. Say so plainly.

## Chapters

Order chapters the way a reader needs to understand the change: the motivation first, then the
core logic, then what calls it, then tests and docs.

## Explaining

Keep each chapter's notes to the problem, the idea, and the example's values. Explain hard code
with a walkthrough: a numbered marker on the code and a short note beside it for each step, in the
order the code runs, each saying what the lines do and what the example holds at that point. Walk through branching
functions, loops that carry state, and lists that must line up. Skip code that reads at a glance.
Writing the steps is also the review: a step you can't explain plainly is where to look for a bug.

## Voice

- Plain, short sentences.
- Name code exactly, and give numbers instead of adjectives.
- Say what you didn't verify.

## Reading

Publish the page, or open it from disk, the way the skill's step 7 says.

## Lint

The build flags these in the page's prose. Each line is a regular expression and what it means.

- `—` an em-dash
