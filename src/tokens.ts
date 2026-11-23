import { createHighlighterCore, type HighlighterCore, type ThemeRegistrationResolved } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import { bundledThemesInfo } from "shiki/themes";
import go from "@shikijs/langs/go";
import typescript from "@shikijs/langs/typescript";
import tsx from "@shikijs/langs/tsx";
import javascript from "@shikijs/langs/javascript";
import jsx from "@shikijs/langs/jsx";
import json from "@shikijs/langs/json";
import jsonc from "@shikijs/langs/jsonc";
import yaml from "@shikijs/langs/yaml";
import sql from "@shikijs/langs/sql";
import python from "@shikijs/langs/python";
import css from "@shikijs/langs/css";
import scss from "@shikijs/langs/scss";
import htmlLang from "@shikijs/langs/html";
import shellscript from "@shikijs/langs/shellscript";
import docker from "@shikijs/langs/docker";
import toml from "@shikijs/langs/toml";
import make from "@shikijs/langs/make";
import proto from "@shikijs/langs/proto";
import hcl from "@shikijs/langs/hcl";
import * as fs from "fs";
import * as path from "path";
import dark2026 from "./themes/2026-dark.jsonc";
import light2026 from "./themes/2026-light.jsonc";
import darkModern from "./themes/dark_modern.jsonc";
import darkPlus from "./themes/dark_plus.jsonc";
import darkVs from "./themes/dark_vs.jsonc";
import lightModern from "./themes/light_modern.jsonc";
import lightPlus from "./themes/light_plus.jsonc";
import lightVs from "./themes/light_vs.jsonc";
import hcBlack from "./themes/hc_black.jsonc";
import hcLight from "./themes/hc_light.jsonc";

/** One coloured run in a line: [start, end, palette index]. */
export type Run = [number, number, number];

export interface Theme {
  id: string;
  resolved: ThemeRegistrationResolved;
}

const LANGS = [go, typescript, tsx, javascript, jsx, json, jsonc, yaml, sql, python, css, scss, htmlLang, shellscript, docker, toml, make, proto, hcl];

const BY_EXT: Record<string, string> = {
  go: "go", ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx", js: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "jsx", json: "json", jsonc: "jsonc", yaml: "yaml", yml: "yaml", sql: "sql", py: "python", css: "css", scss: "scss",
  html: "html", htm: "html", sh: "shellscript", bash: "shellscript", zsh: "shellscript", toml: "toml", mk: "make", proto: "proto",
  tf: "hcl", hcl: "hcl",
};

export function langOf(file: string): string | undefined {
  const base = file.split("/").pop()!;
  if (/^Dockerfile(\..*)?$|\.dockerfile$/i.test(base)) return "docker";
  if (/^(GNU)?makefile$/i.test(base)) return "make";
  if (/^\.?(bash|zsh)rc$|^\.env(\..*)?$/.test(base)) return "shellscript";
  return BY_EXT[base.split(".").pop()!.toLowerCase()];
}

// VS Code's own themes (extensions/theme-defaults at the server's commit), each naming the file it builds on.
const VSCODE_THEMES: Record<string, string> = {
  "2026-dark": dark2026, "2026-light": light2026, dark_modern: darkModern, dark_plus: darkPlus, dark_vs: darkVs,
  light_modern: lightModern, light_plus: lightPlus, light_vs: lightVs, hc_black: hcBlack, hc_light: hcLight,
};

// VS Code's labels and settings ids for its own themes, old and new spellings.
const ALIASES: Record<string, string> = {
  "dark 2026": "vscode:2026-dark", "2026 dark": "vscode:2026-dark", "light 2026": "vscode:2026-light", "2026 light": "vscode:2026-light",
  "default dark modern": "vscode:dark_modern", "dark modern": "vscode:dark_modern",
  "default dark+": "vscode:dark_plus", "dark+": "vscode:dark_plus", "dark+ (default dark)": "vscode:dark_plus",
  "visual studio dark": "vscode:dark_vs", "dark (visual studio)": "vscode:dark_vs", "default dark": "vscode:dark_vs",
  "default light modern": "vscode:light_modern", "light modern": "vscode:light_modern",
  "default light+": "vscode:light_plus", "light+": "vscode:light_plus", "light+ (default light)": "vscode:light_plus",
  "visual studio light": "vscode:light_vs", "light (visual studio)": "vscode:light_vs", "default light": "vscode:light_vs",
  "default high contrast": "vscode:hc_black", "dark high contrast": "vscode:hc_black", "high contrast": "vscode:hc_black",
  "default high contrast light": "vscode:hc_light", "light high contrast": "vscode:hc_light",
  "monokai": "monokai", "solarized dark": "solarized-dark", "solarized light": "solarized-light",
};

