import { describe, it, expect } from "vitest";
import {
  hasInfrastructureTemplate,
  infrastructureTemplateText,
  TEMPLATE_ABSENT_TODO,
} from "@praimana/service-shared";

/**
 * ── ⚠ THE LINK ALLOWLIST IS A DEPLOYMENT FACT, AND IT WAS ABSENT ────────────────────────────────
 *
 * `rejectActionUrl` (routes.ts) refuses any emailed `actionUrl` whose origin is not on the allowlist,
 * which it reads from `NOTIFY_ALLOWED_LINK_ORIGINS` / `APP_URL` / `PORTAL_URL`. `NotifyFunction`
 * declared NONE of the three.
 *
 * ⚠ THAT WAS THE LIVE HALF OF A SECURITY FINDING, NOT A DORMANT CONFIG GAP. The guard used to FAIL
 * OPEN when it resolved no origins — warn, then allow — so the allowlist had never once been enforced
 * in the deployed account, on any of the five send routes. Any caller past the sender-role gate (which
 * admits EXECUTIVE, an ordinary team-level user) could aim the platform's own branded, SPF/DKIM-signed
 * button at a host they controlled, for up to 50 caller-chosen addresses.
 *
 * ⚠ AND IT IS NOW LOAD-BEARING IN THE OTHER DIRECTION. The guard now fails CLOSED, so an
 * unset value REFUSES every invitation and password reset with a 400. The variable is therefore a
 * precondition for the service working at all — which is precisely the category this repo's cross-repo
 * template tests exist for: "numbers and route keys in CloudFormation … every way they go wrong is
 * structural and deploys cleanly".
 *
 * ⚠ WHY A TEST AND NOT A COMMENT. Nothing in the services repo can observe a Lambda's environment, and
 * no unit test can: they call the Hono app directly and set `process.env` themselves. The blind spot is
 * identical to the one `routes.gateway-mapping.test.ts` was written for — passing tests, unusable
 * feature. This is the only place the two repos can be made to agree.
 *
 * ⚠ WHAT THIS STILL CANNOT PROVE: that the DEPLOYED stack matches this template, or that the
 * `PortalUrl` parameter was given a value at deploy time (it defaults to `""`, and an empty value
 * refuses mail exactly as an absent variable would). Those need a live probe. The distinction matters
 * and is the same one that file draws.
 */

const TEMPLATE = infrastructureTemplateText();
const HAS_TEMPLATE = hasInfrastructureTemplate();

/**
 * The `NotifyFunction` resource's text, from its key to the start of the next top-level resource.
 *
 * Sliced rather than YAML-parsed because the template uses SAM shorthand tags (`!Ref`, `!Sub`,
 * `!GetAtt`) that a plain YAML loader rejects — the same approach every other template test here takes.
 * Returns "" when the template is absent, so module scope cannot throw during collection.
 */
function notifyFunctionBlock(): string {
  if (!TEMPLATE) return "";
  const start = TEMPLATE.indexOf("\n  NotifyFunction:");
  if (start === -1) return "";
  // The next resource at the same indentation ends the block.
  const rest = TEMPLATE.slice(start + 1);
  const end = rest.search(/\n {2}[A-Za-z0-9]+:\n {4}Type:/);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * The same block with COMMENT LINES REMOVED.
 *
 * ⚠ NEEDED BECAUSE THE FIRST VERSION OF THE "no escape hatch" ASSERTION FAILED ON ITS OWN
 * DOCUMENTATION. The template's comment explains that `NOTIFY_ALLOW_UNRESTRICTED_LINKS=true` is the
 * recovery hatch, and a substring search over the raw block matched that PROSE — reporting the hatch
 * as enabled when nothing was set. A template test must assert on DECLARATIONS, never on the presence
 * of a word: this codebase comments heavily on purpose, so any check that cannot tell a declaration
 * from a note about one will eventually be wrong in whichever direction is worse.
 */
function notifyFunctionDeclarations(): string {
  return notifyFunctionBlock()
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

describe.skipIf(!HAS_TEMPLATE)("NotifyFunction declares where an emailed link may point", () => {
  it("exists in the template at all", () => {
    // Guards the slice above: a renamed resource would make every assertion below vacuously pass on
    // an empty string.
    expect(notifyFunctionBlock()).not.toBe("");
    expect(notifyFunctionBlock()).toContain("FunctionName: praimana-notify");
  });

  it("⚠ sets at least one of the three variables the allowlist is read from", () => {
    /**
     * THE ASSERTION THIS FILE EXISTS FOR. `allowedLinkOrigins()` reads exactly these three, in this
     * order, and an empty result now refuses every link. Any one of them satisfies the code, so the
     * test accepts any one rather than mandating the specific name — dictating WHICH would make a
     * legitimate template refactor fail for no security reason.
     */
    const block = notifyFunctionDeclarations();
    const declared = [
      "NOTIFY_ALLOWED_LINK_ORIGINS:",
      "APP_URL:",
      "PORTAL_URL:",
    ].filter((name) => block.includes(name));

    expect(
      declared,
      "notify's emailed-link allowlist resolves from NOTIFY_ALLOWED_LINK_ORIGINS/APP_URL/PORTAL_URL. " +
        "With none of them set, rejectActionUrl REFUSES every actionUrl and all invitations and " +
        "password resets 400. Add NOTIFY_ALLOWED_LINK_ORIGINS: !Ref PortalUrl to NotifyFunction."
    ).not.toEqual([]);
  });

  it("points the allowlist at the PORTAL origin, not the API domain", () => {
    /**
     * ⚠ THE MISTAKE THIS PINS HAS ALREADY BEEN MADE ONCE ON THIS PLATFORM, on the neighbouring
     * bulk-provision worker: `APP_URL: !Sub "https://${DomainName}"` sent every invite link to
     * `api.<host>/join/<token>`, where `/join` does not exist. The template's own comment records it
     * ("each token is SINGLE-USE, so the only recovery would have been revoking and re-inviting
     * everybody").
     *
     * Here the same error is worse than a dead link: the allowlist would name the API origin while
     * every real link points at the portal, so the guard would refuse ALL legitimate mail while still
     * being, technically, configured.
     */
    const block = notifyFunctionDeclarations();
    const line = block
      .split("\n")
      .find((l) => /(NOTIFY_ALLOWED_LINK_ORIGINS|APP_URL|PORTAL_URL):/.test(l));

    expect(line).toBeDefined();
    expect(line, "the allowlist must be the PORTAL origin — DomainName is the API").not.toContain(
      "DomainName"
    );
    expect(line).toContain("PortalUrl");
  });

  it("does NOT ship the unrestricted-links escape hatch turned on", () => {
    /**
     * `NOTIFY_ALLOW_UNRESTRICTED_LINKS=true` restores the old fail-open behaviour. It exists so an
     * operator can recover delivery without a code deploy — a deliberate, recorded decision. Shipping
     * it in the template would make that decision permanent and invisible, which is the exact state
     * the fail-closed change was made to end.
     */
    expect(notifyFunctionDeclarations()).not.toContain("NOTIFY_ALLOW_UNRESTRICTED_LINKS");
  });
});

describe.skipIf(HAS_TEMPLATE)("the infrastructure template", () => {
  it.todo(TEMPLATE_ABSENT_TODO);
});
