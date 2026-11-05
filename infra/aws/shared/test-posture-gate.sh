#!/usr/bin/env bash
# =============================================================================
# Regression test for the bucket-posture gate in buildspec-validate.yml
# =============================================================================
# ⚠ WHY THIS EXISTS. A gate is a claim about what it would REFUSE, and that claim is
# untested unless something hands it a policy it should refuse. The gate's action checks were
# literal string membership for a long time - `"s3:DeleteObjectVersion" in actions` - so a
# grant spelled `s3:Delete*` or `s3:*` had the same authority and passed green, and the
# stack-policy check accepted a superset it never asked for. Both were found by review rather
# than by CI, because CI only ever saw the correct template.
#
# So this runs the REAL python block extracted from buildspec-validate.yml against the real
# platform-buckets.yaml (must PASS) and against copies mutated the way live drift would
# mutate them (must FAIL). No AWS calls: a stub `aws` on PATH answers the two SSM
# principal-list lookups.
#
# ⚠ THE STUB RETURNS NON-EMPTY PRINCIPAL LISTS ON PURPOSE. The grant statements are wrapped
# in !If on those lists, so with empty lists they are conditioned out of the resolved policy
# and a tampered grant is never examined - the test would pass for the wrong reason. That is
# also worth knowing operationally: a bucket deployed with no CicdPrincipals has no publisher
# statements for the gate to check.
#
#   ./aws/shared/test-posture-gate.sh          # from the repo root
#
# Add a case whenever you add an assertion to the gate. If a case starts passing when it
# should fail, the gate has been weakened.
# =============================================================================
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/bin"
cat > "$WORK/bin/aws" <<'FAKE'
#!/bin/bash
if [ "$1" = "ssm" ]; then
  case "$*" in
    *customer-principals*) echo "arn:aws:iam::111122223333:root" ;;
    # ⚠ A CASE CAN WIDEN THIS, which is the point: the finding's attack path is an SSM
    # PARAMETER WRITE, not a template edit, so the stub is where that has to be simulated.
    *cicd-principals*)     echo "${FAKE_CICD_PRINCIPALS:-arn:aws:iam::111122223333:role/praimana--services-build-role}" ;;
    *) echo "ParameterNotFound" >&2; exit 1 ;;
  esac
  exit 0
fi
echo "unexpected aws call: $*" >&2
exit 1
FAKE
chmod +x "$WORK/bin/aws"

# Extract the gate rather than reimplementing it - a copy would drift and then test nothing.
python3 - "$REPO/aws/shared/buildspec-validate.yml" "$WORK/gate.py" <<'EXTRACT'
import re, sys, textwrap
src = open(sys.argv[1]).read()
m = re.search(r"<<'PY'\n(.*?)\n\s*PY\b", src, re.S)
if not m:
    sys.exit("FATAL: could not find the embedded python block in buildspec-validate.yml")
open(sys.argv[2], "w").write(textwrap.dedent(m.group(1)))
EXTRACT

cat > "$WORK/mutate.py" <<'MUTATE'
import json, sys

case, tmpl_path, sp_path = sys.argv[1], sys.argv[2], sys.argv[3]
tmpl = open(tmpl_path).read()

# The publisher grant, which every managed bucket policy carries.
ANCHOR = """              Action:
                - s3:PutObject
                - s3:AbortMultipartUpload"""

def widen(replacement):
    if ANCHOR not in tmpl:
        sys.exit("FATAL: the CicdWriteObjects anchor moved - update this test")
    return tmpl.replace(ANCHOR, replacement, 1)

if case == "pristine":
    pass

elif case == "delete-wildcard":
    # Same authority as the s3:DeleteObjectVersion the gate forbids, spelled differently.
    tmpl = widen("""              Action:
                - s3:PutObject
                - s3:Delete*
                - s3:AbortMultipartUpload""")

elif case == "allow-wildcard":
    # A pattern in an Allow. The old check only recognised the exact string "s3:*".
    tmpl = widen("""              Action:
                - s3:Put*
                - s3:AbortMultipartUpload""")

