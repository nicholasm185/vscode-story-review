(function () {
  var script = document.currentScript;
  var KEY = (script && script.getAttribute("data-key")) || "review";

  function load(name) {
    try { return JSON.parse(localStorage.getItem(KEY + "-" + name) || "{}") || {}; } catch (e) { return {}; }
  }

  function save(name, value) {
    try { localStorage.setItem(KEY + "-" + name, JSON.stringify(value)); } catch (e) {}
  }

  var seen = load("review-seen");
  var copied = load("copied");

  function paintChapter(ch, on) {
    var li = document.querySelector('#toc li[data-ch="' + ch + '"]');
    if (li) li.classList.toggle("seen", on);
  }

  document.querySelectorAll(".seen-toggle input").forEach(function (box) {
    var ch = box.getAttribute("data-ch");
    box.checked = !!seen[ch];
    paintChapter(ch, box.checked);
    box.addEventListener("change", function () {
      seen[ch] = box.checked;
      paintChapter(ch, box.checked);
      save("review-seen", seen);
      paintClosing();
    });
  });

  // Viewed is kept per part: a file split across chapters is viewed once every part is.
  var viewed = load("viewed-parts");
  var headBoxes = document.querySelectorAll(".file-h input[data-part]");
  var railBoxes = document.querySelectorAll(".ftree input[data-path]");
  var rows = document.querySelectorAll(".ftree li[data-path]");
  var partsOf = {};
  document.querySelectorAll(".file[data-path][id]").forEach(function (f) {
    var p = f.getAttribute("data-path");
    (partsOf[p] = partsOf[p] || []).push(f.id);
  });

  function idsOf(path) { return partsOf[path] || ["path:" + path]; }

  var legacy = load("viewed");
  if (Object.keys(legacy).length) {
    Object.keys(legacy).forEach(function (p) {
      if (legacy[p]) idsOf(p).forEach(function (id) { viewed[id] = true; });
    });
    save("viewed-parts", viewed);
    try { localStorage.removeItem(KEY + "-viewed"); } catch (e) {}
  }

  function countOf(path) {
    var ids = idsOf(path), n = 0;
    ids.forEach(function (id) { if (viewed[id]) n++; });
    return { n: n, of: ids.length, full: n === ids.length };
  }

  function paintFiles() {
    var done = 0;
    rows.forEach(function (li) {
      var c = countOf(li.getAttribute("data-path"));
      var partial = c.n > 0 && !c.full;
      li.classList.toggle("is-viewed", c.full);
      li.classList.toggle("is-partial", partial);
      var box = li.querySelector("input[data-path]");
      if (box) { box.checked = c.full; box.indeterminate = partial; }
      var parts = li.querySelector(".fparts");
      if (parts) parts.textContent = partial ? c.n + "/" + c.of + " viewed" : c.of + " parts";
      if (c.full) done++;
    });
    document.querySelectorAll(".ftree .tdir").forEach(function (dir) {
      var leaves = dir.querySelectorAll("li[data-path]");
      var n = 0;
      leaves.forEach(function (li) { if (countOf(li.getAttribute("data-path")).full) n++; });
      var prog = dir.querySelector(":scope > details > summary .dprog");
      if (prog) prog.textContent = n + "/" + leaves.length;
      dir.classList.toggle("is-done", leaves.length > 0 && n === leaves.length);
    });
    document.querySelectorAll(".file[data-path][id]").forEach(function (f) {
      f.classList.toggle("is-viewed", !!viewed[f.id]);
    });
    headBoxes.forEach(function (b) { b.checked = !!viewed[b.getAttribute("data-part")]; });
    document.querySelectorAll("a.pj[data-jump]").forEach(function (a) {
      var on = !!viewed[a.getAttribute("data-jump")];
      a.classList.toggle("is-viewed", on);
      a.setAttribute("aria-label", a.getAttribute("data-label") + (on ? ", viewed" : ""));
    });
    var count = document.querySelector(".fcount");
    if (count) count.textContent = done + " / " + rows.length + " viewed";
    var bar = document.querySelector(".fbar > span");
    if (bar) bar.style.width = rows.length ? (100 * done / rows.length) + "%" : "0";
    paintClosing();
  }

  function paintClosing() {
    var box = document.querySelector(".closing");
    if (!box) return;
    var files = box.querySelectorAll(".cl-files li[data-path]");
    var done = 0;
    files.forEach(function (li) {
      var c = countOf(li.getAttribute("data-path"));
      li.hidden = c.full;
      if (c.full) done++;
      var parts = li.querySelector(".cl-parts");
      if (parts) parts.textContent = c.n > 0 && !c.full ? c.n + "/" + c.of + " parts viewed" : "";
      var link = li.querySelector("a[href^='#']");
      var next = idsOf(li.getAttribute("data-path")).filter(function (id) { return !viewed[id]; })[0];
      if (link && next && partsOf[li.getAttribute("data-path")]) link.setAttribute("href", "#" + next);
    });
    var fs = box.querySelector('[data-sum="files"]');
    if (fs) fs.textContent = done === files.length ? "All " + files.length + " files viewed."
      : done + " of " + files.length + " files viewed. Still to view:";
    box.querySelectorAll(".cl-finds li[data-fid]").forEach(function (li) {
      var on = !!copied[li.getAttribute("data-fid")];
      li.classList.toggle("is-done", on);
      var st = li.querySelector(".cl-state");
      if (st) st.textContent = on ? "copied" : "not copied yet";
    });
    var chs = document.querySelectorAll(".seen-toggle input");
    var read = 0;
    chs.forEach(function (b) { if (b.checked) read++; });
    var cs = box.querySelector('[data-sum="chapters"]');
    if (cs) cs.textContent = read + " of " + chs.length + " marked read.";
  }

  function setViewed(ids, on) {
    ids.forEach(function (id) { if (on) viewed[id] = true; else delete viewed[id]; });
    save("viewed-parts", viewed);
    paintFiles();
  }

  headBoxes.forEach(function (b) {
    b.addEventListener("change", function () { setViewed([b.getAttribute("data-part")], b.checked); });
  });
  railBoxes.forEach(function (b) {
    b.addEventListener("change", function () { setViewed(idsOf(b.getAttribute("data-path")), b.checked); });
  });

  // A jump into a collapsed section lands nowhere unless every details around the target opens first.
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[href^='#']");
    var target = a && a.getAttribute("href").length > 1 && document.getElementById(a.getAttribute("href").slice(1));
    for (var el = target && target.parentElement; el; el = el.parentElement) {
      if (el.tagName === "DETAILS") el.open = true;
    }
  });

  paintFiles();

  var filesBox = document.querySelector(".files-box");
  if (filesBox && window.matchMedia && window.matchMedia("(max-width: 980px)").matches) filesBox.open = false;

  var tocLinks = {};
  document.querySelectorAll("#toc a[href^='#']").forEach(function (a) { tocLinks[a.getAttribute("href").slice(1)] = a; });
  if ("IntersectionObserver" in window) {
    var current = null;
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        var a = tocLinks[e.target.id];
        if (!e.isIntersecting || !a || a === current) return;
        if (current) { current.removeAttribute("aria-current"); current.parentElement.classList.remove("current"); }
        current = a;
        a.setAttribute("aria-current", "location");
        a.parentElement.classList.add("current");
      });
    }, { rootMargin: "-15% 0px -80% 0px" });
    Object.keys(tocLinks).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) spy.observe(el);
    });
  }

  // The chapter bar sticks, so once the heading scrolls under it the bar shows the title itself.
  var chapterBars = [];
  document.querySelectorAll(".chapter").forEach(function (ch) {
    var head = ch.querySelector(":scope > .ch-head"), h2 = ch.querySelector(":scope > h2");
    if (!head || !h2) return;
    var title = document.createElement("span");
    title.className = "ch-t";
    title.setAttribute("aria-hidden", "true");
    title.textContent = h2.textContent;
    var num = head.querySelector(".ch-num");
    head.insertBefore(title, num ? num.nextSibling : head.firstChild);
    chapterBars.push({ head: head, h2: h2 });
  });

  // Checked on scroll, not with an observer: a jump can carry the heading from below the screen to above it without crossing it.
  function paintChapterBars() {
    chapterBars.forEach(function (c) {
      c.head.classList.toggle("stuck", c.h2.getBoundingClientRect().bottom < c.head.getBoundingClientRect().bottom);
    });
  }
  var barsQueued = false;
  function queueChapterBars() {
    if (barsQueued) return;
    barsQueued = true;
    requestAnimationFrame(function () { barsQueued = false; paintChapterBars(); });
  }
  window.addEventListener("scroll", queueChapterBars, { passive: true });
  window.addEventListener("resize", queueChapterBars);
  paintChapterBars();

  // Created up front, so a screen reader is already watching it when the first message lands.
  var toast = document.createElement("div");
  toast.className = "toast";
  toast.setAttribute("role", "status");
  document.body.appendChild(toast);

  function showToast(text, ms) {
    toast.textContent = text;
    toast.classList.add("show");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(function () { toast.classList.remove("show"); }, ms || 2000);
  }

  function copyText(text) {
    function manual() {
      showToast(text, 8000);
      var range = document.createRange();
      range.selectNodeContents(toast);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    try {
      navigator.clipboard.writeText(text).then(function () { showToast("Copied " + text); }, manual);
    } catch (e) { manual(); }
  }

  document.addEventListener("click", function (e) {
    if (!e.target.closest) return;
    var btn = e.target.closest(".copy-path");
    if (btn) {
      copyText(btn.getAttribute("data-copy"));
      return;
    }
    var td = e.target.closest("table.diff td.ln");
    if (!td || !(td.cellIndex === 1 || td.classList.contains("nl")) || !td.textContent.trim()) return;
    var file = td.closest("[data-file]");
    if (file) copyText(file.getAttribute("data-file") + ":" + td.textContent.trim());
  });

  document.querySelectorAll("button.copy").forEach(function (btn) {
    var card = btn.closest(".finding");
    var fid = card && card.id;
    function markCopied() {
      btn.textContent = "Copied";
      btn.classList.add("done");
      btn.title = "Copy the PR comment again";
    }
    if (fid && copied[fid]) markCopied();
    btn.addEventListener("click", function () {
      var src = card && card.querySelector("script.md");
      if (!src) return;
      var text = src.textContent.trim();
      function fallback() {
        var ta = card.querySelector("textarea.fallback");
        if (!ta) {
          ta = document.createElement("textarea");
          ta.className = "fallback";
          ta.readOnly = true;
          ta.setAttribute("aria-label", "PR comment text");
          card.appendChild(ta);
        }
        ta.value = text;
        ta.focus();
        ta.select();
        btn.textContent = "Select and copy below";
      }
      try {
        navigator.clipboard.writeText(text).then(function () {
          markCopied();
          if (fid) { copied[fid] = true; save("copied", copied); }
          paintClosing();
          showToast("Copied the PR comment");
        }, fallback);
      } catch (e) { fallback(); }
    });
  });

  // Single-key shortcuts can be switched off in the rail (WCAG 2.1.4).
  var prefs = load("prefs");
  var keysOn = prefs.keys !== false;
  var keysBox = document.querySelector(".keys-toggle input");
  if (keysBox) {
    keysBox.checked = keysOn;
    keysBox.addEventListener("change", function () {
      keysOn = keysBox.checked;
      prefs.keys = keysOn;
      save("prefs", prefs);
    });
  }

  var root = document.documentElement;
  var main = document.querySelector("main");
  var rail = document.querySelector("nav.rail");
  var codeColumn = document.querySelector(".step:not(.solo) > .step-code") || main;
  var SPLIT_MIN = 900;
  var VIEWS = {
    rail: { key: "c", label: "Contents", what: "the contents", icon: '<path class="pane" d="M1.5 4.5a2 2 0 0 1 2-2H6v11H3.5a2 2 0 0 1-2-2z"/>',
      away: "The contents sit above the review at this width." },
    notes: { key: "t", label: "Notes", what: "the notes", icon: '<path class="pane" d="M10 2.5h2.5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H10z"/>',
      away: "The notes sit above the code at this width." },
    split: { key: "s", label: "Split", icon: '<path d="M8 2.5v11"/>',
      away: "Split view needs a wider code column. Hide a panel or widen the window." },
    walk: { key: "w", label: "Steps", what: "the walkthrough", icon: '<path d="M4 5.5h8M4 8h8M4 10.5h5"/>', away: "" }
  };
  if (!document.querySelector(".wnote")) delete VIEWS.walk;
  var viewButtons = {};
  var splitOn = false;
  var splitTables = null;

  function wide(px) { return !window.matchMedia || window.matchMedia("(min-width: " + px + "px)").matches; }

  function viewFits(name) {
    if (name === "rail") return wide(981);
    if (name === "notes") return wide(1360);
    if (name === "walk") return true;
    return codeColumn.getBoundingClientRect().width >= SPLIT_MIN;
  }

  function viewOn(name) {
    if (name === "split") return prefs.split === true && viewFits("split");
    return prefs[name] !== false || !viewFits(name);
  }

  function halfRow(tr, isNew) {
    if (!tr) {
      var nil = document.createElement("td");
      nil.colSpan = 3;
      nil.className = "nil";
      return [nil];
    }
    var kind = tr.classList.contains("add") ? " add" : tr.classList.contains("del") ? " del" : "";
    var ln = document.createElement("td");
    ln.className = "ln" + (isNew ? " nl" : "") + kind;
    ln.textContent = tr.cells[isNew ? 1 : 0].textContent;
    var sign = tr.cells[2].cloneNode(true);
    var code = tr.cells[3].cloneNode(true);
    // A step's marker belongs to the new side only, or an unchanged line would show it twice.
    if (!isNew) code.querySelectorAll(".wmark").forEach(function (m) { m.remove(); code.classList.remove("wm"); });
    sign.className += kind;
    code.className += kind;
    return [ln, sign, code];
  }

  // Returns null for a table with lines on one side only (a new or deleted file, a context block): it reads better at full width.
  function splitTable(table) {
    var lines = [], hasOld = false, hasNew = false, digits = 3;
    Array.prototype.forEach.call(table.rows, function (tr) {
      if (tr.classList.contains("pin")) {
        if (lines.length) lines[lines.length - 1].pins.push(tr);
        return;
      }
      var o = tr.cells[0].textContent, n = tr.cells[1].textContent;
      hasOld = hasOld || !!o;
      hasNew = hasNew || !!n;
      digits = Math.max(digits, o.length, n.length);
      lines.push({ tr: tr, kind: tr.classList.contains("add") ? "add" : tr.classList.contains("del") ? "del" : "ctx", pins: [] });
    });
    if (!hasOld || !hasNew) return null;

    var sp = document.createElement("table");
    sp.className = table.className + " sp";
    sp.hidden = true;
    sp.style.setProperty("--lnw", digits);
    sp.innerHTML = '<colgroup><col class="c-ln"><col class="c-sg"><col><col class="c-ln"><col class="c-sg"><col></colgroup><tbody></tbody>';
    var body = sp.tBodies[0], pins = [];

    function moveRow(src) {
      var row = body.insertRow();
      row.className = src.className;
      var td = row.insertCell();
      td.colSpan = 6;
      row._twin = src;
      src._twin = row;
      pins.push([src.cells[0], td]);
    }

    // A step lights the half it covers: the new side, and the old side only for the removed lines it replaces.
    function stepHalf(half, ws) {
      if (!ws) return;
      half.forEach(function (td) { td.setAttribute("data-ws", ws); });
      half[0].className += " wsb";
    }

    function emit(left, right) {
      var tr = body.insertRow();
      var oldHalf = halfRow(left && left.tr, false), newHalf = halfRow(right && right.tr, true);
      var cells = oldHalf.concat(newHalf);
      cells[left ? 3 : 1].className += " rs";
      stepHalf(oldHalf, left && left.kind === "del" && left.tr.getAttribute("data-ws"));
      stepHalf(newHalf, right && right.tr.getAttribute("data-ws"));
      cells.forEach(function (td) { tr.appendChild(td); });
      tr._twin = (left || right).tr;
      [left, right].forEach(function (line) {
        if (!line || line.tr._twin) return;
        line.tr._twin = tr;
        line.pins.forEach(moveRow);
      });
    }

    for (var i = 0; i < lines.length;) {
      if (lines[i].kind === "ctx") { emit(lines[i], lines[i]); i++; continue; }
      var dels = [], adds = [];
      while (i < lines.length && lines[i].kind === "del") dels.push(lines[i++]);
      while (i < lines.length && lines[i].kind === "add") adds.push(lines[i++]);
      for (var k = 0; k < Math.max(dels.length, adds.length); k++) emit(dels[k], adds[k]);
    }
    table.parentNode.appendChild(sp);
    return { unified: table, split: sp, pins: pins };
  }

  // A finding card exists once (its id, its copy button), so it moves between the two tables.
  function setSplit(on) {
    if (on && !splitTables) {
      splitTables = [];
      document.querySelectorAll(".file:not(.context) table.diff").forEach(function (table) {
        var made = splitTable(table);
        if (made) splitTables.push(made);
      });
    }
    (splitTables || []).forEach(function (t) {
      t.unified.hidden = on;
      t.split.hidden = !on;
      t.pins.forEach(function (pin) {
        var from = pin[on ? 0 : 1], to = pin[on ? 1 : 0];
        while (from.firstChild) to.appendChild(from.firstChild);
      });
    });
    splitOn = on;
  }

  function syncView() {
    root.classList.toggle("rail-off", prefs.rail === false);
    root.classList.toggle("notes-off", prefs.notes === false);
    root.classList.toggle("walk-off", !!VIEWS.walk && prefs.walk === false);
    // Collapsed, the contents show only chapter numbers, so each link names its chapter on hover.
    document.querySelectorAll("#toc a").forEach(function (a) {
      var t = a.querySelector(".t");
      if (prefs.rail === false && viewFits("rail") && t) a.title = t.textContent; else a.removeAttribute("title");
    });
    if (viewOn("split") !== splitOn) setSplit(!splitOn);
    scheduleWalks();
    Object.keys(viewButtons).forEach(function (name) {
      var v = VIEWS[name], btn = viewButtons[name], on = viewOn(name), fits = viewFits(name);
      btn.setAttribute("aria-pressed", String(on));
      if (fits) btn.removeAttribute("aria-disabled"); else btn.setAttribute("aria-disabled", "true");
      btn.title = !fits ? v.away
        : name === "split" ? (on ? "Show the diff unified (s)" : "Show the diff side by side (s)")
        : (on ? "Hide " : "Show ") + v.what + " (" + v.key + ")";
    });
  }

  function anchorAt() {
    var box = main.getBoundingClientRect();
    var x = box.left + Math.min(120, box.width / 2);
    for (var y = 90; y < window.innerHeight; y += 60) {
      var el = document.elementFromPoint(x, y);
      if (!el || !main.contains(el) || el.closest(".file-h, .ch-head")) continue;
      el = el.closest("tr") || el;
      if (!el.matches("main, section, details, .steps, .step, .step-code, .step-notes, .file, .scroll")) return el;
    }
    return null;
  }

  // Hiding a panel or splitting the diff rewraps the code, so the line being read is put back where it was.
  function keepPlace(change) {
    var el = window.scrollY > 0 ? anchorAt() : null;
    var top = el && el.getBoundingClientRect().top;
    change();
    if (el && !shown(el)) el = el._twin;
    if (el && shown(el)) window.scrollBy({ top: el.getBoundingClientRect().top - top, behavior: "instant" });
  }

  function toggleView(name, viaKey) {
    if (!viewFits(name)) { showToast(VIEWS[name].away, 4000); return; }
    var on = !viewOn(name);
    keepPlace(function () {
      prefs[name] = on;
      save("prefs", prefs);
      syncView();
    });
    var active = document.activeElement;
    if (active && active !== document.body && !shown(active)) viewButtons[name].focus({ preventScroll: true });
    if (viaKey) showToast(name === "split" ? (on ? "Split diff" : "Unified diff") : VIEWS[name].label + (on ? " shown" : " hidden"));
  }

  if (rail && main) {
    var bar = document.createElement("div");
    bar.className = "viewbar";
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", "View");
    Object.keys(VIEWS).forEach(function (name) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="2"/>' +
        VIEWS[name].icon + '</svg><span class="vb-t">' + VIEWS[name].label + "</span>";
      btn.addEventListener("click", function () { toggleView(name); });
      viewButtons[name] = btn;
      bar.appendChild(btn);
    });
    rail.insertBefore(bar, rail.firstChild);

    document.querySelectorAll(".step:not(.solo) > .step-notes").forEach(function (aside) {
      var back = document.createElement("button");
      back.type = "button";
      back.className = "notes-back";
      back.innerHTML = "Notes hidden <span>Show notes</span>";
      back.addEventListener("click", function () { toggleView("notes"); });
      aside.appendChild(back);
    });

    syncView();
    var resizing = false;
    window.addEventListener("resize", function () {
      if (resizing) return;
      resizing = true;
      requestAnimationFrame(function () {
        resizing = false;
        if (viewOn("split") !== splitOn) keepPlace(syncView); else syncView();
      });
    });
  }

  function shown(el) { return el.getClientRects().length > 0; }

  function markOf(ws) {
    return Array.prototype.filter.call(document.querySelectorAll('.wmark[data-ws="' + ws + '"]'), shown)[0] || null;
  }

  // Each note sits level with its marker, pushed down only as far as the note above it needs.
  function layoutWalks() {
    var aligned = !!VIEWS.walk && viewOn("walk") && viewOn("notes") && wide(1360);
    document.querySelectorAll(".wcol").forEach(function (col) {
      var notes = col.querySelectorAll(".wnote");
      col.classList.toggle("aligned", aligned);
      if (!aligned) {
        notes.forEach(function (li) { li.style.top = ""; });
        col.style.height = "";
        return;
      }
      var base = col.getBoundingClientRect().top, floor = 0;
      notes.forEach(function (li) {
        var mark = markOf(li.getAttribute("data-ws"));
        var y = Math.max(mark ? mark.getBoundingClientRect().top - base - 3 : floor, floor);
        li.style.top = y + "px";
        floor = y + li.offsetHeight + 6;
      });
      col.style.height = floor + "px";
    });
  }

  var walksQueued = false;
  function scheduleWalks() {
    if (walksQueued || !document.querySelector(".wcol")) return;
    walksQueued = true;
    requestAnimationFrame(function () { walksQueued = false; layoutWalks(); });
  }

  function lightStep(ws, on) {
    document.querySelectorAll('[data-ws="' + ws + '"]').forEach(function (el) { el.classList.toggle("ws-on", on); });
  }

  if (document.querySelector(".wcol")) {
    ["mouseover", "focusin"].forEach(function (type) {
      document.addEventListener(type, function (e) {
        var el = e.target.closest && e.target.closest(".wnote, .wmark");
        if (el) lightStep(el.getAttribute("data-ws"), true);
      });
    });
    ["mouseout", "focusout"].forEach(function (type) {
      document.addEventListener(type, function (e) {
        var el = e.target.closest && e.target.closest(".wnote, .wmark");
        if (el && !(e.relatedTarget && el.contains(e.relatedTarget))) lightStep(el.getAttribute("data-ws"), false);
      });
    });
    document.addEventListener("click", function (e) {
      var num = e.target.closest(".wnote .wnum"), mark = e.target.closest(".wmark");
      if (num) {
        var m = markOf(num.parentNode.getAttribute("data-ws"));
        if (m) m.closest("tr").scrollIntoView({ block: "center", behavior: "instant" });
      } else if (mark) {
        e.preventDefault();
        var note = document.getElementById(mark.getAttribute("data-ws"));
        var box = note && shown(note) && note.getBoundingClientRect();
        if (box && (box.top < 0 || box.bottom > window.innerHeight)) note.scrollIntoView({ block: "center", behavior: "instant" });
        if (note) note.querySelector(".wnum").focus({ preventScroll: true });
      }
    });
    window.addEventListener("resize", scheduleWalks);
    document.addEventListener("toggle", scheduleWalks, true);
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(scheduleWalks);
      document.querySelectorAll(".step.has-walk > .step-code").forEach(function (el) { ro.observe(el); });
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleWalks);
    scheduleWalks();
  }
  function restAt(el) {
    var pad = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
    return pad + (parseFloat(getComputedStyle(el).scrollMarginTop) || 0);
  }

  function jump(selector, dir) {
    var els = Array.prototype.filter.call(document.querySelectorAll(selector), shown);
    if (dir < 0) els.reverse();
    for (var i = 0; i < els.length; i++) {
      var gap = els[i].getBoundingClientRect().top - restAt(els[i]);
      if (dir > 0 ? gap > 2 : gap < -2) {
        els[i].scrollIntoView({ block: "start", behavior: "instant" });
        return els[i];
      }
    }
    return null;
  }

  function fileAtTop() {
    var y = (parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0) + 24;
    var els = document.querySelectorAll(".file[data-path][id]");
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      if (r.top <= y && r.bottom > y && shown(els[i])) return els[i];
    }
    return null;
  }

  document.addEventListener("keydown", function (e) {
    if (!keysOn || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
    var t = e.target;
    if (t && (t.isContentEditable || t.tagName === "TEXTAREA" || t.tagName === "SELECT" ||
      (t.tagName === "INPUT" && !/^(checkbox|radio|button|submit)$/.test(t.type)))) return;
    var k = e.key;
    if (k === "j" || k === "k") {
      if (!jump(".file[data-path][id]", k === "j" ? 1 : -1)) showToast(k === "j" ? "No file below" : "No file above");
    } else if (k === "n" || k === "p") {
      if (!jump(".finding[id]", k === "n" ? 1 : -1)) showToast(k === "n" ? "No finding below" : "No finding above");
    } else if (k === "v") {
      var f = fileAtTop();
      var box = f && f.querySelector(".file-h input[data-part]");
      if (!box) { showToast("No file at the top of the screen"); return; }
      box.checked = !box.checked;
      box.dispatchEvent(new Event("change"));
      showToast((box.checked ? "Viewed " : "Not viewed ") + f.getAttribute("data-path"));
    } else if (k === "c" || k === "t" || k === "s" || k === "w") {
      var view = { c: "rail", t: "notes", s: "split", w: "walk" }[k];
      if (!viewButtons[view]) return;
      toggleView(view, true);
    } else {
      return;
    }
    e.preventDefault();
  });
})();
