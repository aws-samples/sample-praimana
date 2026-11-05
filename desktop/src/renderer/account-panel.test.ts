import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE READ-ONLY ACCOUNT DETAILS PANEL.
 *
 * ── ⚠ WHAT THE AUDIT FOUND BEFORE ANY CODE WAS WRITTEN ──
 *
 * Half of what this panel shows is not on this machine. Checked rather than assumed:
 *
 *   name, email, team name, ids  already local settings.
 *   ROLE                         NOT stored locally at all. Authoritative from the ID token's
 *                                `cognito:groups` claim and echoed by `GET /v1/auth/me` — which login
 *                                already calls, and reads only `name` from.
 *   EXPERIENCE NAME              no local copy and no wired lookup; only `workshop_id` was stored.
 *   COGNITO CONFIG               never persisted; `/v1/auth/config` serves it.
 *
 * So this is a handler with three independent remote reads, not a few `getSetting` calls — and the
 * assertions below are mostly about the two properties that follow from that: nothing may leak, and every
 * remote field must degrade rather than fail the panel.
 *
 * SOURCE ASSERTIONS: this package's vitest is node-only with no jsdom, so no test here can click the user
 * row or observe a render. The IPC contract and the handler's shape are what is decidable.
 */

const local = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel: string) => readFileSync(local(rel), "utf8");

const HANDLER = read("../main/handlers/team-data.ts");
const PRELOAD = read("../preload/index.ts");
const PANEL = read("./components/AccountPanel.tsx");
const SIDEBAR = read("./components/Sidebar.tsx");

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const handlerCode = strip(HANDLER);
const panelCode = strip(PANEL);
const sidebarCode = strip(SIDEBAR);

/** Just the account handler, so assertions cannot pass on some other handler in the same file. */
const accountHandler = (() => {
  const start = handlerCode.indexOf('ipcMain.handle("account:getDetails"');
  expect(start, "the account handler must exist").toBeGreaterThan(-1);
  return handlerCode.slice(start);
})();

describe("⚠ NO SECRET CROSSES THE IPC BOUNDARY", () => {
  it("returns neither the auth token nor the refresh token", () => {
    /**
     * THE ASSERTION THAT MATTERS MOST IN THIS FILE. Both are encrypted at rest specifically so they stay in
     * the main process, and a details panel has no use for either. The renderer is the one place they must
     * never reach — an XSS in a markdown reply would otherwise be able to read them.
     */
    expect(accountHandler).not.toContain("auth_token");
    expect(accountHandler).not.toContain("cognito_refresh_token");
    expect(accountHandler).not.toContain("user_password");
  });

  it("the panel never renders a CREDENTIAL", () => {
    /**
     * Belt and braces on the other side of the boundary: even if a future handler change returned a
     * credential, the UI must not be the thing that displays it.
     *
     * ⚠ NAMED CREDENTIALS, NOT THE WORD "token". This assertion used to be `not.toMatch(/token/i)`, which
     * broke the moment the panel legitimately displayed `tokenEndpoint` — the pool's PUBLIC OAuth token URL
     * from AWS discovery, which is not a secret and which a facilitator debugging sign-in asks for by name.
     *
     * A test that forbids a substring cannot tell a credential from a URL that contains the word, and the
     * cost of the blunt version is that the next person deletes it wholesale. These are the actual field
     * names a credential would arrive under.
     */
    for (const credential of [
      "authToken",
      "auth_token",
      "idToken",
      "accessToken",
      "refreshToken",
      "cognito_refresh_token",
      "clientSecret",
      "client_secret",
      "password",
    ]) {
      expect(panelCode, `${credential} must never reach the Account panel`).not.toContain(credential);
    }
  });

  it("only the PUBLIC Cognito values are returned", () => {
    /**
     * Issuer, client id, the authorize/token endpoints and scopes are all handed to any browser during the
     * OAuth redirect — readable from the network tab of a normal sign-in, so showing them discloses nothing.
     * A client SECRET would be a different matter; this pool has none, and the allow-list shape below means
     * one could not appear by accident if a future config carried it.
     */
    expect(accountHandler).toContain("issuer: cfg.cognito.issuer");
    expect(accountHandler).toContain("clientId: cfg.cognito.clientId");
    // The two AWS-published OAuth endpoints, which replaced the single Hosted UI domain: they come
    // from AWS's OIDC discovery document, so they are what sign-in will REALLY use.
    expect(accountHandler).toContain("authorizationEndpoint: cfg.cognito.authorizationEndpoint");
    expect(accountHandler).toContain("tokenEndpoint: cfg.cognito.tokenEndpoint");
    expect(accountHandler).toContain("scopes: cfg.cognito.scopes");
    expect(accountHandler, "no spread — an allow-list, so a new secret field cannot ride along").not.toMatch(
      /\.\.\.cfg/
    );
    expect(accountHandler).not.toMatch(/clientSecret/i);
  });
});

