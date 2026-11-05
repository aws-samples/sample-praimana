// ── ⚠ THE DESKTOP WRITE TIER: VALIDATED, AUDITED, AND 400 ON A MALFORMED BODY ─────────────────
//
// A code review found all three `/api/desktop/*` write routes sharing one shape:
//
//   const { teamId, content, type } = await req.json();
//   if (!teamId || typeof teamId !== "string") return 400;
//   … forward everything else verbatim …
//
// Three defects in that shape, all now closed and all pinned here:
//
//   1. NO INPUT VALIDATION. The same backend sinks are bounded and enumerated on the tRPC side, and
//      `chat-limits.ts` records that the tRPC schema is the ONLY length bound in the system, so
//      this door was a hole in the only copy, not a redundant second copy.
//   2. NO AUDIT EVENT. Where the record is absent the portal retains no answer to "who joined this
//      team by code", the row that gates all team content.
//
//      ⚠ AND THE ACTOR ON IT USED TO BE A CLAIM. When this file was written `withBearer` admitted
//      on header PRESENCE, so the recorded subject came from an unverified `decodeJwt` and every
//      event had to carry `actorVerified: false` to say so. `withBearer` now VERIFIES the Cognito ID
//      token (signature, `iss`, `aud`, `exp`, `token_use`) before the handler runs, AWS Security
//      Agent f-e2ad7173, so the assertions below require the opposite: a verified actor, and no
//      residual use of the unverified helper.
//   3. `await req.json()` OUTSIDE THE `try`, so malformed JSON threw before the handler's own error
//      mapping and surfaced as a 500. A syntactically invalid body is a client error.
//
// Source-scanned rather than driven: these are Next route modules whose handlers need a live
// backend. What is asserted is therefore the SHAPE, that each guard is present in each route -
// which is exactly what regressed. `team-write-schemas.test.ts` asserts the schemas themselves
// refuse the bad input, so between the two files both halves are covered.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AUDIT_EVENTS } from "./audit-logger";

const DESKTOP_API = join(__dirname, "..", "app", "api", "desktop");

/** The write routes and the schema + event each is expected to use. */
const WRITE_ROUTES = [
  { route: "send-message", schema: "sendMessageSchema", event: "desktop.message.sent" },
  { route: "create-task", schema: "createTaskSchema", event: "desktop.task.created" },
  { route: "join-team", schema: "joinTeamSchema", event: "desktop.team.joined" },
] as const;

const source = (route: string) => readFileSync(join(DESKTOP_API, route, "route.ts"), "utf8");

/**
 * The `auditLog({ … })` call itself, with the surrounding prose excluded.
 *
 * Comments in these routes necessarily quote the fields they used to emit, so any assertion made
 * against the whole file tests the documentation rather than the behaviour.
 */
function auditBlock(src: string): string {
  const start = src.indexOf("auditLog({");
  expect(start, "each write route should emit exactly one audit event").toBeGreaterThan(-1);
  const end = src.indexOf("});", start);
  expect(end, "the auditLog call should be terminated").toBeGreaterThan(start);
  return src.slice(start, end + 3);
}

describe("/api/desktop write routes", () => {
  it("covers every mutating route under /api/desktop", () => {
    // ⚠ THE GUARD AGAINST THIS FILE GOING STALE. A new POST route added under this prefix inherits
    // no validation and no audit event, and would otherwise be tested by nothing. If this fails,
    // add the route to WRITE_ROUTES (and give it the same three guards) rather than to an ignore
    // list.
    const mutating = readdirSync(DESKTOP_API, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .filter((e) => {
        try {
          return /export const (POST|PUT|PATCH|DELETE)/.test(source(e.name));
        } catch {
          return false;
        }
      })
      .map((e) => e.name)
      .sort();

    expect(mutating).toEqual([...WRITE_ROUTES].map((r) => r.route).sort());
  });

  it.each(WRITE_ROUTES)("$route parses its body against $schema", ({ route, schema }) => {
    const src = source(route);
    expect(src).toContain(`${schema}.safeParse`);
    expect(src).toContain(`from "@/lib/team-write-schemas"`);
    // The bare destructure is what the finding described. It must not come back.
    expect(src).not.toMatch(/const\s*\{[^}]*\}\s*=\s*await req\.json\(\)/);
  });

  it.each(WRITE_ROUTES)("$route answers 400 rather than 500 on malformed JSON", ({ route }) => {
    // `.catch(() => null)` is what turns a JSON parse failure into a schema failure, which the
    // handler already answers as 400. Without it the throw escapes the handler entirely.
    expect(source(route)).toContain("await req.json().catch(() => null)");
    expect(source(route)).toContain("{ status: 400 }");
  });

  it.each(WRITE_ROUTES)("$route emits $event with a VERIFIED actor", ({ route, event }) => {
    const src = source(route);
    expect(src).toContain("auditLog(");
    expect(src).toContain(`event: "${event}"`);

    /**
     * ⚠ ASSERTED AGAINST THE `auditLog` CALL, NOT THE WHOLE FILE, and the first draft of this
     * change proved why. Every one of these routes DISCUSSES the old unverified actor in a comment
     * explaining what it replaced, so a file-wide `toContain("actorVerified: false")` kept passing
     * against a route that emits `true`. Same trap `csrf-exemption.test.ts` calls out for
     * `withBearer`: match the construct, never the mention.
     */
    const block = auditBlock(src);
    expect(block).toContain("actorVerified: true");
    expect(block).not.toContain("actorVerified: false");

    // The identity comes from the wrapper's third argument, which only exists because the token
    // was verified. `token` is still forwarded upstream, it just no longer names the actor.
    expect(block).toContain("identity.id");
    expect(block).not.toContain("unverifiedBearerActor");

    // And the handler must actually receive it, rather than shadowing it with a local.
    expect(src).toMatch(/withBearer\(async \(req, token, identity\)/);
  });

  it("⚠ RETIRES THE UNVERIFIED-ACTOR HELPER RATHER THAN LEAVING IT AVAILABLE", () => {
    // A helper that turns an unsigned bearer into an actor id is a footgun once the door verifies:
    // the next route to be written would reach for it and reintroduce the finding. It is gone from
    // `apiAuth.ts`, so this asserts the module exports nothing of the sort.
    const apiAuth = readFileSync(join(__dirname, "apiAuth.ts"), "utf8");
    expect(apiAuth).not.toMatch(/export function unverifiedBearerActor/);
    // The verification itself, at the door, for every route this wrapper guards.
    expect(apiAuth).toMatch(/const identity = await verifyCognitoIdToken\(token\)/);
  });

  it("declares all three events in the catalogue", () => {
    for (const { event } of WRITE_ROUTES) expect(AUDIT_EVENTS).toContain(event);
  });

  it("does not log the invite code, which is a live credential until it is spent", () => {
    const src = source("join-team");
    // The team it granted is the fact worth keeping; the code itself is reusable until redeemed and
    // `audit-logger.ts` refuses credential material by policy.
    const auditBlock = src.slice(src.indexOf("auditLog("), src.indexOf("return NextResponse.json({"));
    expect(auditBlock).not.toContain("inviteCode");
  });
});
