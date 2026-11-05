#!/usr/bin/env bash
# Copyright (c) 2026 Amazon Web Services
# Licensed under the MIT-0 License. See LICENSE.md in the project root.
#
# Step-by-step deployment of Praimana into one AWS account, following infra/SETUP.md and
# infra/aws/app/README.md. Deploys the application TIER BY TIER (stable stack names, and the
# only path that wires the API custom domain), and is safe to re-run: every step is idempotent.
#
#   ./infra/scripts/deploy.sh help                          list the steps
#   ./infra/scripts/deploy.sh --config my.json all          run every step in order
#   ./infra/scripts/deploy.sh --config my.json <step> [...] run one or more steps
#
# Inputs: a JSON file (--config, default infra/scripts/deploy-config.json; see
# deploy-config.example.json). Missing inputs are prompted for and saved back to that file.
# Nothing is ever deleted.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_DIR="$REPO_ROOT/infra/aws/app"
STATE_DIR="$SCRIPT_DIR/.state"
BUILD_DIR="$STATE_DIR/build"

readonly REQUIRED_REGION="us-east-1"
readonly STAGING_PREFIX="templates/cfn-staging"
readonly CAPS="CAPABILITY_IAM CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND"
readonly SEMVER_RE='^[0-9]+\.[0-9]+\.[0-9]+$'
readonly POLL_SECONDS=30

readonly STACK_BUCKETS="praimana-platform-buckets"
readonly STACK_KMS="praimana-kms"
readonly STACK_DDB="praimana-dynamodb"
readonly STACK_PLUMBING="praimana-plumbing"
readonly STACK_SES="praimana-ses"
readonly STACK_IDENTITY="praimana-identity"
readonly STACK_API="praimana-api"
readonly STACK_PORTAL="praimana-portal"
readonly STACK_OBS="praimana-observability"
readonly STACK_DNS="praimana-dns"   # in the DNS account (deployment.dnsProfile)

STEPS="preflight cert buckets publish-services publish-portal publish-desktop kms dynamodb
plumbing ses identity api portal portal-build observability dns seed-formats seed-admin verify"

# ============================================================================================
# helpers
# ============================================================================================
log()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33m    WARN: %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31mFATAL: %s\033[0m\n' "$*" >&2; exit 1; }

awsx() { aws --region "$AWS_REGION" --output text "$@"; }
sha256() { shasum -a 256 "$1" | awk '{print $1}'; }

# Run a quality gate (type-check, lint, test) with every AWS credential source removed, in a
# subshell so the deploy keeps its own credentials. A test must never reach the account being
# deployed: with live credentials, a test that expects an AWS call to fail calls real services.
without_aws() {
  (
    unset AWS_PROFILE AWS_DEFAULT_PROFILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN \
          AWS_CONTAINER_CREDENTIALS_RELATIVE_URI AWS_CONTAINER_CREDENTIALS_FULL_URI AWS_WEB_IDENTITY_TOKEN_FILE
    export AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_CONFIG_FILE=/dev/null AWS_EC2_METADATA_DISABLED=true
    "$@"
  )
}

confirm() {
  [ "${AUTO_APPROVE:-false}" = "true" ] && return 0
  [ "${NON_INTERACTIVE:-false}" != "true" ] && [ -r /dev/tty ] || die "confirmation needed - re-run with --yes"
  printf '\n%s [y/N] ' "$1" > /dev/tty
  read -r answer < /dev/tty
  [ "$answer" = "y" ] || [ "$answer" = "Y" ] || die "aborted by user"
}

stack_status() {
  awsx cloudformation describe-stacks --stack-name "$1" \
    --query 'Stacks[0].StackStatus' 2>/dev/null || echo "NONE"
}

stack_exists() { [ "$(stack_status "$1")" != "NONE" ]; }

out() {
  local v
  v=$(awsx cloudformation describe-stacks --stack-name "$1" \
        --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue | [0]" 2>/dev/null || true)
  [ -n "$v" ] && [ "$v" != "None" ] || die "stack $1 has no output $2 (deploy it first)"
  printf '%s' "$v"
}

param_of() {
  awsx cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Parameters[?ParameterKey=='$2'].ParameterValue | [0]" 2>/dev/null || true
}

state_get() { [ -f "$STATE_DIR/$1" ] && cat "$STATE_DIR/$1" || true; }
state_set() { mkdir -p "$STATE_DIR"; printf '%s' "$2" > "$STATE_DIR/$1"; }

# Deploy one stack. Refuses a dead (ROLLBACK_COMPLETE) stack rather than deleting it.
cfn_deploy() {
  local stack="$1" template="$2"; shift 2
  local status; status=$(stack_status "$stack")
  case "$status" in
    ROLLBACK_COMPLETE|*_FAILED)
      die "$stack is $status. Inspect its events, then delete it yourself:
       aws cloudformation delete-stack --stack-name $stack --region $AWS_REGION" ;;
    *_IN_PROGRESS) die "$stack is $status - wait for it to settle and re-run" ;;
  esac
  log "deploying $stack ($(basename "$template"), currently $status)"
  local staging=()
  if stack_exists "$STACK_BUCKETS" && [ "$stack" != "$STACK_BUCKETS" ]; then
    staging=(--s3-bucket "$(cf_template_bucket)" --s3-prefix "$STAGING_PREFIX")
  fi
  # ${a[@]+...} because bash 3.2 (macOS) treats an empty array as unbound under set -u.
  # shellcheck disable=SC2086
  aws --region "$AWS_REGION" cloudformation deploy \
    --stack-name "$stack" --template-file "$template" ${staging[@]+"${staging[@]}"} \
    --capabilities $CAPS --no-fail-on-empty-changeset \
    --tags ApplicationName=Praimana Environment="$ENVIRONMENT" project=praimana agent-managed=true \
    --parameter-overrides "$@"
  info "$stack: $(stack_status "$stack")"
}

# ============================================================================================
# configuration
# ============================================================================================
# All user inputs live in a JSON file (--config FILE, default infra/scripts/deploy-config.json;
# see deploy-config.example.json). Stack-to-stack values are NOT in it - they are read live from
# stack outputs. A key that is ABSENT, or a required key that is empty, is prompted for,
# validated, and written back to the file so the next run does not ask again. A key present
# with "" is a deliberate "leave empty" for optional inputs.
readonly ABSENT="__ABSENT__"
readonly RE_HOST='^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
readonly RE_EMAIL='^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$'
readonly RE_EMAILS='^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}(,[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}){0,4}$'
readonly RE_BOOL='^(true|false)$'
readonly RE_ANY='.'
CONFIG_FILE="$SCRIPT_DIR/deploy-config.json"

