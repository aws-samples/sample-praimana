// ── ⚠ A TURN THAT GOES SILENT MUST BE STOPPED; A TURN THAT IS WORKING MUST NOT BE ──────────────
//
// Two codex processes were found holding an ESTABLISHED HTTPS connection to Bedrock for 17 minutes at 0% CPU
// — the request had gone out and no response ever came. Nothing on this path had a timeout, so the chat spun
// indefinitely and there was no way to tell "slow" from "dead". That violated the standing rule that every
// external call has one.
//
// ⚠ THE RISK IN FIXING IT IS KILLING GOOD WORK. Agentic turns legitimately run for many minutes, so
// a total-duration cap would abort real work — the failure mode would be worse than the bug, and
// harder to attribute. The budget is therefore on SILENCE, reset by any byte of output. The second
// test below is the one that matters: it is what stops a future "simplification" to a plain timeout.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import {
  watchForStall,
  STALL_TIMEOUT_MS,
  stallTimeoutMs,
  STALL_TIMEOUT_MIN_MINUTES,
  STALL_TIMEOUT_MAX_MINUTES,
  STALL_TIMEOUT_DEFAULT_MINUTES,
  isInteractiveCommand,
  replaceStalledChild,
  INTERACTIVE_COMMANDS,
  activeProcesses,
} from "./cli-assistant";
import { setAssistantCommandOverrides } from "../assistant-command";

