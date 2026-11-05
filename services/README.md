# praimana-services

The **backend** of the Praimana: 15 independently-bundled AWS Lambda handlers plus two
shared libraries, in one pnpm workspace.

The platform runs **AI-assisted experiences** — time-boxed events (hackathons, jams,
innovation sprints) in which a facilitator creates an *experience*, participants work in *teams*
through phased deliverables with an AI assistant, and judges score what the teams submit. This folder
owns every server-side rule in that story: who may see what, what a submission is, when scoring
closes, and how a ranking gets published.

There is no monolith and no shared server. Each service is its own Lambda with its own DynamoDB
tables, and they talk to each other over HTTP ("east-west" calls) with the caller's own identity
forwarded. The two clients — `portal/` (Next.js) and `desktop/` (Electron) — are consumers of
these APIs and live in their own folders beside this one at the repository root.

> **What decides access is [`ROLES.md`](ROLES.md), not this file.** It carries the full role × surface
> matrix and the predicate behind every row. This README describes what exists; `ROLES.md` describes
> who reaches it, and it is the live record for role visibility (architecture decision records are not
> included in this sample).

## Build, test, lint

Node ≥ 22, pnpm. From this directory:

```bash
pnpm install
pnpm run build        # esbuild bundle per handler   — 15 packages
pnpm run type-check   # tsc --noEmit                 — 17 packages (all of them)
pnpm run lint         # eslint                       — 16 packages (all but `shared`)
pnpm run test         # vitest, 3022 tests           — 16 packages (all but `desktop`)
pnpm run check:shared # the vendored-copy drift gate — see below
```

Six test files assert on the infrastructure CloudFormation templates (listed in
`service-shared/src/sibling-repo.ts`). They read every `infra/aws/app/platform*.yaml` tier template
through `infrastructureTemplateText()`, and report a todo instead of running only when that
directory is absent.

`build` uses esbuild, which **does not type-check** — so a green
build says nothing about types and `type-check` is the gate that does. Run both.

`pnpm -r run <script>` stops at the first failing package; use `pnpm -r --no-bail run lint` to see
every package's errors in one pass rather than fixing them one at a time.

The workspace is 17 packages and the counts differ per script because not every package declares
every one: `shared` is a vendored copy with nothing to bundle or lint, `service-shared` is a library,
and `desktop` (`@praimana/desktop-service`, a Lambda handler — **not** the Electron app) has no
tests.

## The services

Each row is a package directory. Everything in the first group is an HTTP service built on **Hono**,
bundled by esbuild into a single Lambda handler.

| Service | Owns | Talks to |
|---|---|---|
| `identity` | The caller's own profile (`/me`), the user directory, platform config, feedback and bug reports, platform-health and AWS **spend** panels | CloudWatch, Cost Explorer |
| `workshop` | Experiences: creation, status/lifecycle, phase definitions, per-team phase notes, assistant config, the format catalogue, and the ADMIN experience catalogue | — |
| `team` | Teams, membership, the **invitation** system (issue / accept / revoke / lookup), the cross-experience teams directory, entitlements, and access audit | Workshop, `bulk-provision` |
| `evaluation` | Submissions, their **release** snapshot, judge scores, per-member ratings, the activity read-model, and the published **ranking** | Workshop, Team, Docs |
| `ai` | AI assistant threads and messages, per-thread timing, thread sharing, and AI-assisted analysis of member contributions | **Bedrock**, through an Amazon Bedrock guardrail |
| `collaboration` | Team chat and tasks, plus the **realtime** team-event stream | — |
| `docs` | Team documents: upload URLs, versions, content reads, deletion | **S3** |
| `source` | Git activity per team: commits, files, commit detail | — |
| `notify` | All transactional email — invitations, password resets, release and experience updates | **SES v2** |
| `user-access` | Account lifecycle and access control: provisioning, enable/disable, MFA and password resets | **Cognito**, EventBridge |
| `desktop` | Desktop-app release metadata and download brokering | **S3** |

Event-driven and trigger Lambdas — no public HTTP surface:

| Package | Trigger | Does |
|---|---|---|
| `bulk-provision` | EventBridge, `bulk-provision.requested` | Resolves or creates each team, writes invitation rows, provisions Cognito accounts, emails every invitee, then emails the facilitator a report. Asynchronous so the upload never waits. |
| `cognito-presignup` | Cognito **PreSignUp** | The invite-only gate. Still load-bearing even with self-service sign-up off — do not delete it; see its header. |
| `cognito-postconfirmation` | Cognito **PostConfirmation** | Materialises the confirmed account: role resolved from the invitation row, user row written, event published. |
| `user-projection` | DynamoDB stream on `praimana-users` | Fans every user change into **all six** services' local users read-models, so member lists, chat authors and commit authors resolve without a cross-service hop. |

