// ── ⚠ A CHAT MUST SURVIVE A RESTART, AND RESUME ITS OWN THREAD ────────────────────────────
//
// TWO faults, one symptom:
//
//   1. Whether a chat had already started lived in `sessionStarted`, a module-level object in the MAIN
//      PROCESS. A restart emptied it, so the first message into an existing chat was sent as turn one and
//      Codex opened a brand-new thread. The desktop still showed the old transcript because it reads
//      SQLite — the UI had the history and the CLI had none, which reads as amnesia rather than a blank
//      chat.
//   2. Continuation used `codex exec resume --last`, which resumes the most recent thread IN THE DIRECTORY
//      rather than the one belonging to the open chat. Two chats in one project could braid together, and
//      that symptom looks like the assistant "remembering the wrong thing" rather than like a bug.
//
// Codex hands us the fix and we were discarding it: `{"type":"thread.started","thread_id":"…"}`.

import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS } from "../migrations";
import { buildCliArgs } from "./cli-assistant";

const REAL_THREAD = "019ff11f-61fc-77d1-b1da-85cf2f51d7f5";

describe("⚠ codex resumes the RIGHT thread", () => {
  it("resumes by id when the chat has one", () => {
    const { cmd, args } = buildCliArgs("codex", true, undefined, REAL_THREAD);
    expect(cmd).toBe("codex");
    expect(args).toEqual(["exec", "resume", REAL_THREAD, "--json", "--skip-git-repo-check"]);
  });

  /**
   * ⚠ ARGUMENT ORDER IS LOAD-BEARING. `resume` is a SUBCOMMAND, so it must sit immediately after `exec`
   * and before the flags — put it later and the CLI treats "resume" as the prompt, which is a turn that
   * appears to work and asks the assistant to resume something.
   */
  it("puts the resume subcommand before any flag", () => {
    const { args } = buildCliArgs("codex", true, undefined, REAL_THREAD);
    expect(args[0]).toBe("exec");
    expect(args[1]).toBe("resume");
    expect(args[2]).toBe(REAL_THREAD);
    expect(args.indexOf("--json")).toBeGreaterThan(args.indexOf("resume"));
  });

  /**
   * The fallback for chats that predate the `cli_thread_id` column: they have prior turns but no recorded
   * id, and resuming the directory's latest is still better than starting over.
   */
  it("falls back to --last only when there is no recorded id", () => {
    const { args } = buildCliArgs("codex", true, undefined, null);
    expect(args).toEqual(["exec", "resume", "--last", "--json", "--skip-git-repo-check"]);
  });

  it("starts fresh when the chat has never run", () => {
    const { args } = buildCliArgs("codex", false, undefined, null);
    expect(args).toEqual(["exec", "--json", "--skip-git-repo-check"]);
    expect(args, "no resume on a brand-new chat").not.toContain("resume");
  });

  /**
   * ⚠ AN ID BEATS THE FLAG. `continued` is derived from the id's presence today, but if the two ever
   * disagree the id is the better answer — it names a specific thread, while `false` would throw the
   * conversation away.
   */
  it("prefers the id even if the continued flag says otherwise", () => {
    const { args } = buildCliArgs("codex", false, undefined, REAL_THREAD);
    expect(args).toContain(REAL_THREAD);
  });
});