cfg_get() {
  jq -r --arg s "$1" --arg k "$2" --arg a "$ABSENT" \
    'if ((.[$s] // {}) | has($k)) then .[$s][$k] | tostring else $a end' "$CONFIG_FILE"
}

cfg_set() {
  local tmp; tmp=$(mktemp "$CONFIG_FILE.XXXX")
  jq --arg s "$1" --arg k "$2" --arg v "$3" '.[$s] = ((.[$s] // {}) + {($k): $v})' \
    "$CONFIG_FILE" > "$tmp" && mv "$tmp" "$CONFIG_FILE"
}

# matches VALUE REGEX REQUIRED - an empty optional value is valid.
matches() {
  if [ -z "$1" ]; then [ "$3" != "required" ]; return; fi
  printf '%s' "$1" | grep -Eq "$2"
}

prompt_value() {
  local name="$1" desc="$2" def="$3" re="$4" req="$5" ans
  { [ -r /dev/tty ] && [ "${NON_INTERACTIVE:-false}" != "true" ]; } \
    || die "missing input $name ($desc) - add it to $CONFIG_FILE"
  while :; do
    printf '  %s\n    %s%s: ' "$name" "$desc" "${def:+ [$def]}" > /dev/tty
    IFS= read -r ans < /dev/tty || die "no input"
    ans="${ans:-$def}"
    matches "$ans" "$re" "$req" && { printf '%s' "$ans"; return 0; }
    printf '    invalid value, try again\n' > /dev/tty
  done
}

# ask VAR SECTION KEY REGEX DEFAULT required|optional DESCRIPTION
ask() {
  local var="$1" sec="$2" key="$3" re="$4" def="$5" req="$6" desc="$7" v
  v=$(cfg_get "$sec" "$key")
  if [ "$v" = "$ABSENT" ] || { [ -z "$v" ] && [ "$req" = "required" ]; }; then
    [ "$PROMPTED" = "true" ] || { log "missing inputs - answer below (saved to $CONFIG_FILE)"; PROMPTED=true; }
    v=$(prompt_value "$sec.$key" "$desc" "$def" "$re" "$req")
    cfg_set "$sec" "$key" "$v"
  fi
  matches "$v" "$re" "$req" || die "$sec.$key='$v' is invalid in $CONFIG_FILE ($desc)"
  printf -v "$var" '%s' "$v"
}

load_config() {
  if [ ! -f "$CONFIG_FILE" ]; then
    mkdir -p "$(dirname "$CONFIG_FILE")" && echo '{}' > "$CONFIG_FILE"
    info "created $CONFIG_FILE"
  fi
  jq -e 'type == "object"' "$CONFIG_FILE" >/dev/null 2>&1 || die "$CONFIG_FILE is not a JSON object"
  PROMPTED=false
  ask_deployment_inputs
  ask_template_inputs
  ask_email_inputs
  derive_config
}

ask_deployment_inputs() {
  ask AWS_PROFILE deployment awsProfile "$RE_ANY" "" optional \
    "AWS CLI profile (empty = credentials already in the environment)"
  ask AWS_REGION deployment awsRegion "^$REQUIRED_REGION\$" "$REQUIRED_REGION" required \
    "AWS region (must be $REQUIRED_REGION: one certificate serves CloudFront and the API)"
  ask EXPECTED_ACCOUNT_ID deployment expectedAccountId '^[0-9]{12}$' "" optional \
    "12-digit account id to refuse any other account (empty = no check)"
  ask DNS_PROFILE deployment dnsProfile "$RE_ANY" "" optional \
    "AWS profile for the account owning the Route 53 zone (empty = the application account)"
  ask HOSTED_ZONE_ID deployment hostedZoneId '^Z[A-Z0-9]+$' "" optional \
    "Route 53 hosted zone id for the records (empty = auto-detect, else print records)"
  ask ADMIN_EMAIL deployment adminEmail "$RE_EMAIL" "" optional \
    "first platform admin email, lowercase (empty = skip seed-admin)"
  ask RUN_CHECKS deployment runChecks "$RE_BOOL" true required \
    "run type-check/lint/test before publishing (true/false)"
}

ask_template_inputs() {
  ask ENVIRONMENT parameters Environment '^(dev|test|staging|prod|shared)$' dev required \
    "Environment (dev|test|staging|prod|shared)"
  ask PORTAL_DOMAIN parameters PortalDomainName "$RE_HOST" "" required \
    "portal hostname, e.g. portal.example.com"
  ask API_DOMAIN parameters ApiDomainName "$RE_HOST" "api.$PORTAL_DOMAIN" required \
    "API custom hostname"
  ask COGNITO_DOMAIN_PREFIX parameters CognitoDomainPrefix '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' "" required \
    "globally unique Cognito Hosted UI prefix (no aws/amazon/cognito)"
  echo "$COGNITO_DOMAIN_PREFIX" | grep -Eq 'aws|amazon|cognito' \
    && die "parameters.CognitoDomainPrefix must not contain aws, amazon or cognito"
  ask RELEASE_VERSION parameters ReleaseVersion "$SEMVER_RE" "$(pkg_version services)" required \
    "services release (bare semver)"
  ask PORTAL_RELEASE_VERSION parameters PortalReleaseVersion "$SEMVER_RE" "$(pkg_version portal)" required \
    "portal release (bare semver)"
  ask KEY_ADMINISTRATOR_ARN parameters KeyAdministratorArn '^arn:aws[a-z-]*:iam::[0-9]{12}:' "" optional \
    "KMS key administrator ARN (empty = account root)"
  ask LOG_RETENTION_DAYS parameters LogRetentionInDays '^[0-9]+$' 30 required "log retention in days"
  ask ENABLE_PORTAL_WAF parameters EnablePortalWaf "$RE_BOOL" true required "attach WAF to the portal"
  ask ENABLE_CANARY parameters EnableCanary "$RE_BOOL" true required "run the API liveness canary"
}

ask_email_inputs() {
  ask ALERT_EMAIL parameters AlertEmail "$RE_EMAILS" "" optional \
    "alarm recipients, comma-separated (empty = nobody subscribed)"
  ask SES_IDENTITY_NAME parameters SesIdentityName '^[^[:space:]]+$' "" optional \
    "SES sender address or domain (empty = no outbound email)"
  SES_IDENTITY_TYPE=EmailAddress SES_USE_EXISTING_IDENTITY=false SES_REPLY_TO=""
  [ -n "$SES_IDENTITY_NAME" ] || return 0
  ask SES_IDENTITY_TYPE parameters SesIdentityType '^(EmailAddress|Domain)$' EmailAddress required \
    "SES identity type (EmailAddress|Domain)"
  ask SES_USE_EXISTING_IDENTITY parameters SesUseExistingIdentity "$RE_BOOL" true required \
    "identity already verified in this account (true = do not deploy the SES tier)"
  ask SES_REPLY_TO parameters EmailReplyTo "$RE_EMAIL" "$SES_IDENTITY_NAME" optional \
    "Reply-To address for platform email"
}