describe("the ACCOUNT channel is READ-ONLY", () => {
  it("exposes a getter and no setter", () => {
    /**
     * Read-only for now, and it is also the honest shape: every field is owned
     * elsewhere. The identity service REFUSES `role` on PATCH — accepting it from a client would be privilege
     * escalation by request — and derives `name` from firstName/lastName rather than accepting it. An input
     * that silently fails is worse than a stated fact.
     *
     * ⚠ THE ACCESS KEY DOES NOT WEAKEN THIS. It is settable, but NOT through this
     * channel: `platform:connect` is a separate handler because changing it voids
     * the session, and it is not an account detail. So `account:getDetails` still has no
     * setter, and the platform write still cannot be reached by asking to "update the
     * account".
     */
    expect(PRELOAD).toContain("getAccountDetails");
    expect(PRELOAD).not.toMatch(/setAccountDetails|updateAccount|saveAccount/);
    expect(handlerCode).not.toMatch(/account:(set|update|save)/);
  });

  /**
   * ── NO INPUTS AT ALL, WHICH IS WHERE THIS STARTED ──
   *
   * This assertion was "renders no inputs", was briefly relaxed to "exactly one, the platform
   * URL", and is now back to the strict form — because the platform arrives WITH the session
   * from the portal, so there is no longer any value on this page for a participant to set.
   *
   * The protection is the same one it always was: no input may appear for a field owned
   * elsewhere. `role` is the sharp case — the identity service refuses it on PATCH because
   * accepting it from a client is privilege escalation by request — and name, email, team and
   * experience are each owned elsewhere too. The Cognito values are DERIVED (pool from the
   * claim response, endpoints from AWS discovery), so an input would only desynchronise them.
   */
  it("⚠ renders NO editable control for any ACCOUNT field", () => {
    /**
     * ⚠ NARROWED TWICE, WEAKENED NEITHER TIME. First it asserted zero `input|textarea|select`
     * anywhere on the page, and the report form added a textarea. Then the subject field added an `<input>`,
     * which the "no input, ever" form refused.
     *
     * The GUARANTEE has never changed and is about ACCOUNT DATA: no editable control may appear for a field
     * owned elsewhere. `role` is the sharp case — the identity service refuses it on PATCH because accepting
     * it from a client is privilege escalation by request — and name, email, team and experience are each
     * owned elsewhere too. A bug report is not account data; it is new text the participant is authoring.
     *
     * ⚠ SO THE RULE IS NOW POSITIONAL RATHER THAN A COUNT, which is what the guarantee actually says: every
     * control in this file must live INSIDE the report form. A count of "one input, one textarea" would be
     * satisfied by an input that had drifted up into the account rows and a textarea in the report — the
     * exact defect this test exists to catch. The count is kept as well, so an unbounded second free-text
     * field cannot appear even in the right place.
     */
    const reportForm = panelCode.indexOf("function FeedbackForm(");
    expect(reportForm, "the report form must be findable for the rule below to mean anything").toBeGreaterThan(0);

    for (const control of ["input", "textarea", "select"]) {
      for (const found of panelCode.matchAll(new RegExp(`<${control}\\b`, "g"))) {
        expect(
          found.index,
          `a <${control}> appears OUTSIDE the report form — no account field may be edited here`
        ).toBeGreaterThan(reportForm);
      }
    }

    expect(panelCode.match(/<select\b/g) ?? [], "nothing on this page is ever chosen").toHaveLength(0);
    expect(panelCode.match(/<input\b/g) ?? [], "the ONLY input is the report's subject").toHaveLength(1);
    expect(
      panelCode.match(/<textarea\b/g) ?? [],
      "the ONLY textarea is the report's description"
    ).toHaveLength(1);
    // And both are unmistakably the report's: labelled from the shared field names, not stray fields.
    expect(panelCode).toContain("aria-label={FEEDBACK_FIELD_LABELS.subject}");
    expect(panelCode).toContain("aria-label={FEEDBACK_FIELD_LABELS.message}");
  });

  /**
   * ⚠ THE ONE ACTION IS DESTRUCTIVE AND MUST BE CONFIRMED.
   *
   * "Sign in to another experience" discards the configuration AND the saved accounts for that
   * platform, and neither is recoverable from inside the app. A single-click version of this is
   * how someone loses a session they wanted.
   */
  it("gates the reset behind an explicit confirmation", () => {
    // The renderer calls the BRIDGE; the channel name lives in the preload. Asserting the
    // channel here would pass only by coincidence of where a string happens to appear.
    expect(panelCode).toContain("api.resetPlatform()");
    expect(PRELOAD).toContain("platform:reset");
    // Two-step: a `confirming` state exists between the button and the action.
    expect(panelCode).toMatch(/setConfirming\(true\)/);
    // And the consequence is spelled out, not just the verb.
    expect(PANEL).toMatch(/forgotten|signed out/i);
  });

  it("and SAYS which parts are read-only rather than leaving it implied", () => {
    // A panel of facts with one edit control reads as "the rest is not implemented yet"
    // unless it says otherwise.
    expect(PANEL).toContain("Read-only");
  });
});

