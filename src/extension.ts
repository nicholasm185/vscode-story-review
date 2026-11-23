import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { randomBytes } from "crypto";
import { Hub, Outline, PanelLink } from "./views";
import { Run, Tokenizer, langOf, overlay, semanticColor, semanticOn, themeIdFor } from "./tokens";

const run = promisify(execFile);
const PENDING = "storyReview.pending";
const tokenizer = new Tokenizer();
let channel: vscode.OutputChannel | undefined;
const log = (line: string) => (channel ??= vscode.window.createOutputChannel("Story Review")).appendLine(line);

type Side = "old" | "new";
interface PaintRequest {
  theme?: { name?: string; kind?: string };
  files: Record<string, Partial<Record<Side, number[]>>>;
}

function configuredTheme(dark: boolean): string | undefined {
  const w = vscode.workspace.getConfiguration("workbench");
  if (vscode.workspace.getConfiguration("window").get<boolean>("autoDetectColorScheme")) {
    return w.get<string>(dark ? "preferredDarkColorTheme" : "preferredLightColorTheme");
  }
  return w.get<string>("colorTheme");
}

interface Meta {
  repo: string;
  pr: number;
  base: string;
  head: string;
  verdict?: string;
  reviewed?: string;
}

interface Review {
  dir: string;
  meta: Meta;
  mtime: number;
}

function reviewsRoot(): string {
  const raw = vscode.workspace.getConfiguration("storyReview").get<string>("reviewsRoot", "~/.claude/story-reviews");
  return raw.replace(/^~(?=$|\/)/, os.homedir());
}

function listReviews(): Review[] {
  const root = reviewsRoot();
  const out: Review[] = [];
  for (const repo of safeReaddir(root)) {
    for (const pr of safeReaddir(path.join(root, repo))) {
      const dir = path.join(root, repo, pr);
      const page = path.join(dir, "page.html");
      const meta = path.join(dir, "meta.json");
      if (!pr.startsWith("pr-") || !fs.existsSync(page) || !fs.existsSync(meta)) continue;
      try {
        out.push({ dir, meta: JSON.parse(fs.readFileSync(meta, "utf8")), mtime: fs.statSync(page).mtimeMs });
      } catch {
        // A half-written meta.json during a build; it shows up on the next listing.
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
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

async function gh(cwd: string, ...args: string[]): Promise<string> {
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

function errText(e: unknown): string {
  const any = e as { stderr?: string; message?: string };
  return (any.stderr || any.message || String(e)).trim().split("\n").slice(-2).join(" ");
}

async function findCheckout(repo: string): Promise<string | undefined> {
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    if (f.uri.scheme !== "file") continue;
    // Any remote counts, so a fork checkout with the real repo as upstream is found too.
    const remotes = await git(f.uri.fsPath, "remote", "-v").catch(() => "");
    if (new RegExp(`[/:]${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\.git)?\\s`, "i").test(remotes)) return f.uri.fsPath;
  }
  return undefined;
}

async function ensureCheckout(ctx: vscode.ExtensionContext, review: Review): Promise<string | undefined> {
  const { pr, head, repo } = review.meta;
  const wt = await findCheckout(repo);
  if (!wt) {
    const choice = await vscode.window.showWarningMessage(
      `Open a checkout of ${repo} as this window's folder, so PR #${pr} can be checked out there.`,
      { modal: true },
      "Open Folder…",
    );
    const picked = choice && (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: "Open Checkout" }));
    if (picked?.[0]) {
      await ctx.globalState.update(PENDING, review.dir);
      await vscode.commands.executeCommand("vscode.openFolder", picked[0]);
    }
    return undefined;
  }
  if ((await git(wt, "rev-parse", "HEAD")).trim() === head) return wt;
  if ((await git(wt, "status", "--porcelain", "--untracked-files=no")).trim()) {
    void vscode.window.showErrorMessage(`${path.basename(wt)} has uncommitted changes. Commit or stash them, then open the review again.`);
    return undefined;
  }
  const branch = (await git(wt, "branch", "--show-current")).trim() || "a detached HEAD";
  const choice = await vscode.window.showInformationMessage(
    `Check out PR #${pr} in ${path.basename(wt)}? It's on ${branch} now.`,
    { modal: true, detail: `Runs gh pr checkout ${pr}, so the files match the review and language features see the PR's code.` },
    "Check Out",
    "Open Without Checking Out",
  );
  if (choice === "Open Without Checking Out") return wt;
  if (choice !== "Check Out") return undefined;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Checking out #${pr}` }, async () => {
    try {
      await gh(wt, "pr", "checkout", String(pr));
    } catch (e) {
      // The PR's branch can only be checked out in one worktree at a time.
      if (!/already (checked out|used by worktree)/.test(errText(e))) throw new Error(errText(e));
      await gh(wt, "pr", "checkout", String(pr), "--branch", `review/pr-${pr}`);
    }
  });
  const now = (await git(wt, "rev-parse", "HEAD")).trim();
  if (now !== head) {
    const newer = await gitOk(wt, "merge-base", "--is-ancestor", head, now);
    const pick = await vscode.window.showWarningMessage(
      newer
        ? `PR #${pr} has commits after the reviewed head ${head.slice(0, 9)}, so some lines on the page may not match the files.`
        : `PR #${pr}'s head ${now.slice(0, 9)} isn't the reviewed head ${head.slice(0, 9)}. The branch was rewritten since the review.`,
      "Check Out the Reviewed Commit",
      "Keep the Branch",
    );
    if (pick === "Check Out the Reviewed Commit") await git(wt, "checkout", "-q", "--detach", head);
  }
  return wt;
}

