import { execFile } from "child_process";
import * as os from "os";
import { promisify } from "util";

const run = promisify(execFile);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", cwd, ...args], { maxBuffer: 64 << 20 });
  return stdout;
}

async function gitOk(cwd: string, ...args: string[]): Promise<boolean> {
  try {
    await run("git", ["-C", cwd, ...args]);
    return true;
  } catch {
    return false;
  }
}

export async function gh(cwd: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await run("gh", args, { cwd, maxBuffer: 64 << 20 });
    return stdout;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`GitHub CLI (gh) isn't on the PATH where this extension runs (${os.hostname()}). Install it there and run gh auth login.`);
    }
    throw e;
  }
}

export function errText(e: unknown): string {
  const any = e as { stderr?: string; message?: string };
  return (any.stderr || any.message || String(e)).trim().split("\n").slice(-2).join(" ");
}

/** Where a worktree's HEAD stands against the commit a review page was built from. */
export type Place =
  | { kind: "at"; now: string }
  | { kind: "behind"; now: string; commits: number }
  | { kind: "ahead"; now: string; commits: number }
  | { kind: "apart"; now: string; branch: string };

export async function placeOf(wt: string, head: string): Promise<Place> {
  const now = (await git(wt, "rev-parse", "HEAD")).trim();
  if (now === head) return { kind: "at", now };
  const count = async (range: string) => Number((await git(wt, "rev-list", "--count", range)).trim());
  if (await gitOk(wt, "merge-base", "--is-ancestor", now, head)) return { kind: "behind", now, commits: await count(`${now}..${head}`) };
  if (await gitOk(wt, "merge-base", "--is-ancestor", head, now)) return { kind: "ahead", now, commits: await count(`${head}..${now}`) };
  return { kind: "apart", now, branch: (await git(wt, "branch", "--show-current")).trim() };
}

/** One sentence for the side bar, or undefined when the checkout is the reviewed code. */
export function placeNote(p: Place, head: string): string | undefined {
  const s = (n: number) => (n === 1 ? "" : "s");
  switch (p.kind) {
    case "at":
      return undefined;
    case "behind":
      return `The checkout is ${p.commits} commit${s(p.commits)} behind the review (${p.now.slice(0, 7)}, review at ${head.slice(0, 7)}).`;
    case "ahead":
      return `The checkout has ${p.commits} commit${s(p.commits)} the review doesn't cover (review at ${head.slice(0, 7)}). A re-review would cover them.`;
    case "apart":
      return `The checkout${p.branch ? ` (${p.branch})` : ""} isn't the reviewed code (review at ${head.slice(0, 7)}).`;
  }
}

export async function hasTrackedChanges(wt: string): Promise<boolean> {
  return !!(await git(wt, "status", "--porcelain", "--untracked-files=no")).trim();
}

const HELD = /already (checked out|used by worktree)/;
const DIVERGED = /non-fast-forward|Not possible to fast-forward|\[rejected\]|diverg/i;

export interface CheckoutAsk {
  /** Whether to reset a local branch that the PR's rebase left behind; review/pr-<n> branches are reset without asking. */
  resetBranch(branch: string): Promise<boolean>;
}

/** Runs gh pr checkout, on review/pr-<n> when another worktree holds the PR's branch; undefined if the reader declined. */
export async function checkoutPr(wt: string, pr: number, prBranch: string | undefined, head: string, ask: CheckoutAsk): Promise<Place | undefined> {
  const own = `review/pr-${pr}`;
  const attempt = async (extra: string[]): Promise<boolean> => {
    try {
      await gh(wt, "pr", "checkout", String(pr), ...extra);
      return true;
    } catch (e) {
      const msg = errText(e);
      if (HELD.test(msg) && !extra.includes("--branch")) return attempt([...extra, "--branch", own]);
      if (DIVERGED.test(msg) && !extra.includes("--force")) {
        const branch = extra.includes("--branch") ? own : prBranch || `PR #${pr}'s branch`;
        if (branch !== own && !(await ask.resetBranch(branch))) return false;
        return attempt([...extra, "--force"]);
      }
      throw new Error(msg);
    }
  };
  if (!(await attempt([]))) return undefined;
  return placeOf(wt, head);
}
