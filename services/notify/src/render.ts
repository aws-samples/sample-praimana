import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Tiny, dependency-free Mustache-ish renderer + loader for the HTML email
 * templates in `apps/services/notify/templates/`. We keep this in-house (rather
 * than pulling in a template engine) because the surface we need is small and we
 * want auto-escaping to be the DEFAULT — the notify service renders SEMANTIC
 * fields into trusted templates, never raw caller HTML.
 *
 * Supported syntax (a strict subset of Mustache):
 *   {{name}}            HTML-escaped value
 *   {{{name}}}          raw value (only for values WE produce, e.g. nested render)
 *   {{#name}}...{{/name}}   section: rendered if truthy; iterated if an array
 *   {{^name}}...{{/name}}   inverted section: rendered if falsy/empty
 *
 * Values resolve against the current context; inside an array section each item
 * becomes the context (with the parent still reachable for un-shadowed keys).
 */

/**
 * Trust marker for raw (unescaped) HTML. The triple-brace slots ({{{ }}}) emit a
 * value verbatim ONLY when it is a SafeHtml instance; any plain string that
 * reaches a raw slot is HTML-escaped instead. This enforces the notify invariant
 * in code: caller-supplied fields are never SafeHtml, so if one is ever wired
 * into `content`/`footerExtra` by mistake it fails safe (escaped) rather than
 * injecting markup. Only server-produced, already-escaped output is wrapped with
 * `markSafe()` (see templates.ts).
 */
export class SafeHtml {
  readonly html: string;
  constructor(html: string) {
    this.html = html;
  }
  toString(): string {
    return this.html;
  }
}

/** Wrap trusted, already-escaped HTML so a {{{ }}} slot will emit it raw. */
export function markSafe(html: string): SafeHtml {
  return new SafeHtml(html);
}

export type TemplateValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | SafeHtml
  | TemplateContext
  | TemplateValue[];

export interface TemplateContext {
  [key: string]: TemplateValue;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Schemes allowed in a link slot. `javascript:` and `data:` are the dangerous
 * ones — HTML-escaping does NOT neutralize them, because the payload sits in an
 * attribute VALUE that the mail client parses as a URL, not as markup. Some
 * webmail clients strip such hrefs, but plenty of desktop clients follow them.
 */
/**
 * ⚠ `http:` WAS HERE AND IS GONE. Every link this service sends is to the platform's own web app or a
 * `mailto:`, and both are https in every environment that works — `bulk-provision` already REFUSES to
 * send when `APP_URL` is unset, local, or an `api.*` host, so a plaintext link was never a
 * configuration anybody deploys on purpose. Keeping `http:` only preserved the ability to send a panel
 * of judges to a downgraded URL, which is a downgrade this platform should not perform on a
 * recipient's behalf.
 *
 * `mailto:` stays: contact links are legitimate and carry no navigation risk.
 */
const SAFE_URL_SCHEMES = ["https:", "mailto:"];

/**
 * Make a caller-supplied URL safe to place in an `href`.
 *
 * Returns "" for anything that isn't an absolute http/https/mailto URL, so the
 * template renders an empty href rather than an executable one. Empty is the
 * right failure mode here: a broken button in an email the recipient can ignore
 * beats a working button that runs script or exfiltrates.
 *
 * Escaping is still the CALLER's job (the template's {{ }} slot does it) — this
 * only decides whether the value is a URL we're willing to link at all.
 */
export function safeUrl(value: unknown): string {
  if (typeof value !== "string" || value === "") return "";
  // Leading/trailing whitespace and control characters are how `java\nscript:`
  // style bypasses get past a naive prefix check; URL parsing handles the rest.
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // Relative URLs land here. An email has no base to resolve them against, so
    // they were never going to work — refuse rather than guess.
    return "";
  }
  if (!SAFE_URL_SCHEMES.includes(parsed.protocol)) return "";
  // ⚠ RETURN THE PARSED FORM, NOT `trimmed`. The WHATWG URL parser strips
  // embedded ASCII tab/LF/CR while PARSING but does not rewrite the input string; `trimmed`
  // can still contain them even though `parsed` does not. Returning `trimmed` here would be
  // "validate the parsed value, act on the original string" in reverse — a value that only
  // *parses* to something safe (e.g. `https://portal.example.com/join/abc\r\ndef` on an allowed
  // origin) would reach `escapeHtml`, which does not encode `\r`/`\n`, carrying them into the
  // template's href attribute. `parsed.toString()` is the exact value that was validated.
  // `mailto:` round-trips as identity through `URL#toString` (confirmed: no case-folding, no
  // added slash), so this is safe to apply to every scheme in SAFE_URL_SCHEMES uniformly rather
  // than branching on protocol.
  return parsed.toString();
}

function lookup(stack: TemplateContext[], key: string): TemplateValue {
  // Search the context stack from innermost to outermost (section scoping).
  for (let i = stack.length - 1; i >= 0; i--) {
    const ctx = stack[i];
    if (ctx && Object.prototype.hasOwnProperty.call(ctx, key)) {
      return ctx[key];
    }
  }
  return undefined;
}

function isTruthy(v: TemplateValue): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v === null || v === undefined || v === false) return false;
  if (v === "") return false;
  return true;
}

