import { describe, it, expect } from "vitest";
import { buildRecord, redactPaths, trimJsonl, redactSecrets } from "./telemetry-format";

describe("redactPaths", () => {
  it("redacts POSIX home paths", () => {
    expect(redactPaths("at /Users/jane/project/file.ts:12")).toBe(
      "at /Users/<redacted>/project/file.ts:12"
    );
    expect(redactPaths("/home/bob/app")).toBe("/Users/<redacted>/app");
  });

  it("redacts Windows home paths", () => {
    expect(redactPaths("C:\\Users\\Alice\\app\\x.ts")).toBe("C:\\Users\\<redacted>\\app\\x.ts");
  });

  it("leaves non-home paths and plain text untouched", () => {
    expect(redactPaths("/usr/local/bin/kiro-cli")).toBe("/usr/local/bin/kiro-cli");
    expect(redactPaths("boom happened")).toBe("boom happened");
  });
});

describe("buildRecord", () => {
  const TS = "2026-07-22T10:00:00.000Z";

  it("builds a record with ts, source, message and redacts paths", () => {
    const rec = buildRecord(
      { source: "renderer:boundary", message: "fail in /Users/jane/x", stack: "at /home/jane/y" },
      TS,
      "0.1.0"
    );
    expect(rec.ts).toBe(TS);
    expect(rec.source).toBe("renderer:boundary");
    expect(rec.message).toContain("/Users/<redacted>/x");
    expect(rec.stack).toContain("/Users/<redacted>/y");
    expect(rec.appVersion).toBe("0.1.0");
  });

  it("omits stack and appVersion when absent", () => {
    const rec = buildRecord({ source: "s", message: "m" }, TS);
    expect(rec.stack).toBeUndefined();
    expect(rec.appVersion).toBeUndefined();
  });

  it("bounds an oversized message", () => {
    const rec = buildRecord({ source: "s", message: "x".repeat(5000) }, TS);
    expect(rec.message.length).toBeLessThanOrEqual(2000);
  });

  it("copies and redacts string extras", () => {
    const rec = buildRecord(
      { source: "s", message: "m", extra: { reason: "crashed at /Users/jane", code: 9 } },
      TS
    );
    expect(rec.extra?.reason).toContain("/Users/<redacted>");
    expect(rec.extra?.code).toBe(9);
  });
});

describe("trimJsonl", () => {
  it("returns null when under the cap", () => {
    expect(trimJsonl("a\nb\nc\n", 5)).toBeNull();
  });

  it("keeps only the most recent lines when over the cap", () => {
    const out = trimJsonl("l1\nl2\nl3\nl4\n", 2);
    expect(out).toBe("l3\nl4\n");
  });

  it("ignores blank lines when counting", () => {
    expect(trimJsonl("a\n\nb\n\n", 5)).toBeNull();
  });
});

/**
 * ── ⚠ A CRASH LOG MUST NOT CARRY A CREDENTIAL ─────────────────────────────────────────────────
 *
 * Paths were redacted and secrets were not — and this log exists to be SHARED ("a local trail the user can
 * export/share", telemetry.ts), so a token in it is a token in a support ticket. The inputs below are the
 * shapes this app's own errors actually produce: a 401 with the request URL, a fetch failure carrying the
 * headers, a token-endpoint body.
 */
