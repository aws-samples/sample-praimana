// ── ⚠ THE BADGE HIDES WHEN SYNCED; THE HEADER SAYS WHAT IS OUTSTANDING ───────────────────
//
// The two halves are one change: hiding the badge on 88% of rows is only honest because the conversation now
// carries the count. Tested together for that reason.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { summariseSync, describeSync } from "./lib/sync-summary";

const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");
const read = (...p: string[]) => strip(readFileSync(join(__dirname, ...p), "utf8"));

const row = (sync_status: "pending" | "synced" | "failed" | null) => ({ sync_status });

describe("⚠ what may honestly be counted as not synced", () => {
  /**
   * ⚠ THE CENTRAL RESTRAINT. `sync_status IS NULL` means nobody recorded an outcome — rows from before
   * migration 11 — not that the push failed. One real database held 14 of them against 98 synced, so a
   * count that included them would have greeted older conversations with "14 messages not synced": a false
   * alarm about messages that almost certainly arrived. `SyncBadge` already draws this line in its wording
   * ("Sync", never "Not synced", for an unknown row); this keeps the header on the same side of it.
   */
  it("never counts an untracked row as a failure", () => {
    const s = summariseSync([row(null), row(null), row("synced")]);
    expect(s.untracked, "they are still counted, separately").toBe(2);
    expect(s.failed).toBe(0);
    expect(s.pending).toBe(0);
    expect(describeSync(s), "and they produce no claim at all").toBeNull();
  });

  it("says nothing when everything synced", () => {
    expect(describeSync(summariseSync([row("synced"), row("synced")]))).toBeNull();
  });

  it("says nothing for an empty conversation", () => {
    expect(describeSync(summariseSync([]))).toBeNull();
  });

  it("reports failures in the requested wording", () => {
    const n = describeSync(summariseSync([row("failed"), row("failed"), row("synced")]))!;
    expect(n.text).toBe("2 messages not synced");
    expect(n.tone, "a real failure is drawn as one").toBe("warn");
  });

  /** Singular, because "1 messages not synced" is the kind of thing that reads as a bug in the app. */
  it("uses the singular for one", () => {
    expect(describeSync(summariseSync([row("failed")]))!.text).toBe("1 message not synced");
  });

  /**
   * ⚠ IN-FLIGHT MESSAGES PRODUCE NO LINE, which reverses what this case asserted a moment ago.
   *
   * The badge was the loud half; a header reading "2 messages syncing" on every turn is the same fault in a
   * smaller font, and it appears the instant you press send — exactly when nobody needs telling.
   *
   * ⚠ AND IT COSTS NOTHING, which is what makes the silence honest rather than merely quieter: `pending` is
   * not a resting state. The push stamps `synced` or `failed` under a timeout, and `sync-sweep` re-pushes
   * whatever is left pending at the next start. A message that truly does not arrive becomes `failed`, and
   * that IS reported.
   */
  it("says nothing about messages still in flight", () => {
    expect(describeSync(summariseSync([row("pending"), row("pending"), row("synced")]))).toBeNull();
    expect(describeSync(summariseSync([row("pending")]))).toBeNull();
  });

  /** The count itself is still kept — it is honest data; nothing merely draws a conclusion from it. */
  it("still counts them, even though it reports nothing", () => {
    expect(summariseSync([row("pending"), row("pending")]).pending).toBe(2);
  });

  /**
   * ⚠ FAILURE IS REPORTED EVEN WHEN PENDING MESSAGES SURROUND IT. One refused message beside three in flight
   * is one problem — and the pending ones must not dilute it or mask it.
   */
  it("reports the failure among in-flight messages", () => {
    const n = describeSync(summariseSync([row("failed"), row("pending"), row("pending"), row("pending")]))!;
    expect(n.text, "the actionable count alone").toBe("1 message not synced");
    expect(n.tone).toBe("warn");
  });
});

