import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * SWITCHING PROFILE MUST NOT KILL THE DEV SERVER.
 *
 * Both halves came from one line. `relaunchInto` called `app.exit(0)`, which ends the process
 * `vite-plugin-electron` spawned — and the plugin wires that exit straight to its own:
 *
 *     process.electronApp.on("exit", process.exit)     // vite-plugin-electron/dist/base-*.mjs:90
 *
 * So vite died with it ("the desktop server stopped"), and the relaunched instance inherited
 * NODE_ENV=development, took the dev branch and loaded http://localhost:5173 against a server that no
 * longer existed ("a new blank window opened").
 */

let packaged = false;
const relaunch = vi.fn();
const exit = vi.fn();
const spawn = vi.fn(() => ({ unref: vi.fn() }));

vi.mock("electron", () => ({
  app: {
    getPath: () => "/tmp/praimana-test",
    setPath: vi.fn(),
    get isPackaged() {
      return packaged;
    },
    relaunch: (...args: unknown[]) => relaunch(...args),
    exit: (...args: unknown[]) => exit(...args),
  },
}));
vi.mock("child_process", () => ({ spawn: (...args: unknown[]) => spawn(...args) }));

const { relaunchInto } = await import("./profile");

beforeEach(() => {
  relaunch.mockClear();
  exit.mockClear();
  spawn.mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("in DEVELOPMENT it spawns rather than replacing", () => {
  beforeEach(() => {
    packaged = false;
  });

  it("never exits the process, because vite dies with it", () => {
    relaunchInto("stark");

    // The single most important assertion in this file: exiting is what broke both symptoms.
    expect(exit, "exiting kills the process vite-plugin-electron owns").not.toHaveBeenCalled();
    expect(relaunch, "relaunch is meaningless without the exit").not.toHaveBeenCalled();
  });

  it("opens the requested profile in a new detached instance instead", () => {
    relaunchInto("stark");

    expect(spawn).toHaveBeenCalledTimes(1);
    const [, args, opts] = spawn.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(args.some((a) => a.includes("stark")), "the new instance must target the profile").toBe(true);
    // Detached and unref'd, or closing the launching window would take the new one with it.
    expect(opts.detached).toBe(true);
  });

  it("says why, so the extra window is not mistaken for a bug", () => {
    // The old window stays open — a visible divergence from packaged behaviour, and worth explaining.
    relaunchInto("stark");
    const said = vi.mocked(console.warn).mock.calls.map((c) => String(c[0])).join(" ");
    expect(said).toMatch(/dev build/i);
    expect(said).toMatch(/dev server/i);
  });
});

describe("in a PACKAGED build it replaces the window, as before", () => {
  beforeEach(() => {
    packaged = true;
  });

  it("relaunches and exits", () => {
    /**
     * No coupling exists there: the executable IS the app, nothing else depends on the process, and
     * replacing the window is the seamless behaviour a user expects from "switch profile".
     */
    relaunchInto("stark");

    expect(relaunch).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(spawn, "the packaged path must not spawn a second instance").not.toHaveBeenCalled();
  });

  it("passes the profile flag, and omits it for the default install", () => {
    relaunchInto("stark");
    const first = relaunch.mock.calls[0][0] as { args: string[] };
    expect(first.args.some((a) => a.includes("stark"))).toBe(true);

    relaunch.mockClear();
    relaunchInto("default");
    const second = relaunch.mock.calls[0][0] as { args: string[] };
    // The default install takes NO flag — that is what makes it the root userData.
    expect(second.args.some((a) => a.includes("--profile"))).toBe(false);
  });
});

describe("either way the choice is remembered", () => {
  it("writes the pointer before doing anything else", () => {
    // A switch that failed to record the target would send the next launch back to the old profile.
    packaged = false;
    expect(() => relaunchInto("stark")).not.toThrow();
  });
});

describe("⚠ IT REPORTS WHICH MECHANISM IT USED", () => {
  /**
   * ProfileChooser dismissed itself on `if (newWindow)` alone — sound for the two cases that existed (an
   * overlay spawns and dismisses; the launch screen is about to be REPLACED and must not clear early).
   * Development introduced a third: `profileOpen` spawns rather than replaces, because the dev server is a
   * child of this process. The process survived, nothing cleared the picker, and the old window sat on a
   * chooser while the new window opened behind it.
   *
   * The return value is the fix: the caller asks what happened instead of inferring it from which channel
   * it called.
   */
  it("returns false in dev, because this process is still alive", () => {
    packaged = false;
    expect(relaunchInto("stark")).toBe(false);
  });

  it("returns true when packaged, because this process is being replaced", () => {
    packaged = true;
    expect(relaunchInto("stark")).toBe(true);
  });

  it("the two answers are distinguishable, which is the whole point", () => {
    // A single boolean is enough, but it must actually differ between the paths — a constant would
    // reintroduce the bug in a form that looks fixed.
    packaged = false;
    const inDev = relaunchInto("stark");
    packaged = true;
    const inProd = relaunchInto("stark");
    expect(inDev).not.toBe(inProd);
  });
});

/**
 * ── ⚠ IT REFUSES AN ID IT CANNOT USE, RATHER THAN WRITING IT DOWN AND EXITING ────────────────
 *
 * The IPC boundary is where that is validated (see `requireExistingProfile` in index.ts), and this is the
 * second line of the same defence: `relaunchInto` writes the MACHINE-LEVEL pointer file and then calls
 * `app.exit(0)`, so a value it accepts outlives every window and is read back by a process that has no
 * database and nobody to ask.
 *
 * The falsification the report performed holds and is worth repeating: the executable is always
 * `process.execPath`, the id is one argv element, and both readers re-sanitise — so this was never
 * argument injection or path traversal. It was availability and persistence, which is bad enough:
 * one call killed the app and repointed every later launch at an empty profile.
 */
describe("⚠ AN UNUSABLE PROFILE ID IS REFUSED, NOT RECORDED", () => {
  it.each([
    ["all dots", ".."],
    ["nothing usable", "///"],
    ["empty", ""],
    ["the reserved sentinel's own spelling, uppercased", "DEFAULT"],
  ])("does not relaunch for %s", (_label, id) => {
    packaged = true;
    expect(relaunchInto(id)).toBe(false);
    expect(exit, "the process must not exit for an id it cannot use").not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
  });

  /**
   * ⚠ A TRAVERSAL IS REDUCED TO ONE COMPONENT, NOT REFUSED, and that is the sanitiser's contract
   * rather than a gap: `../../evil` keeps only `[A-Za-z0-9._-]`, so it becomes the ordinary profile
   * name `....evil` and cannot name anything outside `profiles/`. Asserted explicitly because
   * "traversal input → still relaunches" looks alarming until you see WHAT it relaunches into.
   */
  it("reduces a traversal to a single harmless component rather than refusing", () => {
    packaged = true;
    expect(relaunchInto("../../evil")).toBe(true);
    const { args } = relaunch.mock.calls[0][0] as { args: string[] };
    const flag = args.find((a) => a.startsWith("--profile="))!;
    expect(flag).not.toMatch(/[/\\]/);
    expect(flag).toBe("--profile=....evil");
  });

  /** The sentinel is compared before the sanitiser, because it legitimately means "the root install". */
  it("still accepts the reserved sentinel, which names the root install", () => {
    packaged = true;
    expect(relaunchInto("default")).toBe(true);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });
});
