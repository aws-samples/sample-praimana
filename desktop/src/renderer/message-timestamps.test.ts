// ── ⚠ MESSAGE TIMES: PRESENT EVERYWHERE, AND READ AS UTC ─────────────────────────────────
//
// Two defects behind one question:
//
//   1. The Codex bubbles and every assistant reply never rendered a time at all. `created_at` has been on
//      the row since the baseline schema (`NOT NULL DEFAULT (datetime('now'))`) — the markup was missing,
//      not the data.
//   2. ⚠ THE TIMES THAT DID RENDER WERE AN HOUR OUT. SQLite writes UTC with no zone marker and V8 reads
//      that as local. This is the half worth testing hardest, because it is silent: it is invisible at
//      UTC+0 and wrong everywhere else.

/**
 * ⚠ PINNED TO A FIXED-OFFSET ZONE, BEFORE THE MODULE IS IMPORTED.
 *
 * Without this the timezone case is VACUOUS on a UTC runner: the broken reading and the correct one agree
 * at offset 0, so the assertion would pass against the bug it exists to catch. Asia/Kolkata is +05:30 with
 * no DST, so the two readings can never coincide in any month.
 */
process.env.TZ = "Asia/Kolkata";

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatMessageInstant, formatClock, parseStoredInstant } from "./lib/instants";

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const read = (...p: string[]) => strip(readFileSync(join(__dirname, ...p), "utf8"));

const chatView = read("components", "AssistantChatView.tsx");
const kiro = read("components", "KiroChatView.tsx");
const teamChat = read("components", "TeamChatView.tsx");
const gitPanel = read("components", "GitPanel.tsx");

describe("⚠ a stored timestamp is UTC even when it does not say so", () => {
  /**
   * ⚠ THE GUARD THAT KEEPS THE REST OF THIS BLOCK HONEST. If the pin above ever stops taking effect, the
   * timezone assertions below quietly stop proving anything — they would pass on correct AND broken code.
   * Better to fail here, loudly, than to keep a green test that measures nothing.
   */
  it("really is running off UTC, or the cases below prove nothing", () => {
    expect(new Date("2026-08-14T12:00:00Z").getTimezoneOffset(), "TZ pin did not take").not.toBe(0);
  });

  /** SQLite's `datetime('now')` shape: space-separated, no `Z`. The exact string this app stores. */
  it("reads SQLite's zone-less output as UTC, not as local", () => {
    expect(parseStoredInstant("2026-08-14 20:13:58").getTime()).toBe(
      Date.UTC(2026, 7, 14, 20, 13, 58)
    );
  });

  /** The same instant written both ways must be the same instant. This is the whole defect, stated once. */
  it("agrees with the explicit UTC spelling of the same moment", () => {
    expect(formatMessageInstant("2026-08-14 20:13:58")).toBe(
      formatMessageInstant("2026-08-14T20:13:58Z")
    );
  });

  /**
   * ⚠ AND THE FIX MUST NOT REACH SERVER TIMESTAMPS. The team and ai services stamp
   * `new Date().toISOString()`, which already carries `Z`; appending another zone would introduce the very
   * error this removes. Team chat was never affected for exactly this reason.
   */
  it("leaves a string that already carries a zone completely alone", () => {
    for (const iso of [
      "2026-08-14T20:13:58.123Z",
      "2026-08-14T20:13:58Z",
      "2026-08-14T20:13:58+02:00",
      "2026-08-14T20:13:58-05:00",
    ]) {
      expect(parseStoredInstant(iso).getTime(), iso).toBe(Date.parse(iso));
    }
  });

  /** A bare `T` with no zone is the same ambiguity as the space form, and gets the same treatment. */
  it("treats a zone-less T form as UTC too", () => {
    expect(parseStoredInstant("2026-08-14T20:13:58").getTime()).toBe(
      Date.UTC(2026, 7, 14, 20, 13, 58)
    );
  });

  /** Absent or unparseable renders NOTHING, never "Invalid Date". */
  it("returns null rather than a broken string", () => {
    for (const bad of [undefined, null, "", "not a date"]) {
      expect(formatMessageInstant(bad), String(bad)).toBeNull();
      expect(formatClock(bad), String(bad)).toBeNull();
    }
  });

  /** The clock-only variant shares the parse, or it would keep the bug on its own. */
  it("applies the same parse to the clock-only form", () => {
    expect(formatClock("2026-08-14 20:13:58")).toBe(formatClock("2026-08-14T20:13:58Z"));
  });
});

