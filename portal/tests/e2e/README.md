# Playwright E2E harness — the two access-affecting controls

Covers the two controls added to the portal:

- **Remove a member from a team** — `src/app/w/[workshopId]/t/[teamId]/team/page.tsx`
- **Disable / restore platform access** — `src/app/admin/page.tsx`

Both go through `ConfirmActionDialog` and report through `ActionOutcome`.

The browser is **visible** (`headless: false` in `playwright.config.ts`) because watching the
dialog take and lose focus is the point of this suite.

---

## Why these specs exist at all

The portal's unit suite runs under `environment: "node"` with no DOM
(`vitest.config.mts`), so it can cover gating predicates, message construction and
request correlation as pure functions — and it does. What it structurally
**cannot** observe is anything requiring a real focus model, a real tab order or a real network
stack. That is exactly what these four assertions are:

| # | Behaviour | Where |
|---|---|---|
| 1 | Focus does not land on `<body>` after a successful action | `remove-member.spec.ts` "priority 1", `user-access.spec.ts` "priority 1" |
| 2 | Focus is not lost when Confirm disables itself, and **Escape still dismisses in flight** | both specs, "priority 2" |
| 3 | The focus trap holds in both directions, **including while the focusable set changes** | both specs, "priority 3" |
| 4 | `disabled` genuinely prevents a second submit — exactly ONE request on the wire | both specs, "priority 4" |

---

## The two ways a spec authenticates, and why there are two

**`access-controls.auth.spec.ts` signs in for real.** Password, then the pool's mandatory TOTP
challenge, answered by computing a code from a test account's enrolment secret
(`tests/e2e/totp.ts`). No seam of any kind. This is the *only* evidence that the sign-in journey
works — if it is skipped, nothing about authentication has been verified.

**`remove-member.spec.ts` and `user-access.spec.ts` mint a session cookie**
(`fixtures/session.ts`) and serve their own tRPC responses (`fixtures/trpc.ts`).

That is **not an auth bypass**, and the distinction matters:

- There is **no test-only code path in the application** — no flag, no env check, no header.
  The fixture does what a browser does after a successful sign-in: presents a session cookie
  that the server verifies with its own signing secret. Forging one requires `NEXTAUTH_SECRET`,
  i.e. the server's key. Any deployment whose secret differs rejects these cookies outright.
- The pool stays `MfaConfiguration: ON`. Nothing is re-enrolled and no pool config is touched.
- The minted `accessToken` is visibly a placeholder that no service accepts, which is why these
  specs serve their own transport rather than reaching the services. They test the **browser's**
  behaviour and they say so.

The reason is determinism. Priorities 2 and 3 are keyboard-timing assertions that must be run
many times — one green run of a focus race is not evidence. Driving the real TOTP challenge per
repetition would mean one code per sign-in, `freshTotp` waiting up to 30s for a clean window,
and a suite whose runtime is dominated by MFA. Worse, a Cognito hiccup would be
indistinguishable from a focus defect.

Note also that `serveTrpc` replaces only the **far side of the socket**. The tRPC client, React
Query, the batching link, superjson, the mutation callbacks, `variables`-based correlation and
the invalidate-then-refetch cycle are all real. Priority 4 counts requests with
`page.on("request")`, so it observes HTTP genuinely leaving the browser — a mocked client would
only prove a mocked client was called once.

---

## Environment

Nothing here is committed. Every value comes from the process environment.

### For the browser-behaviour specs (`remove-member`, `user-access`)

| Variable | Needed | Notes |
|---|---|---|
| `NEXTAUTH_SECRET` | yes | Read from the environment, else from `.env`, which is where local dev already keeps it. If you can run the portal locally you can run these specs with no extra setup. |

If it is absent, both specs **skip** with a message naming the variable. They never fail with a
confusing selector error and never silently pass.

### For the real-sign-in spec (`access-controls.auth.spec.ts`)

