// ── ⚠ THE ONLY ADMIN-ONLY TAB, AND A PANEL THAT MUST NEVER SHOW A FALSE ZERO ──────────────────
//
// Estimated daily and overall spend, visible to admins only, ideally scoped by the `ApplicationName`
// cost allocation tag.
//
// Two things here are easy to get wrong and expensive in different currencies:
//
//   1. AUDIENCE. Every other tab on /admin is ADMIN + FACILITATOR, because that is what /admin means. This one
//      is narrower, so the tab list has to be filtered AND the URL validated against the filtered list -
//      otherwise `?tab=cost` deep-links a facilitator into a panel the service will 403. Offering a role
//      something the route then refuses is the mistake already made three times on this platform (the Submit
//      tab, /how-it-works, /desktop).
//   2. HONESTY. The tag-based figure CANNOT be produced yet: cost allocation tags are
//      activated in the management account and this is a linked account, so Cost Explorer holds no
//      ApplicationName data. A tag-filtered total is $0.00 today. The panel therefore shows the ACCOUNT total,
//      labelled, and explains the tag situation, rather than reporting that the platform is free.
//
// Source assertions with comments stripped: a source test can otherwise pass on a comment that merely
// quotes the thing being asserted.

import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { sourceWithoutComments } from "@/lib/source-under-test";
import { canSeePlatformSpend, canManageUsers } from "@praimana/shared";

const admin = sourceWithoutComments(join(__dirname, "page.tsx"));
const router = sourceWithoutComments(
  join(__dirname, "..", "..", "lib", "trpc", "routers", "health.ts")
);

describe("the audience is narrower than the page", () => {
  it("⚠ ADMIN may see spend; FACILITATOR may reach /admin but NOT spend", () => {
    // The two predicates must disagree, that disagreement IS the feature. If they ever returned the same
    // answer for FACILITATOR, the tab would be offered to someone the service refuses.
    expect(canManageUsers("FACILITATOR"), "a facilitator reaches Administration").toBe(true);
    expect(canSeePlatformSpend("FACILITATOR"), "but not the spend").toBe(false);
    expect(canSeePlatformSpend("ADMIN")).toBe(true);
  });

  it("⚠ filters the TAB LIST rather than only hiding the panel", () => {
    expect(admin).toMatch(/adminOnly: true/);
    expect(admin).toMatch(/canSeePlatformSpend\(role\)/);
    // Rendered from the filtered list, not the full one, otherwise the tab still appears.
    expect(admin).toMatch(/\{tabs\.map\(/);
    expect(admin, "the raw TABS list must not be what gets rendered").not.toMatch(/\{TABS\.map\(/);
  });

  it("⚠ validates ?tab= against the FILTERED list, so a deep link cannot bypass it", () => {
    /**
     * The subtle half. With `TABS.some(...)` a facilitator typing ?tab=cost would land on a panel that then
     * 403s, a UI bug indistinguishable from a permissions one. Against the filtered list they fall back to
     * Users.
     */
    expect(admin).toMatch(/tabs\.some\(\(t\) => t\.key === requested\)/);
    expect(admin).not.toMatch(/TABS\.some\(\(t\) => t\.key === requested\)/);
  });

  it("uses the SHARED predicate for SPEND, not an inline role comparison", () => {
    /**
     * Three call sites have to agree about who may see spend (the tab, the BFF, the service route), and an
     * inline string comparison is how one of them ends up checking the wrong case or silently admitting a new
     * role.
     *
     * ⚠ SCOPED TO THE SPEND CODE, NOT THE WHOLE FILE, and deliberately so. `ExperiencesTab` already has its own
     * `role === "ADMIN"` for the experience-configuration affordances, a DIFFERENT question that happens to
     * have the same answer today. Folding it into `canSeePlatformSpend` would be false sharing: the next time
     * one of those rules moves, the other would move with it for no reason. So this test covers the region it
     * is about and says why the other one stays.
     */
    const spendRegion = admin.slice(
      admin.indexOf("const tabs = TABS.filter"),
      admin.indexOf("{tab === \"users\"")
    );
    expect(spendRegion, "the tab filter must not compare roles inline").not.toMatch(/role === "ADMIN"/);
    expect(spendRegion).toMatch(/canSeePlatformSpend/);

    const costPanel = admin.slice(admin.indexOf("function CostTab"));
    expect(costPanel, "the panel must not re-decide the audience").not.toMatch(/role === "ADMIN"/);
  });
});

describe("the panel cannot report a comfortable wrong number", () => {
  it("⚠ never defaults a figure to zero in the BFF", () => {
    // `?? 0` on the tagged total is the whole defect in one operator: "no tag data" would render as "the
    // platform spends nothing".
    expect(router).toMatch(/taggedTotal === null \|\| data\.taggedTotal === undefined \? null/);
  });

  it("⚠ lets the service's 503 surface, no catch that returns zeros", () => {
    expect(router).not.toMatch(/catch/);
  });

  it("⚠ explains the missing tag breakdown instead of showing 0", () => {
    expect(admin).toMatch(/taggedTotal === null/);
    expect(admin).toMatch(/not available yet/i);
    // And names the actual reason, which is the only thing that makes it actionable.
    expect(admin).toMatch(/management account/i);
  });

  it("⚠ says the error is a failed query, not a spend of zero", () => {
    expect(admin).toMatch(/could not be read/i);
    expect(admin).toMatch(/not a spend of zero/i);
  });

  it("⚠ states the SCOPE, because the account is not exactly the platform", () => {
    // One unrelated stack shares the account and the shared build account is not counted. Precision claimed is
    // precision owed.
    expect(admin).toMatch(/Scope:/);
    expect(admin).toMatch(/not included|not exactly/i);
  });
});

describe("it does not become a line item of its own", () => {
  it("⚠ does NOT poll, each query is billed", () => {
    /**
     * $0.01 per Cost Explorer request against a platform that spends ~$1/day. A `refetchInterval` here would
     * quietly turn a panel into a recurring charge; the health tab polls precisely because ITS read is free.
     */
    const costPanel = admin.slice(admin.indexOf("function CostTab"));
    expect(costPanel).not.toMatch(/refetchInterval/);
    expect(costPanel).toMatch(/refetchOnWindowFocus: false/);
  });

  it("shows how old the figures are", () => {
    // A cached number without an age is a number that lies.
    expect(admin).toMatch(/As of:/);
  });

  it("formats money through Intl with the currency the API reported", () => {
    // Not `$${n.toFixed(2)}`, the currency comes from Cost Explorer's response rather than an assumption.
    expect(admin).toMatch(/Intl\.NumberFormat/);
    expect(admin).toMatch(/style: "currency", currency/);
  });
});
