// In a VS Code terminal, `code` is that window's CLI, so a remote window installs on the remote side.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const dist = path.join(root, "dist");
const vsix = fs.existsSync(dist) && fs.readdirSync(dist).filter((f) => f.endsWith(".vsix"))
  .map((f) => path.join(dist, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
if (!vsix) {
  console.error("No dist/*.vsix yet. Run npm run package first.");
  process.exit(1);
}

function onPath(cmd) {
  try {
    execFileSync("which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function serverCli() {
  const bin = path.join(os.homedir(), ".vscode-server", "bin");
  if (!fs.existsSync(bin)) return null;
  const newest = fs.readdirSync(bin).map((d) => path.join(bin, d, "bin", "code-server"))
    .filter((p) => fs.existsSync(p)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  return newest || null;
}

const cli = process.env.VSCODE_CLI
  || (process.env.TERM_PROGRAM === "vscode" && onPath("code") ? "code" : null)
  || serverCli()
  || (onPath("code") ? "code" : null);
if (!cli) {
  console.error("Couldn't find a VS Code CLI. Set VSCODE_CLI, or run this from a VS Code terminal.");
  process.exit(1);
}
console.log(`Installing ${path.basename(vsix)} with ${cli}`);
execFileSync(cli, ["--install-extension", vsix, "--force"], { stdio: "inherit" });
console.log("Done. Run Developer: Reload Window in VS Code to load it.");
