# praimana-desktop

The desktop app (Electron + React). It is **self-contained**: it installs, type-checks, tests and builds with no
other folder of this repository present.

```bash
pnpm install                     # needs this folder's .npmrc and pnpm-workspace.yaml — see below
bash scripts/rebuild-native.sh   # verifies better-sqlite3 loads under Node AND Electron

pnpm dev                         # run it from source: patches the dev Dock name, then vite
pnpm run build                   # renderer + main + preload
pnpm test                        # the full suite (a few are win32-only and skip off Windows)
pnpm run lint                    # 0 errors (warnings only, mostly pre-existing `any`)
pnpm run type-check
pnpm package                     # electron-builder → release/
```

`pnpm dev` is `patch-electron-name.sh && vite`; the patch step is what makes the dev build show "Praimana" in
the Dock instead of "Electron".

`./start.sh` is the end-user launcher for the source zip on macOS/Linux, not a dev wrapper: from its own folder
it checks for Node ≥ 22 and pnpm (falling back to `npx pnpm`), installs dependencies and builds on first run,
then launches the built app with `electron .`. If a `connect.json` from the portal sits beside it, the app opens
on the connect-confirmation screen pre-filled with that config. See the header of `start.sh` for the format.

Verified in isolation at extraction time (historical): **lint 0 errors, type-check 0 errors, 1790 tests
passing, and `pnpm run build` producing all three bundles** — with no other folder present. The suite has
grown since; the current run is 162 test files passed (3 skipped), 3,321 tests passed, 15 skipped.

## Prerequisites

Every version below is **derived from what this folder actually declares**, not a guess — the source is named
so you can re-check it after a dependency bump rather than trusting this list.

### Both platforms

| Need | Version | Why this number |
|---|---|---|
| **Node.js** | **≥ 22.12.0** | `electron@43.5.0` declares `engines.node: ">= 22.12.0"`, which is the binding floor. `better-sqlite3@13` wants `>=22` and `vitest@4` wants `^20 \|\| ^22 \|\| >=24`. Developed on Node 24. |
| **pnpm** | **≥ 10** | Not a preference. The lockfile is `pnpm-lock.yaml`, and `.npmrc` sets `node-linker=hoisted` — a pnpm-only setting that electron-builder's packaging needs (it does not follow symlinks). npm and yarn ignore it and produce a tree `pnpm package` cannot package. |
| **git** | any recent | Needed **twice**: to clone, and **at runtime** — the app's Git panel runs the real `git` binary through `simple-git`, so without it those handlers fail on a machine that otherwise works. |
| **Disk** | ~1.3 GB | `node_modules` is ~960 MB (811 resolved dependencies) and Electron's cached binary is another ~320 MB. |
| **Network** | npmjs.org + GitHub | `.npmrc` pins `registry=https://registry.npmjs.org/` deliberately (see its own comment — an internal registry mirror in a global `~/.npmrc` makes `pnpm install` fail with `ERR_PNPM_FETCH_401` on the first public package). Electron's binary is fetched from GitHub releases on first run of its `bin`. |

⚠ **You do NOT need a C++ toolchain.** No Xcode Command Line Tools, no Visual Studio Build Tools, no Python.
`better-sqlite3` is the only native module and it ships prebuildify binaries for every platform this app
targets — `darwin-arm64`, `darwin-x64`, `win32-x64`, `win32-arm64`, plus glibc and musl Linux. Nothing compiles
from source. This is worth stating because the opposite assumption is the usual one, and acting on it
(`electron-rebuild`, `node-gyp`) fails on this toolchain for the reasons under **Native modules** below.

### macOS