describe("⚠ every AI message carries its time now", () => {
  /**
   * ⚠ ASSERTED PER ROLE, because the gap was ROLE-SHAPED: the Claude/Kiro user box had a time and the
   * assistant's reply did not, and the Codex branch had neither. A file-level "contains a timestamp" check
   * passed throughout the entire bug.
   */
  it("stamps the codex bubble for both roles", () => {
    /* The user's own line, inside the bubble. */
    expect(chatView).toMatch(
      /msg\.role === "user" && formatMessageInstant\(msg\.created_at\)/
    );
    /* And the assistant's, in the footer that already exists for copy and tokens. */
    const at = chatView.indexOf("<MessageTokens input={msg.input_tokens}");
    expect(at, "the codex assistant footer must exist").toBeGreaterThan(-1);
    expect(
      chatView.slice(at, chatView.indexOf("</div>", at)),
      "the codex assistant footer needs the time"
    ).toContain("formatMessageInstant(msg.created_at)");
  });

  it("stamps the claude timeline reply, where only the question was stamped before", () => {
    const at = chatView.indexOf('label="Copy reply"');
    expect(at).toBeGreaterThan(-1);
    expect(
      chatView.slice(at, chatView.indexOf("</div>", at)),
      "the reply footer needs the time"
    ).toContain("formatMessageInstant(msg.created_at)");
  });

  it("stamps both of kiro's shapes", () => {
    expect([...kiro.matchAll(/formatMessageInstant\(message\.created_at\)/g)].length, "user and reply")
      .toBeGreaterThanOrEqual(2);
  });

  /**
   * ⚠ THE TYPE ALONE WOULD HAVE COMPILED AND SHOWN NOTHING. Kiro's loader hand-picks columns from a
   * `SELECT *`, which is precisely how it lost `sync_status` once already — so the mapping is asserted
   * separately from the field. Dropping either line reproduces a silent blank.
   */
  it("carries created_at through kiro's hand-written row mapping", () => {
    expect(kiro, "the field is declared").toMatch(/created_at\?: string/);
    expect(kiro, "and the mapping keeps it").toMatch(/created_at: m\.created_at/);
  });

  /**
   * ⚠ TEAM CHAT NEEDS THE DAY, AND IT HAS NO GROUPING TO FALL BACK ON.
   *
   * The portal's chat page renders a `formatDate` separator per day, so a bare clock under each bubble is
   * unambiguous THERE. This list is flat — nothing else on screen says which day — so the stamp itself has to
   * carry it.
   *
   * Asserted as "uses the shared helper" rather than "contains a date", because the failure mode was a
   * locally-correct-looking `toLocaleTimeString` call: any test that merely looked for a timestamp passed
   * throughout the bug.
   */
  it("gives team chat a DAY SEPARATOR, since a bare clock was the defect", () => {
    /* The separator's label — the only place the day is stated on this surface. */
    expect(teamChat, "team chat must derive a day label").toMatch(
      /messageDayLabel\(msg\.createdAt, new Date\(\), \{ weekday: true \}\)/
    );
    /* And it must only appear when the day actually changed, or every message gets one. */
    expect(teamChat, "the label is gated on the day changing").toMatch(/dayChanged\s*\?/);
    expect(teamChat, "and the change is a calendar-day comparison of the PREVIOUS message").toMatch(
      /parseStoredInstant\(prev\.createdAt\)\.toDateString\(\)/
    );
    /* Per-message stamps are the clock only, because the separator carries the day. */
    expect(teamChat, "each bubble keeps its clock").toMatch(/formatClock\(msg\.createdAt\)/);
    /* Everything comes from the shared module — no fifth hand-rolled copy. */
    expect(teamChat, "must import the rule rather than re-implement it").toMatch(
      /from "\.\.\/lib\/instants"/
    );
    expect(teamChat, "a hand-rolled clock is what this replaced").not.toMatch(/toLocaleTimeString/);
  });

  /**
   * ⚠ THE FOURTH COPY. GitPanel's `formatCommitInstant` tested only `>= startOfToday`, so it could say
   * "Today" and NEVER "Yesterday" — a commit and a chat message from the same minute yesterday were
   * labelled differently in two panes of one window. Asserted as "delegates" rather than "produces the
   * right string" because the defect was a second implementation, not a wrong output.
   */
  it("leaves GitPanel with no date arithmetic of its own", () => {
    expect(gitPanel, "must delegate to the shared rule").toMatch(
      /formatMessageInstant\(iso\)/
    );
    for (const banned of [/startOfToday/, /setHours\(0, 0, 0, 0\)/, /toLocaleDateString/, /toLocaleTimeString/]) {
      expect(gitPanel, `GitPanel must not re-implement the rule (${banned})`).not.toMatch(banned);
    }
  });

  /**
   * ⚠ NOBODY PARSES A DATE BY HAND ANY MORE. The history list's `new Date(session.updated_at)` carried the
   * identical hour-out bug in a second file — one shared helper is what stops it coming back a third time.
   */
  it("leaves no raw Date parsing of a stored column", () => {
    for (const [name, src] of [
      ["AssistantChatView", chatView],
      ["KiroChatView", kiro],
      /**
       * ⚠ ADDED AFTER THIS GUARD MISSED THE THIRD COPY. TeamChatView was absent from this list and
       * held `new Date(msg.createdAt).toLocaleTimeString(...)` — so the suite was green while the
       * defect (a message posted on an earlier day showed only its time) was live in a file the rule
       * simply did not cover. A guard that names its subjects has to name all of them.
       */
      ["TeamChatView", teamChat],
    ] as const) {
      expect(src, `${name} must not parse a stored timestamp itself`).not.toMatch(
        /new Date\((session|msg|message|thread)\.[a-zA-Z_]*(_at|At)\)/
      );
    }
  });
});