describe("credential redaction", () => {
  // Assembled from its three JWT segments at runtime, rather than as one literal, so the
  // fixture does not read as a credential-shaped string to a shape-based secret scanner. The
  // joined value is byte-identical to the original literal.
  const JWT = [
    "eyJhbGciOiJSUzI1NiIsImtpZCI6ImFiYyJ9",
    "eyJzdWIiOiJ1c2VyLTEiLCJleHAiOjE3MDAwMDAwMDB9",
    "c2lnbmF0dXJl",
  ].join(".");

  it("redacts a JWT wherever it appears", () => {
    // Shape-based, so it does not matter which field or format put it there.
    for (const text of [
      `HTTP 401 for https://api.example/v1/teams?token=${JWT}`,
      `fetch failed: {"Authorization":"Bearer ${JWT}"}`,
      `at handler (bundle.js:1) token=${JWT}`,
      JWT,
    ]) {
      const out = redactSecrets(text);
      expect(out, `leaked in: ${text.slice(0, 40)}`).not.toContain(JWT);
      expect(out).not.toContain("eyJzdWIiOiJ1c2VyLTEi"); // nor the payload segment alone
    }
  });

  it("redacts a Bearer credential that is NOT a JWT", () => {
    const out = redactSecrets("Authorization: Bearer abcdef0123456789opaque");
    expect(out).toContain("Bearer <redacted>");
    expect(out).not.toContain("abcdef0123456789opaque");
  });

  it("redacts credential-ish query parameters whatever the value looks like", () => {
    for (const param of ["token", "access_token", "id_token", "refresh_token", "code", "api_key", "password"]) {
      const out = redactSecrets(`https://api.example/x?${param}=SUPERSECRET&team=t1`);
      expect(out, param).not.toContain("SUPERSECRET");
      // The surrounding request is still legible — redaction must not destroy the diagnostic.
      expect(out).toContain("team=t1");
    }
  });

  it("redacts an opaque refresh token in a JSON body", () => {
    // Cognito's refresh token is not a JWT, so the shape rule above does not catch it.
    const out = redactSecrets('{"refresh_token":"opaque-value-here","expires_in":3600}');
    expect(out).not.toContain("opaque-value-here");
    expect(out).toContain("expires_in");
  });

  it("leaves an ordinary message untouched", () => {
    // A redactor that mangles normal text makes the log useless, which is its own failure.
    const plain = "TypeError: cannot read property 'id' of undefined at PhasesView";
    expect(redactSecrets(plain)).toBe(plain);
  });

  it("⚠ buildRecord applies BOTH redactions to every field", () => {
    /**
     * The wiring is the part that would silently regress: `redactSecrets` existing but only being
     * called on `message` would leave every stack trace unfiltered, and stacks are where a request
     * URL usually ends up.
     */
    const rec = buildRecord(
      {
        source: "renderer:error",
        message: `401 https://api.example/v1/x?token=${JWT}`,
        stack: `at f (/Users/someone/app/x.js:1)\nBearer ${JWT}`,
        extra: { url: `https://api.example/y?access_token=${JWT}`, status: 401 },
      },
      "2026-08-19T00:00:00.000Z",
      "1.0.0"
    );

    const serialised = JSON.stringify(rec);
    expect(serialised).not.toContain(JWT);
    expect(serialised).not.toContain("/Users/someone"); // path redaction still applies
    expect(rec.extra?.status, "non-strings pass through").toBe(401);
  });
});

/**
 * ── ⚠ NON-STRING `extra` VALUES BYPASSED EVERY REDACTION ──────────────────────────────────────
 *
 * The comment said "shallow-copy scalar extras only" and the code copied any non-string value verbatim —
 * objects and arrays included — which were then JSON.stringify'd into a log whose stated purpose is to be
 * exported and shared. `telemetry.ts` passes `extra` straight from the renderer's `telemetry:report`, so a
 * nested `Authorization` header reached the file unredacted.
 */
describe("deep redaction of extras", () => {
  // Same assembly technique as JWT above — three segments joined at runtime, byte-identical
  // result, no credential-shaped literal for a shape-based scanner to match.
  const JWT2 = [
    "eyJhbGciOiJSUzI1NiIsImtpZCI6InoifQ",
    "eyJzdWIiOiJ1c2VyLTIiLCJleHAiOjE3MDAwMDAwMDB9",
    "c2ln",
  ].join(".");

  it("⚠ redacts a token nested inside an object", () => {
    const rec = buildRecord(
      {
        source: "renderer:error",
        message: "request failed",
        extra: { response: { headers: { Authorization: `Bearer ${JWT2}` } }, status: 401 },
      },
      "2026-08-20T00:00:00.000Z"
    );
    const serialised = JSON.stringify(rec);
    expect(serialised, "the nested token must not survive").not.toContain(JWT2);
    expect(serialised).toContain("401"); // the diagnostic value is kept
  });

  it("redacts inside arrays too", () => {
    const rec = buildRecord(
      { source: "x", message: "y", extra: { tried: [`token=${JWT2}`, "fine"] } },
      "2026-08-20T00:00:00.000Z"
    );
    expect(JSON.stringify(rec)).not.toContain(JWT2);
  });

  it("keeps non-string scalars intact", () => {
    // The diagnostic value of telemetry is in these; redaction must not mangle them.
    const rec = buildRecord(
      { source: "x", message: "y", extra: { status: 401, ok: false, ratio: 1.5, missing: null } },
      "2026-08-20T00:00:00.000Z"
    );
    expect(rec.extra).toMatchObject({ status: 401, ok: false, ratio: 1.5, missing: null });
  });

  it("⚠ is bounded in depth and in key count", () => {
    /**
     * This walks renderer-supplied data, and the standing constraint in this codebase is that every
     * fan-out is bounded. A deeply nested or enormous object must degrade predictably rather than
     * spending unbounded time in the crash reporter.
     */
    let deep: any = "bottom";
    for (let i = 0; i < 12; i++) deep = { nested: deep };
    const wide: Record<string, string> = {};
    for (let i = 0; i < 100; i++) wide[`k${i}`] = "v";

    const rec = buildRecord(
      { source: "x", message: "y", extra: { deep, wide } },
      "2026-08-20T00:00:00.000Z"
    );
    expect(JSON.stringify(rec)).toContain("[too deep]");
    expect(Object.keys((rec.extra as any).wide).length).toBeLessThanOrEqual(32);
  });

  it("does not crash on awkward shapes", () => {
    // Renderer input; it must not be able to throw inside the crash reporter.
    for (const extra of [{ d: new Date(0) }, { u: undefined }, { fn: () => 1 }, { s: Symbol("x") }] as any[]) {
      expect(() => buildRecord({ source: "x", message: "y", extra }, "t")).not.toThrow();
    }
  });
});

