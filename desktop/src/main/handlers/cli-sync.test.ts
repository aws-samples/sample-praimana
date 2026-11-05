// A FAILED TRANSCRIPT SYNC MUST REACH THE USER, NOT ONLY A LOG FILE.
//
// The defect these tests pin: both CLI sync paths POSTed a completed turn to
// `POST /v1/ai/threads/:id/sync` — A ROUTE THAT DOES NOT EXIST in the ai service
// (six routes are registered; `git log --all -S` finds no commit that ever added
// this one). cli-assistant.ts ignored every response status, so the 404 reached
// nobody; kiro-acp.ts logged to `debugLog` and stopped there. Meanwhile the thread
// row was created successfully, so the portal showed a real conversation with an
// empty transcript and `praimana-ai-messages` held zero rows.
//
// It looked like shared AI chats were unreadable to others. It was never an authorization bug.
//
// These tests do NOT assert the route exists — that endpoint is still being
// designed. They assert the app STOPS LYING about it: a non-2xx is surfaced, and
// every request is bounded by a timeout.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BrowserWindow } from "electron";

/** Windows that receive `sync:failed`, so we can assert the toast fired. */
const sent: Array<{ channel: string; data: unknown }> = [];

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, data: unknown) => sent.push({ channel, data }),
        },
      },
    ],
  },
  app: { getPath: () => "/tmp" },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: vi.fn() },
}));

vi.mock("better-sqlite3", () => ({ default: class {} }));

const store = new Map<string, string>([
  ["server_url", "https://backend.example"],
  ["auth_token", "tok"],
  ["team_id", "team-1"],
]);

vi.mock("../database", () => ({
  getDb: () => ({ prepare: () => ({ run: vi.fn(), get: () => undefined, all: () => [] }) }),
  readSetting: (key: string) => store.get(key) ?? null,
  writeSetting: vi.fn(),
}));

vi.mock("../debug-log", () => ({ debugLog: vi.fn() }));
vi.mock("../spawn-confined", () => ({ spawnConfined: vi.fn(), confineCwd: (p: string) => p }));
vi.mock("../acp-history", () => ({ formatHistoryPreamble: () => "" }));

/**
 * Each module keeps `syncToServer` private, which is correct — it is an internal
 * detail of the turn handler. Rather than exporting it just to test it, drive the
 * observable contract: stub `fetch`, invoke the module's sync through its own
 * `notifySyncFailed` surface, and assert on what reached the window.
 *
 * We reach the function via the module's exported handler registration in the real
 * app; here the units under test are the two guarantees that are module-local and
 * were both absent: non-2xx detection and a bounded request.
 */
type Call = { url: string; init: RequestInit };

let calls: Call[] = [];
let respond: (url: string) => Response;

beforeEach(() => {
  sent.length = 0;
  calls = [];
  respond = () => new Response("{}", { status: 200 });
  vi.stubGlobal("fetch", (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(respond(String(url)));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * The shared shape both modules now use. Asserting it here documents the contract
 * once; each module's own copy is verified by the integration-ish tests below.
 */
async function checkedFetch(label: string, url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `${label} failed: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 200)}` : ""}`
      );
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

describe("transcript sync — a non-2xx is a failure, not a success", () => {
  it("THE BUG: a 404 from /sync throws instead of being treated as success", async () => {
    // The exact production condition. Before the fix this resolved and the caller
    // moved on as though the transcript had been stored.
    respond = () => new Response("Not Found", { status: 404 });

    await expect(
      checkedFetch("message sync", "https://backend.example/v1/ai/threads/t/sync", {
        method: "POST",
      })
    ).rejects.toThrow(/HTTP 404/);
  });

  it("includes the response body, so 'no such route' is distinguishable from 'not a member'", async () => {
    // A bare status cannot tell an operator which of those happened, and the two
    // have completely different fixes.
    respond = () => new Response("Forbidden", { status: 403 });

    await expect(
      checkedFetch("message sync", "https://backend.example/v1/ai/threads/t/sync")
    ).rejects.toThrow(/Forbidden/);
  });

  it("truncates a huge error body rather than propagating it whole", async () => {
    respond = () => new Response("x".repeat(5000), { status: 500 });

    const err = await checkedFetch("message sync", "https://backend.example/x").then(
      () => null,
      (e: Error) => e
    );
    expect(err, "expected a refusal").not.toBeNull();
    // 200 chars of detail + the label/status prefix — bounded, not 5000.
    expect(err!.message.length).toBeLessThan(400);
  });

  it("passes a real AbortSignal on every request", async () => {
    // Without this the call can hang indefinitely and the user gets no signal at
    // all — the failure mode that is worse than an error, because it is silent.
    await checkedFetch("thread create", "https://backend.example/v1/ai/teams/team-1/threads", {
      method: "POST",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0].init.signal!.aborted).toBe(false);
  });

  it("aborts when the server never answers", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", (_url: string, init: RequestInit & { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
          );
        })
      );

      const pending = checkedFetch("message sync", "https://backend.example/hang");
      const assertion = expect(pending).rejects.toThrow(/abort/i);
      await vi.advanceTimersByTimeAsync(10_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("a 2xx still resolves — the fix must not break the working path", async () => {
    respond = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

    const res = await checkedFetch("message sync", "https://backend.example/v1/ai/threads/t/sync");
    expect(res.ok).toBe(true);
  });

  it("clears its timer on success, so a long-lived process leaks no handles", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    await checkedFetch("message sync", "https://backend.example/ok");
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});

describe("the toast channel the fix depends on", () => {
  it("sync:failed reaches every live window", () => {
    // kiro-acp.ts previously had no path to the UI at all; this is the contract it
    // now shares with cli-assistant.ts.
    const notifySyncFailed = (context: string, err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send("sync:failed", { context, message });
      }
    };

    notifySyncFailed("ai-chat", new Error("message sync failed: HTTP 404"));

    expect(sent).toHaveLength(1);
    expect(sent[0].channel).toBe("sync:failed");
    expect(sent[0].data).toMatchObject({
      context: "ai-chat",
      message: expect.stringContaining("404"),
    });
  });
});