derive_config() {
  if [ -n "$AWS_PROFILE" ]; then export AWS_PROFILE; else unset AWS_PROFILE; fi
  export AWS_PAGER=""
  PORTAL_ORIGIN="https://$PORTAL_DOMAIN"
  CALLBACK_URL="$PORTAL_ORIGIN/api/auth/callback/cognito"
  LOGOUT_URL="$PORTAL_ORIGIN/login"
}

pkg_version() { node -p "require('$REPO_ROOT/$1/package.json').version"; }

account_id() { awsx sts get-caller-identity --query Account; }

bucket_suffix() {
  local s; s=$(state_get bucket-suffix)
  if [ -z "$s" ] && stack_exists "$STACK_BUCKETS"; then
    s=$(param_of "$STACK_BUCKETS" BucketNameSuffix); state_set bucket-suffix "$s"
  fi
  [ -n "$s" ] || die "no bucket suffix yet - run the 'buckets' step first"
  printf '%s' "$s"
}

services_bucket()    { printf 'praimana-services%s' "$(bucket_suffix)"; }
portal_bucket()      { printf 'praimana-portal%s' "$(bucket_suffix)"; }
desktop_bucket()     { printf 'praimana-desktop%s' "$(bucket_suffix)"; }
cf_template_bucket() { printf 'praimana-cf-template%s' "$(bucket_suffix)"; }
cert_arn() { local a; a=$(state_get cert-arn); [ -n "$a" ] || die "run the 'cert' step first"; printf '%s' "$a"; }

git_commit() {
  local c; c=$(git -C "$REPO_ROOT" rev-parse HEAD)
  if [ -n "$(git -C "$REPO_ROOT" status --porcelain -- "$1")" ]; then
    warn "$1/ has uncommitted changes - they ARE packaged; the recorded commit is marked -dirty"
    c="$c-dirty"
  fi
  printf '%s' "$c"
}

# ============================================================================================
# step: preflight
# ============================================================================================
step_preflight() {
  log "preflight"
  local t
  for t in aws jq node corepack git zip unzip curl shasum dig python3; do
    command -v "$t" >/dev/null || die "missing tool: $t"
  done
  local acct; acct=$(account_id) || die "no AWS credentials (set AWS_PROFILE or export keys)"
  info "caller   $(awsx sts get-caller-identity --query Arn)"
  info "account  $acct   region $AWS_REGION   environment $ENVIRONMENT"
  [ -z "${EXPECTED_ACCOUNT_ID:-}" ] || [ "$acct" = "$EXPECTED_ACCOUNT_ID" ] \
    || die "account $acct is not EXPECTED_ACCOUNT_ID=$EXPECTED_ACCOUNT_ID"
  info "portal   $PORTAL_ORIGIN"
  info "api      https://$API_DOMAIN"
  info "release  services $RELEASE_VERSION, portal $PORTAL_RELEASE_VERSION"
  ses_existing && assert_ses_verified
  check_orphans
}

# Retain-policy leftovers from a failed deploy block the next one (SETUP.md 2.1). Report only.
check_orphans() {
  stack_exists "$STACK_DDB" && return 0
  local tables; tables=$(awsx dynamodb list-tables --query 'TableNames[?starts_with(@,`praimana-`)]')
  if [ -n "$tables" ]; then
    warn "praimana-* DynamoDB tables exist without the $STACK_DDB stack (orphans from a failed deploy?):"
    warn "$tables"
    warn "clean them per infra/SETUP.md 2.1 before deploying - this script will not delete them"
  else
    info "no orphaned praimana-* tables"
  fi
}

# ============================================================================================
# step: cert  - one ACM certificate in us-east-1 covering the portal and API hostnames
# ============================================================================================
step_cert() {
  log "ACM certificate for $PORTAL_DOMAIN + $API_DOMAIN"
  local arn; arn=$(find_cert)
  if [ -z "$arn" ]; then
    arn=$(awsx acm request-certificate --domain-name "$PORTAL_DOMAIN" \
            --subject-alternative-names "$API_DOMAIN" --validation-method DNS \
            --idempotency-token praimanacert \
            --tags Key=ApplicationName,Value=Praimana Key=agent-managed,Value=true \
            --query CertificateArn)
    info "requested $arn"
    sleep 10   # validation records take a moment to appear
  fi
  state_set cert-arn "$arn"
  dns_sync
  [ "$(cert_status "$arn")" = "ISSUED" ] && { info "certificate ISSUED"; return 0; }
  wait_for_cert "$arn"
}

find_cert() {
  awsx acm list-certificates --certificate-statuses ISSUED PENDING_VALIDATION \
    --query "CertificateSummaryList[?DomainName=='$PORTAL_DOMAIN' && contains(SubjectAlternativeNameSummaries, '$API_DOMAIN')].CertificateArn | [0]" \
    | sed 's/^None$//'
}

cert_status() { awsx acm describe-certificate --certificate-arn "$1" --query Certificate.Status; }

# "<name> <value>" of the ACM validation CNAME for one hostname (empty until ACM publishes it).
validation_record() {
  aws --region "$AWS_REGION" acm describe-certificate --certificate-arn "$(cert_arn)" --output json \
    | jq -r --arg d "$1" '.Certificate.DomainValidationOptions[]
        | select(.DomainName == $d) | .ResourceRecord // empty | "\(.Name) \(.Value)"'
}

wait_for_cert() {
  info "waiting for certificate validation (create the records above if not automated)..."
  local s
  while :; do
    s=$(cert_status "$1")
    case "$s" in
      ISSUED) info "certificate ISSUED"; return 0 ;;
      PENDING_VALIDATION) sleep "$POLL_SECONDS" ;;
      *) die "certificate is $s - check the ACM console" ;;
    esac
  done
}

# ============================================================================================
# DNS  - infra/aws/dns/platform-dns.yaml, deployed in the account that owns the hosted zone
# (deployment.dnsProfile; empty = the application account itself).
# ============================================================================================
dns_aws() {
  if [ -n "$DNS_PROFILE" ]; then aws --profile "$DNS_PROFILE" --region "$AWS_REGION" --output text "$@"
  else awsx "$@"; fi
}