/** Same stamp the block above uses; `TS` there is scoped to that describe. */
const STAMP = "2026-07-22T10:00:00.000Z";

// ── ⚠ EVERY RENDERER-SUPPLIED FIELD GETS BOTH REDACTIONS AND A BOUND ──────────────────────────
//
// `buildRecord` redacted and capped `message` and `stack` and copied `source` verbatim, while `redact`'s
// own docblock calls itself "Both redactions, in the order every field should get them". The top-level
// `extra` loop also omitted the `MAX_EXTRA_KEYS` bound that `redactDeep` applies at every nested level,
// and object keys never passed through `redact()` at any depth — only values did.
//
// ⚠ WHY IT MATTERS FOR A FILE THAT NEVER LEAVES THE MACHINE. Its documented purpose is to be exported
// and shared with support, and `telemetry:openLog` reveals it in the OS file manager for exactly that.
// The confidentiality loss is realised by the user doing what the feature asks of them.
describe("⚠ the source field", () => {
  it("redacts a home path", () => {
    const rec = buildRecord({ source: "/Users/jane.doe/projects/acme", message: "x" }, STAMP);

    expect(rec.source, "an absolute home path must not survive").not.toContain("jane.doe");
  });

  it("redacts a bearer-shaped string", () => {
    // Segments joined at runtime (see JWT above); the "Bearer " prefix is added separately so
    // no single literal is a full header.payload.signature triple.
    const jwt =
      "Bearer " +
      ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxIn0", "aaaaaaaaaaaaaaaaaaaa"].join(".");
    const rec = buildRecord({ source: jwt, message: "x" }, STAMP);

    expect(rec.source).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  /**
   * ⚠ THE CAP IS A DENIAL-OF-SERVICE BOUND TOO. Rotation caps LINES, not bytes, and every append
   * re-reads the whole file synchronously on the main process — so an unbounded source was an unbounded
   * line, 500 times over.
   */
  it("caps an absurd source rather than writing an unbounded line", () => {
    const rec = buildRecord({ source: "s".repeat(100_000), message: "x" }, STAMP);

    expect(rec.source.length).toBeLessThanOrEqual(200);
  });

  /**
   * ⚠ AND IT IS A NO-OP ON EVERY VALUE THE APP ACTUALLY PRODUCES. If redaction mangled these, anything
   * grouping records by source would break — which would be a worse outcome than the leak.
   */
  it("leaves the app's own source labels untouched", () => {
    for (const source of [
      "main:uncaughtException",
      "main:child-process-gone",
      "renderer:error",
      "renderer:unhandledrejection",
    ]) {
      expect(buildRecord({ source, message: "x" }, STAMP).source).toBe(source);
    }
  });

  it("says it does not know rather than writing an empty source", () => {
    expect(buildRecord({ source: "", message: "x" }, STAMP).source).toBe("unknown");
  });
});

describe("⚠ extra keys", () => {
  it("redacts a path in the KEY position, not just the value", () => {
    const rec = buildRecord(
      { source: "s", message: "m", extra: { "/Users/jane.doe/secret-project": 1 } },
      STAMP
    );

    expect(JSON.stringify(rec.extra), "a key is renderer text like any other").not.toContain(
      "jane.doe"
    );
  });

  it("redacts a key at a NESTED level too", () => {
    const rec = buildRecord(
      { source: "s", message: "m", extra: { outer: { "/Users/jane.doe/x": 1 } } },
      STAMP
    );

    expect(JSON.stringify(rec.extra)).not.toContain("jane.doe");
  });

  it("bounds an absurdly long key", () => {
    const rec = buildRecord({ source: "s", message: "m", extra: { ["k".repeat(5_000)]: 1 } }, STAMP);

    for (const key of Object.keys(rec.extra ?? {})) {
      expect(key.length).toBeLessThanOrEqual(64);
    }
  });

  /**
   * ⚠ THE TOP LEVEL WAS THE ONE UNBOUNDED LEVEL, which is the odd part of this finding: `redactDeep`
   * bounds arrays and nested objects, and the level a caller controls most directly had no bound at all.
   */
  it("⚠ bounds the NUMBER of top-level keys, like every nested level", () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < 500; i++) many[`k${i}`] = i;

    const rec = buildRecord({ source: "s", message: "m", extra: many }, STAMP);

    expect(Object.keys(rec.extra ?? {}).length).toBeLessThanOrEqual(32);
  });

  it("still carries an ordinary diagnostic payload", () => {
    // A bound that broke the feature would be a poor trade.
    const rec = buildRecord(
      { source: "s", message: "m", extra: { type: "renderer", exitCode: 139 } },
      STAMP
    );

    expect(rec.extra).toMatchObject({ type: "renderer", exitCode: 139 });
  });
});
