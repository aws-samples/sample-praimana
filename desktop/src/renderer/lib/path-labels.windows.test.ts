// ── ⚠ THE RENDERER SPLIT PATHS ON A LITERAL "/" ───────────────────────────────────────────────
//
// The ninth Windows defect, and the one a participant would see first — on every screen at once.
//
// Main returns paths straight from `fs`, built with `path.join`, so on Windows they are separated by
// `\`. The renderer extracted filenames with `split("/")`, which finds nothing in such a path and
// returns the WHOLE STRING as a single element:
//
//   project name     "C:\Users\me\projects\acme-api"   instead of  "acme-api"
//   file tab label   "C:\Users\me\proj\src\main.ts"    instead of  "main.ts"
//   breadcrumb       undefined                          instead of  "src"
//
// The last is the worst: `slice(-2, -1)` of a one-element array is empty, so the disambiguating parent
// folder vanished exactly where duplicate filenames made it necessary.
//
// ⚠ NOT FIXED IN THE MAIN PROCESS, and the reason matters. My first plan was to normalise separators at
// the IPC boundary. Two things ruled it out: deep-rewriting handler results would corrupt any string
// that is not a path (a chat message containing a backslash), and `KiroChatView`'s tool-call rows render
// paths the AGENT emitted inside `rawInput` — verbatim JSON that main forwards without inspecting, so
// there is no boundary at which they could be normalised at all.
//
// `basenameOf` / `parentDirOf` (file-tree-ops.ts) already accepted both separators and handled the
// Windows drive root. That module's own header had called this assumption out and hardened itself
// against it while the rest of the renderer kept it; this closes the gap it described.

import { describe, it, expect } from "vitest";
import { basenameOf, parentDirOf } from "./file-tree-ops";
import { tabLabel, tabLabels } from "./file-tabs";

const WIN_PROJECT = "C:\\Users\\me\\projects\\acme-api";
const WIN_FILE = "C:\\Users\\me\\projects\\acme-api\\src\\main.ts";
const MAC_FILE = "/Users/me/projects/acme-api/src/main.ts";

describe("⚠ the labels a Windows participant would have seen", () => {
  it("takes the project's own folder name, not the whole path", () => {
    // The value `addProject` PERSISTS, so it was inherited by every later screen.
    expect(basenameOf(WIN_PROJECT)).toBe("acme-api");
    expect(basenameOf(WIN_PROJECT.split("\\").join("/"))).toBe("acme-api");
  });

  it("takes a file's name from a backslash path", () => {
    expect(basenameOf(WIN_FILE)).toBe("main.ts");
  });

  it("⚠ the old expression is demonstrably wrong, and is what this replaces", () => {
    /**
     * Kept as a live comparison rather than prose: it shows the defect rather than asserting that the
     * fix exists. If someone reverts a call site, the difference between these two lines is the bug.
     */
    expect(WIN_FILE.split("/").pop()).toBe(WIN_FILE); // the whole path — the defect
    expect(basenameOf(WIN_FILE)).toBe("main.ts"); //     the fix
  });

  it("finds the parent folder for the breadcrumb", () => {
    expect(basenameOf(parentDirOf(WIN_FILE))).toBe("src");
    // The old form produced `undefined`, which is worse than a wrong string: it renders as nothing.
    expect(WIN_FILE.split("/").slice(-2, -1)[0]).toBeUndefined();
  });

  it("keeps the drive root intact rather than reducing it to a drive-relative path", () => {
    // `C:` alone resolves against the drive's CURRENT directory, not its root — a real hazard if such a
    // value were ever passed back to main.
    expect(parentDirOf("C:\\proj")).toBe("C:\\");
    expect(basenameOf("C:\\proj")).toBe("proj");
  });
});

describe("tab labels, which is where the defect was ugliest", () => {
  it("labels a single tab with the filename on both platforms", () => {
    expect(tabLabel(WIN_FILE)).toBe("main.ts");
    expect(tabLabel(MAC_FILE)).toBe("main.ts");
  });

  it("⚠ disambiguates duplicates with the parent folder — the case that broke silently", () => {
    /**
     * A project has twenty files called `index.ts`. On Windows the disambiguator evaluated to
     * `undefined`, so all of them read "index.ts" and the feature was invisibly absent.
     */
    const open = [
      "C:\\proj\\src\\api\\index.ts",
      "C:\\proj\\src\\web\\index.ts",
      "C:\\proj\\README.md",
    ];
    expect(tabLabels(open)).toEqual({
      "C:\\proj\\src\\api\\index.ts": "api/index.ts",
      "C:\\proj\\src\\web\\index.ts": "web/index.ts",
      "C:\\proj\\README.md": "README.md",
    });
  });

  it("still disambiguates POSIX paths exactly as before", () => {
    // The macOS behaviour is the one already in use; it must be byte-identical.
    const open = ["/proj/src/api/index.ts", "/proj/src/web/index.ts"];
    expect(tabLabels(open)).toEqual({
      "/proj/src/api/index.ts": "api/index.ts",
      "/proj/src/web/index.ts": "web/index.ts",
    });
  });

  it("uses a forward slash in the LABEL on both platforms, deliberately", () => {
    /**
     * `api/index.ts` is a label, not a path — nothing resolves it — and one separator in the UI reads
     * consistently whichever OS the participant is on. Pinned so it is not "fixed" into a backslash
     * later on the assumption that it must match the filesystem.
     */
    expect(tabLabels(["C:\\a\\x.ts", "C:\\b\\x.ts"])["C:\\a\\x.ts"]).toBe("a/x.ts");
  });

  it("falls back to the whole path when there is no separator at all", () => {
    // A bare filename is its own label; the `|| path` fallback must survive.
    expect(tabLabel("main.ts")).toBe("main.ts");
    expect(tabLabel("")).toBe("");
  });
});

describe("no renderer file splits a path on a literal separator any more", () => {
  it("has no `split(\"/\")` left outside tests", async () => {
    /**
     * The sweep, because this defect was a PATTERN across eight sites rather than one bug — and a ninth
     * would be added by anyone who did not know. Counted over the whole renderer so a new one fails
     * here rather than on somebody's Windows laptop.
     */
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { join } = await import("node:path");

    const root = fileURLToPath(new URL("./..", import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
        const code = readFileSync(full, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, " ")
          .replace(/^\s*\/\/.*$/gm, " ");
        if (/split\("\/"\)/.test(code)) offenders.push(full.replace(root, ""));
      }
    };
    walk(root);

    expect(offenders, `these still split a path on "/": ${offenders.join(", ")}`).toEqual([]);
  });
});
