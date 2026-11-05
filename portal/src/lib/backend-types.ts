/**
 * ── DECLARED SHAPES FOR THE BACKEND RESPONSES THIS BFF READS ────────────────────────────────
 *
 * `backendFetch` used to return `any` (it forwards `res.json()`), so every router that mapped
 * over a response annotated its callback `any` and the `any` then travelled outward: a tRPC
 * procedure that spreads an `any` has an `any` output, so the PAGES had to annotate too. That
 * is the whole of the ~60 `no-explicit-any` warnings `eslint.config.mjs` downgraded to `warn`,
 * and the fix it names, *"give the API responses declared types and have `backendFetch` return
 * them"*, is this file plus the type parameter on `backendFetch`.
 *
 * ── WHY HERE AND NOT IN `shared/` ──
 *
 * `shared/` is a VENDORED, DRIFT-CHECKED COPY of the canonical `shared/` repo (see README,
 * "Keeping the copies honest"), and its own header records that `types/workshop`, `types/task`
 * and `types/message` were deliberately left out because *"the portal's tRPC routers type these
 * payloads locally."* Adding portal-only declarations there would create files with no upstream
 * to be checked against, growing the `MISSING-UPSTREAM` gap the README calls the one
 * outstanding piece of the split. So this stays local, and stays honest about being local.
 *
 * ── WHAT THESE TYPES ARE, AND WHAT THEY ARE NOT ──
 *
 * ⚠ THEY ARE A CLAIM, NOT A VALIDATION. Nothing here parses; `backendFetch` casts. A service
 * that omits a key still omits it, which is why every optional field below is marked optional
 * and why the routers keep their `|| []` and `?? 0` normalisation. The value is that a
 * MISSPELLED or REMOVED field now fails `pnpm type-check` instead of arriving as `undefined`
 * three layers later.
 *
 * ⚠ THEY MIRROR THE SERVICES' OWN DOMAIN TYPES, field for field, rather than being invented
 * here (the workshop, team, collaboration and ai services' `domain.ts`). Where
 * a shape differs from the domain entity it is because the ROUTE differs (the `?withMembers=1`
 * and `?withCounts=1` folds, and the `user` projection the roster fan-out adds), and each of
 * those is noted below.
 *
 * ⚠ THIS IS NOT THE WHOLE API. Only the routes whose responses are actually destructured are
 * declared. A `backendFetch` call with no type argument is a route whose contract nobody has
 * written down yet, deliberately visible rather than silently `any` everywhere.
 */

/* ────────────────────────────── Workshop service ────────────────────────────── */

/**
 * `Workshop` from `the workshop service's `domain.ts``.
 *
 * `_count` is NOT on the entity, the `?withCounts=1` branch folds it in, and it is optional
 * within the optional because the count lives in the TEAM service: the route omits it entirely
 * when that read fails, and `workshop.list` preserves the resulting `undefined` on purpose so
 * the experiences list can render "-" rather than a confident "0 teams".
 */
export interface WorkshopRecord {
  ownerId: string;
  id: string;
  name: string;
  description?: string | null;
  format: string;
  status: WorkshopStatus;
  maxTeamSize: number;
  minTeamSize: number;
  aiModel: string;
  aiEnabled: boolean;
  enabledAssistants: string[];
  setupConfig?: WorkshopSetupConfig | null;
  startsAt?: string | null;
  endsAt?: string | null;
  currentPhaseOrder?: number;
  createdAt: string;
  updatedAt: string;
  _count?: { teams?: number };
}

/**
 * The developer-setup blob, a single free-text instruction string.
 *
 * ⚠ THE SERVICE STORES THIS AS OPAQUE JSON (`setupConfig?: unknown` on its own `Workshop`) and
 * validates nothing inside it. This declaration is therefore a statement about what THE PORTAL
 * writes, and the portal is the only writer: the two forms that produce it are
 * `experiences/new/page.tsx` and the settings page's `SettingsForm`, and both emit exactly this key.
 * It is not a guarantee about what a hand-edited row contains, which is why the field is optional.
 *
 * `instructions` is natural-language setup guidance an admin/facilitator writes for the AI coding
 * assistant. The desktop app injects it into the assistant's setup prompt when a participant starts
 * a project (see `desktop/src/main/handlers/framework.ts`). The previous shape, `repoUrl`, `branch`,
 * `setupGuideUrl`, and a per-assistant `assistants` override map, was replaced by this one field.
 */
export interface WorkshopSetupConfig {
  instructions?: string;
}

export type WorkshopStatus =
  | "DRAFT"
  | "REGISTRATION"
  | "ACTIVE"
  | "JUDGING"
  | "COMPLETED"
  | "ARCHIVED";

/** `Phase` from the workshop service. `description` is required upstream; kept optional here
 *  because a phase list written by an older `PUT /phases` may not carry it. */
export interface PhaseRecord {
  workshopId: string;
  order: number;
  id: string;
  name: string;
  description?: string;
  durationMinutes?: number | null;
  createdAt?: string;
}

