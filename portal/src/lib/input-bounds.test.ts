// ── ⚠ EVERY ACCEPTED VALUE HAS AN EXPLICIT BOUND ──────────────────────────────────────────────
//
// A security finding: four tRPC inputs were explicitly unbounded and forwarded verbatim
// upstream, in a component whose own Zod schemas are documented as the ONLY bound in the system for
// some of these values, and where no request-body size limit existed at any layer:
//
//   · `message.send`, `metadata: z.any()`, sitting beside a `content` capped at 4,000
//                               characters and sidestepping it entirely. Removed: nothing sent it.
//   · `workshop.create/update`, `setupConfig: z.any()`, forwarded into a store that validates
//                               nothing inside it. Now a closed, size-bounded schema.
//   · `workshop.setPhases`, `name`/`description`/array all uncapped, while `create` caps the
//                               same two strings at 100/1000.
//   · `submission.publishResults`, `tieOrder` with no array or element cap, the one unbounded value
//                               in a file where everything else is bounded.
//
// The body cap at the entry point is asserted in `trpc/entry-bounds.test.ts`; this file asserts the
// schemas, and that the `z.any()` escape hatch has not come back anywhere in the routers.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { workshopSetupConfigSchema } from "./workshop-setup-schema";

const ROUTERS = join(__dirname, "trpc", "routers");

const routerSources = () =>
  readdirSync(ROUTERS)
    .filter((f) => f.endsWith(".ts") && !f.includes(".test."))
    .map((f) => ({ file: f, src: readFileSync(join(ROUTERS, f), "utf8") }));

/** Comments removed, every ⚠ note in these files quotes the defect it replaced. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("⚠ no unbounded escape hatch survives in the routers", () => {
  it("declares no z.any() input anywhere", () => {
    const offenders = routerSources()
      .filter(({ src }) => /z\.any\(\)/.test(stripComments(src)))
      .map(({ file }) => file);
    expect(
      offenders,
      "z.any() accepts any type, depth and size, and these schemas are the last bound before storage"
    ).toEqual([]);
  });

  it("caps every string and array in setPhases, matching create", () => {
    const workshop = stripComments(
      routerSources().find(({ file }) => file === "workshop.ts")!.src
    );
    const block = workshop.slice(workshop.indexOf("setPhases:"), workshop.indexOf("setCurrentPhase:"));
    expect(block).toMatch(/name: z\.string\(\)\.min\(1\)\.max\(/);
    expect(block).toMatch(/description: z\.string\(\)\.max\(/);
    expect(block).toMatch(/\.min\(1\)\s*\.max\(MAX_PHASES\)/);
  });

  it("caps both the tieOrder array and its elements", () => {
    const submission = stripComments(
      routerSources().find(({ file }) => file === "submission.ts")!.src
    );
    const block = submission.slice(submission.indexOf("publishResults:"));
    expect(block).toMatch(/tieOrder: z[\s\S]{0,120}?z\.string\(\)\.min\(1\)\.max\(/);
    expect(block).toMatch(/\.max\(MAX_TIE_ORDER_TEAMS\)/);
  });

  it("⚠ ACCEPTS NO `metadata` ON message.send, the field had no sender and no schema", () => {
    const message = stripComments(routerSources().find(({ file }) => file === "message.ts")!.src);
    const send = message.slice(message.indexOf("send:"));
    expect(send).not.toMatch(/metadata:/);
    // `parentId` stayed, and is bounded rather than a bare string.
    expect(send).toMatch(/parentId: z\.string\(\)\.max\(/);
  });
});

describe("the setupConfig schema", () => {
  const valid = {
    instructions: "Install dependencies and verify the build.",
  };

  it("accepts what the two forms actually emit", () => {
    expect(workshopSetupConfigSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts an empty object, the blank-textarea case", () => {
    // Both forms omit `setupConfig`/send `{}` when the box is blank.
    expect(workshopSetupConfigSchema.safeParse({}).success).toBe(true);
  });

  it("⚠ REFUSES AN UNKNOWN KEY RATHER THAN STRIPPING IT", () => {
    // Zod's default is to strip, which hides a dropped field behind a successful save. Any of the
    // removed fields (repoUrl/branch/setupGuideUrl/assistants) is now a visible 400, not a silent
    // discard. "A DROPPED FIELD IS WORSE THAN A REJECTED ONE."
    for (const surprise of [
      { repoUrl: "https://github.com/example/repo" },
      { assistants: { claude: {} } },
      { surprise: "value" },
    ]) {
      const res = workshopSetupConfigSchema.safeParse({ ...valid, ...surprise });
      expect(res.success, JSON.stringify(surprise)).toBe(false);
    }
  });

  it("refuses instructions that are not a string", () => {
    for (const instructions of [[1, 2], 42, {}, null]) {
      expect(
        workshopSetupConfigSchema.safeParse({ instructions }).success,
        String(instructions)
      ).toBe(false);
    }
  });

  it("⚠ REFUSES OVERSIZED INSTRUCTIONS, the bound against a prompt-crowding payload", () => {
    const huge = "x".repeat(16 * 1024 + 1);
    expect(workshopSetupConfigSchema.safeParse({ instructions: huge }).success).toBe(false);
  });
});