| Variable | Needed for | Notes |
|---|---|---|
| `E2E_ADMIN_EMAIL` | all tests in the file | An ADMIN or FACILITATOR. Anything lower is redirected away from `/admin`. |
| `E2E_ADMIN_PASSWORD` | all tests | Permanent, not the temporary invite password. |
| `E2E_ADMIN_TOTP_SECRET` | all tests | Base32, as Cognito issues it. Tolerates lowercase, `=` padding and the spaces authenticator apps insert. |
| `E2E_TEAM_URL` | the live removal test | e.g. `/w/<workshopId>/t/<teamId>/team`. |
| `E2E_REMOVABLE_MEMBER_NAME` | the live removal test | Display name of a **disposable** member. |
| `E2E_DISABLE_TARGET_NAME` | the live disable/restore test | Display name of a **disposable** account. |
| `E2E_FACILITATOR_EMAIL` / `_PASSWORD` / `_TOTP_SECRET` | the live gating test | A real FACILITATOR. |
| `E2E_ADMIN_ROW_NAME` | the live gating test | An ADMIN other than the facilitator, as the lateral-attack target. |

**The TOTP secret must belong to a purpose-made test account.** Never point it at a real
operator's authenticator — that would put a permanent second factor for a human's account into
CI configuration. See the header of `tests/e2e/totp.ts`.

**The destructive tests will not choose their own targets.** A removal is a hard delete and a
disable irreversibly destroys pending invitations, so if `E2E_REMOVABLE_MEMBER_NAME` /
`E2E_DISABLE_TARGET_NAME` are unset those tests skip. A spec that picked its own victim would be
a spec that removes someone's real teammate. The disable test restores access in a `finally`
block and shouts loudly if it could not.

### Services

The real-sign-in spec needs the whole stack.

The services live in this repository at [`../../../services`](../../../services) (see its
[README](../../../services/README.md)). Each HTTP service there has a local entry point, started from its
own package directory with `pnpm dev` (`tsx watch src/local.ts`), listening on ports 4010–4020 — for example
`identity` on 4011, `team` on 4012, `user-access` on 4020. Install once from `services/` with
`pnpm install`.

⚠ **There is no local gateway in this repository.** The portal's `.env.example` points `BACKEND_URL` at
`http://localhost:8080`, a single origin fronting the services; nothing in this repository starts a
process on `:8080`, so you must provide one (or point `BACKEND_URL` at a deployed API) for this spec to
reach the services. This suite only needs to be able to *reach* it.