export interface WorkshopResponse {
  workshop?: WorkshopRecord;
}
export interface WorkshopListResponse {
  workshops?: WorkshopRecord[];
}
export interface PhaseListResponse {
  phases?: PhaseRecord[];
}
export interface FormatListResponse {
  /** `unknown` DELIBERATELY: `workshop.formats` filters this at runtime because a backend that
   *  answers a bare list, or omits the key, must not put `undefined` into a `<select>`'s map. */
  formats?: unknown;
}

/* ──────────────────────────────── Team service ──────────────────────────────── */

/** `Team` from `the team service's `domain.ts``. `seatCap`/`memberCount` are the
 *  seat ledger and are absent on rows that predate it, absent is NOT zero. */
export interface TeamRecord {
  workshopId: string;
  id: string;
  name: string;
  description?: string | null;
  inviteCode: string;
  repoUrl?: string | null;
  createdAt: string;
  updatedAt: string;
  seatCap?: number;
  memberCount?: number;
}

/**
 * A roster row as the SERVICE emits it, `TeamMember` plus the `user` projection the fan-out
 * adds from its local read-model (`routes.ts`, `loadTeamMembers`).
 *
 * `status` is ACTIVE/INACTIVE and ABSENT ON LEGACY ROWS, where absent means ACTIVE. The routers
 * exclude on the DENY value for that reason; typing it `string` rather than a union keeps that
 * defensive comparison honest instead of implying the field is always one of two literals.
 *
 * `email` is present only where the caller is entitled to it, the route omits the key rather
 * than sending `undefined`, so a participant's copy of this shape genuinely lacks it.
 */
export interface TeamMemberRecord {
  teamId: string;
  userId: string;
  role: string;
  joinedAt: string;
  status?: string;
  user?: { id: string; name: string; email?: string };
}

/** What `?withMembers=1` returns: the team, its roster, and a count derived from that roster's
 *  length. Both are optional because the route's own catch falls back to an empty fold, and
 *  because an older backend that ignored the parameter answers bare teams. */
export interface TeamWithMembers extends TeamRecord {
  members?: TeamMemberRecord[];
  _count?: { members?: number };
}

/**
 * `Invitation` from the team service, the fields this BFF projects into a list.
 *
 * ⚠ `status` IS ABSENT ON LEGACY ROWS AND ABSENT COUNTS AS PENDING (`isSpentInvitation` upstream
 * explains why that polarity is forced). Typed `string`, not a union, for the same reason
 * `TeamMemberRecord.status` is: the routers compare defensively and a literal union here would
 * imply a guarantee the table does not make.
 *
 * ⚠ `invitedBy` IS A BARE COGNITO SUB AND MUST NEVER REACH A BROWSER. `team.listInvitations`
 * resolves it to a name through `withInviters`, which honours USER_VISIBILITY_GRANTS. It is
 * declared here so that the field's existence, and the reason it is dropped from the projection
 *, is visible to whoever edits that mapping next.
 */
export interface InvitationRecord {
  teamId: string;
  email: string;
  scope?: string;
  status?: string;
  invitedBy?: string;
  sentAt?: string;
  acceptedAt?: string;
  revokedAt?: string;
  revokedBy?: string;
  acceptedBy?: string;
  platformRole?: string;
  teamRole?: string;
  workshopId?: string;
  /** The invite link's 24h window. Absent on rows minted before expiry existed. */
  expiresAt?: string;
}

export interface InvitationListResponse {
  invitations?: InvitationRecord[];
}

export interface TeamListResponse {
  teams?: TeamWithMembers[];
}
export interface TeamResponse {
  team?: TeamRecord;
}
export interface TeamMemberListResponse {
  members?: TeamMemberRecord[];
}

/* ─────────────────────────── Collaboration service ─────────────────────────── */

/**
 * `Message` from `the collaboration service's `domain.ts``, plus the three LEGACY sender
 * spellings `message.list` still normalises over.
 *
 * ⚠ `senderId` IS THE CURRENT FIELD. `userId`/`userName`/`sender` are carried because the
 * router's fallback chain reads them, and deleting them from the type would delete the only
 * record that the chain exists for something. They are not on the entity; a message from the
 * current service has `senderId` alone.
 */
export interface MessageRecord {
  teamId: string;
  createdAt: string;
  id: string;
  type: string;
  content: string;
  metadata?: unknown;
  senderId?: string;
  parentId?: string | null;
  userId?: string;
  userName?: string;
  sender?: { id: string; name: string } | null;
}

export interface MessageListResponse {
  messages?: MessageRecord[];
  /** The pagination cursor. Named `lastKey` on the wire; `message.list` renames it. */
  lastKey?: string;
}
export interface MessageResponse {
  message?: MessageRecord;
}

/** `Task` from the collaboration service. `status`/`priority` are `string` upstream, the zod
 *  enums in `task.ts` constrain what this BFF SENDS, not what a stored row may hold. */