describe("⚠ EVERY REMOTE FIELD DEGRADES", () => {
  it("uses allSettled, so one failing call cannot suppress the others", () => {
    /**
     * Three independent reads. Sequential awaits would let a slow `/auth/me` delay the Cognito config, and a
     * rejection would lose both of the others — turning "role unavailable" into "no account details at all",
     * which is a strictly worse answer than the local half.
     */
    expect(accountHandler).toContain("Promise.allSettled");
    expect(accountHandler).toMatch(/status === "fulfilled"/);
    /**
     * ⚠ AND `Promise.all` IS EXCLUDED BY NAME. Mutation testing showed why: swapping `allSettled` for `all`
     * left the `status === "fulfilled"` reads in place, so both assertions above still passed AND it
     * type-checked — while the runtime behaviour inverted completely. `Promise.all` REJECTS on the first
     * failure, so a single unreachable endpoint would throw past the whole merge and lose the local fields
     * too: exactly the "no account details at all" outcome this is meant to prevent.
     */
    // ⚠ A NEGATIVE LOOKAHEAD, because `/Promise\.all\(/` ALSO matches `Promise.allSettled(` — my first
    // version of this line could therefore never fire, which is the third time a substring check has quietly
    // asserted nothing in this repo.
    expect(accountHandler, "Promise.all would reject the whole read on one failure").not.toMatch(
      /Promise\.all(?!Settled)/
    );
  });

  it("⚠ the degradation is REAL, not just the right method name", () => {
    /**
     * Executing the actual pattern, because the assertion above only checks which function is called. This
     * runs the same shape the handler uses — three independent reads where the first REJECTS — and proves the
     * other two still arrive. It is the one thing in this file that tests behaviour rather than source.
     */
    const results = Promise.allSettled([
      Promise.reject(new Error("offline")),
      Promise.resolve({ workshop: { name: "Spring Accelerator" } }),
      Promise.resolve({ issuer: "https://issuer.example" }),
    ]);

    return results.then(([me, ws, cfg]) => {
      expect(me.status, "the failing read is contained").toBe("rejected");
      expect(ws.status, "and the others still land").toBe("fulfilled");
      expect(cfg.status).toBe("fulfilled");
    });
  });

  it("returns the LOCAL fields even when every fetch fails", () => {
    // The busy-slot fallback is the local snapshot with the three remote fields null — so a participant who
    // is offline still sees their name, email, team and ids.
    expect(accountHandler).toMatch(/role: null, organization: null, workshopName: null, cognito: null/);
  });

  it("bounds every request", () => {
    // House rule: every external call has a timeout. Without one, an unreachable backend leaves the dialog
    // on "Loading…" for ever.
    const timeouts = [...accountHandler.matchAll(/AbortSignal\.timeout\(READ_TIMEOUT_MS\)/g)];
    expect(timeouts.length, "both authed reads are bounded").toBeGreaterThanOrEqual(2);
  });

  it("prefers the SERVER's name and email over the local snapshot", () => {
    /**
     * `/v1/auth/me` is authoritative: the profile row is where the display name actually lives, and the
     * stored setting is a snapshot from login that a later profile edit leaves stale. The local value is the
     * fallback, not the source.
     */
    expect(accountHandler).toMatch(/user\?\.name === "string" && user\.name\) \|\| local\.name/);
    expect(accountHandler).toMatch(/user\?\.email === "string" && user\.email\) \|\| local\.email/);
  });

  it("⚠ role has NO local fallback, because none exists to be wrong", () => {
    /**
     * The subtle one. There is no stored role, so `role` is null when the fetch fails — and the panel says
     * "Not available", not blank. A blank would read as "you have no role", which is a different and false
     * statement; the distinction is the whole reason the Row component takes a per-field `missing` message.
     */
    expect(accountHandler).toMatch(/role: typeof user\?\.role === "string" \? user\.role : null/);
    expect(panelCode).toContain('missing="Not available — could not reach the platform"');
  });

  it("distinguishes 'no team' from 'could not load'", () => {
    // Being on no team is a normal state with its own message; failing to load is not.
    expect(panelCode).toContain('missing="Not on a team"');
  });
});