⚠ **A process manager reporting "UP" is not proof.** A PID check is not a listening socket: `tsx` can kill
its children and never restart them, leaving every service "running" with nothing listening. Verify with
a socket check:

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':40[12][0-9]'
```

Note that `user-access` (port 4020) is the service behind `setUserAccess`. It refuses to start
without `COGNITO_USER_POOL_ID` and credentials that can write to the pool.

---

## Running

```bash
pnpm test:e2e                                   # everything
pnpm exec playwright test remove-member         # one spec
pnpm exec playwright test -g "priority 4"       # one behaviour
pnpm exec playwright test --repeat-each=20 -g "priority 2"   # a focus race, 20x
```

### The portal must be servable, and `next dev` may not be

`playwright.config.ts` boots **the portal** with `pnpm dev` and `reuseExistingServer: true`.

On this machine `next dev` was **unusable**: `ulimit -n` is 1048576 while
`kern.maxfilesperproc` is 61440, and that mismatch makes Watchpack hit `EMFILE: too many open
files`. Next then never scans `src/app`, so *every* route — including `/login` — returns 404 and
the route manifest is empty. It looks exactly like a broken test.

Two things fix it, and both were needed here:

```bash
ulimit -n 10240                            # a SANE limit, not a huge one
pnpm exec next build                       # no file watchers at all
AUTH_TRUST_HOST=true pnpm exec next start --port 3001 -H 127.0.0.1   # loopback only
```

`AUTH_TRUST_HOST=true` is required for a production server: Auth.js v5 otherwise refuses with
`UntrustedHost` and every session read 500s. It is a harness environment variable, not a code
change.

---

## Validating the tests themselves

A test that has never failed has proven nothing.

```bash
tests/e2e/mutation-check.sh        # all six mutations
tests/e2e/mutation-check.sh 3     # just one
```

Each mutation breaks the implementation in one realistic way, rebuilds, runs the spec that
should catch it, and restores the original **verified by sha256**. Mutations are written as
changes a developer could plausibly make — not `if (true) return` stubs, which this repo's
ESLint config rejects as errors. Switching off the lint gate to run a mutation harness would
have broken the thing being measured.

The script restores by **file copy, not git**, and refuses to start if the working tree already has
changes to the files it edits. When it was written both features were uncommitted
(`ConfirmActionDialog.tsx` was untracked), so `git checkout --` would have *deleted* the implementation
rather than restored it; a file-copy restore stays safe whatever the git state.

### ⚠ DEFECT-3 — this script destroyed the team page once (fixed, but read this)

The first version keyed each backup on `basename "$f"`. Under Next's App Router **every route
file is named `page.tsx`**, so the team page and the admin page both mapped to the backup key
`page.tsx`. The admin page's copy overwrote the team page's, and the restore then wrote
**admin-page content into the team page**. The sha256 check did not catch it: the recorded
checksum was overwritten by the same collision, so the restore verified against the wrong
file's hash and reported `sha256 verified`.

The loss was real. The team page's removal feature existed only in the working tree, so
`git` had nothing to restore, and recovery depended on a stale build artefact that happened to
hold a pre-corruption copy of the route.

Fixed three ways, all in `mutation-check.sh`:

1. `backup_key()` derives the key from the **repo-relative path**, not the basename.
2. A **collision check** refuses to run if two sources still map to one slot.
3. The backup is **`cmp`-verified against the original before any edit**, and each
   inter-mutation restore is `cmp`-verified too, aborting rather than compounding.

Lesson worth keeping: a restore mechanism is only as good as the uniqueness of its keys, and
"verified by checksum" is worthless when the checksum shares the collision.

---

## Known defects found by this harness

> ✅ **BOTH DEFECTS BELOW ARE FIXED, and their specs now PASS** (26/26 across
> `remove-member` + `user-access`). The fix is the `focusout` rescue plus
> the disabled-trigger fall-through in `ConfirmActionDialog.tsx`.
>
> The two sections are kept as the RECORD of what the harness found and why the specs exist —
> they are still the regression tests. **The "currently failing" wording below is historical
> and no longer true.** It is called out here rather than deleted because a reader who trusted
> it would conclude a green suite was broken, which is exactly the misdiagnosis the
> "Page not found" note at the top of `playwright.config.ts` warns about.

### DEFECT-1 — dismissing mid-flight strands focus on `<body>` (team page) — FIXED

`tests/e2e/remove-member.spec.ts` → "DEFECT-1: dismissing while the request is in flight must
not strand focus on `<body>`" — **was failing deterministically; now passes.**

Dismissal while pending is explicitly supported (`onDismiss` documents that it "REMAINS
AVAILABLE WHILE PENDING, deliberately", because `backendFetch` passes no `AbortSignal`). But
while the removal is in flight the trigger renders `disabled` and reads "Removing…", and the
cleanup guard in `ConfirmActionDialog.tsx` was (before the fix):

```ts
const doomed = returnToFallbackRef.current?.() ?? false;
if (!doomed && opener instanceof HTMLElement && opener.isConnected) {
  opener.focus();   // ← silent no-op on a DISABLED element
  return;           // ← returns, so the fallback is never tried
}
fallbackRef.current?.()?.focus();
```

`doomed` is false (no success yet) and `isConnected` is true (the row is still there), so it
takes the opener branch — but a disabled element cannot hold focus. Probed directly, the trigger
reports `{text:"Removing…", isConnected:true, disabled:true, focusable:false}`.

The operator has just dismissed a destructive action whose outcome is **unknown** — the moment
they most need to read the notice — and their keyboard is at the top of the document.

Adding a `disabled` check to the guard fixes this (verified locally, then reverted).

### DEFECT-2 — a row leaving the list strands focus on `<body>` (admin page)

`tests/e2e/user-access.spec.ts` → "when the row leaves the list mid-action, focus falls back to
the search box" — **was failing deterministically; now passes.**

Same class, **different trigger condition**, which matters for the fix. Here the opener takes
focus *successfully* and loses it moments later when the refetch drops the row. A recorded
focus-event trace ends with `focusin` on the trigger, so cleanup took the opener branch while
the trigger was legitimately mounted and enabled.

This screen deliberately passes no `returnToFallback`, reasoning that its row survives a
disable. That holds for the ordinary case and fails when the row leaves the list entirely (a
filter or search applied while the dialog is open, or a re-page). Its `fallbackFocus` is
correct and was verified working — `#user-search` is present and focusable throughout. It is
simply never called.

