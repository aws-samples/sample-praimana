import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * WHICH ASSISTANT IMPLEMENTATION A TURN USES.
 *
 * Two exist side by side: the original spawn path (`cli:*`, cli-assistant.ts) and the SDK path
 * (`claude-sdk:*`, claude-code.ts) which asks before every tool use and so finally fires the
 * approve/deny card the renderer already had.
 *
 * ⚠ SOURCE ASSERTIONS, and the reason is stated rather than assumed: this package sets
 * `environment: "node"` with no jsdom, so no test here can click a button or observe a React render.
 * What IS decidable from the source is the ROUTING — and routing is exactly where this goes wrong in a
 * way nobody would notice until a workshop: a permission answer sent to the wrong implementation
 * leaves the SDK's promise parked for ever, and a parked prompt has no deadline.
 */

const CHAT_VIEW = readFileSync(
  fileURLToPath(new URL("./components/AssistantChatView.tsx", import.meta.url)),
  "utf8"
);

/** Comments discuss what must NOT happen, so they defeat absence checks. */
const code = CHAT_VIEW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("Claude uses the SDK path", () => {
  it("routes the send by an EQUALITY on claude", () => {
    /**
     * An equality, not a `!==` on the others: a newly-added assistant then defaults to the WORKING
     * spawn path rather than silently inheriting an SDK that cannot drive it.
     */
    expect(code).toContain('const usesSdk = currentCli === "claude"');
    expect(code, "no inverted test that would catch future assistants").not.toMatch(
      /usesSdk\s*=\s*currentCli\s*!==/
    );
  });

  it("sends through claudeSdkSend when it is Claude", () => {
    expect(code).toContain("usesSdk ? api.claudeSdkSend : api.cliSend");
  });

  it("⚠ answers the permission prompt on the SAME implementation that asked", () => {
    /**
     * THE ASSERTION THAT MATTERS MOST HERE. The SDK parks a Promise until the click arrives; answering
     * `cli:permission-respond` instead would leave it parked for ever and the turn would never end —
     * no error, no log, just a spinner. Both buttons must route.
     */
    const routed = [
      ...code.matchAll(/usesSdk \? api\.claudeSdkPermissionRespond : api\.cliPermissionRespond/g),
    ];
    expect(routed, "both Allow and Deny").toHaveLength(2);
    // And neither button may call the old channel unconditionally.
    expect(code).not.toMatch(/^\s*api\.cliPermissionRespond\(/m);
  });

  it("stops the right implementation", () => {
    // Aborting the spawn path would leave the SDK query running, and vice versa.
    expect(code).toContain("usesSdk ? api.claudeSdkStop : api.cliStop");
  });
});

describe("the shared surfaces stay shared", () => {
  it("does NOT route the model list or workspace trust", () => {
    /**
     * Both are assistant-agnostic: `cliGetModels` lists Claude models either way, and
     * `cliTrustWorkspace` writes the CLI's own trust file. Routing them would duplicate a handler for
     * no behavioural difference — and the SDK path deliberately reuses the trust one, which is why it
     * raises the same `cli:trust-required` event.
     */
    expect(code).toContain("api.cliGetModels()");
    expect(code).toContain("api.cliTrustWorkspace(");
    expect(code).not.toContain("claudeSdkGetModels");
    expect(code).not.toContain("claudeSdkTrustWorkspace");
  });

  it("keeps the STREAM listeners unrouted", () => {
    /**
     * `cli:output`, `cli:error`, `cli:response-complete` and `cli:permission-request` are emitted by
     * BOTH implementations on purpose, so the renderer's listeners work whichever produced the turn.
     * A `claudeSdk`-prefixed listener appearing here would mean the shared-event design had been
     * abandoned and half the UI would go quiet on one path.
     */
    for (const listener of ["onCliOutput", "onCliError", "onCliResponseComplete", "onCliPermissionRequest"]) {
      expect(code, `${listener} must stay shared`).toContain(`api.${listener}(`);
    }
    expect(code).not.toMatch(/api\.onClaudeSdk/);
  });
});

describe("KIRO IS NOT TOUCHED", () => {
  it("has its own view and its own channels", () => {
    /**
     * Deliberately. Kiro runs through kiro-acp.ts with `--trust-all-tools` and
     * its own ACP protocol; the SDK cannot drive it. This pins that AssistantChatView's routing cannot reach
     * it — KiroChatView is a separate component calling `kiroAcp*`, so a change here is structurally
     * incapable of altering Kiro's behaviour.
     */
    const kiro = readFileSync(
      fileURLToPath(new URL("./components/KiroChatView.tsx", import.meta.url)),
      "utf8"
    );
    expect(kiro).toContain("api.kiroAcpSend");
    expect(kiro, "no SDK path in the Kiro view").not.toContain("claudeSdk");
    // …and AssistantChatView's predicate cannot select the SDK for kiro, since it tests for "claude".
    expect(code).not.toMatch(/usesSdk[^;]*kiro/i);
  });
});


describe("the Stream Log debug panel is GONE", () => {
  /**
   * It was a collapsible terminal showing raw `cli:raw` frames, and it existed because there was nothing
   * else to watch while a turn ran — the SDK path shipped without token streaming, so a participant
   * staring at a spinner had this panel as the only evidence anything was happening.
   *
   * That reason is gone: replies now stream token by token into the conversation itself, so the answer
   * IS the progress indicator. A raw frame dump beside it is noise in a tool aimed at workshop
   * participants rather than at the people debugging it.
   */
  it("renders no Stream Log control", () => {
    expect(code).not.toContain("Stream Log");
    expect(code).not.toContain("showTerminal");
    expect(code).not.toContain("terminalEndRef");
  });

  it("no longer accumulates raw frames into React state", () => {
    /**
      * The panel kept the last 200 frames PER SESSION and appended on every line. Doing that for a view
      * nobody can open is work with no reader — and on a long turn it is a re-render per frame.
      */
    expect(code).not.toContain("rawLinesBySession");
    expect(code).not.toContain("setRawLinesBySession");
  });

  it("does not SUBSCRIBE to cli:raw", () => {
    // A listener whose only consumer was deleted is a leak with extra steps.
    expect(code).not.toMatch(/api\.onCliRaw\(/);
  });

  it("⚠ but the CHANNEL and its bridge REMAIN", async () => {
    /**
     * The distinction that makes this a UI removal rather than a capability removal. `cli:raw` is still
     * emitted by cli-assistant.ts and still exposed in the preload, so a future debug view or a support
     * bundle can consume it without re-plumbing the main process. Deleting the emitters would have made
     * this change much harder to undo than it needed to be.
     */
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const preload = readFileSync(
      fileURLToPath(new URL("../preload/index.ts", import.meta.url)),
      "utf8"
    );
    expect(preload, "the bridge stays").toContain("onCliRaw");
    expect(preload, "and is still detached by removeCliListeners").toContain('"cli:raw"');
  });
});