function toLocation(l: vscode.Location | vscode.LocationLink): { uri: vscode.Uri; range: vscode.Range } {
  return "targetUri" in l ? { uri: l.targetUri, range: l.targetSelectionRange ?? l.targetRange } : { uri: l.uri, range: l.range };
}

function hoverMarkdown(hovers: vscode.Hover[]): string {
  const parts: string[] = [];
  for (const h of hovers) {
    for (const c of h.contents) {
      if (typeof c === "string") parts.push(c);
      else if ("language" in c) parts.push("```" + c.language + "\n" + c.value + "\n```");
      else parts.push(c.value);
    }
  }
  return parts.filter((p) => p.trim()).join("\n\n---\n\n");
}

const VIEWED_QUERY = `query($owner: String!, $name: String!, $n: Int!, $after: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $n) { id
    files(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { path viewerViewedState } } } } }`;

class ReviewPanel implements PanelLink {
  static readonly panels = new Map<string, ReviewPanel>();
  private readonly panel: vscode.WebviewPanel;
  private readonly watcher: vscode.FileSystemWatcher;
  private css = "";
  private prId?: string;
  private github?: Map<string, string>;
  private lastPull = 0;
  private pulling = false;
  private writing: Promise<void> = Promise.resolve();
  private readonly ticks = new Map<string, { on: boolean; at: number }>();
  private readonly queue = new Map<string, boolean>();
  private files: Outline["files"] = [];
  private paintSeq = 0;
  private readonly blobs = new Map<string, Promise<string | undefined>>();

  static show(ctx: vscode.ExtensionContext, hub: Hub, review: Review, wt: string): void {
    const open = ReviewPanel.panels.get(review.dir);
    if (open) {
      open.wt = wt;
      open.panel.reveal();
      return;
    }
    ReviewPanel.panels.set(review.dir, new ReviewPanel(ctx, hub, review, wt));
  }