export interface TaskRecord {
  teamId: string;
  id: string;
  title: string;
  description?: string | null;
  status: string;
  priority: string;
  order: number;
  creatorId: string;
  assigneeId?: string;
  aiGenerated: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * A task as `GET /teams/:teamId/tasks` returns it, the entity PLUS the two names that route
 * resolves from its local users read-model. Only the LIST route enriches; the single-task
 * responses carry the bare entity.
 *
 * ⚠ ABSENT AND "Unknown" MEAN DIFFERENT THINGS, and the service is explicit that they must stay
 * distinguishable. `assigneeName` is absent when there is NO assignee and `"Unknown"` when there
 * is one whose name could not be resolved, the board draws an avatar for the second and nothing
 * for the first, so a `?? "Unknown"` default at the reader would put a "?" bubble on every
 * unassigned card. Hence optional here rather than defaulted.
 */
export interface EnrichedTaskRecord extends TaskRecord {
  assigneeName?: string;
  /** For the detail panel's "who raised this", every task has a creator, but the id is a
   *  Cognito sub, so an unresolvable one becomes "Unknown" rather than leaking the sub. */
  creatorName?: string;
}

export interface TaskListResponse {
  tasks?: EnrichedTaskRecord[];
}
export interface TaskResponse {
  task?: TaskRecord;
}

/* ───────────────────────────────── AI service ───────────────────────────────── */

/** `AiThread` from `the ai service's `domain.ts``. */
export interface AiThreadRecord {
  teamId: string;
  id: string;
  title?: string | null;
  phaseContext?: string | null;
  aiProvider?: string | null;
  createdById?: string;
  createdAt: string;
  updatedAt?: string;
  shared?: boolean;
  sharedAt?: string;
  sharedById?: string;
  sharedByName?: string | null;
}

export interface AiThreadListResponse {
  threads?: AiThreadRecord[];
}
export interface AiThreadResponse {
  thread?: AiThreadRecord;
}
/**
 * `AiMessage` from `the ai service's `domain.ts``, the fields the reading pane renders,
 * plus the per-turn measurements the token panel reads.
 *
 * ⚠ THERE IS NO `user` OBJECT ON THIS SHAPE, and declaring it revealed that the AI page was
 * reading one. `GET /threads/:threadId/messages` returns `deps.messages.listByThread(threadId)`
 * verbatim, no read-model join, unlike the TEAM roster fan-out which does add `user`. So
 * `msg.user?.name` was `undefined` on every message ever rendered and the UI silently showed its
 * "U" / "User" fallback instead of the author. `userId` is the field that IS carried; turning it
 * into a name needs a name map the page does not have (`ai.getThreads` builds one for THREADS,
 * from the team roster). Left as a known gap rather than fixed blind, see the note at the call
 * site in `ai/page.tsx`.
 *
 * ⚠ ABSENCE IS MEANINGFUL ON EVERY OPTIONAL FIELD HERE. `latencyMs` absent means NOT MEASURED,
 * not zero, a desktop-synced transcript was timed on somebody's laptop and never here. Rollups
 * count those separately; see `timing.ts`.
 */
export interface AiMessageRecord {
  threadId: string;
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  userId?: string;
  latencyMs?: number;
  firstTokenMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningOutputTokens?: number;
  /** The LAST reading, never a total, see `AiTimeRollup.contextUsagePercent`. */
  contextUsagePercent?: number;
  /** Set on bulk desktop transcript syncs, whose millisecond spacing is fabricated. */
  synced?: boolean;
}

export interface AiMessageListResponse {
  messages?: AiMessageRecord[];
}

/**
 * `AiTimeRollup` from `the ai service's `timing.ts``, the half of the timing rollup the
 * token panel reads.
 *
 * ⚠ EVERY FIELD HERE IS A SUM EXCEPT `contextUsagePercent`, which is the LAST reading and must
 * never be summed, averaged or maxed (that file says why at length). `null` means no reply
 * reported one, which is not 0.
 */
export interface AiTimeRollup {
  basis?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  cacheCounted?: number;
  tokenCount?: number;
  tokenCoverage?: number;
  contextUsagePercent?: number | null;
  measuredCount?: number;
  unmeasuredCount?: number;
  measuredMs?: number;
  meanMs?: number | null;
  firstTokenMeanMs?: number | null;
  firstTokenSampleCount?: number;
}

/** `ThreadTimingRollup`. Fields optional because `ai.timing` tolerates a backend that answers
 *  the rollup BARE rather than under a `timing` key (`data.timing ?? data`). */
export interface ThreadTimingRollup {
  threadId?: string;
  messageCount?: number;
  userMessageCount?: number;
  assistantMessageCount?: number;
  spanMs?: number | null;
  ai?: AiTimeRollup;
  user?: Record<string, unknown>;
  empty?: boolean;
}

/** The timing route's envelope, which may or may not wrap the rollup, hence the intersection:
 *  `data.timing ?? data` has to type-check against both readings of the same response. */
export type ThreadTimingResponse = ThreadTimingRollup & {
  timing?: ThreadTimingRollup;
};
