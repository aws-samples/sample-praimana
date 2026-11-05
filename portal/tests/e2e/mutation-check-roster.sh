#!/usr/bin/env bash
#
# TEST VALIDATION BY DELIBERATE MUTATION — the roster-status and directory specs.
#
# A companion to mutation-check.sh, written the same way and for the same reason: a test that
# has never failed has proven nothing. Separate from that script because it targets DIFFERENT
# production files (the tRPC router, and the admin page's directory tab) and because that
# script's mutation list is specific to the dialog's focus contract.
#
# ⚠ THE BACKUP KEY IS THE REPO-RELATIVE PATH, NEVER `basename`. This is not a style choice.
# The first version of the sibling script keyed on `basename "$f"`, and in Next's App Router
# EVERY route file is called `page.tsx` — so the team page and the admin page mapped to one
# backup slot, the second copy won, and the restore wrote ADMIN CONTENT INTO THE TEAM PAGE. The
# sha256 check did not catch it because the recorded checksum shared the collision. It destroyed
# uncommitted work. Read the note at the top of mutation-check.sh in full before editing this.
#
#   1  getById-unfiltered   drop the INACTIVE exclusion in team.getById  → scenario 14 must fail
#   2  getById-strict       `=== "ACTIVE"` instead of `!== "INACTIVE"`   → scenario 15 must fail
#   3  getById-no-normalise drop .trim().toUpperCase()                   → scenario 16 must fail
#   4  count-coerced        `memberCount ?? 0` in the directory row      → the null-count spec
#   5  workshop-name-loose  branch on `!= null` not on the trimmed value → the blank-cell spec
#   6  prev-not-disabled    drop `disabled={page === 0}` on Previous     → the underflow spec
#
# USAGE
#   tests/e2e/mutation-check-roster.sh          # every mutation
#   tests/e2e/mutation-check-roster.sh 2        # just one
#
# SAFETY: originals are copied before any edit, cmp-verified against the source, restored in an
# EXIT trap, and verified by sha256 AND cmp afterwards. A collision in the backup keys aborts
# the run rather than risking the failure described above.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Filesystem-safe key from the REPO-RELATIVE PATH. `basename` is NOT safe here — see above.
backup_key() {
  printf '%s' "${1#"$REPO_ROOT/"}" | tr '/[]' '___'
}

# ⚠ The two source paths below hang directly off `REPO_ROOT`. `REPO_ROOT` needs no adjustment —
# this script sits at tests/e2e/, so two levels up is this repo's root.
#
# This one is FUNCTIONAL, not documentation: a wrong path would point every mutation at a path that
# does not exist. The script would then find nothing to mutate and report the suite as surviving —
# a green result from having tested nothing, which is the exact failure a mutation check exists to
# rule out.
PORTAL="$REPO_ROOT"
TEAM_ROUTER="$PORTAL/src/lib/trpc/routers/team.ts"
ADMIN_PAGE="$PORTAL/src/app/admin/page.tsx"
SOURCES=("$TEAM_ROUTER" "$ADMIN_PAGE")
BACKUP="$(mktemp -d)"
PORT=3001
# Loopback only: the server this script starts is a local test target, never reachable from the network.
HOST=127.0.0.1

# Stop whatever is LISTENING on $PORT, found by socket rather than by process name: `next start`
# renames its process (next-server), so `pkill -f "next start ..."` can miss it. A server left over
# from the previous mutation would otherwise answer the readiness check for the next one, and the
# result would describe the wrong build. Refuses to continue if the port is still taken.
stop_server() {
  local pids
  pids="$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null)"
  [[ -z "$pids" ]] && return 0
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null
  for _ in $(seq 1 20); do
    [[ -z "$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null)" ]] && return 0
    sleep 0.5
  done
  echo "   PORT $PORT STILL IN USE after stopping pid(s) $pids — refusing to test against a stale server" >&2
  return 1
}

restore_all() {
  local bad=0
  for f in "${SOURCES[@]}"; do
    local key; key="$(backup_key "$f")"
    [[ -f "$BACKUP/$key" ]] || continue
    cp "$BACKUP/$key" "$f"
    # BOTH checks. cmp proves byte-identity; the sha is the recorded evidence for the report.
    if ! cmp -s "$f" "$BACKUP/$key"; then
      echo "   ⚠ RESTORE MISMATCH (cmp) for $key" >&2
      bad=1
      continue
    fi
    local want got
    want="$(cat "$BACKUP/$key.sha")"
    got="$(shasum -a 256 "$f" | awk '{print $1}')"
    if [[ "$want" == "$got" ]]; then
      echo "   restored $key (sha256 + cmp verified)"
    else
      echo "   ⚠ RESTORE MISMATCH (sha) for $key — expected $want, got $got" >&2
      bad=1
    fi
  done
  return $bad
}

