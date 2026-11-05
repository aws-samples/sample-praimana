#!/bin/bash
# Verify better-sqlite3 loads under BOTH runtimes: system Node (tests, scripts) and Electron (the app).
#
# ── ⚠ THIS NO LONGER REBUILDS ANYTHING, AND THAT IS THE POINT ──
#
# It used to. better-sqlite3 11.x shipped per-ABI binaries via `prebuild-install`, so the module
# compiled for whatever Node ran `pnpm install` and then died on first DB access under Electron:
#
#   The module '...better_sqlite3.node' was compiled against a different Node.js
#   version using NODE_MODULE_VERSION 137. This version of Node.js requires
#   NODE_MODULE_VERSION 133.
#
# better-sqlite3 13 (installed alongside the Electron 35 -> 43 upgrade) is a **Node-API** addon
# published with prebuildify: `node_modules/better-sqlite3/prebuilds/<platform>-<arch>.node`, with
# no ABI number in the name because Node-API is ABI-STABLE ACROSS RUNTIMES. One binary serves
# system Node and every Electron version, so there is nothing left to fetch or rebuild.
#
# Verified rather than believed, which is why this script still exists: the same file loads under
# NODE_MODULE_VERSION 137 (Node 24) and 148 (Electron 43). If a future dependency bump silently
# reverts to a per-ABI addon, THIS is the script that catches it — the Vitest suite cannot, because
# it mocks better-sqlite3 and therefore passes under either ABI.
#
# `prebuild-install` is deliberately not reintroduced. It is no longer a better-sqlite3 dependency,
# and the old `npx --no-install prebuild-install` invocation now fails with MODULE_NOT_FOUND.
#
# ── WHEN TO RUN IT ──
#
# After any `pnpm install` that touches node_modules, and after upgrading Electron or
# better-sqlite3. It only reads, so it is safe to re-run.
#
# ⚠ Electron 42 changed when the binary arrives: the `electron` package no longer downloads it in
# `postinstall`, only on first run of its `bin`. So the first invocation below may pause to download
# Electron itself. That is expected, not a failure — but in CI it means the download happens on
# first use rather than at install time.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
MODULE_DIR="$ROOT/node_modules/better-sqlite3"

# ⚠ NODE ON WINDOWS CANNOT RESOLVE THE PATHS THIS SCRIPT RUNS WITH. Under Git-bash/MSYS the
# shell reports `/c/codebuild/.../src`, which bash resolves happily - so the `[ -d ]` check
# below passes - but `node` is a NATIVE Windows binary and require() on `/c/...` fails with
#
#     Error: Cannot find module '/c/codebuild/.../node_modules/better-sqlite3/package.json'
#
# which reads as "the module is missing" when it is present and correct. That broke the
# Windows installer build. cygpath -m produces `C:/codebuild/...`, which Node accepts on
# every platform; where cygpath does not exist (macOS, Linux) the path is already usable.
to_node_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi
}
ROOT_NODE="$(to_node_path "$ROOT")"
MODULE_DIR_NODE="$(to_node_path "$MODULE_DIR")"

if [ ! -d "$MODULE_DIR" ]; then
  echo "better-sqlite3 not found at $MODULE_DIR — run pnpm install first." >&2
  exit 1
fi

BSQ3_VERSION="$(node -p "require('$MODULE_DIR_NODE/package.json').version")"
ELECTRON_VERSION="$(node -p "require('$ROOT_NODE/node_modules/electron/package.json').version")"
ARCH="$(node -p "process.arch")"
echo "better-sqlite3 $BSQ3_VERSION | Electron $ELECTRON_VERSION | $ARCH"

# A Node-API addon ships prebuilds/ and no build/Release output. If that inverts, the dependency
# has gone back to per-ABI binaries and the load check below is the only thing standing between
# that change and a crash on first DB access in the packaged app.
if [ ! -d "$MODULE_DIR/prebuilds" ]; then
  echo "⚠ No prebuilds/ directory — better-sqlite3 may no longer be a Node-API addon." >&2
  echo "  If the Electron check below fails, this module needs per-ABI rebuilding again and this" >&2
  echo "  script needs its old prebuild-install logic back (see git history)." >&2
fi

# Prove it LOADS AND QUERIES under each runtime rather than assuming the file is the right one.
# A require() that succeeds but a query that fails is the failure mode worth catching.
# ⚠ `mktemp`, NOT A FIXED PATH. This wrote and then EXECUTED /tmp/.bsq3-abi-check.js twice — a
# predictable name in a sticky, world-writable directory. A pre-created symlink there makes the
# redirect clobber the target, and winning the race between write and exec gives arbitrary code
# execution in the developer's Electron runtime. CWE-377 / CWE-59. Dev-only, but it is new code.
CHECK_JS="$(mktemp -t bsq3-abi-check.XXXXXX)"
mv "$CHECK_JS" "$CHECK_JS.js"
CHECK_JS="$CHECK_JS.js"
trap 'rm -f "$CHECK_JS"' EXIT

cat > "$CHECK_JS" <<'CHECK'
const Database = require(process.env.MODULE_DIR);
const db = new Database(":memory:");
db.exec("CREATE TABLE t(x)");
db.prepare("INSERT INTO t VALUES (?)").run(1);
if (db.prepare("SELECT x FROM t").get().x !== 1) throw new Error("query returned the wrong value");
const runtime = process.versions.electron ? `Electron ${process.versions.electron}` : `node ${process.version}`;
console.log(`  verified under ${runtime} (NODE_MODULE_VERSION ${process.versions.modules})`);
CHECK

# MODULE_DIR_NODE, not MODULE_DIR: the check script require()s it from inside node.
MODULE_DIR="$MODULE_DIR_NODE" node "$(to_node_path "$CHECK_JS")"
MODULE_DIR="$MODULE_DIR_NODE" ELECTRON_RUN_AS_NODE=1 "$ROOT/node_modules/.bin/electron" "$(to_node_path "$CHECK_JS")"
# Removed by the EXIT trap above, on every path including a failure.

echo "better-sqlite3 is loadable from both runtimes — no rebuild needed."

# ── ⚠ THE node-pty HALF OF THIS SCRIPT IS GONE, WITH THE EMBEDDED TERMINAL ────────────
#
# It chmod'd node-pty's prebuilt `spawn-helper`, which ships mode 644 so every spawn failed
# with `Error: posix_spawnp failed.` — and then proved a real spawn worked, because a chmod
# that silently matched nothing looks identical to a fix.
#
# ⚠ WORTH RECORDING WHY THAT BUG SURVIVED SO LONG: the terminal was never mounted in the UI,
# so the only thing that ever exercised node-pty was this script. `TerminalView.tsx`,
# `handlers/pty.ts` and the `pty:*` bridges have all been removed, and `node-pty` is no
# longer a dependency — so there is nothing left here to fix or verify.
#
# better-sqlite3 remains the ONLY native module in the tree.
