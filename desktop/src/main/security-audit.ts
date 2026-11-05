/**
 * ── ⚠ A LOCAL, TAMPER-EVIDENT RECORD OF SECURITY DECISIONS ────────────────────────────────────
 *
 * When a participant says "someone signed in as me" or "the agent deleted my work", the app could answer
 * nothing at all — not who signed in, not when, not what the assistant was allowed to run.
 *
 * ── WHAT THIS IS AND IS NOT ──
 *
 * It is a LOCAL forensic aid on the user's own machine, in the same place and spirit as
 * `telemetry.jsonl`. It is NOT a security control: anything running as this user can delete the file
 * outright, and no local log can prevent that. What it can do is make SELECTIVE EDITING detectable,
 * which is the realistic threat — an actor who wants one line gone, not the whole trail.
 *
 * ⚠ SO THE POINT OF THE HASH CHAIN IS "EVIDENT", NOT "PREVENTED". Each record carries the previous
 * record's hash, so removing or altering any line breaks every hash after it and `verifyAuditChain`
 * says exactly where. Deleting the file is still possible and still obvious: the sequence restarts
 * at 1 with no `carried` marker.
 *
 * ⚠ IT IS NOT THE TELEMETRY LOG, and must not be folded into it. Telemetry is OPT-IN and defaults
 * OFF (`telemetry_enabled`), which is right for crash reports and wrong for this: an audit trail that
 * a user — or anything running as them — can silently switch off records nothing on the machines
 * where it would matter most. This is unconditional.
 *
 * ── ⚠ WHAT IS DELIBERATELY NOT WRITTEN ──
 *
 * No tokens, no passwords, no email addresses, no names, no file contents. `userId` (the Cognito
 * `sub`, a UUID) is recorded because an audit trail with no subject cannot answer "who", and a
 * pseudonymous id answers it without putting a person's email in a plaintext file that is easier to
 * read than the database. `detail` is a short, code-shaped reason — "bad-signature", "role-refused" —
 * never free text from a server, a token or a filesystem path.
 */

import { app } from "electron";
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { debugLog } from "./debug-log";

const LOG_FILE = "security-audit.jsonl";

/**
 * ⚠ 0600: OWNER READ/WRITE ONLY. The default for a new file under a typical umask is 0644 — group-
 * and world-readable — and on a shared or managed machine that hands the record of who signed in to
 * every other local account. `telemetry.jsonl` had the same gap and is fixed alongside this.
 */
export const AUDIT_FILE_MODE = 0o600;

/**
 * Rotation bound. Every queue, cache and file in this app is bounded (see the standing constraints):
 * an unbounded append-only log on a participant's laptop is a slow disk-filling bug.
 *
 * Generous on purpose — these events are human-paced (sign-ins, tool approvals), so a normal
 * workshop produces tens of lines, and the bound only ever fires on a machine doing something
 * unusual, which is the machine whose history is worth keeping.
 */
export const MAX_AUDIT_LINES = 2000;

/**
 * The bound actually in force. Equal to `MAX_AUDIT_LINES` in the app.
 *
 * ⚠ A TEST SEAM, AND IT EARNS ITS KEEP. Exercising rotation at the real bound means writing 2000+
 * records to a real file per case — which took seconds, and put two tests over vitest's 5s default
 * only when the machine was busy. That reads as flakiness and gets a timeout bumped rather than
 * understood. The rotation logic is identical at 50 records and at 2000, so the tests drive it at 50
 * and one case keeps the production number.
 */
let maxLines = MAX_AUDIT_LINES;

/** Test seam: override the rotation bound. Restored by `__resetAuditState`. */
export function __setMaxAuditLines(n: number): void {
  maxLines = n;
}

