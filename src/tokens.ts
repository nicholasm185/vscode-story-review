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

// VS Code's built-in theme labels differ from Shiki's ids; Modern and Plus share token colours.
const ALIASES: Record<string, string> = {
  "default dark modern": "dark-plus", "dark modern": "dark-plus", "default dark+": "dark-plus", "dark+": "dark-plus",
  "dark+ (default dark)": "dark-plus", "visual studio dark": "dark-plus", "dark (visual studio)": "dark-plus",
  "default high contrast": "dark-plus", "default light modern": "light-plus", "light modern": "light-plus",
  "default light+": "light-plus", "light+": "light-plus", "light+ (default light)": "light-plus",
  "visual studio light": "light-plus", "light (visual studio)": "light-plus", "default high contrast light": "light-plus",
  "monokai": "monokai", "solarized dark": "solarized-dark", "solarized light": "solarized-light",
};

/** The bundled theme for a VS Code theme label, or the default for the light or dark kind. */
export function themeIdFor(label: string | undefined, dark: boolean): { id: string; matched: boolean } {
  const key = (label ?? "").trim().toLowerCase();
  if (ALIASES[key]) return { id: ALIASES[key], matched: true };
  const slug = key.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const hit = bundledThemesInfo.find((t) => t.id === key || t.id === slug || t.displayName.toLowerCase() === key);
  if (hit) return { id: hit.id, matched: true };
  return { id: dark ? "dark-plus" : "light-plus", matched: false };
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
      const info = bundledThemesInfo.find((t) => t.id === id)!;
      await hl.loadTheme((await info.import()).default);
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
