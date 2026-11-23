// Loads a built page in headless Chromium and prints one line per layout problem; exit 0 clean, 1 problems, 2 failed.
// Usage: node check.mjs <page.html> <chrome binary> <scratch dir>
import { spawn } from "node:child_process";

const [page, chromeBin, scratch] = process.argv.slice(2);
if (typeof WebSocket === "undefined") { console.error("needs node 22 or newer"); process.exit(2); }
const port = 9300 + Math.floor(Math.random() * 600);
const chrome = spawn(chromeBin, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
  `--remote-debugging-port=${port}`, `--user-data-dir=${scratch}/chrome-profile`, "about:blank"], { stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const exited = new Promise(r => chrome.on("exit", r));
// The caller deletes the scratch folder, so wait until Chrome stops writing its profile there.
const quit = async code => { try { chrome.kill(); } catch {} await Promise.race([exited, sleep(5000)]); process.exit(code); };
const fail = async msg => { console.error(msg); await quit(2); };

let target;
for (let i = 0; i < 60 && !target; i++) {
  await sleep(500);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === "page"); } catch {}
}
if (!target) await fail("the browser did not start");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", r));
let seq = 0;
const waiting = new Map(), errors = [];
ws.addEventListener("message", m => {
  const d = JSON.parse(m.data);
  if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); }
  if (d.method === "Runtime.exceptionThrown") errors.push((d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text || "").split("\n")[0]);
});
const send = (method, params = {}) => new Promise(r => { const id = ++seq; waiting.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const run = async expr => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
await send("Page.enable");
await send("Runtime.enable");

// Each probe returns a list of problem strings.
const LAYOUT = `(() => {
  const out = [], short = s => s.replace(/\\s+/g, " ").trim().slice(0, 50);
  document.querySelectorAll("svg").forEach((svg, si) => {
    if (!svg.viewBox || !svg.viewBox.baseVal || !svg.closest("figure, .dg-wrap")) return;
    const vb = svg.viewBox.baseVal, rects = [...svg.querySelectorAll("rect")].map(r => r.getBBox());
    const texts = [...svg.querySelectorAll("text")].map(t => ({ t, b: t.getBBox(), s: t.textContent }));
    for (const { t, b, s } of texts) {
      const ax = +t.getAttribute("x"), ay = +t.getAttribute("y");
      const box = rects.filter(r => ax >= r.x && ax <= r.x + r.width && ay >= r.y && ay <= r.y + r.height).sort((p, q) => p.width * p.height - q.width * q.height)[0];
      if (box && (b.x < box.x + 2 || b.x + b.width > box.x + box.width - 2)) out.push("diagram " + (si + 1) + ': label "' + short(s) + '" is ' + Math.round(b.width) + " wide in a " + Math.round(box.width) + " box; widen the box or split the label");
      else if (!box && (b.x < vb.x || b.x + b.width > vb.x + vb.width)) out.push("diagram " + (si + 1) + ': label "' + short(s) + '" runs ' + Math.round(Math.max(b.x + b.width - vb.x - vb.width, vb.x - b.x)) + " past the picture's edge");
    }
    for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i].b, c = texts[j].b;
      if (a.x < c.x + c.width - 1 && c.x < a.x + a.width - 1 && a.y < c.y + c.height - 2 && c.y < a.y + a.height - 2)
        out.push("diagram " + (si + 1) + ': labels "' + short(texts[i].s) + '" and "' + short(texts[j].s) + '" overlap');
    }
  });
  document.querySelectorAll(".fl-box").forEach(b => { if (b.scrollWidth > b.clientWidth + 1) out.push('flow box "' + short(b.textContent) + '" overflows; break its longest word'); });
  const se = document.scrollingElement;
  if (se.scrollWidth > innerWidth + 1) {
    const wide = [...document.querySelectorAll("main *, header *")].filter(e => {
      const r = e.getBoundingClientRect();
      if (r.right <= innerWidth + 1 || !r.width) return false;
      for (let p = e.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o !== "visible") return false; }
      return true;
    }).slice(0, 3).map(e => e.tagName.toLowerCase() + (typeof e.className === "string" && e.className ? "." + e.className.split(" ")[0] : ""));
    out.push("the page scrolls sideways by " + (se.scrollWidth - innerWidth) + "px (" + wide.join(", ") + ")");
  }
  const ids = new Set([...document.querySelectorAll("[id]")].map(e => e.id));
  const dead = [...new Set([...document.querySelectorAll('a[href^="#"]')].map(a => a.getAttribute("href").slice(1)).filter(h => h && !ids.has(h)))];
  if (dead.length) out.push("in-page links to nothing: " + dead.slice(0, 5).join(", "));
  return out;
})()`;

const WALKS = `(() => {
  const out = [];
  document.querySelectorAll(".wcol.aligned").forEach(col => {
    for (const li of col.querySelectorAll(".wnote")) {
      const id = li.getAttribute("data-ws");
      const mark = [...document.querySelectorAll('.wmark[data-ws="' + id + '"]')].find(m => m.getClientRects().length);
      if (!mark) { out.push("step " + id + " has a note but no marker on screen"); continue; }
      const drift = li.getBoundingClientRect().top - mark.getBoundingClientRect().top;
      if (drift > 120) out.push("step " + id + "'s note sits " + Math.round(drift) + "px below its line, pushed down by the notes above it in that side column; shorten those notes or move them to an earlier step");
    }
  });
  return out;
})()`;

// Lights the first step in unified and in split view and confirms its lines change colour; a failure is a page.js or base.css bug.
const STEP_LIGHT = `(async () => {
  const out = [], note = document.querySelector(".wnote");
  if (!note) return out;
  const id = note.getAttribute("data-ws"), tick = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 50)));
  const lit = sel => { const els = [...document.querySelectorAll(sel)].filter(e => e.getClientRects().length); return [els.length, els.filter(e => [e, ...e.children].some(c => getComputedStyle(c).backgroundImage !== "none")).length]; };
  note.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); await tick();
  let [n, ok] = lit('tr[data-ws="' + id + '"]');
  if (n && ok < n) out.push("unified view: step " + id + " lights " + ok + " of its " + n + " lines (format bug in page.js or base.css)");
  note.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
  const split = [...document.querySelectorAll("button")].find(b => /^\\s*Split/.test(b.textContent));
  if (!split || split.disabled) return out;
  split.click(); await tick();
  if (!document.querySelector("table.sp:not([hidden])")) return out;
  note.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); await tick();
  [n, ok] = lit('table.sp td[data-ws="' + id + '"]');
  if (!n) {
    // A new or deleted file stays single-column in split view, so its unified rows carry the step there.
    [n, ok] = lit('tr[data-ws="' + id + '"]');
    if (!n) out.push("split view: step " + id + " marks no cells (format bug in page.js splitTable)");
    else if (ok < n) out.push("split view: step " + id + " lights " + ok + " of its " + n + " lines in a single-column file (format bug in page.js or base.css)");
  } else if (ok < n) out.push("split view: step " + id + " lights " + ok + " of its " + n + " cells (format bug in page.js or base.css)");
  split.click(); await tick();
  return out;
})()`;

const found = new Map();
const note = (msg, where) => found.set(msg, [...(found.get(msg) || []), where]);
for (const [width, dark] of [[390, false], [1100, true], [1600, false], [1920, false]]) {
  errors.length = 0;
  await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
  await send("Page.navigate", { url: "file://" + page });
  await sleep(900);
  await run("Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 3000))]).then(() => { dispatchEvent(new Event('resize')); return new Promise(r => setTimeout(r, 150)); })");
  const loaded = await run("document.querySelectorAll('main .file, main section').length");
  if (!loaded) await fail("the page did not load in the browser (" + page + "); it may not be able to read that folder");
  const where = width + "px" + (dark ? " dark" : "");
  for (const msg of (await run(LAYOUT)) || []) note(msg, where);
  if (width === 1600) for (const msg of (await run(WALKS)) || []) note(msg, where);
  if (width === 1920) for (const msg of (await run(STEP_LIGHT)) || []) note(msg, where);
  for (const e of errors) note("script error: " + e, where);
}
ws.close();
for (const [msg, at] of found) console.log(`${msg} [${at.join(", ")}]`);
await quit(found.size ? 1 : 0);
