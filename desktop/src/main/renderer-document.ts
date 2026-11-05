import path from "path";
import { fileURLToPath } from "url";
import { isDevRuntime } from "./runtime-mode";

/**
 * ── ⚠ WHAT COUNTS AS *OUR* RENDERER — ONE DEFINITION, TWO ENFORCERS ──────────────────────────
 *
 * Two guards decide whether a document is trusted, and they must agree:
 *
 *   `will-navigate` (index.ts)   — may this window go there?
 *   `isAllowedSender` (ipc-guard) — may that frame call ~120 privileged IPC channels?
 *
 * Both used to answer "yes" to `url.startsWith("file://")` — ANY local file, not just ours. Those
 * two blanket allowances composed badly: navigate the window to an attacker-chosen local HTML file
 * and it loads with the SAME preload script attached and passes the sender check for every channel.
 *
 * The reachable trigger was ordinary product behaviour rather than anything exotic. `App.tsx` and
 * `AssistantChatView.tsx` render markdown with no custom `a` component, so a link is a plain
 * in-window `<a href>` — a click goes through `will-navigate`, NOT through `setWindowOpenHandler`
 * (which correctly denies non-http(s)). And the content in those views comes from the local agent,
 * team chat and the shared document store, while the agent can write the target file into the
 * project as part of normal work.
 *
 * So "is this a file:// URL?" is replaced by "is this EXACTLY the document we loaded?".
 *
 * ── WHY PATH COMPARISON RATHER THAN STRING COMPARISON ──
 *
 * The document URL legitimately varies: `loadFile(..., { search })` appends `?chooser=1` and
 * sometimes `&mustCreate=1` for the profile picker, and percent-encoding differs by who built the
 * string. Comparing raw URLs would reject the chooser; comparing the resolved PATH accepts every
 * legitimate spelling and nothing else. Query and hash are ignored on purpose — they select a
 * screen, they do not change which document is running.
 */

// Dev and production load different URLs; the guards must follow the same switch — and that switch
// must not be an environment variable inside a shipped binary. See runtime-mode.ts.

/** The Vite dev server. Matched by EXACT ORIGIN — see `isOwnRendererUrl`. */
export const DEV_ORIGIN = "http://localhost:5173";

/**
 * The packaged renderer document on disk.
 *
 * Derived from `__dirname` exactly as `loadFile` derives it in index.ts, so the two cannot drift.
 * A function rather than a constant because `__dirname` must be read at call time under the test
 * harness, not frozen at module load.
 */
export function rendererDocumentPath(): string {
  return path.resolve(__dirname, "../renderer/index.html");
}

/**
 * True if `url` is this app's own renderer document — the packaged `index.html`, or the dev server
 * in development.
 *
 * Deliberately strict, and fails closed on anything it cannot parse.
 */
export function isOwnRendererUrl(url: string | undefined | null): boolean {
  if (typeof url !== "string" || url.length === 0) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL at all — `about:blank`, a bare path, an empty frame. Never trusted.
    return false;
  }

  if (parsed.protocol === "file:") {
    /**
     * ⚠ THE HOST MUST BE EMPTY, AND CHECKING THE PATHNAME ALONE IS NOT ENOUGH.
     *
     * `file://evil.example/<our path>/index.html` parses cleanly and its `pathname` is byte-identical
     * to ours — so rebuilding the URL from the pathname (which is what this function did first)
     * accepted it. That is not our document: on Windows a file URL with a host is a UNC network
     * path, so the form is a remote fetch wearing a local-looking pathname.
     *
     * `localhost` is allowed because the URL spec defines it as equivalent to an empty host for
     * file URLs, and Node's own `fileURLToPath` accepts it for that reason.
     */
    if (parsed.host !== "" && parsed.host !== "localhost") return false;
    try {
      // Rebuilt from the pathname alone so a query string does not reach fileURLToPath, and so
      // percent-encoding is decoded exactly once by the URL machinery rather than by hand.
      const asPath = fileURLToPath(new URL(`file://${parsed.pathname}`));
      return path.resolve(asPath) === rendererDocumentPath();  // nosemgrep: path-join-resolve-traversal
    } catch {
      return false;
    }
  }

  /**
   * ⚠ EXACT ORIGIN, AND ONLY IN DEV.
   *
   * `startsWith(DEV_ORIGIN)` — what `will-navigate` used to do — also matches
   * `http://localhost:51735` and `http://localhost:5173.evil.com`, because neither is a prefix
   * violation as a string. `URL.origin` cannot be fooled that way.
   *
   * ⚠ AND GATED ON `app.isPackaged`, NOT ON AN ENVIRONMENT VARIABLE.
   *
   * The earlier version of this comment argued that keying on `NODE_ENV` "adds no new failure mode,
   * because if that flag were wrong the app would already be loading the wrong document". That
   * reasoning is circular: "the app already loads the wrong document" IS the vulnerability, and this
   * function is what makes the wrong document TRUSTED. A packaged build now ignores `NODE_ENV`
   * entirely — see runtime-mode.ts.
   */
  return isDevRuntime() && parsed.origin === DEV_ORIGIN;
}
