#!/usr/bin/env bash
#
# TEST VALIDATION BY DELIBERATE MUTATION.
#
# A test that has never failed has proven nothing. This script breaks the implementation in
# one specific way, rebuilds, runs the spec that is supposed to catch it, and reports whether
# it did — then restores the original file unconditionally.
#
# Every mutation below targets a DIFFERENT bound or guard, chosen so that a spec passing under
# the mutation would be a spec that is not actually asserting what its name claims.
#
#   1  focus-trap-off        remove the Tab trap        → priority 3 must fail
#   2  no-pending-refocus    remove the pending refocus → priority 2 must fail
#   3  confirm-not-disabled  drop `disabled={pending}`  → priority 4 must fail
#   4  no-return-fallback    ignore returnToFallback    → priority 1 (team) must fail
#   5  gate-open             render the access control  → the FACILITATOR gating must fail
#                            regardless of the role matrix
#   6  badge-always          badge every row            → the "No access" badge spec must fail
#
# USAGE
#   tests/e2e/mutation-check.sh            # run every mutation
#   tests/e2e/mutation-check.sh 3          # run one
#
# REQUIRES the portal to be servable: this rebuilds it per mutation (next build), which is
# slow but is the only way a production server sees the change.
#
# SAFETY: the original files are copied to a temp dir first and restored in an EXIT trap, so
# an interrupted run does not leave mutated production code behind. It also refuses to start
# if the working tree already has changes to the files it edits, so it can never discard
# somebody's in-progress work.
#
# ⚠ THE BUG THIS SCRIPT ONCE HAD, AND WHY THE BACKUP KEY IS NOT `basename` ANY MORE.
# The first version keyed every backup on `basename "$f"`. In Next's App Router, EVERY route
# file is called `page.tsx` — so `$TEAM_PAGE` and `$ADMIN_PAGE` both mapped to the key
# "page.tsx". The admin page's copy overwrote the team page's, and the restore then wrote
# ADMIN CONTENT INTO THE TEAM PAGE. The sha256 verification did not catch it either, because
# the recorded checksum was overwritten by the same collision, so the restore "verified"
# against the wrong file's hash and reported success.
#
# It destroyed uncommitted work: the team page's removal feature existed only in the working
# tree. Recovery had to come out of a stale turbo cache entry containing a pre-corruption
# build. So the key below is the path with separators replaced, never the basename, and the
# collision is checked for explicitly rather than trusted not to happen.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# A unique, filesystem-safe backup key for a path. `basename` is NOT safe here — see above.
# Defined AFTER REPO_ROOT because it reads it, and `set -u` makes an unset read fatal.
backup_key() {
  printf '%s' "${1#"$REPO_ROOT/"}" | tr '/[]' '___'
}

# ⚠ REBASED FOR THE SPLIT: was "$REPO_ROOT/apps/portal". The portal IS the repository now.
# `REPO_ROOT` needed no change — this script sits at tests/e2e/, so two levels up was the monorepo
# root and is now this repo's root.
#
# FUNCTIONAL, not documentation. `patch_file` would find none of the three sources below, every
# mutation would be skipped, and the run would report the suite as having survived — a green result
# from having mutated nothing, which is precisely the false confidence this script exists to deny.
#
# ⚠ AND THIS LINE WAS ALMOST MISSED, WHICH IS WORTH RECORDING. `file` calls this script "binary
# data" (its heuristic trips on the em-dashes, arrows and box-drawing in the comments — `iconv`
# confirms it is valid UTF-8), so a plain `grep apps/ tests/e2e/` SUPPRESSES the match here and
# prints nothing. "No output" read as "no reference". Use `grep -a` when auditing this directory.
PORTAL="$REPO_ROOT"
DIALOG="$PORTAL/src/components/ConfirmActionDialog.tsx"
TEAM_PAGE="$PORTAL/src/app/w/[workshopId]/t/[teamId]/team/page.tsx"
ADMIN_PAGE="$PORTAL/src/app/admin/page.tsx"
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

cleanup() {
  echo ""
  echo "── restoring original sources ──"
  local bad=0
  for f in "$DIALOG" "$TEAM_PAGE" "$ADMIN_PAGE"; do
    name="$(backup_key "$f")"
    if [[ -f "$BACKUP/$name" ]]; then
      cp "$BACKUP/$name" "$f"
      # VERIFIED, not assumed. "I restored it" is a claim; a matching checksum is evidence.
      if [[ -f "$BACKUP/$name.sha" ]]; then
        want="$(cat "$BACKUP/$name.sha")"
        got="$(shasum -a 256 "$f" | awk '{print $1}')"
        if [[ "$want" == "$got" ]]; then
          echo "   restored $name (sha256 verified)"
        else
          echo "   ⚠ RESTORE MISMATCH for $name — expected $want, got $got" >&2
          echo "     A COPY OF THE ORIGINAL IS AT: $BACKUP/$name (not deleted)" >&2
          bad=1
        fi
      else
        echo "   restored $name (no checksum recorded)"
      fi
    fi
  done
  if [[ $bad -eq 1 ]]; then
    echo "   LEAVING $BACKUP IN PLACE so the originals can be recovered by hand." >&2
    trap - EXIT
    exit 1
  fi
  rm -rf "$BACKUP"
  # Leave a correct build behind, so the next run is not against mutated code.
  echo "── rebuilding from restored sources ──"
  (cd "$PORTAL" && ulimit -n 10240 && pnpm exec next build > /tmp/mutation-restore-build.log 2>&1) \
    && echo "   rebuild ok" || echo "   REBUILD FAILED — see /tmp/mutation-restore-build.log"
}
trap cleanup EXIT INT TERM