/** The events worth recording. A closed union, so a typo cannot invent an event nobody greps for. */
export type SecurityAuditEvent =
  /** A sign-in attempt reached a verdict. `detail` names the reason on failure. */
  | "auth.signin"
  /** The session was given up deliberately. */
  | "auth.signout"
  /** A stored session was renewed, or renewal failed. */
  | "auth.renew"
  /** A different remembered account was made active. */
  | "account.switch"
  /** A remembered account (and its stored credential) was deleted. */
  | "account.remove"
  /** The platform this install trusts was set, changed, or cleared. */
  | "platform.connect"
  | "platform.reset"
  /**
   * The user allowed or denied an assistant tool call.
   *
   * ⚠ THE ONE EVENT THAT IS NOT ABOUT IDENTITY, and the reason this file is worth having beyond
   * sign-in history. "The agent ran something destructive" is the question a participant is most
   * likely to ask, and until Kiro started asking (kiro-trust.ts) there was nothing to record.
   */
  | "tool.permission"
  /**
   * ── ⚠ THE FOUR EVENTS THE FIRST VERSION OF THIS FILE LEFT OUT ───────────────────────────────
   *
   * The log shipped covering the credential lifecycle and nothing else, and the finding named the rest
   * explicitly: chat sharing, agent spawns, file mutation, document upload/delete. Those are exactly the
   * actions a participant asks about afterwards, and the ones that happen ONLY on this machine — the platform
   * backend cannot have a record of a local file being trashed or an agent being launched.
   *
   * ⚠ AND NONE OF THEM CARRIES CONTENT. A path is recorded as its basename only (see
   * `redactedTarget`), a chat as a message count, a spawn as the assistant's name — enough to
   * reconstruct a sequence, never enough to reconstruct the work. Same rule as `detail` above.
   */
  /** A private local transcript was published to, or withdrawn from, the team. */
  | "chat.share"
  /** An assistant process was launched, with the tool policy it was launched under. */
  | "agent.spawn"
  /** A file or folder inside a project was created, renamed, moved, copied or trashed. */
  | "file.mutate"
  /** A team document was uploaded or deleted. */
  | "docs.change"
  /**
   * ── ⚠ THE TWO EVENTS FOR WIDENING WHAT THIS MACHINE WILL TOUCH ──────────────────────────────
   *
   * This union is closed on purpose, so emitting these required extending the type — which is exactly the
   * forcing function the closed union exists to be, and also why the omission survived: the facility was
   * there, the vocabulary was not.
   *
   * ⚠ THESE ARE THE TWO QUESTIONS AN INVESTIGATOR COULD NOT ANSWER LOCALLY. Not "what did the agent
   * do" — `agent.spawn` and `file.mutate` cover that — but "why was it ALLOWED to", which is a
   * different and longer-lived fact. A spawn is a moment; a grant persists and keeps applying.
   */
  /**
   * A filesystem boundary was widened: a project root was added, or the confinement fence was
   * repointed.
   *
   * `db:addProject`'s own comment calls its row "a BOUNDARY GRANT, not just a record — an insert here
   * widens what the file, git and spawn handlers will touch — and PERSISTENTLY", and
   * `files:commitProjectPath` rewrites the `project_path` setting `allowedRoots()` builds the fence
   * from. Neither file even imported this module.
   */
  | "project.grant"
  /**
   * A folder was vouched for to the agent CLI, so its own `permissions.allow` is honoured without
   * prompting.
   *
   * ⚠ THE ONE EVENT WHOSE SUBJECT IS OUTSIDE THIS APP'S OWN STORAGE. `cli:trustWorkspace` writes
   * `hasTrustDialogAccepted` into `~/.claude.json` — OS-global, shared with every other use of Claude
   * Code by this user, and with no revocation path anywhere in the app. So this record is the only
   * trace that a grant with that reach was ever made, which is why it records refusals too.
   */
  | "agent.trust"
  /**
   * The log was trimmed to its bound.
   *
   * ⚠ A REAL RECORD, NOT AN ANNOTATION, and that distinction is the whole of finding F4. Rotation used
   * to prepend an unhashed `{carried: true, continuesFrom: <hash>}` line, and the verifier re-seeded
   * its expectations from that line's own fields. So deleting record k took two edits: remove it, and
   * write a marker whose `continuesFrom` is k's hash — a value sitting in plain sight as record k+1's
   * `prev`. The chain then verified clean. The one property this log claims, tamper-EVIDENCE, did not
   * hold against the exact threat its header names.
   */
  | "log.rotated";

/**
 * ── ⚠ THE EVENTS A RENDERER CAN EMIT AS FAST AS IT LIKES ───────────────────────────────────────
 *
 * The refusal path is budgeted (`REFUSAL_BUDGET`, below) and the SUCCESS path deliberately is not —
 * the justification there is sound and stands: "a legitimate agent run emits hundreds of genuine
 * file.mutate records in a burst", and coalescing those would lose the very sequence an investigator
 * needs. What the justification missed is that `fileOps:createFile` and `fileOps:createFolder` are
 * renderer-driven, rate-limit-free, and cost one record each — so ~2000 calls inside the already-granted
 * project push out every earlier `auth.signin`, `project.grant`, `agent.trust`, `agent.spawn`,
 * `tool.permission` and `chat.share`, and rotation re-chains the survivors so `verifyAuditChain` still
 * reports the file intact. Erasure indistinguishable from ordinary trimming.
 *
 * ⚠ SO THE FIX IS IN THE RETENTION POLICY, NOT IN THE WRITE PATH. Throttling successes would trade one
 * kind of blindness for another; partitioning the retained window means a flood of these can only ever
 * evict OTHER records of the same kind. Volume is a property of the event, so it is declared beside the
 * union rather than computed at the rotation site.
 *
 * ⚠ AND THE MEMBERSHIP RULE IS "CAN THE RENDERER CAUSE MANY OF THESE PER SECOND", not "is it
 * unimportant". `file.mutate` is how "the agent deleted my work" gets answered and it is kept — just
 * not at the cost of the records that say what the agent was ALLOWED to do, which are human-paced and
 * unrecoverable. A new event belongs here only if a caller can emit it in a loop without a user gesture.
 */
const HIGH_VOLUME_EVENTS: ReadonlySet<SecurityAuditEvent> = new Set<SecurityAuditEvent>([
  "file.mutate",
  "docs.change",
]);

/** True when a flood of this event must not be able to evict the decision records. */
function isHighVolume(event: SecurityAuditEvent): boolean {
  return HIGH_VOLUME_EVENTS.has(event);
}

export type SecurityAuditOutcome = "success" | "failure" | "refused";

