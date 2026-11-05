// ── DOES OUR VALIDATOR ACCEPT WHAT AWS ACTUALLY SERVES? ────────────────────────
//
// Every other test in platform-config.test.ts mocks `fetch`, so all of them would keep
// passing if the real discovery-document shape and this validator disagreed — the exact
// class of bug a fake cannot catch (a field renamed on one side, a value the regex
// rejects). This file makes the real call.
//
// ⚠ RETARGETED FROM THE PORTAL TO COGNITO. It used to probe the portal's
// `/api/desktop/config`; that route and `fetchPlatformConfig` were both deleted when
// config stopped being served over an unauthenticated endpoint. Because the file is
// `skipIf`-gated it never ran, so nothing failed — it just quietly stopped testing
// anything while still looking like coverage. The live probe is still worth having; the
// contract it guards is now with AWS's OIDC discovery document.
//
// SKIPPED BY DEFAULT, and skipped rather than failed, so it cannot break `pnpm test` for
// someone offline or without credentials. Run it deliberately:
//
//   PRAIMANA_LIVE_POOL=us-east-1_EXAMPLE01 \
//   PRAIMANA_LIVE_CLIENT=clientaaaaaaaaaaaaaaaaaaaa \
//     pnpm --filter @praimana/desktop test platform-config.live
//
// Worth running after ANY change to `validateDiscovery` or `assertAwsDiscoveryHost` —
// those are a contract with AWS that no compiler enforces.

import { describe, it, expect, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, "utf-8"),
    decryptString: (b: Buffer) => b.toString("utf-8"),
  },
}));
vi.mock("better-sqlite3", () => ({ default: class {} }));
vi.mock("./database", () => ({
  readSetting: () => null,
  writeSetting: () => {},
  getDb: () => ({ transaction: (fn: () => void) => () => fn() }),
}));

import { resolvePlatform } from "./platform-config";

const POOL = process.env.PRAIMANA_LIVE_POOL;
const CLIENT = process.env.PRAIMANA_LIVE_CLIENT;

const params = () => ({
  poolId: POOL!,
  clientId: CLIENT!,
  apiBaseUrl: "https://portal.example.com/api",
});

describe.skipIf(!POOL || !CLIENT)("resolvePlatform against LIVE Cognito discovery", () => {
  it("accepts the real OIDC discovery document", async () => {
    const config = await resolvePlatform(params());

    // The values sign-in cannot proceed without. If AWS ever renames one, `validateDiscovery`
    // throws and this is where it surfaces rather than in a participant's app.
    expect(config.cognito.issuer).toMatch(/^https:\/\/cognito-idp\./);
    expect(config.cognito.issuer, "the issuer must name the pool we asked for").toContain(POOL!);
    expect(config.cognito.clientId).toBe(CLIENT);
    expect(config.region).toBe(POOL!.split("_")[0]);
    expect(config.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable — the same input yields the same fingerprint", async () => {
    // The fingerprint decides whether the desktop signs the user OUT because the platform
    // changed. A value that varied per call would log everyone out on every launch.
    const [a, b] = [await resolvePlatform(params()), await resolvePlatform(params())];
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  /**
   * ⚠ THE LIVE POOL MUST PASS OUR OWN HOST CONTROL. `assertAwsDiscoveryHost` anchors both ends of
   * the hostname to stop a look-alike domain being used as an identity provider. If it were wrong
   * in this direction, every attack case would still be rejected correctly while nobody could
   * actually sign in — which unit tests against a mock cannot reveal.
   */
  it("rejects a pool id that does not exist, rather than hanging", async () => {
    await expect(
      resolvePlatform({ ...params(), poolId: "us-east-1_NoSuchPool" })
    ).rejects.toThrow();
  });
});