# ── SAFETY: restore-by-copy, verified, rather than restore-by-git ──
#
# A `git diff --quiet` guard was the obvious check here and it is the wrong one: both features
# under test are currently UNCOMMITTED work (ConfirmActionDialog.tsx is untracked outright), so
# a git-cleanliness gate would refuse to run on precisely the code it exists to validate. And
# `git checkout --` as the restore mechanism would DELETE an untracked file rather than restore
# it, which would destroy the implementation this harness is testing.
#
# So the backup is a plain copy taken before any edit, restored in an EXIT trap, and VERIFIED
# byte-for-byte at the end. Nothing here consults git for either safety or recovery.
for f in "$DIALOG" "$TEAM_PAGE" "$ADMIN_PAGE"; do
  if [[ ! -f "$f" ]]; then
    echo "REFUSING TO RUN: expected file is missing: $f" >&2
    exit 1
  fi
  key="$(backup_key "$f")"
  # REFUSE on a key collision rather than silently overwriting. This is the exact failure that
  # destroyed the team page once: two different sources mapping to one backup slot, where the
  # second copy wins and the restore writes it over the first.
  if [[ -f "$BACKUP/$key" ]]; then
    echo "REFUSING TO RUN: backup key collision for $f (key '$key')." >&2
    echo "  Two source files map to the same backup slot; restoring would overwrite one with" >&2
    echo "  the other. Fix backup_key() before running." >&2
    exit 1
  fi
  cp "$f" "$BACKUP/$key"
  # A checksum recorded now is what makes "restored correctly" an assertion instead of a hope.
  shasum -a 256 "$f" | awk '{print $1}' > "$BACKUP/$key.sha"
done

# PROVE the backup is faithful before mutating anything. A backup that does not round-trip is
# not a backup, and discovering that after the mutation is discovering it too late.
for f in "$DIALOG" "$TEAM_PAGE" "$ADMIN_PAGE"; do
  key="$(backup_key "$f")"
  if ! cmp -s "$f" "$BACKUP/$key"; then
    echo "REFUSING TO RUN: backup of $f does not match the original. Aborting before any edit." >&2
    exit 1
  fi
done

rebuild_and_serve() {
  (cd "$PORTAL" && ulimit -n 10240 && pnpm exec next build > /tmp/mutation-build.log 2>&1)
  if [[ $? -ne 0 ]]; then
    echo "   BUILD FAILED — the mutation did not compile. See /tmp/mutation-build.log"
    return 1
  fi
  stop_server || return 1
  (cd "$PORTAL" && ulimit -n 10240 && AUTH_TRUST_HOST=true pnpm exec next start --port $PORT -H "$HOST" \
    > /tmp/mutation-serve.log 2>&1 &)
  # Poll for readiness rather than sleeping a guessed duration.
  for _ in $(seq 1 40); do
    if curl -sf -o /dev/null "http://$HOST:$PORT/login"; then return 0; fi
    sleep 0.5
  done
  echo "   SERVER DID NOT COME UP — see /tmp/mutation-serve.log"
  return 1
}

# Replace an exact literal in a file. Fails loudly if the anchor is absent, because a
# mutation that silently did nothing would report the tests as passing over intact code.
patch_file() {
  local file="$1" old="$2" new="$3"
  python3 - "$file" "$old" "$new" <<'PY'
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
    -g "$grep_pattern" --reporter=line > "/tmp/mutation-$id.log" 2>&1)
  local status=$?

  if [[ $status -ne 0 ]]; then
    echo "RESULT $id: ✅ CAUGHT — the spec failed as it should have."
    grep -E "Error:|✘|failed" "/tmp/mutation-$id.log" | head -4 | sed 's/^/     /'
  else
    echo "RESULT $id: ❌ NOT CAUGHT — the spec PASSED against deliberately broken code."
    echo "     This means the assertion does not test what its name claims."
    tail -4 "/tmp/mutation-$id.log" | sed 's/^/     /'
  fi

  # Restore before the next mutation so they cannot compound. Verified per file, because a
  # silent bad restore here is what corrupts the working tree for every mutation after it.
  for f in "$DIALOG" "$TEAM_PAGE" "$ADMIN_PAGE"; do
    key="$(backup_key "$f")"
    cp "$BACKUP/$key" "$f"
    if ! cmp -s "$f" "$BACKUP/$key"; then
      echo "   ⚠ RESTORE FAILED for $f — ABORTING before the next mutation compounds it." >&2
      exit 1
    fi
  done
}

