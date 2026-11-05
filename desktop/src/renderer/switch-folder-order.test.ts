// ── ⚠ THE ORDER OF THE FOLDER SWITCH, WHICH IS THE WHOLE CORRECTNESS OF IT ──────────────────
//
// `handleSwitchFolder` has no return value, so nothing here can be tested through its result. What
// broke was purely SEQUENCE: `allowedRoots()` (main/project-paths.ts) is built from the
// `project_path` setting plus the `projects` rows, and the function called two CONFINED handlers
// against the newly picked folder before either of them named it —
//
//   files:getProjectInfo   assertWithinProject       → threw; the switch died in its own catch
//   framework:check        isRealPathWithinProject   → `{installed: true, skipped: true}`, read by
//                                                      the caller as "already set up", so the
//                                                      framework silently never installed
//
// — which is invisible in a diff and cost the app every folder switch. These assertions pin the
// ordering so it cannot drift back. Asserted against the source for the same reason
// `file-tabs-wiring.test.ts` is: the bug lives in the wiring, not in a helper with a return value.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const app = strip(readFileSync(join(__dirname, "App.tsx"), "utf8"));

/**
 * One function's source, bounded EXPLICITLY at both ends.
 *
 * `performSwitch` is declared immediately after `handleSwitchFolder`, so an end marker of "whatever
 * follows" would put the whole switch body inside the picker's slice — and the assertion that the
 * picker commits nothing would pass while reading the wrong function.
 */
function sliceBetween(startMarker: string, endMarker: string): string {
  const start = app.indexOf(startMarker);
  expect(start, `${startMarker} still exists`).toBeGreaterThan(-1);
  const end = app.indexOf(endMarker, start + startMarker.length);
  expect(end, `${endMarker} still follows ${startMarker}`).toBeGreaterThan(start);
  return app.slice(start, end);
}

/**
 * The body of `performSwitch` alone — the half that mutates. Every ordering assertion below is
 * about calls WITHIN it, so a matching call elsewhere in App.tsx must not be able to satisfy one.
 */
const body = sliceBetween("async function performSwitch", "useEffect");

/** The picker half, which must park its result rather than acting on it. */
const picker = sliceBetween("async function handleSwitchFolder", "async function performSwitch");

/** Index of a call inside the switch body; -1 becomes a failure rather than a silent 0. */
function at(pattern: RegExp): number {
  const m = body.match(pattern);
  expect(m, `${pattern} appears in handleSwitchFolder`).not.toBeNull();
  return m!.index!;
}