describe("⚠ EVERY assistant resumes by id, not by 'the last one'", () => {
  /**
   * ⚠ EVERY FLAG BELOW WAS VERIFIED AGAINST THE INSTALLED BINARY, not inferred:
   *   claude --help        →  `-c, --continue` "Continue the most recent conversation in <cwd>"
   *                           `-r, --resume [value]` "Resume a conversation by session ID"
   *   kiro-cli chat --help →  `-r, --resume` "Resume the most recent conversation from this directory"
   *                           `--resume-id <SESSION_ID>` "Resume a specific conversation by session ID"
   *   codex exec           →  `resume <id>` subcommand (see the codex block above)
   *
   * The directory-scoped forms are what produced the reported bug, and they remain ONLY as the fallback for
   * chats that predate the stored id.
   */
  it("claude resumes the named session", () => {
    const args = buildCliArgs("claude", true, undefined, REAL_THREAD).args;
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe(REAL_THREAD);
    expect(args, "the directory-scoped form must not also be passed").not.toContain("--continue");
  });

  it("claude falls back to --continue only without an id", () => {
    expect(buildCliArgs("claude", true, undefined, null).args).toContain("--continue");
    expect(buildCliArgs("claude", false, undefined, null).args).not.toContain("--continue");
  });

  /**
   * ── ⚠ THE CLI FALLBACK PRE-APPROVES ONLY READ-ONLY TOOLS ─────────────────────────────────────
   *
   * This argv used to carry `--allowedTools Bash Read Edit Write Skill`, which — in claude-code.ts's own
   * words — "PRE-APPROVES those five, so Claude never asks about them". Arbitrary shell with no prompt, on a
   * path where no prompt is possible: `pendingPermissions` in cli-assistant.ts is only ever read and deleted,
   * and `cli:permission-request` is emitted from the SDK path alone, so `cli:permission-respond` had nothing
   * to answer.
   *
   * ⚠ THIS IS NOT THE PATH CLAUDE CHATS TAKE. The renderer routes `currentCli === "claude"` to
   * `claude-sdk:*`, which prompts per tool. This branch is the retained fallback, and a fallback that
   * silently grants shell access is worse than one that cannot write.
   */
  it("claude pre-approves nothing that writes or executes", () => {
    const { args } = buildCliArgs("claude", false, undefined, null);
    expect(args, "read-only tools are still pre-approved, so a read costs no prompt").toContain(
      "--allowedTools"
    );
    for (const tool of ["Bash", "Edit", "Write", "Skill"]) {
      expect(args, `${tool} must not be pre-approved on a path that cannot ask`).not.toContain(tool);
    }
    expect(args).toContain("Read");
  });

  it("kiro resumes the named session with --resume-id", () => {
    const args = buildCliArgs("kiro", true, undefined, REAL_THREAD).args;
    expect(args).toContain("--resume-id");
    expect(args[args.indexOf("--resume-id") + 1]).toBe(REAL_THREAD);
    expect(args, "not the directory-scoped flag as well").not.toContain("--resume");
  });

  it("kiro falls back to -r/--resume only without an id", () => {
    expect(buildCliArgs("kiro", true, undefined, null).args).toContain("--resume");
    expect(buildCliArgs("kiro", false, undefined, null).args).not.toContain("--resume");
  });

  /** kiro-cli is the other spelling of the same assistant and must behave identically. */
  it("treats kiro-cli the same as kiro", () => {
    expect(buildCliArgs("kiro-cli", true, undefined, REAL_THREAD).args).toContain("--resume-id");
  });

  /**
   * ⚠ NO ASSISTANT MAY BE LEFT ON A DIRECTORY-SCOPED RESUME WHEN AN ID EXISTS. Asserted as a sweep rather
   * than per-assistant, so a launcher added later is caught by default instead of inheriting the bug.
   */
  it.each(["claude", "codex", "kiro", "kiro-cli"])(
    "%s never uses a 'most recent' flag once it has an id",
    (cli) => {
      const args = buildCliArgs(cli, true, undefined, REAL_THREAD).args;

      expect(args, `${cli} must name the session`).toContain(REAL_THREAD);

      /**
       * ⚠ THE UNAMBIGUOUS FLAGS: each of these means "whatever ran last in this directory", with no way to
       * say which conversation. `-c`/`--continue` (claude), `--last` (codex), `-r` (kiro).
       */
      for (const guess of ["--continue", "-c", "--last", "-r"]) {
        expect(args, `${cli} still guesses with ${guess}`).not.toContain(guess);
      }

      /**
       * ⚠ AND `--resume` IS AMBIGUOUS ACROSS CLIS, which is why this is not a flat regex — my first version
       * of this sweep failed on claude for being CORRECT. For claude, `--resume <id>` IS the by-id form; for
       * kiro, a BARE `--resume` is the directory-scoped one and `--resume-id` is by-id. So the rule is
       * positional: if `--resume` appears, the very next argument must be the id.
       */
      const at = args.indexOf("--resume");
      if (at !== -1) {
        expect(args[at + 1], `${cli}'s --resume must be followed by the id, not used bare`).toBe(
          REAL_THREAD
        );
      }
    }
  );
});

