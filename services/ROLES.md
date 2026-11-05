# The access matrix

Every rule below was read out of this repo's source, not recalled — each row names the predicate that
decides it, so a reader can check the claim rather than trust it. It was updated when the four gaps this
file originally listed were closed — see the end.

⚠ **THIS FILE IS A DESCRIPTION, NEVER THE RULE.** The predicates it cites are the rule. If this table and
the code disagree, the code wins and this file is a bug. It is written down because a matrix scattered
across eleven services is a matrix nobody can check.

⚠ **THE PORTAL'S CHECKS ARE COURTESIES.** Every service route is mapped behind a JWT authorizer that does
no role scoping, and the browser holds its own ID token — so a caller can reach these services without
passing through the BFF. Role checks in the portal exist to turn a would-be 403 into an immediate,
specific message. **The services enforce; the UI explains.**

---

## The five roles

`ROLE_PRECEDENCE` in `shared/types/user.ts` — lower index wins when a Cognito token carries several
groups, so a user in two groups collapses to the more privileged one.

| # | Role | What it is |
|---|---|---|
| 1 | `ADMIN` | Platform administrator. ⚠ **Not a universal override — see below.** |
| 2 | `FACILITATOR` | Runs experiences. The role that normally creates them. |
| 3 | `JUDGE` | Scores released submissions. Invitation-only, per experience. |
| 4 | `EXECUTIVE` | A team's read-only observer — **and the only role that submits.** |
| 5 | `PARTICIPANT` | Builds, in the desktop app. |

### ⚠ ADMIN is scoped to experiences it owns

The rule: an admin sees no other owner's experiences, scores or anything else — only the experiences the
admin created.

An admin who **created** an experience is its `ownerId` and has every owner power over it. An admin who
did not owns nothing there — the platform role grants no access to another owner's experience, its teams'
content, its submissions, its scores or its results.

Where `ADMIN` is still platform-wide, it is about the **platform** rather than about an experience: user
administration, the invitation matrix, and cost. Those rows are marked ⚙ below.

⚠ **ONE OPERATIONAL CONSEQUENCE, STATED PLAINLY.** An experience whose owner is deactivated is now
reachable by **nobody** — admin used to be the recovery path. An ownership-transfer route is needed before
this is safe in production, and does not exist yet.

---

## Signing in

| | ADMIN | FACILITATOR | JUDGE | EXECUTIVE | PARTICIPANT |
|---|---|---|---|---|---|
| May sign in to the portal | ✅ | ✅ | ✅ | ✅ | ✅ |
| Lands on | `/experiences` | `/experiences` | `/experiences` | `/experiences` | `/welcome` |
| Reaches the staff screens | ✅ | ✅ | ✅ | ✅ read-only | ❌ |
| May sign in to the desktop app | ❌ | ❌ | ❌ | ✅ | ✅ |

`canSignInToWebApp` / `canAccessStaffScreens` / `landingPathForRole`, all in `shared/types/user.ts`.
⚠ The sign-in gate **fails closed**: a token whose groups are not recognised mints no session at all.

---

## Experiences

`O` = only if the caller is the experience's `ownerId`.

| | ADMIN | FACILITATOR | JUDGE | EXECUTIVE | PARTICIPANT | Decided by |
|---|---|---|---|---|---|---|
| Create an experience | ✅ | ✅ | ❌ | ❌ | ❌ | `canCreateWorkshops` |
| List every experience's **id + name** | ✅ ⚙ | ❌ | ❌ | ❌ | ❌ | `GET /workshops/catalogue` |
| See it in `GET /workshops` | **O** | **O** | invited¹ | member | member | `workshop/src/routes.ts` — owners take `listByOwner`; others resolve `E(self)` |
| Read one by id | **O** | **O** | invited¹ | member | member | `requireWorkshopRead` |
| Rename / set status / set phases | **O** | **O** | ❌ | ❌ | ❌ | `isOwnerOrAdmin` (ownership only, despite the name) |
| **Transfer it to a new owner** | ✅ ⚙⁴ | ❌ | ❌ | ❌ | ❌ | `PATCH /workshops/:id/owner` |
| Set the current phase | **O** | **O** | ❌ | ❌ | ❌ | same |

