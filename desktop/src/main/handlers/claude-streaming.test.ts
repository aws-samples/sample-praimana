import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * CLAUDE STREAMS, AND KIRO IS NOT COLLATERAL.
 *
 * ── WHY CLAUDE DID NOT STREAM ──
 *
 * It was run through `exec` with a completion callback. `exec` BUFFERS a process's whole
 * output and delivers it once the process exits — so although the CLI was asked for
 * `--output-format stream-json`, every frame arrived at the end in one lump. Codex and
 * Kiro both used `spawn` and streamed fine, which is exactly why Claude looked frozen
 * while they did not.
 *
 * The comment defending `exec` claimed "spawn doesn't work with toolbox-exec auth". That
 * was tested rather than believed: the CLI authenticates fine when spawned directly.
 *
 * ── AND THE BOUNDARY THAT MUST HOLD ──
 *
 * AssistantChatView's listener cleanup covers `cli:*` ONLY. The seven `kiroAcp:*` channels belong
 * to KiroChatView's own `removeKiroAcpListeners`, which already works — that is why
 * Kiro's streaming is healthy. Tearing those down from AssistantChatView would break a working
 * path in order to fix a broken one, so the two removers must stay disjoint. The last
 * block below is that guarantee.
 */

const DESKTOP = join(__dirname, "..", "..");
const cli = readFileSync(join(__dirname, "cli-assistant.ts"), "utf8");
const preload = readFileSync(join(DESKTOP, "preload", "index.ts"), "utf8");
const chatView = readFileSync(join(DESKTOP, "renderer", "components", "AssistantChatView.tsx"), "utf8");
const kiroAcp = readFileSync(join(__dirname, "kiro-acp.ts"), "utf8");

/** Comments explain what the code must NOT do, so strip them before asserting absence. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const code = stripComments(cli);

describe("Claude is spawned, not exec'd", () => {
  it("no longer uses exec at all", () => {
    // exec is what buffered the output and defeated stream-json.
    expect(code).not.toMatch(/\bexec\(/);
    expect(code).not.toMatch(/require\("child_process"\)/);
  });

  it("spawns with piped stdio so stdout can be read incrementally", () => {
    /**
     * ⚠ `spawnConfined`, WHICH IS STILL A SPAWN. Two wrappers deep now, and both moves were forced:
     *
     *   `spawn` → `spawnPortable`   on Windows `claude` is a `.cmd` shim and CreateProcess cannot
     *                               execute a batch file, so `spawn` with `shell: false` threw ENOENT
     *                               and no turn could start.
     *   `spawnPortable` → `spawnConfined`  these two sites were
     *                               named as bypassing the shared helper, so the agent's working
     *                               directory was never real-path-checked against the open project.
     *
     * `spawnConfined` calls `spawnPortable` after `confineCwd`, and `spawnPortable` still passes
     * `shell: false` in every branch — so what this case protects, a spawn with piped stdio rather
     * than a buffering `exec`, is unchanged.
     */
    expect(code).toMatch(/spawnConfined\(/);
    expect(code).toMatch(/stdio:\s*\["pipe", "pipe", "pipe"\]/);

    // And the confinement is real: the helper resolves the cwd rather than passing it through.
    const confined = stripComments(readFileSync(join(__dirname, "..", "spawn-confined.ts"), "utf8"));
    expect(confined).toMatch(/const cwd = confineCwd\(options\.cwd\)/);
  });

  it("⚠ never routes argv through a shell, on any platform", () => {
    /**
     * The invariant behind the case above, now that a Windows branch exists at all. `shell: true` would
     * hand the prompt and the project path to a shell to re-parse, which is precisely what the stdin
     * design avoids — and it would be invisible on macOS, where the code reads the same either way.
     */
    const portable = stripComments(readFileSync(join(__dirname, "..", "spawn-confined.ts"), "utf8"));
    expect(portable).toContain("shell: false");
    expect(portable).not.toMatch(/shell:\s*true/);
  });

  it("sends the prompt down STDIN, not through a temp file", () => {
    // exec needed `cat <file> | claude ...`, which meant writing a possibly sensitive
    // prompt to /tmp. spawn does not, so the prompt never touches the filesystem.
    expect(code).not.toMatch(/claude-input-/);
    expect(code).not.toMatch(/inputFilePath/);
    expect(code).toMatch(/child\.stdin\?\.write\(params\.message\)/);
  });

  it("has NO fixed turn timeout", () => {
    // The old 30s cap was justified as an auth check but applied to the whole turn, so
    // any real task over 30 seconds was killed mid-work.
    expect(code).not.toMatch(/timeout:\s*30000/);
    expect(code).not.toMatch(/maxBuffer/);
  });

  it("emits cli:output per text block, not once at the end", () => {
    // The actual streaming behaviour: each assistant text block is forwarded as it
    // arrives, inside the stdout handler.
    const stdoutHandler = code.slice(
      code.indexOf('child.stdout?.on("data"'),
      code.indexOf('child.stderr?.on("data"')
    );
    expect(stdoutHandler).toMatch(/cli:output/);
    expect(stdoutHandler).toMatch(/block\.text/);
  });
});

