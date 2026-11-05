import { describe, it, expect } from "vitest";
import { parseChatOptions } from "./option-buttons";

describe("parseChatOptions", () => {
  it("parses the canonical Approve/Edit/Reject block", () => {
    const content = `How would you like to proceed?

Approve — birth the intent with the feature scope and start the workflow.
Edit the grid — tell me which stages to flip to SKIP (e.g. drop the operation phase), and I'll re-present.
Reject — stop; you can name a scope directly instead.
I'll wait for your explicit choice before writing anything or starting.`;

    const opts = parseChatOptions(content);
    expect(opts.map((o) => o.label)).toEqual(["Approve", "Edit the grid", "Reject"]);
    expect(opts[0].description).toContain("birth the intent");
  });

  it("ignores a trailing prose sentence (no dash)", () => {
    const opts = parseChatOptions(
      `Yes — go ahead.\nNo — cancel it.\nThis last line is just prose without a separator.`
    );
    expect(opts.map((o) => o.label)).toEqual(["Yes", "No"]);
  });

  it("accepts numbered and bulleted markers", () => {
    const opts = parseChatOptions(
      `1. Approve — do it now\n2. Reject — stop here`
    );
    expect(opts.map((o) => o.label)).toEqual(["Approve", "Reject"]);
  });

  it("handles spaced-hyphen and en-dash separators", () => {
    const opts = parseChatOptions(`Keep - retain the file\nDelete – remove the file`);
    expect(opts.map((o) => o.label)).toEqual(["Keep", "Delete"]);
  });

  it("strips markdown emphasis from labels", () => {
    const opts = parseChatOptions(`**Approve** — go\n**Reject** — no`);
    expect(opts.map((o) => o.label)).toEqual(["Approve", "Reject"]);
  });

  it("returns nothing for a single option (needs >= 2)", () => {
    expect(parseChatOptions(`Approve — just one option here`)).toEqual([]);
  });

  it("returns nothing for ordinary prose with dashes", () => {
    const content = `The trade-off — as noted — is latency.\nWe measured 30-40ms in practice.`;
    // First line's label "The trade" is >... actually starts uppercase & short,
    // but the second line has no valid separator, so no run of >= 2 forms.
    expect(parseChatOptions(content)).toEqual([]);
  });

  it("rejects labels that are too long (a full sentence with a dash)", () => {
    const content =
      `This is clearly a long explanatory sentence that happens to contain — a dash.\nAnother equally long sentence that also contains — a dash somewhere in it.`;
    expect(parseChatOptions(content)).toEqual([]);
  });

  it("does not match bare hyphens inside words/paths", () => {
    const opts = parseChatOptions(`Edit src/main-process/index.ts\nRun the build-step now`);
    expect(opts).toEqual([]);
  });

  it("de-duplicates repeated labels", () => {
    const opts = parseChatOptions(`Approve — a\nApprove — b\nReject — c`);
    expect(opts.map((o) => o.label)).toEqual(["Approve", "Reject"]);
  });

  it("returns [] for empty input", () => {
    expect(parseChatOptions("")).toEqual([]);
  });
});