¹ **A judge's entitlement is their invitation.** `WORKSHOP_POLICY.JUDGE = "REQUIRED"`, so a judge invite
must name a workshop, and that `invitation.workshopId` is the whole of their access. A judge is **never** a
team member — `team/src/routes.ts` refuses a membership row for ADMIN, FACILITATOR and JUDGE with a 400.

⚠ **The judge's read resolves through entitlement, not membership.** Previously the
list intersected candidates with team membership, which a judge can never satisfy, so an invited judge saw
an empty list and got 403 on every route in.

⚠ **`requireWorkshopRead` resolves ADMIN and owner WITHOUT a hop, and that is a correctness constraint.**
Team resolves ownership by calling that route, so a fall-through to the membership probe would give
`Team → Workshop → Team` on one Lambda pool — self-amplifying under load. Its tests assert the **hop
count**, not merely the status.

---

⁴ **Ownership transfer is platform administration, not an experience power** — an orphan has no owner
left to ask, so it sits with the role that administers the platform (the same ⚙ category as the
invitation matrix and the user directory). The current owner cannot hand their own experience over;
if that is wanted it is a separate, smaller grant.

---

## Team content — board, chat, AI threads, documents, phase notes

| | ADMIN | FACILITATOR | JUDGE | EXECUTIVE | PARTICIPANT | Decided by |
|---|---|---|---|---|---|---|
| Read a team's content | member only | member only | member only | member only | member only | `canReadTeamContent` |

⚠ **ROLE IS NOT CONSULTED AT ALL.** `canReadTeamContent` does `void role; return !!(await
members.get(teamId, userId))` — the `void` is deliberate and commented. A team's board,
chat, AI transcripts, files and phase notes are the team's, and an experience owner does **not** read them
ambiently. The phase **definitions** they own stay readable through `GET /workshops/:id/phases`; the team's
**answers** to them do not.

An EXECUTIVE or PARTICIPANT reaches this content by being on the team. An ADMIN or FACILITATOR reaches it
only by being on the team, which for ADMIN/FACILITATOR is impossible — so in practice **they cannot read
team content at all**.

---

## Teams — the roster, the directory and invitations

Distinct from team CONTENT above, and the distinction matters: this is the person↔team
**relationship** (who is on which team, and the invitations around it), not what the team wrote.
`O` = only if the caller owns the team's experience.

| | ADMIN | FACILITATOR | JUDGE | EXECUTIVE | PARTICIPANT | Decided by |
|---|---|---|---|---|---|---|
| Read a team / its roster | **O** | **O** | ❌ | member | member | `canRead` |
| Remove or reactivate a member | **O** | **O** | ❌ | ❌ | ❌ | `canWrite` |
| Browse the teams directory | **O** scoped | **O** scoped | ❌ | ❌ | ❌ | `canReadDirectory` + owned-workshop scope |
| See every team in an experience | **O** | **O** | ❌ | own teams | own teams | `seesAllTeams` |
| See members' **email addresses** | **O** | **O** | ❌ | ❌ | ❌ | same flag as above |
| Filter the user directory by an experience | ✅ ⚙ | **O** | ❌ | ❌ | ❌ | `/directory/user-ids` |
| Invite into a team | **O** | **O** | ❌ | ✅ member¹ | ❌ | `canWrite` |
| Invite a judge into **ANY** experience | ✅ ⚙² | **O** | ❌ | ❌ | ❌ | `mayGrantWorkshop` |
| Invite **themselves** into anything | ❌ | ❌ | ❌ | ❌ | ❌ | gate 3, `SELF_INVITATION_REFUSED` |