describe("line buffering — a split chunk must not drop a frame", () => {
  it("holds the trailing partial line instead of parsing it", () => {
    // stream-json is one JSON object per line, but a chunk boundary can fall anywhere.
    // Parsing a half-line would silently discard whichever frame straddled the split.
    const handler = code.slice(
      code.indexOf('child.stdout?.on("data"'),
      code.indexOf('child.stderr?.on("data"')
    );
    expect(handler).toMatch(/buffer \+= data\.toString\(\)/);
    expect(handler).toMatch(/lines\.pop\(\)/);
  });

  it("flushes a final newline-less line on close", () => {
    // The last frame frequently arrives without a trailing newline; without this flush
    // the authoritative `result` frame would be dropped on every turn.
    const closeHandler = code.slice(code.indexOf('child.on("close"'));
    expect(closeHandler).toMatch(/buffer\.trim\(\)/);
  });

  it("bounds stderr accumulation", () => {
    expect(code).toMatch(/stderrText \+ data\.toString\(\)\)\.slice\(-\d+\)/);
  });
});

describe("an empty response explains itself", () => {
  it("checks BOTH streams for an auth failure", () => {
    // `authentication_failed` arrives as JSON on STDOUT, so a stderr-only check missed
    // the exact failure that started this investigation.
    const closeHandler = code.slice(code.indexOf('child.on("close"'));
    expect(closeHandler).toMatch(/authentication_failed/);
    expect(closeHandler).toMatch(/stderrText.*resultText|resultText.*stderrText/s);
  });

  it("does not send an empty assistant bubble", () => {
    const closeHandler = code.slice(code.indexOf('child.on("close"'));
    expect(closeHandler).toMatch(/if \(!finalContent\)/);
  });
});

describe("KIRO IS UNTOUCHED — the two removers are disjoint", () => {
  const channelsIn = (name: string) => {
    const i = preload.indexOf(`${name}:`);
    if (i === -1) throw new Error(`${name} not found in preload`);
    const block = preload.slice(i, preload.indexOf("  },", i));
    return new Set([...block.matchAll(/"((?:cli|kiroAcp):[^"]+)"/g)].map((m) => m[1]));
  };

  it("removeCliListeners covers ONLY cli:* channels", () => {
    const cliChannels = channelsIn("removeCliListeners");
    expect(cliChannels.size).toBeGreaterThan(0);
    for (const c of cliChannels) {
      expect(c.startsWith("cli:"), `${c} must not be in removeCliListeners`).toBe(true);
    }
  });

  it("the two removers share NO channel", () => {
    // The whole guarantee: AssistantChatView cannot detach a listener KiroChatView still needs.
    const a = channelsIn("removeCliListeners");
    const b = channelsIn("removeKiroAcpListeners");
    expect([...a].filter((c) => b.has(c))).toEqual([]);
  });

  it("every cli:* channel the renderer subscribes to is removable", () => {
    // A channel with a listener but no remover is the duplication bug in waiting.
    const subscribed = new Set(
      [...preload.matchAll(/ipcRenderer\.on\("(cli:[^"]+)"/g)].map((m) => m[1])
    );
    const removable = channelsIn("removeCliListeners");
    for (const c of subscribed) {
      expect(removable.has(c), `${c} has no remover`).toBe(true);
    }
  });

  it("kiro-acp.ts contains no cli:* channel, so the split is real", () => {
    expect(stripComments(kiroAcp)).not.toMatch(/"cli:/);
  });
});

describe("AssistantChatView detaches its listeners", () => {
  it("clears on mount AND on unmount", () => {
    // Mount-time clear mirrors what KiroChatView already does; the unmount cleanup is
    // what was missing entirely, so StrictMode's double mount doubled every frame.
    const effect = chatView.slice(
      chatView.indexOf("api.removeCliListeners"),
      chatView.indexOf("}, []);", chatView.indexOf("api.onCliStatus"))
    );
    expect(chatView).toMatch(/return \(\) => api\.removeCliListeners/);
    expect(effect.length).toBeGreaterThan(0);
  });

  it("does NOT call removeKiroAcpListeners", () => {
    expect(stripComments(chatView)).not.toMatch(/removeKiroAcpListeners/);
  });
});
