# `aws/shared/` — the supply-chain buckets, and the gates that keep them honest

`platform-buckets.yaml` creates the five supply-chain S3 buckets (plus an access-log bucket that
receives their server access logs) that everything else in this platform is delivered through:
the Lambda zips the app stacks deploy from, the installers customers download, the portal bundle,
and the published CloudFormation templates. Every bucket name is `<base><BucketNameSuffix>`,
e.g. `praimana-services-a1b2c3d4`.

In the original setup nothing in here was deployed by hand: a push to `aws/shared/**` triggered
the `praimana-infra-shared` pipeline (part of the CI/CD setup, not included in this sample),
which ran the two buildspecs in this folder around a reviewable change set. Everything deploys
into a single account; the pipeline passed a dedicated CloudFormation execution role that held
the bucket-mutating permissions, so a bucket change could only happen through a reviewable change
set. Without that pipeline, deploy this template directly (see [`../../SETUP.md`](../../SETUP.md)).

Sibling folder [`aws/app/`](../app/README.md) holds the application as eight tier stacks. Same
account, different lifecycle, different README.

## What each file is

| File | Role |
|---|---|
| `platform-buckets.yaml` | The six buckets and their bucket policies. 12 resources, 24 parameters, 14 conditions |
| `buildspec-validate.yml` | **Stage 2 (pre-gate).** Lints, asserts bucket posture, checks the stack policy, renders `params.json`. Produces the template configuration the deploy actions consume |
| `buildspec-verify.yml` | **Stage 6 (post-deploy).** Re-asserts the same posture against the *live* buckets, then applies termination protection and the stack policy |
| `stack-policy.json` | Denies `Update:Replace` and `Update:Delete` on all six buckets **and all six bucket policies** (the five platform buckets plus the access-log bucket). Applied out-of-band — see below |
| `test-posture-gate.sh` | Regression test for the validate gate. Runs offline, no AWS calls |

## The five buckets

Each grant is scoped to one key prefix per bucket. The deploy role is not special — it is
simply one of the readers.

| Bucket | Prefix | Holds | Read by | Read at |
|---|---|---|---|---|
| `services` | `lambda/` | one immutable zip per service per release | the app tiers' CloudFormation deploy | deploy time |
| `artifacts` | `desktop/` | macOS `.dmg` and Windows `.exe` installers | the desktop-download Lambda, then customers | runtime |
| `desktop` | `desktop/` | the desktop source zip | **nobody — write-only drop box** | never |
| `portal` | `portal/` | the portal source zip | the portal tier's CodeBuild project | deploy time |
| `cf-template` | `templates/` | the published app tier templates | any account standing the platform up | deploy time |

Two principal lists, both supplied as parameters and both read from Parameter Store by the
Validate stage:

- **`CustomerPrincipals` — readers.** `GetObject`/`GetObjectVersion`, prefix-scoped `List`,
  `GetBucketLocation`. Every bucket except `desktop`.
- **`CicdPrincipals` — publishers.** `PutObject`, multipart, read-back, prefix-scoped `List`.
  `DeleteObject` only when `CicdCanDelete=true`; `DeleteObjectVersion` **never**, so no
  pipeline can destroy version history.

Leave a list empty and **no statement is emitted for it at all** — which also means the
posture gate has no grant to inspect for that role. Worth knowing when reading a green build.

## Durability, and how to actually delete a bucket

On all five, no exceptions: versioning enabled, `DeletionPolicy` and `UpdateReplacePolicy` both
`Retain`, and — while `EnableDeleteProtection=true`, the default — a `DenyBucketDeletion`
statement denying `s3:DeleteBucket` to *every* principal. An explicit Deny outranks every
Allow, so neither an account admin nor a console click can drop the bucket.

To genuinely delete one: redeploy with `EnableDeleteProtection=false`, then empty and delete it
by hand. `s3:PutBucketPolicy` is deliberately **not** denied, so the guard is always liftable
and you cannot lock yourself out. That decision is what puts live bucket-policy drift in scope,
which is why the gates below exist.

Two things CloudFormation cannot do to its own stack, both applied by `buildspec-verify.yml`:

