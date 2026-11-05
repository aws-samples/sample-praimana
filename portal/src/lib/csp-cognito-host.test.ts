// ── ⚠ THE CSP'S connect-src MUST NOT FALL OPEN TO AWS-WIDE WILDCARDS ──────────────────────────
//
// A code review found the production CSP failing open on missing build configuration.
// `next.config.ts` derived the exact Cognito IDP host from NEXT_PUBLIC_COGNITO_USER_POOL_ID and,
// when that was unset or the derived region did not match its test, fell back to
// `https://*.amazonaws.com https://*.amazoncognito.com`.
//
// WHY THAT VALUE IS UNSAFE, in the file's own words: "A CSP host wildcard matches subdomains at ANY
// depth, so that pattern admitted every S3 bucket (attacker.s3.us-east-1.amazonaws.com) and every
// API Gateway on AWS, anyone can create a receiving endpoint inside it."
//
// WHY THE FALLBACK WAS UNGUARDED: it was justified on the claim that "`amplify.yml` asserts the
// variable in a real deployment". That control did not exist, the deploy assertion loop covered
// seven variables and this was not one of them, and the variable reached `.env.production` only via
// a generic `NEXT_PUBLIC_[A-Z_]+` capture that asserts nothing. Sign-in worked either way, so a
// deployment could run indefinitely on the wide policy with no signal at all.
//
// TWO AMPLIFIERS made connect-src the directive that mattered AT THE TIME: production `script-src`
// retained `'unsafe-inline'`, and the Cognito ID token that is this app's outbound API bearer was
// reachable from client-side JavaScript (Amplify localStorage). So the one directive narrowed
// specifically to close the exfiltration channel was the one that silently reopened.
//
// ⚠ BOTH AMPLIFIERS ARE NOW CLOSED (nonce + `'strict-dynamic'`, and `sessionStorage`, AWS Security
// Agent f-653f54c2 / f-1721edd4), which makes this guard MORE worth keeping rather than less: it is
// now the narrowing that the rest of the policy actually relies on, not the one thing holding a leaky
// design together.
//
// AND THE REGION TEST WAS WRONG FOR FOUR-SEGMENT REGIONS: `/^[a-z]{2}-[a-z]+-\d$/` fails
// `us-gov-west-1`, so a correctly-configured GovCloud deploy shipped the wildcard too.
//
// ⚠ WHY THIS TEST READS SOURCE. The derivation is build-time configuration and it THROWS on a bad
// value in production, so the failing case, the case worth asserting, cannot simply be imported and
// called under the test runner's own NODE_ENV. Both branches were verified by running real builds: an
// unparseable id fails the build with the error below (exit 1, confirmed), and a valid id builds and
// emits `connect-src 'self' https://cognito-idp.<region>.amazonaws.com` (confirmed against
// `next start`). This file is what stops the guard being removed later.
//
// ⚠ THE LOGIC MOVED TO `src/lib/csp.ts`, AND THE BUILD GATE IS WHAT MADE THAT DELICATE. The policy had
// to become per-request to carry a nonce, so it left `next.config.ts`, but the throw only fails a
// BUILD if something evaluates it at config load. `next.config.ts` therefore calls
// `cognitoConnectSrc()` for that sole purpose, and the last assertion here is what stops that
// seemingly-pointless call being deleted as dead code.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CSP = readFileSync(join(__dirname, "csp.ts"), "utf8");
const CONFIG = readFileSync(join(__dirname, "..", "..", "next.config.ts"), "utf8");

/**
 * The region test as it appears in the config, so this asserts the REAL pattern rather than a copy
 * of it, a copied regex would keep passing after somebody narrowed the original.
 *
 * Rebuilt with `new RegExp` from the captured body rather than `eval`'d: same result for a pattern
 * literal, without introducing an eval into the test suite.
 */
function regionPattern(): RegExp {
  const declared = /const COGNITO_REGION_RE = \/(.+)\/([gimsuy]*);/.exec(CSP);
  if (!declared) throw new Error("COGNITO_REGION_RE not found in lib/csp.ts");
  return new RegExp(declared[1], declared[2]);
}

