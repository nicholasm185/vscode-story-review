// Usage: node test/checkout-test.mjs. Drives the Check Out PR logic against local git repos and a stand-in gh.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const out = path.join(here, "..", "test-out");
fs.mkdirSync(out, { recursive: true });
const bundle = path.join(out, "checkout.cjs");
execFileSync(path.join(here, "..", "node_modules", ".bin", "esbuild"),
  [path.join(here, "..", "src", "checkout.ts"), "--bundle", "--platform=node", "--format=cjs", `--outfile=${bundle}`, "--log-level=warning"]);
const c = createRequire(import.meta.url)(bundle);

const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ": " + detail : ""}`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sr-checkout-"));
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd, ...args) => execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, env, encoding: "utf8" }).trim();

// The stand-in prints gh 2.103's own errors for a branch held by another worktree and for a rebased PR.
const bin = path.join(root, "bin");
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, "gh"), `#!/usr/bin/env bash
set -u
[ "$1 $2" = "pr checkout" ] || { echo "unexpected gh $*" >&2; exit 2; }
n=$3; shift 3; branch=feat; force=
while [ $# -gt 0 ]; do case $1 in --branch) branch=$2; shift 2;; --force) force=1; shift;; *) shift;; esac; done
echo "$n $branch $force" >> "${root}/gh.log"
here=$(git rev-parse --show-toplevel)
held=$(git worktree list --porcelain | awk -v b="branch refs/heads/$branch" '/^worktree /{p=substr($0,10)} $0==b{print p}')
if [ -n "$held" ] && [ "$held" != "$here" ]; then
  echo "fatal: '$branch' is already used by worktree at '$held'" >&2; echo "failed to run git: exit status 128" >&2; exit 1
fi
git fetch -q origin "refs/pull/$n/head" || exit 1
if ! git rev-parse -q --verify "refs/heads/$branch" >/dev/null; then git checkout -q -b "$branch" FETCH_HEAD; exit; fi
git checkout -q "$branch"
if [ -n "$force" ]; then git reset -q --hard FETCH_HEAD; exit; fi
git merge -q --ff-only FETCH_HEAD 2>/dev/null || { echo "fatal: Not possible to fast-forward, aborting." >&2; echo "failed to run git: exit status 128" >&2; exit 1; }
`, { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;

const up = path.join(root, "up");
fs.mkdirSync(up);
git(up, "init", "-q");
const commit = (m) => { fs.writeFileSync(path.join(up, "f.txt"), m + "\n"); git(up, "add", "."); git(up, "commit", "-q", "-m", m); return git(up, "rev-parse", "HEAD"); };
const c1 = commit("one"), c2 = commit("two"), c3 = commit("three");
git(up, "branch", "feat");
git(up, "update-ref", "refs/pull/7/head", c3);
const wt = path.join(root, "wt");
git(root, "clone", "-q", up, wt);
const other = path.join(root, "other");
git(wt, "worktree", "add", "-q", other, "feat");
const asked = [];
const ask = (answer) => ({ async resetBranch(b) { asked.push(b); return answer; } });
const head = () => git(wt, "rev-parse", "HEAD");
const branch = () => git(wt, "branch", "--show-current");

git(wt, "checkout", "-q", "--detach", c1);
let p = await c.placeOf(wt, c3);
check("place: behind by two", p.kind === "behind" && p.commits === 2, JSON.stringify(p));
check("note: behind names both commits", c.placeNote(p, c3) === `The checkout is 2 commits behind the review (${c1.slice(0, 7)}, review at ${c3.slice(0, 7)}).`, c.placeNote(p, c3));
p = await c.placeOf(wt, c1);
check("place: at", p.kind === "at" && c.placeNote(p, c1) === undefined);
git(wt, "checkout", "-q", "--detach", c3);
p = await c.placeOf(wt, c2);
check("place: ahead by one", p.kind === "ahead" && p.commits === 1 && /1 commit the review/.test(c.placeNote(p, c2)), JSON.stringify(p));

git(wt, "checkout", "-q", "--detach", c1);
p = await c.checkoutPr(wt, 7, "feat", c3, ask(false));
check("held by another worktree: lands on review/pr-7 at the PR's head", p?.kind === "at" && branch() === "review/pr-7" && head() === c3, `${branch()} ${JSON.stringify(p)}`);
check("held: asked nothing", asked.length === 0);

git(wt, "reset", "-q", "--hard", c2);
p = await c.checkoutPr(wt, 7, "feat", c3, ask(false));
check("behind on review/pr-7: fast-forwards", p?.kind === "at" && head() === c3);

git(wt, "reset", "-q", "--hard", c1);
fs.writeFileSync(path.join(wt, "local.txt"), "x");
git(wt, "add", "local.txt");
git(wt, "commit", "-q", "-m", "local");
p = await c.checkoutPr(wt, 7, "feat", c3, ask(false));
check("rebased PR on review/pr-7: reset without asking", p?.kind === "at" && head() === c3 && asked.length === 0, JSON.stringify(p));

git(wt, "worktree", "remove", "--force", other);
git(wt, "checkout", "-q", "-B", "feat", c1);
fs.writeFileSync(path.join(wt, "local.txt"), "y");
git(wt, "add", "local.txt");
git(wt, "commit", "-q", "-m", "local on feat");
const local = head();
p = await c.checkoutPr(wt, 7, "feat", c3, ask(false));
check("rebased PR on its own branch: asks, and a no leaves it alone", p === undefined && head() === local && asked.join() === "feat", `${asked} ${head().slice(0, 7)}`);
p = await c.checkoutPr(wt, 7, "feat", c3, ask(true));
check("rebased PR on its own branch: a yes resets it", p?.kind === "at" && branch() === "feat" && head() === c3);

fs.writeFileSync(path.join(wt, "f.txt"), "edited\n");
check("tracked changes are seen", await c.hasTrackedChanges(wt));
git(wt, "checkout", "-q", "--", "f.txt");
fs.writeFileSync(path.join(wt, "untracked.txt"), "x");
check("untracked files don't count", !(await c.hasTrackedChanges(wt)));

fs.rmSync(root, { recursive: true, force: true });
console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
