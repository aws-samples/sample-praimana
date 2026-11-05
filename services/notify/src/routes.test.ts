import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { createNotifyRoutes } from "./routes.js";
import { safeUrl, escapeHtml } from "./render.js";
import {
  renderRegistrationInvite,
  renderTeamInvite,
  renderWorkshopUpdate,
} from "./templates.js";
import type { EmailMessage, EmailResult, EmailTransport } from "./domain.js";
import { buildSendEmailInput, parseReplyTo } from "./transport.js";

/**
 * Route-level tests for the Notify service. The transport is injected, so nothing
 * here sends mail — the fake records what WOULD have been sent, which is exactly
 * what the assertions need.
 *
 * Authentication uses the trusted-internal-hop path (x-internal-token +
 * x-identity-*), the same edgeIdentityMiddleware the deployed service runs, so no
 * Cognito JWKS fetch is needed.
 */
const INTERNAL_TOKEN = "test-internal-token";

beforeAll(() => {
  process.env.INTERNAL_SERVICE_TOKEN = INTERNAL_TOKEN;
});

function asUser(identity: { id: string; email?: string; role: string }) {
  return {
    "x-internal-token": INTERNAL_TOKEN,
    "x-identity-id": identity.id,
    "x-identity-role": identity.role,
    ...(identity.email ? { "x-identity-email": identity.email } : {}),
  };
}

/** Records sends instead of performing them. */
class FakeTransport implements EmailTransport {
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<EmailResult> {
    this.sent.push(message);
    return { messageId: "fake-id", via: "console" };
  }
}

let transport: FakeTransport;
let app: ReturnType<typeof createNotifyRoutes>;

/**
 * ⚠ THE LINK ALLOWLIST IS CONFIGURED FOR THE WHOLE FILE, because a CONFIGURED deployment is the
 * state every other test in here is about (recipient caps, role gates, escaping, log hygiene).
 *
 * Added with the fail-closed change: `rejectActionUrl` used to ALLOW when no origin was
 * configured, so these tests passed without ever naming an origin. They now name the two hosts their
 * own fixtures use, which makes the dependency explicit instead of resting on a fail-open default.
 *
 * The allowlist tests below override or delete this in their own hooks — that is the point of setting
 * it here rather than inside `createNotifyRoutes`: `allowedLinkOrigins()` is read per request.
 */
const TEST_LINK_ORIGINS =
  "https://x.example.com,https://platform.example,https://portal.example.com";

beforeEach(() => {
  process.env.NOTIFY_ALLOWED_LINK_ORIGINS = TEST_LINK_ORIGINS;
  transport = new FakeTransport();
  app = createNotifyRoutes({ email: transport });
});

afterEach(() => {
  delete process.env.NOTIFY_ALLOWED_LINK_ORIGINS;
  delete process.env.NOTIFY_ALLOW_UNRESTRICTED_LINKS;
});

