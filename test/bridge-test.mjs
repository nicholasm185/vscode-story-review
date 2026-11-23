// Usage: node test/bridge-test.mjs [chrome]. Runs bridge.js and notes.js on the fixture review in headless Chrome.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const out = path.join(here, "..", "test-out");
fs.mkdirSync(out, { recursive: true });

function findChrome() {
  // Chrome first: on Ubuntu, `chromium` is often a snap wrapper that can't start in CI.
  const names = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"];
  for (const n of names) {
    try {
      return execFileSync("which", [n], { encoding: "utf8" }).trim();
    } catch {}
  }
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return fs.existsSync(mac) ? mac : null;
}
const chromeBin = process.argv[2] || process.env.CHROME || findChrome();
if (!chromeBin) {
  console.error("No Chrome or Chromium found. Pass its path, or set CHROME.");
  process.exit(2);
}

// The fixture review (test/fixture) and the parts of it the checks aim at.
const reviewDir = path.join(here, "fixture", "review");
const FILE = "shop/cart.go", WORD = "bestDiscount", LINE_TEXT = "off := bestDiscount(";
const STEP = "total-2", STEP_CHAPTER = "#ch2", STEP_CHAPTER_TITLE = "Chapter 2";
const READ_CHAPTER = "#ch1", LAST_CHAPTER = "#ch3", FINDING = "#f2";
const SYNC_FILE = "shop/discount.go", UNLISTED_FILE = "README.md";
const headLines = fs.readFileSync(path.join(here, "fixture", "head", FILE), "utf8").split("\n");
const LINE = headLines.findIndex((l) => l.includes(LINE_TEXT)) + 1;
const wantCol = headLines[LINE - 1].indexOf(WORD);

const nonce = "testnonce";
const page = fs.readFileSync(path.join(reviewDir, "page.html"), "utf8")
  .replace(/<script(?![^>]*type="text\/markdown")/g, `<script nonce="${nonce}"`);
const bridge = fs.readFileSync(path.join(here, "..", "media", "bridge.js"), "utf8");
const css = fs.readFileSync(path.join(here, "..", "media", "bridge.css"), "utf8");
const write = (name, state) => fs.writeFileSync(path.join(out, name),
  `<!doctype html><html><head><meta charset="utf-8">` +
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; script-src 'nonce-${nonce}'">` +
  `<style>${css}</style>` +
  `<script nonce="${nonce}">window.__msgs = []; window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__msgs.push(m) }); window.__srState = ${JSON.stringify(state)};</script>` +
  `<script nonce="${nonce}">${bridge}</script></head><body class="vscode-dark">${page}</body></html>`);
write("test.html", {});