/** Render a template string against a context object. */
export function renderString(template: string, context: TemplateContext): string {
  return renderTokens(template, [context]);
}

// Matches a section {{#key}}...{{/key}} or {{^key}}...{{/key}}, non-greedy, with
// support for the same key nested (handled by scanning for the matching close).
const SECTION_OPEN = /\{\{([#^])\s*([\w.]+)\s*\}\}/;

function renderTokens(template: string, stack: TemplateContext[]): string {
  let out = "";
  let rest = template;

  while (rest.length > 0) {
    const open = SECTION_OPEN.exec(rest);
    if (!open) {
      out += renderInterpolations(rest, stack);
      break;
    }

    // Everything before the section open is plain interpolation.
    out += renderInterpolations(rest.slice(0, open.index), stack);

    const kind = open[1]; // "#" or "^"
    const key = open[2];
    const afterOpen = open.index + open[0].length;

    // Find the matching close tag for THIS key, accounting for nested sections
    // that reuse the same key.
    let depth = 1;
    let searchFrom = afterOpen;
    let closeIdx = -1;
    // Safe: `key` is captured by SECTION_OPEN's `[\w.]+`, so it can only contain
    // word chars and dots — no regex metacharacters — and it's still passed
    // through escapeRegExp() (full metachar set, same coverage as the
    // escape-string-regexp package). The interpolated pattern is therefore fixed
    // in shape and not attacker-influenceable, so no ReDoS surface.
    const reNested = new RegExp(`\\{\\{[#^]\\s*${escapeRegExp(key)}\\s*\\}\\}|\\{\\{/\\s*${escapeRegExp(key)}\\s*\\}\\}`, "g");  // nosemgrep: detect-non-literal-regexp
    reNested.lastIndex = searchFrom;
    let m: RegExpExecArray | null;
    while ((m = reNested.exec(rest)) !== null) {
      if (m[0].startsWith("{{/")) {
        depth--;
        if (depth === 0) {
          closeIdx = m.index;
          searchFrom = m.index + m[0].length;
          break;
        }
      } else {
        depth++;
      }
    }

    if (closeIdx === -1) {
      // Unbalanced section — treat the open tag as literal text and move on.
      out += open[0];
      rest = rest.slice(afterOpen);
      continue;
    }

    const inner = rest.slice(afterOpen, closeIdx);
    const value = lookup(stack, key);

    if (kind === "#") {
      if (Array.isArray(value)) {
        for (const item of value) {
          const itemCtx: TemplateContext =
            item !== null && typeof item === "object" && !Array.isArray(item)
              ? (item as TemplateContext)
              : { ".": item as TemplateValue };
          out += renderTokens(inner, [...stack, itemCtx]);
        }
      } else if (isTruthy(value)) {
        const childCtx =
          value !== null && typeof value === "object" && !Array.isArray(value)
            ? (value as TemplateContext)
            : {};
        out += renderTokens(inner, [...stack, childCtx]);
      }
    } else {
      // Inverted: render only when falsy/empty.
      if (!isTruthy(value)) {
        out += renderTokens(inner, stack);
      }
    }

    rest = rest.slice(searchFrom);
  }

  return out;
}

function renderInterpolations(segment: string, stack: TemplateContext[]): string {
  // Raw first ({{{ }}}), then escaped ({{ }}).
  return segment
    .replace(/\{\{\{\s*([\w.]+)\s*\}\}\}/g, (_all, key: string) => {
      const v = lookup(stack, key);
      if (v === null || v === undefined) return "";
      // Runtime guard: only a SafeHtml marker is emitted raw. Any plain
      // string/number here (e.g. caller input accidentally wired to a raw slot)
      // is escaped, so a {{{ }}} slot can never inject untrusted markup.
      if (v instanceof SafeHtml) return v.html;
      return escapeHtml(String(v));
    })
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_all, key: string) => {
      const v = lookup(stack, key);
      if (v === null || v === undefined) return "";
      // A SafeHtml in a {{ }} slot is already trusted markup — emit it raw
      // (escaping it would double-encode). Everything else is escaped.
      if (v instanceof SafeHtml) return v.html;
      return escapeHtml(String(v));
    });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// --- Template file loading --------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Candidate directories where the .html templates live. In local dev the source
 * runs from `src/`, so templates are one level up. In the Lambda bundle the build
 * copies `templates/` next to the handler, so they sit alongside `dist/`. We try
 * both so the same code works in either layout.
 */
const TEMPLATE_DIRS = [
  join(here, "..", "templates"), // src/ -> ../templates (dev)
  join(here, "templates"), // dist/ + copied templates (lambda)
];

const cache = new Map<string, string>();

/** Read a template file by name (without extension), cached after first read. */
export function loadTemplate(name: string): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  let lastErr: unknown;
  for (const dir of TEMPLATE_DIRS) {
    try {
      const content = readFileSync(join(dir, `${name}.html`), "utf8");
      cache.set(name, content);
      return content;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `notify: template "${name}.html" not found in ${TEMPLATE_DIRS.join(", ")} (${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    })`
  );
}