⚠ **ADMINISTRATION REQUIRES OWNERSHIP BUT NEVER MEMBERSHIP.** It cannot require membership: ADMIN,
FACILITATOR and JUDGE are refused a membership row outright, so a member-only rule would mean **nobody
could remove anyone from a team** and the audited `MEMBER_REMOVED` path would be unreachable. That is why
`canRead` was ownership-scoped rather than made member-only.

⚠ **A NON-OWNING ADMIN GETS AN EMPTY LIST, NOT A 403**, on "every team in an experience". The filtered
branch intersects with the caller's memberships, which for an admin is structurally none. That is a
truthful zero and it discloses nothing about whether the experience exists.

¹ Bounded by `ROLE_GRANTS` — an executive may invite a PARTICIPANT and nothing else.

² **⚠ THE ONE PLACE AN ADMIN REACHES ACROSS EXPERIENCES, AND IT IS DELIBERATE.** The rule: an admin
can invite any user into any experience from the Administration tab, as a facilitator does, but can never
add themselves to an experience. Inviting people INTO
experiences is platform user administration — the same ⚙ category as `ROLE_GRANTS` and the user
directory — so ownership is the wrong question for an admin here. A FACILITATOR still must own the
experience they name.

⚠ **THAT GRANT IS LOAD-BEARING ON THE SELF-INVITATION GATE, AND NEITHER IS SAFE ALONE.** An
invitation row is authoritative at signup — the pre-signup trigger admits on it and
post-confirmation reads the role off it — so "name any experience" without "never yourself" is
precisely the escalation: mint a JUDGE row for yourself in a stranger's experience, register the
second account, arrive inside their judging. The gate refuses a self-invitation for **every** role,
compares on the token's **verified** email claim, and is checked before any hop.

⚠ **WHAT THE SELF-CHECK DOES NOT CATCH, STATED PLAINLY: a second address the same person controls.**
`admin+judge@example.com` is a different string, and this platform's own dev users are plus-addressed,
so normalising plus-tags would break real accounts while still not catching a separate mailbox.
Email equality guards the easy, accidental and auditable case; **attribution and audit are the real
mitigation**, not this comparison. Also fails open by design when the token carries no email claim —
in which case an admin falls back to the ownership probe, so the wide grant is withheld rather than
the feature.

⚠ **AND THE PICKER NEEDED A NEW READ TO MAKE THIS USABLE.** `GET /v1/workshops/catalogue` — ADMIN
only, **id and name only** — is the long-promised "separate route". It is a narrow
widening of "admin cant see any other experiences": it discloses that an experience EXISTS and what
it is CALLED, so an admin can name it. No owner, status, dates, teams, members, submissions or
scores. An admin who picks one can invite into it; they still cannot open it.

---

## Submissions

| | ADMIN | FACILITATOR | JUDGE | EXECUTIVE | PARTICIPANT | Decided by |
|---|---|---|---|---|---|---|
| Create / edit the draft | ❌ | ❌ | ❌ | ✅ member | ❌ | `requireSubmissionDraftWrite` |
| Release it to judges | ❌ | ❌ | ❌ | ✅ member | ❌ | `requireSubmissionRelease` |
| Reopen a released one | **O** | **O** | ❌ | ❌ | ❌ | `requireExperienceOwner` |
| Read the submission | team | team | entitled¹ | team | team | `requireSubmissionRead` |
| Read the pinned snapshot | team | team | entitled¹ | team | team | same |

⚠ **RELEASE IS THE EXECUTIVE'S, AND ONLY THEIRS** — `role !== "EXECUTIVE"` is refused locally, with no
hop. Releasing is the team's act through its executive; a facilitator cannot do it for them.

⚠ **REOPEN IS THE OWNER'S, NEVER THE EXECUTIVE'S.** The asymmetry is the design:
reopening *after* judges may have read and scored is an experience-integrity decision, so it belongs to
whoever is accountable for the experience and not to a party to the submission.

