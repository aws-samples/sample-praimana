# `aws/app/` — the platform as eight tier templates, one account

The Praimana application deploys into a **single account** as **eight tiers** (a KMS tier plus
the seven below), one stack per tier.

Two ways to deploy:

- **One deploy (recommended for a fresh account):** [`platform.yaml`](platform.yaml) is a
  nested-stack **master** that deploys all eight tiers in one `aws cloudformation deploy`,
  wiring each tier's parameters from the previous tiers' outputs automatically. It references
  the tier templates by S3 URL (publish them to the CloudFormation template bucket first — see step 2.0
  of [`infra/SETUP.md`](../../SETUP.md)). It is a
  **two-apply** deploy — the Cognito callback cycle (below) makes a single apply impossible —
  but it collapses eight hand-ordered deploys into two runs of the same command. See the
  header of `platform.yaml` for the exact flow.
- **Tier by tier (for surgical changes / understanding):** deploy the templates individually in
  the order below. This is what the rest of this README documents.

There is no flat all-in-one template (the former `platform-all-in-one.yaml` was split into
these tiers): a 373 KiB single stack made every change a whole-platform change, and it
re-introduced an intra-stack Cognito cycle. The master above gets the one-command experience
without those costs by using nested stacks.

Nothing here uses `Fn::ImportValue`. Tiers hand values to each other as **parameters**, read
from the previous stack's **outputs** — so a customer can deploy them one at a time, in any
tooling, and see exactly what each tier is being told. (The master uses the same outputs via
`!GetAtt NestedStack.Outputs.X`.)

| # | Template | Size | Creates |
|---|---|---|---|
| 0 | [`platform-kms.yaml`](platform-kms.yaml) | 6 KiB | Customer-managed KMS key every tier encrypts with |
| 1 | [`platform-dynamodb.yaml`](platform-dynamodb.yaml) | 49 KiB | 35 DynamoDB tables |
| 2 | [`platform-plumbing.yaml`](platform-plumbing.yaml) | 16 KiB | EventBridge bus, DLQ, docs + workshop-resources + access-log + canary-artifact buckets |
| 3 | [`platform-ses.yaml`](platform-ses.yaml) | 7 KiB | SES identity, configuration set, delivery-event topic |
| 4 | [`platform-identity.yaml`](platform-identity.yaml) | 20 KiB | Cognito user pool, app client, Hosted UI domain, pre-signup/post-confirmation triggers |
| 5 | [`platform-api.yaml`](platform-api.yaml) | 108 KiB | 13 service Lambdas, the HTTP API and its JWT authorizer, EventBridge rules, the users-stream mapping |
| 6 | [`platform-portal.yaml`](platform-portal.yaml) | 52 KiB | Portal Lambda (Web Adapter), its own HTTP API, CloudFront distribution, static + bundle + access-log buckets, CodeBuild project |
| 7 | [`platform-observability.yaml`](platform-observability.yaml) | 56 KiB | 12 alarms, dashboard, canary, alerts topic |

The plumbing buckets (when `BucketSuffix` is left empty) and the portal buckets are named from
the last 12 hex characters of their own stack's id — no account id appears in any bucket name.

Sibling folder [`aws/shared/`](../shared/README.md) holds the supply-chain buckets (the five
platform buckets plus their access-log bucket). This folder holds the application stacks. Same
account, different lifecycle.

## Deploy order, and which output feeds which parameter

Deploy in this order. Each row's parameters come from stacks already deployed above it, so
nothing here is guesswork — the value is in the previous stack's `Outputs`.

