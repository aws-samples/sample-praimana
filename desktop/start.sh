#!/usr/bin/env bash
#
# start.sh — run the Praimana desktop app from source on macOS or Linux.
#
# WHAT THIS DOES
#   1. Checks you have Node and a package manager.
#   2. Installs dependencies the first time (into node_modules/ beside this script).
#   3. Builds the app if it has not been built yet.
#   4. Launches the app. If a connect.json sits next to this script, the app opens on the
#      "connect to this experience" confirmation screen, pre-filled with that config; you
#      still click Connect and then sign in. Without connect.json the app opens normally and
#      you can connect from inside it ("Sign in to another experience").
#
# HOW TO USE
#   1. Download and extract the desktop source zip.
#   2. Download connect.json (from the portal) and place it in THIS folder, next to start.sh.
#   3. Open a terminal, cd into this folder, and run:  ./start.sh
#      (first run installs dependencies, so it takes a few minutes)
#
# connect.json format (all four values come from your portal — none is secret):
#   {
#     "portalUrl":  "https://<your-portal-host>",
#     "apiBaseUrl": "https://<your-api-host>",
#     "poolId":     "<cognito-user-pool-id>",
#     "clientId":   "<cognito-app-client-id>"
#   }

set -euo pipefail

# Always operate from the folder this script lives in, whatever the caller's cwd.
cd "$(dirname "$0")"

say()  { printf '\n\033[1m[Praimana]\033[0m %s\n' "$*"; }
err()  { printf '\n\033[1;31m[Praimana] %s\033[0m\n' "$*" >&2; }

# ── 1. Prerequisites ──────────────────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  err "Node.js is not installed. Install Node 22 or newer from https://nodejs.org and re-run."
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
  err "Node $(node -v) found, but Node 22 or newer is required. Please upgrade and re-run."
  exit 1
fi

# Prefer pnpm; fall back to running it through npx so a user need not install it globally.
if command -v pnpm >/dev/null 2>&1; then
  PNPM="pnpm"
else
  if ! command -v npx >/dev/null 2>&1; then
    err "Neither pnpm nor npx is available. Install Node 22+ (which bundles npx) and re-run."
    exit 1
  fi
  say "pnpm not found; using 'npx pnpm' instead."
  PNPM="npx --yes pnpm@10.30.3"
fi

# ── 1b. Pin the PUBLIC npm registry, overriding the user's global config ────────────────────────
#
# ⚠ WHY THIS IS NEEDED AND WHERE IT BITES. This package pins `packageManager: pnpm@<ver>`, so if the
# user's pnpm is a different version, pnpm DOWNLOADS THE PINNED VERSION to run it — and that
# self-download reads the user's GLOBAL ~/.npmrc, NOT this folder's .npmrc. On a machine whose global
# config points at a private registry (e.g. a mirror with an expired token), that
# bootstrap fetch fails with "GET .../pnpm: Unauthorized - 401" before a single dependency
# is touched. The project .npmrc only governs dependency installs, which pnpm never reaches.
#
# So we write a throwaway npmrc that pins the public registry and point pnpm's USERCONFIG at it. That
# is the layer the self-download consults, and it also carries into the dependency install. A customer
# with any global npm config — private mirror, stale token, or none — now installs from npmjs.org.
# `/dev/null` (what this script used before) is NOT enough: it blanks the registry rather than setting
# the public one, so the self-download still has nowhere valid to go.
PRAIMANA_NPMRC="$(mktemp -t praimana-npmrc.XXXXXX)"
trap 'rm -f "$PRAIMANA_NPMRC"' EXIT
{
  echo "registry=https://registry.npmjs.org/"
  echo "node-linker=hoisted"
} > "$PRAIMANA_NPMRC"
export npm_config_userconfig="$PRAIMANA_NPMRC"
# Belt and braces for pnpm's version self-manager, which has read the registry from several places
# across versions; setting both the npm and corepack hints covers them.
export COREPACK_NPM_REGISTRY="https://registry.npmjs.org/"

# ── 2. Install dependencies (first run only) ────────────────────────────────────────────────
if [ ! -d node_modules ] || [ ! -x node_modules/.bin/electron ]; then
  say "Installing dependencies (first run — this can take a few minutes)…"
  $PNPM install --frozen-lockfile
else
  say "Dependencies already installed; skipping. (Delete node_modules to force a reinstall.)"
fi

# ── 3. Build if needed ───────────────────────────────────────────────────────────────────────
if [ ! -f dist/main/index.js ]; then
  say "Building the app…"
  $PNPM run build
else
  say "Build is present; skipping. (Delete the dist folder to force a rebuild.)"
fi

# ── 4. Assemble the connect link from connect.json, if present ───────────────────────────────
# The link is config only (no credential). The app shows it for confirmation before applying it.
CONNECT_ARG=""
if [ -f connect.json ]; then
  say "Found connect.json — the app will offer to connect to that experience."
  # Build the praimana://connect?... URL with Node, which is already required above. This
  # validates the JSON and URL-encodes each value; a malformed file stops with a clear message.
  CONNECT_ARG="$(node -e '
    const fs = require("fs");
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync("connect.json", "utf8")); }
    catch (e) { console.error("connect.json is not valid JSON: " + e.message); process.exit(3); }
    const need = ["portalUrl", "apiBaseUrl", "poolId", "clientId"];
    const missing = need.filter((k) => !cfg[k] || String(cfg[k]).trim() === "");
    if (missing.length) { console.error("connect.json is missing: " + missing.join(", ")); process.exit(3); }
    const q = new URLSearchParams({
      p: String(cfg.portalUrl).trim(),
      a: String(cfg.apiBaseUrl).trim(),
      pool: String(cfg.poolId).trim(),
      c: String(cfg.clientId).trim(),
    });
    process.stdout.write("praimana://connect?" + q.toString());
  ')" || { err "Could not read connect.json. Fix it (see the format in start.sh) and re-run."; exit 1; }
else
  say "No connect.json in this folder — the app will open normally; connect from inside it."
fi

# ── 5. Launch ─────────────────────────────────────────────────────────────────────────────────
# `electron .` runs this package's main entry (dist/main/index.js). The connect link, when
# present, is passed as the first argument, which the app reads on cold start exactly as it
# would an OS deep link — then shows the confirmation screen.
say "Starting Praimana…"
if [ -n "$CONNECT_ARG" ]; then
  exec node_modules/.bin/electron . "$CONNECT_ARG"
else
  exec node_modules/.bin/electron .
fi