⚠ **A REOPEN WITHDRAWS THE PUBLISHED RANKING**, because the places are stored rather than
recomputed — a ranking left standing after its inputs reopen states an outcome its own scores no longer
support. **A published result is therefore retracted by a reopen**, and the owner must publish again. The
released snapshot survives: it is what already-cast scores were cast against.

---

## Scores

| | ADMIN | FACILITATOR | JUDGE | EXECUTIVE | PARTICIPANT | Decided by |
|---|---|---|---|---|---|---|
| Score a submission | ❌² | ❌ | ✅ entitled | ❌ | ❌ | `isScoringRole` + `requireScoringScope` |
| Read **every** judge's scores | **O** | **O** | ❌ | ❌ | ❌ | the scores route, by ownership |
| Read **their own** score | — | — | ✅ | ❌ | ❌ | same |
| Read **their own team's** scores + comments | ❌ | ❌ | ❌ | ✅ member³ | ❌ | same |

⚠ **A SCORE IS FINAL ONCE SUBMITTED.** The row is keyed `(submissionId, judgeId)` and the
write is conditional on `attribute_not_exists`, so a second score is refused 409 `ALREADY_SCORED` rather
than replacing the first. **This supersedes the original rule**, which said "re-scoring overwrites" — the
anti-ballot-stuffing purpose survives by a stronger mechanism.

⚠ **PUBLICATION CLOSES SCORING** — 409 `RESULTS_PUBLISHED`. Paired with the reopen rule above, that is
what keeps a stored ranking and its scores in agreement.

³ **The team's EXECUTIVE reads their own team's feedback** — the rule is that only the executive has
access to the judges' scoring. It closes a gap the ownership narrowing created:
with the team-read branch removed, a team had **no route to judge feedback at all** — the comments
were written about them and they could not read a word.

⚠ **`judgeId` IS STRIPPED FOR THE EXECUTIVE.** The feedback is the numbers and the comments; *which
judge wrote which* is attribution, not feedback. Handing a team that mapping turns the judged into
judges of the judges, and with a handful of judges an executive could deanonymise every comment
against the invitation list they can already see. Reversing this is one line; the reverse direction
is not recoverable.

⚠ **A PARTICIPANT STILL GETS NOTHING** — "only executive" is the rule, and it is the same shape as
every other executive-only grant (release, draft write).

⚠ **NOT GATED ON PUBLICATION**, as chosen. So an executive can read scores mid-judging, before every
judge has finished — the disclosure the original team-read removal was partly about. Gating this
branch on `publishedAt` is the fix if it bites, and needs no other change.

⚠ **THE OLD RULE, KEPT FOR THE RECORD:** It previously could, via the team-read branch —
a test asserted a PARTICIPANT receiving a judge's comment verbatim. **Consequence: a team has no route to
judge feedback at all.** If they should get it after publication, that is a rule nobody has written yet.

² **Fixed.** `SCORING_ROLES` was `{JUDGE, ADMIN}` and is now `{JUDGE}`. The old set let an
admin score a submission in an experience they did not own, and — because FACILITATOR was never in it —
made the same sentence false for one of the two owner roles: an owner who was a facilitator could not
score their own experience while an owner who was an admin could.

⚠ **NOBODY CAN NOW SCORE EXCEPT AN INVITED JUDGE.** There is no break-glass path for an experience whose
judges never arrive; the owner cannot stand in. That is the right default for a ranking published under
judges' names, but it is a deliberate loss of an escape hatch, not an oversight. ⚠ It also contradicts
the standing rule that **ADMIN and owner short-circuit before any hop**, which needs amending.

---

## Results