describe("⚠ the badge is gone for synced, and ONLY for synced", () => {
  const badge = read("components", "SyncBadge.tsx");

  it("renders nothing for a synced row", () => {
    expect(badge).toMatch(/if \(shown === "synced"\) return null;/);
  });

  /**
   * ⚠ THE FAILURE MODE THAT WOULD MATTER. A change that hid `synced` and took `failed`, `pending` or the
   * untracked push down with it would remove the app's only per-message warning — and it would look identical
   * in a screenshot of a healthy conversation.
   */
  it("still offers a control for failed and untracked rows", () => {
    expect(badge, "the retry/push control survives").toContain("retryMessageSync");
    expect(badge, "failed wording").toContain("Not synced — retry");
    expect(badge, "untracked wording, claiming no failure").toContain("Not tracked — push");
    expect(badge, "failed ink, legal as words").toContain("text-tool-error-text");
  });

  /**
   * ── ⚠ A ROW'S OWN PENDING IS SILENT; A RETRY IN PROGRESS IS NOT ──
   *
   * ⚠ `result === undefined` IS LOAD-BEARING. Pressing retry sets `result` to "pending", so hiding pending
   * unconditionally would delete the button from under the pointer at the instant it was clicked — a worse
   * bug than the noise it fixes, and one that only shows up when someone actually uses the control.
   */
  it("hides a stored pending but keeps a retry in progress visible", () => {
    expect(badge).toMatch(/if \(shown === "pending" && result === undefined\) return null;/);
  });

  /**
   * ⚠ AND THE TOOLTIP MUST STAY SHORT, because the bubble does not wrap by default and is anchored to a 24px
   * icon. The untracked label was 79 characters, drawing a bubble some
   * 420px wide. Capped here so a future edit cannot quietly reintroduce it.
   */
  it("keeps every tooltip label short", () => {
    const labels = [...badge.matchAll(/"((?:Not synced|Not tracked|Syncing)[^"]*)"/g)].map((m) => m[1]);
    expect(labels.length, "the labels must be found").toBeGreaterThanOrEqual(3);
    for (const l of labels) {
      expect(l.length, `"${l}" is too long for a tooltip on a 24px icon`).toBeLessThanOrEqual(24);
    }
  });

  /** And the bubble itself cannot run away, whatever it is handed. */
  it("caps the tooltip bubble and lets it wrap", () => {
    const tip = read("components", "IconTooltip.tsx");
    expect(tip, "a width cap").toMatch(/max-w-\[\d+px\]/);
    expect(tip, "and no nowrap to defeat it").not.toContain("whitespace-nowrap");
  });

  /**
   * ⚠ AND THE CORNER RESERVATION MUST NOT FOLLOW IT. If `pr-9` became conditional on the badge, a message
   * would re-flow its text the instant its sync completed — a visible jump on every turn. Asserted on both
   * bubble views, because both reserve it.
   */
  it("keeps the corner padding reserved anyway", () => {
    for (const f of ["AssistantChatView.tsx", "KiroChatView.tsx"]) {
      expect(read("components", f), `${f} must keep the reservation`).toMatch(/pr-9/);
    }
  });
});

describe("⚠ both chat views carry the header line", () => {
  /**
   * ⚠ ASSERTED IN BOTH, because they are separate components and Kiro has been the one left behind by every
   * previous change in this area — it lost `sync_status` once and `created_at` twice. Hiding the badge there
   * without the count would leave Kiro users with no way to learn that a message failed.
   */
  it.each(["AssistantChatView.tsx", "KiroChatView.tsx"])("%s derives and renders it", (file) => {
    const src = read("components", file);
    expect(src, "from the shared helper, so the wording cannot drift").toMatch(
      /describeSync\(summariseSync\(messages\)\)/
    );
    expect(src, "and renders it").toMatch(/\{syncNotice && \(/);
    expect(src, "with the tone deciding the ink").toMatch(
      /syncNotice\.tone === "warn" \? "text-tool-error-text"/
    );
  });
});

// ── ⚠ THE BRANCH THE ICON WAS ACTUALLY COMING FROM ───────────────────────────────────────
//
// ⚠ MY FIRST TWO FIXES AIMED AT THE WRONG STATE. Hiding `synced` did nothing, and hiding `pending` did nothing
// either, because a message appended by the RENDERER carried no `sync_status` at all — and `undefined` is the
// UNTRACKED state, which draws a push control unconditionally and by design (a row from before migration 11
// has no recorded outcome, so it is offered a push rather than a reassuring tick).
//
// The message was not untracked. `db:addMessage` and Kiro's `saveMessage` both write it as `pending`; only the
// renderer's in-memory copy was silent about that. So the fix is not another hiding rule — it is the copy
// telling the truth about the row that was just written.
describe("⚠ a renderer-built message carries the status the row was written with", () => {
  const views = ["AssistantChatView.tsx", "KiroChatView.tsx"] as const;

  it.each(views)("%s appends messages as pending, not as untracked", (file) => {
    const src = read("components", file);
    const appends = [...src.matchAll(/created_at: new Date\(\)\.toISOString\(\)/g)];
    expect(appends.length, `${file} must stamp at least one append`).toBeGreaterThan(0);

    /*
      ⚠ COUNTED, NOT SPOTTED. Kiro appends TWO messages — the participant's and the assistant's — and an
      earlier round of this fixed one site and left the other, which is exactly how a bug gets reported a
      second time. Every stamped append must also carry the status.
    */
    const stamped = [...src.matchAll(/created_at: new Date\(\)\.toISOString\(\)/g)].length;
    const statused = [...src.matchAll(/sync_status: "pending"/g)].length;
    expect(statused, `${file}: every appended message needs its status`).toBeGreaterThanOrEqual(stamped);
  });

  /**
   * ⚠ AND THE UNTRACKED BRANCH MUST STAY, which is why this was not fixed by hiding it. It is the only
   * affordance for rows written before sync was tracked — and it must not
   * claim they failed, only that nothing recorded an outcome.
   */
  it("keeps the untracked push, without calling it a failure", () => {
    const badge = read("components", "SyncBadge.tsx");
    expect(badge, "the push survives for genuinely untracked rows").toContain("Not tracked — push");
    expect(badge, "and it is not dressed as a failure").not.toMatch(
      /: "Not synced[^"]*"\s*\n?\s*\}/
    );
  });
});