describe("⚠ the user's time sits BELOW the box, not inside it", () => {
  /**
   * ⚠ COUNTED, NOT GUESSED. "Outside the bubble" is a STRUCTURAL claim, and every cheap proxy for it passes
   * while the stamp is still inside: it is after the message text either way, and there is a `</div>` between
   * them either way (the assistant footer contributes one). So this walks the div balance from the bubble's
   * own opening tag to the stamp — if the bubble closed first, opens and closes are equal; if the stamp is
   * still within it, the bubble's own `<div` is unmatched and opens exceed closes.
   */
  const balanceFromBubble = (src: string, bubbleClass: string, stamp: string) => {
    const cls = src.indexOf(bubbleClass);
    expect(cls, `bubble (${bubbleClass}) must exist`).toBeGreaterThan(-1);
    const from = src.lastIndexOf("<div", cls);
    const to = src.indexOf(stamp, from);
    expect(to, `stamp (${stamp}) must follow the bubble`).toBeGreaterThan(from);
    const seg = src.slice(from, to);
    return {
      opens: (seg.match(/<div\b/g) ?? []).length,
      closes: (seg.match(/<\/div>/g) ?? []).length,
    };
  };

  it("closes the codex bubble before stamping it", () => {
    const { opens, closes } = balanceFromBubble(
      chatView,
      "relative max-w-full rounded-lg",
      'className="mt-0.5 text-[10px] tabular-nums'
    );
    expect(closes, "the bubble is still open, so the stamp is INSIDE it").toBe(opens);
  });

  it("closes kiro's bubble before stamping it", () => {
    const { opens, closes } = balanceFromBubble(
      kiro,
      "relative max-w-full rounded-xl",
      'className="mt-0.5 text-[10px] tabular-nums'
    );
    expect(closes, "the bubble is still open, so the stamp is INSIDE it").toBe(opens);
  });

  /**
   * ⚠ THE WIDTH CAP HAD TO MOVE WITH IT. A percentage on the bubble resolves against the row; a stamp that is
   * a SIBLING of the bubble cannot be bounded by the bubble at all. Leaving `max-w-[75%]` on the bubble and
   * adding a wrapper without one lets a long message push the column full width.
   */
  it("caps the column, not the bubble", () => {
    expect(chatView, "codex column").toMatch(/flex max-w-\[75%\] flex-col items-end/);
    expect(kiro, "kiro column").toMatch(/flex max-w-\[80%\] flex-col items-end/);
  });

  /**
   * ⚠ AND THE INK FOLLOWS THE SURFACE, which is the point of moving it. tailwind.config.ts forbids `faint`
   * on `raised` (3.33:1) — so INSIDE the bubble it had to be `white/70`. On the transcript background `faint`
   * is 5.73:1 and is what every other timestamp uses. White ink out here would be the wrong choice twice
   * over: inconsistent, and needlessly loud for a secondary label.
   */
  it("uses faint ink now that it is on the page", () => {
    for (const [name, src] of [["AssistantChatView", chatView], ["KiroChatView", kiro]] as const) {
      const at = src.indexOf('className="mt-0.5 text-[10px] tabular-nums');
      expect(src.slice(at, at + 130), `${name} stamp ink`).toContain("text-surface-faint");
      expect(src.slice(at, at + 130), `${name} must not keep the in-bubble ink`).not.toContain("text-white/70");
    }
  });
});

