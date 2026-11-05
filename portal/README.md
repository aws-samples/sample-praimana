# praimana-portal — the platform's web app

The browser app for Praimana. **Everyone** who is invited registers and signs in here;
where they land depends on their role:

- **Staff** (`ADMIN`, `FACILITATOR`, `EXECUTIVE`, `JUDGE`) → `/experiences`, the console for running
  workshops.
- **Participants** → `/welcome`, which hands them their team join code and the desktop download.
  Participants then build in the **desktop app**, not here.

Runs on `http://localhost:3001` in local dev.

**This folder is self-contained.** `pnpm install && pnpm build` works in `portal/` alone, with no other
folder of this repository, no package to publish first, and no `.env`. What that cost is written down below rather than left to be
discovered — see [Vendored shared code](#vendored-shared-code-shared) and
[The four cross-folder assertions](#-the-four-cross-folder-assertions).

## What the product does

The platform runs a **team hackathon where the point is learning to work with an AI coding assistant** —
and where the assessment is of the team, not of individuals. An **experience** is one such
event. Teams build inside it, submit a deliverable, and judges score them.

⚠ **Participants barely use this app.** They register here, collect their team join code and the desktop
download from `/welcome`, and then build in the **desktop app** — which is where the AI assistant runs, where
phase notes are written, and where files are synced from. This portal is the console for everyone *around*
the building: facilitators running the event, executives releasing their team's work, judges scoring it.

### The three phases

Fixed and immutable — `FIXED_PHASE_PIPELINE` in `shared/constants/phases.ts`, and phase ids key every team's
notes, so they cannot be edited after creation:

| Phase | What the team does |
|---|---|
| **Ideation** | Define the problem and shape the idea, working with the assistant before building |
| **Build** | Build it. Files land here, synced from the desktop app |
| **Demo** | Record the live application URL and the demo recording |

Progression is **workshop-wide and facilitator-controlled** — one `currentPhaseOrder` on the workshop row
that every team sees. There is no per-team advance, which is why a phase's COMPLETED / IN_PROGRESS /
NOT_STARTED state is *derived* rather than stored (see [Phase status](#phase-status-is-derived-never-stored)).
The one gate on the team's side is a workflow nudge: the first phase needs ~50 words before the later ones
open (`MIN_FIRST_PHASE_WORDS`), enforced in the desktop because that is the only surface that writes notes.

The three supported assistants are **Claude Code**, **Kiro CLI** and **Codex**, and a facilitator can
restrict which of them an experience offers (`enabledAssistants`).

### The submission → judging pipeline

This is the part with the most rules:

1. **The team drafts.** One submission per team, created idempotently on first visit to the Submit tab. Four
   deliverable links (only the demo link is required) and four narrative fields — title, summary, problem,
   solution. Drafts save incrementally.
2. **An executive releases it.** Not the facilitator, and not any member: releasing is the team's act through
   its executive. Release has preconditions — files uploaded, an **`https:`** demo link, the write-up
   complete, nothing unsaved — and the checklist names whichever is missing *before* the button is pressed.
3. **Release pins a snapshot.** Judges read the work *as released*, with a banner saying so; later edits are
   not shown. The snapshot holds the phase notes inline plus an artifact **manifest** (path, author,
   timestamp) — pointers, never file bodies.
4. **Judges score it.** Five criteria — innovation, execution, aiUsage, impact, presentation — 1–10 each,
   equally weighted, so 50 per judge. One row per `(submission, judge)`, which is the anti-ballot-stuffing
   property.
5. **The owner publishes the ranking.** Results are a **404 until published**, deliberately, so no partial
   ranking is ever rendered. Only the experience owner can reopen a released submission, and reopening
   retains the old snapshot — it is what already-cast scores were measured against.

The whole pipeline works end to end. The judging rules: a score is
**final once submitted**, publication **closes scoring** (and a reopen withdraws the ranking), a judge sees
the experiences their invitation named, and **judges' scores go to the facilitator** — a judge sees only
their own, on the submission and beside each place on the results page. See [Known gaps](#known-gaps) for
what remains.

### What this app is not

It holds **no database**. Every fact above lives in a service — workshop, team, collaboration, ai, docs,
evaluation, identity — and this app is the BFF in front of them (see [Architecture](#architecture)). It is
also **not the security boundary**: every rule is re-checked by the service that owns the data, which is why
role checks here are described throughout as courtesies rather than controls.

## Quick start

```bash
pnpm install
pnpm dev          # http://localhost:3001
```

```bash
pnpm build        # production build — passes with no .env at all
pnpm type-check   # tsc --noEmit over src/, shared/ and tests/
pnpm test         # vitest: 1655 tests, 3 todo, 85 files (~4s)
pnpm lint         # eslint src/ shared/ — clean: 0 errors, 0 warnings
```

`pnpm dev` boots and serves pages without configuration, but **sign-in needs a `.env`** — see
[Configuration](#configuration). Without one, `/api/auth/*` answers `UntrustedHost` and no session is minted.

## Authentication

Native **Amazon Cognito** via the Hosted UI (OAuth2 authorization-code + PKCE), wired as a NextAuth provider
in `src/lib/auth.ts`. Cognito owns credentials, MFA, and token issuance — this app never sees a password.

Registration is **invite-only, gated by email address** in the Cognito pre-signup trigger, so an account is
created only if that address was invited. (There is no signup code; the team join code is a separate concept
used to join a team.)

The bearer forwarded to the API is the Cognito **ID token** — it carries the `cognito:groups` claim the
services authorize against. Roles come from those groups, collapsed to a single role by
`collapseCognitoGroups()`.

> Cognito access/ID tokens live 30 **minutes** and the refresh token 30 **days** (see the app client in
> [`../infra/aws/app/platform-identity.yaml`](../infra/aws/app/platform-identity.yaml)).
> `src/lib/idle-timeout.test.ts` is meant to assert that the 30-minute figure has not been raised; see
> [the four cross-folder assertions](#-the-four-cross-folder-assertions) for why it currently reports a todo.

## Who can sign in

Every recognised role may sign in. The gate is `canSignInToWebApp()` in `shared/types/user.ts` — it **fails
closed**, so a token whose groups we don't understand mints no session at all.

| Role | Sign in | Lands on | Staff screens |
|---|---|---|---|
| `ADMIN` | ✅ | `/experiences` | ✅ |
| `FACILITATOR` | ✅ | `/experiences` | ✅ |
| `EXECUTIVE` | ✅ | `/experiences` | ✅ (read-only) |
| `JUDGE` | ✅ | `/experiences` | ✅ |
| `PARTICIPANT` | ✅ | `/welcome` | ❌ confined to `/welcome` |

Landing paths come from `landingPathForRole()`; access to the staff screens is `canAccessStaffScreens()` /
`STAFF_APP_ROLES`. Both live beside the sign-in gate in `shared/types/user.ts` so the three can't drift apart.

A signed-in participant who requests a staff path is **redirected** to `/welcome` by `src/middleware.ts`
rather than 403'd — a stale bookmark or an invite-email deep link becomes a nudge, not a dead end. That
redirect is UI routing, not the security boundary: every mutation is additionally gated server-side (tRPC role
checks + each service's own authz), so bypassing it doesn't grant staff powers.

## Access model

Two axes: who can **create workshops**, and which **teams** each role can see.

### Creating workshops

| Role | Create workshops |
|---|---|
| `ADMIN` | ✅ |
| `FACILITATOR` | ✅ |
| `EXECUTIVE` | ❌ (read-only) |
| `JUDGE` | ❌ |

Enforced server-side in the `workshop.create` tRPC procedure (`src/lib/trpc/routers/workshop.ts`) via
`canCreateWorkshops()` / `WORKSHOP_CREATOR_ROLES` — a disallowed role gets `FORBIDDEN`, not just a hidden
button. The UI also hides the "Create Experience" entry points for non-creators.

### Team visibility

⚠ **THIS TABLE PREVIOUSLY SAID "ALL TEAMS" FOR ADMIN, FACILITATOR AND JUDGE, AND IT WAS NOT A
DOCUMENTATION SLIP — THE CODE DID THAT.** An admin's teams directory ran with no workshop scope at all, which
the store reads as *no restriction*, so the response was every team in every experience owned by anyone — and
the roster route disclosed every member's email address through the same flag. Scoped by ownership now.

| Role | Teams visible |
|---|---|
| `ADMIN` | Only teams in experiences **they own** |
| `FACILITATOR` | Only teams in experiences **they own** |
| `JUDGE` | **None** — see below |
| `EXECUTIVE` | Only teams they are a **member** of |
| `PARTICIPANT` | Only teams they are a **member** of |

A `JUDGE` sees no teams by design rather than by omission: judges are *refused* a team-membership row,
and the roster route's non-owner branch intersects with the caller's memberships — so
the honest answer for a judge is the empty list. They reach the submissions they judge through their
**entitlement** (the workshop named on their invitation), not through teams.

⚠ **NEITHER `ADMIN` NOR `FACILITATOR` CAN READ TEAM CONTENT AT ALL** — board, chat, AI transcripts, documents,
phase notes. `canReadTeamContent` ignores role entirely and asks only about membership, and those two roles
cannot hold a membership row. They see the phase *definitions* they authored, never the team's answers to them.

`EXECUTIVE` is a read-only observer. The experiences landing routes an executive straight to their own team(s)
via `trpc.team.listMine`, because the experiences list only surfaces workshops the caller owns.

The authoritative matrix for every role, with the predicate that decides each row, is
**[`../services/ROLES.md`](../services/ROLES.md)** — the services enforce these rules and this README only summarises the
portal's slice of them.

`EXECUTIVE` is also the platform's read-only role (`READ_ONLY_ROLES`): it may view a team workspace but never
mutate it — enforced defense-in-depth (UI + this BFF + the services), not UI-only.

## Architecture

A **Next.js 15 App Router BFF** — it has no database of its own. Server-side tRPC routers
(`src/lib/trpc/routers/`) call the platform API over HTTP through `backendFetch()` (`src/lib/backend.ts`),
attaching the caller's Cognito ID token. The browser never talks to the API directly and never holds AWS
credentials.

Beyond tRPC there are a few plain route handlers:

| Route | Purpose |
|---|---|
| `/api/auth/[...nextauth]` | NextAuth + Cognito callback |
| `/api/trpc/[trpc]` | tRPC transport |
| `/api/invite` | Builds the invite link into the Cognito Hosted UI sign-up page |
| `/api/desktop/*` | Endpoints the desktop app calls with a bearer token |

`/api/desktop/download` is a plain browser navigation, not a fetch: the desktop service 302-redirects to a
presigned S3 URL because installers are far larger than an API response can carry.

`/workshops/*` **308**-redirects to `/experiences/*` (`next.config.ts`). 308 rather than 307 so the move is
cacheable and a form POST to an old path keeps its method and body. `/api/workshops/*` is deliberately NOT
redirected — it is named after the backend's own `/v1/workshops`.

### The typed backend boundary

`backendFetch` forwards `res.json()`, which is `Promise<any>`. It used to return that unnarrowed, and the
`any` travelled: a router that spreads an `any` has an `any` output, so the **pages** inherited it too. That
produced ~60 `no-explicit-any` warnings, which `eslint.config.mjs` had downgraded to `warn` for the router and
page globs while recording the real fix — *give the API responses declared types and have `backendFetch`
return them.* That is now done, in three pieces, and the rule for those globs has since been promoted from
`warn` to **`error`**: the count is zero, so a new `any` in a router or a page is a regression rather than
unfinished work. The remaining untyped call sites need no annotation to stay green — they inherit the
permissive default, which lives outside those globs.

| Piece | What it is |
|---|---|
| `backendFetch<T>()` (`src/lib/backend.ts`) | Type parameter on the boundary. Defaults to a permissive `UndeclaredResponse` — **one** documented `any`, in one place, instead of sixty above it |
| `src/lib/backend-types.ts` | The declared response shapes, mirrored field-for-field from the services' own `domain.ts` |
| `RouterOutputs` (`src/lib/trpc/client.ts`) | `inferRouterOutputs<AppRouter>`, so a component names a procedure's return type instead of restating it |

**Writing a new call:** pass the shape — `backendFetch<TeamListResponse>(…)` — and add it to `backend-types.ts`
if it is not there. A call with **no** type argument is legal and means *nobody has written this route's
contract down yet*; that is deliberately visible at the call site rather than invisible everywhere. Of 101
production call sites, **29 are typed and 72 are not** — so defaulting to `unknown` instead of the permissive
default would have turned one change into ~72 type errors. Typing the rest is incremental, one route at a time,
and each one that lands deletes an `any` from every consumer downstream of it.

⚠ **These types are a claim, not a validation.** Nothing parses; `backendFetch` casts. A service that omits a
key still omits it, which is why every optional field is marked optional and why the routers keep their
`|| []` and `?? 0`. What they buy is that a **misspelled or removed** field fails `pnpm type-check` instead of
arriving as `undefined` three layers later — which is exactly what they did on arrival, surfacing six live
defects: an admin row rendering `undefined teams`; **three** entity-returning mutations whose callers navigated
to an `undefined` id (`workshop.create` first POSTing the phases to `/v1/workshops/undefined/phases`, so the
silent failure was also a write); an AI transcript that never showed its authors; an insights tile hardcoded to
`0 of 0`; two dead field reads that could never match; and a `formatDate` narrower than the nullable dates it
received.

⚠ **They are NOT in `shared/`, deliberately** — see [Vendored shared code](#vendored-shared-code-shared). That
directory is a vendored copy whose own header records that `types/workshop`, `types/task` and
`types/message` were left out because *"the portal's tRPC routers type these payloads locally"*. A
portal-only file there would have no counterpart in the other copies to be checked against.

### Phase status is derived, never stored

A phase's `COMPLETED` / `IN_PROGRESS` / `NOT_STARTED` state is a **comparison against the workshop's
`currentPhaseOrder`**, not a stored per-team field. Progression is workshop-wide and facilitator-controlled
(`PATCH /workshops/:id/current-phase`), so every team in a workshop sees the same phase state — which is why
the workshop service's `TeamPhase` carries content, an editor and a timestamp and **no status**.
`shared/constants/phase-progress.ts` states this at length; `src/lib/phase-status.ts` is this repo's single
implementation of the comparison, and `team.getById` applies it.

⚠ **The desktop holds the same rule** (`../desktop/src/renderer/components/PhasesView.tsx`), with the identical ternary and
its own test pinning the operators. Two front-ends that disagree about whether a team finished a phase is the
failure to avoid, so the comparison lives in one tested module per app rather than inlined at call sites. If
it is ever promoted, `shared/` is the right home and the desktop's copy should collapse into the same import —
a coordinated change across the vendored copies, not something to fake by adding a file to one of them.

> `team.getById` returned `teamPhases: []`, hardcoded, for as long as it existed. The workspace phase badge and
> stepper sat behind `length > 0` and had therefore **never rendered**; the insights tile reported `0 of 0` as
> fact on a page executives read. The field is now `phases` — the old name asserted per-team state that nothing
> in the stack has ever held.

## Configuration

Copy `.env.example` to `.env` and fill it in. ⚠ **No populated `.env` is committed to this
repo**: it would hold live secrets (`NEXTAUTH_SECRET`, `COGNITO_CLIENT_SECRET`, `DESKTOP_ACCESS_KEY_SECRET`,
`GITHUB_TOKEN`), and those must not be spread into git history. `.gitignore`
keeps `.env` out of this one.

`.env.example` lists what the code actually reads — four variables the old file carried were dropped because
nothing in `src/` reads them any more (`DESKTOP_ACCESS_KEY_SECRET`, `COGNITO_REDIRECT_URI`,
`NEXT_PUBLIC_PLATFORM_NAME`, `GITHUB_TOKEN`).

Point the app at the API — one base URL fronting every service:

```
BACKEND_URL / NEXT_PUBLIC_BACKEND_URL = http://localhost:8080
```

The Cognito values come from the deployed app stack. With the stack name used in
[`../infra/SETUP.md`](../infra/SETUP.md):

```bash
aws cloudformation describe-stacks --stack-name praimana-app --region us-east-1 \
  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output table
```

`COGNITO_CLIENT_SECRET` stays empty: the app client is a public PKCE client.

> **Note:** changes to `src/lib/auth.ts` (the NextAuth config) don't reliably hot-reload — restart the dev
> server after editing the login/role gate.

### Secret management

`NEXTAUTH_SECRET` and `COGNITO_CLIENT_SECRET` are the two long-lived secrets this application can depend on.
The essentials:

- **Rotation policy** — 90-day cycle for `NEXTAUTH_SECRET`, and for `COGNITO_CLIENT_SECRET` when one is set.
- **`NEXTAUTH_SECRET` is in AWS Secrets Manager.** The portal stack generates it at create time
  (`PortalSessionSecret`, encrypted with the platform KMS key; output `PortalSessionSecretArn`). The secret
  value is JSON: `{"NEXTAUTH_SECRET": "…"}`, plus `NEXTAUTH_SECRET_PREVIOUS` during a rotation. The Lambda
  environment holds only the ARN (`NEXTAUTH_SECRET_ARN`). At cold start, `lambda/load-session-secret.cjs`
  reads the value, sets it in `process.env` and then starts `server.js`. If the read fails, the execution
  environment fails to start and the error is in the function's log group. The CodeBuild build carries
  only a labelled placeholder and asserts the secret is absent from `.env.production`, so it is never in
  the bundle bucket.
- `COGNITO_CLIENT_SECRET` is set to `""` in the CodeBuild environment, because the deployed app client is a
  public PKCE client with no secret. See
  [`../infra/aws/app/platform-portal.yaml`](../infra/aws/app/platform-portal.yaml).
- Local development (`pnpm dev`) still reads `NEXTAUTH_SECRET` from `.env`; the loader is only the
  Lambda entrypoint.

⚠ **Rotating `NEXTAUTH_SECRET` without an overlap signs everybody out.** It signs and encrypts the session
JWE, and `src/lib/session-cookie.ts` accepts `NEXTAUTH_SECRET_PREVIOUS` as an outgoing key. For a planned
rotation:

1. Write the new key, keeping the old one as the outgoing key:
   `aws secretsmanager put-secret-value --secret-id <PortalSessionSecretArn> --secret-string '{"NEXTAUTH_SECRET":"<new>","NEXTAUTH_SECRET_PREVIOUS":"<old>"}'`
   (generate keys with `openssl rand -base64 48`).
2. Start the portal build project (`PortalBuildProjectName`). Warm execution environments keep the value
   they read at cold start, and the code update replaces them.
3. After 24h (the longest session), write `{"NEXTAUTH_SECRET":"<new>"}` and start the build project again.

For **revocation** after a compromise, do step 1 *without* `NEXTAUTH_SECRET_PREVIOUS` and then step 2.
While the outgoing key is set, the old key still mints valid sessions.

## Vendored shared code (`shared/`)

`shared/` is a **copy**, not a dependency. It is duplicated into this folder so that **the portal builds, tests
and releases on its own**, with no workspace package to publish, version or install first.

There are three vendored copies in this repository — `../desktop/shared`, `portal/shared` and
`../services/shared` — and **none of them is canonical**: there is no upstream shared library. They are kept
in step by hand, and by the comparison described [below](#keeping-the-copies-honest).

### What is in it, and why exactly this much

Sixteen modules. The set was **derived and then verified by the type checker**, not hand-picked: every
`@praimana/shared` import in `src/` was mapped to its defining module (90 distinct symbols, 13 modules),
closed transitively over those modules' own imports (which is what adds `types/phase` and `types/team`), plus
`constants/auth-flow`, which no `import` statement reveals — `src/lib/auth-flow.ts` is
`export * from "@praimana/shared"`, and a re-export is invisible to a grep. `pnpm type-check` passes,
which is what makes the set provably closed. `shared/index.ts` records the reasoning per module.

| Module group | What it decides |
|---|---|
| `constants/roles`, `types/user` | The platform roles and every predicate over them — the Administration gates, `canSignInToWebApp`, `landingPathForRole` |
| `constants/profile`, `constants/support` | The profile form's fields, and the bug-report/feedback bounds |
| `constants/phases`, `constants/phase-progress`, `constants/phase-links` | The phase list, the first-phase word gate, and the Demo phase's two labelled URLs (`isSafeHttpUrl` is a security control) |
| `constants/scoring`, `constants/assistants` | The 1–10 judging scale and the assistant catalog |
| `constants/auth-flow`, `constants/chat-limits`, `constants/message-time`, `constants/desktop-link` | Sign-in state machine and error copy, composer caps, the one timestamp format, the portal→desktop connect link |
| `types/audit`, `types/phase`, `types/team` | The payload shapes those modules refer to |

⚠ **This is deliberately larger than the desktop's copy and than the three-way intersection.** Vendoring
is per-consumer by definition: the portal is the only consumer that renders the admin screens, the profile
form, the assistant catalog and the judging scale. What was left out — `constants/cognito-pool`,
`constants/teams`, and five `types/*` files — is listed with a reason in `shared/index.ts`, so the absences
are decisions rather than oversights.

### ⚠ The risk being accepted, stated plainly

Several of these modules exist *because* they must not be duplicated, and each has already caused a real bug
in this codebase when it was:

- the identity service kept its own `MAX_FEEDBACK_MESSAGE = 8_000`, while the test asserting drift was
  impossible only covered three of the four readers — so editing the shared number would have moved the form
  and left the API's refusal behind;
- the portal carried an inline `role === "EXECUTIVE" || role === "PARTICIPANT"` beside
  `canSignInToDesktopApp`, which is how a UI ends up offering something the service then refuses;
- `countWords` is shared precisely so a live counter and the gate cannot disagree — two implementations is
  how somebody sees "20 / 20" next to a disabled button.

Duplicating them buys independent builds and pays for it in drift. The mitigation is not discipline, it is the
check below: **duplication you can detect is a different thing from duplication you cannot.**

⚠ **These rules are NOT enforced here.** The service is authoritative: it re-checks every one of them against
the request and its refusal is the one that counts. The copy in this repo exists so the UI can tell somebody
the rule *before* they hit it — a courtesy, not a control. That is deliberate, and it is what makes a stale
copy survivable: the worst case is a slightly wrong hint, never a wrong outcome.

### Keeping the copies honest

The copies are per-consumer, so they are not byte-identical *as directories* — but every file that appears in
two of them is meant to say the same thing. This compares each portal module against the same path in the
other two copies (run from `portal/`):

```bash
for f in $(cd shared && find . -name '*.ts' ! -name index.ts | sort); do
  for peer in ../desktop/shared ../services/shared; do
    p="$peer/${f#./}"
    [ -f "$p" ] || continue
    if cmp -s "shared/$f" "$p"; then echo "ok     $f = $p"; else echo "DRIFT  $f vs $p"; fi
  done
done
```

**Wire this into CI** as a job that fails on `DRIFT` (CI/CD pipelines are not included in this sample).
Without it the copies drift silently, which is the one outcome this whole arrangement cannot survive.

⚠ **As of this writing it reports `DRIFT` for most files present in more than one copy, and that is a real
gap.** The differences sampled are in comments (wording that names folders or repositories differently), not
in the rules themselves, but `cmp` cannot tell the two apart — so until the copies are reconciled the check
is a report to read, not yet a gate. Modules only the portal carries — `roles`, `profile`, `assistants`,
`scoring`, `phases`, `types/audit`, `types/phase`, `types/team` — have no other copy to be compared against.

To change a shared rule: edit it in one copy, copy it into the other copies that carry it, and release
them together. These files historically change *with* their consumers — 4 of 4 commits to `support.ts` and 10
of 12 to `types/user.ts` also touched consumer code — so a coordinated change is the normal case.

### Imports

The vendored files import each other by relative path (`./phase-progress`), so no file needed editing.
Consumer code still imports the package specifier:

```ts
import { MIN_FIRST_PHASE_WORDS, checkFeedbackReport } from "@praimana/shared";
```

That keeps working because the specifier is **aliased**, not rewritten — ~60 files would otherwise have
changed. `tsconfig.json` `paths` carries it, and **Next configures its bundler from that file**, so the alias
holds at build and runtime as well as in `tsc`. Vitest does *not* read `tsconfig` paths, so
`vitest.config.mts` repeats the alias; without it every test importing shared code fails to resolve.

## Tests

```bash
pnpm test   # 1655 passed, 3 todo, 85 files
```

Unit tests cover the security-critical pure logic — the role/authorization gate, the AI-stream rate limiter,
`backendFetch`'s error mapping — plus a convention this repo leans on: `environment` is `node` with no jsdom,
so a number of component rules are asserted against the **source** via `src/lib/source-under-test.ts`, which
strips comments first. That stripping is not tidiness; two source assertions here have already passed on a
comment that merely quoted the thing being asserted.

The vendored `shared/**` tests run in this suite too (8 files, 125 tests). They have no other home in this
folder, so this config is the only thing that runs them here. One test was **not** copied:
`chat-limits.drift.test.ts` reads the AI service's `routes.ts` to prove `MAX_AI_PROMPT_CHARS` still equals
its `MAX_SYNC_CONTENT`. That assertion belongs where both ends are visible —
`../services/ai/src/chat-limits.drift.test.ts`.

The BFF routers are exercised through a **mocked `backendFetch`** (`trpc-team-queries.test.ts`,
`routers/ai-thread-names.test.ts`, `routers/feedback-names.test.ts`): these are tests about *which requests are
made* and *what happens when one fails*, so the transport is the thing to control. That is where the
failure-posture decisions are pinned — a phase-list read that fails must not take the roster down with it, and
a roster read that fails must not cost the AI transcript, because in both cases the decoration must never
outrank the content.

`lib/phase-status.test.ts` closes with a **fourth** cross-folder assertion, listed with the others below: the
phase-status comparison is duplicated in the desktop, and nothing enforces the agreement, so it is checked the
same present-⇒-assert way. It matches **structurally, not textually** — the desktop's local is `currentOrder`
and ours is the parameter `currentPhaseOrder`, so requiring identical text would fail on a correct rename and
teach the next reader to delete the test. What must not differ is which operator maps to which state.

### ⚠ The four cross-folder assertions

Four tests assert agreements that **no shared module enforces**, by reading a file that belongs to another
folder of this repository. All four resolve the path through `src/lib/sibling-repo-source.ts`:

| Test | Reads | Catches |
|---|---|---|
| `components/feedback-form-bounds.test.ts` | the desktop's `AccountPanel.tsx` | one feedback form being fixed while the other keeps springing the 20-word floor on Send |
| `components/auth/code-field-placeholder.test.ts` | the desktop's `SignInView.tsx` | the two apps' verification-code fields hinting differently in what is one login |
| `lib/idle-timeout.test.ts` | `../infra/aws/app/platform-identity.yaml` | the Cognito token lifetime being raised from 30 minutes to match a longer session |
| `lib/phase-status.test.ts` | the desktop's `PhasesView.tsx` | one app's phase comparison being changed while the other's stays, so the two disagree about whether a team finished a phase |

**Asserted when the sibling folder is reachable, reported as `it.todo` (or skipped) when it is not.**
Present ⇒ assert; absent ⇒ a todo in the summary, naming what went unchecked. Never a silent pass, and never a
red suite when `portal/` is used on its own. A file missing from a folder that *is* present still throws —
that is a rename nobody propagated, not an absent checkout.

Siblings are resolved as folders beside `portal/`: `../desktop`, `../services`, and `../infra` for
`infrastructure`. (The resolver also knows a `shared` sibling, `../shared`, which does not exist in this
repository.) Override with `AIAP_DESKTOP_REPO`, `AIAP_INFRASTRUCTURE_REPO`, `AIAP_SERVICES_REPO`,
`AIAP_SHARED_REPO`.

⚠ **CI must run against a full checkout of this repository**, or these assertions never run where it matters.
A job that copies out only `portal/` will report them as todos for ever.

> One of the original three was passing **by accident** before it was made explicit: the desktop
> `SignInView.tsx` path
> was `join(__dirname, "..","..","..","..", "desktop", …)`, whose directory depth happened to land on the
> sibling `desktop` folder in this layout — on one machine's checkout only, and on no CI
> runner. An accident of directory depth is not a dependency anyone can maintain.

## Known build warnings

`pnpm build`, `pnpm lint` and `pnpm type-check` are all **clean** — zero ESLint warnings, zero type errors —
with exactly one exception, recorded here so nobody spends an afternoon rediscovering it.

### `CompressionStream is not supported in the Edge Runtime` (jose) — not fixable from this repo

```
./node_modules/jose/dist/webapi/lib/deflate.js
A Node.js API is used (CompressionStream at line: 10) which is not supported in the Edge Runtime.
```

`src/middleware.ts` imports `auth` from `src/lib/auth.ts`, so that module's whole import graph is bundled for
the **Edge** runtime. The natural conclusion is that this repo's own `jose` imports are the cause and that
subpath imports would fix it.

⚠ **They do not. This was tried and reverted.** `@auth/core/jwt.js` imports the `jose` **barrel** itself to
encrypt the session cookie as a JWE, and `next-auth` is a hard dependency of `src/lib/auth.ts` — so
`webapi/index.js`, and with it `jwe_decrypt.js` → `deflate.js`, is in the middleware bundle regardless of what
specifier `src/lib/cognito-verify.ts` or `src/lib/auth.ts` use. Narrowing them saved nothing and churned the
auth path; the attempt and its outcome are recorded in the header of `src/lib/cognito-verify.ts`.

The warning is **benign**: a static reference in a JWE branch (compressed `zip` headers) that neither this app
nor `@auth/core` ever executes. It clears when `@auth/core` stops importing the barrel — upstream's call. The
remaining local options are a `pnpm.patchedDependencies` patch of `@auth/core` or suppressing build warnings
wholesale; **neither is recommended**, since patching a dependency's auth internals to remove a benign warning
is the worse trade.

## Properties of this self-contained folder, in one list

Everything below is a deliberate property of `portal/` building on its own:

1. **`tsconfig.json` has no `extends`** — the twelve options from `tsconfig.base.json` are inlined. A dangling
   `extends` fails at `tsc` startup (TS5083) before it checks a single file.
2. **`eslint.config.mjs` is required** — ESLint 9 searches upward for a config; without one `pnpm lint` drops
   into `next lint`'s interactive prompt, which in CI is a hang rather than an error. It is scoped to
   `portal/`, with no desktop/services blocks.
3. **`.npmrc` is required** — without it pnpm uses the machine's global registry (which may be an internal
   mirror) and `pnpm install` fails `ERR_PNPM_FETCH_401` on the first public package.
4. **`transpilePackages` removed from `next.config.ts`** — there is no workspace package to transpile any
   more; keeping the line would name one that is not installed.
5. **`vitest.config.mts` sets `oxc: { jsx: { runtime: "automatic" } }`** — some environments resolve vite 6,
   which compiled JSX despite `"jsx": "preserve"`. A fresh install here can resolve vite 8, which honours
   `preserve` literally and then cannot parse the result. The
   tsconfig keeps saying what **Next** requires; the test runner is told what **it** requires.
   ⚠ **The `.mts` extension is load-bearing.** As `.ts` it was loaded as CommonJS while containing ESM syntax,
   so every run warned that `configLoader: 'native'` — a future Vite default — would not support it. The other
   remedy Vite suggests, `"type": "module"` in `package.json`, would reinterpret every `.js` file in the repo
   as ESM and break `postcss.config.js` (`module.exports = …`), i.e. break `next build` to silence a test-runner
   warning. `.mts` scopes the fix to the one file and keeps the config's TypeScript types (`.mjs` would lose
   them).
6. **`pnpm-workspace.yaml` approves `sharp`'s build** — without it image optimization falls back to WASM.
7. **`.env` not copied; `.env.example` written from what the code reads** (see [Configuration](#configuration)).
8. **`tests/e2e/totp.ts` vendored** — `src/lib/totp.test.ts` checks it against RFC 6238's published vectors,
   and those vectors are what keep the two copies from drifting — see [End-to-end tests](#end-to-end-tests-playwright).

## End-to-end tests (Playwright)

```bash
pnpm test:e2e                              # 17 spec files
pnpm exec playwright test remove-member    # one spec
pnpm exec playwright test --list           # collect without running
```

⚠ **These are NOT slow unit tests, and the distinction is the reason they exist.** `vitest.config.mts` runs
`environment: "node"` with no DOM, so the unit tests cover gating predicates and request correlation as
*pure functions* and structurally cannot observe a real focus model, a real tab order, or **how many requests
actually went out**. Those are precisely what these specs assert — including that a disabled Confirm button
issues exactly ONE request, which no unit test in this repo can see.

⚠ **THEY NEED A STACK, AND THEY SKIP RATHER THAN LIE WHEN THEY DO NOT HAVE ONE.** `tests/e2e/fixtures/env.ts`
reports a missing test account as `SKIPPED` with the variable names, never as passed — a suite that
green-lights itself having tested nothing manufactures exactly the confidence this harness exists to withhold.
Requirements:

| Spec group | Needs |
|---|---|
| `remove-member`, `user-access`, `roster-status`, `teams-directory`, `restore-member`, `invite-flow` | `NEXTAUTH_SECRET` (read from the environment, else from `.env`); they mint a session cookie and serve their own tRPC responses |
| `access-controls.auth` | A **real** Cognito sign-in — password plus the pool's mandatory TOTP challenge, computed from a purpose-made test account's enrolment secret. No seam. It is the only evidence the sign-in journey works. |

⚠ **THE SPECS DO NOT START THE SERVICES.** The API that `BACKEND_URL` points at fronts the microservices in
[`../services`](../services); the browser-behaviour specs serve their own tRPC responses rather than reaching
them, and the real sign-in spec needs a deployed Cognito pool. See
[`tests/e2e/README.md`](tests/e2e/README.md) for what each spec needs.

**What was rebased on the way in.** The specs and fixtures were copied from an earlier layout; the changes
made on the way in were:

- `fixtures/env.ts` — `.env` is at the portal root (`portal/.env`). `REPO_ROOT` itself needed no change;
  three levels up from `tests/e2e/fixtures` is `portal/`. ⚠ That depth
  coinciding is **luck**, the same luck this README flags for the desktop `SignInView.tsx` path.
- `mutation-check.sh`, `mutation-check-roster.sh` — the portal path was collapsed to `"$REPO_ROOT"`.
  Functional, not cosmetic: left otherwise they would mutate nothing, run the specs against unmodified source,
  and report the suite as *surviving* — a green result from having tested nothing.
- `playwright.config.ts` — the dev-server launch was collapsed to `pnpm dev`.
- Prose path references.

> ⚠ **`mutation-check.sh` reads as "binary data" to `file(1)`** — its heuristic trips on the em-dashes and
> box-drawing in the comments, though `iconv` confirms valid UTF-8. Consequence: plain `grep` **suppresses
> matches in it and prints nothing**, so "no output" reads as "no reference". One cross-folder path was almost
> missed this way. Use `grep -a` when auditing `tests/e2e/`.

> Two unused-variable declarations survive in the copied specs (`access-controls.auth.spec.ts:31`,
> `user-access.spec.ts:43`). `pnpm lint` covers `src/ shared/` only, so they fail nothing today — but they
> would if `tests/` were ever added to it. Left as-is.

## Known gaps

Most known gaps are **not fixable in `portal/`** — the portal is a BFF, and the judging, entitlement and
thread-timestamp problems live in the services.

**Closed** in [`../services`](../services): judges can see the experiences they were invited to,
scores are immutable once submitted, publication closes scoring, judges' scores are visible to the
facilitator only, and a thread's `updatedAt` moves when its messages sync.

⚠ What remains is mostly **outside `portal/`**: a pre-existing cost-cache defect in
`identity` fails its own test; and **a team now has no route to judge feedback**, which was a deliberate
consequence of restricting score visibility.

## Related folders

`portal/` is one of the peer folders of this repository, beside [`../desktop`](../desktop),
[`../services`](../services) and [`../infra`](../infra). Platform-wide documents (architecture overviews,
decision records, specs) are not included in this sample.

## Important Notes

- **This is sample code, not a production service.** This component demonstrates how to build an
  AI-assisted workshop web console on AWS. It is provided as a starting point for your own
  implementation, not as a maintained software product.
- **No warranty.** This code is provided as-is. Review, test, and adapt it for your environment
  before any production use.
- **Your responsibility.** Once deployed in your account, you are responsible for the security,
  cost, and operational management of these resources per the
  [AWS Shared Responsibility Model](https://aws.amazon.com/compliance/shared-responsibility-model/).
- **Not published to package indexes.** These samples are not available via pip, npm, or Maven.
  Clone this repository to use them.
- **Feedback welcome.** File issues or pull requests on GitHub. We review contributions but cannot
  guarantee response times.

## License

This library is licensed under the MIT-0 License. See the [`LICENSE.md`](../LICENSE.md) file in the repository root.