/** VS Code's theme files allow comments and trailing commas. */
export function parseJsonc(text: string): any {
  let out = "", i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

interface RawTheme {
  name?: string;
  type?: string;
  include?: string;
  colors?: Record<string, string>;
  tokenColors?: unknown;
  semanticHighlighting?: boolean;
  semanticTokenColors?: Record<string, unknown>;
}

type Loader = (ref: string, from?: string) => { theme: RawTheme | unknown[]; where: string };

// Flattens a theme's include chain, the parent's rules first so the theme's own rules win.
function resolveTheme(load: Loader, ref: string, from?: string): RawTheme {
  const { theme, where } = load(ref, from);
  const own = theme as RawTheme;
  const parent: RawTheme = own.include ? resolveTheme(load, own.include, where) : {};
  let rules = own.tokenColors ?? [];
  if (typeof rules === "string") {
    const t = load(rules, where).theme;
    rules = Array.isArray(t) ? t : t.tokenColors ?? [];
  }
  return {
    name: own.name ?? parent.name,
    type: own.type ?? parent.type,
    colors: { ...parent.colors, ...own.colors },
    tokenColors: [...((parent.tokenColors as unknown[]) ?? []), ...(rules as unknown[])],
    semanticHighlighting: own.semanticHighlighting ?? parent.semanticHighlighting,
    semanticTokenColors: { ...parent.semanticTokenColors, ...own.semanticTokenColors },
  };
}

function vscodeTheme(name: string): RawTheme {
  return resolveTheme((ref) => {
    const text = VSCODE_THEMES[ref.replace(/^\.\//, "").replace(/\.json$/, "")];
    if (!text) throw new Error(`VS Code theme ${ref} isn't bundled.`);
    return { theme: parseJsonc(text), where: "" };
  }, name);
}

function fileTheme(file: string): RawTheme {
  return resolveTheme((ref, from) => {
    const p = from ? path.resolve(from, ref) : ref.replace(/^~(?=$|\/)/, process.env.HOME ?? "~");
    if (!p.endsWith(".json")) throw new Error(`${p}: only .json theme files are supported, not .tmTheme.`);
    return { theme: parseJsonc(fs.readFileSync(p, "utf8")), where: path.dirname(p) };
  }, file);
}

/**
 * The theme for a VS Code theme label or a storyReview.colorTheme value: a VS Code built-in theme,
 * a bundled Shiki theme, or "file:" and a path to a theme's .json file. Unknown names fall back by kind.
 */
export function themeIdFor(label: string | undefined, dark: boolean): { id: string; matched: boolean } {
  const key = (label ?? "").trim().toLowerCase();
  if (key.startsWith("file:")) return { id: "file:" + label!.trim().slice(5), matched: true };
  if (ALIASES[key]) return { id: ALIASES[key], matched: true };
  const slug = key.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const hit = bundledThemesInfo.find((t) => t.id === key || t.id === slug || t.displayName.toLowerCase() === key);
  if (hit) return { id: hit.id, matched: true };
  return { id: dark ? "vscode:2026-dark" : "vscode:2026-light", matched: false };
}

export class Tokenizer {
  private hl?: Promise<HighlighterCore>;
  private readonly palette = new Map<string, number>();
  readonly colors: string[] = [];

  private highlighter(): Promise<HighlighterCore> {
    this.hl ??= createHighlighterCore({ langs: LANGS, themes: [], engine: createOnigurumaEngine(import("shiki/wasm")) });
    return this.hl;
  }

  async theme(id: string): Promise<Theme> {
    const hl = await this.highlighter();
    if (!hl.getLoadedThemes().includes(id)) {
      if (id.startsWith("vscode:") || id.startsWith("file:")) {
        const raw = id.startsWith("vscode:") ? vscodeTheme(id.slice(7)) : fileTheme(id.slice(5));
        const type = raw.type === "light" || raw.type === "vs" || /light/i.test(id) ? "light" : "dark";
        await hl.loadTheme({ ...raw, name: id, type, settings: raw.tokenColors as never } as never);
      } else {
        const info = bundledThemesInfo.find((t) => t.id === id)!;
        await hl.loadTheme((await info.import()).default);
      }
    }
    return { id, resolved: hl.getTheme(id) };
  }

  color(c: string): number {
    const key = c.toLowerCase();
    let i = this.palette.get(key);
    if (i === undefined) {
      i = this.colors.length;
      this.palette.set(key, i);
      this.colors.push(c);
    }
    return i;
  }

  /** TextMate runs for every line of a file. */
  async lines(text: string, lang: string, theme: Theme): Promise<Run[][]> {
    const hl = await this.highlighter();
    const fg = theme.resolved.fg;
    return hl.codeToTokensBase(text, { lang, theme: theme.id }).map((line) => {
      const runs: Run[] = [];
      let at = 0;
      for (const t of line) {
        const end = at + t.content.length;
        if (end > at) runs.push([at, end, this.color(t.color ?? fg)]);
        at = end;
      }
      return runs;
    });
  }
}

// VS Code's fallback from a semantic token to TextMate scopes (tokenClassificationRegistry), most modifiers first.
const SEMANTIC_SCOPES: [string, string[], string[]][] = [
  ["variable", ["defaultLibrary", "readonly"], ["support.constant"]],
  ["property", ["defaultLibrary", "readonly"], ["support.constant.property"]],
  ["variable", ["readonly"], ["variable.other.constant"]],
  ["property", ["readonly"], ["variable.other.constant.property"]],
  ["type", ["defaultLibrary"], ["support.type"]],
  ["class", ["defaultLibrary"], ["support.class"]],
  ["interface", ["defaultLibrary"], ["support.class"]],
  ["variable", ["defaultLibrary"], ["support.variable", "support.other.variable"]],
  ["property", ["defaultLibrary"], ["support.variable.property"]],
  ["function", ["defaultLibrary"], ["support.function"]],
  ["member", ["defaultLibrary"], ["support.function"]],
  ["method", ["defaultLibrary"], ["support.function"]],
  ["comment", [], ["comment"]],
  ["string", [], ["string"]],
  ["keyword", [], ["keyword.control"]],
  ["number", [], ["constant.numeric"]],
  ["regexp", [], ["constant.regexp"]],
  ["operator", [], ["keyword.operator"]],
  ["namespace", [], ["entity.name.namespace"]],
  ["type", [], ["entity.name.type", "support.type"]],
  ["struct", [], ["entity.name.type.struct"]],
  ["class", [], ["entity.name.type.class", "support.class"]],
  ["interface", [], ["entity.name.type.interface"]],
  ["enum", [], ["entity.name.type.enum"]],
  ["typeParameter", [], ["entity.name.type.parameter"]],
  ["function", [], ["entity.name.function", "support.function"]],
  ["member", [], ["entity.name.function.member", "support.function"]],
  ["method", [], ["entity.name.function.member", "support.function"]],
  ["macro", [], ["entity.name.function.preprocessor"]],
  ["variable", [], ["variable.other.readwrite", "entity.name.variable"]],
  ["parameter", [], ["variable.parameter"]],
  ["property", [], ["variable.other.property"]],
  ["enumMember", [], ["variable.other.enummember"]],
  ["event", [], ["variable.other.event"]],
  ["decorator", [], ["entity.name.decorator", "entity.name.function"]],
  ["label", [], ["entity.name.label"]],
];

function scopeForeground(theme: ThemeRegistrationResolved, scope: string): string | undefined {
  let best: string | undefined, depth = -1;
  for (const rule of theme.settings ?? []) {
    if (!rule.settings?.foreground || !rule.scope) continue;
    const sels = Array.isArray(rule.scope) ? rule.scope : rule.scope.split(",");
    for (const raw of sels) {
      const sel = raw.trim();
      if (!sel || sel.includes(" ")) continue;
      // A later rule of equal depth wins, as in VS Code, where a theme's own rules follow the ones it includes.
      if ((scope === sel || scope.startsWith(sel + ".")) && sel.split(".").length >= depth) {
        depth = sel.split(".").length;
        best = rule.settings.foreground;
      }
    }
  }
  return best;
}

function semanticRuleColor(theme: ThemeRegistrationResolved, type: string, mods: string[]): string | undefined {
  const rules = (theme as { semanticTokenColors?: Record<string, string | { foreground?: string }> }).semanticTokenColors ?? {};
  let best: string | undefined, score = -1;
  for (const [sel, v] of Object.entries(rules)) {
    const [t, ...need] = sel.split(":")[0].split(".");
    if ((t !== type && t !== "*") || !need.every((m) => mods.includes(m))) continue;
    const fg = typeof v === "string" ? v : v?.foreground;
    const s = need.length * 2 + (t === type ? 1 : 0);
    if (fg && s > score) {
      score = s;
      best = fg;
    }
  }
  return best;
}

/** The colour VS Code gives a semantic token in this theme, or undefined to keep the TextMate colour. */
export function semanticColor(theme: ThemeRegistrationResolved, type: string, mods: string[]): string | undefined {
  const own = semanticRuleColor(theme, type, mods);
  if (own) return own;
  for (const [t, need, scopes] of SEMANTIC_SCOPES) {
    if (t !== type || !need.every((m) => mods.includes(m))) continue;
    for (const s of scopes) {
      const fg = scopeForeground(theme, s);
      if (fg) return fg;
    }
  }
  return undefined;
}

/** Whether VS Code would apply semantic colours, given editor.semanticHighlighting.enabled. */
export function semanticOn(theme: ThemeRegistrationResolved, setting: unknown): boolean {
  if (setting === true || setting === false) return setting;
  return (theme as { semanticHighlighting?: boolean }).semanticHighlighting === true;
}

/** Overlay [start, end, colour] spans on a line's TextMate runs. */
export function overlay(runs: Run[], spans: Run[]): Run[] {
  let out = runs;
  for (const [s, e, c] of spans) {
    const next: Run[] = [];
    for (const [a, b, k] of out) {
      if (b <= s || a >= e) {
        next.push([a, b, k]);
        continue;
      }
      if (a < s) next.push([a, s, k]);
      if (b > e) next.push([e, b, k]);
    }
    next.push([s, e, c]);
    out = next.sort((x, y) => x[0] - y[0]);
  }
  return out;
}
