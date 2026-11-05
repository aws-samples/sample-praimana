import { Hono } from "hono";
import { edgeIdentityMiddleware, requireIdentity } from "@praimana/service-shared";
import type {
  DocStore,
  DocPointerRepository,
  TeamLookup,
  IncomingDoc,
  UsersReadModel,
} from "./domain.js";
import {
  requireTeamRead,
  requireTeamWrite,
  type TeamMembership,
} from "./authz.js";
import { admitPath, admitUpload, MAX_UPLOAD_BYTES } from "./upload-policy.js";

/**
 * How long a presigned upload URL stays valid.
 *
 * Long enough for 20MB on a workshop-venue connection (5 minutes covers ~550kbps),
 * short enough that a URL captured from a log or a shoulder-surfed screen is useless
 * by the time anyone tries it. It grants a write to ONE key at ONE size, never a read.
 */
const UPLOAD_URL_TTL_SECONDS = 300;

/**
 * Bounds on the git-sync ingest, which had none.
 *
 * The desktop sends every `.md` in the repository in one request, so this array grows
 * with the team's repo and each element is a whole file body. Unbounded, one sync of a
 * docs-heavy repo is a multi-megabyte request that issues one S3 Put per element —
 * over the Lambda payload ceiling and slow enough to time out, with a partially
 * written result.
 */
const MAX_SYNC_FILES = 200;
const MAX_SYNC_FILE_BYTES = 1024 * 1024;

/**
 * Docs service routes. Constructor-style dependency injection: routes depend on
 * INTERFACES (DocStore, DocPointerRepository, TeamLookup, TeamMembership) passed
 * in, never on the AWS SDK. Wiring lives in app.ts; tests pass in-memory fakes.
 *
 * Mounted under basePath /v1 so it is a drop-in behind the gateway. Stores every
 * committed `.md` under S3 key workshop/<workshopId>/team/<teamId>/<path> with S3
 * object versioning providing the content history.
 */
export interface DocsDeps {
  store: DocStore;
  pointers: DocPointerRepository;
  teams: TeamLookup;
  membership: TeamMembership;
  /**
   * Resolves a `lastAuthor` id to a display name.
   *
   * OPTIONAL so this service still composes where the read-model is not wired, and so the existing
   * tests need no new fake. When absent, ids are returned as they are stored — the previous
   * behaviour, which is wrong but not worse than failing the request.
   */
  users?: UsersReadModel;
}

/**
 * Turn stored `lastAuthor` IDS into names, in place of the raw Cognito subs a reader was seeing.
 *
 * ── THE BUG THIS FIXES ──
 *
 * An uploaded file listed its author as `94c89498-90e1-7070-dd34-b71a17076f4c`. `lastAuthor` holds
 * whatever the writer supplied and the upload route supplies the caller's identity id, so a
 * hand-uploaded file always showed a sub. (A git-synced file shows a git author NAME, because the
 * desktop sends one — which is why this looked like an upload-only problem when it is really "this
 * field holds two different kinds of value".)
 *
 * ── THE TWO KINDS OF VALUE, AND WHY THAT DECIDES THE SHAPE ──
 *
 * `lastAuthor` is either a Cognito sub (uploads) or a git author name (syncs). So this cannot simply
 * replace the field: looking up "Alice Smith" in a users read-model returns nothing, and blanking it
 * would DELETE the only attribution a synced file has.
 *
 * Hence: an ADDITIVE `lastAuthorName`, set only when the id actually resolves. A reader prefers it
 * and falls back to `lastAuthor`, so a git name still shows and a resolvable sub becomes a name.
 * Nothing is lost and nothing is invented.
 *
 * ONE LOOKUP PER DISTINCT AUTHOR, not per file: a team whose twelve documents were all uploaded by
 * one person costs one Get. Same rule, and the same reasoning, as the board's assignee enrichment.
 */