describe("the experience name is resolved, not faked", () => {
  it("calls the workshop endpoint for it", () => {
    /**
     * There is no local workshop NAME — only its id. The real lookup is wired rather than
     * display a raw id, so `GET /v1/workshops/:id` is called; it is gated on membership, which a participant
     * satisfies.
     */
    expect(accountHandler).toContain("/v1/workshops/");
    expect(accountHandler).toContain("encodeURIComponent(local.workshopId");
    expect(accountHandler).toMatch(/workshopName: typeof ws\?\.name === "string" \? ws\.name : null/);
  });

  it("shows the ID as well as the name", () => {
    // The name is what a participant recognises; the id is what appears in a support conversation or an S3
    // key. Neither replaces the other.
    expect(panelCode).toContain('label="Experience"');
    expect(panelCode).toContain('label="Experience ID"');
  });

  it("shows the role's raw code beside its friendly label", () => {
    /**
     * "Executive" is not greppable against `cognito:groups`. A facilitator diagnosing "why can't I see
     * insights" needs the exact string the token carries, so both are shown.
     */
    expect(panelCode).toMatch(/ROLE_LABELS\[details\.role\] \?\? details\.role/);
    expect(panelCode).toMatch(/\$\{details\.role\}/);
  });
});

describe("⚠ IT IS A ROUTED VIEW, NOT A POPUP", () => {
  /**
   * ⚠ THREE ASSERTIONS HERE WERE REVERSED, and deliberately: they required a focus trap, an Escape handler and
   * a backdrop that closes on click — all correct for the dialog this used to be, and all wrong for a view. A
   * test that encodes a modal has to change when the modal becomes a page.
   */
  it("the user row SELECTS the view", () => {
    // A `<button>` rather than a clickable `<div>`: it keeps its tab stop, Enter/Space activation and accessible
    // name. It now behaves like every other nav item in that column.
    expect(sidebarCode).toContain('onSelectView("account")');
    expect(sidebarCode, "no dialog state left").not.toContain("setShowAccount");
    expect(sidebarCode, "and it does not announce a popup").not.toContain('aria-haspopup="dialog"');
  });

  it("shows as SELECTED while it is the active view", () => {
    // The affordance a popup could not have, and the reason moving it is an improvement rather than a shuffle.
    expect(sidebarCode).toMatch(/view === "account" \? "bg-surface-raised"/);
  });

  it("is routed like Settings", () => {
    const app = strip(read("./App.tsx"));
    /**
     * ⚠ THE UNION IS EXTRACTED, NOT MATCHED WITH `[\s\S]*`. My first version did the latter, so the pattern ran
     * past the type declaration and matched the `view === "account"` route further down the file — the assertion
     * passed with the union member deleted, which is precisely the mismatch that makes a nav item render nothing
     * with no compiler error.
     */
    const union = app.match(/type View =([\s\S]*?);/)?.[1] ?? "";
    expect(union, "found the View union").toBeTruthy();
    expect(union, "account is a member of the union itself").toContain('"account"');
    /**
     * ⚠ THE ROUTE IS NOW A `switch` CASE, NOT A TERNARY ARM. This asserted `view === "account"` and fired
     * when the single-pane ternary became `renderView(v)` — a function, so the same view can be rendered
     * in a SECOND pane when it is pinned beside the active one. The claim is unchanged: "account" is
     * routed, not merely defined.
     */
    expect(app).toContain('case "account":');
    // Takes `onSignOut` now: sign-out moved here from Settings, so the panel has to tell
    // App.tsx that a session ended and the gates need re-reading.
    expect(app).toMatch(/<AccountPanel\s+onSignOut=/);
  });

  it("⚠ NO FOCUS TRAP, NO BACKDROP — it is a page, not a dialog", () => {
    /**
     * These belonged to the dialog this used to be. A `fixed inset-0` backdrop would still
     * be intercepting clicks across the whole window.
     */
    expect(panelCode, "not a dialog").not.toContain('role="dialog"');
    expect(panelCode).not.toContain("aria-modal");
    expect(panelCode, "no backdrop").not.toContain("fixed inset-0");
    expect(panelCode, "and nothing to stop propagating to").not.toContain("stopPropagation");
  });

  /**
   * ⚠ NO ESCAPE HANDLER, back to the original rule.
   *
   * It briefly existed for an inline editor that is gone. On a routed page there is nothing to
   * dismiss, so a listener would make the key do something invisible — and a page-level key
   * handler is the specific thing this guards against returning.
   */
  it("handles no keyboard shortcuts — it is a page, not a dialog", () => {
    expect(panelCode).not.toMatch(/e\.key === "Escape"/);
    expect(panelCode, "no document-level key listener").not.toMatch(/addEventListener\(\s*"keydown"/);
  });

  it("wears the same shell as Settings", () => {
    /**
     * The literal request — "so we have same view". Same scrolling column, same bounded measure on an inner
     * wrapper so the dark fill spans the window while the prose stays readable, same page-title weight.
     */
    const settings = strip(read("./components/SettingsView.tsx"));
    for (const shape of ["flex-1 overflow-y-auto bg-surface-bg p-8", "mx-auto max-w-2xl"]) {
      expect(panelCode, `Account uses ${shape}`).toContain(shape);
      expect(settings, `Settings uses ${shape}`).toContain(shape);
    }
    expect(panelCode, "a page title, not a dialog label").toContain("text-2xl font-bold");
  });

  it("values are selectable, since copying them is the point", () => {
    // These are ids, URLs and a client id — things people paste into a ticket or a terminal. The label is
    // deliberately NOT selectable, so a selection does not drag it along.
    expect(panelCode).toContain("select-text");
  });

  it("cancels its fetch on unmount", () => {
    // Closing the dialog mid-request would otherwise setState on an unmounted tree.
    expect(panelCode).toContain("cancelled = true");
  });
});