# Longest public zone, in the DNS account, that is a suffix of the hostname.
hosted_zone_for() {
  [ -n "${HOSTED_ZONE_ID:-}" ] && { printf '%s' "$HOSTED_ZONE_ID"; return 0; }
  local name="$1" id
  while [ "${name#*.}" != "$name" ]; do
    id=$(dns_aws route53 list-hosted-zones-by-name --dns-name "$name." --max-items 1 \
           --query "HostedZones[?Name=='$name.' && Config.PrivateZone==\`false\`].Id | [0]" 2>/dev/null || true)
    [ -n "$id" ] && [ "$id" != "None" ] && { printf '%s' "${id##*/}"; return 0; }
    name="${name#*.}"
  done
  return 0
}

# Current endpoint targets, empty while the endpoint does not exist yet. Every DNS deploy passes
# ALL records it knows, so re-running an early step never deletes a later step's record.
portal_target() {
  stack_exists "$STACK_PORTAL" || return 0
  out "$STACK_PORTAL" PortalDistributionDomainName
}

api_target() {
  awsx apigatewayv2 get-domain-name --domain-name "$API_DOMAIN" \
    --query 'DomainNameConfigurations[0].ApiGatewayDomainName' 2>/dev/null | sed 's/^None$//' || true
}

dns_sync() {
  local pv av pt at zone
  pv=$(validation_record "$PORTAL_DOMAIN"); av=$(validation_record "$API_DOMAIN")
  pt=$(portal_target); at=$(api_target)
  zone=$(hosted_zone_for "$PORTAL_DOMAIN")
  if [ -z "$zone" ]; then
    warn "no Route 53 zone for $PORTAL_DOMAIN found${DNS_PROFILE:+ via profile $DNS_PROFILE} - create these yourself:"
    print_records "$pv" "$av" "$pt" "$at"; return 0
  fi
  log "DNS stack $STACK_DNS (zone $zone${DNS_PROFILE:+, profile $DNS_PROFILE})"
  dns_deploy "$zone" "$pv" "$av" "$pt" "$at"
}

print_records() {
  [ -z "$1" ] || info "CREATE DNS RECORD:  ${1% *}  CNAME  ${1#* }"
  [ -z "$2" ] || info "CREATE DNS RECORD:  ${2% *}  CNAME  ${2#* }"
  [ -z "$3" ] || info "CREATE DNS RECORD:  $PORTAL_DOMAIN  CNAME  $3"
  [ -z "$4" ] || info "CREATE DNS RECORD:  $API_DOMAIN  CNAME  $4"
  return 0
}

dns_deploy() {
  local pv="$2" av="$3"
  local status; status=$(dns_aws cloudformation describe-stacks --stack-name "$STACK_DNS" \
                           --query 'Stacks[0].StackStatus' 2>/dev/null || echo NONE)
  case "$status" in ROLLBACK_COMPLETE|*_FAILED|*_IN_PROGRESS)
    die "$STACK_DNS is $status in the DNS account - resolve it there and re-run" ;; esac
  dns_aws cloudformation deploy --stack-name "$STACK_DNS" \
    --template-file "$REPO_ROOT/infra/aws/dns/platform-dns.yaml" --no-fail-on-empty-changeset \
    --tags ApplicationName=Praimana Environment="$ENVIRONMENT" project=praimana \
    --parameter-overrides HostedZoneId="$1" PortalDomainName="$PORTAL_DOMAIN" ApiDomainName="$API_DOMAIN" \
      PortalValidationName="${pv% *}" PortalValidationValue="${pv#* }" \
      ApiValidationName="${av% *}" ApiValidationValue="${av#* }" \
      PortalTarget="$4" ApiTarget="$5"
  info "records: validation(${pv:+portal}${av:+ api}) endpoints(${4:+portal}${5:+ api})"
}

# ============================================================================================
# step: buckets  - the five supply-chain buckets (infra/aws/shared/platform-buckets.yaml)
# ============================================================================================
step_buckets() {
  local suffix; suffix=$(state_get bucket-suffix)
  if [ -z "$suffix" ] && stack_exists "$STACK_BUCKETS"; then suffix=$(param_of "$STACK_BUCKETS" BucketNameSuffix); fi
  if [ -z "$suffix" ]; then
    suffix="-$(python3 -c 'import secrets;print(secrets.token_hex(4))')"
    info "generated BucketNameSuffix=$suffix (stored in $STATE_DIR/bucket-suffix - never change it)"
  fi
  state_set bucket-suffix "$suffix"
  local root; root="arn:aws:iam::$(account_id):root"
  local protect=true
  # A first-run rollback must not meet the deletion guard (SETUP.md 1.3): create unprotected.
  stack_exists "$STACK_BUCKETS" || protect=false
  deploy_buckets "$suffix" "$root" "$protect"
  [ "$protect" = "true" ] || deploy_buckets "$suffix" "$root" true
}

deploy_buckets() {
  cfn_deploy "$STACK_BUCKETS" "$REPO_ROOT/infra/aws/shared/platform-buckets.yaml" \
    Environment="$ENVIRONMENT" BucketNameSuffix="$1" \
    CustomerPrincipals="$2" CicdPrincipals="$2" EnableDeleteProtection="$3"
}

# ============================================================================================
# step: publish-services  - mirrors services/buildspec-publish.yml
# ============================================================================================
# Corepack shims FIRST on PATH, so pnpm calls made from INSIDE package scripts
# (e.g. "pnpm -r run build") also get the packageManager-pinned version, not a global pnpm.
PNPM() {
  if [ -z "${PNPM_SHIMS:-}" ]; then
    PNPM_SHIMS="$STATE_DIR/corepack-bin"; mkdir -p "$PNPM_SHIMS"
    corepack enable --install-directory "$PNPM_SHIMS" pnpm
    export PATH="$PNPM_SHIMS:$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  fi
  pnpm "$@"
}

step_publish_services() {
  local bucket prefix commit; bucket=$(services_bucket); prefix="lambda/v$RELEASE_VERSION/"
  commit=$(git_commit services)
  log "publish services v$RELEASE_VERSION -> s3://$bucket/$prefix"
  release_guard "$bucket" "$prefix" "$commit" || return 0
  (cd "$REPO_ROOT/services" && build_services)
  local list; list=$(service_list)
  rm -rf "$BUILD_DIR/services" && mkdir -p "$BUILD_DIR/services"
  local svc
  for svc in $list; do package_service "$svc"; done
  assert_notify_templates
  for svc in $list; do upload_service "$bucket" "$prefix" "$svc" "$commit"; done
  write_services_manifest "$bucket" "$prefix" "$commit" "$list"
}

