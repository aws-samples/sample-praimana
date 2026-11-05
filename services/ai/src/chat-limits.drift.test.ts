/**
 * ── ⚠ THE TEST chat-limits.ts CLAIMED EXISTED, AND DID NOT ──────────────────────────────────
 *
 * `constants/chat-limits.ts` says of MAX_AI_PROMPT_CHARS: "`chat-limits.drift.test.ts` asserts the
 * two stay equal, because they are two numbers that must agree and nothing else makes them." No such
 * file existed anywhere in any of the four repositories — `portal/shared/index.ts` even describes it
 * as "the ONE test not copied with its module", which reads as an explanation for its absence rather
 * than a pointer to it. So the guarantee was documented and unimplemented, which is worse than
 * undocumented: a reader checking whether the numbers were pinned would have concluded they were.
 *
 * The gap surfaced while promoting chat-limits into the services copy of the shared package. The
 * claim is now true.
 *
 * ⚠ IT LIVES IN THE ai SERVICE, NOT IN shared/. The vendored `shared/` tree is hash-locked by
 * scripts/check-vendored-shared.sh, which hashes every `*.ts` under it — a test in there would have
 * to be copied byte-identically into the desktop and portal trees too, where it cannot run because
 * neither repo contains the AI service. This service owns MAX_SYNC_CONTENT, so this is where the
 * two values can both be read.
 *
 * ⚠ AND IT READS THE SOURCE RATHER THAN IMPORTING MAX_SYNC_CONTENT, because that constant is
 * module-private in routes.ts — deliberately, it is not part of the service's surface. Exporting it
 * purely so a test could import it would widen the surface to suit the test; reading the file is the
 * same technique buildspec-toolchain.test.ts and the template assertions in this repo already use.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_AI_PROMPT_CHARS } from "@praimana/shared";

const ROUTES = readFileSync(join(__dirname, "routes.ts"), "utf8");

describe("⚠ the AI prompt ceiling agrees with the service's own limit", () => {
  it("MAX_AI_PROMPT_CHARS equals MAX_SYNC_CONTENT", () => {
    const match = /const MAX_SYNC_CONTENT = ([0-9_]+);/.exec(ROUTES);
    expect(match, "MAX_SYNC_CONTENT declaration not found — has it been renamed?").not.toBeNull();

    const serviceLimit = Number(match![1].replace(/_/g, ""));

    /**
     * Why equality and not "client ≤ server": a SMALLER client cap forbids prompts the platform can
     * store, and a LARGER one lets the participant type, send, watch the assistant answer, and then
     * lose the turn from the transcript — the service REJECTS rather than truncates. The failure is
     * invisible when it happens and discovered later, which is the shape chat-limits.ts calls "the
     * worst available".
     */
    expect(MAX_AI_PROMPT_CHARS).toBe(serviceLimit);
  });

  it("and the ceiling is still rejected rather than truncated, which is why equality matters", () => {
    // If this route ever truncated instead, "equal" would stop being the right relationship and
    // this test would be pinning the wrong invariant — so the rejection is asserted alongside it.
    expect(ROUTES).toMatch(/content\.length > MAX_SYNC_CONTENT/);
  });
});
