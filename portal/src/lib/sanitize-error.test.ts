import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Tests for the error message sanitization module.
 *
 * These verify that sensitive infrastructure details (AWS ARNs, account IDs,
 * internal hostnames, filesystem paths, etc.) are stripped from error messages
 * in production, while being preserved in development for debuggability.
 */

describe("sanitize-error", () => {
  /**
   * ⚠ WRITTEN THROUGH A WIDENED ALIAS, because `process.env.NODE_ENV` is typed READONLY under
   * this repo's tsconfig and a direct assignment is a compile error (TS2540), which `pnpm test`
   * would not have told us, since vitest transpiles without type-checking. The module reads the
   * value at import time, so every case has to re-import after setting it.
   */
  const env = process.env as Record<string, string | undefined>;
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    env.NODE_ENV = originalEnv;
    vi.resetModules();
  });

  async function loadModule(nodeEnv: string) {
    env.NODE_ENV = nodeEnv;
    vi.resetModules();
    return import("@/lib/sanitize-error");
  }

  /** A coded refusal, the only shape that may pass through. See the module header. */
  const CODE = "SCORES_NOT_VISIBLE";

  describe("containsSensitiveContent", () => {
    it("detects AWS ARNs", async () => {
      const { containsSensitiveContent } = await loadModule("production");
      expect(
        containsSensitiveContent(
          "User: arn:aws:iam::123456789012:role/MyRole is not authorized"
        )
      ).toBe(true);
    });

    it("detects AWS account IDs (12-digit numbers)", async () => {
      const { containsSensitiveContent } = await loadModule("production");
      expect(
        containsSensitiveContent("Account 123456789012 does not have access")
      ).toBe(true);
    });

    it("detects IAM role references", async () => {
      const { containsSensitiveContent } = await loadModule("production");
      expect(
        containsSensitiveContent("role/AWSServiceRoleForSSO is not authorized")
      ).toBe(true);
    });

    it("detects internal hostnames", async () => {
      const { containsSensitiveContent } = await loadModule("production");
      expect(
        containsSensitiveContent(
          "Connection refused to ip-10-0-1-42.ec2.internal"
        )
      ).toBe(true);
      expect(
        containsSensitiveContent(
          "Failed to connect to my-service.us-east-1.amazonaws.com"
        )
      ).toBe(true);
    });

    it("detects private IP addresses", async () => {
      const { containsSensitiveContent } = await loadModule("production");
      expect(
        containsSensitiveContent("Connection refused to 10.0.1.42:3000")
      ).toBe(true);
      expect(
        containsSensitiveContent("Timeout connecting to 192.168.1.100")
      ).toBe(true);
    });

    it("detects filesystem paths", async () => {
      const { containsSensitiveContent } = await loadModule("production");
      expect(
        containsSensitiveContent(
          "Error at /var/task/node_modules/@aws-sdk/client-iam/dist/index.js:42"
        )
      ).toBe(true);
    });

    it("detects webpack internal paths", async () => {
      const { containsSensitiveContent } = await loadModule("production");
      expect(
        containsSensitiveContent(
          "at backendFetch (webpack-internal:///(rsc)/./src/lib/backend.ts:42:10)"
        )
      ).toBe(true);
    });

    it("detects stack traces", async () => {
      const { containsSensitiveContent } = await loadModule("production");
      expect(
        containsSensitiveContent(
          "Error: something failed\n    at Module.handler (/app/index.js:15:7)"
        )
      ).toBe(true);
    });

    it("detects AWS access key IDs", async () => {
      const { containsSensitiveContent } = await loadModule("production");
      // Built from segments so no 20-character AKIA-shaped literal exists in source; this is
      // AWS's own documented example key id (never a real credential), joined at runtime.
      const exampleKeyId = "AKIA" + "IOSFODNN7" + "EXAMPLE";
      expect(
        containsSensitiveContent(
          `The security token included in the request is expired for ${exampleKeyId}`
        )
      ).toBe(true);
    });

    it("does NOT flag safe user-facing messages", async () => {
      const { containsSensitiveContent } = await loadModule("production");
      expect(containsSensitiveContent("Team name already taken")).toBe(false);
      expect(containsSensitiveContent("You do not have access to this workshop")).toBe(false);
      expect(containsSensitiveContent("Invalid email address")).toBe(false);
      expect(containsSensitiveContent("Rate limit exceeded")).toBe(false);
    });
  });

  describe("sanitizeErrorMessage (production), ⚠ DEFAULT-DENY", () => {
    /**
     * ⚠ THE POLICY THESE TESTS PIN WAS INVERTED FROM THE ONE ORIGINALLY WRITTEN HERE. It used to
     * be "pass through unless a regex objects", a denylist over text some other service happened
     * to produce, which misses the pattern nobody thought of. It is now "replace unless the
     * service attached a `code`". The first two tests are the whole rule.
     */
    it("REPLACES an uncoded message even when it looks harmless", async () => {
      const { sanitizeErrorMessage } = await loadModule("production");
      // Nothing sensitive in it, and it is still replaced: no code means nobody wrote it for a
      // reader, so there is nothing to preserve and no way to be sure of what is in the next one.
      expect(sanitizeErrorMessage("Forbidden", 403)).toBe(
        "You do not have permission to perform this action."
      );
      expect(sanitizeErrorMessage("Workshop not found", 404)).toBe(
        "The requested resource was not found."
      );
    });

    it("PASSES a coded message through, that is what the code is for", async () => {
      const { sanitizeErrorMessage } = await loadModule("production");
      // Every coded refusal in this platform is hand-authored and the wording is the point.
      const authored =
        "You can't invite yourself. Ask another administrator to invite you if you need a role in an experience.";
      expect(sanitizeErrorMessage(authored, 403, "SELF_INVITATION_REFUSED")).toBe(authored);
      expect(
        sanitizeErrorMessage(
          "Your experiences can't be loaded right now. This is a temporary problem, not a change to your access.",
          503,
          "ENTITLEMENTS_UNAVAILABLE"
        )
      ).toMatch(/temporary problem/);
    });

    it("⚠ REPLACES A CODED MESSAGE THAT CARRIES INFRASTRUCTURE DETAIL ANYWAY", async () => {
      const { sanitizeErrorMessage } = await loadModule("production");
      // The second pass. "A human wrote it" is not "a human wrote it carefully", a service that
      // interpolates an SDK error into its own coded message would otherwise walk straight through.
      const leaky =
        "Could not read the table: User: arn:aws:iam::123456789012:role/PortalServiceRole is not authorized";
      const result = sanitizeErrorMessage(leaky, 403, "WORKSHOP_UNAVAILABLE");
      expect(result).toBe("You do not have permission to perform this action.");
      expect(result).not.toContain("arn:");
      expect(result).not.toContain("123456789012");
    });

    it("replaces an empty message with the generic one for the status", async () => {
      const { sanitizeErrorMessage } = await loadModule("production");
      expect(sanitizeErrorMessage("", 500, CODE)).toBe(
        "An internal error occurred. Please try again later."
      );
    });

    it("replaces a message too long to have been written for a person", async () => {
      const { sanitizeErrorMessage } = await loadModule("production");
      // Coded and free of every sensitive pattern, and still replaced: 301 characters of prose is
      // an error page or a serialised object, whatever code it arrived with.
      expect(sanitizeErrorMessage("A".repeat(301), 500, CODE)).toBe(
        "An internal error occurred. Please try again later."
      );
      expect(sanitizeErrorMessage("A".repeat(300), 500, CODE)).toBe("A".repeat(300));
    });

    it("uses status-appropriate generic messages", async () => {
      const { sanitizeErrorMessage } = await loadModule("production");
      const sensitive = "arn:aws:iam::123456789012:role/Foo is not authorized";
      const cases: Array<[number, string]> = [
        [401, "Authentication required."],
        [403, "You do not have permission to perform this action."],
        [404, "The requested resource was not found."],
        [429, "Too many requests. Please wait and try again."],
        [500, "An internal error occurred. Please try again later."],
        [504, "The request timed out. Please try again later."],
      ];
      for (const [status, expected] of cases) {
        expect(sanitizeErrorMessage(sensitive, status, CODE), String(status)).toBe(expected);
      }
    });

    it("genericMessage() agrees with the sanitiser, so callers cannot word it differently", async () => {
      // `apiAuth.errorResponse` uses `genericMessage` directly for errors raised INSIDE a handler
      // (a TypeError, an SDK failure), never passing that text through at all. Same wording.
      const { genericMessage, sanitizeErrorMessage } = await loadModule("production");
      for (const status of [400, 401, 403, 404, 409, 429, 500, 502, 503, 504]) {
        expect(genericMessage(status), String(status)).toBe(
          sanitizeErrorMessage("uncoded", status)
        );
      }
    });
  });

  describe("sanitizeErrorMessage (development)", () => {
    it("preserves sensitive messages for debuggability", async () => {
      const { sanitizeErrorMessage } = await loadModule("development");
      const sensitiveMsg =
        "User: arn:aws:iam::123456789012:role/PortalServiceRole is not authorized";
      expect(sanitizeErrorMessage(sensitiveMsg, 403)).toBe(sensitiveMsg);
    });

    it("preserves long messages", async () => {
      const { sanitizeErrorMessage } = await loadModule("development");
      const longMessage = "A".repeat(301);
      expect(sanitizeErrorMessage(longMessage, 500)).toBe(longMessage);
    });

    it("preserves an UNCODED message too, the code only matters in production", async () => {
      // The dev branch returns before any policy runs. Stated because the production rule turns
      // entirely on the code, and a reader could reasonably expect it to apply here as well.
      const { sanitizeErrorMessage } = await loadModule("development");
      expect(sanitizeErrorMessage("Forbidden", 403)).toBe("Forbidden");
    });
  });
});
