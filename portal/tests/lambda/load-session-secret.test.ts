import { describe, it, expect, vi } from "vitest";
import loader from "../../lambda/load-session-secret.cjs";

const { loadSessionSecret, parseSessionSecret, readSecretArn, SessionSecretError, MIN_SECRET_LENGTH } = loader;

const ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:praimana-portal-session-AbCdEf";
const CURRENT = "c".repeat(MIN_SECRET_LENGTH + 8);
const PREVIOUS = "p".repeat(MIN_SECRET_LENGTH + 8);

type Env = Record<string, string | undefined>;

function secretOf(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

describe("readSecretArn", () => {
  it("returns a valid Secrets Manager ARN", () => {
    expect(readSecretArn({ NEXTAUTH_SECRET_ARN: ARN })).toBe(ARN);
  });

  it.each([
    ["missing", {}],
    ["empty", { NEXTAUTH_SECRET_ARN: "" }],
    ["not an ARN", { NEXTAUTH_SECRET_ARN: "praimana-portal-session" }],
    ["another service", { NEXTAUTH_SECRET_ARN: "arn:aws:ssm:us-east-1:123456789012:parameter/x" }],
    ["injection characters", { NEXTAUTH_SECRET_ARN: `${ARN} ; rm -rf /` }],
  ])("rejects an ARN that is %s", (_label, env: Env) => {
    expect(() => readSecretArn(env)).toThrow(SessionSecretError);
  });
});

describe("parseSessionSecret", () => {
  it("returns the current key and no previous key", () => {
    expect(parseSessionSecret(secretOf({ NEXTAUTH_SECRET: CURRENT }))).toEqual({
      current: CURRENT,
      previous: undefined,
    });
  });

  it("returns the previous key during a rotation overlap", () => {
    const parsed = parseSessionSecret(secretOf({ NEXTAUTH_SECRET: CURRENT, NEXTAUTH_SECRET_PREVIOUS: PREVIOUS }));
    expect(parsed).toEqual({ current: CURRENT, previous: PREVIOUS });
  });

  it("treats an empty previous key as absent", () => {
    const parsed = parseSessionSecret(secretOf({ NEXTAUTH_SECRET: CURRENT, NEXTAUTH_SECRET_PREVIOUS: "" }));
    expect(parsed.previous).toBeUndefined();
  });

  it.each([
    ["no SecretString", undefined],
    ["a JSON array", "[]"],
    ["JSON null", "null"],
    ["a bare string", JSON.stringify(CURRENT)],
    ["no current key", secretOf({ OTHER: CURRENT })],
    ["a short current key", secretOf({ NEXTAUTH_SECRET: "x".repeat(MIN_SECRET_LENGTH - 1) })],
    ["a non-string current key", secretOf({ NEXTAUTH_SECRET: 12345 })],
    ["a short previous key", secretOf({ NEXTAUTH_SECRET: CURRENT, NEXTAUTH_SECRET_PREVIOUS: "short" })],
  ])("rejects %s", (_label, value) => {
    expect(() => parseSessionSecret(value)).toThrow(SessionSecretError);
  });

  it("does not echo the secret value when the JSON is malformed", () => {
    const leaked = `{"NEXTAUTH_SECRET":"${CURRENT}"`;
    let message = "";
    try {
      parseSessionSecret(leaked);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("secret value is not valid JSON");
    expect(message).not.toContain(CURRENT);
  });

  it("does not echo the secret value when a key is too short", () => {
    const short = "s".repeat(MIN_SECRET_LENGTH - 1);
    expect(() => parseSessionSecret(secretOf({ NEXTAUTH_SECRET: short }))).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(short) }),
    );
  });
});

describe("loadSessionSecret", () => {
  it("fetches by the ARN from the environment and sets the current key", async () => {
    const env: Env = { NEXTAUTH_SECRET_ARN: ARN };
    const getSecretString = vi.fn().mockResolvedValue(secretOf({ NEXTAUTH_SECRET: CURRENT }));

    const result = await loadSessionSecret({ env, getSecretString });

    expect(getSecretString).toHaveBeenCalledExactlyOnceWith(ARN);
    expect(env.NEXTAUTH_SECRET).toBe(CURRENT);
    expect(env).not.toHaveProperty("NEXTAUTH_SECRET_PREVIOUS");
    expect(result).toEqual({ hasPrevious: false });
  });

  it("sets the previous key during a rotation overlap", async () => {
    const env: Env = { NEXTAUTH_SECRET_ARN: ARN };
    const getSecretString = vi
      .fn()
      .mockResolvedValue(secretOf({ NEXTAUTH_SECRET: CURRENT, NEXTAUTH_SECRET_PREVIOUS: PREVIOUS }));

    const result = await loadSessionSecret({ env, getSecretString });

    expect(env.NEXTAUTH_SECRET_PREVIOUS).toBe(PREVIOUS);
    expect(result).toEqual({ hasPrevious: true });
  });

  it("removes a stale previous key that the secret no longer carries", async () => {
    const env: Env = { NEXTAUTH_SECRET_ARN: ARN, NEXTAUTH_SECRET_PREVIOUS: PREVIOUS };
    const getSecretString = vi.fn().mockResolvedValue(secretOf({ NEXTAUTH_SECRET: CURRENT }));

    await loadSessionSecret({ env, getSecretString });

    expect(env).not.toHaveProperty("NEXTAUTH_SECRET_PREVIOUS");
  });

  it("does not call Secrets Manager when the ARN is invalid", async () => {
    const getSecretString = vi.fn();
    await expect(loadSessionSecret({ env: {}, getSecretString })).rejects.toThrow(SessionSecretError);
    expect(getSecretString).not.toHaveBeenCalled();
  });

  it("leaves the environment untouched when the fetch fails", async () => {
    const env: Env = { NEXTAUTH_SECRET_ARN: ARN };
    const denied = Object.assign(new Error("not authorized"), { name: "AccessDeniedException" });
    const getSecretString = vi.fn().mockRejectedValue(denied);

    await expect(loadSessionSecret({ env, getSecretString })).rejects.toBe(denied);
    expect(env).not.toHaveProperty("NEXTAUTH_SECRET");
  });

  it("leaves the environment untouched when the value is invalid", async () => {
    const env: Env = { NEXTAUTH_SECRET_ARN: ARN };
    const getSecretString = vi.fn().mockResolvedValue(secretOf({ NEXTAUTH_SECRET: "short" }));

    await expect(loadSessionSecret({ env, getSecretString })).rejects.toThrow(SessionSecretError);
    expect(env).not.toHaveProperty("NEXTAUTH_SECRET");
  });
});