/** One line of the log. Field names are short because every record repeats them. */
export interface SecurityAuditRecord {
  /** 1-based, contiguous. A gap is evidence. */
  seq: number;
  at: string;
  event: SecurityAuditEvent;
  outcome: SecurityAuditOutcome;
  /** Cognito `sub` when known. Never an email or a name. */
  userId?: string;
  /** A short reason code. Never free text from a server, a token, or a path. */
  detail?: string;
  /** The previous record's `hash`, or "genesis" for the first. */
  prev: string;
  /** sha256 over the canonical form of everything above. */
  hash: string;
}

/** In-memory tail of the chain, so the common case needs no read of the file. */
let lastSeq = 0;
let lastHash = "genesis";
let loaded = false;
/**
 * ── ⚠ THE LINE COUNT IS TRACKED, NOT RECOUNTED ────────────────────────────────────────────────
 *
 * Rotation needs to know how many records the file holds. Reading and splitting the whole log to find
 * out — which is what this did first — makes every append cost O(n) and a session O(n²): measured at
 * ~4.6s to write 2000 records, nearly all of it re-reading a growing file. A size gate only DELAYED
 * that, because past the threshold every single append read again.
 *
 * So the count is established once (`loadTail`) and maintained from there. The file is read only when
 * a rotation actually happens, which is once per 2000 events.
 */
let lineCount = 0;
/**
 * Whether the file is known to end in a newline.
 *
 * Only the FIRST write of a process has to look: a crash could have left a partial line, but every
 * subsequent append is one this process made and terminated itself.
 */
let endsClean: boolean | null = null;

function logPath(): string {
  return path.join(app.getPath("userData"), LOG_FILE);
}

/**
 * The bytes that get hashed.
 *
 * ⚠ NOT `JSON.stringify(record)`. Key order in a JSON object is an implementation detail, and a
 * verifier that re-serialised differently from the writer would report tampering on an untouched
 * file. An explicit, ordered, delimited string cannot drift that way.
 *
 * `\u0000` as the separator: it cannot occur in any of these fields, so no combination of values can
 * be arranged to produce the same digest as a different combination.
 */
function canonical(r: Omit<SecurityAuditRecord, "hash">): string {
  return [r.seq, r.at, r.event, r.outcome, r.userId ?? "", r.detail ?? "", r.prev].join("\u0000");
}

function hashOf(r: Omit<SecurityAuditRecord, "hash">): string {
  return createHash("sha256").update(canonical(r), "utf8").digest("hex");
}

/**
 * A filesystem path reduced to something safe to write into this log.
 *
 * ── ⚠ WHY NOT THE PATH ITSELF ──
 *
 * The header of this file promises no file contents, no names, no email addresses — and a full path
 * breaks that promise sideways. `/Users/jane.doe/clients/acme-merger/valuation.xlsx` is a person's
 * name, an employer's name and a confidential project in one string, written to a PLAINTEXT file
 * that is easier to read than the encrypted database. It is also the exact string an attacker
 * chooses, so echoing it makes this log an injection sink for anything that later renders it.
 *
 * The basename answers the question an audit trail is for — "what did it touch, in what order" —
 * without carrying the directory tree that identifies the person and the work. The separator is
 * checked for both platforms because a Windows path never appears in a POSIX `path.basename`.
 *
 * ⚠ AND IT IS BOUNDED. A 4,000-character name would push the rest of the record off a terminal and
 * make the log expensive to scan; 64 characters is more than any real filename and enough to
 * recognise one.
 */
export function redactedTarget(target: unknown): string {
  if (typeof target !== "string" || target.length === 0) return "unknown";
  const parts = target.split(/[/\\]/).filter(Boolean);
  const name = parts[parts.length - 1] ?? "unknown";
  // Control characters would corrupt a JSONL line's readability; NUL would corrupt the digest input.
  return name.replace(/[\x00-\x1f]/g, "").slice(0, 64) || "unknown";
}

/**
 * ── ⚠ THE AUDITED SUBJECT, HELD TO THE SAME RULE AS EVERY OTHER FIELD ─────────────────────────
 *
 * `userId` was spread into the record and into `canonical()` verbatim, and both of those handlers take it
 * straight from the renderer with no `isSafeRowId`, no `typeof`, no length bound and no control-character
 * strip.
 *
 * ⚠ IT BREAKS AN INVARIANT THIS MODULE STATES ABOUT ITSELF, which is why it is worth more than its
 * severity label. `canonical()` joins fields with `\x00` on the written assumption that NUL "cannot
 * occur in any of these fields, so no combination of values can be arranged to produce the same digest
 * as a different combination". A renderer-supplied `userId` containing NUL violates exactly that — and
 * the module already applies this hygiene to its OTHER renderer-influenced field: `redactedTarget`
 * strips control characters and truncates, with the comment "NUL would corrupt the digest input".
 * `userId` was the one field the module's own rule was not applied to.
 *
 * ⚠ APPLIED HERE, AT THE SINK, NOT AT THE TWO REPORTED CALL SITES. Those two are where the finding was
 * observed; this is where the guarantee belongs. Every caller of this function writes into a hashed
 * chain, so the normalisation has to hold for the next caller nobody has written yet — and the two
 * handlers additionally gain an `isSafeRowId` gate of their own, which is a different claim ("that is
 * not a plausible account id") from this one ("no field can corrupt the digest input").
 *
 * ⚠ NOT `redactedTarget`, DESPITE THE SIMILARITY. That function reduces a path to its basename, which
 * would silently mangle any id containing a slash into something that is not the id — a subject must
 * survive normalisation recognisably or the record names nobody. Same two protections, no path
 * semantics.
 *
 * ⚠ AND AN EMPTY RESULT IS DROPPED RATHER THAN WRITTEN. A `userId` of `""` in the record would claim a
 * subject the log does not have; the spread above omits the field entirely, which is how "no subject"
 * has always been represented.
 */