  private constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly hub: Hub,
    private readonly review: Review,
    private wt: string,
  ) {
    this.panel = vscode.window.createWebviewPanel("storyReview", `Review #${review.meta.pr}`, vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, "media")],
    });
    // A hover fires on every pause of the mouse, and code colours are optional, so their failures stay quiet; clicks report theirs.
    this.panel.webview.onDidReceiveMessage((m) =>
      this.onMessage(m).catch((e) => (m.type === "hover" ? undefined : m.type === "paint" ? log(`Colouring failed: ${errText(e)}`) : this.fail(e))),
    );
    this.panel.onDidDispose(() => {
      this.watcher.dispose();
      ReviewPanel.panels.delete(review.dir);
      if (hub.panel === this) hub.setPanel([...ReviewPanel.panels.values()].pop());
    });
    this.panel.onDidChangeViewState((e) => {
      if (!e.webviewPanel.active) return;
      hub.setPanel(this);
      if (Date.now() - this.lastPull > 15000) void this.pullViewed();
    });
    const config = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("storyReview.colorTheme")) this.post({ type: "repaint" });
    });
    this.panel.onDidDispose(() => config.dispose());
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(review.dir), "page.html"));
    this.watcher.onDidChange(() => this.render());
    this.watcher.onDidCreate(() => this.render());
    this.render();
    hub.setPanel(this);
  }

  post(m: unknown): void {
    void this.panel.webview.postMessage(m);
  }

  reveal(): void {
    this.panel.reveal(this.panel.viewColumn, true);
  }

  style(): string {
    return this.css;
  }

  remote(): Map<string, string> | undefined {
    return this.github;
  }

  // GitHub's Viewed state is the record, except for files the reader ticked since the read began: those win.
  private async pullViewed(): Promise<void> {
    if (this.pulling) return;
    const started = Date.now();
    this.lastPull = started;
    this.pulling = true;
    const [owner, name] = this.review.meta.repo.split("/");
    const state = new Map<string, string>();
    let after: string | undefined;
    try {
      do {
        const args = ["api", "graphql", "-f", `query=${VIEWED_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `n=${this.review.meta.pr}`];
        if (after) args.push("-f", `after=${after}`);
        const pr = JSON.parse(await gh(this.wt, ...args)).data.repository.pullRequest;
        this.prId = pr.id;
        for (const f of pr.files.nodes) state.set(f.path, f.viewerViewedState);
        after = pr.files.pageInfo.hasNextPage ? pr.files.pageInfo.endCursor : undefined;
      } while (after);
    } catch (e) {
      void vscode.window.setStatusBarMessage(`Story Review: couldn't read Viewed marks from GitHub (${errText(e)})`, 8000);
      return;
    } finally {
      this.pulling = false;
    }
    const seededKey = `githubSeeded:${this.review.dir}`;
    if (!this.ctx.globalState.get<boolean>(seededKey) && this.files.length) {
      // The first sync keeps marks made on the page before syncing existed, by sending them to GitHub.
      for (const f of this.files) if (f.viewed && state.get(f.path) === "UNVIEWED") this.ticks.set(f.path, { on: true, at: started });
      await this.ctx.globalState.update(seededKey, true);
    }
    // A write still in flight when the read started may not show in it yet, so recent ticks count as the reader's.
    const fresh = (t: { at: number }) => t.at >= started - 10000;
    const page = new Map(state);
    for (const [file, t] of this.ticks) if (fresh(t) && page.has(file)) page.set(file, t.on ? "VIEWED" : "UNVIEWED");
    this.github = state;
    this.hub.setRemote(this, page);
    this.post({ type: "syncViewed", listed: [...page.keys()], viewed: [...page].filter(([, v]) => v === "VIEWED").map(([p]) => p) });
    for (const [file, t] of this.ticks) if (fresh(t)) this.queue.set(file, t.on);
    await this.flush();
  }

  private async onViewedChange(file: string, on: boolean): Promise<void> {
    this.ticks.set(file, { on, at: Date.now() });
    this.queue.set(file, on);
    await this.flush();
  }

  // Writes run one at a time, so two quick ticks on one file can't land on GitHub out of order.
  private flush(): Promise<void> {
    this.writing = this.writing.then(async () => {
      if (!this.github || !this.prId) return;
      for (const [file, on] of [...this.queue]) {
        this.queue.delete(file);
        const had = this.github.get(file);
        if (had === undefined || (had === "VIEWED") === on) continue;
        const op = on ? "markFileAsViewed" : "unmarkFileAsViewed";
        try {
          await gh(this.wt, "api", "graphql", "-f", `query=mutation($id: ID!, $path: String!) { ${op}(input: {pullRequestId: $id, path: $path}) { clientMutationId } }`,
            "-f", `id=${this.prId}`, "-f", `path=${file}`);
          this.github.set(file, on ? "VIEWED" : "UNVIEWED");
        } catch (e) {
          void vscode.window.showErrorMessage(`Story Review: couldn't ${on ? "mark" : "unmark"} ${file} as viewed on GitHub. ${errText(e)}`);
        }
      }
      this.hub.setRemote(this, this.github);
    });
    return this.writing;
  }

  private get stateKey(): string {
    return `state:${this.review.dir}`;
  }

  private render(): void {
    const page = fs.readFileSync(path.join(this.review.dir, "page.html"), "utf8");
    this.css = /<style>([\s\S]*?)<\/style>/.exec(page)?.[1] ?? "";
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString("base64");
    const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, "media", f));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com`,
      `font-src ${webview.cspSource} https://fonts.gstatic.com`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    const state = JSON.stringify(this.ctx.globalState.get<Record<string, string>>(this.stateKey, {})).replace(/</g, "\\u003c");
    const body = page.replace(/<script(?![^>]*type="text\/markdown")/g, `<script nonce="${nonce}"`);
    webview.html =
      `<!doctype html><html><head><meta charset="utf-8">` +
      `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<link rel="stylesheet" href="${media("bridge.css")}">` +
      `<script nonce="${nonce}">window.__srState = ${state}; window.__srPr = ${this.review.meta.pr};</script>` +
      `<script nonce="${nonce}" src="${media("bridge.js")}"></script>` +
      `</head><body>${body}</body></html>`;
  }

  private uri(rel: string): vscode.Uri {
    return vscode.Uri.file(path.join(this.wt, rel));
  }

  private async besideColumn(): Promise<vscode.ViewColumn> {
    if (vscode.window.tabGroups.all.length === 1) {
      await vscode.commands.executeCommand("vscode.setEditorLayout", { orientation: 0, groups: [{ size: 0.6 }, { size: 0.4 }] });
    }
    return (this.panel.viewColumn ?? vscode.ViewColumn.One) + 1;
  }

  private async onMessage(m: any): Promise<void> {
    switch (m.type) {
      case "ready":
        if (this.hub.panel === this) this.hub.layout();
        void this.pullViewed();
        return;
      case "viewedChange":
        await this.onViewedChange(m.path, !!m.viewed);
        return;
      case "outline":
        this.files = (m.outline as Outline).files;
        this.hub.setOutline(this, m.outline as Outline);
        return;
      case "current":
        this.hub.setCurrent(this, m.href);
        return;
      case "notes":
      case "light":
      case "focusNote":
        this.hub.fromPanel(this, m);
        return;
      case "state": {
        const state = { ...this.ctx.globalState.get<Record<string, string>>(this.stateKey, {}) };
        if (m.value === null) delete state[m.key];
        else state[m.key] = m.value;
        await this.ctx.globalState.update(this.stateKey, state);
        return;
      }
      case "paint":
        await this.paint(m as PaintRequest);
        return;
      case "hover": {
        const uri = this.uri(m.path);
        await vscode.workspace.openTextDocument(uri);
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
          "vscode.executeHoverProvider", uri, new vscode.Position(m.line - 1, m.col),
        );
        const md = hoverMarkdown(hovers ?? []);
        let html = "";
        if (md) {
          try {
            html = await vscode.commands.executeCommand<string>("markdown.api.render", md);
          } catch {
            html = `<pre>${md.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)}</pre>`;
          }
        }
        void this.panel.webview.postMessage({ type: "hover", id: m.id, html });
        return;
      }
      case "definition": {
        const uri = this.uri(m.path);
        await vscode.workspace.openTextDocument(uri);
        const found = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
          "vscode.executeDefinitionProvider", uri, new vscode.Position(m.line - 1, m.col),
        );
        const locs = (found ?? []).map(toLocation);
        if (!locs.length) {
          void vscode.window.setStatusBarMessage(`No definition found for ${m.word}`, 3000);
          return;
        }
        let pick = locs[0];
        if (locs.length > 1) {
          const item = await vscode.window.showQuickPick(
            locs.map((l) => ({ label: `${vscode.workspace.asRelativePath(l.uri)}:${l.range.start.line + 1}`, l })),
            { placeHolder: `${locs.length} definitions of ${m.word}` },
          );
          if (!item) return;
          pick = item.l;
        }
        await vscode.window.showTextDocument(pick.uri, { viewColumn: await this.besideColumn(), selection: pick.range, preview: true });
        return;
      }
      case "references": {
        const pos = new vscode.Position(m.line - 1, m.col);
        await vscode.window.showTextDocument(this.uri(m.path), {
          viewColumn: await this.besideColumn(), selection: new vscode.Range(pos, pos), preview: true,
        });
        await vscode.commands.executeCommand("references-view.findReferences");
        return;
      }
      case "open": {
        const pos = new vscode.Position(m.line - 1, 0);
        await vscode.window.showTextDocument(this.uri(m.path), {
          viewColumn: await this.besideColumn(), selection: new vscode.Range(pos, pos), preview: true, preserveFocus: true,
        });
        return;
      }
    }
  }

  private blob(sha: string, file: string): Promise<string | undefined> {
    const key = `${sha}:${file}`;
    let b = this.blobs.get(key);
    if (!b) {
      b = git(this.wt, "show", key).catch(() => undefined);
      this.blobs.set(key, b);
    }
    return b;
  }

  // Colours each requested line the way the editor would: TextMate first, then the language server's semantic tokens.
  private async paint(m: PaintRequest): Promise<void> {
    const seq = ++this.paintSeq;
    const kind = vscode.window.activeColorTheme.kind;
    const dark = m.theme?.kind ? !/light/.test(m.theme.kind) : kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
    const chosen = vscode.workspace.getConfiguration("storyReview").get<string>("colorTheme", "").trim();
    const label = chosen ? (/[\\/]|\.json$/i.test(chosen) ? "file:" + chosen : chosen) : m.theme?.name || configuredTheme(dark);
    let pick = themeIdFor(label, dark);
    log(`Code colours: theme "${label ?? "(unset)"}" → ${pick.id}${pick.matched ? "" : " (not bundled, so the default for its kind)"}.`);
    let theme;
    try {
      theme = await tokenizer.theme(pick.id);
    } catch (e) {
      pick = themeIdFor(undefined, dark);
      log(`Code colours: couldn't load that theme (${errText(e)}), so code uses ${pick.id}.`);
      theme = await tokenizer.theme(pick.id);
    }
    const { base, head } = this.review.meta;
    const tm = new Map<string, { src: string[]; runs: Run[][] }>();
    for (const [file, want] of Object.entries(m.files)) {
      const lang = langOf(file);
      if (!lang) continue;
      const out: Partial<Record<Side, Record<number, [string, Run[]]>>> = {};
      for (const side of ["old", "new"] as const) {
        const lines = want[side];
        if (!lines?.length) continue;
        const text = await this.blob(side === "old" ? base : head, file);
        if (text === undefined || text.length > 2_000_000) continue;
        const src = text.split(/\r?\n/);
        const runs = await tokenizer.lines(text, lang, theme);
        if (seq !== this.paintSeq) return;
        if (side === "new") tm.set(file, { src, runs });
        out[side] = Object.fromEntries(lines.filter((n) => n >= 1 && n <= src.length).map((n) => [n, [src[n - 1], runs[n - 1] ?? []]]));
      }
      this.post({ type: "paint", colors: tokenizer.colors, files: { [file]: out } });
      await new Promise((r) => setImmediate(r));
    }
    if (!semanticOn(theme.resolved, vscode.workspace.getConfiguration("editor").get("semanticHighlighting.enabled"))) {
      log("Code colours: semantic highlighting is off for this theme or in editor.semanticHighlighting.enabled.");
      return;
    }
    const silent = await this.semanticPass(seq, m, tm, theme.resolved);
    if (!silent.size) return;
    // A language server still loading a large workspace may answer later, so try those languages once more.
    setTimeout(() => {
      if (seq !== this.paintSeq) return;
      const again = new Map([...tm].filter(([file]) => silent.has(langOf(file)!)));
      void this.semanticPass(seq, m, again, theme.resolved).catch((e) => log(`Colouring failed: ${errText(e)}`));
    }, 20000);
  }

  // Overlays semantic colours on each file's new side; returns the languages whose server didn't answer.
  private async semanticPass(
    seq: number,
    m: PaintRequest,
    tm: Map<string, { src: string[]; runs: Run[][] }>,
    theme: Parameters<typeof semanticColor>[0],
  ): Promise<Set<string>> {
    const silent = new Set<string>();
    const counts = new Map<string, number>();
    for (const [file, { src, runs }] of tm) {
      const lang = langOf(file)!;
      if (silent.has(lang)) continue;
      const spans = await this.semantic(file, src, theme);
      if (seq !== this.paintSeq) return silent;
      if (!spans) {
        silent.add(lang);
        continue;
      }
      counts.set(lang, (counts.get(lang) ?? 0) + [...spans.values()].reduce((a, l) => a + l.length, 0));
      const lines = m.files[file].new ?? [];
      const out = Object.fromEntries(
        lines.filter((n) => n >= 1 && n <= src.length).map((n) => [n, [src[n - 1], overlay(runs[n - 1] ?? [], spans.get(n - 1) ?? [])]]),
      );
      this.post({ type: "paint", colors: tokenizer.colors, files: { [file]: { new: out } } });
    }
    const parts = [...counts].map(([l, n]) => `${l} ${n} tokens`).concat([...silent].map((l) => `${l} no answer`));
    if (parts.length) log(`Code colours: semantic tokens: ${parts.join(", ")}.`);
    return silent;
  }

  // Semantic spans per zero-based line, or undefined when no language server answers for this file's language.
  private async semantic(file: string, src: string[], theme: Parameters<typeof semanticColor>[0]): Promise<Map<number, Run[]> | undefined> {
    const uri = this.uri(file);
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch {
      return new Map();
    }
    if (doc.getText().split(/\r?\n/).join("\n") !== src.join("\n")) return new Map();
    let legend: vscode.SemanticTokensLegend | undefined, tokens: vscode.SemanticTokens | undefined;
    // A language server that is still starting answers with nothing, so wait for it a few times.
    for (let i = 0; i < 4 && !tokens?.data.length; i++) {
      if (i) await new Promise((r) => setTimeout(r, 1500 * i));
      legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend>("vscode.provideDocumentSemanticTokensLegend", uri);
      tokens = await vscode.commands.executeCommand<vscode.SemanticTokens>("vscode.provideDocumentSemanticTokens", uri);
    }
    if (!legend || !tokens?.data.length) return undefined;
    const spans = new Map<number, Run[]>();
    const d = tokens.data;
    let line = 0, start = 0;
    for (let i = 0; i + 4 < d.length; i += 5) {
      line += d[i];
      start = d[i] ? d[i + 1] : start + d[i + 1];
      const type = legend.tokenTypes[d[i + 3]];
      const mods = legend.tokenModifiers.filter((_, b) => d[i + 4] & (1 << b));
      const fg = type && semanticColor(theme, type, mods);
      if (!fg) continue;
      const list = spans.get(line) ?? [];
      list.push([start, start + d[i + 2], tokenizer.color(fg)]);
      spans.set(line, list);
    }
    return spans;
  }

  private fail(e: unknown): void {
    void vscode.window.showErrorMessage(`Story Review: ${e instanceof Error ? e.message : String(e)}`);
  }
}