describe("⚠ nothing is granted or replaced before the user confirms", () => {
  /**
   * The picker records provenance in main, which makes the folder GRANTABLE. Granting it is a
   * separate decision, and this is the assertion that keeps the two apart.
   */
  it("parks the picked folder instead of switching to it", () => {
    expect(picker, "the path goes into pending state").toMatch(/setPendingFolder\(dirPath\)/);
    for (const call of [
      /api\.commitProjectPath\(/,
      /api\.addProject\(/,
      /api\.removeProject\(/,
      /api\.frameworkInstall\(/,
      /api\.cliStop\(/,
    ]) {
      expect(picker, `${call} must not run before the confirmation`).not.toMatch(call);
    }
  });

  /** The confirm handler is the ONLY thing that starts the switch. */
  it("runs the switch from the dialog's confirm", () => {
    expect(app).toMatch(/onConfirm=\{\(\) => \{[\s\S]*?void performSwitch\(chosen\)/);
  });

  /**
   * ⚠ CLEARED BEFORE THE AWAIT, NOT AFTER IT. `performSwitch` awaits a framework install that can
   * run an agent for minutes; a dialog left up for the duration reads as "nothing happened" and
   * invites a second click on an action that is already in flight.
   */
  it("closes the dialog before the switch begins", () => {
    const handler = app.slice(app.indexOf("onConfirm={() =>"));
    expect(handler.indexOf("setPendingFolder(null)")).toBeLessThan(
      handler.indexOf("performSwitch(chosen)")
    );
  });
});

describe("⚠ the new folder is granted before anything reads it", () => {
  /**
   * The one assertion that would have caught the reported error. `commitProjectPath` is what puts
   * the chosen folder inside `allowedRoots()`, and `files:getProjectInfo` is confined by it.
   */
  it("commits the project path before asking main about the folder", () => {
    expect(at(/api\.commitProjectPath\(/)).toBeLessThan(at(/api\.getProjectInfo\(/));
  });

  /**
   * Same reason, different handler — and this is the one that failed SILENTLY, so it is the one a
   * future edit is most likely to reorder without noticing.
   */
  it("commits the project path before the framework check", () => {
    expect(at(/api\.commitProjectPath\(/)).toBeLessThan(at(/api\.frameworkCheck\(/));
  });

  /**
   * ⚠ NOT `addProject` FIRST. A `projects` row grants the folder too, but `db:addProject` answers
   * with the EXISTING row when one matches the path instead of updating it, so a placeholder row
   * inserted before `getProjectInfo` could never take the name that call returns.
   */
  it("registers the project row after the name is known", () => {
    expect(at(/api\.getProjectInfo\(/)).toBeLessThan(at(/api\.addProject\(/));
  });

  /** The CLI/ACP session is stopped before the cwd moves under it, not after. */
  it("stops the running assistant before switching", () => {
    expect(at(/api\.cliStop\(/)).toBeLessThan(at(/api\.commitProjectPath\(/));
  });
});

describe("⚠ the previous project is revoked without revoking the new one", () => {
  /**
   * The rows to delete are read BEFORE the insert. Reading them after would put the row this
   * switch just created into the list the cleanup walks.
   */
  it("reads the existing projects before adding the new one", () => {
    expect(at(/api\.getProjects\(/)).toBeLessThan(at(/api\.addProject\(/));
  });

  /**
   * ⚠ RE-PICKING THE FOLDER THAT IS ALREADY OPEN IS THE CASE THAT BITES. `db:addProject` returns
   * the matching row's id rather than the fresh uuid, so an unguarded "delete everything I saw
   * earlier" loop deletes the row for the folder being switched TO — revoking the access the
   * switch just granted.
   */
  it("keeps the active row when clearing the old ones", () => {
    const loop = body.slice(body.indexOf("for (const p of existing)"));
    expect(loop, "the cleanup loop skips the active project").toMatch(
      /if \(p\.id !== project\.id\)\s*await api\.removeProject\(p\.id\)/
    );
  });

  /**
   * The id the UI adopts is main's answer, not the locally minted one — `proposed` goes in,
   * `project` is what comes back out and what every later line uses.
   */
  it("adopts the row main returned", () => {
    expect(body).toMatch(/const added = await api\.addProject\(proposed\)/);
    expect(body, "the returned row wins when one already existed").toMatch(
      /const project = added\?\.id \?/
    );
  });

  /**
   * ⚠ THIS ASSERTION WAS THE OPPOSITE ONE, AND THE REASON IT FLIPPED IS THE FIX BELOW.
   *
   * It used to require revocation AFTER the framework step, on the grounds that everything above it
   * might still read the folder being left. That held only while the UI swap also came last — and the
   * UI swap coming last is what made an approved switch look like it had never happened. Once the tabs
   * pointing into the old folder are closed at the swap, nothing downstream reads it, so revocation
   * belongs with the swap rather than minutes later behind an install.
   *
   * What still matters is that it follows `addProject`: the loop skips the active row by id, and that
   * id is only known once main has answered.
   */
  it("clears the old rows once the new row exists, not before", () => {
    expect(at(/api\.addProject\(/)).toBeLessThan(at(/for \(const p of existing\)/));
  });
});

/**
 * ── ⚠ THE SYMPTOM THAT LOOKED LIKE A FAILED SWITCH ────────────────────────────────────────────
 *
 * Nothing threw. `framework:install` downloads a distribution, extracts it, copies it in and then runs
 * an assistant turn in the folder — bounded in main at 120s + 60s + 120s — and `setActiveProject` sat
 * AFTER all of it. The switch was already committed to the database; for up to five minutes every
 * visible surface disagreed, which is indistinguishable from "the button did nothing".
 */
describe("⚠ the screen switches as soon as the project row exists", () => {
  it("swaps the active project BEFORE the framework step", () => {
    expect(at(/setActiveProject\(project\)/)).toBeLessThan(at(/api\.frameworkCheck\(/));
  });

  it("prunes the tabs before it too, so no editor points into the closed folder", () => {
    expect(at(/closeTabsOutside\(prev, project\.path\)/)).toBeLessThan(
      at(/api\.frameworkCheck\(/)
    );
  });

  /**
   * The setup agent is a CLI run in this folder. Trusting the workspace afterwards is too late for the
   * one process that most needs it — an untrusted workspace makes the CLI discard `permissions.allow`
   * and prompt for tools mid-setup, in a pane nobody is watching.
   */
  it("trusts the workspace before an agent is run in it", () => {
    expect(at(/api\.cliTrustWorkspace\(/)).toBeLessThan(at(/api\.frameworkCheck\(/));
  });
});

/**
 * ── ⚠ AND THE APP IS BLOCKED WHILE THAT AGENT WRITES ──────────────────────────────────────────
 *
 * The consequence of switching the screen early: the participant is looking at a project whose files
 * are being created underneath them. The overlay is what stops them opening a file the agent is about
 * to overwrite, messaging the assistant while a second CLI process holds the same working tree, or
 * switching folders again mid-install.
 */
describe("⚠ the setup agent runs behind a blocker", () => {
  it("raises the blocker around the install", () => {
    expect(at(/setFrameworkSetup\(check\.name\)/)).toBeLessThan(at(/api\.frameworkInstall\(/));
  });

  /**
   * ⚠ IN `finally`, NOT AFTER THE AWAIT. The overlay has no dismiss control of its own, so this is the
   * only thing that takes it down — it has to survive a REJECTED invoke, not merely a returned
   * `{ error }`. Anything else strands the app behind a modal with no way out.
   */
  it("clears it in a finally, so a rejected invoke cannot strand the app", () => {
    const branch = body.slice(at(/setFrameworkSetup\(check\.name\)/), at(/\} catch \(err\)/));
    expect(branch).toMatch(/\} finally \{[\s\S]*?setFrameworkSetup\(null\)/);
  });
});

describe("⚠ the framework step reports what it did", () => {
  /**
   * `skipped` carries the only distinction between "no config on the server", "no config for this
   * assistant" and "not signed in to a workshop". The first-run screen has always shown it; this
   * path dropped it, so a participant whose framework never installed had nothing to go on.
   */
  it("surfaces a skipped check to the user", () => {
    const branch = body.slice(at(/if \(check\.skipped\)/), at(/else if \(!check\.installed\)/));
    expect(branch, "the reason reaches a toast").toMatch(/toast\.\w+\([^)]*check\.reason/s);
  });

  /**
   * ⚠ A FAILED INSTALL MUST NOT ABORT THE SWITCH. `framework:install` copies the distribution into
   * the folder before it can fail, so the early `return` this used to do left the user pointed at
   * the OLD folder while the new one held a half-installed framework — undoing nothing, reporting
   * nothing, and leaving the two disagreeing.
   */
  it("does not bail out of the switch when the install fails", () => {
    /**
     * Bounded at the end of the try block rather than at `cliTrustWorkspace`: trust now runs BEFORE
     * the install (the setup agent needs it), so the old delimiter no longer follows this branch.
     */
    const branch = body.slice(at(/api\.frameworkInstall\(/), at(/\} catch \(err\)/));
    expect(branch, "the failure is reported").toMatch(/toast\.error\(/);
    expect(branch, "and the switch still completes").not.toMatch(/\breturn\b/);
  });
});

/**
 * ── ⚠ THE FOLDER IS RE-READ AFTER THE AGENT WRITES TO IT ──────────────────────────────────────
 *
 * A direct consequence of switching the screen early: the tree and the git panel list the folder as it
 * was a moment BEFORE `framework:install` copied a distribution into it and ran an agent there. Without
 * a nudge they stay stale until the participant clicks Refresh — on the one view whose whole job is to
 * show what is in the folder.
 */
describe("⚠ the folder-reading views are told to re-read", () => {
  it("bumps the signal when the install settles", () => {
    expect(body).toMatch(/setFolderRefresh\(\(n\) => n \+ 1\)/);
  });

  /**
   * ⚠ IN THE SAME `finally` AS THE BLOCKER, so it runs for a FAILED install too — and that is the case
   * that needs it most. The distribution is copied in BEFORE the step that can fail (the agent), so a
   * failure leaves real files on disk; refreshing only on success would hide exactly the half-finished
   * state somebody needs to see.
   */
  it("bumps it for a failed install as well as a successful one", () => {
    const tail = body.slice(at(/api\.frameworkInstall\(/), at(/\} catch \(err\)/));
    const finallyBlock = tail.slice(tail.indexOf("} finally {"));
    expect(finallyBlock, "the bump is inside the finally").toMatch(/setFolderRefresh\(/);
  });

  it("reaches both views that read the folder", () => {
    expect(app, "the tree, through the sidebar").toMatch(/refreshSignal=\{folderRefresh\}/);
    expect(app, "and the git panel").toMatch(
      /<GitPanel projectPath=\{activeProject\.path\} refreshSignal=\{folderRefresh\}/
    );
  });
});

/**
 * ── ⚠ AND AFTER AN ORDINARY ASSISTANT TURN, NOT ONLY AFTER THE INSTALL ────────────────────────
 *
 * `assistantBusy` already exists for the switch guard, so the whole feature is its falling edge.
 */
describe("⚠ a finished turn refreshes the folder", () => {
  const shell = app.slice(app.indexOf("const wasAssistantBusy"));

  it("fires on the falling edge, not while the turn runs", () => {
    /**
     * Refreshing while `assistantBusy` is true would re-list the tree repeatedly mid-turn — more disk
     * work for a picture that is still changing.
     */
    expect(shell).toMatch(
      /if \(wasAssistantBusy\.current && !assistantBusy\) setFolderRefresh\(\(n\) => n \+ 1\)/
    );
  });

  it("records the previous value every time, or the edge is only ever seen once", () => {
    const effect = shell.slice(0, shell.indexOf("}, [assistantBusy])"));
    expect(effect).toMatch(/wasAssistantBusy\.current = assistantBusy;/);
    expect(
      effect.indexOf("setFolderRefresh"),
      "the bump is decided before the value is overwritten"
    ).toBeLessThan(effect.indexOf("wasAssistantBusy.current = assistantBusy"));
  });

  it("watches the flag itself, so it cannot miss a transition", () => {
    expect(shell).toMatch(/\}, \[assistantBusy\]\)/);
  });
});
