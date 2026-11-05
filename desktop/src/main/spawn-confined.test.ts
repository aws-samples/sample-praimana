import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "os";

// Mock project-paths so we control which dirs count as "inside a project".
//
// ⚠ `isRealPathWithinProject`, not `isWithinProject`. confineCwd used the LEXICAL check, which a
// symlink inside an open project defeats — so every agent spawned through here could run with a
// working directory outside the project. The confinement logic itself is tested in
// project-paths.test.ts; what matters here is which predicate confineCwd asks, and that it still
// falls back to $HOME rather than throwing.
const mockIsWithin = vi.fn<(p: string, o?: unknown) => boolean>();
vi.mock("./project-paths", () => ({
  isRealPathWithinProject: (p: string, o?: unknown) => mockIsWithin(p, o),
}));

import { confineCwd } from "./spawn-confined";

describe("confineCwd (EA-H4: spawn cwd confinement invariant)", () => {
  beforeEach(() => mockIsWithin.mockReset());

  it("keeps a cwd that is inside an open project", () => {
    mockIsWithin.mockReturnValue(true);
    expect(confineCwd("/Users/dev/proj/sub")).toBe("/Users/dev/proj/sub");
  });

  /**
   * ── ⚠ IT REFUSES; IT DOES NOT FALL BACK TO `$HOME` ──
   *
   * These assertions were the opposite way round, and the implementation's comment called `$HOME`
   * "the conservative answer". It is the maximally permissive one — `project-paths.ts` refuses `$HOME`
   * as a project root precisely because "a project root that wide hands every file handler the user's
   * credentials", and this function then handed that directory to a spawned agent.
   *
   * It matters most here: the one caller runs its agent with `--trust-all-tools` while
   * `cli:permission-respond` takes approve/deny FROM THE RENDERER, so a compromised renderer could
   * pass a nonexistent path, land the no-prompt agent in `$HOME`, and self-approve what followed.
   */
  it("REFUSES a cwd outside any project rather than redirecting to $HOME", () => {
    mockIsWithin.mockReturnValue(false);
    expect(() => confineCwd("/etc")).toThrow(/not inside an open project folder/i);
  });

  it("never returns the home directory, for any unusable input", () => {
    mockIsWithin.mockReturnValue(false);
    for (const bad of ["/etc", "/", os.homedir(), "/nope"]) {
      let returned: string | undefined;
      try {
        returned = confineCwd(bad);
      } catch {
        returned = undefined;
      }
      expect(returned, bad).not.toBe(os.homedir());
    }
  });

  it("REFUSES empty / null / undefined", () => {
    mockIsWithin.mockReturnValue(false);
    expect(() => confineCwd("")).toThrow(/not inside an open project folder/i);
    expect(() => confineCwd(undefined)).toThrow(/not inside an open project folder/i);
    expect(() => confineCwd(null)).toThrow(/not inside an open project folder/i);
  });

  it("never asks project-paths about empty input (short-circuits)", () => {
    // The `requested &&` guard still comes first, so an empty string is refused without a
    // filesystem check.
    expect(() => confineCwd("")).toThrow();
    expect(mockIsWithin).not.toHaveBeenCalled();
  });

  it("the refusal is a message a user can act on", () => {
    // It surfaces through kiroAcp:start's catch as `{ error }`, so it is read by a person.
    mockIsWithin.mockReturnValue(false);
    expect(() => confineCwd("/etc")).toThrow(/open the project again|pick a different folder/i);
  });

  it("asks the REALPATH predicate, and requires the directory to exist", () => {
    // Pins the guard choice itself. The lexical variant is blind to a symlink pointing out of the
    // project, and a cwd that does not exist is not a cwd — `spawn` would fail with ENOENT, so it is
    // refused along with every other unusable value.
    mockIsWithin.mockReturnValue(true);
    confineCwd("/Users/dev/proj/sub");
    expect(mockIsWithin).toHaveBeenCalledWith("/Users/dev/proj/sub", { mustExist: true });
  });
});