| | ADMIN | FACILITATOR | JUDGE | EXECUTIVE | PARTICIPANT | Decided by |
|---|---|---|---|---|---|---|
| Read the published ranking | **O** | **O** | ✅ entitled | ✅ entitled | ✅ entitled | `requireExperienceReader` |
| See their own score per team | — | — | ✅ | — | — | portal, from `forWorkshop` |
| Preview the unpublished ranking | **O** | **O** | ❌ | ❌ | ❌ | `requireExperienceOwner` |
| Publish it | **O** | **O** | ❌ | ❌ | ❌ | same |

⚠ **404 UNTIL PUBLISHED, FOR EVERYONE INCLUDING THE OWNER**. "Never render a partial ranking": with
five judges and two having scored, an order is a confident, wrong, public statement about named teams. The
owner's preview is a **separate route**, and it is labelled unpublished so no caller can mistake one for
the other.

⚠ **PUBLICATION IS ONCE**, enforced by a `ConditionExpression` rather than a preceding read — two owners
pressing Publish in the same second must not both write, with the stored ranking being whichever landed
second.

---

## Platform administration ⚙

Not experience-scoped. `ADMIN` is genuinely platform-wide here, and that is the intent.

| | ADMIN | FACILITATOR | JUDGE | EXECUTIVE | PARTICIPANT | Decided by |
|---|---|---|---|---|---|---|
| Reach the Administration area | ✅ | ✅ | ❌ | ❌ | ❌ | `canManageUsers` |
| See platform spend | ✅ | ❌ | ❌ | ❌ | ❌ | `canSeePlatformSpend` |
| Read the feedback inbox | ✅ | ✅ | ❌ | ❌ | ❌ | identity service |

### Who may invite whom — `ROLE_GRANTS`

| Inviter → | ADMIN | FACILITATOR | JUDGE | EXECUTIVE | PARTICIPANT |
|---|---|---|---|---|---|
| **ADMIN** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **FACILITATOR** | ❌ | ✅ | ✅ | ✅ | ✅ |
| **EXECUTIVE** | ❌ | ❌ | ❌ | ❌ | ✅ |
| **JUDGE** | ❌ | ❌ | ❌ | ❌ | ❌ |
| **PARTICIPANT** | ❌ | ❌ | ❌ | ❌ | ❌ |

⚠ A `FACILITATOR` cannot mint an `ADMIN`. The first admin comes from the seeded bootstrap, not from an
invitation.

### Which invitations must name an experience — `WORKSHOP_POLICY`

| Role | Policy | Meaning |
|---|---|---|
| `JUDGE` | `REQUIRED` | The invitation must name a workshop. A judge with none can see or score nothing. |
| `EXECUTIVE`, `PARTICIPANT` | `DERIVED` | Taken from the team they are invited to. |
| `ADMIN`, `FACILITATOR` | `FORBIDDEN` | Must **not** name one — their access comes from ownership. |

### Who may administer / see which user

`USER_ADMIN_GRANTS` (act on) and `USER_VISIBILITY_GRANTS` (see at all) are **separate tables, deliberately
not derived from each other** — "whom may I invite", "whom may I act on" and "whom may I see" are three
questions.

| Actor | May administer | May see |
|---|---|---|
| `ADMIN` | all five roles | all five roles |
| `FACILITATOR` | JUDGE, EXECUTIVE, PARTICIPANT | FACILITATOR, JUDGE, EXECUTIVE, PARTICIPANT |
| `EXECUTIVE` / `JUDGE` / `PARTICIPANT` | none | none |

⚠ A FACILITATOR can neither see nor act on an ADMIN — so an admin account cannot be learned about, or
disabled, by a facilitator. And the last enabled ADMIN cannot be removed at all.

### Who may hold a team-membership row

| ADMIN | FACILITATOR | JUDGE | EXECUTIVE | PARTICIPANT |
|---|---|---|---|---|
| ❌ | ❌ | ❌ | ✅ | ✅ |

