// ── ⚠ `script-src` MUST NOT CARRY `'unsafe-inline'` ───────────────────────────────────────────
//
// The production policy used to be `script-src 'self' 'unsafe-inline'`, the stricter branch of a
// ternary gated only on IS_DEV, whose only production difference was dropping `'unsafe-eval'`.
// `'unsafe-inline'` permits exactly the injection `script-src` exists to prevent, so the directive was
// decorative. It was raised as a security finding (which also named it as a permissive default),
// and the project's own backlog had it recorded as an open gap.
//
// It was not a live XSS: a sweep for injection sinks found none (no `dangerouslySetInnerHTML`,
// `innerHTML`, `document.write`, `srcdoc`, `eval`, `new Function`; `react-markdown` used without
// `rehype-raw`). It was an inoperative defence-in-depth layer in front of a real credential, the
// Cognito ID token that is this app's outbound `/v1/*` bearer. Both halves are now closed: the nonce
// here, and the token store in `lib/amplify.ts`.
//
// The end-to-end behaviour (nonce on every script tag, unique per response) was verified against a
// production build and `next start`. What this file pins is the policy STRING, which is the part a
// future edit can quietly weaken.

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildContentSecurityPolicy, CSP_HEADER, NONCE_HEADER } from "./csp";

const NONCE = "dGVzdC1ub25jZS0xMjM0";

/** One directive out of the policy, by name. */
function directive(policy: string, name: string): string {
  const found = policy.split("; ").find((d) => d.startsWith(`${name} `) || d === name);
  expect(found, `${name} should be present in the policy`).toBeDefined();
  return found as string;
}