- **Termination protection** — a stack cannot set it on itself from within its own template.
- **The stack policy** — it cannot travel with a change set. `CreateChangeSet` and
  `ExecuteChangeSet` accept no `StackPolicyBody`; only `CreateStack`, `UpdateStack` and
  `SetStackPolicy` do. A `StackPolicy` key in a template-configuration file is parsed and
  **silently dropped**, which reads like protection while providing none. So `stack-policy.json`
  is applied in `post_build`, and the Validate stage asserts it covers every managed bucket
  first. Once set, a change that genuinely needs to replace a bucket is refused until a human
  applies a temporary override.

Applying it *after* the deploy means it guards every **subsequent** run, not the one that just
executed — correct for a first deploy (nothing to protect yet) and for steady state (the policy
set last run was in force during this run's change set).

MFA delete is not set: CloudFormation cannot configure it, and it needs root credentials.

## The two gates

Both run the same five checks, one against the committed template and one against what is
actually live. The build gate reads intent; the live gate reads reality, and live drift is the
threat the template accepts by design when it declines to deny `s3:PutBucketPolicy`. **Keep the
two in step** — a live gate weaker than the build gate is the wrong way round.

What they assert, per bucket policy:

1. Sids are unique.
2. `DenyInsecureTransport` is present (plus `DenyBucketDeletion` when delete protection is on).
3. No `Allow` grants `s3:DeleteObjectVersion` — matched **semantically**, so `s3:Delete*`,
   `s3:D*` and `s3:*` are all caught, not just that one spelling.
4. No `Allow` carries a wildcard action pattern at all.
5. The `desktop` bucket grants no readers.

Checks 3 and 4 are **Allow-only**, and that is not a detail: once matching is semantic, the
`s3:*` in `DenyInsecureTransport` matches `s3:DeleteObjectVersion`, so testing Deny statements
too would fail the build on the very statement doing the protecting.

`buildspec-validate.yml` additionally runs `cfn-lint` (fails the build), `checkov`
(`--soft-fail`, informational — it flags generic S3 findings this bucket set does not want),
the stack-policy coverage check, and `test-posture-gate.sh`.

`buildspec-verify.yml` additionally asserts an **expected bucket count**
(`EXPECT_BUCKET_COUNT`, default 5). The check set is derived from the stack's own conditioned
outputs, so a bucket that leaves the managed set simply stopped being checked — "nothing to
check" and "everything checked" were the same green. Making the count a parameter means
coverage cannot shrink without somebody changing a number on purpose.

## `params.json` — the rendered template configuration

The Validate stage's single Python pass resolves parameters → conditions → posture assertions →
stack-policy check → `params.json`, in that order, computing the parameter values **once** so
the assertions and the rendered configuration cannot drift apart. `params.json` is the build
artifact the deploy actions consume; anything absent from it falls back to the template's own
`Default`.

⚠ **`BUCKET_NAME_SUFFIX` is why this matters.** `platform-buckets.yaml` appends the required
`BucketNameSuffix` (no default) to every bucket name, and S3 bucket names are global — the suffix
is what stops a second environment failing at `ExecuteChangeSet` with `BucketAlreadyExists` or
inheriting the first one's names. Through a pipeline, the Validate stage renders it from
`BUCKET_NAME_SUFFIX` into the template configuration, and the pipeline's CloudFormation execution
role must scope its S3 permissions to those same `<base><suffix>` names, so one value keeps both
halves in step. Deploying directly, pass `BucketNameSuffix` yourself and never change it (see
[`../../SETUP.md`](../../SETUP.md)).

## Running the checks locally

`test-posture-gate.sh` needs no AWS credentials — it stubs the two Parameter Store lookups:

```bash
./aws/shared/test-posture-gate.sh          # from infra/
```

It extracts the **real** Python block out of `buildspec-validate.yml` rather than
reimplementing it (a copy would drift and then test nothing), runs it against the committed
template, which must pass, and against three copies mutated the way live drift would mutate
them, each of which must fail:

| Case | Expect | Why it exists |
|---|---|---|
| `pristine` | pass | the committed template must not trip its own assertions |
| `delete-wildcard` | fail | `s3:Delete*` grants what `s3:DeleteObjectVersion` grants |
| `allow-wildcard` | fail | any wildcard action pattern in an `Allow` |
| `unguarded-policy` | fail | the stack policy must cover the `*BucketPolicy` ids too, not just the buckets |

⚠ **The stub returns non-empty principal lists on purpose.** The grant statements are wrapped
in `!If` on those lists, so with empty lists they are conditioned out of the resolved policy
and a tampered grant is never examined — the test would pass for the wrong reason.

Add a case whenever you add an assertion. **If a case starts passing when it should fail, the
gate has been weakened**, and that is the whole signal this script exists to give.

`cfn-lint` alone, if that is all you want (from `infra/`):

```bash
pip install cfn-lint==1.58.0 && cfn-lint aws/shared/platform-buckets.yaml
```

## Environment contract

Neither buildspec sets its own variables; both are supplied by the CodeBuild projects in the
CI/CD pipeline (not included in this sample). A missing one fails with the variable name rather than a bare traceback.

| Buildspec | Reads |
|---|---|
| `buildspec-validate.yml` | `TEMPLATE_PATH`, `ENVIRONMENT`, `APPLICATION_NAME`, `AUTO_DELETE`, `CUSTOMER_PRINCIPALS_PARAM`, `CICD_PRINCIPALS_PARAM`, `ENABLE_DELETE_PROTECTION`, `CICD_CAN_DELETE`, `BUCKET_NAME_SUFFIX` |
| `buildspec-verify.yml` | `TARGET_STACK`, `EXPECT_DELETE_PROTECTION`, `EXPECT_BUCKET_COUNT`, `STACK_POLICY_PATH` |

The two principal-list parameters live in Parameter Store in the same account: the Validate
build's role holds `ssm:GetParameter` on exactly those two paths. The `/shared/` in the path
is a naming convention. In the original setup the CI/CD foundation stack (not included in this
sample) owned them, so a list was rotated by redeploying that stack — an out-of-band
`put-parameter` works until the next deploy of that stack, which reverts it.

## Known gaps, recorded rather than implied

Both are real and currently unaddressed. They are written down because a gate nobody knows the
limits of is worse than no gate.

- **The posture gates inspect `Action` and `Sid`, never `Principal` or `Resource`.** So a
  policy that adds an external account to a reader statement, widens a resource from a
  prefix to the whole bucket, or adds `PutObject` to a reader grant passes both gates green:
  none of those introduces a wildcard action, none matches `s3:DeleteObjectVersion`, and all
  keep the required Sids. The `desktop` "no readers" invariant is weaker still — it is keyed on
  Sid *spelling*, so a reader statement named anything else grants readers on the bucket the
  model says must have none. Closing this means asserting both fields in
  `buildspec-validate.yml` and mirroring it in `buildspec-verify.yml`, and extending
  `test-posture-gate.sh` with a widened-principal and a widened-resource case.
- **`buildspec-verify.yml` runs with the pipeline's `VerifyRole` directly** (no assumed
  session or temp credentials file any more). That role is read-only on the buckets apart from
  the two protective CloudFormation writes in `post_build` (termination protection and the
  stack policy); it holds no `CreateStack`/`UpdateStack` and no bucket-mutating S3 action, so a
  commit-supplied Verify buildspec can observe and protect, not change bucket contents.

