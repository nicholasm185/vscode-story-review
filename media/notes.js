(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("notes");
  const title = document.getElementById("title");
  const EMPTY = '<p class="sr-empty">Scroll to a chapter’s code and its notes show here.</p>';

  function followTheme() {
    const c = document.body.classList;
    document.documentElement.dataset.theme = c.contains("vscode-light") || c.contains("vscode-high-contrast-light") ? "light" : "dark";
  }
  followTheme();
  new MutationObserver(followTheme).observe(document.body, { attributes: true, attributeFilter: ["class"] });

  function show(m) {
    title.textContent = m.title || "";
    if (m.files && m.files.length) {
      const f = document.createElement("div");
      f.className = "sr-files";
      m.files.forEach((file, i) => {
        if (i) f.append(" · ");
        const name = file.path.slice(file.path.lastIndexOf("/") + 1);
        if (!file.line) { f.append(name); return; }
        const a = document.createElement("a");
        a.href = "#";
        a.textContent = name;
        a.title = `Open ${file.path} beside the review`;
        a.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          vscode.postMessage({ type: "open", path: file.path, line: file.line });
        });
        f.appendChild(a);
      });
      title.appendChild(f);
    }
    root.innerHTML = m.html ? `<aside class="step-notes">${m.html}</aside>` : EMPTY;
    window.scrollTo(0, 0);
  }

  window.addEventListener("message", (ev) => {
    const m = ev.data || {};
    if (m.type === "notes") show(m);
    else if (m.type === "light") root.querySelectorAll(`[data-ws="${m.ws}"]`).forEach((el) => el.classList.toggle("ws-on", m.on));
    else if (m.type === "focusNote") {
      const li = root.querySelector(`.wnote[data-ws="${m.ws}"]`);
      if (!li) return;
      li.scrollIntoView({ block: "center" });
      li.classList.add("sr-flash");
      setTimeout(() => li.classList.remove("sr-flash"), 900);
    }
  });

  let lit = null;
  function light(li, on) {
    li.classList.toggle("ws-on", on);
    vscode.postMessage({ type: "light", ws: li.getAttribute("data-ws"), on });
  }
  root.addEventListener("mouseover", (e) => {
    const li = e.target.closest(".wnote");
    if (li === lit) return;
    if (lit) light(lit, false);
    lit = li;
    if (li) light(li, true);
  });
  root.addEventListener("mouseleave", () => {
    if (lit) light(lit, false);
    lit = null;
  });
  root.addEventListener("click", (e) => {
    const a = e.target.closest("a[href]");
    if (a) {
      const href = a.getAttribute("href");
      if (href.startsWith("#")) {
        e.preventDefault();
        vscode.postMessage({ type: "goto", href });
      }
      return;
    }
    const li = e.target.closest(".wnote");
    if (li) vscode.postMessage({ type: "step", ws: li.getAttribute("data-ws") });
  });
})();