async function post(
  path: string,
  headers: Record<string, string>,
  body: unknown
): Promise<Response> {
  return app.request(`/v1/notify${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** An ADMIN caller, the role that actually sends invitations. */
const ADMIN_HEADERS = asUser({ id: "admin-1", role: "ADMIN" });

const VALID_INVITE = {
  to: "someone@example.com",
  teamName: "Team Rocket",
  inviteUrl: "https://portal.example.com/join/abc123",
};

// ─── The role gate ──────────────────────────────────────────────────────────

/**
 * Every notify route is reachable by ANY authenticated caller as far as
 * edgeIdentityMiddleware is concerned — it establishes identity, not permission.
 * Without a role gate a signed-in PARTICIPANT could send arbitrary recipients a
 * branded email from the platform's verified domain: a phishing relay carrying our
 * SPF/DKIM, and a fast way to destroy the SES reputation every other email depends
 * on. These tests pin the gate shut.
 */
describe("who may make notify send email", () => {
  it("refuses a PARTICIPANT and sends NOTHING", async () => {
    const res = await post("/team-invite", asUser({ id: "u1", role: "PARTICIPANT" }), VALID_INVITE);

    expect(res.status).toBe(403);
    // The important half: not merely a 403, but no mail generated.
    expect(transport.sent).toEqual([]);
  });

  it("allows the staff roles that may invite", async () => {
    /**
     * ⚠ THIS LOOP USED TO INCLUDE "JUDGE", AND THAT IS THE DEFECT THIS TEST NOW PINS SHUT.
     * The set is documented as mirroring ROLE_GRANTS — "a role that can grant no role can send no
     * invitation" — and `ROLE_GRANTS.JUDGE` is `[]`. So the test asserted the opposite of the rule the
     * code claimed to implement, which is why nothing caught it. EXECUTIVE stays: it may grant
     * PARTICIPANT.
     */
    for (const role of ["ADMIN", "FACILITATOR", "EXECUTIVE"]) {
      const fresh = new FakeTransport();
      const freshApp = createNotifyRoutes({ email: fresh });
      const res = await freshApp.request("/v1/notify/team-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...asUser({ id: "u1", role }) },
        body: JSON.stringify(VALID_INVITE),
      });

      expect(res.status, role).toBe(200);
      expect(fresh.sent.length, role).toBe(1);
    }
  });

  it("⚠ REFUSES A JUDGE and sends NOTHING — a role that can grant nothing may send nothing", async () => {
    /**
     * The inversion of the line removed from the loop above, asserted on its OWN so it cannot be
     * quietly re-widened by editing an array literal.
     *
     * A JUDGE is invitation-only, holds no team membership row and may grant no role. Before this,
     * one judge token could send any recipient a branded, SPF/DKIM-signed "your account is ready"
     * email with an invented `temporaryPassword` and an `actionUrl` of the judge's choosing — a
     * credential-harvesting mail carrying this platform's sender reputation. Nothing was injected;
     * the templates escape correctly, which is exactly what made it convincing.
     */
    for (const path of ["/team-invite", "/registration-invite", "/password-reset"]) {
      const fresh = new FakeTransport();
      const freshApp = createNotifyRoutes({ email: fresh });
      const res = await freshApp.request(`/v1/notify${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...asUser({ id: "judge-1", role: "JUDGE" }),
        },
        body: JSON.stringify({ ...VALID_INVITE, temporaryPassword: "Hunter2-Temp!" }),
      });

      expect(res.status, path).toBe(403);
      // The important half: not merely a 403, but no mail generated on any of the three.
      expect(fresh.sent, path).toEqual([]);
    }
  });

  it("⚠ REFUSES an over-sized recipient list and sends NOTHING", async () => {
    /**
     * `recipients()` accepts an array of any length and there was no cap anywhere, so one call could
     * name arbitrarily many addresses. Asserted as all-or-nothing: the refusal must land BEFORE the
     * transport, because a partial send cannot be taken back and the caller would be told "sent".
     */
    const fresh = new FakeTransport();
    const freshApp = createNotifyRoutes({ email: fresh });
    const res = await freshApp.request("/v1/notify/team-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...asUser({ id: "a1", role: "ADMIN" }) },
      body: JSON.stringify({
        ...VALID_INVITE,
        to: Array.from({ length: 51 }, (_, i) => `p${i}@example.com`),
      }),
    });

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("TOO_MANY_RECIPIENTS");
    expect(fresh.sent).toEqual([]);
  });

  it("still sends at exactly the cap — the bound is 50, not 49", async () => {
    // An off-by-one here would silently narrow a legitimate broadcast, so the boundary is pinned.
    const fresh = new FakeTransport();
    const freshApp = createNotifyRoutes({ email: fresh });
    const res = await freshApp.request("/v1/notify/team-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...asUser({ id: "a1", role: "ADMIN" }) },
      body: JSON.stringify({
        ...VALID_INVITE,
        to: Array.from({ length: 50 }, (_, i) => `p${i}@example.com`),
      }),
    });

    expect(res.status).toBe(200);
    expect(fresh.sent.length).toBe(1);
  });

  it("⚠ keeps recipient ADDRESSES out of the logs, and the temporary password too", async () => {
    /**
     * The audit line logged `to.join(", ")`, writing every recipient address into CloudWatch on every
     * send. Counts and domains are what an operator triages on; the addresses are personal data that
     * did not need to be there. `temporaryPassword` is a LIVE CREDENTIAL and must never appear.
     */
    const logged: unknown[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logged.push(args);
    });

    const fresh = new FakeTransport();
    const freshApp = createNotifyRoutes({ email: fresh });
    await freshApp.request("/v1/notify/registration-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...asUser({ id: "a1", role: "ADMIN" }) },
      body: JSON.stringify({
        to: "secret.person@customer.example",
        actionUrl: "https://platform.example/join",
        temporaryPassword: "Hunter2-Temp!",
      }),
    });

    const dump = JSON.stringify(logged);
    expect(dump).not.toContain("secret.person@customer.example");
    expect(dump).not.toContain("secret.person");
    expect(dump).not.toContain("Hunter2-Temp!");
    // The signal an operator needs IS still there.
    expect(dump).toContain("customer.example");
    spy.mockRestore();
  });

  it("fails closed on an absent or unrecognised role", async () => {
    for (const role of ["", "SOMETHING_NEW", "participant", "admin"]) {
      const res = await post("/team-invite", asUser({ id: "u1", role }), VALID_INVITE);
      // Case matters: roles are compared exactly, so "admin" is NOT ADMIN.
      expect([401, 403], `role=${role}`).toContain(res.status);
      expect(transport.sent, `role=${role}`).toEqual([]);
    }
  });

  it("rejects an unauthenticated caller outright", async () => {
    const res = await post("/team-invite", {}, VALID_INVITE);
    expect(res.status).toBe(401);
    expect(transport.sent).toEqual([]);
  });

  it("gates EVERY email type, not just team-invite", async () => {
    // A gate applied per-handler rots as routes are added; this asserts the
    // middleware covers the whole surface.
    const routes: Array<[string, unknown]> = [
      ["/registration-invite", { to: "a@example.com", actionUrl: "https://x.example.com/j" }],
      ["/team-invite", VALID_INVITE],
      ["/password-reset", { to: "a@example.com", actionUrl: "https://x.example.com/r" }],
      ["/release-update", { to: "a@example.com", headline: "H", intro: "I" }],
      ["/workshop-update", { to: "a@example.com", headline: "H", body: "B" }],
    ];

    for (const [path, body] of routes) {
      const res = await post(path, asUser({ id: "u1", role: "PARTICIPANT" }), body);
      expect(res.status, path).toBe(403);
    }
    expect(transport.sent).toEqual([]);
  });

  it("refuses BEFORE parsing the body, so a malformed payload still 403s", async () => {
    // Ordering matters: authorization must not depend on the request being
    // well-formed, or a bad body would surface a 400/500 that leaks whether the
    // route exists and does work on an unauthorized caller's behalf.
    const res = await app.request("/v1/notify/team-invite", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...asUser({ id: "u1", role: "PARTICIPANT" }),
      },
      body: "{ not json",
    });

    expect(res.status).toBe(403);
    expect(transport.sent).toEqual([]);
  });
});

// ─── URL safety in link slots ───────────────────────────────────────────────

/**
 * actionUrl is caller-supplied and lands in an `href`. HTML-escaping does NOT
 * make that safe: the payload sits in an attribute VALUE the mail client parses
 * as a URL, so `javascript:` and `data:` survive escaping intact. safeUrl is the
 * separate check that decides whether a value is a URL we will link at all.
 */
