#!/usr/bin/env bash
# =============================================================================
# Regression test for the portal build's .env.production guard in platform-portal.yaml
# =============================================================================
# ⚠ WHY THIS EXISTS, AND WHY IT IS IN THIS REPO. These assertions used to live in the portal
# repo, in `src/lib/csp-cognito-host.test.ts`, under `describe("amplify.yml — the deploy guard
# the config relies on")`. They read `portal/amplify.yml` and checked that its env-capture loop
# asserted the variables the CSP and backend modules rely on.
#
# Amplify Hosting is not the deploy path: `platform-portal.yaml` builds the portal with
# CodeBuild and serves it from Lambda behind CloudFront, and there is no `amplify.yml`. A
# portal-side test of a hosting file would keep passing while the REAL guard rotted.
#
# The guard lives in PortalBuildProject's buildspec in platform-portal.yaml, so this test
# lives beside that template.
#
# ⚠ THESE ASSERTIONS ARE LOAD-BEARING FOR A SECURITY PROPERTY, NOT JUST FOR A BUILD.
#   * `csp.ts` narrows connect-src to the exact Cognito IDP host parsed out of
#     NEXT_PUBLIC_COGNITO_USER_POOL_ID. Unset, an older revision fell back to
#     `https://*.amazonaws.com https://*.amazoncognito.com` — a wildcard admitting every AWS
#     host. The fallback was justified on "the deploy asserts the variable", so if that
#     assertion disappears the justification is void and the wildcard is reachable.
#   * NEXTAUTH_SECRET is asserted ABSENT rather than present, which is the inverse of every
#     other key here. It lives in Secrets Manager and is read at cold start; written into
#     .env.production it would be baked into the Lambda zip in S3 and recoverable with
#     s3:GetObject or lambda:GetFunction. The template's own comment calls that out.
#
#   ./aws/app/test-portal-env-guard.sh          # from the repo root
#
# Add a case whenever you add a key to either loop. If a case starts passing when it should
# fail, the guard has been weakened.
# =============================================================================
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMPLATE="$REPO/aws/app/platform-portal.yaml"

fails=0
pass() { printf '  ok      %s\n' "$1"; }
fail() { printf '  FAILED  %s\n' "$1"; fails=$((fails + 1)); }

[ -f "$TEMPLATE" ] || { echo "FATAL: $TEMPLATE not found"; exit 1; }

# Extract the buildspec's guard rather than restating the key list — a restated copy would drift
# and then assert nothing. Both loops are pulled out by shape: the first writes .env.production,
# the second re-reads it and exits non-zero on anything missing or empty.
WRITE_LOOP="$(python3 - "$TEMPLATE" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
m = re.search(r"rm -f \.env\.production.*?printf 'NEXT_PUBLIC_APP_URL", src, re.S)
print(m.group(0) if m else "")
PY
)"

ASSERT_LOOP="$(python3 - "$TEMPLATE" <<'PY'
import re, sys
src = open(sys.argv[1]).read()
m = re.search(r"for k in ([^;]*?); do\s*\n\s*grep -Eq .\^\$k=\.\+.", src, re.S)
print(m.group(1) if m else "")
PY
)"

echo "portal .env.production guard — platform-portal.yaml"

[ -n "$WRITE_LOOP" ]  || fail "could not locate the .env.production write loop (template restructured?)"
[ -n "$ASSERT_LOOP" ] || fail "could not locate the .env.production assertion loop (template restructured?)"

# ── The keys the assertion loop must refuse to deploy without ────────────────────────────────
# NEXT_PUBLIC_COGNITO_USER_POOL_ID is the one the CSP wildcard fallback hinged on. The rest are
# what sign-in and the backend call cannot work without; a missing one should fail the build
# rather than produce a deployed app that 500s or silently widens a policy.
for key in \
  NEXTAUTH_URL \
  AUTH_TRUST_HOST \
  COGNITO_ISSUER \
  COGNITO_CLIENT_ID \
  BACKEND_URL \
  NODE_ENV \
  NEXT_PUBLIC_COGNITO_USER_POOL_ID \
  NEXT_PUBLIC_COGNITO_CLIENT_ID
do
  case "$ASSERT_LOOP" in
    *"$key"*) pass "asserted non-empty: $key" ;;
    *)        fail "NOT asserted: $key — a deploy missing it would succeed" ;;
  esac
done

# ── NEXT_PUBLIC_APP_URL must NOT be asserted ────────────────────────────────────────────────
# ⚠ DELIBERATE, mirroring the portal-side reasoning this test inherited. Every read falls back to
# NEXTAUTH_URL, which IS asserted, so a deploy setting only the latter is correctly configured.
# Asserting it would fail deploys that are fine.
case "$ASSERT_LOOP" in
  *NEXT_PUBLIC_APP_URL*) fail "NEXT_PUBLIC_APP_URL is asserted; it has an asserted fallback and must not be" ;;
  *)                     pass "not asserted (has an asserted fallback): NEXT_PUBLIC_APP_URL" ;;
esac

# ── NEXTAUTH_SECRET: the inverse assertion ──────────────────────────────────────────────────
case "$WRITE_LOOP" in
  *NEXTAUTH_SECRET*) fail "NEXTAUTH_SECRET appears in the .env.production write loop — it must come from Secrets Manager, not be baked into the artifact" ;;
  *)                 pass "absent from the write loop: NEXTAUTH_SECRET" ;;
esac

if grep -q "! grep -q '\^NEXTAUTH_SECRET=' .env.production" "$TEMPLATE"; then
  pass "artifact is checked to NOT contain NEXTAUTH_SECRET"
else
  fail "the 'NEXTAUTH_SECRET must not be in .env.production' check is gone — a regression here is otherwise invisible"
fi

# ── Negative control ────────────────────────────────────────────────────────────────────────
# ⚠ WITHOUT THIS THE WHOLE FILE CAN PASS FOR THE WRONG REASON. If the extraction regexes stop
# matching, every `case` above falls through to its success branch against an empty string. This
# asserts the extraction actually captured a key list, so a restructured template fails loudly
# instead of going green with zero coverage.
case "$ASSERT_LOOP" in
  *NEXTAUTH_URL*) pass "negative control: extraction returned a real key list" ;;
  *)              fail "negative control: extraction produced nothing usable — the checks above are vacuous" ;;
esac

echo
if [ "$fails" -eq 0 ]; then
  echo "PASS — portal env guard intact"
  exit 0
fi
echo "FAIL — $fails problem(s). The portal deploy guard has been weakened."
exit 1