Libraries:

| Package | What it is |
|---|---|
| `service-shared` | The backend's own shared library — edge identity, the role tables and grant predicates, the DynamoDB and EventBridge adapters, east-west invocation with timeouts, metrics/EMF helpers, scoring rules, health. Imported as `@praimana/service-shared`. |
| `shared` | A **vendored copy** of the contract shared with `portal/` and `desktop/`, which each carry their own copy. This copy is pinned by `pnpm check:shared`. See "Vendored shared code" below. |

## API surface

All routes are mounted under `/v1`. Authorization is per-route and is **not** implied by this list —
read [`ROLES.md`](ROLES.md).

<details>
<summary><b>identity</b></summary>

```
GET    /me                      PATCH  /me
GET    /users                   GET    /user-names
GET    /config                  GET    /platform-health
GET    /cost
GET    /feedback                POST   /feedback
POST   /feedback/:id/acknowledge
```
</details>

<details>
<summary><b>workshop</b></summary>

```
GET    /workshops                              POST   /workshops
GET    /workshops/catalogue                    ← ADMIN only; id + name only
GET    /workshops/:id                          PATCH  /workshops/:id
PATCH  /workshops/:id/status
GET    /workshops/:id/assistants
GET    /workshops/:workshopId/phases           PUT    /workshops/:workshopId/phases
PATCH  /workshops/:workshopId/current-phase
GET    /workshops/teams/:teamId/phases         PUT    /workshops/teams/:teamId/phases/:phaseId
GET    /lookup/formats
```
</details>

<details>
<summary><b>team</b></summary>

```
GET    /teams/mine                             GET    /teams/directory
GET    /workshops/:workshopId/teams            POST   /workshops/:workshopId/teams
GET    /workshops/:workshopId/membership
PATCH  /teams/:teamId                          GET    /teams/:teamId/access
GET    /teams/:teamId/members                  DELETE /teams/:teamId/members/:userId
POST   /teams/:teamId/members/:userId/reactivate
GET    /teams/:teamId/former-members
POST   /teams/join

GET    /teams/:teamId/invitations              POST   /teams/:teamId/invitations
DELETE /teams/:teamId/invitations/:email       DELETE /teams/:teamId/invitations/:email/workshop
PATCH  /teams/:teamId/invitations/:email/accept
GET    /invitations/mine                       POST   /invitations/mine/accept
GET    /invitations/lookup                     GET    /invitations/lookup-by-email
GET    /invitations/lookup-by-token

GET    /entitlements/workshops                 GET    /audit/users/:userId
GET    /directory/user-ids                     GET    /directory/invited-by

POST   /workshops/:workshopId/bulk-provision
GET    /workshops/:workshopId/bulk-provision/batches
PATCH  /workshops/:workshopId/bulk-provision/batches/:batchId
```
</details>

<details>
<summary><b>evaluation</b></summary>

```
GET    /teams/:teamId/submissions              POST   /teams/:teamId/submissions
PATCH  /teams/:teamId/submissions/:id
POST   /teams/:teamId/submissions/:id/release  POST   /teams/:teamId/submissions/:id/reopen
GET    /submissions/:submissionId              GET    /submissions/:submissionId/snapshot
GET    /submissions/:submissionId/scores       POST   /submissions/:submissionId/scores
GET    /workshops/:workshopId/submissions
GET    /workshops/:workshopId/results          GET    /workshops/:workshopId/results/preview
POST   /workshops/:workshopId/results/publish
GET    /workshops/:workshopId/activity
GET    /teams/:teamId/ratings                  POST   /teams/:teamId/ratings
```
</details>

<details>
<summary><b>ai, collaboration, docs, source, notify, user-access, desktop</b></summary>

