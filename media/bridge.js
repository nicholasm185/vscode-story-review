(function () {
  const vscode = acquireVsCodeApi();
  const store = Object.assign({}, window.__srState || {});
  const has = (k) => Object.prototype.hasOwnProperty.call(store, k);

  // A webview's storage is wiped whenever its panel closes, so the page's progress lives in the extension instead.
  Storage.prototype.getItem = function (k) { return has(k) ? store[k] : null; };
  Storage.prototype.setItem = function (k, v) {
    store[k] = String(v);
    vscode.postMessage({ type: "state", key: k, value: String(v) });
  };
  Storage.prototype.removeItem = function (k) {
    delete store[k];
    vscode.postMessage({ type: "state", key: k, value: null });
  };

  function followTheme() {
    const c = document.body.classList;
    document.documentElement.dataset.theme = c.contains("vscode-light") || c.contains("vscode-high-contrast-light") ? "light" : "dark";
  }

  const WORD = /[\p{L}\p{N}_$]/u;

  function lineOf(td) {
    const tr = td.parentElement;
    if (tr.closest("table.sp")) {
      const ln = td.previousElementSibling && td.previousElementSibling.previousElementSibling;
      return ln && ln.classList.contains("nl") ? parseInt(ln.textContent, 10) || null : null;
    }
    if (tr.classList.contains("del") || !tr.cells[1]) return null;
    return parseInt(tr.cells[1].textContent, 10) || null;
  }

  function offsetAt(td, x, y) {
    let node, off;
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (!p) return null;
      node = p.offsetNode; off = p.offset;
    } else {
      const r = document.caretRangeFromPoint(x, y);
      if (!r) return null;
      node = r.startContainer; off = r.startOffset;
    }
    if (!td.contains(node) || (node.parentElement && node.parentElement.closest(".wmark"))) return null;
    const r = document.createRange();
    r.setStart(td, 0);
    r.setEnd(node, off);
    return r.toString().length;
  }

  function codeText(td) {
    const mark = td.querySelector(".wmark");
    const t = td.textContent;
    return mark ? t.slice(0, t.length - mark.textContent.length) : t;
  }

  // The word under the pointer in a new-side or context code cell, with its position in the worktree file.
  function wordAt(e) {
    if (!e.target.closest || e.target.closest("a, button")) return null;
    const td = e.target.closest("table.diff td.code");
    if (!td) return null;
    const line = lineOf(td);
    const file = td.closest("[data-file]");
    if (!line || !file) return null;
    let col = offsetAt(td, e.clientX, e.clientY);
    if (col === null) return null;
    const text = codeText(td);
    if (!WORD.test(text[col] || "") && WORD.test(text[col - 1] || "")) col -= 1;
    if (!WORD.test(text[col] || "")) return null;
    let s = col, end = col;
    while (s > 0 && WORD.test(text[s - 1])) s--;
    while (end < text.length && WORD.test(text[end])) end++;
    return { td, path: file.getAttribute("data-file"), line, col: s, s, end, word: text.slice(s, end) };
  }

  function rangeFor(td, s, e) {
    const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
    const r = document.createRange();
    let pos = 0, started = false, n;
    while ((n = walker.nextNode())) {
      const len = n.nodeValue.length;
      if (!started && s <= pos + len) { r.setStart(n, s - pos); started = true; }
      if (started && e <= pos + len) { r.setEnd(n, e - pos); return r; }
      pos += len;
    }
    return null;
  }

  function mark(w) {
    if (!window.CSS || !CSS.highlights) return null;
    const r = w && rangeFor(w.td, w.s, w.end);
    if (r) CSS.highlights.set("sr-word", new Highlight(r));
    else CSS.highlights.delete("sr-word");
    return r;
  }

  function sanitize(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("script, style, iframe, object, embed, link, meta, form, input, button").forEach((n) => n.remove());
    doc.body.querySelectorAll("*").forEach((n) => {
      for (const a of Array.from(n.attributes)) {
        const v = a.value.trim().toLowerCase();
        if (a.name.startsWith("on") || ((a.name === "href" || a.name === "src") && !/^(https?:|#)/.test(v))) n.removeAttribute(a.name);
      }
    });
    return doc.body.innerHTML;
  }

  let tip, timer, shownKey = null, wantKey = null, seq = 0, overTip = false;
  const keyOf = (w) => w.path + ":" + w.line + ":" + w.s;

  function hideTip() {
    shownKey = null;
    wantKey = null;
    if (tip) tip.hidden = true;
    mark(null);
  }

  function showTip(w, html) {
    const r = mark(w) || w.td;
    tip.innerHTML = sanitize(html);
    tip.hidden = false;
    const box = (r.getBoundingClientRect ? r : w.td).getBoundingClientRect();
    const width = Math.min(560, window.innerWidth - 24);
    tip.style.maxWidth = width + "px";
    tip.style.left = Math.max(8, Math.min(box.left, window.innerWidth - width - 8)) + "px";
    const below = box.bottom + 6;
    tip.style.top = "0px";
    const h = tip.offsetHeight;
    tip.style.top = (below + h < window.innerHeight - 8 ? below : Math.max(8, box.top - h - 6)) + "px";
    shownKey = keyOf(w);
  }

  const pending = new Map();

  window.addEventListener("message", (ev) => {
    const m = ev.data;
    if (m && m.type === "hover") {
      const w = pending.get(m.id);
      pending.delete(m.id);
      if (w && keyOf(w) === wantKey && m.html) showTip(w, m.html);
    }
  });

  function onMove(e) {
    if (overTip) return;
    const w = wordAt(e);
    const k = w && keyOf(w);
    if (k && k === shownKey) return;
    clearTimeout(timer);
    if (!w) {
      timer = setTimeout(() => { if (!overTip) hideTip(); }, 250);
      return;
    }
    if (shownKey) hideTip();
    wantKey = k;
    timer = setTimeout(() => {
      const id = ++seq;
      pending.set(id, w);
      vscode.postMessage({ type: "hover", id, path: w.path, line: w.line, col: w.col });
    }, 350);
  }

  // The first added line of a file block, or its first line when nothing was added there; null for a deleted file.
  function firstLine(block) {
    let first = null;
    for (const tr of block.querySelectorAll("table.diff:not(.sp) tr")) {
      const n = tr.cells[1] && parseInt(tr.cells[1].textContent, 10);
      if (!n) continue;
      if (tr.classList.contains("add")) return n;
      if (first === null) first = n;
    }
    return first;
  }

  function openFile(block) {
    const line = firstLine(block);
    if (line) vscode.postMessage({ type: "open", path: block.getAttribute("data-file"), line });
  }

  function onClickCapture(e) {
    if (!e.target.closest) return;
    const head = e.target.closest(".file-h .path");
    if (head) {
      const block = head.closest(".file[data-file]");
      if (block) openFile(block);
      return;
    }
    const ln = e.target.closest("table.diff td.ln");
    if (ln) {
      const isNew = ln.cellIndex === 1 || ln.classList.contains("nl");
      const file = ln.closest("[data-file]");
      if (!isNew || !file || !ln.textContent.trim() || e.altKey) return;
      e.stopPropagation();
      vscode.postMessage({ type: "open", path: file.getAttribute("data-file"), line: parseInt(ln.textContent, 10) });
      return;
    }
    if (!(e.metaKey || e.ctrlKey)) return;
    const w = wordAt(e);
    if (!w) return;
    e.preventDefault();
    e.stopPropagation();
    hideTip();
    vscode.postMessage({ type: e.shiftKey ? "references" : "definition", path: w.path, line: w.line, col: w.col, word: w.word });
  }

  function addHint() {
    const keys = document.querySelector(".rail .shortcuts p");
    if (!keys) return;
    const mac = /Mac/.test(navigator.platform);
    const k = mac ? "⌘" : "Ctrl";
    keys.insertAdjacentHTML(
      "beforeend",
      `<br><b>In VS Code</b><br>hover a name: its type and docs<br><kbd>${k}</kbd>-click: go to definition<br>` +
        `<kbd>⇧</kbd><kbd>${k}</kbd>-click: find references<br>click a line number: open it beside` +
        `<br><kbd>⌥</kbd>-click a line number: copy path:line`,
    );
  }

  const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : "");

  function outline() {
    const chapters = [...document.querySelectorAll("#toc > li")].map((li) => {
      const a = li.querySelector("a");
      const ch = li.getAttribute("data-ch");
      const box = ch && document.querySelector(`.seen-toggle input[data-ch="${ch}"]`);
      return {
        href: a.getAttribute("href"), n: text(a.querySelector(".n")), title: text(a.querySelector(".t")),
        read: box ? box.checked : null,
        dots: [...a.querySelectorAll(".dot")].map((d) => ({ sev: (d.className.match(/s-(\w+)/) || [])[1] || "", count: text(d) })),
      };
    });
    const locs = {};
    document.querySelectorAll(".ftable tr").forEach((tr) => {
      const a = tr.querySelector("a[href^='#']");
      if (a) locs[a.getAttribute("href")] = text(tr.querySelector(".loc"));
    });
    const findings = [...document.querySelectorAll(".rail .fl a")].map((a) => ({
      href: a.getAttribute("href"), sev: ((a.querySelector(".sev") || {}).className || "").replace(/.*s-(\w+).*/, "$1"),
      short: text(a.querySelector("span:not(.sev)")), loc: locs[a.getAttribute("href")] || "",
    }));
    const files = [...document.querySelectorAll(".ftree li.tfile")].map((li) => ({
      path: li.getAttribute("data-path"), href: (li.querySelector("a[href^='#']") || { getAttribute: () => "" }).getAttribute("href"),
      viewed: li.classList.contains("is-viewed"), partial: li.classList.contains("is-partial"), meta: text(li.querySelector(".fmeta")),
    }));
    return { title: text(document.querySelector("h1")), chapters, findings, files, viewed: text(document.querySelector(".fcount")) };
  }

  let outlineTimer, lastOutline = "";
  function sendOutline() {
    clearTimeout(outlineTimer);
    outlineTimer = setTimeout(() => {
      const o = outline(), j = JSON.stringify(o);
      if (j !== lastOutline) { lastOutline = j; vscode.postMessage({ type: "outline", outline: o }); }
      const cur = document.querySelector("#toc li.current > a");
      if (cur) vscode.postMessage({ type: "current", href: cur.getAttribute("href") });
    }, 80);
  }

  // The step whose code crosses a line a third of the way down the panel; its notes go to the Notes view.
  let stepKey = null, stepQueued = false;
  function currentStep() {
    const y = window.innerHeight / 3;
    let best = null;
    for (const st of document.querySelectorAll(".step:not(.solo)")) {
      const r = st.getBoundingClientRect();
      if (r.top <= y && r.bottom > 0) best = st;
      if (r.top > y) break;
    }
    return best;
  }
  function sendNotes() {
    stepQueued = false;
    const st = currentStep();
    const key = st ? [...document.querySelectorAll(".step:not(.solo)")].indexOf(st) : -1;
    if (key === stepKey) return;
    stepKey = key;
    if (!st) { vscode.postMessage({ type: "notes", html: "", title: "" }); return; }
    const notes = st.querySelector(".step-notes");
    const copy = notes ? notes.cloneNode(true) : document.createElement("div");
    copy.querySelectorAll(".notes-back, .notes-ch").forEach((n) => n.remove());
    copy.querySelectorAll(".wcol").forEach((n) => { n.classList.remove("aligned"); n.removeAttribute("style"); });
    copy.querySelectorAll(".wnote").forEach((n) => { n.removeAttribute("style"); n.classList.remove("ws-on"); });
    const ch = st.closest(".chapter");
    const label = text(notes && notes.querySelector(".notes-ch")) || text(ch && ch.querySelector("h2"));
    const files = [...st.querySelectorAll(".step-code .file[data-file]")].map((f) => ({ path: f.getAttribute("data-file"), line: firstLine(f) }));
    vscode.postMessage({ type: "notes", html: copy.innerHTML, title: label, files });
  }
  const queueNotes = () => { if (!stepQueued) { stepQueued = true; requestAnimationFrame(sendNotes); } };

  function light(ws, on) {
    document.querySelectorAll(`[data-ws="${ws}"]`).forEach((el) => el.classList.toggle("ws-on", on));
  }

  function jumpTo(href) {
    const a = document.createElement("a");
    a.href = href;
    a.hidden = true;
    document.querySelector("main").appendChild(a);
    a.click();
    a.remove();
  }

  // Programmatic clicks from a GitHub sync must not be written back to GitHub.
  let applying = false;
  const fileRow = (p) => document.querySelector(`.ftree li.tfile[data-path="${CSS.escape(p)}"]`);

  function applyViewed(viewed, listed) {
    const want = new Set(viewed), known = new Set(listed);
    applying = true;
    try {
      document.querySelectorAll(".ftree li.tfile").forEach((li) => {
        if (!known.has(li.getAttribute("data-path"))) return;
        const on = want.has(li.getAttribute("data-path"));
        if (on !== li.classList.contains("is-viewed") && (on || !li.classList.contains("is-partial"))) li.querySelector("input").click();
      });
    } finally {
      applying = false;
    }
  }

  document.addEventListener("change", (e) => {
    const box = !applying && e.target.closest && e.target.closest(".viewed-toggle input[data-path], .ftree input[data-path]");
    if (!box) return;
    const p = box.getAttribute("data-path");
    setTimeout(() => {
      const li = fileRow(p);
      vscode.postMessage({ type: "viewedChange", path: p, viewed: !!li && li.classList.contains("is-viewed") });
    }, 0);
  }, true);

  window.addEventListener("message", (ev) => {
    const m = ev.data || {};
    if (m.type === "syncViewed") {
      applyViewed(m.viewed, m.listed || m.viewed);
    } else if (m.type === "layout") {
      const root = document.documentElement;
      root.classList.toggle("sr-no-rail", !!m.rail);
      root.classList.toggle("sr-no-notes", !!m.notes);
      window.dispatchEvent(new Event("resize"));
      stepKey = null;
      queueNotes();
    } else if (m.type === "goto") {
      jumpTo(m.href);
    } else if (m.type === "setRead") {
      const box = document.querySelector(`.seen-toggle input[data-ch="${m.href.slice(1)}"]`);
      if (box && box.checked !== m.on) box.click();
    } else if (m.type === "setViewed") {
      const box = document.querySelector(`.ftree input[data-path="${CSS.escape(m.path)}"]`);
      if (box && box.checked !== m.on) box.click();
    } else if (m.type === "view") {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: m.key, bubbles: true }));
    } else if (m.type === "open") {
      vscode.postMessage(m);
    } else if (m.type === "light") {
      light(m.ws, m.on);
    } else if (m.type === "step") {
      const mark = [...document.querySelectorAll(`.wmark[data-ws="${m.ws}"]`)].find((x) => x.getClientRects().length);
      if (mark) mark.closest("tr").scrollIntoView({ block: "center", behavior: "instant" });
    }
  });

  function initSides() {
    sendOutline();
    document.addEventListener("change", sendOutline, true);
    const watch = document.querySelector(".rail");
    if (watch) new MutationObserver(sendOutline).observe(watch, { subtree: true, attributes: true, attributeFilter: ["class"] });
    window.addEventListener("scroll", queueNotes, { passive: true });
    window.addEventListener("resize", queueNotes);
    document.addEventListener("mouseover", (e) => {
      const m = e.target.closest && e.target.closest(".wmark");
      if (m) vscode.postMessage({ type: "light", ws: m.getAttribute("data-ws"), on: true });
    });
    document.addEventListener("mouseout", (e) => {
      const m = e.target.closest && e.target.closest(".wmark");
      if (m) vscode.postMessage({ type: "light", ws: m.getAttribute("data-ws"), on: false });
    });
    document.addEventListener("click", (e) => {
      const m = e.target.closest && e.target.closest(".wmark");
      if (m && document.documentElement.classList.contains("sr-no-notes")) vscode.postMessage({ type: "focusNote", ws: m.getAttribute("data-ws") });
    });
    queueNotes();
    vscode.postMessage({ type: "ready" });
  }

  document.addEventListener("DOMContentLoaded", () => {
    followTheme();
    new MutationObserver(followTheme).observe(document.body, { attributes: true, attributeFilter: ["class"] });
    tip = document.createElement("div");
    tip.className = "sr-tip";
    tip.hidden = true;
    tip.addEventListener("mouseenter", () => { overTip = true; clearTimeout(timer); });
    tip.addEventListener("mouseleave", () => { overTip = false; hideTip(); });
    document.body.appendChild(tip);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("click", onClickCapture, true);
    document.addEventListener("scroll", () => { if (!overTip) hideTip(); }, true);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideTip(); });
    document.documentElement.classList.toggle("sr-mod", false);
    window.addEventListener("keydown", (e) => { if (e.metaKey || e.ctrlKey) document.documentElement.classList.add("sr-mod"); });
    window.addEventListener("keyup", (e) => { if (!e.metaKey && !e.ctrlKey) document.documentElement.classList.remove("sr-mod"); });
    window.addEventListener("blur", () => document.documentElement.classList.remove("sr-mod"));
    addHint();
    document.querySelectorAll(".file[data-file] .file-h .path").forEach((el) => {
      const block = el.closest(".file[data-file]");
      if (!firstLine(block)) return;
      el.classList.add("sr-open");
      el.setAttribute("role", "link");
      el.tabIndex = 0;
      el.title = "Open the file beside the review";
      el.addEventListener("keydown", (e) => { if (e.key === "Enter") openFile(block); });
    });
    const files = document.querySelector(".files-box");
    if (files && window.innerWidth > 640) files.open = true;
    initSides();
  });
})();
