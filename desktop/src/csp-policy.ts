/**
 * ── ⚠ THE CSP, IN ONE PLACE, BECAUSE IT IS DELIVERED TWICE ────────────────────────────────────
 *
 * The policy used to exist only as a `Content-Security-Policy` RESPONSE HEADER, injected via
 * `session.defaultSession.webRequest.onHeadersReceived`. That works in development, where the
 * renderer is served over `http://localhost:5173`.
 *
 * In production the window is loaded with `loadFile(...)`, i.e. the `file://` scheme — and a
 * `file://` load has no HTTP response and therefore no response headers. `index.html` carried no
 * `<meta http-equiv="Content-Security-Policy">` either, so the packaged app very likely ran with
 * NO POLICY AT ALL: the one build where it matters most, since that is what ships.
 *
 * So production now gets a meta tag as well, injected at build time (see the `csp` plugin in
 * vite.config.ts). The header stays for dev. Both read the strings below, so the two deliveries
 * cannot drift — which is the failure this file exists to prevent, not merely tidiness: a header
 * and a meta tag disagreeing would apply the INTERSECTION of the two, and the resulting breakage
 * would look like a bug in whatever feature happened to trip it first.
 *
 * ⚠ THE META TAG IS NOT INJECTED IN DEV. Vite serves this same `index.html` from memory, and the
 * production policy has no `'unsafe-eval'`, no `'unsafe-inline'` for scripts and no
 * `ws://localhost:5173` — it would break HMR on the first hot update.
 */

/**
 * Development: Vite's HMR client needs inline script, `eval`, and its own websocket.
 *
 * Deliberately loose, and deliberately never shipped — `NODE_ENV === "development"` selects it,
 * the same switch that decides whether the renderer is loaded from the dev server at all.
 */
export const CSP_DEV =
  "default-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:5173 ws://localhost:5173 data:; " +
  "connect-src *; img-src 'self' data: https:;";

/**
 * Production.
 *
 * ⚠ `script-src 'self'`, WITH NO `file:` SOURCE — and that was checked rather than assumed.
 *
 * The first draft of this file added `file:` to `default-src`/`script-src`, on the reasoning that a
 * `file://` document has an opaque origin so `'self'` might not match a sibling `file:` script and
 * the window would render blank. That reasoning is wrong, and the experiment says so: a packaged
 * launch with `script-src 'self'` and no `file:` produced ZERO "Refused to load" messages, booted
 * the renderer, and opened the database. Blink's CSP source matching treats the document's own
 * directory as `'self'` here.
 *
 * The strict form is kept because `file:` is not a harmless widening: it would permit a script from
 * ANY local path, which is precisely the injected-`<script src="file:///…">` case CSP is for.
 *
 * ⚠ VERIFIED ON macOS / ELECTRON 43 ONLY. CSP source matching lives in Blink and is not
 * OS-specific, so the same result is expected for the `nsis` and `AppImage` targets — but expected
 * is not verified, and the failure mode there would be a blank window. Worth one launch per
 * platform before shipping a build for it.
 *
 * `file:` is deliberately LEFT IN `img-src` and `font-src`: the cost of a local image or font
 * source is not code execution, and those are the two directives whose failure would be a silent
 * cosmetic regression rather than a crash the smoke test catches.
 *
 * ⚠ `connect-src` is BROAD, and this is the known weak directive. The backend origin is
 * user-configurable at runtime (the portal URL), so it cannot be enumerated at build time. It is
 * narrowed as far as the delivery mechanism allows — a meta tag is static — and tightening it
 * properly means building the policy per session in main, which is a change to how the policy is
 * delivered rather than to the policy itself.
 */
export const CSP_PROD =
  "default-src 'self'; " +
  "script-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https: file:; " +
  "font-src 'self' data: file:; " +
  "connect-src *; " +
  "object-src 'none'; " +
  "base-uri 'self'; " +
  /**
   * ⚠ `form-action` DOES NOT FALL BACK TO `default-src`. Without it, injected markup could POST
   * anywhere regardless of how tight the rest of the policy is — and with `connect-src *` still
   * broad, form submission was the cheapest exfiltration route the policy left open.
   */
  "form-action 'self'; " +
  "frame-ancestors 'none';";

/**
 * Directives the HTML spec says a `<meta>` element MUST ignore.
 *
 * ⚠ FOUND BY RUNNING IT, NOT BY READING THE SPEC FIRST. A packaged launch logged: "The Content
 * Security Policy directive 'frame-ancestors' is ignored when delivered via a <meta> element."
 * Leaving it in would mean shipping a policy whose own console output says part of it does nothing —
 * which is exactly the kind of noise that trains people to ignore CSP warnings.
 *
 * They stay in `CSP_PROD` because the HEADER honours them, and the header is what covers dev.
 */
const META_IGNORED_DIRECTIVES = ["frame-ancestors", "report-uri", "report-to", "sandbox"];

/**
 * `CSP_PROD` with the meta-ignored directives stripped.
 *
 * Derived rather than written out a second time: a hand-maintained copy is how the meta and the
 * header would drift, and this whole file exists to stop that.
 */
export const CSP_PROD_META = CSP_PROD.split(";")
  .map((directive) => directive.trim())
  .filter((directive) => {
    if (!directive) return false;
    const name = directive.split(/\s+/)[0].toLowerCase();
    return !META_IGNORED_DIRECTIVES.includes(name);
  })
  .join("; ")
  .concat(";");

/** The policy for a given mode. One switch, so header and meta agree by construction. */
export function cspFor(isDev: boolean): string {
  return isDev ? CSP_DEV : CSP_PROD;
}