# 0 = proceed, 1 = already published from this commit (skip). Dies on a different commit.
release_guard() {
  local prev
  prev=$(aws --region "$AWS_REGION" s3 cp "s3://$1/${2}manifest.json" - 2>/dev/null | jq -r '.commit // empty' || true)
  [ -z "$prev" ] && return 0
  if [ "$prev" = "$3" ]; then info "already published from this commit - skipping"; return 1; fi
  die "release ${2} is already published from ${prev:0:12} and is immutable.
       Bump \"version\" in services/package.json (or set RELEASE_VERSION) and re-run."
}

build_services() {
  PNPM install --frozen-lockfile
  PNPM audit --audit-level=high
  if [ "$RUN_CHECKS" = "true" ]; then
    without_aws PNPM run type-check; without_aws PNPM run lint
    without_aws PNPM run test; without_aws PNPM run check:shared
  else
    warn "RUN_CHECKS=false - publishing without type-check, lint or tests"
  fi
  PNPM run build
}

# Same rule as the buildspec: every workspace package except the two shared libraries.
service_list() {
  sed -n 's/^[[:space:]]*-[[:space:]]*"\{0,1\}\([A-Za-z0-9._-]*\)"\{0,1\}[[:space:]]*$/\1/p' \
    "$REPO_ROOT/services/pnpm-workspace.yaml" | grep -vx -e shared -e service-shared
}

package_service() {
  local svc="$1" dist="$REPO_ROOT/services/$1/dist" stage="$BUILD_DIR/services/$1"
  [ -f "$dist/handler.js" ] || die "$svc/dist/handler.js missing - did the build run?"
  mkdir -p "$stage" && cp -R "$dist"/. "$stage"/
  [ -f "$stage/package.json" ] || printf '{"type":"module"}' > "$stage/package.json"
  [ "$(jq -r .type "$stage/package.json")" = "module" ] || die "$svc package.json is not type=module"
  rm -f "$BUILD_DIR/services/$svc.zip"
  (cd "$stage" && zip -qr "$BUILD_DIR/services/$svc.zip" .)
  info "$(printf '%-26s %9s bytes' "$svc" "$(wc -c < "$BUILD_DIR/services/$svc.zip" | tr -d ' ')")"
}

assert_notify_templates() {
  local zip="$BUILD_DIR/services/notify.zip"
  [ -f "$zip" ] || return 0
  # grep -c, not grep -q: under pipefail an early-exiting grep -q SIGPIPEs unzip and fails.
  local n; n=$(unzip -l "$zip" | grep -c 'templates/.*\.html' || true)
  [ "$n" -gt 0 ] || die "notify.zip carries no templates/"
  info "notify: $n html templates in the zip"
}

upload_service() {
  local bucket="$1" prefix="$2" svc="$3" commit="$4" zip="$BUILD_DIR/services/$3.zip"
  local key="${prefix}${svc}/${svc}.zip" size; size=$(wc -c < "$zip" | tr -d ' ')
  awsx s3 cp "$zip" "s3://$bucket/$key" --only-show-errors \
    --metadata "release=v$RELEASE_VERSION,commit=$commit,service=$svc,sha256=$(sha256 "$zip")"
  [ "$(awsx s3api head-object --bucket "$bucket" --key "$key" --query ContentLength)" = "$size" ] \
    || die "size mismatch for $key"
}

# Written LAST: its presence marks the release complete for release_guard.
write_services_manifest() {
  local bucket="$1" prefix="$2" commit="$3" list="$4" svc rows="[]"
  for svc in $list; do
    rows=$(jq --arg s "$svc" --arg k "${prefix}${svc}/${svc}.zip" \
      --arg h "$(sha256 "$BUILD_DIR/services/$svc.zip")" '. + [{service:$s,key:$k,sha256:$h}]' <<< "$rows")
  done
  jq -n --arg r "$RELEASE_VERSION" --arg p "$prefix" --arg c "$commit" --argjson s "$rows" \
    '{app:"praimana",component:"services",release:$r,keyPrefix:$p,commit:$c,builtBy:"infra/scripts/deploy.sh",services:$s}' \
    > "$BUILD_DIR/services/manifest.json"
  awsx s3 cp "$BUILD_DIR/services/manifest.json" "s3://$bucket/${prefix}manifest.json" --only-show-errors
  info "published $(echo "$list" | wc -w | tr -d ' ') services + manifest"
}

# ============================================================================================
# step: publish-portal  - mirrors portal/buildspec-publish.yml (SOURCE zip; built in-account)
# ============================================================================================
step_publish_portal() {
  local bucket v commit; bucket=$(portal_bucket); v="$PORTAL_RELEASE_VERSION"
  commit=$(git_commit portal)
  log "publish portal $v -> s3://$bucket/portal/$v/"
  (cd "$REPO_ROOT/portal" && check_portal)
  local stage="$BUILD_DIR/portal-src"
  export_tree portal "$stage"
  assert_no_env_files "$stage"
  local zip="$BUILD_DIR/portal-$v-${commit:0:12}.zip"
  rm -f "$zip"; (cd "$stage" && zip -qr "$zip" .)
  local key="portal/$v/portal-$v-${commit:0:12}.zip" pointer="portal/$v/portal-$v.zip"
  awsx s3 cp "$zip" "s3://$bucket/$key" --only-show-errors --metadata "version=$v,commit=$commit"
  awsx s3 cp "s3://$bucket/$key" "s3://$bucket/$pointer" --only-show-errors \
    --metadata-directive REPLACE --metadata "version=$v,commit=$commit"
  info "published s3://$bucket/$pointer ($(du -h "$zip" | cut -f1))"
}

check_portal() {
  PNPM install --frozen-lockfile
  PNPM audit --audit-level=high --prod
  if [ "$RUN_CHECKS" = "true" ]; then
    without_aws PNPM run type-check; without_aws PNPM run lint; without_aws PNPM run test
  else
    warn "RUN_CHECKS=false - publishing without type-check, lint or tests"
  fi
}

# The WORKING tree as git sees it: tracked files plus untracked files that are not git-ignored,
# so node_modules, .next, .env* etc. never travel. Uncommitted edits ARE included (and
# git_commit marks the artifact "-dirty"), so a fix can be deployed before it is committed.
export_tree() {
  rm -rf "$2" && mkdir -p "$2"
  (cd "$REPO_ROOT/$1" && git ls-files -z --cached --others --exclude-standard \
     | while IFS= read -r -d '' f; do [ -e "$f" ] && printf '%s\0' "$f"; done \
     | tar --null -T - -cf -) | tar -xf - -C "$2"
}

