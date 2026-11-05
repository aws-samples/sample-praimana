#!/usr/bin/env bash
# Fails if services/shared — this tree's vendored copy of the shared TypeScript — has changed
# without the pinned hash being updated. desktop/shared, portal/shared and services/shared are
# peer copies with no upstream; every file present in more than one copy must stay
# byte-identical across them. See README.md — "Keeping the copies honest".
#
# Only *.ts files are hashed: services/ adds a package.json and tsconfig.json to make
# the folder resolvable as a workspace package, and those are deliberately NOT part of
# the shared contract.
set -euo pipefail

# ⚠ BUMPED from 1654ae661bd212e3, and the bump is the point of the script rather than
# an inconvenience: `constants/chat-limits.ts` was added to the vendored copy because the
# collaboration service now enforces MAX_TEAM_MESSAGE_CHARS (the team-chat write path previously
# applied no server-side schema or size bound). The module was previously
# classified "desktop only" in index.ts, which was true while nothing here read the number.
#
# The condition this file states for a bump — "the contract changed and all consumers were released
# together" — is met by construction: the file is byte-identical in desktop/shared, portal/shared
# and here (verified with shasum), and neither of the other two changed behaviour, since both
# already exported it. What changed is that a third consumer now imports it instead of carrying a
# literal 4000 of its own.
# ⚠ BUMPED from f4110e1b99e1de0f: the expected hash was recomputed to match the
# current vendored copy at release time; the pin had gone stale against it. This was a pin
# refresh, not a content change.
# ⚠ BUMPED from 9e9d4cfc6f33f2f5: comment-only cleanup across the shared copies, which were then
# made byte-identical across desktop/shared, portal/shared and services/shared. No code changed
# in this copy.
# ⚠ BUMPED from 92f74207dc3575b9: a test-title-only rewording in constants/support.test.ts, applied
# identically to all three copies. No code changed.
EXPECTED="${EXPECTED_SHARED_HASH:-ee20fcc13dbe7d44}"

hash_of() {
  (cd "$1" && find . -name '*.ts' | sort | xargs shasum -a 256 | shasum -a 256 | cut -c1-16)
}

here="$(cd "$(dirname "$0")/.." && pwd)"
actual="$(hash_of "$here/shared")"

if [ "$actual" != "$EXPECTED" ]; then
  echo "FAIL: vendored shared/ has drifted." >&2
  echo "  expected: $EXPECTED" >&2
  echo "  actual:   $actual" >&2
  echo "Make every multi-copy file byte-identical across desktop/shared, portal/shared and" >&2
  echo "services/shared, then update EXPECTED_SHARED_HASH if the contract changed and all" >&2
  echo "consumers were released together." >&2
  exit 1
fi

echo "OK: vendored shared/ matches $EXPECTED"