elif case == "wildcard-principal":
    # A Principal of "*" on the publisher grant, spelled in the template. The gate inspected
    # Effect, Action, Sid, versioning, deletion policy and public-access blocks - and never WHO
    # a statement grants to, so this passed every assertion it had.
    if "                AWS: !Ref CicdPrincipals" not in tmpl:
        sys.exit("FATAL: the CicdWriteObjects Principal moved - update this test")
    tmpl = tmpl.replace("                AWS: !Ref CicdPrincipals", '                AWS: "*"')

elif case == "unguarded-policy":
    # Buckets guarded, their BucketPolicy resources not - the state this repo shipped, in
    # which a policy resource was replaceable by an ordinary stack update.
    sp = json.load(open(sp_path))
    for s in sp["Statement"]:
        if s.get("Effect") == "Deny":
            s["Resource"] = [r for r in s["Resource"] if not r.endswith("BucketPolicy")]
    json.dump(sp, open(sp_path, "w"), indent=2)

elif case == "wildcard-principal-from-ssm":
    # No template change at all - the widening arrives through the stubbed SSM lookup.
    pass

else:
    sys.exit(f"unknown case {case}")

open(tmpl_path, "w").write(tmpl)
MUTATE

export PATH="$WORK/bin:$PATH"
export ENVIRONMENT=shared APPLICATION_NAME="Praimana" AUTO_DELETE=never
export ENABLE_DELETE_PROTECTION=true CICD_CAN_DELETE=false BUCKET_NAME_SUFFIX="-testhash"
export CUSTOMER_PRINCIPALS_PARAM=/praimana/shared/customer-principals
export CICD_PRINCIPALS_PARAM=/praimana/shared/cicd-principals

failed=0

run_case() {
  local name="$1" expect="$2" dir="$WORK/case-$1"
  mkdir -p "$dir/aws/shared"
  cp "$REPO/aws/shared/platform-buckets.yaml" "$REPO/aws/shared/stack-policy.json" "$dir/aws/shared/"
  python3 "$WORK/mutate.py" "$name" "$dir/aws/shared/platform-buckets.yaml" "$dir/aws/shared/stack-policy.json" || exit 1

  local got=pass
  ( cd "$dir" && python3 "$WORK/gate.py" aws/shared/platform-buckets.yaml ) > "$dir/out.txt" 2>&1 || got=fail

  if [ "$got" = "$expect" ]; then
    printf '  ok       %-18s %s\n' "$name" "$got"
    [ "$got" = fail ] && sed -n 's/^  - /           /p' "$dir/out.txt" | head -3
  else
    printf '  FAILED   %-18s got %s, expected %s\n' "$name" "$got" "$expect"
    sed 's/^/           /' "$dir/out.txt" | tail -12
    failed=1
  fi
}

echo "bucket-posture gate:"
run_case pristine         pass   # the committed template must not trip its own assertions
run_case delete-wildcard  fail   # s3:Delete* == s3:DeleteObjectVersion
run_case allow-wildcard   fail   # any wildcard action in an Allow
run_case wildcard-principal fail # "*" in an Allow Principal, spelled in the template
run_case unguarded-policy fail   # stack policy must cover the *BucketPolicy ids too

# ⚠ THE FINDING'S ACTUAL PATH, which no template edit reproduces: the principal lists are read
# from Parameter Store at deploy time, so widening them needs an SSM write and a pipeline run
# rather than a reviewed change. The AllowedPattern on the parameter would refuse this at
# CloudFormation, and this asserts the gate refuses it BEFORE that - the two controls are
# independent because either can be bypassed alone.
FAKE_CICD_PRINCIPALS='*' run_case wildcard-principal-from-ssm fail

if [ "$failed" -ne 0 ]; then
  echo "POSTURE GATE TEST FAILED"
  exit 1
fi
echo "all posture-gate cases behaved as expected"
