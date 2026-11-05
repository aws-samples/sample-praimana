#!/bin/bash
#
# patch-electron-name.sh — make the DEV app appear as "Praimana" rather than
# "Electron" in the Dock, the ⌘-Tab switcher and the menu bar.
#
# ── WHY THIS EXISTS AT ALL ──
#
# In development the running application IS `node_modules/electron/dist/Electron.app`. macOS takes
# the Dock name from that bundle's Info.plist, not from anything the app does at runtime:
# `app.setName()` changes `app.getName()` and the userData path, and does NOT rename the Dock entry.
# A packaged build has no such problem — electron-builder names the bundle from `productName` — so
# this is a dev-only nicety.
#
# ── ⚠ THE DOCK SHOWED "Electron" AS THE APP NAME, AND THE PATCH WAS ALREADY APPLIED ──
#
# Measured at the time: both plist keys held "Praimana" and LaunchServices reported
# `"LSDisplayName"="Praimana"` for the running process. So the name was right and the
# Dock was showing a STALE one — LaunchServices caches bundle metadata, keyed on the bundle, and it
# does not re-read a plist that changed underneath a bundle it has already seen.
#
# Two changes follow from that:
#
#   1. `touch` the bundle, so its mtime moves and LaunchServices re-reads the plist. This is the
#      actual fix for the reported symptom; setting the keys alone was already happening.
#   2. STOP SILENCING FAILURES. Every PlistBuddy call ended in `2>/dev/null`, and the whole block was
#      skipped without comment when the plist was not found — so a patch that never applied looked
#      exactly like one that did. The name is cosmetic; a script that lies about what it did is not.
#
# ── ⚠ WHAT THIS DELIBERATELY DOES NOT TOUCH: CFBundleIdentifier ──
#
# It stays `com.github.Electron`, which is why ⌘-Tab may still group this with other Electron dev
# apps. Changing it would be the "proper" fix and would BREAK STORED CREDENTIALS: `safeStorage`
# encrypts the auth tokens in every profile's settings against a keychain item tied to the app's
# identity, so a new bundle id would make existing tokens undecryptable — every profile silently
# signed out, with `decryptSettingValue` returning null. Not worth a nicer switcher entry.
#
# ⚠ AND IT MUST RE-RUN AFTER EVERY INSTALL. The patch mutates `node_modules`, so `pnpm install` or an
# Electron upgrade reverts it. That is why `pnpm dev` runs this first rather than it being a one-off.

set -uo pipefail

APP_NAME="Praimana"

# ⚠ RESOLVED FROM THE SCRIPT'S OWN LOCATION, NOT FROM `$PWD`. A bare `../../node_modules`
# only resolves when the cwd happens to be the app directory — true under `pnpm dev`, and false
# for anyone running the script by path from the repo root, where it silently found nothing.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# ⚠ ONE LEVEL UP FROM scripts/: node_modules sits beside package.json at the repo root.
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# `find` because the path differs between npm and pnpm layouts. First match wins: there is only one
# Electron binary a dev run can launch, and it is the one the workspace resolves.
PLIST=$(find "$REPO_ROOT/node_modules" -path "*/electron/dist/Electron.app/Contents/Info.plist" 2>/dev/null | head -1)

if [ -z "$PLIST" ]; then
  # Not fatal: the app runs perfectly well called "Electron". But it is now SAID rather than hidden.
  echo "[patch-electron-name] Electron Info.plist not found under $REPO_ROOT/node_modules — skipping." >&2
  echo "[patch-electron-name] The dev app will appear as \"Electron\" in the Dock." >&2
  exit 0
fi

for key in CFBundleName CFBundleDisplayName; do
  if ! /usr/libexec/PlistBuddy -c "Set :$key '$APP_NAME'" "$PLIST"; then
    echo "[patch-electron-name] could not set $key in $PLIST" >&2
  fi
done

# ⚠ THE PART THAT MAKES A CHANGED NAME VISIBLE. Without it, LaunchServices keeps serving the name it
# cached the first time it saw this bundle, and the Dock keeps saying "Electron" however many times
# the keys are rewritten.
BUNDLE="${PLIST%/Contents/Info.plist}"
touch "$BUNDLE"

# Verified rather than assumed — the whole point of the rewrite above.
ACTUAL=$(/usr/libexec/PlistBuddy -c "Print :CFBundleDisplayName" "$PLIST" 2>/dev/null)
if [ "$ACTUAL" = "$APP_NAME" ]; then
  echo "[patch-electron-name] dev app name set to \"$APP_NAME\"."
else
  echo "[patch-electron-name] WARNING: expected \"$APP_NAME\" but the bundle reports \"$ACTUAL\"." >&2
fi
