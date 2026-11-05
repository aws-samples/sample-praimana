# Praimana — Setup Guide

This guide takes you from an empty AWS account to a running Praimana platform. It is the
exact sequence used to stand up the reference deployment, including the gotchas that are easy
to hit.

There are **two phases**:

1. **CI/CD + buckets** (the supply chain) — a one-time bootstrap that creates the pipelines
   and the S3 buckets the application is delivered through, then publishes the build artifacts
   (service Lambda zips, portal bundle, desktop zip).
2. **The application** — deploy the running platform (DynamoDB, Cognito, the API + 13 service
   Lambdas, the portal, observability) from those published artifacts.

If the artifacts are already published (buckets populated), skip to [Phase 2](#phase-2--deploy-the-application).

> **Scripted alternative.** [`scripts/deploy.sh`](scripts/deploy.sh) runs this whole guide step by
> step, tier by tier, and can be re-run safely: ACM certificate, buckets, artifact publishing, all
> application tiers, both second passes, DNS, seed data and verification. It also wires the
> API's custom domain, which the `platform.yaml` master does not pass through. All user inputs
> come from a JSON file passed with `--config` (see `scripts/deploy-config.example.json`; the
> default `scripts/deploy-config.json` is git-ignored). Any input missing from the file is
> prompted for and saved back to it. Run
> `./infra/scripts/deploy.sh --config my-config.json all`, or `./infra/scripts/deploy.sh help`
> to see the individual steps.

---

## Prerequisites

- An AWS account and credentials with administrative access to it (CloudFormation, IAM, S3,
  KMS, DynamoDB, Cognito, Lambda, API Gateway, CloudFront, CodePipeline/CodeBuild,
  CodeConnections, SNS, SQS, CloudWatch).
- The AWS CLI v2, authenticated to that account. All commands below use `--region us-east-1`;
  change it consistently if you deploy elsewhere.
- **A domain name for the portal and an ACM certificate for it in `us-east-1`** (required, in
  `us-east-1` whatever region you deploy to, because CloudFront reads certificates only from
  there). The portal is served only on this hostname, which is what lets CloudFront enforce
  TLSv1.2_2021; the default `*.cloudfront.net` certificate is fixed at TLSv1. Request the
  certificate with DNS validation and wait for it to be **Issued** before Phase 2:

  ```bash
  aws acm request-certificate --region us-east-1 \
    --domain-name portal.example.com --validation-method DNS
  # create the CNAME shown by describe-certificate, then wait:
  aws acm wait certificate-validated --region us-east-1 --certificate-arn <arn>
  ```
- A GitHub organisation/repos holding the source: `infra` (this repo), `services`, `portal`,
  and `desktop`. The pipelines pull from GitHub via an AWS CodeConnections connection.
- A **staging S3 bucket** in the same account/region for `aws cloudformation deploy` to upload
  templates that exceed the 51,200-byte inline limit (several do). Any bucket works; the CI/CD
  artifact bucket created in Phase 1 is a convenient choice.

> **Account-id and region consistency.** Pick one region and use it everywhere. The IAM
> policies scope to `${AWS::Region}`, so a mismatch fails silently.

---

## Phase 1 — CI/CD and the supply-chain buckets

> **The CI/CD pipeline templates are not included in this sample.** The DevOps-account
> foundation stack, the bucket pipeline, and the four publish pipelines referenced in this
> phase were part of a separate CI/CD setup that is not shipped here. This phase documents what
> that pipeline did so you understand the supply-chain model; to stand the platform up from this
> sample, deploy the shared stacks under `infra/aws/shared/` directly (shown inline below) and
> publish artifacts by hand. The deployable templates for the application itself are the per-tier
> files under `infra/aws/app/` (Phase 2).

### 1.1 Foundation (artifact bucket, KMS key, GitHub connection, SSM params)

In the original setup a foundation stack created the artifact bucket, a KMS key, the GitHub
connection, and the SSM parameters. That foundation template is not included in this sample. If
you are reproducing the pipeline yourself, the foundation produced three values the later steps
consume — `ArtifactBucketNameOut`, `ArtifactKeyArn`, and `ConnectionArn`. Otherwise, provide your
own artifact bucket and (for a GitHub-connected pipeline) a CodeConnections connection ARN.

### 1.2 Authorize the GitHub connection

The connection is created **PENDING**. In the console: **Developer Tools → Settings →
Connections →** select it **→ Update pending connection**, install the AWS Connector for
GitHub into your org, and grant it access to `infra`, `services`, `portal`, `desktop`.
Confirm it is `AVAILABLE`:

```bash
aws codeconnections get-connection --connection-arn <ConnectionArn> --region us-east-1 \
  --query 'Connection.ConnectionStatus' --output text   # want: AVAILABLE
```

### 1.3 The platform buckets

The original bucket pipeline deployed the five platform buckets through a change set with an
approval gate. That pipeline template is not included in this sample, so deploy the shipped
buckets template (`infra/aws/shared/platform-buckets.yaml`) directly instead.

> **`BucketNameSuffix` is required and must be a stable random hash** (e.g. `-ab12cd34`). It is
> appended to every bucket name so the global S3 namespace cannot collide and the account id is
> not leaked. **Generate it once and never change it** — changing it renames (replaces) every
> bucket. Pass the *same* value here and to the app later.

```bash
HASH="-$(python3 -c 'import secrets;print(secrets.token_hex(4))')"   # keep this value!
echo "BucketNameSuffix=$HASH"

aws cloudformation deploy \
  --template-file infra/aws/shared/platform-buckets.yaml \
  --stack-name praimana-platform-buckets --region us-east-1 \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    Environment=prod \
    'CustomerPrincipals=arn:aws:iam::<ACCOUNT_ID>:root' \
    'CicdPrincipals=arn:aws:iam::<ACCOUNT_ID>:root' \
    BucketNameSuffix=$HASH
```

Put the principal(s) that will read and publish artifacts (in a single account, your deploy role
or account root ARN) into `CustomerPrincipals` and `CicdPrincipals`. The original pipeline
re-ran this stack a second time with delete protection enabled once the first deploy settled;
if you want the bucket-deletion guard locked in, deploy once, then deploy again after the first
run settles (a first-run rollback must not meet that guard).

Your buckets are now `praimana-services<HASH>`, `praimana-artifacts<HASH>`,
`praimana-desktop<HASH>`, `praimana-portal<HASH>`, `praimana-cf-template<HASH>`.

### 1.4 Publish the artifacts

The four publish pipelines (services, portal, desktop, template) are part of the CI/CD setup and
are **not included in this sample**. In the original setup each was an `aws cloudformation deploy`
of a pipeline template that built the artifact and uploaded it; the build roles were added to
`CicdPrincipals` and the buckets stack re-run so the bucket policies granted them upload. Without
those pipelines, build each artifact from its source repo and upload it directly to the matching
bucket (`...<HASH>`) with `aws s3 cp`, using a principal that is in `CicdPrincipals`. What each
publishes and where:

- **services** → publishes `lambda/v<version>/<svc>/<svc>.zip` to the services bucket.
- **portal** → publishes `portal/<version>/portal-<version>.zip` to the portal bucket.
- **desktop** (optional) → the source zip (with `start.sh`) that users download and run locally.
- **template** → publishes the app tier templates to the CloudFormation template
  bucket (or stage them by hand, see Phase 2.0).

> The build pipelines enforced a dependency-vulnerability gate (`pnpm audit`). When building the
> artifacts yourself, run the same audit and fix any flagged dependency in the source repo before
> publishing.

Note the published versions — you pass them to the app in Phase 2. In the reference deployment
they were services `1.0.0` and portal `1.0.0`.

---

## Phase 2 — Deploy the application

The application is eight tiers (KMS, DynamoDB, plumbing, SES, Cognito identity, API, portal,
observability). You can deploy them **all at once** with the master template
`aws/app/platform.yaml`, or **tier by tier**. The master is a two-apply deploy (the Cognito
callback cycle makes a single apply impossible — see below).

### 2.0 Publish the tier templates to the CloudFormation template bucket

The master references each tier by S3 URL, so the tier templates must be in the CloudFormation
template bucket that the bucket stack created in Phase 1. Its name is the `CfTemplateBucketNameOut`
output of `infra/aws/shared/platform-buckets.yaml` (export `<stack-name>-cf-template-bucket-name`).
Read it from the export rather than typing it, then publish the templates there:

```bash
CF_TEMPLATE_BUCKET=$(aws cloudformation list-exports --region us-east-1 \
  --query "Exports[?Name=='praimana-platform-buckets-cf-template-bucket-name'].Value" \
  --output text)
for t in kms dynamodb plumbing ses identity api portal observability; do
  aws s3 cp infra/aws/app/platform-$t.yaml \
    "s3://$CF_TEMPLATE_BUCKET/templates/platform-$t.yaml" --region us-east-1
done
```

### 2.1 ⚠ Clean any orphaned app resources first (only if a prior deploy failed)

The app's data resources are `DeletionPolicy: Retain`. If a previous deploy **failed and rolled
back**, the resources from the tiers that *did* progress are **left behind**, and AWS's Early
Validation `ResourceExistenceCheck` hook will block the next deploy with a confusing
`[AWS::EarlyValidation::ResourceExistenceCheck]` error. A fresh account has none of this; skip
this step.

To check for and remove orphans (verify each is empty first — do not delete anything holding
real data):

```bash
# DynamoDB tables
aws dynamodb list-tables --region us-east-1 \
  --query 'TableNames[?starts_with(@,`praimana-`)]' --output text
# For each: confirm it is empty, then delete
aws dynamodb scan --table-name <table> --select COUNT --max-items 1 --query Count --output text
aws dynamodb delete-table --table-name <table> --region us-east-1

# App S3 buckets (docs/resources/canary/logs - NOT the ...<HASH> supply-chain buckets)
aws s3 ls | grep praimana | grep -v '<HASH>'      # inspect, then delete the empty ones

# SQS DLQ, and CloudWatch log groups under /praimana and /aws/lambda/praimana*
aws sqs delete-queue --queue-url <praimana-dlq-url> --region us-east-1
aws logs delete-log-group --log-group-name /praimana/cognito-presignup --region us-east-1
aws logs delete-log-group --log-group-name /praimana/cognito-postconfirmation --region us-east-1
```

> SQS enforces a ~60-second name-reuse cooldown after deleting a queue. Wait it out before
> redeploying.

### 2.2 Make the deploying principal a bucket reader

CloudFormation fetches each Lambda `CodeUri` and the portal source zip with **your** deploy
credentials. The deploying principal must be in the services and portal buckets'
`CustomerPrincipals` reader list, or tiers 4/5/6 fail with an opaque S3 `AccessDenied`. The
Phase-1 default `CustomerPrincipals=arn:aws:iam::<account>:root` covers any in-account role; if
you scoped it tighter, add your deploy role and re-run the bucket pipeline.

### 2.3 Apply 1 — deploy all tiers (one command)

```bash
aws cloudformation deploy \
  --template-file infra/aws/app/platform.yaml \
  --stack-name praimana-app --region us-east-1 \
  --s3-bucket <staging-bucket> --s3-prefix cfn-app-staging \
  --capabilities CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND CAPABILITY_IAM \
  --parameter-overrides \
    Environment=prod \
    TemplateBucket="$CF_TEMPLATE_BUCKET" \
    SesIdentityName= \
    ApiAllowedOrigins=https://example.invalid \
    CognitoDomainPrefix=<your-unique-prefix> \
    PortalDomainName=portal.example.com \
    PortalCertificateArn=<issued-acm-certificate-arn-in-us-east-1> \
    AlertEmail=<you@example.com> \
    ServicesBucket=praimana-services<HASH> ReleaseVersion=<services-version> \
    PortalBucket=praimana-portal<HASH> PortalReleaseVersion=<portal-version>
```

Notes on the inputs:

- **`SesIdentityName=` (empty) skips SES.** The app works fully without it — the notify service
  falls back to a console transport (no outbound email) and email-OTP MFA is off. To enable real
  email, set `SesIdentityType=EmailAddress SesIdentityName=you@example.com` (a verification
  email is sent) or a `Domain` identity (publish the DKIM DNS records the SES tier outputs).
  **SES refuses identities for domains it protects (e.g. `amazon.com`)** — use a domain/mailbox
  you control.
- **`ApiAllowedOrigins` and the Cognito callback URLs are placeholders on apply 1** in the command
  above. Because the portal hostname is now fixed by `PortalDomainName`, you can instead set
  `ApiAllowedOrigins=https://portal.example.com`,
  `CognitoCallbackUrls=https://portal.example.com/api/auth/callback/cognito` and
  `CognitoLogoutUrls=https://portal.example.com/login` on apply 1. Apply 2 is still needed for
  `ApiInternalBaseUrl`.
- **`CognitoDomainPrefix` is required** and becomes the sign-in host
  `<prefix>.auth.<region>.amazoncognito.com`. It is globally unique across all AWS accounts, so
  pick your own value (lowercase letters, digits, dashes; it must not contain `aws`, `amazon` or
  `cognito`). There is no account-id fallback, so the account id never appears in a public URL.
  Keep it the same on apply 2.
- **Bucket names need no input.** The plumbing and portal tiers suffix their bucket names with
  part of their own stack id, so names are unique without exposing the account id.
- **`PortalDomainName` and `PortalCertificateArn` are required.** The certificate must be issued,
  in `us-east-1`, and cover the hostname. There is no `*.cloudfront.net`-only mode.
- **No session secret to supply.** The portal tier generates `NEXTAUTH_SECRET` in AWS Secrets
  Manager (output `PortalSessionSecretArn`); the portal function reads it at cold start. See
  "Secret management" in `portal/README.md` for rotation.

CloudFront takes 10–15 minutes, so apply 1 runs ~20–25 minutes. When it finishes, read:

```bash
aws cloudformation describe-stacks --stack-name praimana-app --region us-east-1 \
  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output table
```

You need `PortalUrlOut`, `PortalDistributionDomainName`, `PortalCallbackUrlForSecondApply`,
`ApiInternalBaseUrlForSecondApply`, and `PortalBuildProjectName`.

Then create the DNS record for the portal: in Route 53 an **alias A/AAAA record** from
`PortalDomainName` to `PortalDistributionDomainName`, or a **CNAME** at another DNS provider. The
portal does not resolve until this record exists.

### 2.4 Build the portal

The portal Lambda is empty until the bundle is built in-account:

```bash
aws codebuild start-build --project-name <PortalBuildProjectName> --region us-east-1
# wait for buildStatus SUCCEEDED
aws codebuild batch-get-builds --ids <build-id> --region us-east-1 \
  --query 'builds[0].buildStatus' --output text
```

### 2.5 Apply 2 — close the Cognito cycle and enable east-west calls

Re-run the **same** command as 2.3, changing three parameters to the real values from apply 1's
outputs (everything else stays identical). Only the identity and API tiers change:

```bash
  ...
    ApiAllowedOrigins=<PortalUrlOut> \
    CognitoCallbackUrls=<PortalCallbackUrlForSecondApply> \
    CognitoLogoutUrls=<PortalUrlOut>/login \
    ApiInternalBaseUrl=<ApiInternalBaseUrlForSecondApply> \
  ...
```

Until apply 2, interactive sign-in returns `redirect_mismatch` — expected, not a fault.

### 2.6 Seed data (two steps CloudFormation cannot do)

These are DynamoDB writes, so they are not part of any stack:

1. **Create the first admin** — see [`ADMIN-SETUP.md`](ADMIN-SETUP.md) (the step-by-step
   bootstrap; the same procedure is summarised in the header of `aws/app/platform-identity.yaml`).
2. **Seed the format catalogue** — see `aws/app/README.md`.

### 2.7 Verify

```bash
API=https://<ApiId>.execute-api.us-east-1.amazonaws.com
curl -s -o /dev/null -w '%{http_code}\n' "$API/v1/auth/me"     # 401 = API + JWT authorizer live
curl -s -o /dev/null -w '%{http_code}\n' "<PortalUrlOut>"       # 200 = portal serving
```

A `401` from the API (authorizer rejecting an unauthenticated call) and a `200` from the portal
mean the platform is up. Sign in through the portal to exercise Cognito end-to-end.

---

## Tier-by-tier alternative

If you prefer to deploy the app one stack at a time (surgical changes, or to isolate a failure),
deploy in this order, threading each tier's outputs into the next tier's parameters:

```
kms → dynamodb → plumbing → [ses] → identity → api → portal → observability
```

`aws/app/README.md` carries the full output→parameter wiring table. Each tier is an
`aws cloudformation deploy` of `aws/app/platform-<tier>.yaml`; tiers 1/4/5/6/7 exceed the inline
limit so pass `--s3-bucket <staging>`, and tiers 4/5 are SAM templates so add
`CAPABILITY_AUTO_EXPAND`. Run the portal build (2.4) and the identity/api second passes (2.5)
the same way. This is exactly what the master automates.

---

## Reference deployment values

The reference stand-up used:

| Thing | Value |
|---|---|
| Region | us-east-1 |
| Services version | 1.0.0 |
| Portal version | 1.0.0 |
| SES | enabled — `EmailFrom` set to a verified SES identity on the API tier (sandbox) |
| Portal URL | a custom domain (`PortalDomainName`) with an ACM certificate in `us-east-1` |

Replace the bucket suffix, versions, email, and origins with your own.

---

## What can go wrong (seen in practice)

| Symptom | Cause | Fix |
|---|---|---|
| `[AWS::EarlyValidation::ResourceExistenceCheck]` at change-set creation | Orphaned Retain resources from a prior failed deploy | Clean them (step 2.1) |
| `Email verification denied` on the SES tier | SES refuses the domain (e.g. `amazon.com`) | Use a domain/mailbox you control, or skip SES (`SesIdentityName=`) |
| First S3 `AccessDenied` fetching a Lambda `CodeUri` | Deploy principal not in the bucket's `CustomerPrincipals` | Add it, re-run the bucket pipeline (step 2.2) |
| Sign-in returns `redirect_mismatch` | Apply 2 not done | Run step 2.5 |
| Portal serves a blank/500 | Portal build not run | Run step 2.4 |
| `ROLLBACK_COMPLETE ... can not be updated` | A failed create left the stack in a dead state | `aws cloudformation delete-stack` it, then redeploy |
| Published version serves old code silently | A stale `ReleaseVersion`/`PortalReleaseVersion` | Pass the version you actually published; verify the key exists in the bucket |
| An invitation is accepted by the portal but no email ever arrives | SES was skipped (`EmailFrom=""`), so the notify service used the **console transport** and silently dropped the mail. Cognito's own email is `MessageAction: SUPPRESS`ed on this path, so there is no fallback | Configure SES (below), then re-send the invite |

### Invitation emails silently dropped (SES not configured)

The invite flow is: store the invitation row → `AdminCreateUser` → `POST /v1/notify/registration-invite`
(a branded email carrying the temporary password). Every `AdminCreateUser` call passes
`MessageAction: SUPPRESS`, so **Cognito never sends anything on this path** — the branded notify
email is the only email. When `EmailFrom` is empty the notify service's composition root selects the
**console transport**, which logs `[notify] (console transport — NOT SENT) → <domain>` and returns
`{sent, via:"console"}`. The account is created and the role is correct, but no mail is sent — which
looks exactly like "the invitation wasn't sent".

To turn real email on for an already-running deployment (what was done here), set `EmailFrom` on the
**API tier** (it owns the `praimana-notify` Lambda and its `NotifySesSend` IAM grant, which is gated
on a non-empty `EmailFrom`):

```bash
# EmailFrom must be an SES identity verified in this account+region.
# ⚠ Set EmailFrom on the IDENTITY tier only when the identity is a DOMAIN — an
#   address identity misconfigures the Cognito UserPool SourceArn (see platform-identity.yaml).
aws cloudformation update-stack --stack-name praimana-api --region us-east-1 \
  --use-previous-template \
  --parameters \
    ParameterKey=EmailFrom,ParameterValue=you@verified.example \
    ParameterKey=EmailReplyTo,ParameterValue=you@verified.example \
    $(for k in <every-other-parameter-key>; do echo ParameterKey=$k,UsePreviousValue=true; done) \
  --capabilities CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND
```

SES starts in the **sandbox** (200 sends/day, rate 1/s): the **sender and every recipient** must be
a verified identity until you request production access. Verify an address with
`aws sesv2 create-email-identity --email-identity you@verified.example` and click the link.

Re-send a dropped invitation (idempotent — `/v1/user-access/provision` treats an existing account as
`alreadyExisted` and regenerates the temporary password): from the portal's admin UI, invite the
address again. The invitation row must still be live (`status=PENDING` and not past `expiresAt`); if
it has expired, re-issue it first.