// ── ⚠ A MESSAGE YOU JUST SENT HAS A TIME TOO ─────────────────────────────────────────────
//
// ⚠ THE MARKUP WAS NEVER THE PROBLEM. Both views build messages in the RENDERER and append them straight to
// state: Kiro for the participant's message AND the assistant's reply, AssistantChatView for the participant's. Those
// objects had no `created_at`, so `formatMessageInstant` returned null and the row rendered no time until a
// session switch re-read the list from SQLite. Adding the field to the component's TYPE and its DB mapping —
// which I did — fixes the reload path only.
describe("⚠ messages appended in the renderer carry a timestamp", () => {
  it("stamps kiro's own message and its reply", () => {
    const appends = [...kiro.matchAll(/const (userMsg|msg): ChatMessage = \{[\s\S]{0,400}?\};/g)];
    expect(appends.length, "both the user's and the assistant's").toBeGreaterThanOrEqual(2);
    for (const [block] of appends) {
      expect(block, "every renderer-built message needs a time").toContain("created_at:");
    }
  });

  it("stamps the message chatview appends on send", () => {
    expect(chatView).toMatch(/created_at: new Date\(\)\.toISOString\(\)/);
  });

  /**
   * ⚠ THE STAMP MUST NOT REACH THE DB PAYLOAD. `chat_messages.created_at` is written by SQLite as
   * `2026-08-14 20:13:58` — space-separated, no zone — and EIGHT queries order by that column AS A STRING.
   * For the same day `' '` (0x20) sorts before `'T'` (0x54), so one ISO value would sort after every
   * space-form row of that day and silently reorder a transcript. `db:addMessage` picks its four fields by
   * name so nothing leaks today; this pins the SHAPE that keeps it that way.
   */
  it("keeps the rendered copy separate from the row that is inserted", () => {
    const at = chatView.indexOf("await api.addMessage(userMsg);");
    expect(at, "the insert call must exist").toBeGreaterThan(-1);
    expect(
      chatView.slice(at, at + 200),
      "the stamp is spread onto a COPY, never onto the payload"
    ).toMatch(/\{ \.\.\.userMsg, created_at:/);

    /* And the object handed to the DB has no timestamp of its own. */
    const decl = chatView.slice(chatView.indexOf("const userMsg = {"));
    expect(decl.slice(0, decl.indexOf("};")), "the payload stays clean").not.toContain("created_at");
  });
});
