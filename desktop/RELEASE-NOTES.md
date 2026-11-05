# Praimana — Desktop Client

**Release notes · v1.0.0**

The workshop client participants run on their own machine: an in-app AI coding assistant, team
collaboration surfaces, a file explorer and editor, source control, and a phase-driven experience
workflow.

Electron 43 · React 19 · Vite 6 · SQLite (better-sqlite3)
macOS (dmg + zip, signed and notarized) · Windows (NSIS) · Linux (AppImage)

> This document is an inventory of what the app does. Each section describes current behaviour.

---

## Contents

- [Getting connected](#getting-connected)
- [Signing in](#signing-in)
- [Profiles — several desktops at once](#profiles--several-desktops-at-once)
- [The AI coding assistant](#the-ai-coding-assistant)
- [Token and context analytics](#token-and-context-analytics)
- [Keeping the team transcript complete](#keeping-the-team-transcript-complete)
- [Team collaboration](#team-collaboration)
- [Team documents](#team-documents)
- [Files, editor and search](#files-editor-and-search)
- [Source control](#source-control)
- [Workspace layout](#workspace-layout)
- [Project setup — the development framework](#project-setup--the-development-framework)
- [Settings and Account](#settings-and-account)
- [Updates, diagnostics and security](#updates-diagnostics-and-security)
- [Requirements and verification](#requirements-and-verification)

---

## Getting connected

The participant configures nothing by hand.

- **One-click connect from the portal.** The website's "Open desktop app" button sends an `praimana://`
  deep link carrying a one-time code plus the portal and API URLs. The app redeems the code for a session
  and resolves the Cognito pool from it. Cold start (the link launched the app) and warm start (the app
  was already running) are both handled.
- **A link is always confirmed before it is applied.** The app shows where it is about to connect and
  waits. No web page can silently repoint the app at another API.
- **Drift is detected at startup.** If the platform configuration changed while the app was closed, the
  session is ended and the user is told the *platform* moved — not that their session expired, which
  would send them to retry the wrong thing.
- **"Sign in to another experience"** disconnects the app so it can be pointed at a different
  experience. It is confirmed, and the confirmation names what is lost (the saved accounts for that
  platform).
- **First run walks four gates in order:** connect a platform → sign in → join a team → choose an
  assistant and project folder. Each remembers, so a returning participant sees none of them.

## Signing in

- **Native in-app sign-in** — email and password, then a six-digit code. No browser hand-off.
- **Multi-factor authentication:** authenticator app (TOTP), email code, and SMS code. When more than one
  factor is enrolled, the app asks which to use — listing only the factors the identity provider actually
  offered, so no option on that screen is a dead end.
- **Steps the desktop defers** — a forced password change, an unconfirmed email, a required password
  reset — explain themselves and link out to the website, instead of presenting a form that cannot
  complete.
- **Readable failures.** Wrong password, expired code, wrong code, too many attempts, and password-policy
  rejections each get their own plain-English message.
- **Forgot your password** links to the website, which owns the reset.
- **Session renewal is automatic.** The session is refreshed in the background; a request that arrives
  just as the token expires is retried once transparently. Only a refresh that genuinely fails returns
  the user to sign-in, with an explanation.
- **Access is role-gated.** Participants and executives may use the desktop app. Roles come from the
  signed token, never from the client.
- **Credentials are held for as short a time as possible.** The password is discarded the moment it is
  used; the session token is handed to the app's privileged process immediately and the window's copy
  cleared. Nothing is remembered between launches — entry is always the sign-in form.

## Profiles — several desktops at once

For one machine running more than one participant, team, or experience.

- **Each profile is a fully separate desktop:** its own database, settings, signed-in user, team, and
  chat history.
- **A chooser on launch** — pick a profile, or create one. The last profile used is remembered, and only
  after it has launched successfully, so a broken profile can never trap you in a loop.
- **File → New Window with Profile** opens another profile *alongside* the current one, running
  concurrently. **File → New Profile…** creates one.
- **A new profile inherits the experience** of the window that created it — same platform, same pool — so
  it lands on the sign-in form rather than asking a question this machine has already answered. It never
  inherits the session: every profile requires its own explicit sign-in.
- **The profile's name sits beside the macOS window controls**, so two side-by-side windows are
  distinguishable at a glance. The default install shows nothing extra.
- **A profile remembers whose it is.** The first sign-in records that account in the profile's own
  `profile.json`, and the chooser shows it under the team — so two profiles of the same deployment, which
  otherwise differ only by team, are told apart at a glance. Signing in as a *different* account is
  refused with a pointer to switch or create a profile; the field is filled and locked when the profile
  has exactly one account, and stays editable when it already has several, so nobody is locked out of
  work already in there. Repointing a profile at another platform releases the binding, because one
  person legitimately uses different addresses for different experiences.
- **Connecting from the portal asks which profile it is for.** The experience is confirmed first — the
  same pool/API screen as before — and *then* the chooser appears, because only at that point is there
  something to place. A new profile created there inherits the platform just connected, so it needs only
  a sign-in. If the profile you are in already holds projects and chats, the confirmation screen says so
  before you commit.
- **Profiles separate work, not people.** They are a convenience for one person juggling several
  contexts, not a security boundary between two people sharing a computer.

## The AI coding assistant

Three assistants, each running as the participant's **own local CLI** on their own machine. The
facilitator controls which are available; if the selected one is switched off mid-workshop, the app moves
to an enabled one and says so.

| Assistant | Notes |
|---|---|
| **Claude Code** | Two paths: the spawned CLI, and the official Claude Agent SDK, which adds a real approve/deny prompt before every tool use |
| **Kiro CLI** | Structured protocol (ACP), giving richly rendered tool calls and true conversation resume |
| **Codex** | Spawned CLI with full event-stream parsing |

**In the conversation**

- **A live transcript** built as a timeline: each tool call is its own labelled row, expandable to show
  what went in and what came out, with long output truncated visibly rather than silently.
- **A working indicator** carrying elapsed time and a rising token count. Claude keeps its own rotating
  vocabulary; Kiro and Codex show a plain "Thinking…", because neither narrates its work and inventing
  narration for them would be putting words in their mouth.
- **Approve or deny tool use** from a card in the conversation.
- **Stop generating** at any point — and the question you asked is still recorded, even if you stop
  before the answer arrives.
- **Pick a model.** Each assistant's model list is *asked of that assistant*, never guessed, and is
  scoped to it — so Claude's models are never offered for a Codex turn. The real default is named rather
  than described as "the CLI default".
- **Conversations survive a restart.** Each chat remembers the assistant's own conversation id, so the
  next message continues the real thread instead of starting an empty one with your transcript still on
  screen above it.
- **Many chats at once**, each keeping its own draft, streaming state, and tool history. Switching views
  or tabs never interrupts a turn in flight.
- **Markdown, tables and code** rendered in the transcript, with a copy button on every reply.
- **Prompts up to 100,000 characters**, with a counter that appears as you approach the limit.
- **Your project is pre-trusted** for Claude Code — for the exact folder you chose in the file picker —
  so the repository's already-approved tool permissions are honoured instead of prompting you again for
  each one during a workshop.

## Token and context analytics

Recorded per message and summarised per conversation, so token use can be taught rather than guessed at.

- **Input, output, cached-input, cache-write and reasoning tokens** stored for every message that reports
  them.
- **Conversation totals in the chat header** — and nothing at all when nothing was counted, rather than a
  `0` that would look authoritative.
- **Measured cache savings**, not estimated: how much of the prompt was served from cache against how
  much was sent. Cache *writes* are recorded too, which is what distinguishes a normal first turn
  (expensive, unavoidable) from a conversation throwing its cache away every question — the second being
  the one a participant can actually fix.
- **Context fullness** for Kiro, shown once it is worth knowing and quiet below that, so it is a signal
  rather than permanent furniture.

## Keeping the team transcript complete

Every message is written locally the instant it is sent, and pushed to the team transcript separately.
The app tracks whether the second half happened.

- **Per-message state:** sent, delivered, or refused.
- **"N messages not synced"** in the chat header — shown only when something is genuinely outstanding, so
  a healthy conversation carries no warning. A message merely in flight is reported quietly; a refused
  one is reported as a problem.
- **Retry a message** with one click. It re-sends the whole exchange, which is the unit the server
  accepts, and is safe to press repeatedly.
- **Automatic catch-up at startup** for anything the previous session left unsent — including the
  commonest case, where the app was closed with a turn still pending.
- **Failures are never silent.** A background sync failure raises a notice saying the work is safe
  locally.

## Team collaboration

- **Team chat** — messages up to 4,000 characters, with timestamps that say *Today*, *Yesterday*, or the
  date, so an old conversation cannot be mistaken for a live one.
- **Board** — a five-column task board (Backlog, To Do, In Progress, Review, Done). Create and edit
  tasks with a title, description, priority (Low → Urgent) and an assignee chosen from the team.
- **Experience Phases** — the workshop's stages, each expandable to read or write the team's notes.
  - Status is shown by shape *and* words, not colour alone: a completed phase carries a tick where the
    others carry a number.
  - **Later phases open once the first is written up** — at least 50 words — with a live word counter and
    the number of words still needed stated in the row. Reading ahead is always allowed; only editing is
    gated, so it reads as an order of work rather than a punishment.
  - **The Demo phase collects links** — the live application URL and the demo recording — each labelled,
    validated, and clickable for the facilitator or judge who opens them later.
  - Notes show who wrote them and when, and whether they were AI-generated.
- **Share an AI chat with your team.** Shared conversations are labelled as such, and a **Team** tab
  alongside your own history lets you read what others shared.
- **Live updates, no refreshing.** New team messages, board changes and phase edits arrive pushed rather
  than polled, with unread badges per surface, an optional chime, and a dock badge. Your own actions never
  badge or chime you. Opening a tab clears its count.
- **A connection indicator** in the title bar — online, offline, or not yet connected — clickable to
  re-check.

## Team documents

On the Build phase, where the team's artefacts are produced.

- **Full version history** per document, with any earlier version viewable.
- **Publish from your repository** in two steps: list the candidate files — a purely local read that
  uploads nothing — then tick the ones you want. Nothing is pre-selected, because publishing puts your
  work where your team and executives can read it.
- **Or upload a file directly** — `md`, `txt`, `pdf`, `html`, up to 20 MB. A rejected file says *why*, so
  it can be fixed.
- **Remove a document**, confirmed in the row where you can still see who last changed it and when.
- Nothing leaves your machine until you ask. There is no background sync and no upload-on-commit.

## Files, editor and search

- **A file explorer** in the sidebar: folders load as you open them, expansion is remembered, and the
  whole tree is keyboard-navigable.
- **Full file management** — new file, new folder, rename, move, copy and paste, and reveal in
  Finder/Explorer.
- **Delete moves to the OS trash**, not a permanent removal, so a mis-click is recoverable from
  Finder/Explorer.
- **Several files open at once**, as tabs. Each keeps its own unsaved changes and scroll position, tabs
  mark unsaved work with a dot, and the app refuses to close a file with unsaved edits to make room for
  another.
- **An editor** with line numbers and ⌘S / Ctrl+S to save. Markdown opens as a rendered preview with an
  Edit toggle. Binary files say so instead of displaying as noise.
- **Search files by name** from the title bar. Results are bounded, and a partial list says it is partial
  rather than implying it is complete.
- **Switching project folder** re-checks the framework setup, restarts the assistant in the new folder,
  and closes any tab that pointed outside it.

## Source control

Available whenever the project folder is a git repository; a folder that is not one explains that rather
than showing an empty screen.

- **Changes** — a commit message field and Commit, Push, Pull, and Fetch, with the current branch,
  how far ahead or behind the remote you are, and the **full list of files the commit will include**
  (modified, new, deleted, staged). Commit stages everything, so the list is the manifest of what the
  button will do, not decoration.
- **History** — recent commits with author, short hash, and date *and* time.
- **Diff** — the full uncommitted diff at full width.
- The current branch is also shown next to Source Control in the sidebar, so you can see it before you
  act.
- Git operations run one at a time, and git's own error messages are shown verbatim — they are written
  for the person reading them.

## Workspace layout

- **Pin a second view beside your work.** Chat, Team Chat, Board and Phases can each be pinned to a
  second pane, so team chat can sit next to an AI conversation. The choice persists across launches.
- **Collapse the sidebar** with ⌘B / Ctrl+B. It collapses to an icon rail rather than disappearing, so
  navigation stays reachable, and the state persists.
- **A dark theme throughout**, with contrast verified by measurement rather than by eye, and no state
  communicated by colour alone.

## Project setup — the development framework

- **The facilitator chooses which development framework an experience uses**, and the app installs it for
  you. AI-DLC, Spec Kit and OpenSpec all work, as does anything a facilitator assembles themselves — it is
  a repository, a branch, and a set of files per assistant, so switching an experience from one framework
  to another is a configuration change rather than a new release of this app.
- **It is installed when you need it** — on choosing a folder, switching assistant, or switching folder —
  downloaded, unpacked into the project, then completed and verified by the assistant itself against the
  framework's own setup guide, with progress shown at each step and the framework named throughout.
- Already-configured folders are detected and left alone.
- Different assistants can receive different files, which is why switching assistant re-checks.
- A link to the experience's Getting Started guide appears on the assistant-selection screen.
- The setup agent runs with **normal** permission behaviour — it is driven by a fetched document, so it is
  never allowed to auto-approve its own actions.

## Settings and Account

**Settings** — how the app behaves:

- Which AI assistant to use.
- **Appearance — Light, Dark, or Auto.** Auto follows your computer's setting and changes with it, so the
  app turns light or dark when your machine does. Every colour in both modes is contrast-checked, and the
  choice is per profile.
- Notification sound for team activity, on by default.
- Local error logging, off by default.
- The desktop version you are running (blank rather than guessed if it cannot be read).

**Account** — who you are and where you are:

- Name, email, role (with the exact role code, for support conversations), and organisation.
- Experience name and id, team name and id, and a copyable **team code** — the one identifier you
  actually share with another person.
- The platform website and pool this app is connected to.
- **Sign out** (keeps the experience connected, so signing back in needs nothing re-entered) and **sign
  in to another experience** (disconnects, confirmed).
- Every field is read-only, and the page says so. Each is owned elsewhere — by the identity service, by
  your signed token, or by the deployed platform — so an editable field here would be an offer the app
  cannot honour.

**Report a bug / give feedback** — in the app, from the Account page:

- A subject and a description, with the length expected stated *before* you start typing, counters that
  count up toward the minimum, and a Send button that says why it is not ready yet.
- Your app version, experience and team are attached automatically.
- A clear confirmation when it has been sent, so nobody sends the same report twice.

## Updates, diagnostics and security

- **Updating is a download that replaces the app**, and it keeps your work. Nothing you create lives
  inside the application itself — your projects, chats, sign-in and settings sit in your user data folder,
  one folder per profile — so a newer build opens everything that was already there and brings the local
  database up to date on first launch.
- **Optional local error logging.** Off by default. When enabled, crashes and errors are appended to a
  self-trimming file on your own machine, which you can open and share from Settings. **Nothing is sent
  anywhere.**
- **Your session token never reaches the app window.** Every authenticated request — board, chat, phases,
  documents, feedback, account — is made by the app's privileged process. Credentials are encrypted at
  rest and are not readable by the interface at all.
- **File operations cannot escape your project.** Every create, rename, move, copy and delete is checked
  against the open project, with symlinks resolved before the decision.
- **Hardened window:** process isolation and sandboxing on, a strict content policy, in-app navigation
  blocked, and external links opened in your real browser. Every internal message channel is checked for
  origin before any of them are registered.
- **Your local database keeps itself in step with the app**, so an updated client reads the chats and
  projects already on the machine — verified against a database written by a much earlier build.

## Requirements and verification

**Requires** the participant's own AI CLI installed and authenticated — `claude`, `kiro-cli`, or `codex`
— matching whichever assistants the facilitator enabled. The app runs them locally; it does not proxy a
model of its own.

**This release was verified with:**

| Gate | Result |
|---|---|
| `pnpm run type-check` | clean |
| `pnpm test` | 1835 passed, 7 skipped (95 files) |
| `pnpm run lint` | 0 errors (77 `any` warnings) |
| `pnpm run build` | renderer, main and preload built |

Coverage includes the local database migrations, message sync state, project-path confinement,
authentication flows, theme contrast, pane layout, file-tab rules, and per-assistant model scoping.