Refused with a 400 on all three write paths. ⚠ **This invariant is load-bearing**, not hygiene: it is what
makes a judge's `isMember` a foregone `false`, which is why the entitlement branch could replace that probe
rather than adding a hop to it.

---

## Failure semantics — the rule that cuts across every row

⚠ **"COULD NOT DETERMINE" IS NEVER "YOU MAY NOT."** Every predicate above that crosses a service
boundary is three-valued, and an unanswerable probe is a **503 with `Retry-After`**, never a 403 and never
an empty list.

This is not defensive coding, it is a defect this platform has already shipped twice: a fail-closed catch
reported an infrastructure fault as an authorization answer, and a judge's empty list looked exactly like a
correct "you have none". The codes are distinct so a client can tell them apart without string-matching:
`MEMBERSHIP_UNAVAILABLE`, `ENTITLEMENTS_UNAVAILABLE`, `WORKSHOP_UNAVAILABLE`.

---

## What changed after this file first listed it as a gap

The ADMIN grants that were still broader than the stated rule have been closed — **seven of them, where this file first listed four**. Recorded here
because a matrix that quietly acquires the fixes it once flagged teaches nobody anything.

| Was | Now | Where |
|---|---|---|
| `SCORING_ROLES = {JUDGE, ADMIN}` — an admin could score any experience | `{JUDGE}` | `evaluation/src/authz.ts` |
| `decideSubmissionScope`: `if (role === "ADMIN") return "allow"` | resolves by entitlement like anyone else | `evaluation/src/authz.ts` |
| judging worklist: `allowed = role === "ADMIN" \|\| ownerId === callerId` | ownership only | `evaluation/src/routes.ts` |
| `canRead`: `if (role === "ADMIN") return true` — read ANY team | resolves through `isStaffRole && ownsTeamWorkshop`, like a facilitator | `team/src/authz.ts` |
| teams directory: `if (role !== "ADMIN")` skipped the scope — **every team on the platform** | scoped to owned workshops, capped and truncation-reported | `team/src/routes.ts` |
| `seesAllTeams`: `role === "ADMIN" \|\|` — every team **and every member's email** in any workshop | ownership only | `team/src/routes.ts` |
| `mayGrantWorkshop`: `if (role === "ADMIN") return true` — invite a JUDGE into ANY experience | must own the workshop named | `team/src/routes.ts` |

⚠ **SEVEN AND NOT THE FOUR THIS FILE ORIGINALLY LISTED.** The two evaluation sites were found by grepping
for the pattern after the first four were closed, rather than by reading the matrix — and **neither was
covered by any test**, so removing them broke nothing and would have gone unnoticed.

⚠ **THE LAST TWO WERE INERT INDIVIDUALLY AND ONLY CLOSED TOGETHER.** The worklist route falls through to
`requireScoringScope`, which calls `decideSubmissionScope` — so an admin refused by the owner check was
allowed by the scope predicate one line later. Either fix alone changes no behaviour. Both are now pinned
by a test that was mutation-checked against each grant separately.

⚠ **THE INVITE ONE WAS THE ESCALATION, NOT MERELY AN OVER-GRANT.** An invitation row is authoritative at
signup — the pre-signup trigger admits on it and post-confirmation reads the role off it — so an admin
could mint themselves a JUDGE invitation into a stranger's experience, register the second account and
arrive inside its judging. That is the attack `resolveInviteWorkshops`' own header describes for a forged
workshop id, spelled with a role instead.

### What it cost, stated plainly

- **An admin's reads now cost an east-west hop** that used to be free (`canRead`, the roster, the
  directory scope). Cycle-safe only because the Workshop service resolves both owner roles from its own
  row; if that ever changes, one hop becomes `Team → Workshop → Team` on a single Lambda pool and nothing
  in the team service fails. Pinned by a hop-count assertion that says so.
- **An admin who owns more than 50 workshops now gets a SHORT directory page**, flagged by
  `scopeTruncated`. Previously they got everything, unscoped.