| Order | Stack | Parameters it needs | Where the value comes from |
|---|---|---|---|
| 0 | `praimana-kms` | `Environment` | you |
| 1–7 | every tier below | `KmsKeyArn` | tier 0 output |
| 1 | `praimana-dynamodb` | `Environment` | you |
| 2 | `praimana-plumbing` | `Environment` | you |
| 3 | `praimana-ses` (optional) | `IdentityType`, `IdentityName`, `Environment` | you (`EmailAddress`/`Domain`, then the address or domain) |
| 4 | `praimana-identity` | `Environment`, `CognitoCallbackUrls`, `CognitoLogoutUrls` | you — **placeholder on the first pass**, see below |
| | | `CognitoDomainPrefix` | you — required, globally unique hosted-UI prefix; pass the same value to tiers 5 and 6 |
| | | `ServicesBucket`, `ReleaseVersion` | you — your suffixed services bucket and the release to deploy, [see below](#-read-this-before-your-first-deploy) |
| 5 | `praimana-api` | `ApiAllowedOrigins`, `CognitoDomainPrefix` | you |
| | | `ServicesBucket`, `DesktopBucket`, `ReleaseVersion` | you — your suffixed services and artifacts buckets, same release as tier 4 |
| | | `DesktopBucketOwnerAccountId` | you — only if `DesktopBucket` is in another account; empty means this account |
| | | `UserPoolId`, `UserPoolClientId` | tier 4 outputs |
| | | `DeadLetterQueueArn`, `DocsBucketName`, `ResourcesBucketName` | tier 2 outputs (`ResourcesBucketName` may be left empty: no resource storage) |
| | | `UsersTableStreamArn` | tier 1 output |
| 6 | `praimana-portal` | `Environment`, `CognitoDomainPrefix` | you |
| | | `PortalDomainName`, `PortalCertificateArn` | you — required: the portal hostname and an issued ACM certificate for it in `us-east-1`. Afterwards, point the hostname's DNS at the `PortalDistributionDomainName` output |
| | | `PortalBucket`, `PortalReleaseVersion` | you — your suffixed portal bucket and the portal release |
| | | `ApiId` | tier 5 output |
| | | `UserPoolId`, `UserPoolClientId` | tier 4 outputs |
| | | `ResourcesBucketName` | tier 2 output (optional, same value as tier 5) |
| 7 | `praimana-observability` | `Environment`, `AlertEmail`, `CanaryBaseUrl` | you |
| | | `ApiId` | tier 5 output |
| | | `CanaryArtifactsBucketName`, `DeadLetterQueueName` | tier 2 outputs |

Then **two second passes and two seeding steps**, none of which are optional on a fresh
account:

| Step | Do |
|---|---|
| 8 | Re-deploy tier 4 with `CognitoCallbackUrls` / `CognitoLogoutUrls` containing the real portal URL — tier 6 emits `CognitoCallbackUrlForIdentityTier` ready to paste |
| 9 | Re-deploy tier 5 with `InternalBaseUrl` set from tier 5's own `InternalBaseUrlForSecondPass` output |
| 10 | Create the first admin — [see below](#the-first-admin) |
| 11 | Seed the format catalogue — [see below](#seed-data) |

### Why tiers 4 and 6 are a cycle

Cognito matches callback URLs **exactly**, and the portal's CloudFront domain does not exist
until the portal stack does — but the portal needs the user pool to exist before it can be
configured against it. Something has to go first, so identity does, with a placeholder:

```bash
# first pass — any syntactically valid https URL; it is replaced in step 8
CognitoCallbackUrls=https://example.invalid/api/auth/callback/cognito
CognitoLogoutUrls=https://example.invalid/login
```

Until step 8 runs, sign-in fails with `redirect_mismatch`. That is the expected state between
step 4 and step 8, not a fault.

### Capabilities and the inline size limit

```bash
aws cloudformation deploy \
  --template-file platform-<tier>.yaml \
  --stack-name praimana-<tier> \
  --capabilities CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND \
  --s3-bucket <a-bucket-you-own-in-this-region> \
  --profile <app-profile> --region us-east-1 \
  --parameter-overrides Environment=dev ...
```

Two things that will stop a deploy dead, both easy to mistake for a template bug:

- **`--s3-bucket` is required for tiers 5, 6 and 7.** `platform-api.yaml` (108 KiB),
  `platform-portal.yaml` (52 KiB) and `platform-observability.yaml` (56 KiB) are over
  CloudFormation's **51,200-byte inline limit**, so they must be uploaded rather than passed in
  the request. Without the flag the CLI tries inline and fails with `Member must have length
  less than or equal to 51200`, which does not mention the template's size. The others fit
  inline (`platform-dynamodb.yaml`, at 49 KiB, only just). Passing `--s3-bucket` for all seven
  of tiers 1–7 is simpler and harmless (tier 0, KMS, is 6 KiB and always fits inline).
- **`CAPABILITY_AUTO_EXPAND` is required for tiers 4 and 5**, which carry
  `Transform: AWS::Serverless-2016-10-31`; **`CAPABILITY_NAMED_IAM`** for tiers 5 and 7, which
  create roles with explicit names, and at least `CAPABILITY_IAM` for tiers 4 and 6, which create
  unnamed roles. Passing both `CAPABILITY_NAMED_IAM` and `CAPABILITY_AUTO_EXPAND` for all of
  tiers 1–7 is a harmless superset and one less thing to get wrong per tier (tier 0, KMS, needs
  neither).

## ⚠ Read this before your first deploy

**1. The deploying principal must be in the services bucket's reader list.** Every function's
`CodeUri` is

```yaml
CodeUri:
  Bucket: !Ref ServicesBucket          # praimana-services<BucketNameSuffix>
  Key: !Sub "lambda/v${ReleaseVersion}/<svc>/<svc>.zip"
```

CloudFormation fetches that with the **deploying** principal's credentials, and the bucket
policy grants read only to the principals in its `CustomerPrincipals` list. A principal that is
neither on that list nor granted `s3:GetObject` by its own identity policy fails on the first
function with an S3 `AccessDenied` that does not mention the bucket policy. Before deploying,
make sure the deploy role is in `CustomerPrincipals`.

> **Note:** The CI/CD pipeline templates that originally managed this list (the DevOps
> foundation and bucket pipelines) are not included in this sample. Set `CustomerPrincipals`
> directly when you deploy the shared bucket stack (`infra/aws/shared/platform-buckets.yaml`),
> adding the deploy role ARN to the existing reader list:

```bash
# add the deploy role to the EXISTING reader list when deploying the buckets stack
aws cloudformation deploy --template-file platform-buckets.yaml \
  --stack-name praimana-platform-buckets --profile <account-profile> --region us-east-1 \
  --parameter-overrides ... \
    'CustomerPrincipals=<existing readers>,<the deploy role ARN>'
```

Read the current value before overwriting it — this parameter is the whole reader list, not an
append, and CloudFormation owns it, so an out-of-band edit is reverted on the next deploy. The
same applies to `PortalBucket`, which the portal tier's CodeBuild project reads the source zip
from.

**2. `ReleaseVersion` must name artifacts that exist.** It is bare semver (no leading `v`) and
defaults to `1.0.0`; the template adds the `v` in the S3 key itself. Check first:

```bash
aws s3 ls s3://praimana-services<BucketNameSuffix>/lambda/v1.0.0/ --profile <account-profile>
```

A version whose artifacts are missing fails the deploy. Worse — and this has happened — a
**stale** version deploys *successfully* and serves older code, because old artifacts are still
in the bucket. A default that drifts behind the published release produces exactly that, with
every deploy still working. Treat it as a release decision, not a default to inherit.

`ServicesBucket` (tiers 4, 5), `DesktopBucket` (tier 5) and `PortalBucket` (tier 6) have **no
default**: the shared stack appends the required `BucketNameSuffix` to every bucket name, so an
unsuffixed default (`praimana-services` etc.) would never name a real bucket. Pass your real,
suffixed names.

`DesktopBucketOwnerAccountId` (tier 5, and the master) is the 12-digit account that owns
`DesktopBucket`. The desktop function sends it as `ExpectedBucketOwner` on every installer request
and presigned download, and the docs function does the same with this account's ID, so S3 refuses
the request if any other account owns a bucket by that name. Leave it empty when the bucket stack
is in this account, which is the single-account layout this guide deploys.

**3. Values you must supply.** These parameters have **no default at all**, so the deploy fails
until you choose. They used to default to one specific deployment's values, which is the wrong
shape for templates published for other accounts to deploy unmodified: a permissive or foreign
default is not a local convenience, it is the posture every deployment that does not know to
override it inherits.

| Parameter | Tier | What to provide | Why there is no default |
|---|---|---|---|
| `ApiAllowedOrigins` | 5 | The web origin(s) permitted to call the API cross-origin — normally just your portal's origin | It defaulted to `*`, and CORS is configured on the API rather than per route, so one value covered every `/v1/*` route including the admin and user-access surfaces. Any page on the internet could then call the API with a stolen bearer and read the reply. `*` is still expressible for a genuinely public API, but it now has to be typed out |
| `CognitoCallbackUrls` | 4 | Your portal's sign-in callback path | A registered callback URL is where Cognito is willing to **send an authorization code**. The old defaults left another deployment's host registered in *your* user pool, and the client is public, so an intercepted code converts into a user's tokens — and group membership in those tokens is the sole source of platform role, admin included |
| `CognitoLogoutUrls` | 4 | Your portal's post-sign-out path | Same reason |
| `IdentityType`, `IdentityName` | 3 | `EmailAddress` or `Domain`, and the address/domain to verify | Nothing sensible to guess, and a wrong value silently sends no mail |
| `CognitoDomainPrefix` | 4, 5, 6 | Your own globally unique Hosted UI prefix, the same value on all three tiers | Hosted UI domains are global, and there is deliberately no account-id fallback, which would publish the account id in a public URL |
| `Environment` | 0–4, 6, 7 | `dev` / `test` / `staging` / `prod` / `shared` | Tags read it, and it is required rather than defaulted so a production stack cannot inherit `dev` by omission. (On tier 5 it is optional and only tags.) |

All the URL lists are comma-delimited; a multi-entry `ParameterValue` needs its commas escaped
(`ParameterValue="first\,second"`) or the CLI reads them as separate arguments.

⚠ **Loopback redirect URIs.** Registering a `http://localhost` callback on the production app
client lets any local process able to bind that port receive a redeemable code over a cleartext
listener. There is currently **one** app client, so a loopback entry cannot be scoped away from
the browser flow — including it is a decision to accept that, and the remaining half of the fix
is to give the desktop flow its own `UserPoolClient`. A note in `platform-identity.yaml` marks
the spot.

Everything else keeps a default, but several are empty and mean a feature is inert:

| Parameter | Tier | Default | Why it needs changing |
|---|---|---|---|
| `InternalBaseUrl` | 5 | empty | Two-pass — see [below](#two-pass-for-internalbaseurl). Must be `https` and end in `/v1`; the template refuses anything else |
| `EmailFrom` / `EmailReplyTo` | 4, 5 | empty | Notify falls back to a console transport while empty — no mail is sent. With `EmailFrom` set but `EmailReplyTo` empty, replies to invitations are discarded |
| `AlertEmail` | 7 | empty | No alarm notifications without it |
| `PortalUrl` | 5 | empty | Links in emails are relative and broken without it |
| `CanaryBaseUrl` | 7 | empty | The canary has nothing to probe |
| `DomainName`, `AcmCertificateArn` | 5 | empty | Only used when `EnableCustomDomain=true` |

### Two-pass for `InternalBaseUrl`

Leave `InternalBaseUrl` empty on the **first** deploy of tier 5 — services use it for east-west
calls, and pointing it at the HTTP API the same stack creates would be a circular dependency.
Then redeploy with the value from that stack's `InternalBaseUrlForSecondPass` output.

⚠ **It must be `https` and end in `/v1`, and the template enforces that.** This is the one URL
parameter that carries user credentials: every east-west call re-presents *the caller's own
bearer token* to whatever host this names, from functions with no egress filtering, and
team-membership authorization is answered by an HTTP probe to it. So an `http://` value strips
TLS from live tokens and team content, and a wrong or hostile host becomes an oracle that can
answer "yes, this caller is a member" for every probe. The failure mode is quiet — a bad value
renders as a fail-closed 503, indistinguishable from an outage — which is exactly why it is
rejected at change-set time instead.

## Portal hosting — Lambda Web Adapter behind CloudFront

The portal is a Next.js SSR app, built and served entirely by this platform's own stacks.

⚠ **The zip the portal publisher (`portal/buildspec-publish.yml`) produces is the SOURCE TREE, not build output.** Anything that
deploys it as-is serves a directory of TypeScript publicly, and does so without failing loudly.
Tier 6 therefore does the build in-account and serves the result itself:

```
CloudFront ──/_next/static/*──> PortalStaticBucket        (OAC, s3 origin)
           └──everything else──> PortalApi ──> PortalFunction (Lambda Web Adapter)
CodeBuild (PortalBuildProject) ──> builds the source zip from PortalBucket, writes both
```

Three details that are load-bearing:

- **`AWS_LWA_INVOKE_MODE` must be `buffered`.** It is served through an HTTP API, and API
  Gateway cannot parse a streaming response prelude — `response_stream` yields a 500 with
  nothing useful in the logs.
- **The portal has its own HTTP API, not a route on the main one.** A `$default` route added to
  the API tier's `AWS::Serverless::HttpApi` is **deleted on that tier's next deploy**: SAM
  reconciles the API's route set against the routes declared in its own template, and a route
  added from another stack is not in that set. This was diagnosed from drift detection showing
  the integration and route as `DELETED`. Giving the portal its own API is what makes the two
  tiers independently deployable.
- **The CloudFront origin request policy excludes `host` and `authorization`.** Forwarding
  `host` breaks the Lambda origin; forwarding `authorization` to an origin that does not expect
  it is a credential leak.

## Amazon Bedrock: `RatingsModelId`

Defaults to `us.amazon.nova-2-lite-v1:0` — a system-defined inference profile id that resolves
in any account where the model is enabled. It does **not** default to an account-specific
application-inference-profile ARN, whose embedded account id is wrong everywhere else.

The **`us.` prefix is load-bearing.** It names the US geo cross-region inference profile. AWS's
Nova 1→2 migration guide says Nova 2 Lite is available "through Global CRIS, US CRIS, EU CRIS
and JP CRIS endpoints" and instructs: *"when accessing models from a US region, use the `us.`
prefix"*. A bare `amazon.nova-2-lite-v1:0` is the **model** identifier — what a
`foundation-model` ARN contains — and passing it as a `modelId` risks `ValidationException:
Invocation of model ID … with on-demand throughput isn't supported`. Deploying outside the US
means setting `eu.` / `jp.`, or `global.` to route worldwide (no data-residency guarantee) —
**nothing derives this from `AWS::Region`**.

Bedrock model access is **per-account, and listed is not enabled**. If it is not enabled in the
target account and region, ratings answer `503 RATINGS_UNAVAILABLE` rather than failing
silently. Nova is used rather than Anthropic because an account that has not submitted the
Anthropic use-case form gets *"Model use case details have not been submitted for this account"*
from every Anthropic model — a human must submit that form in the Bedrock console before an
Anthropic id works.

### There is no Bedrock endpoint to create, and that is correct

Worth stating because its absence looks like an omission:

- **No VPC interface endpoint for Bedrock.** There is no VPC at all: an `execute-api` interface
  endpoint cannot front an HTTP v2 API, which breaks every service-to-service call from inside a
  VPC. The functions run outside a VPC and
  reach Bedrock over its public endpoint, so an interface endpoint would have nothing to attach
  to.
- **One `AWS::Bedrock::*` pair, and it is the guardrail, not the model.** The template
  *references* a model by id; it creates nothing to host it. It does create
  `RatingsGuardrail` (`AWS::Bedrock::Guardrail`) and a published `RatingsGuardrailVersion`, and
  passes both to the ai function as `BEDROCK_GUARDRAIL_ID` / `BEDROCK_GUARDRAIL_VERSION`. Every
  Converse call is evaluated against it: content filters (sexual, violence, hate, insults,
  misconduct) and a prompt-attack filter on the transcript-derived input, plus content filters,
  the managed profanity list and PII anonymisation (email, phone, AWS keys, passwords, card
  numbers) on the reply. The service refuses to call the model if either variable is unset, and a
  blocked call is counted as `GUARDRAIL_INTERVENED` on the Bedrock refusal alarm.
  ⚠ **CloudFormation only publishes a new guardrail version when `RatingsGuardrailVersion`
  changes**, so edit the number in its `Description` whenever you change `RatingsGuardrail`.
  The guardrail uses Bedrock's default encryption: it holds filter settings, not customer data,
  and the platform key's policy does not admit Bedrock.
  `AWS::Bedrock::ApplicationInferenceProfile` exists and could wrap the model, but
  it buys cost-allocation tagging, **not** entitlement. Model access still has to be enabled per
  account by a human, so adding it would create a second thing to keep in step without removing
  the manual step.
- **The IAM grant is the real control**, and it already anticipates the fan-out:
  `inference-profile/*` in this account for the profile, plus `foundation-model/amazon.nova-*`
  with a **wildcard region** for the models the profile routes to on the second hop. Granting
  only the profile fails at runtime with an `AccessDenied` that names the *model*. The same role
  holds `bedrock:ApplyGuardrail` on `RatingsGuardrail` only, which Converse needs to evaluate a
  call against it.

## Where the code comes from

These stacks deploy artifacts; they do not build them (the portal tier is the one exception, and
it builds in-account rather than in CI). The zips are published by the services publisher
([`services/buildspec-publish.yml`](../../../services/buildspec-publish.yml); see step 1.4 of
[`infra/SETUP.md`](../../SETUP.md)) to

```
s3://praimana-services<BucketNameSuffix>/lambda/v<version>/<service>/<service>.zip
```

one per service, immutable once published. `ReleaseVersion` (bare semver, e.g. `1.0.0`) selects
which release a stack runs; the `v` is part of the key, not the parameter.

## Seed data

Two things a freshly deployed environment needs that CloudFormation does not deliver, because
they are **data** rather than resources: the first admin, and the format catalogue. A customer
who deploys all eight templates gets a platform that cannot create an experience until the
catalogue is seeded, and nothing in the console says so — the portal reports "No formats have
been set up yet", which is accurate but reads like a fault.

### The format catalogue

`praimana-formats` is the platform's only static reference table. Established by comparing
item counts across every table against a working deployment: `phases` looks like a template set
but is keyed by `workshopId` and written per-experience at runtime, and everything else with rows
is runtime state. Formats is also **read-only to the platform** —
`services/workshop/src/repository.dynamo.ts` has `PutCommand` writes for `workshops`, `phases` and
`teamPhases` and none for `formats`, and the only route is `GET /lookup/formats`. So it can only
be seeded out of band.

⚠ `category` MUST be `workshop_format`. The handler calls
`listByCategory("workshop_format")` with that string hardcoded, so a row filed under any other
category is invisible to the picker and the portal still says the catalogue is empty — an empty
dropdown, not an error.

```bash
cat > /tmp/formats-seed.json <<'JSON'
{"praimana-formats":[
 {"PutRequest":{"Item":{"category":{"S":"workshop_format"},"name":{"S":"Accelerator"},"value":{"S":"ACCELERATOR"}}}},
 {"PutRequest":{"Item":{"category":{"S":"workshop_format"},"name":{"S":"Hackathon"},"value":{"S":"HACKATHON"}}}},
 {"PutRequest":{"Item":{"category":{"S":"workshop_format"},"name":{"S":"Program"},"value":{"S":"PROGRAM"}}}},
 {"PutRequest":{"Item":{"category":{"S":"workshop_format"},"name":{"S":"Workshop"},"value":{"S":"WORKSHOP"}}}}
]}
JSON

aws dynamodb batch-write-item \
  --profile <app-profile> --region <region> \
  --request-items file:///tmp/formats-seed.json

# Verify — expect four values, and an empty UnprocessedItems above.
aws dynamodb scan --table-name praimana-formats \
  --profile <app-profile> --region <region> \
  --query 'Items[].value.S' --output text
```

`name` is what the picker displays; `value` is what it submits and what an experience stores. The
four above are the set a working deployment uses — change the list if the product's vocabulary
differs, but keep `value` uppercase and stable, because existing experiences reference it.

### The first admin

There is no self-service sign-up: the pool sets `AllowAdminCreateUserOnly`, and the pre-signup
trigger gates the admin-create path too — `admin-create-user` for an address with no invitation
is refused with "Registration is by invitation only." and no account is created. The
post-confirmation trigger does not help either; it serves the self-signup path only and produces
no log events at all for an admin-created user, so the role group and profile row must be written
explicitly.

Once any ADMIN exists, use `POST /v1/user-access/provision` — that service is the boundary for
Cognito admin-writes and does the whole sequence synchronously. It needs an ADMIN token, so it
cannot make the first one; [`services/ROLES.md`](../../../services/ROLES.md) states the rule ("the first admin comes from the seeded
bootstrap").

**The four bootstrap steps, the exact invitation row shape, and why each guard exists are
documented in the header of [`platform-identity.yaml`](platform-identity.yaml)** — next to the
pool and the triggers they concern, rather than duplicated here where the two could drift apart.

### Why these are not in a template

Both write items to DynamoDB. They will never appear as stack drift, `cloudformation deploy` will
not reconcile them, and deleting a stack leaves them behind (the durable tables are `Retain`).
Anyone standing up an environment runs them once, after the tiers are deployed and before handing
the platform to a facilitator.

## Local checks, no AWS credentials needed

```bash
pip install cfn-lint==1.58.0
for f in platform*.yaml; do cfn-lint "$f"; done
```