describe("the Cognito region test", () => {
  it("accepts four-segment regions, the GovCloud case that used to ship the wildcard", () => {
    for (const region of ["us-gov-west-1", "us-gov-east-1"]) {
      expect(regionPattern().test(region), region).toBe(true);
    }
  });

  it("still accepts ordinary three-segment regions", () => {
    for (const region of ["us-east-1", "eu-west-2", "ap-southeast-3", "eu-central-1"]) {
      expect(regionPattern().test(region), region).toBe(true);
    }
  });

  it("refuses anything that is not a region", () => {
    // Including the shapes a misconfiguration actually produces: an empty value, a whole pool id
    // (someone splitting on the wrong character), and a bare word.
    for (const value of ["", "not-a-pool-id", "us-east-1_AbC123", "US-EAST-1", "us-east", "-us-east-1", "us-east-"]) {
      expect(regionPattern().test(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe("lib/csp.ts, the fallback must stay closed in production", () => {
  it("throws rather than emitting the wildcard when the pool id is unusable", () => {
    expect(CSP).toContain("throw new Error(");
    expect(CSP).toMatch(/Refusing to build a production CSP/);
  });

  it("reaches the wildcard only behind IS_DEV", () => {
    // ⚠ THE ASSERTION THAT MATTERS. The wildcard string appears in prose too (the file explains at
    // length why it is unsafe), so this checks the one RETURN of it sits in an `IS_DEV` branch and
    // that no other return produces it.
    const returned = [...CSP.matchAll(/return "(https:\/\/\*[^"]*)"/g)].map((m) => m[1]);
    expect(returned).toEqual(["https://*.amazonaws.com https://*.amazoncognito.com"]);

    const index = CSP.indexOf('return "https://*');
    const guard = CSP.slice(0, index).lastIndexOf("IS_DEV");
    const otherBranch = CSP.slice(0, index).lastIndexOf("if (COGNITO_REGION_RE");
    expect(guard).toBeGreaterThan(otherBranch);
  });

  it("derives the exact IDP host when the region parses", () => {
    expect(CSP).toContain("https://cognito-idp.${COGNITO_REGION}.amazonaws.com");
  });

  it("⚠ IS STILL EVALUATED AT CONFIG LOAD, SO THE GUARD REMAINS A *BUILD* FAILURE", () => {
    // Without this call the throw would first happen on a REQUEST, which is a weaker guarantee than
    // the one this whole file exists to protect. The call looks like dead code and is not.
    expect(CONFIG).toMatch(/^cognitoConnectSrc\(\);$/m);
    expect(CONFIG).toMatch(/import \{ cognitoConnectSrc \} from "\.\/src\/lib\/csp"/);
  });
});

/**
 * ⚠ THE DEPLOY-GUARD ASSERTIONS THAT WERE HERE HAVE MOVED, THEY ARE NOT GONE.
 *
 * This file used to carry `describe("amplify.yml, the deploy guard the config relies on")`,
 * reading `portal/amplify.yml` and asserting its env-capture loop demanded
 * NEXT_PUBLIC_COGNITO_USER_POOL_ID and friends. That mattered because the wildcard fallback
 * documented above was justified on "the deploy asserts the variable".
 *
 * Amplify Hosting is no longer the deploy path (`platform-portal.yaml` replaced it with
 * CodeBuild + Lambda behind CloudFront) and `amplify.yml` was deleted. Keeping the
 * old tests would have been worse than deleting them: they would have gone on passing against a
 * file that governed nothing, while the real guard rotted unobserved.
 *
 * The guard is now PortalBuildProject's `.env.production` loop in `platform-portal.yaml`, and
 * the equivalent assertions, including the inverse one, that NEXTAUTH_SECRET must NOT be baked
 * into the artifact, live beside it in the infrastructure repo:
 *
 *     infra/aws/app/test-portal-env-guard.sh
 *
 * They are there rather than here only because this repo cannot read across a repo boundary.
 * Verified against three mutations (drop an asserted key, re-add NEXTAUTH_SECRET to
 * the write loop, delete the absent-check): each one fails the script.
 *
 * ⚠ IF YOU NARROW `COGNITO_REGION_RE` OR THE FALLBACK ABOVE, CHECK THAT SCRIPT TOO.
 */
