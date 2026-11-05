import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ConsoleEmailTransport,
  SesEmailTransport,
  redactForLog,
} from "./transport.js";

/**
 * ── THE SILENT FALL-OPEN THAT TURNED THE MAIL PATH INTO A CREDENTIAL LOG ───────────────────
 *
 * Previously `selectTransport` returned the console transport whenever EMAIL_FROM
 * was absent AND whenever the SES constructor threw, with no environment gate anywhere in the
 * service — so a missing or mistyped EMAIL_FROM on a deployed function wrote live Cognito
 * temporary passwords, raw single-use invite tokens and every recipient address to CloudWatch,
 * while returning `{sent, via:"console"}` to the caller as a success.
 *
 * These assertions pin the two halves of the fix:
 *   1. Selection FAILS CLOSED — no EMAIL_FROM and no explicit dev flag is a THROW, not a
 *      downgrade. A function that cannot send mail must not start.
 *   2. The console transport REDACTS the credential and logs domains, not addresses, so a
 *      future mistake in the composition root cannot on its own leak one.
 *
 * ⚠ app.ts SELECTS A TRANSPORT AT MODULE LOAD — that is the point of a composition root, and
 * it is also why EMAIL_FROM has to be set before the import below or this file cannot load.
 * The exported `selectTransport` then takes its env as a PARAMETER, so every case here is
 * exercised without mutating the real process environment.
 */
process.env.EMAIL_FROM = "no-reply@import-time.example";
const { selectTransport, DEV_CONSOLE_TRANSPORT_FLAG } = await import("./app.js");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("transport selection fails closed", () => {
  it("throws rather than downgrading when EMAIL_FROM is absent", () => {
    // The exact shape of the reported defect: no mail configuration at all.
    expect(() => selectTransport({})).toThrow(/EMAIL_FROM is not set/);
  });

  it("names both remedies in the failure, because the operator could need either", () => {
    // An operator hitting this has either forgotten a deployment variable or is trying to
    // run the stack on a laptop. A message that answers only one of those sends the other
    // one looking for the flag in the source.
    expect(() => selectTransport({})).toThrow(/verified SES identity/);
    expect(() => selectTransport({})).toThrow(
      new RegExp(DEV_CONSOLE_TRANSPORT_FLAG)
    );
  });

  it("does not accept a merely truthy dev flag", () => {
    // Checked against the literal "true": every one of these is somebody trying to turn the
    // flag OFF, and truthiness would read them all as ON.
    for (const value of ["1", "false", "0", "no", "yes", "TRUE", ""]) {
      expect(() =>
        selectTransport({ [DEV_CONSOLE_TRANSPORT_FLAG]: value })
      ).toThrow(/EMAIL_FROM is not set/);
    }
  });

  it("does not fall back to console when the SES transport cannot be constructed", () => {
    // The second silent path: EMAIL_FROM present but empty threw inside the constructor and
    // was CAUGHT, downgrading to console. It must propagate now.
    expect(() => selectTransport({ EMAIL_FROM: "" })).toThrow(
      /EMAIL_FROM is not set/
    );
  });

  it("selects SES when EMAIL_FROM is configured, dev flag or not", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(
      selectTransport({ EMAIL_FROM: "no-reply@example.test" })
    ).toBeInstanceOf(SesEmailTransport);
    // EMAIL_FROM WINS. A deployed function that somehow also carries the dev flag must still
    // send real mail rather than log bodies.
    expect(
      selectTransport({
        EMAIL_FROM: "no-reply@example.test",
        [DEV_CONSOLE_TRANSPORT_FLAG]: "true",
      })
    ).toBeInstanceOf(SesEmailTransport);
  });

  it("returns the console transport only on an explicit opt-in, and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      selectTransport({ [DEV_CONSOLE_TRANSPORT_FLAG]: "true" })
    ).toBeInstanceOf(ConsoleEmailTransport);
    // WARN not log, and it must say that nothing is being sent — if this line ever appears in
    // a deployed environment's logs it is an incident, and it has to read like one.
    expect(warn).toHaveBeenCalledOnce();
    const line = warn.mock.calls[0]!.join(" ");
    expect(line).toMatch(/NO MAIL WILL BE SENT/);
    expect(line).toMatch(/never be set on a deployed function/);
  });
});

describe("the console transport does not log credentials", () => {
  /** The real shape `passwordLines` renders (templates.ts). */
  const BODY = [
    "You've been invited to Praimana.",
    "",
    "Temporary password: Hunter2-Correct-Horse",
    "",
    "You'll be asked to replace it on first sign-in.",
    "https://app.example.test/join/01JAVERYREALTOKEN",
  ].join("\n");

  it("redacts the temporary password line and keeps the rest readable", () => {
    const out = redactForLog(BODY);
    expect(out).not.toContain("Hunter2-Correct-Horse");
    expect(out).toContain("Temporary password: [REDACTED");
    // The surrounding prose must survive, or the preview is useless and somebody will
    // "temporarily" revert this.
    expect(out).toContain("You'll be asked to replace it on first sign-in.");
  });

  it("redacts every occurrence and tolerates indentation and recasing", () => {
    const out = redactForLog(
      "  Temporary password: aaa\ntemporary PASSWORD: bbb\n"
    );
    expect(out).not.toMatch(/aaa|bbb/);
  });

  it("leaves a body with no credential untouched", () => {
    const plain = "Your workshop starts at 09:00.\nSee you there.";
    expect(redactForLog(plain)).toBe(plain);
  });

  it("logs recipient DOMAINS and a count, never the addresses", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await new ConsoleEmailTransport().send({
      to: ["alice@corp.example", "bob@corp.example", "carol@other.example"],
      subject: "You're invited",
      html: "<p>hi</p>",
      text: BODY,
    });

    const line = log.mock.calls[0]!.join(" ");
    expect(line).not.toContain("alice@corp.example");
    expect(line).not.toContain("bob@corp.example");
    expect(line).not.toContain("carol@other.example");
    expect(line).toContain("corp.example");
    expect(line).toContain("other.example");
    expect(line).toContain("3 recipients");
    // And the credential is gone from the line that actually reaches the log, not merely
    // from the helper.
    expect(line).not.toContain("Hunter2-Correct-Horse");
  });

  it("still reports the send as via:console so callers can tell mail was not sent", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await new ConsoleEmailTransport().send({
      to: ["a@b.example"],
      subject: "s",
      html: "",
      text: "",
    });
    expect(result).toEqual({ messageId: null, via: "console" });
  });
});