async function withAuthorNames<T extends { lastAuthor: string | null }>(
  rows: T[],
  users: UsersReadModel | undefined
): Promise<Array<T & { lastAuthorName?: string }>> {
  if (!users || rows.length === 0) return rows;

  const ids = [
    ...new Set(rows.map((r) => r.lastAuthor).filter((a): a is string => !!a)),
  ];
  const names = new Map<string, string>();
  /**
   * ⚠ FAILURES ARE COUNTED AND LOGGED, AND THAT IS NOT DEFENSIVE PADDING — IT IS THE FIX FOR A REAL
   * BUG THAT HID HERE FOR A WHOLE DEPLOYMENT.
   *
   * The swallow below is right (see its note) but it made a PERMANENT misconfiguration look exactly
   * like a transient one. The docs role was never granted `dynamodb:GetItem` on this read-model, so
   * every lookup threw AccessDeniedException, every row rendered a raw Cognito sub, and nothing
   * anywhere said so. The reported symptom was "the portal shows an id instead of a name" — a UI bug,
   * apparently, three layers away from the actual cause.
   *
   * So: still no throw, but ALL of them failing is now a log line naming the table and the count. A
   * name degrading is a nicety; a name degrading for EVERY row is a broken grant.
   */
  let failures = 0;
  await Promise.all(
    ids.map(async (id) => {
      try {
        const view = await users.get(id);
        if (view?.name) names.set(id, view.name);
      } catch (err) {
        /**
         * A FAILED LOOKUP LEAVES THE ROW ALONE rather than failing the list.
         *
         * The document list is the valuable thing on this response; a name is a nicety. Throwing
         * here would turn a read-model blip into "this team has no documents", which is a far more
         * alarming and less true statement than showing an id.
         */
        failures += 1;
        // ⚠ THE ERROR NAME, NOT THE MESSAGE. `AccessDeniedException` is the whole diagnosis and is
        // safe to log; a full AWS message carries an account id and a role ARN.
        if (failures === 1) {
          console.error("[docs] author-name lookup failed", {
            error: err instanceof Error ? err.name : "unknown",
            event: "author names cannot be resolved — file lists will show raw user ids",
          });
        }
      }
    })
  );
  if (failures > 0 && failures === ids.length) {
    // EVERY lookup failed. That is a configuration fault (a missing IAM grant or a wrong table name),
    // not bad luck, and it is stated as such so the next reader does not go looking in the UI.
    console.error("[docs] EVERY author-name lookup failed", {
      authors: ids.length,
      event:
        "the users read-model is unreachable — check dynamodb:GetItem on TABLE_DOCS_USERS_READMODEL",
    });
  }

  return rows.map((r) => {
    const name = r.lastAuthor ? names.get(r.lastAuthor) : undefined;
    // Omitted, not null, when unresolved — so a reader's `?? lastAuthor` fallback works and a git
    // author name is never overwritten by an absent lookup.
    return name ? { ...r, lastAuthorName: name } : r;
  });
}

/**
 * ── ⚠ A CLIENT-SUPPLIED ATTRIBUTION THAT ATTRIBUTES NOTHING ────────────────────────────────
 *
 * REPORTED: files uploaded via the desktop's "choose from repo" showed their author as "unknown".
 *
 * The desktop defaulted `lastAuthor` and `lastCommitHash` to the literal string `"unknown"` for a file
 * git had never seen committed. Because `"unknown"` is not null, the `?? id` fallback below never
 * fired, and the string was stored as though it were a person's name. That is fixed in the desktop
 * (git.ts now sends null) — but ⚠ THE FIX HAS TO BE HERE AS WELL, because an older installer cannot be
 * forced to update mid-workshop and would keep sending the sentinel.
 *
 * ⚠ AN EXTREMELY NARROW LIST, ON PURPOSE. It is exactly the sentinel a previous client sent, plus the
 * empty string, matched case-insensitively after trimming. It is NOT a general "does this look like a
 * placeholder" heuristic: "n/a", "none", "anonymous" and friends are deliberately absent, because a
 * real git `user.name` could plausibly be any of them, and silently reassigning authorship of a
 * committed file is a worse bug than the one being fixed.
 *
 * The consequence, stated plainly: a git author genuinely named "unknown" is treated as absent, and
 * their file is attributed to whoever uploaded it. That is a real person who really did upload it, so
 * the answer is still true — just less specific than it could be.
 */
const NON_ATTRIBUTIVE = new Set(["", "unknown"]);

function realAttribution(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return NON_ATTRIBUTIVE.has(text.toLowerCase()) ? null : text;
}

