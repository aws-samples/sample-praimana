// ── ⚠ A PARTICIPANT'S URL, A JUDGE'S CLICK ───────────────────────────────────────────────────
//
// A code review found the four deliverable URLs (demoUrl, videoUrl, repoUrl, slidesUrl) accepted as
// bare `z.string()` and rendered straight into an anchor `href` on two staff screens. The privilege
// crossing is the point: the WRITER is a participant or executive on a team, the READERS are judges,
// facilitators and the experience-owning admin. A stored `javascript:` URL either executes in the
// reader's session on click, where the Cognito ID token used as the API bearer is readable from
// `/api/auth/session` and from Amplify's localStorage, or throws during render and takes the
// judging page to the error boundary for every reader. Both follow from the same missing check.
//
// ⚠ THE CONTROL ALREADY EXISTED AND WAS APPLIED ON THE SIBLING SURFACE. `isSafeHttpUrl` allowlists
// http/https and `PhaseNoteBody.tsx` uses it for participant-supplied phase links, with a comment
// recording that the previous code "rendered href={phase.content.trim()} directly, so a participant
// who stored a javascript: URL had it execute in the renderer's context on click". The same one-line
// reuse was missing at both submission sinks. This file pins it at both, plus at the write.
//
// Rendered as SOURCE ASSERTIONS because this suite has no DOM (vitest `environment: "node"`), which
// is the established pattern here, see `desktop-card-gate.test.ts` and `PhaseNoteBody`'s own tests.

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { isSafeHttpUrl } from "@praimana/shared";
import { sourceWithoutComments } from "./source-under-test";

/**
 * ⚠ COMMENTS STRIPPED, WHICH IS THE WHOLE POINT OF READING IT THIS WAY. Both pages TALK about
 * `isSafeHttpUrl` in their comments, so an assertion against the raw file would pass on a page that
 * merely mentions the control while rendering an ungated href. `sourceWithoutComments` is the
 * repo's helper for exactly this; its documented limit (it mangles string literals containing a
 * double slash) does not bite here, since nothing below asserts on a URL literal.
 */
const APP = join(__dirname, "..", "app", "experiences", "[id]", "submissions");
const detail = sourceWithoutComments(join(APP, "[submissionId]", "page.tsx"));
const worklist = sourceWithoutComments(join(APP, "page.tsx"));
const router = sourceWithoutComments(join(__dirname, "trpc", "routers", "submission.ts"));

describe("the allowlist itself refuses what the finding described", () => {
  /**
   * Guarding the guard. Every assertion below depends on `isSafeHttpUrl` actually refusing these,
   * and it lives in the vendored `shared/` copy, so if a well-meaning "let people paste bare
   * domains" change ever loosens it, this fails here rather than silently at the two sinks.
   */
  it("refuses the schemes that execute or embed", () => {
    for (const url of [
      "javascript:alert(document.cookie)",
      "JavaScript:alert(1)",
      "  javascript:alert(1)  ",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "github.com/team/repo",
      "",
    ]) {
      expect(isSafeHttpUrl(url), url).toBe(false);
    }
  });

  it("allows the real links a team actually submits", () => {
    for (const url of [
      "https://github.com/team/repo",
      "http://localhost:3000/demo",
      "https://drive.google.com/file/d/abc/view?usp=sharing",
    ]) {
      expect(isSafeHttpUrl(url), url).toBe(true);
    }
  });
});

describe("sink 1, the submission detail / scoring page a judge reads", () => {
  it("gates the href on isSafeHttpUrl", () => {
    expect(detail).toContain("isSafeHttpUrl");
    expect(detail).toMatch(/isSafeHttpUrl\(submission\[key\] as string\) \?/);
  });

  it("⚠ NEVER RENDERS AN UNGATED href FOR A TEAM-SUPPLIED URL", () => {
    // The regression to catch is someone re-adding the anchor outside the conditional. There must
    // be no `href={submission[...]}` that is not inside the guarded branch.
    const ungated = /href=\{submission\[[^\]]+\][^}]*\}/g;
    const hrefs = detail.match(ungated) ?? [];
    for (const h of hrefs) {
      const at = detail.indexOf(h);
      const preceding = detail.slice(Math.max(0, at - 400), at);
      expect(preceding, `ungated href: ${h}`).toContain("isSafeHttpUrl");
    }
  });

  it("renders a refused value as INERT TEXT rather than dropping it", () => {
    // The reader still needs to see that something was stored, silently omitting the row hides a
    // team's mistake from the person scoring them. Same choice PhaseNoteBody makes.
    expect(detail).toMatch(/not a valid web link/);
  });

  it("keeps rel=noreferrer noopener on the links that DO render", () => {
    // Second line, not the first: it does nothing about the scheme, but a valid https link opened
    // in a new tab still must not get a handle back to the judge's window.
    expect(detail).toMatch(/rel="noreferrer noopener"/);
  });
});

describe("sink 2, the judging worklist", () => {
  it("gates the demo href on isSafeHttpUrl", () => {
    expect(worklist).toContain("isSafeHttpUrl");
    expect(worklist).toMatch(/isSafeHttpUrl\(row\.demoUrl\) \?/);
  });

  it("⚠ NEVER RENDERS AN UNGATED href={row.demoUrl}", () => {
    const at = worklist.indexOf("href={row.demoUrl}");
    expect(at, "the sink should still exist").toBeGreaterThan(-1);
    expect(worklist.slice(Math.max(0, at - 400), at)).toContain("isSafeHttpUrl");
  });
});

describe("write-time, the schema that stores them", () => {
  /**
   * ⚠ BOTH ENDS, DELIBERATELY. Render-time is the controlling fix (it protects the rows already
   * stored, which a write-time check cannot reach). Write-time stops new ones arriving and means a
   * future sink that forgets the render check is not immediately exploitable. Neither is redundant.
   */
  it("routes ALL FOUR URL fields through the same checked builder", () => {
    // ⚠ ASSERTED ON THE PROPERTY, NOT THE EXPRESSION. This first pinned the inline
    // `field: z.string()...refine(...)` form, and then failed when the four identical copies were
    // (rightly) collapsed into one `submittedUrl()` helper, a test objecting to an improvement.
    // What matters is that no field bypasses the shared builder, which is also what stops three of
    // four being updated next time.
    for (const field of ["demoUrl", "videoUrl", "repoUrl", "slidesUrl"]) {
      expect(router, `${field} must use the checked builder`).toMatch(
        new RegExp(`${field}: submittedUrl\\(\\)`)
      );
    }
  });

  it("and that builder applies BOTH the scheme allowlist and a length bound", () => {
    // Two different jobs: the allowlist stops `javascript:` becoming an href, the bound stops an
    // unbounded string being stored and re-rendered forever. A 100KB `https://` URL passes the
    // allowlist, so neither check implies the other.
    const at = router.indexOf("function submittedUrl()");
    expect(at, "the builder should exist").toBeGreaterThan(-1);
    const body = router.slice(at, at + 500);
    expect(body).toContain("isSafeHttpUrl");
    expect(body).toMatch(/\.max\(MAX_URL_CHARS/);
  });

  it("⚠ STILL ACCEPTS null, because clearing a link must keep working", () => {
    // The submit form sends `null` for an emptied box (documented there: "an empty box is sent as
    // null, not as ''"). A refinement that rejected null would make the field unclearable, the
    // classic way a validation fix becomes a bug report.
    expect(router).toMatch(/v === null \|\| v === undefined \|\| isSafeHttpUrl\(v\)/);
  });
});