assert_no_env_files() {
  local found; found=$(find "$1" \( -name '.env' -o -name '.env.*' \) ! -name '.env.example')
  [ -z "$found" ] || die "environment files in the bundle - refusing to publish: $found"
}

# ============================================================================================
# step: publish-desktop  - mirrors desktop/buildspec-source-zip.yml (run-from-source zip)
# ============================================================================================
step_publish_desktop() {
  local bucket v commit; bucket=$(desktop_bucket); v=$(pkg_version desktop)
  commit=$(git_commit desktop)
  log "publish desktop source zip $v -> s3://$bucket/desktop/"
  local stage="$BUILD_DIR/desktop-src" f
  export_tree desktop "$stage"
  rm -rf "$stage/.kiro" "$stage/.ash" "$stage/connect.json"
  find "$stage" \( -name '*.test.ts' -o -name '*.test.tsx' \) -delete
  for f in start.sh start.bat START-HERE.md package.json pnpm-lock.yaml .npmrc; do
    [ -e "$stage/$f" ] || die "$f missing from the desktop bundle"
  done
  assert_no_env_files "$stage"
  local zip="$BUILD_DIR/Praimana-$v-source.zip"
  rm -f "$zip"; (cd "$stage" && zip -qr "$zip" .)
  local meta sum; sum=$(sha256 "$zip")
  meta="version=$v,commit=$commit,signed=false,sha256=$sum,kind=source-zip"
  awsx s3 cp "$zip" "s3://$bucket/desktop/$v/desktop-$v-${commit:0:12}.zip" --only-show-errors --metadata "$meta"
  # The desktop service presigns the newest object under desktop/<platform>/ of DesktopBucket.
  for f in macos windows; do
    awsx s3 cp "$zip" "s3://$bucket/desktop/$f/Praimana-$v-source.zip" --only-show-errors --metadata "$meta"
  done
  info "published desktop $v ($(du -h "$zip" | cut -f1)) to desktop/{macos,windows}/"
}

# ============================================================================================
# application tiers
# ============================================================================================
step_kms() {
  cfn_deploy "$STACK_KMS" "$APP_DIR/platform-kms.yaml" \
    Environment="$ENVIRONMENT" KeyAdministratorArn="${KEY_ADMINISTRATOR_ARN:-}"
}

kms_arn() { out "$STACK_KMS" KmsKeyArn; }

step_dynamodb() {
  cfn_deploy "$STACK_DDB" "$APP_DIR/platform-dynamodb.yaml" \
    Environment="$ENVIRONMENT" KmsKeyArn="$(kms_arn)"
}

step_plumbing() {
  # Resource-bucket CORS limited to the portal origin rather than the template's "*".
  cfn_deploy "$STACK_PLUMBING" "$APP_DIR/platform-plumbing.yaml" \
    Environment="$ENVIRONMENT" KmsKeyArn="$(kms_arn)" ResourceCorsOrigin="$PORTAL_ORIGIN"
}

ses_enabled() { [ -n "${SES_IDENTITY_NAME:-}" ]; }
ses_existing() { ses_enabled && [ "${SES_USE_EXISTING_IDENTITY:-false}" = "true" ]; }

step_ses() {
  ses_enabled || { log "ses: SES_IDENTITY_NAME empty - skipping (no outbound email)"; return 0; }
  if ses_existing; then
    log "ses: using existing identity $SES_IDENTITY_NAME (SES tier not deployed)"
    assert_ses_verified; return 0
  fi
  cfn_deploy "$STACK_SES" "$APP_DIR/platform-ses.yaml" \
    Environment="$ENVIRONMENT" KmsKeyArn="$(kms_arn)" \
    IdentityType="$SES_IDENTITY_TYPE" IdentityName="$SES_IDENTITY_NAME"
  [ "$SES_IDENTITY_TYPE" = "EmailAddress" ] && info "click the SES verification link sent to $SES_IDENTITY_NAME"
  return 0
}

assert_ses_verified() {
  local s; s=$(awsx sesv2 get-email-identity --email-identity "$SES_IDENTITY_NAME" \
                 --query VerificationStatus 2>/dev/null || echo MISSING)
  [ "$s" = "SUCCESS" ] || die "SES identity $SES_IDENTITY_NAME is $s in this account/region.
       Verify it first (aws sesv2 create-email-identity --email-identity $SES_IDENTITY_NAME, then
       click the link), or set SES_USE_EXISTING_IDENTITY=false to let the SES tier create it."
  local prod; prod=$(awsx sesv2 get-account --query ProductionAccessEnabled)
  [ "$prod" = "True" ] || warn "SES is in the SANDBOX: every recipient must also be a verified identity"
  info "SES identity $SES_IDENTITY_NAME verified"
}

ses_email_from() {
  ses_enabled || return 0
  if ses_existing; then printf '%s' "$SES_IDENTITY_NAME"; else out "$STACK_SES" EmailFromHint; fi
}

ses_identity_arn() {
  ses_enabled || return 0
  if ses_existing; then
    printf 'arn:aws:ses:%s:%s:identity/%s' "$AWS_REGION" "$(account_id)" "$SES_IDENTITY_NAME"
  else
    out "$STACK_SES" IdentityArn
  fi
}

step_identity() {
  # An ADDRESS identity on the identity tier misconfigures the pool's SourceArn
  # (see platform-identity.yaml), so EmailFrom is only passed here for a Domain identity.
  local from=""
  ses_enabled && [ "$SES_IDENTITY_TYPE" = "Domain" ] && from=$(ses_email_from)
  cfn_deploy "$STACK_IDENTITY" "$APP_DIR/platform-identity.yaml" \
    Environment="$ENVIRONMENT" KmsKeyArn="$(kms_arn)" \
    CognitoCallbackUrls="$CALLBACK_URL" CognitoLogoutUrls="$LOGOUT_URL" \
    CognitoDomainPrefix="$COGNITO_DOMAIN_PREFIX" EmailFrom="$from" \
    EmailReplyTo="${SES_REPLY_TO:-}" LogRetentionInDays="$LOG_RETENTION_DAYS" \
    ServicesBucket="$(services_bucket)" ReleaseVersion="$RELEASE_VERSION"
}