- **`resolveWorkshopNames` has no caller left** — an admin's names now arrive with the ownership scope in
  the same hop. Dead code, not wrong code; it and `MAX_DIRECTORY_WORKSHOP_NAMES` should go.
  - **`MAX_DIRECTORY_WORKSHOP_NAMES` is now gone.** It was unreferenced, and once the repo's missing
    `eslint.config.mjs` was restored it was the only lint error in all 16 packages. `resolveWorkshopNames`
    itself is still retained — the interface, its HTTP implementation and its tests are all correct, and
    removing them is the separate cleanup its own note describes.
  - ⚠ **Deleting it briefly left `resolveWorkshopNames` an unbounded fan-out, and that is now closed.**
    The method never capped itself ("the fan-out is bounded by the CALLER"), so once the caller went
    there was no cap anywhere — an uncapped `Promise.all` of `GET /v1/workshops/:id`, one per id, on a
    method any future caller can reach. Rather than move the number into a comment for that caller to
    honour, the cap moved INTO the method as `MAX_WORKSHOP_NAME_PROBES` (still 25), which is the only
    place that can guarantee it. It **deduplicates before it slices**, so a repeated workshop id cannot
    crowd out a resolvable name.
  - **The bound is now tested, which it never was** — not before the move and not after. Three cases in
    `workshop-directory.http.test.ts` (cap at 25 given 100 distinct ids; dedupe-before-slice; one probe
    per repeated id), each mutation-checked: removing the cap, inverting the order, and removing the
    dedupe each fail a test. Previously the bound was asserted only by a constant existing.

### Documentation now contradicted by the code

Three written rules say the opposite of what ships. Each is annotated at the test that inverted it,
rather than diverged from silently:

1. **The original written rule** — *"admin should see all workshops teams and users which are created by other users"*.
   **Superseded by the current rule** — an admin sees no other owner's experiences, scores or anything
   else, only the experiences the admin created. An ADMIN is an ordinary OWNER role,
   reading what a FACILITATOR reads on the same `isStaffRole && ownsWorkshop` predicate. The single
   exception is `GET /v1/workshops/catalogue` — **id and name only, every owner's experiences,
   ADMIN-only** — which exists so the Administration tab's invite picker can NAME an experience it does
   not own. An admin who picks one there can invite into it; they still cannot open it.
2. **The original short-circuit rule** — *"ADMIN and owner short-circuit before any hop"*, for scoring and the
   submission read. **Also superseded**: the short-circuit is gone, so an admin's read now costs the
   east-west hop it used to skip — a real latency change, not only an access one.
3. **The original re-scoring rule** — *"re-scoring overwrites and does not create a second"*, superseded by the immutable score.

> ⚠ **THE WRITTEN RULES CITED ABOVE ARE NOT IN THIS REPO, AND THAT IS WHY THIS SECTION STATES THE RULES
> RATHER THAN ONLY NAMING THEM.** The decision records are maintained outside this repository, so a
> reference to one of those documents points at something a reader here cannot open. Unlike config
> files whose absence breaks a build, a dangling documentation reference fails silently.
>
> **Treat this file as the live record for role visibility.** If the decision records are ever brought
> into this repo, the divergences above are what needs folding into §C.

## Known gaps that remain

1. ~~**NO RECOVERY PATH FOR AN ORPHAN.**~~ **CLOSED** — `PATCH /workshops/:id/owner`, ADMIN
   only, moves an experience to a new owner. ⚠ **The new owner's ROLE is verified against Identity,
   and that is what keeps the route from being an escalation primitive:** `isOwnerOrAdmin` is pure
   ownership with no role check, so an experience handed to a PARTICIPANT would let them rename it,
   set its phases and reopen its submissions. An unwired directory port **refuses (501)** rather than
   transferring unchecked; an undetermined lookup is **503**, never "no such user".

   ⚠ **A MOVE, NOT AN UPDATE, DONE IN ONE TRANSACTION.** `workshops` is keyed (ownerId HASH, id
   RANGE), so `ownerId` IS the partition key. Two non-atomic writes could leave two rows sharing one
   `id`, and `getById` resolves through the id-index GSI with `Limit: 1` — the experience would answer
   to whichever copy the index returned, with two people each seeing themselves as owner.

   ⚠ **STILL OPEN: a team whose `workshopId` was CLEARED.** That orphan has no experience to transfer,
   so this route does not reach it. Nobody can administer such a team.