```
ai            GET  /teams/:teamId/threads             POST /teams/:teamId/threads
              GET  /threads/:threadId/messages        POST /threads/:threadId/messages
              POST /threads/:threadId/sync            GET  /threads/:threadId/timing
              POST /teams/:teamId/threads/:threadId/share
              GET  /teams/:teamId/ratings/summary     GET  /teams/:teamId/ratings/analysis
              POST /teams/:teamId/ratings/analyze     POST /teams/:teamId/ratings/publish

collaboration GET  /teams/:teamId/messages            POST /teams/:teamId/messages
              GET  /teams/:teamId/tasks               POST /teams/:teamId/tasks
              PATCH /teams/:teamId/tasks/:taskId
              GET  /teams/:teamId/events              ← WebSocket upgrade, not Hono

docs          GET  /teams/:teamId/docs                POST /teams/:teamId/docs
              DELETE /teams/:teamId/docs              GET  /teams/:teamId/docs/content
              GET  /teams/:teamId/docs/versions
              POST /teams/:teamId/docs/upload-url     POST /teams/:teamId/docs/upload-complete

source        GET  /teams/:teamId/commits             POST /teams/:teamId/commits
              GET  /teams/:teamId/commits/:sha        GET  /teams/:teamId/files

notify        POST /team-invite                       POST /registration-invite
              POST /password-reset                    POST /release-update
              POST /workshop-update

user-access   POST /access                            POST /provision

desktop       GET  /desktop/releases                  GET  /desktop/download
```
</details>

## Authorization model

Five platform roles: **ADMIN, FACILITATOR, JUDGE, EXECUTIVE, PARTICIPANT**.

The organising idea is **ownership, not rank**. A FACILITATOR reaches the experiences they created.
An **ADMIN is an ordinary owner role** on the same predicate
(`isStaffRole && ownsWorkshop`) — an admin sees no other owner's experiences, scores or anything else,
only the experiences the admin created. That change closed seven blanket role grants.

The one deliberate exception is `GET /v1/workshops/catalogue`: **id and name only, every owner's
experiences, ADMIN-only**, so the Administration tab's invite picker can *name* an experience it does
not own. An admin who picks one there can invite into it and still cannot open it.

JUDGE and EXECUTIVE reach what their **invitation** granted — an entitlement set that accumulates.
PARTICIPANT reaches their own team.

Identity arrives two ways, both resolved by `edgeIdentityMiddleware` in `service-shared`: a Cognito
JWT from the API Gateway authorizer, or forwarded internal-hop headers on an east-west call. **An
absent or empty claim is a deny, never a wildcard.**

[`ROLES.md`](ROLES.md) is the full matrix. Read it before changing any guard.

## Data

One DynamoDB table per concern, owned by exactly one service. Names come from `TABLE_*` env vars and
default to the values below.

| Service | Tables |
|---|---|
| `identity` | `users`, `feedback`, `cost-cache` |
| `workshop` | `workshops`, `phases`, `team-phases`, `formats` |
| `team` | `teams`, `team-members`, `invitations`, `audit`, `bulk-batches`, `team-users-readmodel` |
| `evaluation` | `submissions-v2`, `scores`, `member-ratings-v2`, `workshop-results`, `evaluation-users-readmodel` |
| `ai` | `ai-threads`, `ai-messages`, `team-ai-ratings`, `ai-users-readmodel` |
| `collaboration` | `messages`, `tasks`, `collaboration-users-readmodel` |
| `docs` | `docs`, `docs-users-readmodel` |
| `source` | `git-commits`, `git-files`, `source-users-readmodel` |

All prefixed `praimana-`. The six `*-users-readmodel` tables are projections maintained by
`user-projection`, never written by hand.

## Events

EventBridge, published by the owning service:

```
user.created           user.updated
team.created           member.joined      member.left     member.rated
workshop.created
submission.created     submission.submitted
submission.scored      submission.reopened
invitation.revoked     bulk-provision.requested
doc.docx
```

Consumers are **idempotent** — delivery is at-least-once. `bulk-provision.requested` is the one event
that drives a whole workflow rather than a projection update.

## Realtime

`GET /v1/teams/:teamId/events` on `collaboration` is a **WebSocket** upgrade, handled outside Hono in
`ws-server.ts`. An in-process pub/sub bus (`live-bus.ts`) fans route-handler writes out to connected
clients; it is deliberately separate from EventBridge, which is fire-and-forget to external consumers
and cannot be read back in-process to push to a live stream. The upgrade is authorized and
session-bound — see `collaboration/src/ws-server.ts` (JWT check via `verifyJwtIdentity`, team
membership via `team-access.http.ts`) and its tests in `ws-authz.test.ts` and `ws-session-bound.test.ts`.

## Cross-cutting invariants

These hold everywhere and are the things to preserve when changing code here:

- **Every external call has a timeout.** `EAST_WEST_TIMEOUT_MS` bounds every service-to-service hop;
  each parallel probe carries its own `AbortSignal` so one slow callee cannot pin a page.
- **Every fan-out is bounded**, and the cap is *reported* rather than silently applied — a quietly
  truncated list reads as "it does not exist".
- **Fail-closed, and 503 ≠ 403.** "We could not determine your access" must never render as "you do
  not have access", and an unavailable dependency must never produce a plausible empty page. An
  empty list that looks correct is the defect this platform has shipped twice.
- **Consumers are idempotent**; assume at-least-once delivery.
- **Null is not zero.** A count that could not be read is `null`, never `0` — an operator would act
  on a number.

## Vendored shared code (`shared/`)

`shared/` is a **copy**, not a dependency. A copy also lives in `desktop/shared` and `portal/shared`,
so that **each of the three folders builds, tests and releases on its own**, with no shared package to
publish, version or install first. There is no canonical upstream: the three copies are peers.

`service-shared/` is different — it is this workspace's own library, not a vendored copy.

### What is in it, and why only this much

Four modules, ~710 lines. They are the intersection actually used by all three consumers — measured
by mapping every exported symbol to the files importing it, not by reading names:

| Module | What it decides |
|---|---|
| `constants/phase-progress.ts` | The first-phase word gate: `MIN_FIRST_PHASE_WORDS`, `countWords`, `isPhaseNotesUnlocked` |
| `constants/support.ts` | Bug reports and feedback: the labels, the two kinds, the subject/description word and character bounds |
| `constants/chat-limits.ts` | The team-chat message bound (`MAX_TEAM_MESSAGE_CHARS`) the collaboration service enforces |
| `types/user.ts` | The platform roles and the predicates over them (`canSignInToDesktopApp`, `canAccessStaffScreens`) |

The `portal/` and `desktop/` copies carry more modules than this one, on purpose: those serve one or
two consumers, not all three (e.g. `desktop-link`, `phase-links` → desktop + portal; `roles`,
`profile`, `scoring` → portal + services). Adding a module here means it is needed by **all
three** — otherwise it belongs in the folder that uses it.

In the backend services this is consumed by `identity` above all: the report bounds the API refuses
on, `countWords`, and the role predicates the route gates use.

### ⚠ The risk being accepted, stated plainly

Every one of these three modules exists *because* it must not be duplicated, and each has already
caused a real bug in this codebase when it was:

- the identity service kept its own `MAX_FEEDBACK_MESSAGE = 8_000`, while the test asserting drift was
  impossible only covered three of the four readers — so editing the shared number would have moved
  the form and left the API's refusal behind;
- the portal carried an inline `role === "EXECUTIVE" || role === "PARTICIPANT"` beside
  `canSignInToDesktopApp`, which is how a UI ends up offering something the service then refuses;
- `countWords` is shared precisely so a live counter and the gate cannot disagree — two
  implementations is how somebody sees "20 / 20" next to a disabled button.

Duplicating them buys independent builds and pays for it in drift. The mitigation is not discipline,
it is the check below: **duplication you can detect is a different thing from duplication you
cannot.**

⚠ **This folder is the authoritative one for these rules.** The service's refusal is what decides; the
clients' copies only decide what they show a person *before* asking. Keep it that way — it is what
makes a stale client copy survivable rather than a correctness bug.

### Keeping the copies honest

The shared modules are meant to be byte-identical in all three copies (`index.ts` differs by design,
since each copy exports a different module set). From the repository root, this prints one hash per
copy for each shared module — each group should match:

```bash
for f in constants/chat-limits.ts constants/phase-progress.ts constants/support.ts types/user.ts; do
  echo "$f"
  for r in desktop portal services; do echo "  $(shasum -a 256 "$r/shared/$f" | cut -c1-16)  $r"; done
done
```

This folder's side of that check is `pnpm check:shared` (`scripts/check-vendored-shared.sh`), which
hashes the whole `shared/` tree (`*.ts` only — see "Imports" below for why) and fails on mismatch
against a pinned value (`ee20fcc13dbe7d44`, overridable with `EXPECTED_SHARED_HASH`). It pins this
copy only; the loop above is what compares it against the other two.

**Wire this into CI** as a job that fails on mismatch (CI/CD pipelines are not included in this
sample). Without it the copies drift silently, which is the one outcome this whole arrangement
cannot survive. ⚠ This is not hypothetical: the gate was **already red** once for a reason unrelated
to drift (six test files sat in the hashed tree, hashing `c763d4db27ec33b3`) and nothing said so out
loud until it was found by hand.