describe("safeUrl", () => {
  it("passes ordinary https/mailto URLs through unchanged", () => {
    for (const url of [
      "https://portal.example.com/join/abc123",
      "mailto:someone@example.com",
      "https://example.com/p?a=1&b=2#frag",
    ]) {
      expect(safeUrl(url), url).toBe(url);
    }
  });

  it("⚠ NO LONGER PASSES http: — a link in an email must not be a downgrade", () => {
    /**
     * ⚠ THIS CASE MOVED FROM THE TEST ABOVE, WHERE IT ASSERTED THE OPPOSITE.
     * `"http://localhost:3001/join/x"` was in the pass-through list, so `http:` was linkable.
     *
     * Every link this service sends goes to the platform's own web app or is a `mailto:`, and
     * `bulk-provision` already refuses to send when `APP_URL` is unset, local, or an `api.*` host — so
     * a plaintext link was never a configuration anyone deploys deliberately. What `http:` did buy was
     * the ability to send a panel of judges to a downgraded URL, which is a downgrade this platform
     * should not perform on a recipient's behalf.
     *
     * Empty string, not a throw: the template renders a dead button rather than an executable href,
     * which is `safeUrl`'s existing contract for everything it refuses.
     */
    for (const url of [
      "http://localhost:3001/join/x",
      "http://portal.example.com/join/abc123",
      "HTTP://portal.example.com/join/abc123",
    ]) {
      expect(safeUrl(url), url).toBe("");
    }
  });

  it("refuses javascript: and data: however they are dressed up", () => {
    for (const url of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "  javascript:alert(1)  ",
      "\tjavascript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
    ]) {
      expect(safeUrl(url), url).toBe("");
    }
  });

  it("refuses relative URLs, which an email has no base to resolve", () => {
    for (const url of ["/join/abc", "join/abc", "//evil.example.com/x", ""]) {
      expect(safeUrl(url), url).toBe("");
    }
  });

  it("refuses non-strings", () => {
    for (const v of [null, undefined, 42, {}, ["https://x.example.com"]]) {
      expect(safeUrl(v)).toBe("");
    }
  });
});

describe("templates refuse to emit an unsafe link", () => {
  it("drops a javascript: actionUrl from both the HTML and the text body", () => {
    const { html, text } = renderTeamInvite({
      teamName: "Team Rocket",
      actionUrl: "javascript:alert(document.domain)",
    });

    expect(html).not.toContain("javascript:");
    expect(text).not.toContain("javascript:");
  });

  it("keeps a legitimate link in both bodies, identically", () => {
    const url = "https://portal.example.com/join/abc123";
    const { html, text } = renderTeamInvite({ teamName: "T", actionUrl: url });

    expect(html).toContain(url);
    expect(text).toContain(url);
  });

  it("omits the button entirely when an optional actionUrl is unsafe", () => {
    // release/workshop templates wrap the button in {{#actionUrl}}, so "" collapses
    // the section — no dead button rather than one pointing nowhere.
    const { html } = renderWorkshopUpdate({
      headline: "H",
      body: "B",
      actionUrl: "javascript:alert(1)",
      actionLabel: "Open workshop",
    });

    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("Open workshop");
  });
});

// ─── HTML escaping of caller-supplied copy ──────────────────────────────────

describe("caller-supplied fields cannot inject markup", () => {
  it("escapes a script tag in teamName", () => {
    const { html } = renderTeamInvite({
      teamName: "<script>alert(1)</script>",
      actionUrl: "https://x.example.com/j",
    });

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes an attribute-breaking quote in inviterName", () => {
    const { html } = renderTeamInvite({
      teamName: "T",
      actionUrl: "https://x.example.com/j",
      inviterName: '" onmouseover="alert(1)',
    });

    expect(html).not.toContain('onmouseover="alert(1)"');
    expect(html).toContain("&quot;");
  });

  it("escapes the five characters that matter and nothing else", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
    expect(escapeHtml("plain text 123")).toBe("plain text 123");
  });

  it("escapes ampersands FIRST so escaping is not double-applied", () => {
    // A naive order turns "&" into "&amp;" after "<" became "&lt;", yielding
    // "&amp;lt;". Pinning this stops a refactor from reordering the replaces.
    expect(escapeHtml("&<")).toBe("&amp;&lt;");
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });
});

// ─── Email-client CSS support ───────────────────────────────────────────────

/**
 * Gmail and Outlook strip `background-image` (and gradients generally), so any
 * element that paints light text MUST get its colour from a solid
 * `background-color` — a gradient can only ever be decoration layered on top.
 *
 * This is a real reported bug, not a hypothetical: the brand monogram's fill lived
 * solely in a shorthand `background` gradient, the client dropped the whole
 * declaration, and the white "A" rendered on white. The mark was invisible in the
 * invitation email while looking perfect in a browser preview — which is exactly
 * why a test pins it rather than a code comment.
 *
 * The monogram itself is GONE now (it was a placeholder standing in for the real
 * product logo, and an emailed logo would be blocked as a remote image in most
 * clients — the layout carries a typographic wordmark instead). The invariant it
 * was protecting is not gone, so these tests now watch the elements that still
 * paint light text: the call-to-action buttons.
 */
