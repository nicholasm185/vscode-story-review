import * as vscode from "vscode";
import { randomBytes } from "crypto";

export interface Outline {
  title: string;
  chapters: { href: string; n: string; title: string; read: boolean | null; dots: { sev: string; count: string }[] }[];
  findings: { href: string; sev: string; short: string; loc: string }[];
  files: { path: string; href: string; viewed: boolean; partial: boolean; meta: string }[];
  viewed: string;
}

export interface PanelLink {
  post(m: unknown): void;
  reveal(): void;
  style(): string;
  remote(): Map<string, string> | undefined;
}

type Node =
  | { kind: "chapter"; c: Outline["chapters"][number] }
  | { kind: "finding"; f: Outline["findings"][number] }
  | { kind: "dir"; dir: string; files: Outline["files"] }
  | { kind: "file"; f: Outline["files"][number] };

const SEV_ICON: Record<string, [string, string]> = {
  high: ["error", "errorForeground"],
  med: ["warning", "editorWarning.foreground"],
  low: ["info", "editorInfo.foreground"],
  nit: ["circle-small", "descriptionForeground"],
};

class OutlineTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private nodes: Node[] = [];

  constructor(private readonly hub: Hub, private readonly kind: "chapters" | "findings" | "files") {}

  refresh(): void {
    this.nodes = [];
    this.changed.fire(undefined);
  }

  getChildren(parent?: Node): Node[] {
    const o = this.hub.outline;
    if (!o) return [];
    if (parent) return parent.kind === "dir" ? parent.files.map((f) => ({ kind: "file" as const, f })) : [];
    if (this.kind === "chapters") this.nodes = o.chapters.map((c) => ({ kind: "chapter" as const, c }));
    else if (this.kind === "findings") this.nodes = o.findings.map((f) => ({ kind: "finding" as const, f }));
    else {
      const dirs = new Map<string, Outline["files"]>();
      for (const f of o.files) {
        const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ".";
        dirs.set(dir, [...(dirs.get(dir) ?? []), f]);
      }
      this.nodes = [...dirs].map(([dir, files]) => ({ kind: "dir" as const, dir, files }));
    }
    return this.nodes;
  }

  getParent(): undefined {
    return undefined;
  }

  find(href: string): Node | undefined {
    return this.nodes.find((n) => n.kind === "chapter" && n.c.href === href);
  }

  getTreeItem(n: Node): vscode.TreeItem {
    const goto = (href: string, title: string): vscode.Command => ({ command: "storyReview.goto", title, arguments: [href] });
    if (n.kind === "chapter") {
      const item = new vscode.TreeItem(n.c.n ? `${n.c.n}  ${n.c.title}` : n.c.title);
      item.id = n.c.href;
      item.tooltip = n.c.title;
      item.description = n.c.dots.map((d) => `${d.count} ${d.sev}`).join(" · ");
      if (n.c.read !== null) item.checkboxState = n.c.read ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
      else item.iconPath = new vscode.ThemeIcon(n.c.href === "#end" ? "flag" : "lightbulb");
      item.command = goto(n.c.href, "Go to chapter");
      return item;
    }
    if (n.kind === "finding") {
      const [icon, color] = SEV_ICON[n.f.sev] ?? ["circle-small", "descriptionForeground"];
      const item = new vscode.TreeItem(n.f.short);
      item.id = n.f.href;
      item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
      item.description = n.f.loc;
      item.tooltip = `${n.f.sev}: ${n.f.short}${n.f.loc ? `\n${n.f.loc}` : ""}`;
      item.command = goto(n.f.href, "Go to finding");
      return item;
    }
    if (n.kind === "dir") {
      const done = n.files.filter((f) => f.viewed).length;
      const item = new vscode.TreeItem(n.dir, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `dir:${n.dir}`;
      item.description = `${done}/${n.files.length}`;
      item.iconPath = new vscode.ThemeIcon(done === n.files.length ? "pass-filled" : "folder", done === n.files.length ? new vscode.ThemeColor("testing.iconPassed") : undefined);
      return item;
    }
    const item = new vscode.TreeItem(n.f.path.slice(n.f.path.lastIndexOf("/") + 1));
    item.id = `file:${n.f.path}`;
    const dismissed = this.hub.remote?.get(n.f.path) === "DISMISSED";
    item.description = n.f.meta + (n.f.partial ? " · part viewed" : "") + (dismissed ? " · changed since you viewed it" : "");
    item.tooltip = n.f.path;
    item.checkboxState = n.f.viewed ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
    item.resourceUri = vscode.Uri.file("/" + n.f.path);
    item.command = goto(n.f.href, "Go to file");
    return item;
  }
}

class NotesView implements vscode.WebviewViewProvider {
  view?: vscode.WebviewView;
  private last: unknown = { type: "notes", html: "", title: "" };