const port = 9300 + Math.floor(Math.random() * 600);
// Ubuntu runners block the sandbox's user namespaces, so CI runs without it.
const chrome = spawn(chromeBin, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
  ...(process.env.CI ? ["--no-sandbox"] : []),
  `--remote-debugging-port=${port}`, `--user-data-dir=${out}/chrome-profile`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
let chromeErr = "";
chrome.stderr.on("data", (d) => { chromeErr = (chromeErr + d).slice(-4000); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 60 && !target; i++) {
  await sleep(500);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page"); } catch {}
}
if (!target) {
  console.error(`${chromeBin} didn't start within 30 seconds. Its last output:\n${chromeErr || "(none)"}`);
  chrome.kill();
  process.exit(2);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let seq = 0;
const waiting = new Map(), errors = [];
ws.addEventListener("message", (m) => {
  const d = JSON.parse(m.data);
  if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); }
  if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description?.split("\n")[0]);
  if (d.method === "Log.entryAdded" && /Content Security Policy/.test(d.params.entry.text)) errors.push(d.params.entry.text.slice(0, 160));
});
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const js = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
await send("Page.enable"); await send("Runtime.enable"); await send("Log.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "file://" + path.join(out, "test.html") });
await sleep(2500);

const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ": " + detail : ""}`);

// Centre of WORD in the new-side cell for LINE, in unified or split view.
const locate = (split) => js(`(() => {
  const file = [...document.querySelectorAll('[data-file="${FILE}"]')].find(f => [...f.querySelectorAll(${split ? `"td.ln.nl"` : `"table.diff:not(.sp) tr"`})]
    .some(x => (${split ? "x" : "x.cells[1]"})?.textContent.trim() === "${LINE}" && x.offsetParent));
  if (!file) return null;
  let td;
  if (${split}) { const ln = [...file.querySelectorAll("td.ln.nl")].find(x => x.textContent.trim() === "${LINE}" && x.offsetParent); td = ln.nextElementSibling.nextElementSibling; }
  else { const tr = [...file.querySelectorAll("table.diff:not(.sp) tr")].find(x => x.cells[1]?.textContent.trim() === "${LINE}"); td = tr.cells[3]; }
  td.scrollIntoView({ block: "center", behavior: "instant" });
  const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT); let n;
  while ((n = walker.nextNode())) { const i = n.nodeValue.indexOf("${WORD}"); if (i >= 0) { const r = document.createRange(); r.setStart(n, i + 3); r.setEnd(n, i + 4); const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; } }
  return null;
})()`);
const lastMsg = (type) => js(`JSON.stringify(window.__msgs.filter(m => m.type === "${type}").pop() || null)`).then(JSON.parse);
const click = async (x, y, modifiers = 0) => {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, modifiers });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, modifiers });
  await sleep(200);
};

// Code colours: the page asks for its lines, paints what the extension sends, and leaves the DOM as built.
const cellFor = (split, n) => `(() => {
  const want = "${n}";
  for (const f of document.querySelectorAll('[data-file="${FILE}"]')) {
    if (${split}) { const ln = [...f.querySelectorAll("table.sp td.ln.nl")].find(x => x.textContent.trim() === want); if (ln) return ln.nextElementSibling.nextElementSibling; }
    else { const tr = [...f.querySelectorAll("table.diff:not(.sp) tr")].find(x => x.cells[1]?.textContent.trim() === want); if (tr) return tr.cells[3]; }
  }
  return null;
})()`;
const askPaint = await lastMsg("paint");
check("the page asks for colours for its diff lines", !!askPaint?.files?.[FILE]?.new?.includes(LINE), JSON.stringify(askPaint?.files?.[FILE] ?? null).slice(0, 120));
const OTHER = askPaint?.files?.[FILE]?.new?.find((n) => n !== LINE);
const lineText = headLines[LINE - 1];
const before = await js(`${cellFor(false, LINE)}.innerHTML`);
await js(`window.postMessage(${JSON.stringify({ type: "paint", colors: ["#ff0000", "#00ff00"], files: { [FILE]: { new: { [LINE]: [lineText, [[0, 3, 0], [3, lineText.length, 1]]], [OTHER]: ["not the line", [[0, 2, 0]]] } } } })}, "*")`);
await sleep(200);
const painted = await js(`(() => { const td = ${cellFor(false, LINE)}, other = ${cellFor(false, OTHER)};
  return { on: td.classList.contains("sr-tm"), same: td.innerHTML === ${JSON.stringify(before)},
    hl: CSS.highlights.get("sr-tm-0")?.size || 0, other: other.classList.contains("sr-tm"), css: [...document.querySelectorAll("style")].some(s => s.textContent.includes("::highlight(sr-tm-1) { color: #00ff00; }")) }; })()`);
check("a sent line paints as highlights without changing the cell", painted?.on && painted.same && painted.hl > 0 && painted.css, JSON.stringify(painted));
check("a line whose text differs stays unpainted", painted?.other === false);

for (const split of [false, true]) {
  const view = split ? "split" : "unified";
  if (split) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "s", text: "s" });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "s" });
    await sleep(500);
    check("split view built", await js(`document.querySelectorAll("table.diff.sp").length > 0 && !!document.querySelector("table.sp")?.offsetParent`));
    check("split view cells are painted too", await js(`${cellFor(true, LINE)}?.classList.contains("sr-tm")`));
    const oldCtx = await js(`(() => { const tr = [...document.querySelectorAll('[data-file="${FILE}"] table.diff:not(.sp) tr.ctx')].find(x => x.cells[0].textContent.trim()); return tr && +tr.cells[0].textContent; })()`);
    check("unchanged lines are asked for on the old side too, for split view", !!oldCtx && askPaint.files[FILE].old.includes(oldCtx), `${oldCtx} in ${JSON.stringify(askPaint.files[FILE].old)}`);
  }
  await locate(split);
  await sleep(400);
  const p = await locate(split);
  if (!p) { check(`${view}: found ${WORD}`, false); continue; }
  await sleep(300);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y });
  await sleep(700);
  const h = await lastMsg("hover");
  check(`${view}: hover names the word's position`, h && h.path === FILE && h.line === LINE && h.col === wantCol,
    JSON.stringify(h) + ` want col ${wantCol}`);
  if (h) {
    await js(`window.postMessage({ type: "hover", id: ${h.id}, html: '<p><code>func bestDiscount(sum int, codes []string) int</code></p><img src="x" onerror="window.__pwned=1"><a href="javascript:alert(1)">x</a>' }, "*")`);
    await sleep(300);
    const tip = await js(`(() => { const t = document.querySelector(".sr-tip"); return { shown: !t.hidden, html: t.innerHTML, pwned: !!window.__pwned }; })()`);
    check(`${view}: hover card shows`, tip.shown && tip.html.includes(WORD));
    check(`${view}: hover card is sanitized`, !tip.pwned && !/onerror|javascript:/.test(tip.html), tip.html.slice(0, 120));
    check(`${view}: word is highlighted`, await js(`CSS.highlights.has("sr-word")`));
  }
  await click(p.x, p.y, 4);
  const d = await lastMsg("definition");
  check(`${view}: ⌘-click asks for the definition`, d && d.line === LINE && d.col === wantCol && d.word === WORD, JSON.stringify(d));
  await click(p.x, p.y, 2 | 8);
  const r = await lastMsg("references");
  check(`${view}: ⇧Ctrl-click asks for references`, r && r.line === LINE && r.col === wantCol, JSON.stringify(r));
  const ln = await js(`(() => { const c = ${split} ? [...document.querySelectorAll('[data-file="${FILE}"] td.ln.nl')].find(x => x.textContent.trim() === "${LINE}" && x.offsetParent)
    : [...document.querySelectorAll('[data-file="${FILE}"] table.diff:not(.sp) tr')].find(x => x.cells[1]?.textContent.trim() === "${LINE}").cells[1];
    const b = c.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  await click(ln.x, ln.y);
  const o = await lastMsg("open");
  check(`${view}: line-number click opens the line`, o && o.path === FILE && o.line === LINE, JSON.stringify(o));
}

const part = await js(`(() => { const b = document.querySelector(".viewed-toggle input"); b.click(); return b.dataset.part; })()`);
await sleep(200);
const saved = await js(`JSON.stringify(Object.fromEntries(window.__msgs.filter(m => m.type === "state").map(m => [m.key, m.value])))`);
check("progress is saved through the extension", /viewed/.test(saved), saved.slice(0, 120));
check("theme follows VS Code", (await js(`document.documentElement.dataset.theme`)) === "dark");

// Half a screen, as when an editor is open beside the panel, with the saved progress handed back.
write("test-narrow.html", JSON.parse(saved));
await send("Emulation.setDeviceMetricsOverride", { width: 820, height: 1000, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "file://" + path.join(out, "test-narrow.html") });
await sleep(2500);
check("progress comes back after reopening", await js(`!!document.querySelector('.viewed-toggle input[data-part="${part}"]')?.checked`));
await js(`document.querySelector("${LAST_CHAPTER}").scrollIntoView({ behavior: "instant" })`);
await sleep(300);
// The page's own "contents hidden" layout, then a wider panel: the page must still use the full width.
await js(`document.documentElement.classList.add("rail-off")`);
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "c", text: "c" });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "c" });
await send("Emulation.setDeviceMetricsOverride", { width: 1300, height: 1000, deviceScaleFactor: 1, mobile: false });
await sleep(400);
const wide = await js(`(() => ({ rail: getComputedStyle(document.querySelector(".rail")).display, main: Math.round(document.querySelector("main").getBoundingClientRect().width), vw: innerWidth }))()`);
check("the page's own rail never shows, even with its contents hidden", wide.rail === "none" && wide.main > wide.vw - 80, JSON.stringify(wide));
await send("Emulation.setDeviceMetricsOverride", { width: 820, height: 1000, deviceScaleFactor: 1, mobile: false });
await sleep(300);
const narrow = await js(`Math.round(document.querySelector("main").getBoundingClientRect().width)`);
check("at 820px the page uses the full width", narrow > 740, String(narrow));
const sideways = await js(`document.documentElement.scrollWidth > document.documentElement.clientWidth`);
check("at 820px nothing scrolls sideways", !sideways);
// The test's own hover payload carries an inline handler; the page's script lock refusing it is expected.
const other = errors.filter((e) => !/inline event handler/.test(e));
check("no script errors or blocked page scripts", other.length === 0, other.join(" | "));
// Side views: outline, layout switch, notes for the code in view, highlight and read marks driven from outside.
const outlineMsg = await lastMsg("outline");
const o = outlineMsg && outlineMsg.outline;
const counts = await js(`({ chapters: document.querySelectorAll("#toc > li").length, findings: document.querySelectorAll(".finding[id]").length, files: document.querySelectorAll(".ftree li.tfile").length })`);
check("outline lists every chapter, finding and file", o && o.chapters.length === counts.chapters && o.findings.length === counts.findings && o.files.length === counts.files && counts.files > 1,
  o ? `${o.chapters.length}/${counts.chapters} chapters, ${o.findings.length}/${counts.findings} findings, ${o.files.length}/${counts.files} files` : "none");
check("findings carry their location", o && o.findings.every((f) => /:\d+/.test(f.loc)), o && JSON.stringify(o.findings.map((f) => f.loc)));
check("the viewed file shows in the outline", o && o.files.some((f) => f.viewed || f.partial));
await js(`window.postMessage({ type: "layout", rail: true, notes: true }, "*")`);
await sleep(400);
const lay = await js(`(() => ({ rail: getComputedStyle(document.querySelector(".rail")).display, notes: [...document.querySelectorAll(".step:not(.solo) > .step-notes")].every(n => getComputedStyle(n).display === "none"),
  main: Math.round(document.querySelector("main").getBoundingClientRect().width), sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth }))()`);
check("with side views open the page drops its rail and notes", lay.rail === "none" && lay.notes && !lay.sideways, JSON.stringify(lay));
await js(`window.__msgs.length = 0; document.querySelector('tr[data-ws="${STEP}"]').scrollIntoView({ block: "start", behavior: "instant" }); window.scrollBy(0, -200)`);
await sleep(500);
const notes = await lastMsg("notes");
check("notes for the code in view are sent", notes && /wnote/.test(notes.html) && notes.title.includes(STEP_CHAPTER_TITLE) && !/aligned|style="top/.test(notes.html),
  notes ? `${notes.title} | ${notes.html.length} chars | files ${notes.files}` : "none");
const shot = async (name) => {
  if (!process.env.SHOTS) return;
  const r = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(out, name), Buffer.from(r.result.data, "base64"));
};
await shot("page-side-views.png");
const cur = await lastMsg("current");
check("the current chapter is reported", cur && cur.href === STEP_CHAPTER, JSON.stringify(cur));
await js(`window.postMessage({ type: "light", ws: "${STEP}", on: true }, "*")`);
await sleep(150);
check("a note hovered in the side view lights its lines", await js(`document.querySelectorAll('tr.ws-on[data-ws="${STEP}"], td.ws-on[data-ws="${STEP}"]').length > 0`));
await js(`window.__msgs.length = 0; window.postMessage({ type: "setRead", href: "${READ_CHAPTER}", on: true }, "*")`);
await sleep(400);
const after = await lastMsg("outline");
await js(`window.__msgs.length = 0; window.postMessage({ type: "keys", on: false }, "*")`);
await sleep(300);
const keysMsg = await lastMsg("outline");
check("the shortcuts toggle turns single-key shortcuts off", await js(`document.querySelector(".keys-toggle input").checked === false`) && keysMsg && keysMsg.outline.keysOn === false);
await js(`window.postMessage({ type: "keys", on: true }, "*")`);
await sleep(200);
check("a chapter ticked in the side view is marked read", await js(`document.querySelector('.seen-toggle input[data-ch="${READ_CHAPTER.slice(1)}"]').checked`) && after && after.outline.chapters.find((c) => c.href === READ_CHAPTER).read === true);
await js(`window.postMessage({ type: "goto", href: "${FINDING}" }, "*")`);
await sleep(1500);
check("a finding clicked in the side view scrolls the page to it", await js(`(() => { const r = document.getElementById("${FINDING.slice(1)}").getBoundingClientRect(); return r.top >= -5 && r.top < innerHeight; })()`));

// A file header's name opens the file at its first added line.
const hdr = await js(`(() => { const b = document.querySelector('.file[data-file="${FILE}"]'); const el = b.querySelector(".file-h .path"); el.scrollIntoView({ block: "center", behavior: "instant" });
  const first = [...b.querySelectorAll("table.diff:not(.sp) tr.add")][0]; const r = el.getBoundingClientRect();
  return { x: r.left + 20, y: r.top + r.height / 2, want: first && parseInt(first.cells[1].textContent, 10), link: el.classList.contains("sr-open") }; })()`);
await js(`window.__msgs.length = 0`);
await click(hdr.x, hdr.y);
const opened = await lastMsg("open");
check("clicking a file header's name opens the file", hdr.link && opened && opened.path === FILE && opened.line === hdr.want, JSON.stringify({ opened, want: hdr.want }));

// GitHub's Viewed marks: a sync updates the page without echoing back, and the reader's own tick is sent.
const syncPath = SYNC_FILE;
await js(`window.__msgs.length = 0; window.postMessage({ type: "syncViewed", viewed: ["${syncPath}"] }, "*")`);
await sleep(300);
const synced = await js(`(() => ({ viewed: document.querySelector('.ftree li.tfile[data-path="${syncPath}"]').classList.contains("is-viewed"),
  echoed: window.__msgs.filter(m => m.type === "viewedChange").length }))()`);
check("a GitHub sync marks the file viewed on the page without writing back", synced.viewed && synced.echoed === 0, JSON.stringify(synced));
await js(`window.__msgs.length = 0; document.querySelector('.ftree li.tfile[data-path="${syncPath}"] input').click()`);
await sleep(200);
const ticked = await lastMsg("viewedChange");
check("unticking a file sends it to GitHub", ticked && ticked.path === syncPath && ticked.viewed === false, JSON.stringify(ticked));
const unlisted = UNLISTED_FILE;
await js(`window.__msgs.length = 0; document.querySelector('.ftree li.tfile[data-path="${unlisted}"] input').click()`);
await sleep(100);
await js(`window.postMessage({ type: "syncViewed", viewed: [], listed: ["${syncPath}"] }, "*")`);
await sleep(200);
check("a sync leaves files GitHub doesn't list alone", await js(`document.querySelector('.ftree li.tfile[data-path="${unlisted}"]').classList.contains("is-viewed")`));
await js(`window.__msgs.length = 0; (() => { const f = document.querySelector('.file[data-path="${syncPath}"]'); f.scrollIntoView({ block: "start", behavior: "instant" }); window.scrollBy(0, 40); })()`);
await sleep(300);
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "v", text: "v" });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "v" });
await sleep(300);
const vkey = await lastMsg("viewedChange");
check("the v key's tick is sent to GitHub too", vkey && vkey.path, JSON.stringify(vkey));

await js(`window.__msgs.length = 0; document.body.dataset.vscodeThemeId = "Monokai"`);
await sleep(200);
const reask = await lastMsg("paint");
check("a theme change asks for colours again and clears the old ones", reask?.theme?.name === "Monokai" && await js(`!document.querySelector("td.sr-tm") && (CSS.highlights.get("sr-tm-0")?.size || 0) === 0`), JSON.stringify(reask?.theme));

// The Notes view itself, fed one notes message.
const notesHtml = `<!doctype html><html><head><meta charset="utf-8"><style>${(page.match(/<style>([\s\S]*?)<\/style>/) || [])[1]}</style>` +
  `<style>${fs.readFileSync(path.join(here, "..", "media", "notes.css"), "utf8")}</style>` +
  `<script>window.__msgs = []; window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__msgs.push(m) });</script></head>` +
  `<body class="vscode-dark"><header id="title"></header><main id="notes"></main><script>${fs.readFileSync(path.join(here, "..", "media", "notes.js"), "utf8")}</script></body></html>`;
fs.writeFileSync(path.join(out, "notes.html"), notesHtml);
await send("Emulation.setDeviceMetricsOverride", { width: 340, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: "file://" + path.join(out, "notes.html") });
await sleep(800);
await js(`window.postMessage(${JSON.stringify({ ...notes, type: "notes" })}, "*")`);
await sleep(300);
const nv = await js(`(() => ({ notes: document.querySelectorAll(".wnote").length, title: document.getElementById("title").textContent, sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth }))()`);
check("the Notes view shows the step's notes", nv.notes > 0 && nv.title.includes(STEP_CHAPTER_TITLE) && !nv.sideways, JSON.stringify(nv));
await shot("notes-view.png");
const li = await js(`(() => { const n = document.querySelector('.wnote[data-ws="${STEP}"]'); if (!n) return null; const b = n.getBoundingClientRect(); return { x: b.left + 40, y: b.top + 8 }; })()`);
if (li) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: li.x, y: li.y });
  await sleep(150);
  await click(li.x, li.y);
}
const fileLink = await js(`(() => { const a = document.querySelector(".sr-files a"); if (!a) return null; const r = a.getBoundingClientRect(); return { x: r.left + 5, y: r.top + r.height / 2, text: a.textContent }; })()`);
if (fileLink) await click(fileLink.x, fileLink.y);
const sentOpen = await js(`JSON.stringify(window.__msgs.filter(m => m.type === "open"))`);
check("a file name in the Notes view opens the file", fileLink && sentOpen.includes(`"path":"${FILE}","line":`), `${fileLink && fileLink.text} ${sentOpen}`);
const sent = await js(`JSON.stringify(window.__msgs)`);
check("hovering and clicking a note asks the page to light and show its lines", sent.includes(`"light","ws":"${STEP}","on":true`) && sent.includes(`"step","ws":"${STEP}"`), sent.slice(0, 160));

console.log(results.join("\n"));
chrome.kill();
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