describe("the branded layout survives a client that drops gradients", () => {
  // Strip every gradient declaration to simulate the client, then assert the
  // element still has a colour behind its white text.
  function withoutGradients(html: string): string {
    return html.replace(/background-image:[^;"]*;?/g, "");
  }

  it("gives every element with white text a solid colour, not only a gradient", () => {
    const { html } = renderTeamInvite({
      teamName: "T",
      actionUrl: "https://x.example.com/j",
    });

    const survives = withoutGradients(html);

    // Split into table cells: each piece begins with one <td>'s attributes and runs
    // to the next cell, so a cell's own fill and the text inside it land in the
    // SAME piece. That is what makes this checkable — the white text is on an
    // <a>, but the colour behind it is on the enclosing <td>.
    const cells = survives.split(/<td\b/);
    const whiteTextCells = cells.filter((cell) => /color:\s*#ffffff/i.test(cell));

    // Asserted rather than assumed: if a refactor renames the button colour, this
    // test must fail loudly rather than quietly iterate over an empty list and pass.
    expect(
      whiteTextCells.length,
      "no cell with white text found — has the layout changed shape?"
    ).toBeGreaterThan(0);

    for (const cell of whiteTextCells) {
      const where = cell.trim().slice(0, 120);
      // Every cell painting white text needs a solid fill that survives the strip.
      expect(
        /background(-color)?:\s*#[0-9a-fA-F]{3,6}/.test(cell),
        `white text with no solid background behind it: ${where}`
      ).toBe(true);
      // bgcolor is the belt-and-braces attribute for the oldest Outlook renderers,
      // which ignore the style attribute on a td entirely.
      expect(
        cell.includes('bgcolor="#'),
        `white text with no bgcolor fallback: ${where}`
      ).toBe(true);
    }
  });

  it("never paints a background with a gradient alone", () => {
    const { html } = renderTeamInvite({
      teamName: "T",
      actionUrl: "https://x.example.com/j",
    });

    // A gradient in the `background` SHORTHAND is the exact defect: it carries the
    // colour, so stripping it leaves nothing. `background-image` is fine.
    expect(html).not.toMatch(/background:\s*linear-gradient/);
  });

  /**
   * The placeholder "A" tile must not come back, in any email. It was never the
   * product's logo — the portal and the desktop app render a different mark
   * entirely — so a reintroduced monogram is a branding regression, and a silent
   * one, because it looks deliberate.
   */
  it("renders the product wordmark and no placeholder monogram tile", () => {
    const { subject, html } = renderTeamInvite({
      teamName: "T",
      actionUrl: "https://x.example.com/j",
    });

    // A lone letter as an element's entire content is the monogram's signature.
    expect(html).not.toMatch(/>\s*A\s*<\/(td|div|span)>/);

    // The wordmark is now the only thing naming the product in the header, so it
    // has to be there. Taken from the subject rather than hardcoded: the product
    // name is env-overridable (EMAIL_PRODUCT_NAME), and a hardcoded default would
    // make this test fail for a deployment that renamed the product — which is not
    // the defect being guarded against.
    const productName = subject.replace(/^.* on /, "");
    expect(productName.length).toBeGreaterThan(0);
    expect(html).toContain(productName);
  });

  /**
   * No remote image anywhere in an email. Images are blocked by default in a large
   * share of clients, so a logo <img> would be an empty box for most recipients —
   * and if one is ever added it must be decorative, never the only thing carrying
   * information the wordmark does not already give.
   */
  it("embeds no remote images, so a client that blocks them loses nothing", () => {
    const { html } = renderTeamInvite({
      teamName: "T",
      actionUrl: "https://x.example.com/j",
    });

    expect(html).not.toMatch(/<img\b/i);
  });
});

// ─── The temporary password ─────────────────────────────────────────────────

/**
 * Registration is now ADMIN-PROVISIONED: the account is created before the invitation
 * email is sent, and this email is the ONLY delivery of its temporary password. That
 * makes the credential's handling in these templates load-bearing in a way none of the
 * other fields are:
 *
 *   - it must actually APPEAR (an email without it is a dead end — the recipient has a
 *     link and nothing to sign in with, and the password cannot be recovered);
 *   - it must appear VERBATIM after escaping, because the recipient copies it;
 *   - it must NOT appear in the PREHEADER, which mail clients render in inbox list
 *     previews and sync to lock screens;
 *   - it must be ABSENT ENTIRELY when not supplied, rather than rendering an empty box.
 */
describe("the temporary password in an invitation email", () => {
  const PASSWORD = "Tq7#mKp2$xNvR4wZ";

  for (const [name, render] of [
    [
      "registration-invite",
      (temporaryPassword?: string) =>
        renderRegistrationInvite({
          actionUrl: "https://x.example.com/join/abc",
          temporaryPassword,
        }),
    ],
    [
      "team-invite",
      (temporaryPassword?: string) =>
        renderTeamInvite({
          teamName: "Team Rocket",
          actionUrl: "https://x.example.com/join/abc",
          temporaryPassword,
        }),
    ],
  ] as const) {
    describe(name, () => {
      it("includes the password in BOTH the HTML and the plain-text body", () => {
        // Both, because a text-only client is a real client and the recipient of a
        // password-bearing email must not be the one who cannot read it.
        const { html, text } = render(PASSWORD);
        expect(html).toContain(PASSWORD);
        expect(text).toContain(PASSWORD);
      });

      it("does NOT put the password in the preheader shown in inbox previews", () => {
        const { html } = render(PASSWORD);
        // The preheader is the hidden span near the top of the layout. Assert the
        // password appears only AFTER it — i.e. in the body, not the preview line.
        const preheaderEnd = html.indexOf("</div>");
        const head = html.slice(0, Math.max(preheaderEnd, 0));
        expect(head).not.toContain(PASSWORD);
      });

      it("omits the credential block ENTIRELY when no password is supplied", () => {
        // An invitation to an account whose owner already chose a password carries
        // none. An empty box would read as a broken email, and copy promising a
        // password that is not there is worse than silence.
        const { html, text } = render(undefined);
        expect(html).not.toMatch(/Temporary password/i);
        expect(text).not.toMatch(/Temporary password/i);
      });

      it("ESCAPES the password rather than emitting it raw", () => {
        // The generated alphabet includes & and other characters that would corrupt
        // the string the recipient copies — or, with a hostile value, inject markup.
        const hostile = 'Ab3!&<script>"x';
        const { html } = render(hostile);
        expect(html).not.toContain("<script>");
        expect(html).toContain("&amp;&lt;script&gt;");
      });

      it("keeps the password on ONE line in the text body, so a copy is exact", () => {
        // A wrapped password is a mis-transcribed password, and a mis-transcribed
        // password reads to the user as "incorrect email or password".
        const { text } = render(PASSWORD);
        const line = text.split("\n").find((l) => l.includes(PASSWORD));
        expect(line).toBe(`Temporary password: ${PASSWORD}`);
      });
    });
  }

  it("tells the recipient they will have to replace it", () => {
    // The account is in FORCE_CHANGE_PASSWORD, so this WILL happen; saying so up front
    // stops it reading as an unexpected demand mid-sign-in.
    const { html, text } = renderRegistrationInvite({
      actionUrl: "https://x.example.com/join/abc",
      temporaryPassword: PASSWORD,
    });
    expect(html).toMatch(/replace/i);
    expect(text).toMatch(/replace/i);
  });

  it("no longer claims that no account is created until the link is clicked", () => {
    // It WAS true under self-signup and is now false — the account exists before this
    // email is sent. Telling a recipient otherwise misleads them about a live
    // credential they are holding.
    const { html } = renderRegistrationInvite({
      actionUrl: "https://x.example.com/join/abc",
      temporaryPassword: PASSWORD,
    });
    expect(html).not.toMatch(/no account is created/i);
  });
});

describe("POST /registration-invite carries the temporary password through", () => {
  it("passes a string temporaryPassword into the rendered email", async () => {
    const res = await post("/registration-invite", ADMIN_HEADERS, {
      to: "someone@example.com",
      actionUrl: "https://x.example.com/join/abc",
      temporaryPassword: "Tq7#mKp2$xNvR4wZ",
    });
    expect(res.status).toBe(200);
    expect(transport.sent[0].text).toContain("Tq7#mKp2$xNvR4wZ");
  });

  it("IGNORES a non-string temporaryPassword rather than rendering [object Object]", async () => {
    // The recipient must copy this field verbatim; "[object Object]" in it would be an
    // unfixable dead end, and a number would be a password they cannot use.
    const res = await post("/registration-invite", ADMIN_HEADERS, {
      to: "someone@example.com",
      actionUrl: "https://x.example.com/join/abc",
      temporaryPassword: { nope: true },
    });
    expect(res.status).toBe(200);
    expect(transport.sent[0].text).not.toContain("object Object");
    expect(transport.sent[0].text).not.toMatch(/Temporary password/i);
  });
});

// ─── Reply-To ───────────────────────────────────────────────────────────────

/**
 * The sender is `no-reply@` at the verified domain, so without ReplyToAddresses a
 * person answering an invitation is answering a mailbox nobody reads: SES accepts
 * the reply's delivery attempt at a nonexistent address and it is discarded with
 * no bounce to them and no signal to us. Reply-To is the fix, and it is TRANSPORT
 * CONFIG rather than a caller-supplied field on purpose — see buildSendEmailInput.
 */
describe("parseReplyTo", () => {
  it("returns an empty list when unset or blank, so the field is omitted", () => {
    expect(parseReplyTo(undefined)).toEqual([]);
    expect(parseReplyTo("")).toEqual([]);
    expect(parseReplyTo("   ")).toEqual([]);
  });

  it("accepts a single address", () => {
    expect(parseReplyTo("team@example.com")).toEqual(["team@example.com"]);
  });

  it("splits a comma-separated list and trims each entry", () => {
    expect(parseReplyTo("a@example.com, b@example.com")).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });

  it("drops empty entries so a trailing comma cannot become an empty address", () => {
    // SES rejects the ENTIRE send on one malformed address, so a stray comma in a
    // config string would take out every email the platform sends.
    expect(parseReplyTo("a@example.com,")).toEqual(["a@example.com"]);
    expect(parseReplyTo(",,a@example.com,,b@example.com,")).toEqual([
      "a@example.com",
      "b@example.com",
    ]);
  });
});

describe("buildSendEmailInput", () => {
  const message: EmailMessage = {
    to: ["someone@example.com"],
    subject: "Subject",
    html: "<p>hi</p>",
    text: "hi",
  };

  it("sets ReplyToAddresses when configured", () => {
    const input = buildSendEmailInput(message, {
      from: "no-reply@example.com",
      replyTo: ["team@example.com"],
    });
    expect(input.ReplyToAddresses).toEqual(["team@example.com"]);
  });

  it("OMITS ReplyToAddresses entirely when there is none", () => {
    // Not `[]` and not `""`: an empty list is a different request, and sending one
    // is the failure mode this pins shut.
    const input = buildSendEmailInput(message, { from: "no-reply@example.com" });
    expect("ReplyToAddresses" in input).toBe(false);
    expect(buildSendEmailInput(message, {
      from: "no-reply@example.com",
      replyTo: [],
    })).not.toHaveProperty("ReplyToAddresses");
  });

  it("omits the delegate identity ARN when absent, keeps it when present", () => {
    expect(
      buildSendEmailInput(message, { from: "no-reply@example.com" })
    ).not.toHaveProperty("FromEmailAddressIdentityArn");
    expect(
      buildSendEmailInput(message, {
        from: "no-reply@example.com",
        identityArn: "arn:aws:ses:us-east-1:111122223333:identity/example.com",
      }).FromEmailAddressIdentityArn
    ).toBe("arn:aws:ses:us-east-1:111122223333:identity/example.com");
  });

  it("carries the From, recipients and both bodies through unchanged", () => {
    const input = buildSendEmailInput(message, { from: "no-reply@example.com" });
    expect(input.FromEmailAddress).toBe("no-reply@example.com");
    expect(input.Destination.ToAddresses).toEqual(["someone@example.com"]);
    expect(input.Content.Simple.Body.Html.Data).toBe("<p>hi</p>");
    expect(input.Content.Simple.Body.Text.Data).toBe("hi");
  });
});

/**
 * ── ⚠ WHERE A LINK IN A PLATFORM EMAIL IS ALLOWED TO POINT ───────────────────────────────────
 *
 * `actionUrl` came straight from the request body into the template's link slot, and `safeUrl` only
 * asked "is this a URL shape we will link at all". So any caller past the role gate could aim the
 * platform's own branded, SPF/DKIM-signed "your account is ready, sign in here" button at a host they
 * controlled. That is the difference between spam and phishing, and it is the third compounding factor
 * in the JUDGE sender-role finding.
 *
 * Every real value is the platform's own app — `${APP_URL}/join/<token>` from bulk-provision,
 * `${PORTAL_URL}/admin?tab=feedback` from identity — so an origin allowlist costs nothing legitimate.
 */
describe("actionUrl is confined to the platform's own origins", () => {
  const ORIGIN = "https://portal.example.com";
  const send = (
    path: string,
    actionUrl: string,
    role = "ADMIN",
    fresh = new FakeTransport()
  ) => ({
    fresh,
    res: createNotifyRoutes({ email: fresh }).request(`/v1/notify${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...asUser({ id: "u1", role }) },
      body: JSON.stringify({
        to: "someone@example.com",
        teamName: "Team Rocket",
        actionUrl,
      }),
    }),
  });

  const LINK_ROUTES = ["/registration-invite", "/team-invite", "/password-reset"];

  beforeEach(() => {
    process.env.NOTIFY_ALLOWED_LINK_ORIGINS = ORIGIN;
  });
  afterEach(() => {
    delete process.env.NOTIFY_ALLOWED_LINK_ORIGINS;
  });

  for (const path of LINK_ROUTES) {
    it(`${path} ACCEPTS a link on an allowed origin`, async () => {
      // NOT VACUOUS: without this the refusals below would pass on a route that refuses everything.
      const { fresh, res } = send(path, `${ORIGIN}/join/abc123`);
      expect((await res).status, path).toBe(200);
      expect(fresh.sent.length, path).toBe(1);
    });

    it(`${path} REFUSES an attacker-controlled origin and sends NOTHING`, async () => {
      const { fresh, res } = send(path, "https://attacker.example/signin");
      const r = await res;
      expect(r.status, path).toBe(400);
      expect(((await r.json()) as { code: string }).code).toBe("ACTION_URL_NOT_ALLOWED");
      expect(fresh.sent, path).toEqual([]);
    });

    it(`${path} REFUSES http:, javascript: and a relative link`, async () => {
      for (const bad of [
        `http://portal.example.com/join/x`,
        "javascript:alert(document.cookie)",
        "/join/relative",
        "not a url",
      ]) {
        const { fresh, res } = send(path, bad);
        const r = await res;
        expect(r.status, `${path} ${bad}`).toBe(400);
        expect(fresh.sent, `${path} ${bad}`).toEqual([]);
      }
    });

    it(`${path} matches on ORIGIN, so a deeper path on the same host is fine`, async () => {
      // APP_URL legitimately may carry a path; links are built beneath it.
      const { res } = send(path, `${ORIGIN}/a/b/c?x=1#f`);
      expect((await res).status, path).toBe(200);
    });

    it(`${path} REFUSES a look-alike host that merely starts with the allowed origin`, async () => {
      // The check must be an origin comparison, not a prefix match: `portal.example.com.evil.test`
      // starts with the allowed host and is a different site.
      const { fresh, res } = send(path, "https://portal.example.com.evil.test/join/x");
      expect((await res).status, path).toBe(400);
      expect(fresh.sent, path).toEqual([]);
    });
  }

  /**
   * ⚠ THE ROLE MATRIX ON TOP OF THE LINK CHECK. The link rule is a validation and must sit BEHIND the
   * sender-role gate — a refused role must hear "your role cannot send email", not a critique of its
   * URL, because the latter confirms the endpoint exists and is reachable to someone who may not use
   * it. JUDGE is in this table for the reason the whole finding existed.
   */
  const ROLE_MATRIX: Array<[role: string, status: number]> = [
    ["ADMIN", 400],
    ["FACILITATOR", 400],
    ["EXECUTIVE", 400],
    ["JUDGE", 403],
    ["PARTICIPANT", 403],
  ];

  it.each(ROLE_MATRIX)(
    "a %s sending an attacker origin gets %s — the role gate is checked first",
    async (role, status) => {
      const { fresh, res } = send(
        "/registration-invite",
        "https://attacker.example/signin",
        role
      );
      const r = await res;
      expect(r.status, role).toBe(status);
      expect(fresh.sent, role).toEqual([]);
    }
  );

  it("⚠ FAILS CLOSED when no origins are configured, and says so in the log", async () => {
    /**
     * ⚠ THIS ASSERTION WAS INVERTED. It used to assert a 200 — a deliberate,
     * documented fail-OPEN, on the grounds that enforcing an empty allowlist strictly would refuse
     * every email (PASSWORD RESETS INCLUDED) the first time this deployed without the variable.
     *
     * That reasoning was right about the outage and wrong about the default: a control that allows
     * everything when unconfigured is indistinguishable from an absent control, and nobody had
     * confirmed the variable IS set on the deployed function. The outage risk is now answered by an
     * explicit `NOTIFY_ALLOW_UNRESTRICTED_LINKS` opt-out (asserted below) rather than by a weak
     * default, so recovery costs one environment variable instead of a code deploy.
     *
     * The log is asserted at `error` because it refuses real mail — an operator needs to find it.
     */
    delete process.env.NOTIFY_ALLOWED_LINK_ORIGINS;
    delete process.env.APP_URL;
    delete process.env.PORTAL_URL;
    delete process.env.NOTIFY_ALLOW_UNRESTRICTED_LINKS;

    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a) => {
      errors.push(a);
    });

    const { fresh, res } = send("/registration-invite", "https://anywhere.example/x");
    const r = await res;
    expect(r.status).toBe(400);
    expect(((await r.json()) as { code: string }).code).toBe("ACTION_URL_NOT_ALLOWED");
    expect(fresh.sent).toEqual([]);
    expect(JSON.stringify(errors)).toContain("no allowed-link origins configured");

    spy.mockRestore();
  });

  it("the NOTIFY_ALLOW_UNRESTRICTED_LINKS opt-out restores sending, and warns every time", async () => {
    /**
     * The escape hatch for the deployment that has no origin variable set. It exists so a refused
     * password reset is recoverable without a code change — and it warns on EVERY send rather than
     * once at startup, because an opt-out nobody is reminded of becomes the permanent configuration.
     *
     * ⚠ IT DOES NOT WEAKEN THE https FLOOR OR THE CONFIGURED CASE — the two tests either side of
     * this one hold those, and the hatch is only ever consulted when the allowlist is EMPTY.
     */
    delete process.env.NOTIFY_ALLOWED_LINK_ORIGINS;
    delete process.env.APP_URL;
    delete process.env.PORTAL_URL;
    process.env.NOTIFY_ALLOW_UNRESTRICTED_LINKS = "true";

    const warnings: unknown[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((...a) => {
      warnings.push(a);
    });

    const { fresh, res } = send("/registration-invite", "https://anywhere.example/x");
    expect((await res).status).toBe(200);
    expect(fresh.sent.length).toBe(1);
    expect(JSON.stringify(warnings)).toContain("NOTIFY_ALLOW_UNRESTRICTED_LINKS is set");

    spy.mockRestore();
    delete process.env.NOTIFY_ALLOW_UNRESTRICTED_LINKS;
  });

  it("the opt-out is exact: any value other than \"true\" still refuses", async () => {
    // A half-set variable ("1", "yes", "TRUE") must not silently open the platform up. Only the
    // documented value counts, so a typo fails CLOSED rather than open.
    delete process.env.NOTIFY_ALLOWED_LINK_ORIGINS;
    delete process.env.APP_URL;
    delete process.env.PORTAL_URL;

    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const value of ["1", "yes", "TRUE", "True", ""]) {
      process.env.NOTIFY_ALLOW_UNRESTRICTED_LINKS = value;
      const { fresh, res } = send("/registration-invite", "https://anywhere.example/x");
      expect((await res).status, value).toBe(400);
      expect(fresh.sent, value).toEqual([]);
    }
    spy.mockRestore();
    delete process.env.NOTIFY_ALLOW_UNRESTRICTED_LINKS;
  });

  it("still enforces https even with no origins configured", async () => {
    delete process.env.NOTIFY_ALLOWED_LINK_ORIGINS;
    delete process.env.APP_URL;
    delete process.env.PORTAL_URL;

    const { fresh, res } = send("/registration-invite", "http://anywhere.example/x");
    expect((await res).status).toBe(400);
    expect(fresh.sent).toEqual([]);
  });

  it("reads APP_URL and PORTAL_URL too, so an existing deployment needs no new variable", async () => {
    delete process.env.NOTIFY_ALLOWED_LINK_ORIGINS;
    process.env.APP_URL = "https://app.example.com";
    process.env.PORTAL_URL = "https://portal2.example.com/admin";

    // Both are honoured, and PORTAL_URL's path is reduced to its origin.
    expect((await send("/registration-invite", "https://app.example.com/join/x").res).status).toBe(200);
    expect((await send("/registration-invite", "https://portal2.example.com/anything").res).status).toBe(200);
    expect((await send("/registration-invite", "https://other.example/x").res).status).toBe(400);

    delete process.env.APP_URL;
    delete process.env.PORTAL_URL;
  });
});

