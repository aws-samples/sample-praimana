// ── ⚠ A MODEL ID IS RENDERER INPUT THAT REACHES argv ──────────────────────────────────────────
//
// On Windows that argv passed through `cmd.exe`, where a defect in the command-line construction made
// `--model "sonnet & calc.exe"` execute `calc.exe`. Two things had to be wrong for that to be reachable, and
// only one of them was fixed by correcting the quoting — nothing anywhere established that a model id is not
// an arbitrary string.
//
// ⚠ THIS IS THE LAYER THAT DOES NOT DEPEND ON GETTING cmd.exe RIGHT. It would have closed the vector on
// a platform whose quoting rules nobody had verified, which is the more durable of the two guarantees.

import { describe, it, expect, vi, afterEach } from "vitest";
// Static rather than require()d inside the helper below: neither symbol needs lazy
// loading, and @typescript-eslint/no-require-imports forbids the require() form.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isSafeModelId, safeModelId } from "./model-id";

afterEach(() => vi.restoreAllMocks());

describe("what a real model id looks like", () => {
  it("accepts every id the shipped catalogues actually contain", () => {
    /**
     * Taken from the three catalogues this app reads rather than invented — kiro's Bedrock ids carry a
     * colon, which is the one character a naive `[a-z0-9-]` rule would have broken.
     */
    for (const id of [
      "sonnet",
      "opus",
      "haiku",
      "claude-sonnet-4-5-20250929",
      "gpt-5.6-sol",
      "gpt-5.5",
      "o3-mini",
      "claude-sonnet-4.5",
      "amazon-nova-pro-v1:0",
      "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
    ]) {
      expect(safeModelId(id), id).toBe(id);
    }
  });

  it("⚠ refuses the reported payload", () => {
    expect(safeModelId("sonnet & calc.exe")).toBeUndefined();
  });

  it("refuses every shell and cmd metacharacter", () => {
    // An allowlist, so this is a demonstration rather than the mechanism — but it is the demonstration
    // a reviewer will look for.
    for (const bad of [
      "sonnet & calc",
      "sonnet && calc",
      "sonnet | more",
      "sonnet > out.txt",
      "sonnet < in.txt",
      "a ^ b",
      "%PATH%",
      'a"b',
      "a'b",
      "a`b",
      "a$(b)",
      "a;b",
      "a\nb",
      "a\rb",
      "a\u0000b",
      "../../etc/passwd",
      "C:\\Windows\\System32\\calc.exe",
      "sonnet ",
      " sonnet",
    ]) {
      expect(safeModelId(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("refuses anything that is not a string", () => {
    // IPC payloads arrive as whatever the caller sent.
    for (const junk of [undefined, null, 42, {}, [], true, { toString: () => "sonnet" }]) {
      expect(safeModelId(junk)).toBeUndefined();
    }
  });

  it("is anchored, so a good prefix cannot carry a bad suffix", () => {
    expect(safeModelId("sonnet\n& calc")).toBeUndefined();
    expect(safeModelId("sonnet & calc\n")).toBeUndefined();
  });

  it("must start with a letter or digit", () => {
    // A leading `-` would be read as a flag by the CLI rather than as a value.
    for (const bad of ["-sonnet", "--model", ".sonnet", ":sonnet", "_sonnet"]) {
      expect(safeModelId(bad), bad).toBeUndefined();
    }
  });

  it("is bounded in length", () => {
    // Unbounded input into a command line is its own problem, whatever the characters.
    expect(safeModelId("a".repeat(128))).toBe("a".repeat(128));
    expect(safeModelId("a".repeat(129))).toBeUndefined();
  });
});

describe("⚠ how it fails matters as much as that it fails", () => {
  it("degrades to the CLI's default rather than throwing", () => {
    /**
     * Omitting `--model` is a complete, correct behaviour — it is what happens on every turn where the
     * user has not chosen a model. Throwing would turn a malformed value into a failed chat turn.
     */
    expect(() => safeModelId("sonnet & calc")).not.toThrow();
    expect(safeModelId("sonnet & calc")).toBeUndefined();
  });

  it("⚠ does NOT log the rejected value", () => {
    /**
     * The value is attacker-controlled text, and the warning lands in a log the user is invited to
     * export (`telemetry:openLog`). Logging it would move the payload somewhere it is easier to read.
     */
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    safeModelId("sonnet & calc.exe");
    expect(warn).toHaveBeenCalled();
    for (const call of warn.mock.calls) {
      expect(call.join(" "), "the payload must not appear").not.toContain("calc.exe");
    }
  });

  it("says nothing at all for the ordinary absent case", () => {
    // `model` is optional on every send; a warning per turn would train people to ignore the log.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    safeModelId(undefined);
    safeModelId("");
    expect(warn).not.toHaveBeenCalled();
  });

  it("isSafeModelId agrees with safeModelId", () => {
    for (const v of ["sonnet", "a b", "", null, "amazon-nova-pro-v1:0"]) {
      expect(isSafeModelId(v)).toBe(safeModelId(v) !== undefined);
    }
  });
});

describe("every path that sends a model id validates it", () => {
  const read = (rel: string) => {
    return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*\/\/.*$/gm, " ");
  };

  it("⚠ no handler passes a raw params.model onward", () => {
    /**
     * Counted rather than spot-checked: one missed call site is the whole vector back, and it would be
     * the least-used path. Three handlers take a model — the spawn path, the ACP path, and the SDK path.
     */
    for (const file of [
      "./handlers/cli-assistant.ts",
      "./handlers/kiro-acp.ts",
      "./handlers/claude-code.ts",
    ]) {
      const code = read(file);
      const raw = code.match(/params\.model/g) ?? [];
      const guarded = code.match(/safeModelId\(params\.model\)/g) ?? [];
      expect(raw.length, `${file}: every params.model must be wrapped`).toBe(guarded.length);
    }
  });

  it("the ACP path compares and stores the VALIDATED value", () => {
    // Comparing against an id we were going to drop would respawn the client for nothing.
    const acp = read("./handlers/kiro-acp.ts");
    expect(acp).toContain("const requestedModel = safeModelId(params.model)");
    expect(acp).toMatch(/ensureClient\(event, params\.sessionId, projectPath, requestedModel\)/);
  });
});