  constructor(private readonly hub: Hub, private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")] };
    view.webview.onDidReceiveMessage((m) => this.hub.fromNotes(m));
    view.onDidChangeVisibility(() => this.hub.layout());
    view.onDidDispose(() => {
      this.view = undefined;
      this.hub.layout();
    });
    this.render();
    this.hub.layout();
  }

  render(): void {
    if (!this.view) return;
    const w = this.view.webview;
    const nonce = randomBytes(16).toString("base64");
    const media = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", f));
    const csp = `default-src 'none'; img-src ${w.cspSource} https: data:; style-src ${w.cspSource} 'unsafe-inline' https://fonts.googleapis.com; font-src ${w.cspSource} https://fonts.gstatic.com; script-src 'nonce-${nonce}'`;
    w.html =
      `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">` +
      `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap">` +
      `<style>${this.hub.panel?.style() ?? ""}</style><link rel="stylesheet" href="${media("notes.css")}"></head>` +
      `<body><header id="title"></header><main id="notes"><p class="sr-empty">Open a review. The notes for the code in view show here.</p></main>` +
      `<script nonce="${nonce}" src="${media("notes.js")}"></script></body></html>`;
    void w.postMessage(this.last);
  }

  post(m: { type: string; [k: string]: unknown }): void {
    if (m.type === "notes") this.last = m;
    void this.view?.webview.postMessage(m);
  }

  get visible(): boolean {
    return !!this.view?.visible;
  }
}

export class Hub {
  outline?: Outline;
  panel?: PanelLink;
  remote?: Map<string, string>;
  private readonly trees: Record<"chapters" | "findings" | "files", OutlineTree>;
  private readonly views: vscode.TreeView<Node>[] = [];
  private readonly notes: NotesView;
  private current?: string;

  constructor(ctx: vscode.ExtensionContext) {
    this.trees = { chapters: new OutlineTree(this, "chapters"), findings: new OutlineTree(this, "findings"), files: new OutlineTree(this, "files") };
    for (const kind of ["chapters", "findings", "files"] as const) {
      const view = vscode.window.createTreeView(`storyReview.${kind}`, { treeDataProvider: this.trees[kind], manageCheckboxStateManually: true });
      view.onDidChangeVisibility(() => this.layout());
      view.onDidChangeCheckboxState((e) => {
        for (const [n, state] of e.items) {
          const on = state === vscode.TreeItemCheckboxState.Checked;
          if (n.kind === "chapter") this.panel?.post({ type: "setRead", href: n.c.href, on });
          if (n.kind === "file") this.panel?.post({ type: "setViewed", path: n.f.path, on });
        }
      });
      this.views.push(view);
      ctx.subscriptions.push(view);
    }
    this.notes = new NotesView(this, ctx.extensionUri);
    ctx.subscriptions.push(
      vscode.window.registerWebviewViewProvider("storyReview.notes", this.notes, { webviewOptions: { retainContextWhenHidden: true } }),
      vscode.commands.registerCommand("storyReview.goto", (href: string) => {
        this.panel?.post({ type: "goto", href });
        this.panel?.reveal();
      }),
      vscode.commands.registerCommand("storyReview.toggleSplit", () => this.panel?.post({ type: "view", key: "s" })),
    );
  }

  setPanel(p: PanelLink | undefined): void {
    if (this.panel === p) return;
    this.panel = p;
    this.remote = p?.remote();
    if (!p) {
      this.outline = undefined;
      this.refresh();
      this.notes.post({ type: "notes", html: "", title: "" });
    }
    this.notes.render();
    this.layout();
  }

  setOutline(from: PanelLink, o: Outline): void {
    if (from !== this.panel) return;
    this.outline = o;
    this.views[2].description = o.viewed + (this.remote ? " · synced with GitHub" : "");
    this.views[0].description = o.title;
    this.refresh();
    if (this.current) void this.select(this.current);
  }

  setRemote(from: PanelLink, state: Map<string, string>): void {
    if (from !== this.panel) return;
    this.remote = state;
    if (this.outline) this.views[2].description = this.outline.viewed + " · synced with GitHub";
    this.trees.files.refresh();
  }

  setCurrent(from: PanelLink, href: string): void {
    if (from !== this.panel || href === this.current) return;
    this.current = href;
    void this.select(href);
  }

  private async select(href: string): Promise<void> {
    const n = this.trees.chapters.find(href);
    if (n && this.views[0].visible) await this.views[0].reveal(n, { select: true, focus: false });
  }

  fromPanel(from: PanelLink, m: { type: string; [k: string]: unknown }): void {
    if (from === this.panel) this.notes.post(m);
  }

  fromNotes(m: { type: string }): void {
    this.panel?.post(m);
  }

  layout(): void {
    this.panel?.post({ type: "layout", rail: this.views.some((v) => v.visible), notes: this.notes.visible });
  }

  private refresh(): void {
    for (const t of Object.values(this.trees)) t.refresh();
  }
}