/** A child that records the signals it was sent and can report itself still alive. */
function fakeChild() {
  const child = new EventEmitter() as unknown as ChildProcess & { signals: string[] };
  (child as any).signals = [];
  (child as any).exitCode = null;
  (child as any).signalCode = null;
  (child as any).kill = (sig?: string) => {
    (child as any).signals.push(sig ?? "SIGTERM");
    return true;
  };
  return child as ChildProcess & { signals: string[] };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("⚠ turn stall watchdog", () => {
  it("stops a turn that produces nothing at all", () => {
    const child = fakeChild();
    const onStall = vi.fn();
    watchForStall(child, onStall);

    vi.advanceTimersByTime(STALL_TIMEOUT_MS - 1);
    expect(onStall, "must not fire early").not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onStall).toHaveBeenCalledOnce();
    expect(onStall).toHaveBeenCalledWith(STALL_TIMEOUT_MS);
    expect(child.signals).toContain("SIGTERM");
  });

  /**
   * ⚠ THE ASSERTION THAT PROTECTS LONG WORKING TURNS. Output resets the budget, so a turn can run
   * far longer than the timeout as long as it is saying something. Ten budgets' worth of elapsed time
   * with a byte of output in each one must not be stopped.
   */
  it("never stops a turn that keeps producing output, however long it runs", () => {
    const child = fakeChild();
    const onStall = vi.fn();
    const stall = watchForStall(child, onStall);

    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(STALL_TIMEOUT_MS - 1000);
      stall.bump();
    }

    expect(onStall, "a talking turn must never be stalled").not.toHaveBeenCalled();
    expect(child.signals).toEqual([]);
    // ...but it is still armed: go quiet and it does fire.
    vi.advanceTimersByTime(STALL_TIMEOUT_MS);
    expect(onStall).toHaveBeenCalledOnce();
  });

  it("stop() disarms it, so a completed turn cannot be killed late", () => {
    const child = fakeChild();
    const onStall = vi.fn();
    const stall = watchForStall(child, onStall);

    stall.stop();
    vi.advanceTimersByTime(STALL_TIMEOUT_MS * 3);

    expect(onStall).not.toHaveBeenCalled();
    expect(child.signals).toEqual([]);
  });

  it("bump() after stop() does not re-arm it", () => {
    const child = fakeChild();
    const onStall = vi.fn();
    const stall = watchForStall(child, onStall);

    stall.stop();
    stall.bump();
    vi.advanceTimersByTime(STALL_TIMEOUT_MS * 2);

    expect(onStall).not.toHaveBeenCalled();
  });

  /**
   * SIGTERM first so the CLI can write its own session state — Codex persists a rollout on the way
   * out, and SIGKILL loses the turn on its side. SIGKILL only if it ignored the polite request.
   */
  it("escalates to SIGKILL only if the child is still alive", () => {
    const child = fakeChild();
    watchForStall(child, () => {});

    vi.advanceTimersByTime(STALL_TIMEOUT_MS);
    expect(child.signals).toEqual(["SIGTERM"]);

    vi.advanceTimersByTime(5000);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("does NOT SIGKILL a child that exited after the SIGTERM", () => {
    const child = fakeChild();
    watchForStall(child, () => {});

    vi.advanceTimersByTime(STALL_TIMEOUT_MS);
    (child as any).exitCode = 143; // it went away politely
    vi.advanceTimersByTime(5000);

    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("fires once, not repeatedly", () => {
    const child = fakeChild();
    const onStall = vi.fn();
    watchForStall(child, onStall);

    vi.advanceTimersByTime(STALL_TIMEOUT_MS * 4);
    expect(onStall).toHaveBeenCalledOnce();
  });

  it("budgets silence generously enough for a real slow first token", () => {
    // Measured on this machine: ~104s for a trivial prompt against the Bedrock config. The budget
    // must clear that comfortably or it would abort working turns.
    expect(STALL_TIMEOUT_MS).toBeGreaterThan(104_000 * 2);
  });
});

// ── ⚠ THE CONFIGURED BUDGET, AND WHY IT CANNOT BE SET TO "NEVER" ───────────────────────────────
//
// The limit is user-settable (Settings → Assistant responses) because the right value depends on the
// model: a throttled Bedrock endpoint legitimately needs longer than a local CLI. What it must NOT be
// is disableable — a timeout with an off switch is a safety mechanism the UI can turn off, and the
// standing rule is that those are never disabled to make a symptom disappear. Here the symptom is an
// assistant that has stopped responding, which is exactly when someone would be tempted.
//
// `settings` is a plaintext SQLite table anything running as this user can edit, so these cases are
// about a value arriving from ANYWHERE, not only from the field that normally writes it.
describe("⚠ configurable stall budget", () => {
  it("uses a valid value as given", () => {
    expect(stallTimeoutMs(10)).toBe(10 * 60_000);
    expect(stallTimeoutMs("15")).toBe(15 * 60_000);
    expect(stallTimeoutMs(STALL_TIMEOUT_MIN_MINUTES)).toBe(STALL_TIMEOUT_MIN_MINUTES * 60_000);
    expect(stallTimeoutMs(STALL_TIMEOUT_MAX_MINUTES)).toBe(STALL_TIMEOUT_MAX_MINUTES * 60_000);
  });

  /** The assertion that matters: no input can mean "wait forever". */
  it("REFUSES to be turned off, however it is asked", () => {
    for (const off of [0, "0", -1, -9999, "", "   ", null, undefined, NaN, "off", "never", "false"]) {
      const ms = stallTimeoutMs(off as unknown);
      expect(ms, `${JSON.stringify(off)} must not disable the watchdog`).toBeGreaterThanOrEqual(
        STALL_TIMEOUT_MIN_MINUTES * 60_000
      );
      expect(Number.isFinite(ms)).toBe(true);
    }
  });

  it("caps an absurdly large value rather than honouring it", () => {
    for (const huge of [600, "99999", Number.MAX_SAFE_INTEGER, Infinity]) {
      expect(stallTimeoutMs(huge as unknown)).toBeLessThanOrEqual(
        STALL_TIMEOUT_MAX_MINUTES * 60_000
      );
    }
  });

  it("falls back to the default when the value is not a number at all", () => {
    for (const junk of ["abc", {}, [], true]) {
      expect(stallTimeoutMs(junk as unknown)).toBe(STALL_TIMEOUT_DEFAULT_MINUTES * 60_000);
    }
  });

  it("the floor clears the slowest first-token wait measured on this machine", () => {
    // ~104s for a trivial Codex prompt against this Bedrock config. A floor below that would abort
    // turns that were working, which is a worse and more confusing failure than the one being fixed.
    expect(STALL_TIMEOUT_MIN_MINUTES * 60_000).toBeGreaterThan(104_000);
  });

  it("honours the configured budget end to end in the watcher", () => {
    const child = fakeChild();
    const onStall = vi.fn();
    watchForStall(child, onStall, stallTimeoutMs(3));

    vi.advanceTimersByTime(3 * 60_000 - 1);
    expect(onStall).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onStall).toHaveBeenCalledWith(3 * 60_000);
  });
});

// ── ⚠ THE HOLE THAT MADE THE WATCHDOG LOOK BROKEN ──────────────────────────────────────────────
//
// Every watchdog test above passed, because they all call watchForStall directly — none exercised the handler
// path that decides whether to arm one at all.
//
// `cli:send` began with: if this session already has a live child, write the message to its stdin and
// RETURN. That returned before the spawn path, so no watchdog was armed for the new message. A turn
// already stalled therefore stayed stalled for ever — the timeout was never started, not broken.
//
// And the branch was wrong on its own terms: Claude runs `-p` and Codex runs `exec`, both one-shot.
// Neither reads a second prompt, so even with a healthy child the message went nowhere.
describe("⚠ one-shot assistants must not be fed a second prompt", () => {
  it("no shipped assistant is interactive, so the reuse branch never fires today", () => {
    for (const cmd of ["claude", "codex", "kiro-cli", "kiro"]) {
      expect(isInteractiveCommand(cmd), `${cmd} must not be treated as interactive`).toBe(false);
    }
    expect(INTERACTIVE_COMMANDS.size).toBe(0);
  });

  it("recognises a renamed binary as the same one-shot assistant", () => {
    // A rename must not smuggle a command past the check by no longer matching the shipped name.
    setAssistantCommandOverrides({ codex: "codex_bedrock" });
    expect(isInteractiveCommand("codex_bedrock")).toBe(false);
    setAssistantCommandOverrides({});
  });

  it("retires a still-registered child so the next message can spawn a fresh turn", () => {
    const child = fakeChild();
    activeProcesses.set("s1", child as unknown as ChildProcess);

    replaceStalledChild("s1", child as unknown as ChildProcess, "codex");

    expect(child.signals, "the stuck child is terminated").toContain("SIGTERM");
    expect(activeProcesses.has("s1"), "and de-registered, so cli:send reaches the spawn path").toBe(
      false
    );
  });

  it("does not remove a NEWER child that replaced the one being retired", () => {
    // clearSessionProcess only deletes when the entry still points at the same process — otherwise a
    // late retirement would unregister the turn the participant just started.
    const oldChild = fakeChild();
    const newChild = fakeChild();
    activeProcesses.set("s2", newChild as unknown as ChildProcess);

    replaceStalledChild("s2", oldChild as unknown as ChildProcess, "codex");

    expect(activeProcesses.get("s2")).toBe(newChild as unknown as ChildProcess);
  });
});
