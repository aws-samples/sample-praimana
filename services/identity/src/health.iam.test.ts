import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  hasInfrastructureTemplate,
  infrastructureTemplateText,
  TEMPLATE_ABSENT_TODO,
} from "@praimana/service-shared";

/**
 * ── ⚠ THE HEALTH GRANT MUST STAY `Resource: "*"` — THE SURPRISING DIRECTION ──────────────────
 *
 * This file now pins the OPPOSITE of what it originally pinned, and the history is the point.
 *
 *  1. The statement was `Resource: "*"` with a comment ASSERTING that DescribeAlarms takes no resource-level
 *     conditions. Unverified.
 *  2. It was then SCOPED to `alarm:praimana-*` on two independent pieces of evidence: AWS's API
 *     reference ("You can't return information about composite alarms if your cloudwatch:DescribeAlarms
 *     permission has a narrower scope" — implying narrower scopes exist), and `iam simulate-custom-policy`
 *     reporting `allowed` for a platform alarm ARN and `implicitDeny` for another team's.
 *  3. IT WAS DEPLOYED AND THE REAL CALL RETURNED `AccessDenied` (in the identity log), while
 *     `simulate-principal-policy` against the REAL role still said `allowed`. CloudWatch authorises this
 *     LIST operation against `*`, whatever the policy permits per alarm.
 *
 * ⚠ SO WHAT THIS TEST NOW GUARDS IS SOMEBODY SCOPING IT — a change that reads like tightening, passes IAM
 * simulation, deploys green, and breaks the health tab with an AccessDenied nobody sees until they open it.
 *
 * ⚠ AND THE LESSON GENERALISES: `iam simulate-*` evaluates POLICY LOGIC, not a service's own authorisation
 * semantics. For list/describe operations it can bless a call the service refuses. Only a real call settles
 * it — the same reason this repo already distrusts green tests over AWS APIs.
 *
 * Exposure is bounded by the QUERY instead (the reader passes `AlarmNamePrefix`), which is a bound on
 * behaviour rather than on permission, and weaker. Named rather than glossed.
 */

/**
 * ⚠ `infrastructureTemplateText()` RETURNS "" WHEN THE TEMPLATE IS ABSENT, NOT NULL, and the
 * difference decides whether this file loads. Module-scope helpers below derive values from
 * TEMPLATE during COLLECTION, before any `describe` runs, so a null would throw and the file would
 * FAIL rather than skip. `HAS_TEMPLATE` is what gates the assertions.
 */
const TEMPLATE = infrastructureTemplateText();
const HAS_TEMPLATE = hasInfrastructureTemplate();

/**
 * The PlatformHealthRead statement AND the comment block above it — which is what a reader actually sees, and
 * the reason the slice starts where it does: the rationale for a permission sits above the permission in this
 * template, so a check that begins at `- PolicyName:` cannot see the thinking it is meant to hold in place.
 */
function healthPolicy(): string {
  // ⚠ NO-OP WITHOUT THE TEMPLATE. `describe.skipIf` still EVALUATES the describe body during
  // collection, so helpers called there run even when every test in them is skipped — and an
  // `expect` in here would fail the file rather than skip it. Guarded at the top so the absent-
  // template path stays a todo. See `sibling-repo.ts`.
  if (!HAS_TEMPLATE) return "";
  const name = TEMPLATE.indexOf("- PolicyName: PlatformHealthRead");
  expect(name, "the PlatformHealthRead policy must exist").toBeGreaterThan(-1);

  // Walk back over the contiguous run of comment lines immediately above it.
  const lines = TEMPLATE.slice(0, name).split("\n");
  let first = lines.length - 1;
  while (first > 0 && lines[first - 1].trim().startsWith("#")) first -= 1;
  const start = lines.slice(0, first).join("\n").length;

  const next = TEMPLATE.indexOf("- PolicyName:", name + 1);
  return TEMPLATE.slice(start, next === -1 ? undefined : next);
}

/**
 * ⚠ TWO VIEWS, AND CONFUSING THEM BREAKS THIS FILE IN BOTH DIRECTIONS.
 *
 * `statement` is the YAML with comments stripped: what IAM actually receives. `rationale` is the whole block
 * including the prose. The permission assertions must read the former — the comment above the policy explains
 * the `Resource: "*"` mistake and therefore CONTAINS that string, so `not.toMatch(/Resource: "\*"/)` against
 * the full text fails on a correctly-scoped policy. (And the mirror image has bitten this repo twice: an
 * assertion satisfied by a comment that merely quoted the thing being asserted.)
 */
const rationale = healthPolicy();
const statement = rationale
  .split("\n")
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n");

describe.skipIf(!HAS_TEMPLATE)("the platform-health IAM grant", () => {
  const policy = statement;

  it("⚠ IS Resource: '*', because CloudWatch refuses the call otherwise", () => {
    // Verified the hard way: the scoped form deployed cleanly and then returned AccessDenied live.
    expect(policy, "DescribeAlarms is authorised against * — see the header").toMatch(/Resource:\s*"\*"/);
  });

  it("⚠ and the ARN-scoped form is NOT reintroduced", () => {
    // The plausible "improvement" that has already been tried and failed in production.
    expect(policy).not.toMatch(/alarm:praimana-\*/);
  });

  it("⚠ grants exactly ONE action, and it is a READ", () => {
    /**
     * The health page renders alarm states. `GetMetricData` would let it recompute thresholds — which is
     * both unnecessary and the thing that would let this page disagree with the alarms that page whoever is
     * on call. Anything mutating (SetAlarmState, DisableAlarmActions, DeleteAlarms) would turn a read-only
     * panel into an operational lever on a role every service holds.
     */
    const actions = [...policy.matchAll(/^\s*-\s*(cloudwatch:[A-Za-z]+)\s*$/gm)].map((m) => m[1]);
    expect(actions).toEqual(["cloudwatch:DescribeAlarms"]);
  });

  it("⚠ the READER still narrows by prefix, since the GRANT cannot", () => {
    /**
     * The two halves have to agree or the grant is either useless or wider than the query. The adapter asks
     * for `AlarmNamePrefix: "praimana-"`; the policy allows `alarm:praimana-*`. If somebody
     * changes one, this fails rather than the page quietly returning nothing.
     */
    const reader = readFileSync(
      fileURLToPath(new URL("./health.cloudwatch.ts", import.meta.url)),
      "utf8"
    );
    expect(/const ALARM_PREFIX = "([^"]+)"/.exec(reader)?.[1]).toBe("praimana-");
    expect(reader, "the only remaining bound is what the code asks for").toMatch(
      /AlarmNamePrefix: ALARM_PREFIX/
    );
  });
});

/**
 * ⚠ ABSENT TEMPLATES ⇒ A TODO, NEVER A SILENT PASS. Every assertion above is skipped when the
 * infrastructure templates cannot be read, so this reports the gap in the run summary instead of
 * leaving a low test count to be noticed by nobody. Declared only when absent, because vitest counts
 * an `it.todo` inside a skipped `describe`. See `sibling-repo.ts`.
 */
if (!HAS_TEMPLATE) {
  describe("the infrastructure template", () => {
    it.todo(TEMPLATE_ABSENT_TODO);
  });
}