To change a shared rule: edit it in one copy, copy it into `desktop/shared`, `portal/shared` and
`services/shared`, update the pinned hash in `scripts/check-vendored-shared.sh`, and release all three
together. These files historically change *with* their consumers — 4 of 4 commits to
`support.ts` and 10 of 12 to `types/user.ts` also touched consumer code — so a coordinated change is
the normal case, not the exception.

### Imports

The copies import internally by relative path (`./phase-progress`), so no edits were needed to vendor
them. Consumer code still imports the package specifier:

```ts
import { MIN_FIRST_PHASE_WORDS, checkFeedbackReport } from "@praimana/shared";
```

That specifier keeps working because `shared/` is a **workspace package of this repo**, not a path
alias. It carries a `package.json` (`"name": "@praimana/shared"`, `"main": "index.ts"`) and is
listed in `pnpm-workspace.yaml`; consumers declare `"@praimana/shared": "workspace:*"` and pnpm
links it into `node_modules`. TypeScript, `tsx` and esbuild all resolve it by normal module
resolution — no `paths` entry, and no per-service bundler alias to keep in sync across 15 `build`
scripts.

This mirrors how `service-shared/` already works in this repo, and it is still fully self-contained:
`workspace:*` resolves inside this repo and nowhere else.

> Earlier revisions of this file prescribed a `tsconfig` `paths` alias instead. Both approaches
> satisfy the constraint that this repo builds alone; the package form was chosen because it needs no
> bundler-side twin.

The two added files (`package.json`, `tsconfig.json`) are **not** part of the shared contract, so
`check:shared` hashes only `*.ts`.

## ⚠ Standalone-repo gotchas worth recording

This repo is self-contained; a few things are easy to get wrong and each fails in a way that names
the wrong cause. They are handled; this records them so they are not "fixed" again differently.

| Item | Symptom if missing/wrong | Now |
|---|---|---|
| `.npmrc` | `ERR_PNPM_FETCH_401` against an internal registry mirror — read as an auth problem with this repo | present, see its own header |
| `eslint.config.mjs` | `pnpm lint` failed in **all 16 packages** with "couldn't find an eslint.config file" — read as 16 broken packages | present, services-scoped |
| `allowBuilds` (pnpm) | see below | answered `esbuild: false` |
| `check:shared` drift gate | `shared/` hashed the wrong value when test files were misplaced | pinned to the current tree (see "Keeping the copies honest") |

⚠ **`allowBuilds: esbuild: false` is correct and `true` breaks all 15 builds.** pnpm blocks dependency
build scripts by default and, on the first install that hits one, writes the placeholder
`esbuild: set this to true or false`. Answering it the intuitive way is a trap: esbuild's
`bin/esbuild` is a JS shim that spawns the real binary out of `@esbuild/darwin-arm64` (an ordinary
dependency, no build step), and that path works untouched. esbuild's postinstall is an *optimisation*
that overwrites the shim with the native binary — but pnpm has already linked `.bin/esbuild` as a
wrapper running `exec node …/bin/esbuild`, so Node is then handed a Mach-O and all 15 builds die with
`SyntaxError: Invalid or unexpected token`. The full reasoning is in `pnpm-workspace.yaml`. The
`ERR_PNPM_IGNORED_BUILDS` warning on a fresh install is noise for this dependency, not a defect.

⚠ **A pnpm major-version change purges `node_modules` and cannot prompt in CI.** If `node_modules`
was built by a different pnpm major than the one on PATH, every script fails before running anything
with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` — which names neither the version gap nor the
script you ran. Re-install with `pnpm install --config.confirmModulesPurge=false`. Note that
`CI=true` also works but implies `--frozen-lockfile`, so it fails instead if the lockfile is
genuinely out of date.

⚠ **`check:shared` guards the vendored copy.** `service-shared/src/` holds the service-shared
implementations and their tests. The three test files under `shared/` belong there — they are part of
the byte-identical vendored copy, and the expected hash `check:shared` compares against accounts for
them. A stray `*.ts` added under `shared/` changes that hash and trips the drift gate.

⚠ **Architecture decision records are not included in this sample.** [`ROLES.md`](ROLES.md) is the
live record for role visibility and states the governing rules directly.

## Important Notes

- **This is sample code, not a production service.** These services demonstrate how to build an
  AI-assisted workshop backend on AWS. They are provided as a starting point for your own
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