describe("the production script-src", () => {
  const policy = buildContentSecurityPolicy(NONCE);

  it("⚠ CARRIES NO 'unsafe-inline', the finding itself", () => {
    expect(directive(policy, "script-src")).not.toContain("'unsafe-inline'");
  });

  it("carries the nonce it was given, and 'strict-dynamic'", () => {
    const scriptSrc = directive(policy, "script-src");
    expect(scriptSrc).toContain(`'nonce-${NONCE}'`);
    /**
     * `'strict-dynamic'` is not decoration: Next injects `<script>` elements from JavaScript as
     * chunks load, and a script created by a trusted script carries no nonce attribute. Without this
     * the nonce alone would block chunk loading and the app would not boot, which is the failure a
     * future "tidy-up" of this directive would cause.
     */
    expect(scriptSrc).toContain("'strict-dynamic'");
  });

  it("carries no 'unsafe-eval' outside development", () => {
    // NODE_ENV is not "production" under vitest, so this asserts the dev branch is the ONLY thing
    // that can add it, the string must be conditional, never unconditional.
    const src = readFileSync(join(__dirname, "csp.ts"), "utf8");
    expect(src).toMatch(/IS_DEV \? "'unsafe-eval'" : ""/);
  });

  it("keeps the directives that were already restrictive", () => {
    expect(directive(policy, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(policy, "object-src")).toBe("object-src 'none'");
    expect(directive(policy, "base-uri")).toBe("base-uri 'none'");
    expect(directive(policy, "form-action")).toBe("form-action 'self'");
    expect(directive(policy, "default-src")).toBe("default-src 'self'");
  });

  it("⚠ ADMITS NO BARE `https:` IN img-src, an open exfiltration channel", () => {
    expect(directive(policy, "img-src")).toBe("img-src 'self' data:");
  });

  it("pins connect-src to the exact Cognito IDP host, never a wildcard", () => {
    // The dev fallback is a wildcard by design (a local build with no Cognito must still run), so
    // this asserts the shape: whatever it resolves to, it is derived rather than hardcoded wide, and
    // a production build with an unparseable pool id THROWS rather than widening. That throw is
    // exercised by `next build`, and is invoked from `next.config.ts` so it fails the build.
    const nextConfig = readFileSync(join(__dirname, "..", "..", "next.config.ts"), "utf8");
    expect(nextConfig).toMatch(/^cognitoConnectSrc\(\);$/m);
  });

  it("omits the nonce placeholder entirely when no nonce is supplied", () => {
    // A response that is not a document gets no nonce, and must not get an empty `'nonce-'`, which
    // is a syntax error the browser would treat as an unparseable source expression.
    expect(buildContentSecurityPolicy()).not.toContain("nonce-");
  });
});

describe("⚠ the CSP is emitted from exactly one place", () => {
  it("is not also set in next.config.ts", () => {
    /**
     * Two `Content-Security-Policy` headers are INTERSECTED by the browser, not overridden. A
     * nonce-less copy in `next.config.ts` (whose `headers()` cannot produce a nonce) would therefore
     * combine with the middleware's policy to allow NEITHER inline scripts nor the nonce, a blank
     * page. So the config keeps the static headers and nothing else.
     */
    const nextConfig = readFileSync(join(__dirname, "..", "..", "next.config.ts"), "utf8");
    expect(nextConfig).not.toMatch(/key:\s*"Content-Security-Policy"/);
    // The static headers it must still set.
    expect(nextConfig).toMatch(/key:\s*"Strict-Transport-Security"/);
    expect(nextConfig).toMatch(/key:\s*"Referrer-Policy"/);
  });

  it("is set on every return path in the middleware", () => {
    /**
     * A policy applied only to the "allowed" path would leave the anonymous→/login redirect and the
     * CSRF 403 without one, the responses an attacker is most likely to be looking at. Asserted by
     * requiring that no raw `NextResponse` construction escapes the helper.
     */
    const middleware = readFileSync(join(__dirname, "..", "middleware.ts"), "utf8");
    const body = middleware.slice(middleware.indexOf("export default auth("));
    const raw = [...body.matchAll(/return (NextResponse\.(next|redirect)\(|new NextResponse\()/g)];
    expect(
      raw.map((m) => m[0]),
      "every response should go through withSecurityHeaders / next() / redirect()"
    ).toEqual([]);
    // `withSecurityHeaders` is declared above the handler, so this looks at the whole module.
    expect(middleware).toMatch(/res\.headers\.set\(CSP_HEADER/);
  });

  it("forwards the nonce to the layout on a request header", () => {
    const middleware = readFileSync(join(__dirname, "..", "middleware.ts"), "utf8");
    expect(middleware).toMatch(/requestHeaders\.set\(NONCE_HEADER, nonce\)/);
    const layout = readFileSync(join(__dirname, "..", "app", "layout.tsx"), "utf8");
    expect(layout).toContain("NONCE_HEADER");
    expect(CSP_HEADER).toBe("Content-Security-Policy");
    expect(NONCE_HEADER).toBe("x-csp-nonce");
  });
});

describe("⚠ the injection sinks the CSP is a backstop for stay absent", () => {
  it("finds no HTML/script injection sink in src/ or shared/", () => {
    // The sweep that kept this finding at Low severity, kept as a test so the severity assumption is
    // re-checked rather than remembered. If this fails, the CSP is no longer the only thing standing
    // between an injected string and script execution.
    const roots = [join(__dirname, ".."), join(__dirname, "..", "..", "shared")];
    const sinks = /dangerouslySetInnerHTML|\.innerHTML\s*=|document\.write\(|srcdoc=|[^.\w]eval\(|new Function\(/;
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules") continue;
          walk(path);
        } else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) {
          const src = readFileSync(path, "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\/\/[^\n]*/g, "");
          if (sinks.test(src)) offenders.push(path);
        }
      }
    };
    for (const root of roots) walk(root);

    expect(offenders).toEqual([]);
  });
});

// ── ⚠ THE DIRECTIVE THAT BROKE THE RESOURCES FEATURE ON A DEPLOYED BUILD ──────────────────────
//
// `connect-src 'self' https://cognito-idp.<region>.amazonaws.com` is correct for every other screen and
// is exactly what blocked workshop-resource uploads: the browser must PUT multipart parts straight to
// S3 (100MB fits through neither API Gateway's 10MB nor Lambda's 6MB), and the policy forbade reaching
// that origin at all. The browser refused before a packet left, surfacing as a bare
// `TypeError: Failed to fetch` that named neither CSP nor S3, the whole feature, invisible, on a build
// where every other signal said shipped.
//
// What these pin: the bucket host is EXACT, it is absent when unconfigured, and a malformed value can
// never reach the header, an env var concatenated into a CSP is a directive-injection primitive.
describe("⚠ connect-src and the workshop-resources bucket", () => {
  // ⚠ SYNTHETIC POOL ID, KEEP IT THAT WAY, this file is published. Satisfies POOL_ID_PATTERN
  // (`desktop/shared/constants/cognito-pool.ts`): /^[a-z]{2}(-[a-z]+)+-\d+_[A-Za-z0-9]+$/. The
  // assertions only need the region prefix, which they parse out of this value; the suffix is
  // never matched on, so a real pool id buys nothing and is a free identifier for an attacker.
  const POOL = "us-east-1_EXAMPLE01";
  // ⚠ SYNTHETIC ACCOUNT ID, KEEP IT THAT WAY. 123456789012 is the AWS documentation placeholder.
  const BUCKET = "praimana-workshop-resources-123456789012";

  async function policyWith(env: Record<string, string | undefined>) {
    vi.resetModules();
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) vi.stubEnv(k, "");
      else vi.stubEnv(k, v);
    }
    const mod = await import("./csp");
    return mod.buildContentSecurityPolicy(NONCE);
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("permits the EXACT bucket host when one is configured", async () => {
    const p = await policyWith({
      NEXT_PUBLIC_COGNITO_USER_POOL_ID: POOL,
      NEXT_PUBLIC_RESOURCES_BUCKET: BUCKET,
    });
    expect(directive(p, "connect-src")).toContain(`https://${BUCKET}.s3.us-east-1.amazonaws.com`);
  });

  /**
   * ⚠ THE REGIONAL VIRTUAL-HOSTED FORM IS THE ONE THE SDK PRESIGNS. Verified against a live presigned
   * URL from the deployed service. Permitting only the legacy global form would fail identically and
   * just as invisibly.
   */
  it("uses the regional host, not the legacy global one", async () => {
    const p = await policyWith({
      NEXT_PUBLIC_COGNITO_USER_POOL_ID: POOL,
      NEXT_PUBLIC_RESOURCES_BUCKET: BUCKET,
    });
    const c = directive(p, "connect-src");
    expect(c).toContain(".s3.us-east-1.amazonaws.com");
    expect(c, "the bare global form is not what gets presigned").not.toContain(
      `https://${BUCKET}.s3.amazonaws.com`
    );
  });

  /** A deployment with no bucket answers 501 on every resource route, so there is nothing to permit. */
  it("adds nothing when no bucket is configured", async () => {
    const p = await policyWith({
      NEXT_PUBLIC_COGNITO_USER_POOL_ID: POOL,
      NEXT_PUBLIC_RESOURCES_BUCKET: undefined,
    });
    const c = directive(p, "connect-src");
    expect(c).not.toContain("s3.");
    expect(c).toBe(`connect-src 'self' https://cognito-idp.us-east-1.amazonaws.com`);
  });

  /**
   * ⚠ NEVER A WILDCARD, and this module records the cost: a host wildcard matches subdomains at ANY
   * depth, so `https://*.s3.us-east-1.amazonaws.com` admits every bucket in the region and anyone can
   * create one.
   */
  it("never widens connect-src to a wildcard", async () => {
    const p = await policyWith({
      NEXT_PUBLIC_COGNITO_USER_POOL_ID: POOL,
      NEXT_PUBLIC_RESOURCES_BUCKET: BUCKET,
    });
    expect(directive(p, "connect-src")).not.toContain("*");
  });

  /**
   * ⚠ CSP INJECTION. An unvalidated env var concatenated into the policy can append a directive -
   * `'unsafe-inline'` here would undo the entire nonce mechanism this module exists for. The value is
   * validated against S3's own naming rules, which admit no space, semicolon or quote.
   */
  it("refuses a value that would inject another directive", async () => {
    const p = await policyWith({
      NEXT_PUBLIC_COGNITO_USER_POOL_ID: POOL,
      NEXT_PUBLIC_RESOURCES_BUCKET: "bad; script-src 'unsafe-inline'",
    });
    // ⚠ NOT a whole-policy search for "unsafe-inline": `style-src` carries it deliberately (an
    // injected stylesheet cannot execute JavaScript, see the directive's own note). Asserting on the
    // whole string would fail on a documented, intended value and say nothing about the injection.
    expect(directive(p, "script-src")).not.toContain("unsafe-inline");
    expect(directive(p, "connect-src")).not.toContain("bad");
    expect(directive(p, "connect-src")).toBe(
      "connect-src 'self' https://cognito-idp.us-east-1.amazonaws.com"
    );
    // The injected text must not have become a directive of its own anywhere in the policy.
    expect(p.split("; ").filter((d) => d.startsWith("script-src"))).toHaveLength(1);
  });

  it("refuses other malformed values rather than emitting them", async () => {
    for (const bad of ["UPPERCASE", "has space", "a", "x".repeat(70), "semi;colon"]) {
      const p = await policyWith({
        NEXT_PUBLIC_COGNITO_USER_POOL_ID: POOL,
        NEXT_PUBLIC_RESOURCES_BUCKET: bad,
      });
      expect(directive(p, "connect-src"), bad).not.toContain("s3.");
    }
  });
});