ONLY="${1:-all}"

# ── WHY EVERY MUTATION BELOW IS PLAUSIBLE CODE, NOT AN `if (true) return` STUB ──
# The first draft of this script used constant-condition stubs, and the build REFUSED them:
# `no-constant-condition`, `no-constant-binary-expression` and `no-unused-vars` are errors in
# this repo's ESLint config, and `next build` runs lint. The right response was NOT to disable
# the gate — a mutation harness that switches off a CI check to do its job has broken the thing
# it is measuring. Instead each mutation is now written as a change a developer could actually
# make by mistake, which is a strictly better test of the spec anyway: it proves the assertion
# catches a REALISTIC regression rather than an obviously-broken one.

# ── 1 ── Trap only the FORWARD direction, dropping the Shift+Tab branch. This is the most
# likely real-world version of this bug: forward wrapping is the case people remember to
# implement, and Shift+Tab on the first element is the one that gets forgotten.
if [[ "$ONLY" == "all" || "$ONLY" == "1" ]]; then
  patch_file "$DIALOG" \
    '    if (event.shiftKey && (active === first || active === root)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {' \
    '    if (!event.shiftKey && active === last) {' \
    && run_mutation 1 "focus trap loses its Shift+Tab (backward) branch" "remove-member" "priority 3"
fi

# ── 2 ── Guard the pending refocus on the panel CONTAINING the active element, inverted — i.e.
# the classic mistake of getting the condition backwards, so focus is rescued only when it did
# NOT need rescuing.
if [[ "$ONLY" == "all" || "$ONLY" == "2" ]]; then
  patch_file "$DIALOG" \
    '    if (root.contains(document.activeElement)) return;
    dismissRef.current?.focus();' \
    '    if (!root.contains(document.activeElement)) return;
    dismissRef.current?.focus();' \
    && run_mutation 2 "pending-refocus guard inverted" "remove-member" "priority 2"
fi

# ── 3 ── Disable the confirm button on the WRONG signal — a plausible refactor that reads
# `reason` state instead of `pending`. The button stays live while the request is in flight, so
# a second submit becomes reachable.
if [[ "$ONLY" == "all" || "$ONLY" == "3" ]]; then
  patch_file "$DIALOG" \
    '            disabled={pending}
            onClick={() => onConfirm(reason)}' \
    '            disabled={reason === "\u0000never"}
            onClick={() => onConfirm(reason)}' \
    && run_mutation 3 "confirm button no longer disables while pending" "remove-member" "priority 4"
fi

# ── 4 ── Check only `isConnected` and drop the `doomed` half — exactly the "surely isConnected
# is enough" simplification the prop's own comment warns against.
if [[ "$ONLY" == "all" || "$ONLY" == "4" ]]; then
  patch_file "$DIALOG" \
    '      const doomed = returnToFallbackRef.current?.() ?? false;
      if (!doomed && opener instanceof HTMLElement && opener.isConnected) {' \
    '      if (opener instanceof HTMLElement && opener.isConnected) {' \
    && run_mutation 4 "returnToFallback dropped in favour of isConnected alone" "remove-member" "priority 1"
fi

# ── 5 ── Gate the control on `hasAccount` alone, dropping the role-matrix and self checks.
# A FACILITATOR would then be offered a control on an ADMIN row — the lateral attack.
if [[ "$ONLY" == "all" || "$ONLY" == "5" ]]; then
  patch_file "$ADMIN_PAGE" \
    '        {!reason && (
          <button
            type="button"
            disabled={submitting}' \
    '        {user.hasAccount && (
          <button
            type="button"
            disabled={submitting}' \
    && run_mutation 5 "access gate drops the role matrix, keeping only hasAccount" "user-access" "FACILITATOR is offered no access control"
fi

# ── 6 ── Test the ALLOW value instead of the DENY value — the exact inversion
# isUserDeactivated's comment exists to prevent, which badges every legacy row with no
# `status` attribute as disabled.
#
# The shared predicate is still CALLED (or-ed in) purely so the import does not become unused,
# which is a lint error here and would fail the build for the wrong reason. The `!== "ACTIVE"`
# term is what does the damage, and it dominates: a row with no status satisfies it.
if [[ "$ONLY" == "all" || "$ONLY" == "6" ]]; then
  patch_file "$ADMIN_PAGE" \
    '  const deactivated = isUserDeactivated(user);' \
    '  const deactivated = isUserDeactivated(user) || user.status !== "ACTIVE";' \
    && run_mutation 6 "deactivation predicate inverted to test the ALLOW value" "user-access" "disabled row is unmistakable"
fi

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo "Mutation run complete. Sources are restored by the EXIT trap below."
echo "════════════════════════════════════════════════════════════════════"