# Applies twice on first create: InternalBaseUrl can only name the API after the API exists.
step_api() {
  local internal=""
  stack_exists "$STACK_API" && internal=$(out "$STACK_API" InternalBaseUrlForSecondPass)
  deploy_api "$internal"
  if [ -z "$internal" ]; then
    log "api second pass: InternalBaseUrl for east-west calls"
    deploy_api "$(out "$STACK_API" InternalBaseUrlForSecondPass)"
  fi
}

deploy_api() {
  local from="" ses_arn=""
  if ses_enabled; then from=$(ses_email_from); ses_arn=$(ses_identity_arn); fi
  cfn_deploy "$STACK_API" "$APP_DIR/platform-api.yaml" \
    Environment="$ENVIRONMENT" KmsKeyArn="$(kms_arn)" \
    ApiAllowedOrigins="$PORTAL_ORIGIN" PortalUrl="$PORTAL_ORIGIN" \
    CognitoDomainPrefix="$COGNITO_DOMAIN_PREFIX" InternalBaseUrl="$1" \
    EnableCustomDomain=true DomainName="$API_DOMAIN" AcmCertificateArn="$(cert_arn)" \
    ServicesBucket="$(services_bucket)" DesktopBucket="$(desktop_bucket)" ReleaseVersion="$RELEASE_VERSION" \
    EmailFrom="$from" EmailReplyTo="${SES_REPLY_TO:-}" SesIdentityArn="$ses_arn" \
    LogRetentionInDays="$LOG_RETENTION_DAYS" \
    UserPoolId="$(out "$STACK_IDENTITY" UserPoolId)" UserPoolClientId="$(out "$STACK_IDENTITY" UserPoolClientId)" \
    DeadLetterQueueArn="$(out "$STACK_PLUMBING" DeadLetterQueueArn)" \
    DocsBucketName="$(out "$STACK_PLUMBING" DocsBucketName)" \
    ResourcesBucketName="$(out "$STACK_PLUMBING" ResourcesBucketName)" \
    UsersTableStreamArn="$(out "$STACK_DDB" UsersTableStreamArn)"
}

step_portal() {
  cfn_deploy "$STACK_PORTAL" "$APP_DIR/platform-portal.yaml" \
    Environment="$ENVIRONMENT" KmsKeyArn="$(kms_arn)" \
    ApiId="$(out "$STACK_API" ApiId)" BackendDomainName="$API_DOMAIN" \
    UserPoolId="$(out "$STACK_IDENTITY" UserPoolId)" UserPoolClientId="$(out "$STACK_IDENTITY" UserPoolClientId)" \
    CognitoDomainPrefix="$COGNITO_DOMAIN_PREFIX" \
    PortalBucket="$(portal_bucket)" PortalReleaseVersion="$PORTAL_RELEASE_VERSION" \
    PortalDomainName="$PORTAL_DOMAIN" PortalCertificateArn="$(cert_arn)" \
    EnablePortalWaf="$ENABLE_PORTAL_WAF" \
    ResourcesBucketName="$(out "$STACK_PLUMBING" ResourcesBucketName)"
  local expected; expected=$(out "$STACK_PORTAL" CognitoCallbackUrlForIdentityTier)
  [ "$expected" = "$CALLBACK_URL" ] \
    || warn "portal expects callback $expected but identity has $CALLBACK_URL - fix and re-run identity"
}

step_portal_build() {
  local project id status; project=$(out "$STACK_PORTAL" PortalBuildProjectName)
  log "building the portal in-account (CodeBuild $project)"
  id=$(awsx codebuild start-build --project-name "$project" --query build.id)
  info "build $id"
  while :; do
    status=$(awsx codebuild batch-get-builds --ids "$id" --query 'builds[0].buildStatus')
    [ "$status" = "IN_PROGRESS" ] || break
    sleep "$POLL_SECONDS"
  done
  [ "$status" = "SUCCEEDED" ] || die "portal build $status - see CodeBuild logs for $id"
  info "portal build SUCCEEDED"
}

step_observability() {
  cfn_deploy "$STACK_OBS" "$APP_DIR/platform-observability.yaml" \
    Environment="$ENVIRONMENT" KmsKeyArn="$(kms_arn)" \
    AlertEmail="${ALERT_EMAIL:-}" EnableCanary="$ENABLE_CANARY" CanaryBaseUrl="" \
    ApiId="$(out "$STACK_API" ApiId)" \
    CanaryArtifactsBucketName="$(out "$STACK_PLUMBING" CanaryArtifactsBucketName)" \
    DeadLetterQueueName="$(out "$STACK_PLUMBING" DeadLetterQueueName)"
  [ -n "${ALERT_EMAIL:-}" ] && info "confirm the SNS subscription email sent to $ALERT_EMAIL"
  return 0
}

# ============================================================================================
# step: dns  - portal -> CloudFront, api -> API Gateway regional domain
# ============================================================================================
step_dns() {
  dns_sync
  # Only wait for names that have a record: the portal may not be deployed yet.
  [ -z "$(portal_target)" ] || wait_for_dns "$PORTAL_DOMAIN"
  [ -z "$(api_target)" ] || wait_for_dns "$API_DOMAIN"
}

wait_for_dns() {
  info "waiting for $1 to resolve..."
  until [ -n "$(dig +short "$1" | head -1)" ]; do sleep "$POLL_SECONDS"; done
  info "$1 -> $(dig +short "$1" | head -1)"
}

# ============================================================================================
# seed data  (infra/aws/app/README.md "Seed data", infra/ADMIN-SETUP.md)
# ============================================================================================
step_seed_formats() {
  log "seeding the format catalogue (praimana-formats)"
  local items='[["Accelerator","ACCELERATOR"],["Hackathon","HACKATHON"],["Program","PROGRAM"],["Workshop","WORKSHOP"]]'
  local req; req=$(jq -c '{"praimana-formats": [ .[] | {PutRequest:{Item:{
      category:{S:"workshop_format"}, name:{S:.[0]}, value:{S:.[1]}}}} ]}' <<< "$items")
  local left; left=$(awsx dynamodb batch-write-item --request-items "$req" --query 'length(UnprocessedItems)')
  [ "$left" = "0" ] || die "unprocessed items: $left - re-run seed-formats"
  info "formats: $(awsx dynamodb scan --table-name praimana-formats --query 'Items[].value.S' | tr '\t' ' ')"
}