describe("⚠ the continuation state is DURABLE, not in memory", () => {
  /**
   * The real schema, from the real migration list — so the column is exercised as it will exist on a
   * participant's machine rather than as a hand-written CREATE TABLE that could drift from migrations.ts.
   */
  it("migration 12 adds a cli_thread_id that round-trips", () => {
    const db = new DatabaseSync(":memory:");
    for (const sql of MIGRATIONS) db.exec(sql);
    db.prepare("INSERT INTO projects (id, name, path) VALUES ('p1','proj','/tmp/p')").run();
    db.prepare(
      "INSERT INTO chat_sessions (id, project_id, title, ai_provider) VALUES ('s1','p1','Chat','codex')"
    ).run();

    // A brand-new chat has no thread — which is what makes "start fresh" the right first call.
    const before = db.prepare("SELECT cli_thread_id FROM chat_sessions WHERE id='s1'").get() as {
      cli_thread_id: string | null;
    };
    expect(before.cli_thread_id).toBeNull();

    db.prepare("UPDATE chat_sessions SET cli_thread_id = ? WHERE id = 's1'").run(REAL_THREAD);
    const after = db.prepare("SELECT cli_thread_id FROM chat_sessions WHERE id='s1'").get() as {
      cli_thread_id: string | null;
    };
    expect(after.cli_thread_id, "survives the process, unlike the old flag").toBe(REAL_THREAD);
  });

  /** The handler must read the column, not a module-level object. */
  it("the handler stores and reads the id from SQLite", () => {
    const src = readFileSync(join(__dirname, "cli-assistant.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src, "reads it").toMatch(/SELECT cli_thread_id FROM chat_sessions/);
    expect(src, "writes it").toMatch(/UPDATE chat_sessions SET cli_thread_id/);
    expect(src, "and keeps no in-memory started flag").not.toMatch(/sessionStarted/);

    /**
     * ⚠ THE CALL SITE, NOT JUST THE FUNCTION — mutation testing found this gap. Deleting
     * `storeCliThreadId(...)` from the stream handler left the assertions above passing, because the
     * function still CONTAINED the UPDATE; nothing was ever calling it. A persister nobody invokes is
     * exactly the bug being fixed, restored in a form that looks like the fix.
     */
    expect(src, "the stream handler must actually call it").toMatch(
      /case "thread":[\s\S]{0,200}?storeCliThreadId\(params\.sessionId, effect\.threadId\)/
    );
    expect(src, "and the send path must read it").toMatch(
      /readCliThreadId\(params\.sessionId\)/
    );

    /**
     * ⚠ CLAUDE'S CAPTURE NEEDS ITS OWN ASSERTION, and mutation testing proved it: deleting the
     * `system`/`session_id` handler left every test green, because the only capture asserted was CODEX's.
     * An id that is never recorded means `--resume` never fires and claude silently falls back to
     * `--continue` for ever — the original bug, for a different assistant.
     */
    expect(src, "claude's session id must be captured from its system event").toMatch(
      /obj\.type === "system"[\s\S]{0,160}?storeCliThreadId\(params\.sessionId, obj\.session_id\)/
    );

    /**
     * ⚠ AND ONLY A NON-EMPTY ID MAY BE STORED. This is not defensive tidying: the capture runs on EVERY
     * turn, so a malformed later event carrying `session_id: ""` would OVERWRITE a good id with an empty
     * one, and the chat would silently fall back to `--continue` from then on. Mutation testing found the
     * gap — removing the truthiness check passed every other assertion, because a stored "" reads back as
     * null and merely looks like "no id yet".
     */
    expect(src, "an empty session_id must not overwrite a good one").toMatch(
      /typeof obj\.session_id === "string" && obj\.session_id/
    );
  });
});

// ── ⚠ THE MODEL MUST REACH EVERY CODEX PATH, AND `-c` MUST REACH NONE ────────────────────
//
// There are THREE codex command shapes — fresh, resume-by-id, resume --last — and a selection that applied to
// only one would look like the picker reverting the moment a conversation had history.
//
// ⚠ THE EFFORT FLAG WAS HERE AND IS GONE, because it broke every turn: after model selection was added to
// Codex, Codex gave no response and only the last message synced. Measured on one thread, back to back:
//
//     no flags                                → replies
//     -m openai.gpt-5.4 (same as config)      → replies
//     -c model_reasoning_effort=high (SAME)   → "failed to load AWS credentials: the credential provider was
//     -c check_for_update_on_startup=false    →  not enabled", then turn.failed
//
// ANY `-c` override breaks the credential provider for a config with a nested
// `[model_providers.amazon-bedrock.aws]` table — even setting a key to the value it already holds. `-m` is
// unaffected. So the model picker stays and the effort control was removed.
describe("⚠ codex carries the model, and never a -c override", () => {
  const MODEL = "openai.gpt-5.6-sol";

  /** The three shapes, as (label, threadId, continued). */
  const PATHS: [string, string | null, boolean][] = [
    ["a fresh thread", null, false],
    ["resume by id", "019ff11f-0000-7000-8000-000000000000", true],
    ["resume --last", null, true],
  ];

  it.each(PATHS)("%s passes the model through", (_label, threadId, continued) => {
    const { args } = buildCliArgs("codex", continued, MODEL, threadId);

    const at = args.indexOf("-m");
    expect(at, "the model flag is present").toBeGreaterThan(-1);
    expect(args[at + 1], "and carries the selected model").toBe(MODEL);
  });

  /** ⚠ THE REGRESSION GUARD. A `-c` on any path fails the whole turn for this provider. */
  it.each(PATHS)("%s passes no -c override", (_label, threadId, continued) => {
    const { args } = buildCliArgs("codex", continued, MODEL, threadId);

    expect(args, "-c breaks the bedrock credential provider").not.toContain("-c");
    expect(args.join(" ")).not.toContain("model_reasoning_effort");
  });

  /**
   * ⚠ THE MODEL FLAG GOES AFTER THE `resume` SUBCOMMAND AND ITS ID. `resume` is positional, so a flag before
   * it would be read as the thread to resume — the CLI would try to continue a conversation called "-m".
   */
  it("keeps the resume subcommand and its id ahead of the flags", () => {
    const id = "019ff11f-0000-7000-8000-000000000000";
    const { args } = buildCliArgs("codex", true, MODEL, id);

    expect(args.slice(0, 3)).toEqual(["exec", "resume", id]);
    expect(args.indexOf("-m")).toBeGreaterThan(2);
  });

  /** Nothing selected must add nothing: an empty `-m` would be a parse error, not a default. */
  it("omits the model flag when nothing was selected", () => {
    const { args } = buildCliArgs("codex", false, undefined, null);

    expect(args).not.toContain("-m");
  });

  /**
   * ⚠ AND THE JSON STREAM MUST SURVIVE THE ADDITION. `--json` is what makes Codex stream events instead of a
   * formatted transcript; appending the model flag must not displace it on any path.
   */
  it.each(PATHS)("%s still asks for the JSON stream", (_label, threadId, continued) => {
    const { args } = buildCliArgs("codex", continued, MODEL, threadId);

    expect(args).toContain("--json");
    expect(args).toContain("--skip-git-repo-check");
  });
});
