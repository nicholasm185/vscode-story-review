// Fixed commit author and date, so a rebuild with the same skill version gives the same page.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const skill = process.argv[2] || process.env.STORY_REVIEW_SKILL || path.join(os.homedir(), ".claude", "skills", "story-review");
const build = path.join(skill, "scripts", "build.py");
if (!fs.existsSync(build)) {
  console.error(`No story-review skill at ${skill}. Pass its folder, or set STORY_REVIEW_SKILL.`);
  process.exit(1);
}

const repo = path.join(here, "..", "..", "test-out", "fixture-repo");
fs.rmSync(repo, { recursive: true, force: true });
fs.mkdirSync(repo, { recursive: true });
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.com", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.com", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};
const git = (...args) => execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", ...args], { env, encoding: "utf8" }).trim();
const commit = (tree, message) => {
  fs.cpSync(path.join(here, tree), repo, { recursive: true });
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
};

git("init", "-q", "-b", "main");
const base = commit("base", "shop: a cart that adds up its items");
const head = commit("head", "feat(cart): apply discount codes");

const review = path.join(here, "review");
fs.writeFileSync(path.join(review, "pr.json"), JSON.stringify({
  author: { login: "example-author", name: "Example Author" },
  baseRefName: "main", headRefName: "feat/discount-codes", headRefOid: head, number: 42,
  reviewDecision: "", reviews: [], statusCheckRollup: [], title: "feat(cart): apply discount codes",
  url: "https://github.com/example/shop/pull/42",
}, null, 1) + "\n");
fs.writeFileSync(path.join(review, "meta.json"), JSON.stringify({
  repo: "example/shop", pr: 42, base, head, reviewed: "2026-01-01", style: "fixture",
}, null, 1) + "\n");

execFileSync("python3", ["-I", build, "--repo", repo, "--base", base, "--head", head,
  "--template", path.join(review, "template.html"), "--out", path.join(review, "page.html"), "--no-check"], { stdio: "inherit" });