## Bucket modes, for importing an existing bucket

Each bucket has a tri-state `*BucketMode` parameter — `false` | `import` | `true` — so a bucket
that already exists outside CloudFormation can be adopted without blocking the others. All five
are `true` today; the machinery is retained for a future bucket, not for these.

Importing is two passes, because an `IMPORT` change set may only add the resources named in
`--resources-to-import`: first bring the bucket in with mode `import`, which withholds its
policy, then flip the mode to `true` and deploy to attach it. `Retain` on both deletion policies
is mandatory for import and already set.

⚠ **A bucket in `import` mode has no bucket policy at all** — no TLS deny, no delete guard and
no grants. The Validate stage warns loudly rather than failing, since the state is legitimate
mid-import, so do not leave it there.

## Every bucket added here needs a change in the pipeline stack too

The CloudFormation execution role's S3 permissions (in the CI/CD pipeline's CfnExecutionRole)
are scoped to the bucket names **by name**. A bucket added to this template but not to that
role's list fails at `ExecuteChangeSet` with `AccessDenied` on `s3:CreateBucket` — the pipeline
goes green through Validate and CreateChangeSet, then dies at Deploy. That is exactly how
`cf-template` was missed when it was added. The Verify stage's `EXPECT_BUCKET_COUNT` needs the
same attention in the other direction.