cleanup() {
  echo ""
  echo "── restoring original sources ──"
  if ! restore_all; then
    echo "   LEAVING $BACKUP IN PLACE so the originals can be recovered by hand." >&2
    trap - EXIT
    exit 1
  fi
  rm -rf "$BACKUP"
  echo "── rebuilding from restored sources ──"
  (cd "$PORTAL" && ulimit -n 10240 && pnpm exec next build > /tmp/roster-restore-build.log 2>&1) \
    && echo "   rebuild ok" || echo "   REBUILD FAILED — see /tmp/roster-restore-build.log"
  # Bring the server back up on restored code, so the tree is left in a runnable state.
  stop_server || return
  (cd "$PORTAL" && ulimit -n 10240 && AUTH_TRUST_HOST=true pnpm exec next start --port $PORT -H "$HOST" \
    > /tmp/roster-serve.log 2>&1 &)
  for _ in $(seq 1 40); do
    curl -sf -o /dev/null "http://$HOST:$PORT/login" && { echo "   server back up on restored code"; break; }
    sleep 0.5
  done
}
trap cleanup EXIT INT TERM

for f in "${SOURCES[@]}"; do
  [[ -f "$f" ]] || { echo "REFUSING TO RUN: missing $f" >&2; exit 1; }
  key="$(backup_key "$f")"
  if [[ -f "$BACKUP/$key" ]]; then
    echo "REFUSING TO RUN: backup key collision for $f (key '$key')." >&2
    exit 1
  fi
  cp "$f" "$BACKUP/$key"
  shasum -a 256 "$f" | awk '{print $1}' > "$BACKUP/$key.sha"
done

# PROVE the backup round-trips BEFORE mutating. Discovering a bad backup after the edit is
# discovering it too late.
for f in "${SOURCES[@]}"; do
  key="$(backup_key "$f")"
  cmp -s "$f" "$BACKUP/$key" || {
    echo "REFUSING TO RUN: backup of $f does not match the original. Aborting before any edit." >&2
    exit 1
  }
done

rebuild_and_serve() {
  (cd "$PORTAL" && ulimit -n 10240 && pnpm exec next build > /tmp/roster-build.log 2>&1)
  if [[ $? -ne 0 ]]; then
    echo "   BUILD FAILED — the mutation did not compile. See /tmp/roster-build.log"
    return 1
  fi
  stop_server || return 1
  (cd "$PORTAL" && ulimit -n 10240 && AUTH_TRUST_HOST=true pnpm exec next start --port $PORT -H "$HOST" \
    > /tmp/roster-serve.log 2>&1 &)
  # Poll for readiness rather than sleeping a guessed duration.
  for _ in $(seq 1 40); do
    curl -sf -o /dev/null "http://$HOST:$PORT/login" && return 0
    sleep 0.5
  done
  echo "   SERVER DID NOT COME UP — see /tmp/roster-serve.log"
  return 1
}

# Replace an exact literal. Fails loudly if the anchor is absent — a mutation that silently did
# nothing would report the specs as passing over intact code, which is the one outcome this
# script must never produce.
patch_file() {
  python3 - "$1" "$2" "$3" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read()
if old not in s:
    sys.stderr.write("ANCHOR NOT FOUND — the implementation has changed; update this mutation.\n")
    sys.exit(2)
open(path, "w").write(s.replace(old, new, 1))
PY
}

run_mutation() {
  local id="$1" label="$2" spec="$3" grep_pattern="$4"
  echo ""
  echo "════════════════════════════════════════════════════════════════════"
  echo "MUTATION $id: $label"
  echo "  expects FAILURE from: $spec -g '$grep_pattern'"
  echo "════════════════════════════════════════════════════════════════════"

  if ! rebuild_and_serve; then
    echo "RESULT $id: INCONCLUSIVE (could not build/serve the mutation)"
    return
  fi

  (cd "$REPO_ROOT" && ulimit -n 10240 && pnpm exec playwright test "$spec" \
    -g "$grep_pattern" --reporter=line > "/tmp/roster-mutation-$id.log" 2>&1)
  local status=$?

  if [[ $status -ne 0 ]]; then
    echo "RESULT $id: CAUGHT — the spec failed as it should have."
    grep -E "Error:|✘|failed|expected" "/tmp/roster-mutation-$id.log" | head -6 | sed 's/^/     /'
  else
    echo "RESULT $id: NOT CAUGHT — the spec PASSED against deliberately broken code."
    echo "     The assertion does not test what its name claims."
    tail -5 "/tmp/roster-mutation-$id.log" | sed 's/^/     /'
  fi

  echo "   ── restoring before the next mutation ──"
  restore_all || { echo "   ABORTING before the next mutation compounds a bad restore." >&2; exit 1; }
}

