import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ── READ A SOURCE FILE THAT LIVES IN ANOTHER REPO OF THIS PLATFORM ──────────────────────────
 *
 * ⚠ THIS IS THE HONEST VERSION OF A PROBLEM THAT HAS NO CLEAN ANSWER: asserting an agreement between
 * two apps that live in separate repositories.
 *
 * Four tests in this suite deliberately assert agreements that NO SHARED MODULE ENFORCES, by reading a
 * file belonging to another app:
 *
 *   · `components/feedback-form-bounds.test.ts` → the desktop's `AccountPanel.tsx`. The bug it catches is
 *     one of the two feedback forms being fixed while the other keeps springing the 20-word floor on Send.
 *   · `components/auth/code-field-placeholder.test.ts` → the desktop's `SignInView.tsx`. Two apps, ONE
 *     login: a different placeholder in each invites the reader to wonder whether one wants something else.
 *   · `lib/idle-timeout.test.ts` → the infrastructure template. A 30-minute Cognito token
 *     lifetime is a security control, and the template is where the mistake would be made.
 *   · `lib/phase-status.test.ts` → the desktop's `PhasesView.tsx`. Both apps derive a phase's
 *     COMPLETED/IN_PROGRESS/NOT_STARTED pill from the workshop's `currentPhaseOrder`; if one app's operator
 *     moves, the two disagree about whether a team finished a phase. ⚠ Asserted STRUCTURALLY, not
 *     textually, the two modules name the variable differently (`currentOrder` vs `currentPhaseOrder`), so
 *     demanding identical text would fail on a correct rename.
 *
 * Because those files live in separate repositories, the paths are not always resolvable. This repo is
 * self-contained by design, so every alternative is worse than this one:
 *
 *   · Keep the hard relative path → `pnpm test` is RED on a correct, complete clone of this repo. A suite
 *     that is red by default is a suite nobody reads, so it protects nothing.
 *   · Delete the three assertions → three real cross-app agreements silently lose their only automated
 *     check, and nothing anywhere records that they used to have one.
 *   · Vendor the other apps' files → copies of somebody else's source of truth, stale within a week, and
 *     the assertion would then be about the copy rather than about the app that ships.
 *
 * ⚠ SO: PRESENT ⇒ ASSERT, ABSENT ⇒ `it.todo`. The check runs wherever the sibling repo is reachable, the
 * normal local layout, all four repos checked out side by side, and reports as TODO where it is not,
 * which vitest prints in every summary. It never reports as PASSED without having looked. `existsSync`
 * before `readFileSync` is the whole mechanism: a MISSING repo is a todo, but a file that is missing from a
 * repo that IS present still throws, because that is a real breakage (a rename nobody propagated) and not
 * an absent checkout.
 *
 * ⚠ CI MUST CHECK OUT THE SIBLINGS, or these three assertions never run in the one place it matters. Point
 * the env vars at the checkouts if the layout differs:
 * `AIAP_DESKTOP_REPO`, `AIAP_INFRASTRUCTURE_REPO`, `AIAP_SERVICES_REPO`, `AIAP_SHARED_REPO`.
 */
export type SiblingRepo = "desktop" | "infrastructure" | "services" | "shared";

/** This repo's root, `src/lib/` up two. */
const THIS_REPO = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The directory each sibling occupies beside this one. The infrastructure templates live in `infra/`,
 * so a lookup for `infrastructure` must resolve there rather than to a non-existent `../infrastructure`.
 */
const SIBLING_DIRECTORY: Readonly<Record<SiblingRepo, string>> = {
  desktop: "desktop",
  infrastructure: "infra",
  services: "services",
  shared: "shared",
};

export function siblingRepoPath(repo: SiblingRepo, ...parts: string[]): string {
  const override = process.env[`AIAP_${repo.toUpperCase()}_REPO`];
  const root = override ? resolve(override) : join(THIS_REPO, "..", SIBLING_DIRECTORY[repo]);
  return join(root, ...parts);
}

/** True when the sibling repo is checked out where `siblingRepoPath` looks for it. */
export function siblingRepoPresent(repo: SiblingRepo): boolean {
  return existsSync(siblingRepoPath(repo));
}

/**
 * The file's source with comments stripped, the same treatment `source-under-test.ts` applies, and for the
 * same reason: an assertion of the form `expect(src).toContain("…")` is otherwise satisfied by a COMMENT
 * that merely mentions the thing. Two of this suite's source assertions have already passed that way.
 *
 * ⚠ THROWS if the repo is present but the file is not. Guard the call with `siblingRepoPresent` and let the
 * test be a todo when the answer is false; do NOT swallow a missing file inside a present repo.
 */
export function readSiblingRepoSource(repo: SiblingRepo, ...parts: string[]): string {
  return readFileSync(siblingRepoPath(repo, ...parts), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/(?<!:)\/\/.*$/gm, " ");
}