const MAX_SUBJECT_LENGTH = 64;

function normalisedSubject(userId: unknown): string | undefined {
  if (typeof userId !== "string" || userId.length === 0) return undefined;
  const clean = userId.replace(/[\x00-\x1f]/g, "").slice(0, MAX_SUBJECT_LENGTH);
  return clean || undefined;
}

/**
 * Adopt the tail of an existing log so a restart CONTINUES the chain.
 *
 * ⚠ WITHOUT THIS, EVERY LAUNCH WOULD LOOK LIKE TAMPERING: the sequence would restart at 1 and `prev`
 * at "genesis" mid-file, which is exactly the signature of a truncated log.
 *
 * A trailing partial line (a crash mid-append) is discarded rather than treated as corruption: the
 * chain continues from the last COMPLETE record, and the partial line's absence from the chain is
 * itself visible to the verifier.
 */
function loadTail(): void {
  loaded = true;
  try {
    const file = logPath();
    if (!fs.existsSync(file)) return;
    const raw = fs.readFileSync(file, "utf-8");
    // Both facts come from the read we are already doing, rather than from extra syscalls later.
    endsClean = raw.length === 0 || raw.endsWith("\n");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    lineCount = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const rec = JSON.parse(lines[i]) as SecurityAuditRecord;
        if (typeof rec?.seq === "number" && typeof rec?.hash === "string") {
          lastSeq = rec.seq;
          lastHash = rec.hash;
          return;
        }
      } catch {
        // Partial or corrupt last line — step back and continue from the last good one.
      }
    }
  } catch (err) {
    // A log that cannot be read must not stop the app; the chain restarts and the verifier says so.
    debugLog("[security-audit] could not read existing log:", err instanceof Error ? err.message : err);
  }
}

/**
 * Keep the file bounded, without silently orphaning the chain.
 *
 * ⚠ ROTATION WRITES A `carried` MARKER as its first line, naming the hash and sequence the surviving
 * records continue from. Otherwise a trimmed log is indistinguishable from a tampered one — the first
 * remaining record would reference a `prev` that appears nowhere, which is precisely what deleting a
 * line looks like. The marker makes an honest trim honest.
 */