ONLY="${1:-all}"

# Every mutation below is code a developer could plausibly write. Constant-condition stubs
# (`if (true) return`) are ESLint ERRORS in this repo and `next build` runs lint, so they would
# fail the build rather than the test — and switching off the lint gate to run a mutation
# harness would break the thing being measured.

# ── 1 ── The reported defect, exactly: the mapper passes INACTIVE rows straight through. This
# is the pre-81bc473 code.
if [[ "$ONLY" == "all" || "$ONLY" == "1" ]]; then
  patch_file "$TEAM_ROUTER" \
    '      const members = (membersData.members || [])
        .filter((m: any) => String(m?.status ?? "").trim().toUpperCase() !== "INACTIVE")
        .map((m: any) => ({' \
    '      const members = (membersData.members || [])
        .map((m: any) => ({' \
    && run_mutation 1 "team.getById passes INACTIVE rows through (the shipped defect)" \
       "roster-status" "scenario 14"
fi

# ── 2 ── The tidy-up refactor the commit message warns about: require the ALLOW value instead
# of excluding the DENY value. Legacy rows with no status are then dropped.
if [[ "$ONLY" == "all" || "$ONLY" == "2" ]]; then
  patch_file "$TEAM_ROUTER" \
    '        .filter((m: any) => String(m?.status ?? "").trim().toUpperCase() !== "INACTIVE")' \
    '        .filter((m: any) => String(m?.status ?? "").trim().toUpperCase() === "ACTIVE")' \
    && run_mutation 2 "team.getById requires status === ACTIVE (the legacy-lockout)" \
       "roster-status" "scenario 15"
fi

# ── 3 ── Drop the normalisation, keeping the comparison. A casing difference across bundles
# then decides whether a removed person appears.
if [[ "$ONLY" == "all" || "$ONLY" == "3" ]]; then
  patch_file "$TEAM_ROUTER" \
    '        .filter((m: any) => String(m?.status ?? "").trim().toUpperCase() !== "INACTIVE")' \
    '        .filter((m: any) => String(m?.status ?? "") !== "INACTIVE")' \
    && run_mutation 3 "team.getById stops normalising case and whitespace" \
       "roster-status" "scenario 16"
fi

# ── 4 ── `?? 0` on the member count — the exact coercion the row's own ⚠ note forbids, and the
# one that reads as "empty team" and gets a populated team deleted.
if [[ "$ONLY" == "all" || "$ONLY" == "4" ]]; then
  patch_file "$ADMIN_PAGE" \
    '  const count = team.memberCount;' \
    '  const count = team.memberCount ?? 0;' \
    && run_mutation 4 "directory row coerces a null member count to 0" \
       "teams-directory" "memberCount"
fi

# ── 5 ── Branch on `!= null` rather than on the trimmed value, so `""` and `" "` render an
# invisible cell — the "data problem" reading the fallback exists to prevent.
if [[ "$ONLY" == "all" || "$ONLY" == "5" ]]; then
  patch_file "$ADMIN_PAGE" \
    '  const workshopName = team.workshopName?.trim() ? team.workshopName : null;' \
    '  const workshopName = team.workshopName != null ? team.workshopName : null;' \
    && run_mutation 5 "directory row treats a blank workshop name as a real name" \
       "teams-directory" "workshopName"
fi

# ── 6 ── Drop `disabled={page === 0}` from Previous. The in-handler guard still exists, so this
# specifically tests the DOM PROPERTY the unit suite cannot reach — which is the whole reason
# these specs exist.
if [[ "$ONLY" == "all" || "$ONLY" == "6" ]]; then
  patch_file "$ADMIN_PAGE" \
    '          <button
            type="button"
            disabled={page === 0}
            /* GUARDED IN THE HANDLER as well as by `disabled`, identical to UsersTab'"'"'s Previous' \
    '          <button
            type="button"
            /* GUARDED IN THE HANDLER as well as by `disabled`, identical to UsersTab'"'"'s Previous' \
    && run_mutation 6 "Previous loses its disabled attribute on page 1" \
       "teams-directory" "underflow"
fi

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo "Mutation run complete. Sources are restored by the EXIT trap below."
echo "════════════════════════════════════════════════════════════════════"