let hub: Hub;

async function openReview(ctx: vscode.ExtensionContext, review: Review): Promise<void> {
  const wt = await ensureCheckout(ctx, review);
  if (wt) ReviewPanel.show(ctx, hub, review, wt);
}

async function pickReview(): Promise<Review | undefined> {
  const reviews = listReviews();
  if (!reviews.length) {
    void vscode.window.showInformationMessage(`No built reviews under ${reviewsRoot()}.`);
    return undefined;
  }
  const item = await vscode.window.showQuickPick(
    reviews.map((r) => ({
      label: `#${r.meta.pr}`,
      description: r.meta.verdict ?? "",
      detail: `${r.meta.repo} · head ${r.meta.head.slice(0, 9)} · reviewed ${r.meta.reviewed ?? "?"}`,
      r,
    })),
    { placeHolder: "Open a story review" },
  );
  return item?.r;
}

export function activate(ctx: vscode.ExtensionContext): void {
  hub = new Hub(ctx);
  ctx.subscriptions.push(
    vscode.commands.registerCommand("storyReview.open", async () => {
      const r = await pickReview();
      if (r) await openReview(ctx, r);
    }),
  );
  const pending = ctx.globalState.get<string>(PENDING);
  if (pending) {
    void ctx.globalState.update(PENDING, undefined);
    const r = listReviews().find((x) => x.dir === pending);
    if (r) void openReview(ctx, r);
  }
}

export function deactivate(): void {}