step_seed_admin() {
  [ -n "${ADMIN_EMAIL:-}" ] || { log "seed-admin: ADMIN_EMAIL empty - skipping"; return 0; }
  log "bootstrapping first admin $ADMIN_EMAIL"
  local pool; pool=$(out "$STACK_IDENTITY" UserPoolId)
  seed_invitation
  if awsx cognito-idp admin-get-user --user-pool-id "$pool" --username "$ADMIN_EMAIL" >/dev/null 2>&1; then
    info "cognito user exists - not recreating"
  else
    awsx cognito-idp admin-create-user --user-pool-id "$pool" --username "$ADMIN_EMAIL" \
      --user-attributes Name=email,Value="$ADMIN_EMAIL" Name=email_verified,Value=true \
      --query User.UserStatus
  fi
  awsx cognito-idp admin-add-user-to-group --user-pool-id "$pool" --username "$ADMIN_EMAIL" --group-name ADMIN
  seed_profile "$pool"
  info "groups: $(awsx cognito-idp admin-list-groups-for-user --user-pool-id "$pool" \
                   --username "$ADMIN_EMAIL" --query 'Groups[].GroupName')"
}

seed_invitation() {
  local n; n=$(awsx dynamodb query --table-name praimana-invitations --index-name email-index \
    --key-condition-expression "email = :e" \
    --expression-attribute-values "$(jq -nc --arg e "$ADMIN_EMAIL" '{":e":{S:$e}}')" --query Count)
  [ "$n" != "0" ] && { info "invitation exists"; return 0; }
  awsx dynamodb put-item --table-name praimana-invitations --item "$(jq -nc --arg e "$ADMIN_EMAIL" \
    '{teamId:{S:"PLATFORM"},email:{S:$e},scope:{S:"PLATFORM"},platformRole:{S:"ADMIN"},status:{S:"PENDING"}}')"
  info "invitation seeded"
}

seed_profile() {
  local sub now; now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  sub=$(awsx cognito-idp admin-get-user --user-pool-id "$1" --username "$ADMIN_EMAIL" \
          --query "UserAttributes[?Name=='sub'].Value | [0]")
  local item; item=$(jq -nc --arg id "$sub" --arg e "$ADMIN_EMAIL" --arg t "$now" \
    '{id:{S:$id},email:{S:$e},role:{S:"ADMIN"},authProvider:{S:"COGNITO"},name:{S:$e},createdAt:{S:$t},updatedAt:{S:$t}}')
  if awsx dynamodb put-item --table-name praimana-users --item "$item" \
       --condition-expression "attribute_not_exists(id)" 2>/dev/null; then
    info "profile row written (id=$sub)"
  else
    info "profile row already exists (id=$sub)"
  fi
}

# ============================================================================================
# step: verify  - anonymous callers must be DENIED by the API; the portal must serve
# ============================================================================================
step_verify() {
  log "verify"
  local invoke; invoke=$(out "$STACK_API" ApiEndpoint)
  expect_status "$invoke/v1/auth/me" 401 "API (execute-api) rejects anonymous callers"
  expect_status "https://$API_DOMAIN/v1/auth/me" 401 "API ($API_DOMAIN) rejects anonymous callers"
  expect_status "$PORTAL_ORIGIN/login" 200 "portal serves the sign-in page"
  info "sign in at $PORTAL_ORIGIN with ${ADMIN_EMAIL:-<your admin>} to exercise Cognito end-to-end"
}

expect_status() {
  local got; got=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$1" || true)
  [ -n "$got" ] || got=000
  if [ "$got" = "$2" ]; then info "OK   $3 ($1 -> $got)"; return 0; fi
  warn "FAIL $3 ($1 -> $got, want $2)"
  # 000 = no connection: often a NEGATIVE DNS answer cached by this machine from before the
  # record existed. Retry via a public resolver so a stale local cache is not reported as an outage.
  [ "$got" = "000" ] || return 0
  local host ip; host=$(printf '%s' "$1" | sed -E 's#^https://([^/]+).*#\1#')
  ip=$(dig +short @8.8.8.8 "$host" | grep -E '^[0-9.]+$' | head -1)
  [ -n "$ip" ] || return 0
  got=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 --resolve "$host:443:$ip" "$1" || true)
  [ "$got" = "$2" ] && info "     ...but via public DNS it returns $got: flush this machine's DNS cache"
  return 0
}

# ============================================================================================
# driver
# ============================================================================================
step_status() {
  local s
  for s in $STACK_BUCKETS $STACK_KMS $STACK_DDB $STACK_PLUMBING $STACK_SES $STACK_IDENTITY \
           $STACK_API $STACK_PORTAL $STACK_OBS; do
    printf '    %-28s %s\n' "$s" "$(stack_status "$s")"
  done
}

step_config() {
  log "inputs ($CONFIG_FILE)"
  jq -r 'to_entries[] | .key as $s | .value | to_entries[] | "    \($s).\(.key) = \(.value)"' "$CONFIG_FILE"
}

usage() {
  cat <<EOF
Usage: $(basename "$0") [--config FILE] [--yes] [--non-interactive] <step> [<step> ...]

  --config FILE      JSON inputs file (default: infra/scripts/deploy-config.json).
                     Created if absent; missing inputs are prompted for and saved to it.
  --yes              do not ask for confirmation before 'all'
  --non-interactive  never prompt; fail if an input is missing

Steps, in order (all = every step):
$(echo $STEPS | tr ' ' '\n' | sed 's/^/  /')
Other: config (collect and show all inputs), status, help
EOF
}

run_step() {
  case "$1" in
    help|-h|--help) usage ;;
    status) step_status ;;
    config) step_config ;;
    *) echo " $STEPS " | tr '\n' ' ' | grep -q " $1 " || die "unknown step '$1' (try: help)"
       "step_$(echo "$1" | tr '-' '_')" ;;
  esac
}

main() {
  local steps=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --config) [ $# -ge 2 ] || die "--config needs a file"; CONFIG_FILE="$2"; shift 2 ;;
      --config=*) CONFIG_FILE="${1#--config=}"; shift ;;
      --yes|-y) AUTO_APPROVE=true; shift ;;
      --non-interactive) NON_INTERACTIVE=true; shift ;;
      help|-h|--help) usage; exit 0 ;;
      -*) die "unknown option $1 (try: help)" ;;
      *) steps+=("$1"); shift ;;
    esac
  done
  [ ${#steps[@]} -gt 0 ] || { usage; exit 1; }
  case "$CONFIG_FILE" in /*) ;; *) CONFIG_FILE="$PWD/$CONFIG_FILE" ;; esac
  load_config
  if [ "${steps[0]}" = "all" ]; then
    step_preflight
    confirm "Deploy Praimana to account $(account_id) ($AWS_REGION)?"
    local s; for s in $STEPS; do [ "$s" = preflight ] || run_step "$s"; done
    step_status
  else
    local s; for s in "${steps[@]}"; do run_step "$s"; done
  fi
}

main "$@"
