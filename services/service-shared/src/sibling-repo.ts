import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

/**
 * ── READ A FILE THAT LIVES IN ANOTHER REPO OF THIS PLATFORM ──────────────────────────────────
 *
 * ⚠ THIS IS THE HONEST VERSION OF A PROBLEM WITH NO CLEAN ANSWER. Six tests in this repo assert
 * facts about the infrastructure CloudFormation template — throttle settings, gateway route
 * mappings, IAM shape, the MFA email template — because those facts are NOT CODE. They are numbers
 * and route keys in CloudFormation, and every way they go wrong is structural and deploys cleanly:
 *
 *   · ai/src/throttling.template.test.ts          — RouteSettings keyed on a route that must EXIST
 *   · identity/src/routes.gateway-mapping.test.ts — a mapping typo 404s a fully-tested route
 *   · identity/src/health.iam.test.ts             — the health probe's IAM grant
 *   · identity/src/infra-guardrails.test.ts       — template-level guardrails
 *   · docs/src/routes.gateway-mapping.test.ts     — as above, for docs
 *   · user-access/src/mfa-email-otp.template.test.ts — the OTP email
 *
 * The infrastructure template lives in a SEPARATE repo, so a plain relative path to it is only
 * resolvable on a checkout that happens to have the sibling repo beside this one — and on NO CI
 * runner by default. An accident of directory depth is not a dependency anyone can maintain.
 *
 * ⚠ SO: PRESENT ⇒ ASSERT, ABSENT ⇒ `it.todo`. Never a silent pass. `existsSync` before `readFileSync`
 * is the whole mechanism, and callers guard with `describe.skipIf(!TEMPLATE)` plus a matching
 * `it.todo`, so an absent checkout is REPORTED in every run summary rather than inferred from a low
 * test count. This mirrors `sibling-repo-source.ts` in the portal repo, deliberately — two repos
 * solving the same problem two ways is how one of them rots.
 *
 * ⚠ CI MUST CHECK OUT THE SIBLING, or these six assertions never run where it matters. Point
 * `AIAP_INFRASTRUCTURE_REPO` at the checkout if the layout differs.
 */
export type SiblingRepo = "infrastructure" | "portal" | "desktop" | "shared";

/**
 * This repo's root — `service-shared/src/` up TWO, verified by computing it rather than counting
 * dots: `service-shared/src/` → `service-shared/` → `services/`. Siblings then hang off `../`.
 *
 * ⚠ I GOT THIS WRONG ONCE WITH `../../..`, AND THE FAILURE MODE IS WHY THIS COMMENT EXISTS. That
 * resolved to the platform directory, so `../infrastructure` became `~/projects/infrastructure` —
 * absent — and all six assertion sets reported as SKIPPED on a machine that had the sibling checked
 * out. Nothing failed; the suite simply stopped testing the template and said so quietly in a summary.
 * A wrong depth here is invisible in exactly the direction that matters.
 *
 * ⚠ ANCHORED ON THIS FILE, NOT ON `process.cwd()`. Vitest is invoked per package (`pnpm -r run test`),
 * so the working directory is whichever service is running; a cwd-relative path would resolve
 * differently for `ai` than for `identity` and be reliably correct for neither.
 */
const THIS_REPO = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The directory each sibling occupies beside this one. In this repository the infrastructure
 * templates live in `infra/`, so a lookup for `infrastructure` must resolve there, not to a
 * non-existent `../infrastructure` that would quietly turn every template assertion into a todo.
 */
const SIBLING_DIRECTORY: Readonly<Record<SiblingRepo, string>> = {
  infrastructure: "infra",
  portal: "portal",
  desktop: "desktop",
  shared: "shared",
};

/** Where a sibling repo is expected: beside this one, unless the env var overrides it. */
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
 * Where the templates are expected to live, exported so a todo message can name the exact path.
 *
 * The platform is split into tier templates, `infra/aws/app/platform*.yaml` (the `platform.yaml`
 * master plus one file per tier). If that directory moves, update it here — a wrong path makes
 * these assertions silently degrade to todos rather than catching a real drift.
 *
 * ⚠ These template assertions are gated present ⇒ assert, absent ⇒ todo (see the header). An armed
 * template test asserting a required variable fails the moment the code starts requiring it; a
 * mis-pointed path instead reports a quiet todo in every run, so keep this path correct.
 */
export function infrastructureTemplatePath(): string {
  return siblingRepoPath("infrastructure", "aws", "app");
}

/** The tier template files, sorted, or an empty list when the directory is absent. */
function tierTemplateFiles(): string[] {
  const dir = infrastructureTemplatePath();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^platform.*\.yaml$/.test(f))
    .sort()
    .map((f) => join(dir, f));
}

/**
 * Every tier template's text, concatenated in a stable order. The assertions were written against a
 * single all-in-one template; each resource now lives whole in exactly one tier, so a resource-level
 * search over the concatenation finds the same text it found before the split.
 */
export function readInfrastructureTemplate(): string | null {
  const files = tierTemplateFiles();
  if (files.length === 0) return null;
  return files.map((f) => readFileSync(f, "utf8")).join("\n");
}

/**
 * True when the templates could be read. Use THIS for `describe.skipIf(!HAS_…)`, and
 * {@link infrastructureTemplateText} for the content.
 */
export function hasInfrastructureTemplate(): boolean {
  return tierTemplateFiles().length > 0;
}

/**
 * The template's text, or the EMPTY STRING when it cannot be read.
 *
 * ⚠ EMPTY STRING RATHER THAN NULL, AND THIS IS NOT COSMETIC — IT IS WHAT MAKES `skipIf` WORK AT ALL.
 *
 * Three of these six tests build derived values at MODULE SCOPE — `const rationale = healthPolicy()`
 * in `identity/src/health.iam.test.ts:63`, for instance, which calls `TEMPLATE.indexOf(…)`. Module
 * scope runs during COLLECTION, before any `describe` is evaluated, so a null template throws
 * `TypeError: Cannot read properties of null` and the file fails to load. `describe.skipIf` never gets
 * a chance to skip anything: the suite is red, not skipped, which is the opposite of the intent.
 *
 * With `""` those helpers degrade quietly — `indexOf` returns -1, slices come back empty — and the
 * assertions that would have consumed them are skipped by the guard. Nothing silently PASSES, because
 * every affected `describe` is gated and a todo reports the gap.
 */
export function infrastructureTemplateText(): string {
  return readInfrastructureTemplate() ?? "";
}

/** The message an `it.todo` carries when the template could not be read, naming the path and override. */
export const TEMPLATE_ABSENT_TODO =
  `is checked against the infrastructure templates once platform*.yaml exist in ` +
  `${infrastructureTemplatePath()} — check that the template directory is current; ` +
  `override with AIAP_INFRASTRUCTURE_REPO`;