2. ~~**A team has no route to judge feedback.**~~ **CLOSED** — the team's EXECUTIVE reads
   their own team's scores and comments, with `judgeId` stripped. See footnote ³ on the Scores table,
   including the two things that were decided rather than derived: participants get nothing, and the
   read is not gated on publication.
3. ~~**`GET /v1/audit/users/:userId` is still platform-wide for both staff roles.**~~ **CLOSED.** It is
   now scoped per entry, by what the entry is *about*:
   - **Team-scoped** entries (`MEMBER_REMOVED`, `MEMBER_RESTORED` — they carry `teamId`) are visible
     only to a caller who **owns that experience**, ADMIN included. Same predicate as everything else.
   - **Account-level** entries (`ACCESS_DISABLED`, `ACCESS_ENABLED`, `ENTITLEMENT_REVOKED` — no
     `teamId`) have no experience to own, so they are **ADMIN-only**. That is not a hole in the
     experience scoping: disabling an account is not an experience.
   - An entry whose team cannot be resolved is **withheld** — unscopeable means invisible.
   - The ownership scope being unreadable is a **503** (`AUDIT_SCOPE_UNAVAILABLE`), never a short
     trail. A trail silently missing entries reads as "the action never happened".
   - Bounded: **one** east-west hop for the caller's scope, then one local lookup per *distinct*
     team on the page — not one per entry, which would be up to 100 from a single request.

   ⚠ **The ADMIN-only line for account-level entries is a POLICY CHOICE and should be confirmed.**
   There is no ownership to test on an entry that names no team, so something had to be decided. Two
   things make it low-risk: the alternative is the status quo that was being fixed, and this route has
   **no consumer** — nothing in the portal or desktop reads it — so a wrong policy is wrong in a
   response nobody renders yet.

4. ~~**Two internal invitation lookups had authentication but no authorization.**~~ **CLOSED.**
   `GET /v1/invitations/lookup` and `/invitations/lookup-by-email` now require `canReadDirectory`.
   Their only prior control was an absent API Gateway route — a line of CloudFormation in the
   `infrastructure` repo, so a single `/{proxy+}` mapping added there would have made both live with
   nothing in this repo failing. `lookup-by-email` was the dangerous one: keyed on email alone, it is
   an email-to-platform-role enumeration oracle, and confirming "this address is an ADMIN" is the
   reconnaissance step for the branded-phishing path below. Verified safe: **nothing calls either
   route** — `cognito-presignup` reads the invitations table directly, and the portal uses only the
   token-keyed `lookup-by-token`.

   ⚠ **This also resolves a contradiction between this file and the code.** The blanket claim above
   that "every service route is mapped behind a JWT authorizer that does no role scoping" and the
   routes' own comments ("not reachable from the internet: no gateway route maps it") cannot both be
   right. The guard makes the outcome the same either way, so the dispute no longer decides anything.
4. **An admin can still self-deal through a second address they control.** The self-invitation gate
   compares email equality, which cannot see `admin+judge@example.com` or a separate mailbox. Deliberate
   — see footnote ² — but it means the invitation audit trail is the real control, and nothing
   currently *reviews* it. A periodic "who granted judging to whom" report would close it.
5. **`GET /v1/directory/invited-by` remains role-gated** — keyed on emails the caller supplies and
   returning bare subs, so there is no experience to scope it by. Listed for completeness.
