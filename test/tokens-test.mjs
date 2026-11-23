// Usage: node test/tokens-test.mjs. Checks the tokenizer against VS Code's Dark Modern colours, with no VS Code needed.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const out = path.join(here, "..", "test-out");
fs.mkdirSync(out, { recursive: true });
// CommonJS, like the shipped bundle, so the grammar engine loads the way it does in VS Code.
const bundle = path.join(out, "tokens.cjs");
execFileSync(path.join(here, "..", "node_modules", ".bin", "esbuild"),
  [path.join(here, "..", "src", "tokens.ts"), "--bundle", "--platform=node", "--format=cjs", "--loader:.jsonc=text", `--outfile=${bundle}`, "--log-level=warning"]);
const t = createRequire(import.meta.url)(bundle);

const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ": " + detail : ""}`);

const tk = new t.Tokenizer();
const dark = await tk.theme(t.themeIdFor("Default Dark Modern", true).id);
const colorOf = (src, lines, n, word) => {
  const at = src[n].indexOf(word);
  const run = lines[n].find(([s, e]) => s <= at && at < e);
  return run && tk.colors[run[2]].toUpperCase();
};

const goFile = path.join(here, "fixture", "head", "shop", "cart.go");
const goSrc = fs.readFileSync(goFile, "utf8");
const goLines = await tk.lines(goSrc, t.langOf("shop/cart.go"), dark);
const go = goSrc.split("\n");
const fn = go.findIndex((l) => l.startsWith("func Total"));
check("Go: func keyword, function name and type match Dark Modern",
  colorOf(go, goLines, fn, "func") === "#569CD6" && colorOf(go, goLines, fn, "Total") === "#DCDCAA" && colorOf(go, goLines, fn, "Item") === "#4EC9B0",
  [colorOf(go, goLines, fn, "func"), colorOf(go, goLines, fn, "Total"), colorOf(go, goLines, fn, "Item")].join(" "));
check("Go: a comment is comment green", colorOf(go, goLines, 2, "Item") === "#6A9955", colorOf(go, goLines, 2, "Item"));
check("Go: runs cover each line exactly", goLines.every((runs, i) => runs.reduce((a, [s, e]) => (a === s ? e : -1), 0) === (go[i] ?? "").length));

const tsx = ["import { useState } from 'react'", "export function App({ name }: { name: string }) {", "  const [n] = useState(0)", "  return <div className=\"x\">{name}{`${n}`}</div>", "}"];
const tsxLines = await tk.lines(tsx.join("\n"), t.langOf("src/App.tsx"), dark);
check("TSX: keyword, string, function and JSX tag colours", colorOf(tsx, tsxLines, 0, "import") === "#C586C0" && colorOf(tsx, tsxLines, 0, "'react'") === "#CE9178" &&
  colorOf(tsx, tsxLines, 1, "App") === "#DCDCAA" && colorOf(tsx, tsxLines, 3, "div") === "#569CD6",
  [colorOf(tsx, tsxLines, 0, "import"), colorOf(tsx, tsxLines, 0, "'react'"), colorOf(tsx, tsxLines, 1, "App"), colorOf(tsx, tsxLines, 3, "div")].join(" "));

const sem = (type, mods = []) => t.semanticColor(dark.resolved, type, mods)?.toUpperCase();
check("semantic tokens map like VS Code's fallback scopes",
  sem("variable", ["readonly"]) === "#4FC1FF" && sem("function") === "#DCDCAA" && sem("type") === "#4EC9B0" && sem("keyword") === "#C586C0" && sem("parameter") === "#9CDCFE",
  [sem("variable", ["readonly"]), sem("function"), sem("type"), sem("keyword"), sem("parameter")].join(" "));
check("a theme's own semanticTokenColors win", sem("newOperator") === "#C586C0", sem("newOperator"));
check("semantic colouring follows the setting, then the theme", t.semanticOn(dark.resolved, "configuredByTheme") && !t.semanticOn(dark.resolved, false));
check("overlay splits TextMate runs around a semantic span", JSON.stringify(t.overlay([[0, 10, 1], [10, 20, 2]], [[5, 12, 9]])) === "[[0,5,1],[5,12,9],[12,20,2]]");

const themes = [["Dark 2026", true, "vscode:2026-dark"], ["Default Light Modern", false, "vscode:light_modern"], ["Dark+", true, "vscode:dark_plus"],
  ["One Dark Pro", true, "one-dark-pro"], ["GitHub Dark Default", true, "github-dark-default"], ["Some Theme", false, "vscode:2026-light"]];
check("VS Code theme names map to bundled themes", themes.every(([n, d, id]) => t.themeIdFor(n, d).id === id) && !t.themeIdFor("Some Theme", true).matched,
  themes.map(([n, d]) => t.themeIdFor(n, d).id).join(" "));

const builtIns = ["2026-dark", "2026-light", "dark_modern", "dark_plus", "dark_vs", "light_modern", "light_plus", "light_vs", "hc_black", "hc_light"];
const loaded = [];
for (const b of builtIns) { try { const th = await tk.theme("vscode:" + b); if (th.resolved.settings.length > 20) loaded.push(b); } catch (e) { console.log(b, e.message); } }
check("every VS Code built-in theme loads with its include chain", loaded.length === builtIns.length, loaded.join(" "));

const d26 = await tk.theme(t.themeIdFor("Dark 2026", true).id);
const goD26 = await tk.lines(goSrc, "go", d26);
check("Dark 2026 takes its own colours over Dark Modern's", colorOf(go, goD26, fn, "func") === "#FF7B72" && colorOf(go, goD26, fn, "Total") === "#D2A8FF" && colorOf(go, goD26, 2, "Item") === "#8B949E",
  [colorOf(go, goD26, fn, "func"), colorOf(go, goD26, fn, "Total"), colorOf(go, goD26, 2, "Item")].join(" "));

const dir = fs.mkdtempSync(path.join(out, "theme-"));
fs.writeFileSync(path.join(dir, "base.json"), `{ // a comment\n "type": "dark", "tokenColors": [{ "scope": "keyword", "settings": { "foreground": "#111111" } },], }`);
fs.mkdirSync(path.join(dir, "mine"));
fs.writeFileSync(path.join(dir, "mine", "theme.json"), `{ "include": "../base.json", /* own */ "tokenColors": [{ "scope": "entity.name.function", "settings": { "foreground": "#222222" } }] }`);
const pick = t.themeIdFor("file:" + path.join(dir, "mine", "theme.json"), true);
const own = await tk.theme(pick.id);
const goOwn = await tk.lines(goSrc, "go", own);
check("a theme .json file loads, with comments and an include relative to it", colorOf(go, goOwn, fn, "func") === "#111111" && colorOf(go, goOwn, fn, "Total") === "#222222",
  [colorOf(go, goOwn, fn, "func"), colorOf(go, goOwn, fn, "Total")].join(" "));
check("JSONC keeps // inside strings", t.parseJsonc(`{"a": "vscode://x", // c\n "b": [1,],}`).a === "vscode://x");
check("file names pick a language", t.langOf("a/b.ts") === "typescript" && t.langOf("Dockerfile") === "docker" && t.langOf("x/Makefile") === "make" && t.langOf("README.md") === undefined);

console.log(results.join("\n"));
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