/**
 * ── ⚠ THE TWO BROADCAST ROUTES ARE SUBJECT TO THE SAME LINK RULE ──────────────────────────────
 *
 * `/release-update` and `/workshop-update` NEVER CALLED `rejectActionUrl`. The allowlist above was
 * therefore inert on exactly the two routes where it mattered most: `actionUrl` is caller-chosen,
 * `MAX_RECIPIENTS` is 50, the addresses need not belong to the platform, and `SENDER_ROLES` admits
 * EXECUTIVE — an ordinary team-level user. So an executive could aim the platform's own branded,
 * SPF/DKIM-signed button at a host they controlled, for 50 arbitrary addresses, which is the exact
 * scenario the file header describes as already having happened once.
 *
 * ⚠ `actionUrl` IS OPTIONAL ON THESE TWO SHAPES, and that is the difference from the three routes
 * above: an absent link must still send (a release note with no button is legitimate), so the guard is
 * conditional on presence. Both halves are asserted — the absent case sends, the bad case does not.
 */
describe("the broadcast routes enforce the link allowlist too", () => {
  const ORIGIN = "https://portal.example.com";
  const BROADCAST: Array<[path: string, body: Record<string, unknown>]> = [
    ["/release-update", { headline: "v2 is out", intro: "Here is what changed." }],
    ["/workshop-update", { headline: "Judging opens at 4pm", body: "Please be ready." }],
  ];

  const send = (path: string, body: Record<string, unknown>, role = "EXECUTIVE") => {
    const fresh = new FakeTransport();
    return {
      fresh,
      res: createNotifyRoutes({ email: fresh }).request(`/v1/notify${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...asUser({ id: "u1", role }) },
        body: JSON.stringify({ to: "someone@example.com", ...body }),
      }),
    };
  };

  beforeEach(() => {
    process.env.NOTIFY_ALLOWED_LINK_ORIGINS = ORIGIN;
  });
  afterEach(() => {
    delete process.env.NOTIFY_ALLOWED_LINK_ORIGINS;
  });

  for (const [path, required] of BROADCAST) {
    it(`${path} REFUSES an attacker-controlled origin and sends NOTHING`, async () => {
      const { fresh, res } = send(path, {
        ...required,
        actionUrl: "https://attacker.example/signin",
      });
      const r = await res;
      expect(r.status, path).toBe(400);
      expect(((await r.json()) as { code: string }).code, path).toBe("ACTION_URL_NOT_ALLOWED");
      expect(fresh.sent, path).toEqual([]);
    });

    it(`${path} REFUSES a javascript: link`, async () => {
      const { fresh, res } = send(path, {
        ...required,
        actionUrl: "javascript:alert(document.cookie)",
      });
      expect((await res).status, path).toBe(400);
      expect(fresh.sent, path).toEqual([]);
    });

    it(`${path} ACCEPTS a link on an allowed origin`, async () => {
      // NOT VACUOUS: without this the refusals above would pass on a route that refuses everything.
      const { fresh, res } = send(path, { ...required, actionUrl: `${ORIGIN}/x` });
      expect((await res).status, path).toBe(200);
      expect(fresh.sent.length, path).toBe(1);
    });

    it(`${path} still sends when actionUrl is ABSENT — the link is optional here`, async () => {
      // The regression this guards: a naive `rejectActionUrl(body.actionUrl)` refuses an absent
      // value by contract, which would have turned every buttonless broadcast into a 400.
      const { fresh, res } = send(path, required);
      expect((await res).status, path).toBe(200);
      expect(fresh.sent.length, path).toBe(1);
    });

    it(`${path} treats an explicit null actionUrl as absent`, async () => {
      const { fresh, res } = send(path, { ...required, actionUrl: null });
      expect((await res).status, path).toBe(200);
      expect(fresh.sent.length, path).toBe(1);
    });
  }
});

/**
 * ── ⚠ SEND ACCOUNTING (security finding, Medium) ─────────────────────────────────────────────
 *
 * "Unmetered branded-email relay: /v1/notify/* is gated only by a three-role set… There is no
 * per-user rate limit or send quota anywhere in the service." The role gate answered WHO may send;
 * nothing answered HOW MUCH, so a permitted role could send unlimited branded, SPF/DKIM-aligned
 * mail to caller-supplied addresses, 50 at a time.
 *
 * These are about the ROUTE's use of the quota — that it is consulted for every route, that a
 * refusal is a 429 with Retry-After and no send, and that it runs after the role check so a
 * forbidden caller is not metered. The quota's own contract is tested in service-shared.
 */
describe("⚠ send quota", () => {
  /** A quota that allows `allow` calls and then refuses, recording every subject it saw. */
  function fakeQuota(allow: number) {
    const subjects: string[] = [];
    return {
      subjects,
      consume: async (subject: string) => {
        subjects.push(subject);
        return {
          allowed: subjects.length <= allow,
          limit: allow,
          retryAfterSeconds: 1800,
        };
      },
    };
  }

  it("refuses with 429 and sends nothing once the allowance is spent", async () => {
    const quota = fakeQuota(1);
    const fresh = new FakeTransport();
    const metered = createNotifyRoutes({ email: fresh, quota });

    const first = await metered.request("/v1/notify/team-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...ADMIN_HEADERS },
      body: JSON.stringify(VALID_INVITE),
    });
    expect(first.status).toBe(200);
    expect(fresh.sent).toHaveLength(1);

    const second = await metered.request("/v1/notify/team-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...ADMIN_HEADERS },
      body: JSON.stringify(VALID_INVITE),
    });
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({
      code: "SEND_QUOTA_EXHAUSTED",
      limit: 1,
      retryAfterSeconds: 1800,
    });
    // Retry-After so a client can back off correctly rather than guessing.
    expect(second.headers.get("Retry-After")).toBe("1800");
    // The refusal costs no send — the point of the whole exercise.
    expect(fresh.sent).toHaveLength(1);
  });

  it("meters the AUTHENTICATED SENDER, not the recipients", async () => {
    // Keying on recipients would let one sender spread an unlimited campaign across addresses;
    // keying on the sender is what bounds the sender.
    const quota = fakeQuota(10);
    const metered = createNotifyRoutes({ email: new FakeTransport(), quota });

    await metered.request("/v1/notify/team-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...asUser({ id: "exec-7", role: "EXECUTIVE" }) },
      body: JSON.stringify(VALID_INVITE),
    });

    expect(quota.subjects).toEqual(["exec-7"]);
  });

  it("does NOT meter a caller the role gate already refused", async () => {
    // Ordering: a PARTICIPANT gets 403 and spends nothing, so an unauthorized caller cannot drain
    // somebody else's allowance or their own.
    const quota = fakeQuota(1);
    const metered = createNotifyRoutes({ email: new FakeTransport(), quota });

    const res = await metered.request("/v1/notify/team-invite", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...asUser({ id: "p1", role: "PARTICIPANT" }) },
      body: JSON.stringify(VALID_INVITE),
    });

    expect(res.status).toBe(403);
    expect(quota.subjects).toEqual([]);
  });

  it("is unmetered when no quota is wired, which is the pre-fix behaviour", async () => {
    // Stated as a test rather than left implicit: the dependency is optional so the service still
    // composes without it, and app.ts warns loudly at cold start when it is absent.
    const fresh = new FakeTransport();
    const unmetered = createNotifyRoutes({ email: fresh });

    for (let i = 0; i < 3; i++) {
      const res = await unmetered.request("/v1/notify/team-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...ADMIN_HEADERS },
        body: JSON.stringify(VALID_INVITE),
      });
      expect(res.status).toBe(200);
    }
    expect(fresh.sent).toHaveLength(3);
  });
});