/** Build the S3 key for a team's file. Normalizes leading slashes so a path like
 *  "/README.md" or "README.md" both land at the same key. */
function s3Key(workshopId: string, teamId: string, path: string): string {
  const clean = path.replace(/^\/+/, "");
  return `workshop/${workshopId}/team/${teamId}/${clean}`;
}

export function createDocsRoutes(deps: DocsDeps) {
  const docs = new Hono().basePath("/v1");

  // Every request must carry a gateway-injected (or in-service verified) identity.
  docs.use("*", edgeIdentityMiddleware());

  // Ingest: store one or more committed .md files. Called by the desktop app's
  // git:sync. Each file becomes a new S3 object version; the pointer row records
  // the latest versionId for fast listing.
  docs.post("/teams/:teamId/docs", async (c) => {
    const teamId = c.req.param("teamId");
    const denied = await requireTeamWrite(c, deps.membership, teamId);
    if (denied) return denied;

    const { id } = requireIdentity(c);
    const workshopId = await deps.teams.workshopIdForTeam(teamId);
    if (!workshopId) return c.json({ error: "Team not found" }, 404);

    const body = await c.req.json().catch(() => ({}));
    const files: IncomingDoc[] = Array.isArray(body.files) ? body.files : [];
    const now = new Date().toISOString();

    // Bounded, and REFUSED rather than truncated: silently storing the first 200 of
    // 500 files would leave a team believing their docs are synced.
    if (files.length > MAX_SYNC_FILES) {
      return c.json(
        { error: `too many files: ${files.length} exceeds the ${MAX_SYNC_FILES} limit` },
        400
      );
    }

    const stored: string[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    for (const f of files) {
      if (!f?.path || typeof f.content !== "string") continue;

      /**
       * ── ⚠ PATH ADMISSION, WHICH THIS ROUTE ORIGINALLY DID NOT DO AT ALL ──────────────────────
       *
       * `f.path` went straight into `s3Key()` — which strips leading slashes and nothing else — and
       * then into `S3DocStore.put` verbatim, and was ALSO persisted as the pointer row's range key.
       * The only per-file checks were the truthiness test above and the byte cap below. So any ACTIVE
       * team member could write keys containing `..` segments, backslashes, NUL/control characters and
       * unbounded path lengths, into the shared docs bucket and the pointer table.
       *
       * `upload-policy.ts` calls itself "the whole of the upload admission policy" and its header spells
       * out the impact of skipping it ("a path of `../../team/<other>/x.md` would write into ANOTHER
       * TEAM's prefix"). The two presign routes in this same file, behind this same `requireTeamWrite`
       * guard, both call it. This route was the one that did not.
       *
       * ⚠ `admitPath`, NOT `admitUpload`, AND THAT IS DELIBERATE — see the note on `admitPath`.
       * `admitUpload` also applies the four-extension allowlist, and this route legitimately carries a
       * team's repository files: these pointer rows ARE the release snapshot's artifact manifest that
       * judges read, and it routinely contains `src/*.ts`. Enforcing the allowlist here would have
       * closed the hole by breaking the feature.
       *
       * SKIPPED WITH A REASON, not fatal, matching the byte cap immediately below: one malformed path
       * must not stop the rest of a team's documentation from syncing, and the omission is REPORTED so
       * it is visible rather than silent.
       */
      const admitted = admitPath(f.path);
      if (!admitted.ok) {
        skipped.push({ path: f.path, reason: admitted.reason });
        continue;
      }

      // A single oversized file is skipped, not fatal — one huge generated file must
      // not block the rest of a team's documentation from syncing. Reported back so
      // the omission is visible rather than silent.
      if (Buffer.byteLength(f.content, "utf8") > MAX_SYNC_FILE_BYTES) {
        skipped.push({ path: f.path, reason: "file exceeds the per-file sync limit" });
        continue;
      }
      // ⚠ THE ADMITTED PATH, NOT THE RAW ONE, for BOTH the S3 key and the pointer row's range key —
      // the normalisation and the safety check must apply to the same string that gets stored, or the
      // check was decorative.
      const key = s3Key(workshopId, teamId, admitted.path);
      const versionId = await deps.store.put(key, f.content);
      await deps.pointers.put({
        teamId,
        path: admitted.path,
        workshopId,
        s3Key: key,
        versionId,
        // Both run through `realAttribution` so a legacy client's "unknown" sentinel becomes null —
        // see the note there. `lastCommitHash` stays null (there is no commit to name), while
        // `lastAuthor` falls back to the CALLER, who is the one person we can be certain about.
        lastCommitHash: realAttribution(f.lastCommitHash),
        lastAuthor: realAttribution(f.lastAuthor) ?? id,
        updatedAt: now,
      });
      // The ADMITTED path, so the response names the same key that was actually stored.
      stored.push(admitted.path);
    }

    return c.json({ stored: stored.length, paths: stored, skipped }, 201);
  });

  /**
   * ── STEP 1 OF 2: ask permission to upload, and get a URL for it ──────────────
   *
   * POST /v1/teams/:teamId/docs/upload-url  { path, sizeBytes }
   *   → { upload: { url, headers, expiresAt }, path }
   *
   * WHY TWO STEPS RATHER THAN ONE PROXIED UPLOAD. A 20MB file cannot pass through
   * this request path at any limit: API Gateway caps a payload at 10MB and Lambda's
   * synchronous invoke caps at 6MB, neither adjustable, and JSON-encoding a binary
   * body adds ~33%. So the bytes have to go straight to S3.
   *
   * What stays with API Gateway is everything that matters: it is still the only
   * endpoint the client calls, it authorizes team membership, and it — not the client
   * — decides the key, the content type and the byte ceiling. The client receives no
   * AWS credential, only a URL scoped to one key, one content type and one exact
   * size, expiring in minutes.
   *
   * The pointer row is deliberately NOT written here. A row written at presign time
   * would list a file that may never arrive, and the list endpoint would advertise a
   * document that 404s on read. `/upload-complete` writes it after the object exists.
   */
  docs.post("/teams/:teamId/docs/upload-url", async (c) => {
    const teamId = c.req.param("teamId");
    // Membership BEFORE anything else, and the WRITE predicate: a read-only
    // EXECUTIVE may browse a team's docs but must not add to them.
    const denied = await requireTeamWrite(c, deps.membership, teamId);
    if (denied) return denied;

    const workshopId = await deps.teams.workshopIdForTeam(teamId);
    if (!workshopId) return c.json({ error: "Team not found" }, 404);

    const body = await c.req.json().catch(() => ({}));
    const admitted = admitUpload(body.path, body.sizeBytes);
    if (!admitted.ok) return c.json({ error: admitted.reason }, 400);

    const key = s3Key(workshopId, teamId, admitted.path);
    const upload = await deps.store.presignPut({
      key,
      contentType: admitted.contentType,
      maxBytes: body.sizeBytes as number,
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    });

    return c.json({ path: admitted.path, contentType: admitted.contentType, upload });
  });

  /**
   * ── STEP 2 OF 2: record the file now that S3 actually holds it ───────────────
   *
   * POST /v1/teams/:teamId/docs/upload-complete  { path }
   *
   * VERIFIES rather than trusts. It HEADs the object and refuses if it is absent, or
   * if its stored size exceeds the ceiling — so a client that somehow uploaded
   * something else cannot get it indexed, and a client that lies about having
   * finished gets a 404 instead of a phantom row.
   *
   * Idempotent: calling it twice re-reads S3 and rewrites the same pointer with the
   * same versionId. Retries are expected, since this is the hop most likely to be
   * lost after a slow upload.
   */
  docs.post("/teams/:teamId/docs/upload-complete", async (c) => {
    const teamId = c.req.param("teamId");
    const denied = await requireTeamWrite(c, deps.membership, teamId);
    if (denied) return denied;

    const { id } = requireIdentity(c);
    const workshopId = await deps.teams.workshopIdForTeam(teamId);
    if (!workshopId) return c.json({ error: "Team not found" }, 404);

    const body = await c.req.json().catch(() => ({}));
    // Re-run the SAME admission check on the path. Size is re-derived from S3 below,
    // so a placeholder passes the size arm without weakening the path or type arms.
    const admitted = admitUpload(body.path, 1);
    if (!admitted.ok) return c.json({ error: admitted.reason }, 400);

    const key = s3Key(workshopId, teamId, admitted.path);
    const head = await deps.store.head(key);
    if (!head) return c.json({ error: "Upload not found — nothing was stored at that path" }, 404);
    if (head.size > MAX_UPLOAD_BYTES) {
      return c.json({ error: "Stored object exceeds the size limit" }, 400);
    }

    const pointer = await deps.pointers.put({
      teamId,
      path: admitted.path,
      workshopId,
      s3Key: key,
      versionId: head.versionId,
      // An uploaded file has no commit behind it — recording one would be a lie.
      lastCommitHash: null,
      lastAuthor: id,
      updatedAt: new Date().toISOString(),
    });

    return c.json({ path: pointer.path, versionId: pointer.versionId, sizeBytes: head.size }, 201);
  });

  // List a team's docs (latest-version pointers). Executives may read.
  docs.get("/teams/:teamId/docs", async (c) => {
    const teamId = c.req.param("teamId");
    const denied = await requireTeamRead(c, deps.membership, teamId);
    if (denied) return denied;

    const pointers = await deps.pointers.listByTeam(teamId);
    return c.json({ files: await withAuthorNames(pointers, deps.users) });
  });

  /**
   * ── ⚠ REMOVE ONE OF THE TEAM'S FILES ──────────────────────────────────────────────────────
   *
   * THE REQUIREMENT: on the desktop, users can delete files they uploaded in Build.
   *
   * ── WHO MAY DELETE, AND WHY IT IS NOT "ONLY YOUR OWN" ──
   *
   * The same guard as the upload: if you can add a file to this team, you can remove one. Two reasons,
   * and the second is the one that decides it.
   *
   * ⚠ "MY OWN FILES" IS NOT EXPRESSIBLE FOR HALF OF THEM. `lastAuthor` holds a Cognito sub for a
   * hand-uploaded file and a GIT AUTHOR NAME for a synced one (see `withAuthorNames`) — so an
   * ownership check would work on uploads and silently fail on everything that came from a repository,
   * which is most of what a team produces. A rule that applies to some rows and not others is worse
   * than a rule that applies to the team.
   *
   * And a team is the unit that owns its documents here: any member may already rewrite any phase's
   * notes. A team whose one uploader has gone home must still be able to remove the wrong file before
   * their submission is released.
   *
   * ── ⚠ NOT GATED ON THE SUBMISSION'S STATE, DELIBERATELY ──
   *
   * A released submission pins its own manifest INTO the snapshot, so deleting a file
   * afterwards cannot alter what a judge reads — the snapshot is the record of what was submitted, and
   * it is unaffected. Adding a "only before release" gate here would mean this service asking the
   * evaluation service about submission state on every delete: a new east-west dependency, pointing the
   * wrong way, to protect something already immutable. If that gate is ever wanted, it belongs in the
   * evaluation service, which owns the question.
   *
   * ── NOTHING IS ACTUALLY DESTROYED ──
   *
   * The pointer row goes and S3 gets a DELETE MARKER; every version survives (see `DocStore.remove`).
   * So the worst case — a member removing a teammate's work mid-event — is recoverable by an operator
   * rather than final. That is what makes member-level permission defensible.
   */
  docs.delete("/teams/:teamId/docs", async (c) => {
    const teamId = c.req.param("teamId");
    // Same guard as the upload, and BEFORE anything is read: an unauthorized caller must not be able
    // to learn whether a path exists from the difference between 403 and 404.
    const denied = await requireTeamWrite(c, deps.membership, teamId);
    if (denied) return denied;

    const { id: actorId } = requireIdentity(c);

    const path = c.req.query("path");
    if (!path) return c.json({ error: "Missing path" }, 400);

    const pointer = await deps.pointers.get(teamId, path.replace(/^\/+/, ""));
    // ⚠ 404 RATHER THAN A CHEERFUL 204. A participant who deleted the wrong thing needs to know their
    // click did nothing; "it worked" on a path that was never there hides a client-side bug.
    if (!pointer) return c.json({ error: "Doc not found" }, 404);

    /**
     * ⚠ S3 FIRST, THEN THE POINTER — and the order matters in exactly one direction.
     *
     * If S3 succeeds and the pointer delete fails, the row survives and points at a hidden object: the
     * file still lists, and opening it 404s. Ugly, and RETRYABLE — a second click finishes the job.
     *
     * The reverse order fails worse: the row would be gone while the object stayed live, leaving a file
     * nobody can see, delete or account for. Between two partial failures, take the one the user can
     * fix by pressing the button again.
     */
    await deps.store.remove(pointer.s3Key);
    await deps.pointers.remove(teamId, pointer.path);

    // Ids only. Logged because it is the one destructive action a participant can take in this service,
    // and "who removed the design doc" is a question a facilitator will ask during an event.
    console.log(
      JSON.stringify({
        message: "[docs] file removed from the team's list",
        teamId,
        path: pointer.path,
        actorId,
        event: "pointer deleted and an S3 delete marker written; versions retained",
      })
    );

    return c.json({ path: pointer.path, removed: true });
  });

  // Version history for a single doc (S3 object versions, newest-first).
  docs.get("/teams/:teamId/docs/versions", async (c) => {
    const teamId = c.req.param("teamId");
    const denied = await requireTeamRead(c, deps.membership, teamId);
    if (denied) return denied;

    const path = c.req.query("path");
    if (!path) return c.json({ error: "Missing path" }, 400);

    const pointer = await deps.pointers.get(teamId, path.replace(/^\/+/, ""));
    if (!pointer) return c.json({ error: "Doc not found" }, 404);

    const versions = await deps.store.listVersions(pointer.s3Key);
    return c.json({ path: pointer.path, versions });
  });

  // Content of a doc — latest, or a specific ?versionId= for history browsing.
  docs.get("/teams/:teamId/docs/content", async (c) => {
    const teamId = c.req.param("teamId");
    const denied = await requireTeamRead(c, deps.membership, teamId);
    if (denied) return denied;

    const path = c.req.query("path");
    if (!path) return c.json({ error: "Missing path" }, 400);
    const versionId = c.req.query("versionId") || undefined;

    const pointer = await deps.pointers.get(teamId, path.replace(/^\/+/, ""));
    if (!pointer) return c.json({ error: "Doc not found" }, 404);

    const content = await deps.store.get(pointer.s3Key, versionId);
    if (content === null) return c.json({ error: "Content not found" }, 404);

    // Enriched the same way as the list, so the viewer's "Last edited by" and the row it was opened
    // from cannot disagree about the same person.
    const [enriched] = await withAuthorNames([pointer], deps.users);
    return c.json({
      path: pointer.path,
      versionId: versionId ?? pointer.versionId,
      lastAuthor: pointer.lastAuthor,
      ...(enriched.lastAuthorName ? { lastAuthorName: enriched.lastAuthorName } : {}),
      lastCommitHash: pointer.lastCommitHash,
      content,
    });
  });

  /**
   * ── ⚠ THERE IS NO `internal` ROUTE HERE, AND THAT IS THE SECOND TIME THIS WAS DECIDED ────
   *
   * `GET /v1/internal/teams/:teamId/docs/content` was once added so `evaluation` could serve
   * a released team's file to an entitled judge, and then REMOVED.
   *
   * It was gated by `requireInternalCaller`, which compared `INTERNAL_SERVICE_TOKEN`. ⚠ THAT VARIABLE
   * IS SET ON NO FUNCTION, DELIBERATELY — the template records an earlier draft adding it and being
   * removed because "it bought no security and was strictly worse", since this platform's
   * internal-trust mechanism is DIRECT LAMBDA INVOCATION where `lambda:InvokeFunction` is the
   * credential (`service-shared/src/service-invoke.ts`). So the route could only ever answer 403, and
   * making it work meant a new service-to-service dependency for one read.
   *
   * ⚠ SO THIS FILE IS BACK TO WHAT ITS HEADER CLAIMS: member-only on every route, `isMember` a single
   * GetItem with NO role branch, and the one surface on this platform that never leaked stays that
   * way. If a judge ever needs file bodies again, the transport is `invokeService`, NOT a shared
   * secret and NOT a role branch in `requireTeamRead`.
   */

  return docs;
}