function rotateIfNeeded(file: string): void {
  /**
   * ⚠ THE TRACKED COUNT DECIDES, so the ordinary append does no reading at all. Reaching past this
   * line happens once per `maxLines` events; everything before it is arithmetic.
   */
  if (lineCount <= maxLines) return;
  try {
    const raw = fs.readFileSync(file, "utf-8");  // nosemgrep: detect-non-literal-fs-filename
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length <= maxLines) return;

    /**
     * ── ⚠ TRIM TO A LOW WATERMARK, SO ROTATION IS AMORTISED RATHER THAN PER-EVENT ─────────────
     *
     * This was `lines.slice(-maxLines)`, and the file written back is the `log.rotated` MARKER **plus** those
     * survivors — so the new chain was `maxLines + 1` long, `lineCount = chain.length` was set to that, and
     * the very next event re-entered this function's slow path. It never returned to a state below its own
     * trigger.
     *
     * ⚠ THE COST WAS PER AUDITED ACTION, ON THE MAIN PROCESS. With `MAX_AUDIT_LINES = 2000`, an
     * install past 2000 events paid a ~300 KB `readFileSync`, a `JSON.parse` per line, 2001 fresh
     * SHA-256 digests and a ~300 KB `writeWholeFile` — synchronously, on every `recordSecurityEvent`
     * — which freezes the UI. The guard above could not save it either: with 2001 lines on disk,
     * `lines.length <= maxLines` is false. It also meant continuous rewriting of the one file that is
     * supposed to be the durable record of boundary grants.
     *
     * ⚠ AND `maxLines - 1` WOULD NOT HAVE BEEN ENOUGH, which is worth writing down because it is the
     * obvious one-line fix. It does return the chain to exactly `maxLines`, clearing the trigger —
     * but the very next append pushes it to `maxLines + 1` again, so the file is still re-read,
     * re-hashed and rewritten on essentially every event from then on. Only trimming BELOW the bound
     * buys events between rotations.
     *
     * 80% is the watermark: it keeps the overwhelming majority of the window while making rotation
     * cost one read+rewrite per ~20% of `maxLines` events — ~400 at the production bound. That is
     * what makes this function's own claim above ("once per `maxLines` events") approximately true
     * instead of false. Clamped to `maxLines - 1` so the marker always fits, and floored at 0 so a
     * bound of 1 in a test cannot produce a chain longer than the bound.
     */
    const keep = Math.max(0, Math.min(maxLines - 1, Math.floor(maxLines * 0.8)));

    const parsed: SecurityAuditRecord[] = [];
    for (const line of lines) {
      try {
        const rec = JSON.parse(line) as SecurityAuditRecord;
        if (typeof rec?.seq === "number" && typeof rec?.event === "string") parsed.push(rec);
      } catch {
        /* A corrupt line is dropped rather than carried into the new chain. */
      }
    }

    /**
     * ── ⚠ THE WINDOW IS PARTITIONED BY EVENT CLASS, NOT A FLAT `slice(-keep)` ──────────────────
     *
     * This was `lines.slice(-keep)`: pure recency, so the cheapest event on the cheapest channel decided what
     * survived. ~2000 `fileOps:createFile` calls — renderer-driven, no rate limit, one `file.mutate` each —
     * evicted every `auth.signin`, `project.grant`, `agent.trust`, `agent.spawn`, `tool.permission` and
     * `chat.share` before them, and because the survivors are re-chained the result verifies clean. That is
     * erasure that looks exactly like housekeeping.
     *
     * ⚠ DECISIONS ARE SEATED FIRST, THEN THE REMAINING BUDGET GOES TO VOLUME. So a flood can only
     * ever push out other high-volume records, which is the property that was missing. Nothing is
     * given unlimited retention: a run of decision records past `keep` still trims to the newest
     * `keep` of them, because no bounded file can promise otherwise and pretending it could would be
     * the more dangerous lie.
     *
     * ⚠ CHRONOLOGICAL ORDER IS RESTORED BY INDEX, not by re-sorting on `at`. Timestamps come from
     * records that were already on disk, so two events inside one millisecond, a clock stepped
     * backwards by NTP, or a hand-edited `at` would all reorder the chain — and a chain whose order
     * depends on a field the file itself supplies is not evidence of anything. The read order is the
     * only ordering this function can vouch for.
     */
    /**
     * ⚠ PRIOR ROTATION MARKERS ARE DROPPED, NOT CARRIED — AND THE PARTITION IS WHY THIS HAD TO CHANGE.
     *
     * A `log.rotated` record is not a security decision; it is this module talking about itself. Under
     * the old flat window that only made it mild noise. Under the partition it is actively corrosive:
     * every trim mints one, markers are not high-volume, so they accrue in the DECISION budget and
     * squeeze out the very records the partition exists to protect — self-perpetuating, and worse the
     * longer the log lives. Measured before this line existed: a flood left 16 `file.mutate` where the
     * budget should have allowed ~26, the difference being accumulated markers.
     *
     * The new marker written below supersedes them, and its `trimmed:` count already covers the ones
     * dropped here, so nothing is lost that was not already double-counted. `rotations:` keeps the one
     * fact the stale markers were carrying — how many times this log has been trimmed.
     */
    const priorRotations = parsed.filter((rec) => rec.event === "log.rotated").length;
    const retainable = parsed.filter((rec) => rec.event !== "log.rotated");

    const decisionIdx: number[] = [];
    const volumeIdx: number[] = [];
    retainable.forEach((rec, i) => (isHighVolume(rec.event) ? volumeIdx : decisionIdx).push(i));

    // ⚠ `slice(-0)` is `slice(0)` — the WHOLE array, not none. Zero has to be explicit, twice.
    const newest = (idx: readonly number[], n: number) => (n > 0 ? idx.slice(-n) : []);
    const kept = new Set<number>(newest(decisionIdx, keep));
    for (const i of newest(volumeIdx, Math.max(0, keep - kept.size))) kept.add(i);

    const survivors = retainable.filter((_, i) => kept.has(i));
    const decisionsKept = survivors.filter((r) => !isHighVolume(r.event)).length;
    const dropped = lines.length - survivors.length;

    /**
     * ── ⚠ THE WHOLE WINDOW IS RE-CHAINED BEHIND A REAL RECORD ────────────────────────────────
     *
     * The old rotation left the first surviving record pointing at the hash of a record it had just
     * deleted, and asked the verifier to accept an unauthenticated marker as the explanation. That is
     * what made a forged marker equivalent to an honest one.
     *
     * Now the marker is an ordinary record — hashed, sequenced, `prev: "genesis"` — and every survivor
     * is re-linked behind it, so the file is ONE unbroken chain from byte zero. The verifier needs no
     * special case at all, which is the point: there is nothing left for it to trust.
     *
     * ⚠ WHAT THIS DOES NOT CLAIM. Nothing here defeats an attacker who is willing to recompute the
     * whole chain — an unkeyed hash chain on a file its owner can rewrite cannot. What it removes is
     * the SHORTCUT: deleting a record now requires re-deriving every hash after it, instead of copying
     * one value that was already visible two lines away. The header's claim is "evident", not
     * "prevented", and that is now true for the rotation path as well as the append path.
     *
     * ⚠ AND THE SEQUENCE RESTARTS AT 1, deliberately. Contiguity is what makes a gap evidence, so the
     * new chain has to be contiguous; carrying the original numbers forward would leave a permanent
     * hole at the front that is indistinguishable from a deletion. The count that was dropped is
     * recorded in the marker instead — the information is kept, in a place that is covered by a hash.
     */
    const at = new Date().toISOString();
    const marker: Omit<SecurityAuditRecord, "hash"> = {
      seq: 1,
      at,
      event: "log.rotated",
      outcome: "success",
      /**
       * ⚠ THE DECISION COUNT IS PART OF THE RECORD. "kept 1600" does not distinguish a healthy trim
       * from one that discarded every sign-in to make room for a flood of file writes; "decisions-12"
       * does, and it is the number an investigator reading a suspiciously round log wants first.
       * The `trimmed:…-dropped:kept-…` prefix is unchanged — a test pins it.
       */
      detail:
        `trimmed:${dropped}-dropped:kept-${survivors.length}` +
        `-decisions:${decisionsKept}-rotations:${priorRotations + 1}`,
      prev: "genesis",
    };
    const chain: SecurityAuditRecord[] = [{ ...marker, hash: hashOf(marker) }];

    for (const survivor of survivors) {
      const bare: Omit<SecurityAuditRecord, "hash"> = {
        seq: chain.length + 1,
        at: survivor.at,
        event: survivor.event,
        outcome: survivor.outcome,
        ...(survivor.userId ? { userId: survivor.userId } : {}),
        ...(survivor.detail ? { detail: survivor.detail } : {}),
        prev: chain[chain.length - 1].hash,
      };
      chain.push({ ...bare, hash: hashOf(bare) });
    }

    writeWholeFile(file, chain.map((r) => JSON.stringify(r)).join("\n") + "\n");

    // The in-memory tail now describes the rewritten file, not the one that was read.
    lineCount = chain.length;
    lastSeq = chain[chain.length - 1].seq;
    lastHash = chain[chain.length - 1].hash;
    endsClean = true;
  } catch (err) {
    debugLog("[security-audit] rotation failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * Does the file end in a newline (or not exist / not be readable)?
 *
 * Reads the last byte only — this runs on every append, and reading a 2000-line log to answer a
 * one-byte question would make the audit log's cost grow with its length.
 */
function endsWithNewline(file: string): boolean {
  try {
    const { size } = fs.statSync(file);  // nosemgrep: detect-non-literal-fs-filename
    if (size === 0) return true; // a new or empty file needs no separator
    const fd = fs.openSync(file, "r");  // nosemgrep: detect-non-literal-fs-filename
    try {
      const buf = Buffer.alloc(1);
      fs.readSync(fd, buf, 0, 1, size - 1);  // nosemgrep: detect-non-literal-fs-filename
      return buf[0] === 0x0a;
    } finally {
      fs.closeSync(fd);  // nosemgrep: detect-non-literal-fs-filename
    }
  } catch {
    // Cannot tell — assume it does, so the normal path is not penalised by a stat failure.
    return true;
  }
}

/** Replace the file's contents, preserving the restrictive mode. */
function writeWholeFile(file: string, contents: string): void {
  // `mode` on writeFileSync applies only when CREATING, so an existing 0644 file would keep its
  // permissions. The explicit chmod is what actually narrows it.
  fs.writeFileSync(file, contents, { encoding: "utf-8", mode: AUDIT_FILE_MODE });  // nosemgrep: detect-non-literal-fs-filename
  try {
    fs.chmodSync(file, AUDIT_FILE_MODE);  // nosemgrep: detect-non-literal-fs-filename
  } catch {
    /* Windows has no POSIX mode; the write above is still correct there. */
  }
}

/**
 * ── ⚠ A FLOOD OF IDENTICAL REFUSALS MUST NOT EVICT THE HISTORY ─────────────────────────────────
 *
 * Several channels emit one record per invocation with no state change and no rate limit —
 * `cli:trustWorkspace`/`cli:untrustWorkspace` write an `agent.trust` refusal for any path failing
 * `isOpenProjectRoot`, and `auth:completeSignIn` writes an `auth.signin` refusal for any non-empty string,
 * because the issuer check is local and precedes any network call. So ~2000 cheap calls pushed every genuine
 * `auth.signin`, `project.grant`, `agent.trust`, `chat.share`, `agent.spawn` and `file.mutate` record out of
 * the retained window.
 *
 * ⚠ THIS BOUNDS THE APPENDS, IT DOES NOT DROP THE FACT. Under attack the log ends up STRICTLY more
 * useful than before: ~15 records saying "this refusal happened, most recently as occurrence 1024"
 * plus ~1985 preserved genuine records, instead of 2000 identical lines and no history at all.
 *
 * ⚠ REFUSALS ONLY, and the asymmetry is the justification rather than a convenience. A refusal by
 * definition CHANGED NOTHING, so N identical ones carry the information of one plus a count. A
 * success is a distinct state transition and every one keeps its own line.
 *
 * ⚠ AND ONLY BEYOND A BURST, so ordinary use is recorded verbatim. A participant who mistypes a
 * folder twice, or a handful of refusals in a minute, appear individually exactly as before; only a
 * run longer than `COALESCE_AFTER` starts thinning, and then only to powers of two — which always
 * writes the tail, so the largest observed count is never lost.
 */
const COALESCE_WINDOW_MS = 60_000;
const COALESCE_AFTER = 8;
/** Bounded like every other cache here: distinct refusal shapes are few in any real session. */
const MAX_COALESCE_KEYS = 64;
const refusalBursts = new Map<string, { at: number; count: number }>();

/**
 * ── ⚠ AND A CEILING ON REFUSALS PER WINDOW, WHATEVER SHAPE THEY TAKE ───────────────────────────
 *
 * ⚠ THE PER-SHAPE THINNING ABOVE IS NOT SUFFICIENT ON ITS OWN, and the reason is worth writing down
 * because it is easy to miss: it keys on `detail`, and the loudest of the reported channels supplies
 * an ATTACKER-VARIED one. `cli:trustWorkspace`'s refusal records
 * `detail: declined:${redactedTarget(folderPath)}` — the basename of a caller-supplied path — so a
 * caller that varies the path gets a fresh key every time and never reaches a burst threshold.
 *
 * This is the backstop that holds regardless: at most `REFUSAL_BUDGET` refusal records per window, no
 * matter how many distinct shapes they arrive in. 2000 varied refusals therefore cost ~64 lines rather
 * than 2000, which cannot evict a 2000-line window.
 *
 * ⚠ REFUSALS ONLY — successes are never budgeted. A legitimate agent run emits hundreds of genuine
 * `file.mutate` records in a burst, and a global cap that swallowed those would lose exactly the
 * history this log exists for. A refusal changed nothing by definition; a success is a state change.
 *
 * ⚠ THE THROTTLE ANNOUNCES ITSELF IN THE LOG. The first record over budget is still written, carrying
 * `throttled-after:<n>`, so a reader can never mistake a throttled window for a quiet one — and the
 * running total is attached to the first refusal of the following window. That second half is
 * best-effort: a flood that stops dead and is never followed by another refusal leaves its final count
 * unreported. The bound is the guarantee; the exact tally is a courtesy.
 */
const REFUSAL_BUDGET = 64;
let refusalWindowAt = 0;
let refusalsInWindow = 0;
let refusalsDropped = 0;

/**
 * How many times this exact refusal has repeated inside the window, and whether to write it.
 *
 * Keyed on the NORMALISED subject rather than the raw one, so invisible characters cannot be used to
 * make one repeated refusal look like many distinct ones and slip past the bound.
 */
function refusalBurst(input: {
  event: SecurityAuditEvent;
  userId?: string;
  detail?: string;
}): { write: boolean; count: number } {
  const now = Date.now();
  const key = `${input.event}|${String(input.detail ?? "").slice(0, 200)}|${normalisedSubject(input.userId) ?? ""}`;
  const prev = refusalBursts.get(key);
  const count = prev && now - prev.at < COALESCE_WINDOW_MS ? prev.count + 1 : 1;

  if (!refusalBursts.has(key) && refusalBursts.size >= MAX_COALESCE_KEYS) {
    // Insertion order: `set` on an existing key does not reorder, so this is the oldest first seen.
    const oldest = refusalBursts.keys().next().value as string | undefined;
    if (oldest !== undefined) refusalBursts.delete(oldest);
  }
  refusalBursts.set(key, { at: now, count });

  // Verbatim up to the threshold, then powers of two — 1..8, 16, 32, 64, … 1024.
  return { write: count <= COALESCE_AFTER || (count & (count - 1)) === 0, count };
}

/**
 * Record one security event. Best-effort and never throws.
 *
 * ⚠ A FAILURE HERE MUST NOT FAIL THE OPERATION BEING AUDITED. If the disk is full, the right
 * outcome is a sign-in that works with a gap in the log — not a user locked out by their audit
 * trail. The gap is visible: sequence numbers are contiguous by construction, so a skipped write
 * shows up as a jump.
 */
export function recordSecurityEvent(input: {
  event: SecurityAuditEvent;
  outcome: SecurityAuditOutcome;
  userId?: string;
  detail?: string;
}): void {
  try {
    if (!loaded) loadTail();

    /** See `refusalBurst` and `REFUSAL_BUDGET`: a refusal flood must not evict the history. */
    let detail = input.detail;
    if (input.outcome === "refused") {
      const burst = refusalBurst(input);
      if (!burst.write) return;
      /**
       * The count is carried IN the record, so a thinned run is self-describing — an investigator
       * reading `declined:notes x256` learns both what happened and that it happened a lot.
       */
      if (burst.count > COALESCE_AFTER) detail = `${detail ?? "repeated"} x${burst.count}`;

      const now = Date.now();
      if (now - refusalWindowAt >= COALESCE_WINDOW_MS) {
        refusalWindowAt = now;
        refusalsInWindow = 0;
        // Carried across the boundary so the tally is not silently forgotten.
        if (refusalsDropped > 0) {
          detail = `${detail ?? "refused"} dropped:${refusalsDropped}`;
          refusalsDropped = 0;
        }
      }
      if (refusalsInWindow >= REFUSAL_BUDGET) {
        refusalsDropped++;
        // Exactly one record announces the throttle; the rest of the window is silent.
        if (refusalsDropped > 1) return;
        detail = `${detail ?? "refused"} throttled-after:${REFUSAL_BUDGET}`;
      }
      refusalsInWindow++;
    }

    const bare: Omit<SecurityAuditRecord, "hash"> = {
      seq: lastSeq + 1,
      at: new Date().toISOString(),
      event: input.event,
      outcome: input.outcome,
      ...(normalisedSubject(input.userId) ? { userId: normalisedSubject(input.userId) } : {}),
      ...(detail ? { detail } : {}),
      prev: lastHash,
    };
    const record: SecurityAuditRecord = { ...bare, hash: hashOf(bare) };

    const file = logPath();
    /**
     * ⚠ OPENED WITH AN EXPLICIT MODE, then chmod'd. `appendFileSync(file, data)` creates with 0666
     * masked by the umask — commonly 0644 — and applies no mode at all to an existing file, which is
     * how a log created by an earlier build stays world-readable for ever.
     */
    const fd = fs.openSync(file, "a", AUDIT_FILE_MODE);
    try {
      /**
       * ⚠ A LEADING NEWLINE WHEN THE FILE DOES NOT END IN ONE. Found by a test rather than by
       * reading: a crash between `openSync` and the newline leaves a partial last line, and a plain
       * append then CONCATENATES the next record onto it — turning one damaged line into two,
       * losing a real record and leaving the chain broken with no way to tell truncation from
       * tampering. `loadTail` already steps over a partial line on read; this is the write side of
       * the same problem.
       */
      /**
       * ⚠ THE NEWLINE CHECK RUNS AT MOST ONCE PER PROCESS. `endsClean` is null only before the first
       * write, when a crash may have left a partial line; after that this process wrote every byte and
       * knows each one ended in a newline. A per-append check was four syscalls to re-learn a fact we
       * already had.
       */
      if (endsClean === null) endsClean = endsWithNewline(file);
      fs.writeSync(fd, (endsClean ? "" : "\n") + JSON.stringify(record) + "\n");
      endsClean = true;
    } finally {
      fs.closeSync(fd);
    }
    lineCount += 1;
    try {
      fs.chmodSync(file, AUDIT_FILE_MODE);
    } catch {
      /* not POSIX */
    }

    lastSeq = record.seq;
    lastHash = record.hash;

    rotateIfNeeded(file);
  } catch (err) {
    debugLog("[security-audit] write failed:", err instanceof Error ? err.message : err);
  }
}

export interface AuditVerification {
  ok: boolean;
  records: number;
  /** 1-based sequence of the first record that does not verify, if any. */
  brokenAt?: number;
  reason?: string;
}

/**
 * Re-walk the chain and report whether it is intact.
 *
 * ⚠ THIS IS THE WHOLE POINT OF THE `prev`/`hash` PAIR. Without a verifier the chain is decoration —
 * nobody would ever discover a broken link by eye, and an integrity mechanism nobody can check is
 * indistinguishable from none.
 */
export function verifyAuditChain(contents: string): AuditVerification {
  const lines = contents.split("\n").filter((l) => l.trim().length > 0);
  let expectedPrev = "genesis";
  let expectedSeq = 1;
  let count = 0;

  for (const line of lines) {
    let rec: SecurityAuditRecord;
    try {
      rec = JSON.parse(line);
    } catch {
      return { ok: false, records: count, brokenAt: expectedSeq, reason: "unparseable line" };
    }

    /**
     * ⚠ THERE IS NO SPECIAL CASE ANY MORE, and its absence is the fix. This branch used to accept a
     * `{carried: true}` line and re-seed `expectedPrev`/`expectedSeq` from that line's own unhashed
     * fields — so a forged marker made a deleted record verify clean. Rotation now writes a `log.rotated`
     * record that is hashed and chained like every other, and re-links the survivors behind it, so the
     * file is one unbroken chain and this walk is the only thing that has to be right.
     */

    if (rec.seq !== expectedSeq) {
      return {
        ok: false,
        records: count,
        brokenAt: expectedSeq,
        reason: `expected seq ${expectedSeq}, found ${rec.seq} — a record was removed or reordered`,
      };
    }
    if (rec.prev !== expectedPrev) {
      return { ok: false, records: count, brokenAt: rec.seq, reason: "prev hash does not match the previous record" };
    }
    const { hash, ...bare } = rec;
    if (hashOf(bare as Omit<SecurityAuditRecord, "hash">) !== hash) {
      return { ok: false, records: count, brokenAt: rec.seq, reason: "record contents do not match their hash" };
    }

    expectedPrev = hash;
    expectedSeq = rec.seq + 1;
    count++;
  }

  return { ok: true, records: count };
}

/** Absolute path to the log, for the "reveal in folder" affordance and for tests. */
export function auditLogPath(): string {
  return logPath();
}

/** Test seam: the in-memory chain tail would otherwise leak between cases. */
export function __resetAuditState(): void {
  lastSeq = 0;
  lastHash = "genesis";
  loaded = false;
  lineCount = 0;
  endsClean = null;
  maxLines = MAX_AUDIT_LINES;
  // Burst and budget state are per process in production; between cases they would be cross-talk.
  refusalBursts.clear();
  refusalWindowAt = 0;
  refusalsInWindow = 0;
  refusalsDropped = 0;
}