| Need | Version | Why |
|---|---|---|
| **macOS** | **12 Monterey or later** | `build.mac.minimumSystemVersion: "12.0"` in `package.json`. Both architectures work — Apple Silicon and Intel each have a prebuilt binary. |
| **Keychain** | built in | Credentials are stored via `safeStorage`, and sign-in now **refuses** rather than writing a token in cleartext when the keychain is unavailable (`src/main/database.ts`). Always present on macOS; listed because the refusal is otherwise mystifying. |
| Apple credentials | only if you sign/notarise | This sample ships **unsigned** and declares no signing hooks. To produce a signed, notarised build with **your own Apple Developer ID**, see **[Code signing](#code-signing-optional)** below. |

### Windows

| Need | Version | Why |
|---|---|---|
| **Windows** | **10 or later (64-bit)** | The supported-Windows floor is Electron's own: current Electron supports Windows 10 and later. The framework installer no longer bundles download/extract tools — it spawns your AI assistant CLI to perform setup — so it adds no requirement of its own. |
| **Git for Windows** | any recent | Provides `git` itself **and Git Bash**, which `pnpm dev` needs — the dev script is `bash scripts/patch-electron-name.sh && vite`. `pnpm run build`, `pnpm test`, `pnpm run lint` and `pnpm run type-check` need no shell, so CI is unaffected. |
| **DPAPI** | built in | The Windows counterpart of the keychain note above. |

⚠ **Your AI CLI is probably a `.cmd` shim on Windows.** `claude` and `codex` installed through npm are batch
files, not executables, and CreateProcess cannot run a batch file — so the app resolves commands through `PATH`
and `PATHEXT` itself and uses an interpreter only where one is required (`src/main/windows-launch.ts`). Nothing to
configure; it is here because it explains why a Windows-specific launch path exists at all.

The window uses the **default OS frame** off macOS. `titleBarStyle: "hiddenInset"` is a macOS style, and on
Windows Electron treats it as `hidden` — which removes the minimise/maximise/close buttons, and this app draws
no replacements.

## Code signing (optional)

This repository ships **unsigned builds by design** — it carries no signing identity and declares no
signing hooks. An unsigned build runs, but the operating system warns (or blocks) on first launch:

- **macOS** — Gatekeeper refuses the download outright: *"can't be opened because Apple cannot check it for
  malicious software."* Users must right-click → **Open**, or run
  `xattr -dr com.apple.quarantine /Applications/Praimana.app`.
- **Windows** — SmartScreen shows *"Windows protected your PC"*; the user chooses **More info → Run anyway**.
  A warning, not a block.

To distribute without that friction, **sign and notarise with your own certificates** using
electron-builder's built-in support. No change to the build structure is required — the two buildspecs
(`buildspec-mac.yml`, `buildspec-win.yml`) note exactly where each piece plugs in.

**macOS — Developer ID + notarisation**

1. Provide a *Developer ID Application* certificate to electron-builder via `CSC_LINK` (a base64-encoded
   `.p12` or a path to one) and `CSC_KEY_PASSWORD`. electron-builder then signs the `.app` and `.dmg` with
   `codesign`.
2. Re-enable notarisation: set `build.mac.notarize` back to a truthy value in `package.json` (it is `false`
   in this sample) and supply Apple credentials — either an App Store Connect API key
   (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) or an Apple ID
   (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`).
3. Remove `CSC_IDENTITY_AUTO_DISCOVERY=false` from `buildspec-mac.yml` so electron-builder uses the identity
   you supplied.

**Windows — Authenticode**

Provide your Authenticode certificate through electron-builder's `win.signtoolOptions` configuration — for
example `certificateFile` + `certificatePassword`, or `certificateSubjectName` for a certificate already in
the Windows certificate store. An NSIS target produces several signable PE files (the app `.exe`, the
installer and the uninstaller); electron-builder signs all of them in one pass.
`package.json` already pins `win.signtoolOptions.signingHashAlgorithms` to `["sha256"]` so a signed build
makes one `signtool` pass per file.

See the electron-builder **Code Signing** and **Notarization** documentation for the current option and
environment-variable names.

### To USE the app (either platform)

Building it is not enough to get a working chat:

- **One of the AI CLIs, installed and signed in** — `claude`, `kiro-cli`, or `codex`. The app spawns whichever
  one the assistant picker selects; it does not bundle them. `kiro-cli` is also looked for at
  `~/.toolbox/bin`, `~/.local/bin` and `/usr/local/bin` (plus `%LOCALAPPDATA%` on Windows) before falling back
  to `PATH`.
- **A connect link from the portal** — the `praimana://` link its "Open desktop app" button produces. Nothing is
  hardcoded: the API origin and the Cognito pool both come from that link, and the app shows them for
  confirmation before it trusts them.
- **git**, for the Git panel, as above.

## Shared code lives in `shared/` — it is a copy, not a dependency

`shared/` holds 9 modules vendored as a copy rather than consumed as a package: duplicating them is
what makes this folder build on its own, with nothing to publish, version or install first. Peer copies
live in `../portal/shared` and `../services/shared`; there is no canonical upstream, and each copy carries
only the modules its own consumer needs.

| Module | What it decides |
|---|---|
| `constants/phase-progress.ts` | The first-phase word gate: `MIN_FIRST_PHASE_WORDS`, `countWords`, `isPhaseNotesUnlocked` |
| `constants/support.ts` | Bug reports and feedback: labels, kinds, subject/description word and character bounds |
| `constants/phase-links.ts` | Demo links on a phase: `encodeLinks`, `decodeLinks`, `isSafeHttpUrl` |
| `constants/desktop-link.ts` | The desktop download/connect link shape |
| `constants/message-time.ts` | `parseStoredInstant`, `formatClock`, `formatMessageInstant`, `messageDayLabel` |
| `constants/auth-flow.ts` | The sign-in flow's shared vocabulary |
| `constants/chat-limits.ts` | Composer limits |
| `constants/cognito-pool.ts` | Pool-id parsing, and the issuer/JWKS URLs derived from it |
| `types/user.ts` | Platform roles and the predicates over them (`canSignInToDesktopApp`) |

### The set was derived and then proven, not hand-picked

Mapping every `@praimana/shared` import in `src/` to the module that defines it gave 8 modules.
`pnpm type-check` then found a 9th: `src/renderer/lib/instants.ts` uses `export { … } from
"@praimana/shared"`, and a scan for `import` statements does not see a **re-export**. The type checker is
the only authority on this question, and it now passes — which is what makes the set provably closed.

It is deliberately **larger than the three-way intersection**. Only `phase-progress`, `support` and
`types/user` are used by all of desktop, portal and services; that is the right set for a package everyone
depends on, and the wrong one for a copy. Vendoring is per-consumer by definition, so the portal's and the
services' copies are each a different shape.

### ⚠ The risk being accepted

Three of these modules exist *precisely because* they must not be duplicated, and each has already caused a
real bug in this codebase when it was:

- the identity service kept its own `MAX_FEEDBACK_MESSAGE = 8_000`, while the test asserting drift was
  impossible covered only three of the four readers;
- the portal carried an inline `role === "EXECUTIVE" || role === "PARTICIPANT"` beside
  `canSignInToDesktopApp` — how a UI comes to offer something the service then refuses;
- `countWords` is shared so a live counter and a gate cannot disagree.

**These rules are not enforced here.** The backend re-checks every one of them against the request and its
refusal is the one that counts; this copy only decides what a person is told *before* asking. That is
deliberate, and it is what makes a stale copy survivable — the worst case is a wrong hint, never a wrong
outcome.

### Keeping the copies honest

The drift check is not wired in here, and no CI is included in this sample. The copies are peers
(`desktop/shared`, `portal/shared`, `services/shared`), so the check is a comparison of each module this
folder shares with a peer. From the repository root:

```bash
# Compare every vendored module here with the same file in each peer copy that also carries it.
for f in $(cd desktop/shared && find . -name '*.ts' ! -name index.ts); do
  for peer in portal services; do
    [ -f "$peer/shared/$f" ] || continue
    cmp -s "desktop/shared/$f" "$peer/shared/$f" || echo "DRIFT: $f (vs $peer)"
  done
done
```

Expected differences:

- `shared/index.ts` — each copy re-exports only the modules it carries, so it is excluded above.
- Test files whose fixtures were sanitised for this sample (for example the Cognito pool id replaced with
  `us-east-1_EXAMPLE01`, see *Sanitised for extraction*) may differ for that reason alone.

Anything else is real drift; the loop currently reports none. The services side has its own gate, `pnpm check:shared`; see
[Keeping the copies honest](../services/README.md#keeping-the-copies-honest) in the services README.
**This belongs in a CI job**, with the expected files allowed — a check that cries wolf on known files is one
people stop reading.

`vitest`'s `include` covers `shared/**` as well as `src/**`, so the vendored test files run with the rest of
the suite. (At extraction time it covered only `src/**`, so they were collected by nothing; widening it is
what took the count from 1670 to 1790.)

### Imports were not rewritten

The specifier `@praimana/shared` still resolves — aliased to `shared/index.ts`, so the 16 files that
import it needed no edits when the code was vendored. The alias is declared in **four**
places:

- `tsconfig.json` and `tsconfig.main.json` → `compilerOptions.paths`
- `vite.config.ts` → `resolve.alias`, and **repeated inside each `electron()` entry**

⚠ That repetition is not redundant. `vite-plugin-electron` builds main and preload with their own nested vite
config, which does **not** inherit the top-level `resolve`. Set only at the top level, the renderer resolved
fine and the main build failed with *"Rollup failed to resolve import @praimana/shared from
src/main/deep-link.ts"*.

## Two config files that are easy to lose, and both break the build

Both are easy to overlook when copying the app directory, and each breaks the build if missing:

- **`.npmrc`** — pins `registry=https://registry.npmjs.org/`. Without it pnpm uses whatever the machine's
  global `~/.npmrc` names; on a workstation configured for an internal mirror, `pnpm install` fails with
  `ERR_PNPM_FETCH_401` on the first public package. It also sets `node-linker=hoisted`, which
  electron-builder needs (real directories, not symlinks into the store).
- **`pnpm-workspace.yaml`** — holds this folder's pnpm settings: `onlyBuiltDependencies`, the security
  `overrides` and `auditConfig`. Keep them here, not in a `"pnpm"` field in `package.json`: pnpm 11 ignores
  that field entirely, and pnpm 10 reads `onlyBuiltDependencies` from this file and nowhere else (in
  `package.json` it logs "will not take effect" and silently skips install scripts, so
  **electron never downloads its binary and better-sqlite3 never builds** — on an install that reported no
  error at all).

## Dependency audit exception

`pnpm-workspace.yaml` → `auditConfig.ignoreGhsas` lists one advisory, deliberately:

- **`GHSA-ch52-4w7c-c8xp`** (`http-cache-semantics` ≤ 4.2.0, no patched release). It arrives only
  through `electron-builder` → `@electron/get` → `got`, which downloads Electron binaries **at build
  time**. It is not part of the packaged app, and the advisory needs a cache shared between users,
  which a single developer's build cache is not. Remove the entry once a patched release exists.

## Native modules

Run `bash scripts/rebuild-native.sh` after every install. **It no longer rebuilds anything** — it verifies, and
the name is kept only so the habit still works.

better-sqlite3 13 (installed with the Electron 43 upgrade) is a **Node-API** addon published via prebuildify:
`node_modules/better-sqlite3/prebuilds/<platform>-<arch>.node`, with no ABI number in the name because Node-API
is ABI-stable across runtimes. One binary serves system Node and every Electron version, so the old per-ABI
`prebuild-install` fetch is gone — and `prebuild-install` is no longer a better-sqlite3 dependency, so the old
invocation now fails with `MODULE_NOT_FOUND`.

The script proves the same file loads and queries under **both** runtimes (NODE_MODULE_VERSION 137 under Node 24,
148 under Electron 43). Keep running it: if a future bump reverts to a per-ABI addon, this is the only thing that
catches it — the Vitest suite mocks better-sqlite3 and so passes under either ABI.

better-sqlite3 is the only native module left — `node-pty` went with the embedded terminal. Do not substitute
`electron-rebuild`: it compiles from source via node-gyp, which needs Python `distutils` — removed in Python 3.12.
That failure is not hypothetical: `pnpm add better-sqlite3@11` still triggers it on this toolchain.

⚠ **Electron 42 changed when the binary arrives.** The `electron` package no longer downloads it in `postinstall`,
only on first run of its `bin` — so the first `rebuild-native`, `dev` or `package` after a fresh install pauses to
download Electron. `ELECTRON_SKIP_BINARY_DOWNLOAD` is no longer supported; use `ELECTRON_INSTALL_ARCH` /
`ELECTRON_INSTALL_PLATFORM` if you need to preseed a different platform in CI.

## Shipping a new version — two names you must not change

There is no auto-updater. A new version is a build somebody downloads and drops in place of the installed
app. That is safe because **no user data lives in the app bundle**: every profile's database sits under
`userData` (`profiles/<id>/praimana.db`, plus the profile pointer at the root), and `initDatabase()`
migrates whatever it finds forward on first open. Verified against a real pre-migration database — schema
version 0, written by a much earlier build — which reached the current version with every row intact.

⚠ **Two identifiers are load-bearing for that guarantee, and changing either loses data silently.**

- **`productName`** (`package.json`) NAMES the `userData` directory. Rename the app and it points at a
  directory that does not exist yet: Electron creates an empty one, and the previous data is stranded
  beside it under the old name. There is no error and no prompt — the app opens, works, and looks as
  though it deleted everything. If a rename is ever genuinely wanted, it needs a step that **moves** the
  old directory, not just a string edit.
- **`build.appId`** keys `safeStorage`. A new id leaves the database perfectly readable but every stored
  credential in it undecryptable, so every profile is silently signed out. This is the same reason
  `scripts/patch-electron-name.sh` refuses to touch `CFBundleIdentifier`.

⚠ **Replacement is forward-only.** Migrations never run backwards. An older build opening a newer database
keeps the newer schema without complaint — the added columns are harmless — but the unique index from
migration 9 remains and rejects the plain project `INSERT` older code performed
(`UNIQUE constraint failed: index 'idx_projects_path_user'`). Handing someone a previous build is not the
inverse of handing them a new one; treat a rollback as a migration problem, not a file swap.

## Sanitised for extraction

Values identifying the original deployment were replaced with placeholders. None was a credential; the point is
that a repo carrying deployment identifiers is harder to share.

| Was | Now |
|---|---|
| A real AWS account id, federated role and user alias in a `claude-code.test.ts` 403 fixture | `111122223333`, `ExampleFederatedRole`, `example-user` |
| The live Cognito user-pool id (test files, incl. two under `shared/`) | `us-east-1_EXAMPLE01` |
| The live portal hostname | `portal.example.com` |

The account-id fixture is load-bearing rather than decoration: the test asserts those tokens are **scrubbed**
from what a participant sees, so the fixture must contain them. All four asserted tokens still appear in the
redacted string, so the test still proves redaction.

**No deployment-specific build-time value is left in place.** Earlier builds injected an access-key secret
(with a dev-only fallback) and two other values through `define` in `vite.config.ts`; they had no consumers
and were removed — see the header of `vite.config.ts`. The API origin and Cognito pool come from the
portal's connect link at runtime, not from the build.

## Important Notes

- **This is sample code, not a production service.** This component demonstrates how to build an
  AI-assisted workshop client on AWS. It is provided as a starting point for your own
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

This library is licensed under the MIT-0 License. See the `LICENSE.md` file in the repository root.
