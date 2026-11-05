// ── ⚠ A DISPLAY NAME IS NOT AN IDENTITY ────────────────────────────────────────────────────────
//
// `TeamChatView` decided whether a message belonged to the viewer with
// `msg.sender?.name === userId || msg.sender?.id === userId`. `sender.name` is whatever another
// participant's profile says; `userId` was the Cognito `sub` or, when that was unset, the user's
// e-mail address. So a teammate who set their display name to the victim's `sub` (or e-mail) had every
// message they posted render in the victim's client as the victim's OWN — right-aligned in the "mine"
// bubble, with the sender name and avatar suppressed entirely, because those render only under
// `{!isMe && …}`. The victim had no way in the UI to see who really sent it, and the value needed is
// not secret to teammates: `board:getBoard` hands every member's record to every other member.
//
// ── WHY SOURCE ASSERTIONS ──
//
// Same convention as chat-view-parity.test.ts and view-theme.test.ts: the view needs the `electronAPI`
// bridge, a polling interval and a team to render, while the property here is a fact about ONE
// expression. Asserting it against the source is what makes it cheap enough to keep.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Comments stripped, because this file's own prose contains the defective expression. */
const strip = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const SRC = strip(readFileSync(join(__dirname, "components", "TeamChatView.tsx"), "utf8"));

describe("team chat decides ownership from identity, not from a name", () => {
  it("⚠ does NOT compare a sender's display name against the viewer", () => {
    expect(SRC, "a profile name is attacker-chosen; it cannot decide whose message this is").not.toMatch(
      /sender\?\.name\s*===\s*userId/
    );
  });

  it("compares the sender id, and only after checking there is one to compare", () => {
    /**
     * `!!userId &&` matters: without it an install carrying no `user_id` would match every message
     * whose sender id is also empty, which is the same defect with an empty string as the key.
     */
    expect(SRC).toMatch(/const isMe = !!userId && msg\.sender\?\.id === userId/);
  });

  /**
   * ⚠ AND THE VIEWER'S KEY IS THE `sub`, NOT THEIR E-MAIL. The fallback `storedUserId || email` made
   * an address an identity, so a display name equal to the victim's e-mail was enough — no `sub`
   * needed. `sender.email` is not what the comparison reads, so the e-mail has no business here.
   */
  it("⚠ does not fall back to the e-mail address as an identity", () => {
    expect(SRC).not.toMatch(/setUserId\(\s*storedUserId\s*\|\|\s*email\s*\)/);
    expect(SRC).toMatch(/setUserId\(\(await api\.getSetting\("user_id"\)\) \|\| ""\)/);
  });

  /**
   * ⚠ THE SECOND ATTRIBUTION DEFECT, from the same conflation. A response carrying neither `sender`
   * nor `userId` says nothing about who sent it; the fallback labelled it "You" — asserting the one
   * thing that cannot be inferred.
   */
  it('⚠ never labels an unattributable message "You"', () => {
    expect(SRC).not.toMatch(/name:\s*"You"/);
  });
});