**Verified: the `disabled` check that fixes DEFECT-1 does not fix this.**

Both were left **failing rather than skipped or weakened** while they stood — they are the
regression tests. The fixes landed in `ConfirmActionDialog.tsx`: a `focusout` rescue that re-reads
`document.activeElement` on the next task and falls back only when focus actually settled on
`<body>`/null, bounded at 5s, plus a fall-through for the case where `opener.focus()` was a
no-op because the trigger was disabled. That one mechanism covers both triggers, including the
DEFECT-2 case the note above correctly predicted the `disabled` check alone would not fix.

---

## The Teams directory, Former-members and Restore specs

Covering the Teams directory, the Former-members section and the Restore control — and one
regression that reached a deployed environment.

| File | Scenarios | Notes |
|---|---|---|
| `roster-status.spec.ts` | 8 | **The regression that shipped**: a removed member rendered in Members AND Former members at once. Plus the legacy-row case, which is the dangerous direction. |
| `teams-directory.spec.ts` | 17 | Tab routing, the two documented nulls, `scopeTruncated`, paging underflow, debounce, `maxLength`, the 503, row links. |
| `restore-member.spec.ts` | 24 | The four focus/concurrency priorities, mirrored from `remove-member.spec.ts`, plus the ambiguous `audited: false` wording. |

Run: `pnpm exec playwright test roster-status teams-directory restore-member --workers=1`
(49 tests; 147/147 across `--repeat-each=3`, no flakes).

### ⚠ `roster-status.spec.ts` stubs the GATEWAY, not tRPC — and that choice is load-bearing

The roster filter is in the **router** (`src/lib/trpc/routers/team.ts`, the live-roster mapper), not the page —
`team/page.tsx` renders `team.members.map(...)` over whatever it is handed. So a `serveTrpc`
spec, which replaces the router, would hand the page an unfiltered roster and then "discover"
that the removed member renders in Members — **failing against correct production code.** That
is a defect manufactured by the harness, and it is the single easiest way to file a confidently
wrong report about this feature.

So that file stubs the far side of `backendFetch` instead (`fixtures/gateway.ts`, the `:8080`
gateway `.env` already points `BACKEND_URL` at). The real router, real filter, real
`isMember` derivation and real layout all execute.

It binds a real port, so it pins `mode: "serial"` **and** requires `--workers=1` on the command
— `--repeat-each` parallelises across worker *processes*, which `serial` does not constrain.

### ⚠ Paging buttons must be looked up inside `<main>`

`page.getByRole("button", { name: "Next" })` matches **two** elements on a development build:
the directory's own Next button and React's injected "Open Next.js Dev Tools" button, whose
accessible name contains "Next". Playwright's strict mode then fails with `resolved to 2
elements`, which reads exactly like a duplicated control in the product and is not one — it
appears and disappears with the serving mode rather than with the code under test. Scope to the
`main` landmark, not `.first()`: the assertion "there is no paging control" has to mean "none in
the tab panel", which `.first()` cannot express when the expected count is zero.

---

## Not covered here

- `tests/e2e/invite-flow.spec.ts` is **stale and cannot pass.** It begins by self-registering
  an account, and the pool has `AllowAdminCreateUserOnly: true` (confirmed directly against the deployed pool), so Cognito refuses the SignUp API outright. Untouched by this work.
- Load, soak and leak detection. These are functional browser specs; nothing here measures
  latency percentiles or heap growth.
- Concurrent same-target actions from two browser contexts (two operators disabling the same
  account simultaneously). The per-row `submitting` guard and the `currentAccessRef`
  correlation are single-tab mechanisms; cross-tab races are unverified.
- The services' own authorization. Every negative assertion here is about what the **client**
  offers. The server decides independently and that is where the actual boundary is.
