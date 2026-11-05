# infrastructure

The AWS resources for Praimana, as CloudFormation.

This folder holds **what gets deployed**. The CI/CD pipelines that deploy it are maintained
separately and are not included in this sample; this folder does not hold application source,
and it deploys built artifacts that the `services/` and `portal/` publishers produce (plus,
optionally, the desktop source zip).

Everything deploys into a **single AWS account**. Two folders, two lifecycles: the supply-chain
buckets (long-lived) and the application stacks (a tenant of them).

| Folder | Contents | Deployed by |
|---|---|---|
| [`aws/shared/`](aws/shared/README.md) | Five S3 buckets (plus their access-log bucket): Lambda zips, installers, portal bundle, published templates | by hand (see [`SETUP.md`](SETUP.md)); originally the `praimana-infra-shared` pipeline (not included in this sample), on a push to `aws/shared/**` |
| [`aws/app/`](aws/app/README.md) | The application as **eight tier templates**: KMS, DynamoDB, plumbing, SES, Cognito, the API and its Lambdas, the portal, observability — plus the nested-stack master `platform.yaml` | by hand, in order, or via `platform.yaml` from the published template URLs. **There is no pipeline that deploys the app stacks** |

```
                    ┌──────────────────────── one account ───────────────────────────┐
  publishers ─────> │  services   artifacts   desktop   portal   cf-template         │
  (publish zips)    │  lambda/    desktop/    desktop/  portal/  templates/          │
                    │            aws/shared/platform-buckets.yaml                    │
                    │                              │ read at deploy / runtime        │
                    │  eight stacks from aws/app/platform-*.yaml, deployed in order; │
                    │  each takes the previous tiers' outputs as parameters          │
                    │  (no Fn::ImportValue anywhere)                                 │
                    └────────────────────────────────────────────────────────────────┘
```

## Which pipeline touches what

Both pipelines are part of the separate CI/CD setup (not included in this sample) and watch
**disjoint paths in this folder**, deliberately — widening either filter would mean a bucket-policy
change republishing the app template, or a template edit touching live bucket policies.

| Pipeline | Triggers on | Does |
|---|---|---|
| `praimana-infra-shared` | `aws/shared/**` | *Deploys* the bucket stack through a change set with a human approval gate (CloudFormation runs under a dedicated execution role that holds no CreateStack/UpdateStack) |
| `praimana-infra-template-publish` | the `aws/app/platform-*.yaml` tier templates, plus `aws/app/buildspec-publish.yml` | *Publishes* the app templates to the CloudFormation template bucket. Copies files; deploys nothing |

The second filter is a **list of exact paths, not a glob**: CodeStar `FilePaths.Includes` takes
up to eight patterns and does not expand `{a,b}`, so a brace expression matches nothing and the
trigger silently never fires. ⚠ There are now **eight** tier templates (KMS was added as tier 0;
see [`aws/app/README.md`](aws/app/README.md)), so the templates plus the buildspec already exceed
the eight-pattern cap. The trigger pattern list lives in the CI/CD pipeline definition (not
included in this sample) — reconcile it there with a second pipeline or a shared prefix rather than a brace
expression that matches nothing.

## Where to start reading

- Standing up the platform in an account → [`aws/app/README.md`](aws/app/README.md), which
  covers the **tier deploy order and which output feeds which parameter**, the parameters that
  have no defaults, the two second passes (Cognito callbacks, `InternalBaseUrl`), and the two
  seeding steps CloudFormation cannot perform (first admin, format catalogue).
- Changing the buckets, or understanding the posture gates →
  [`aws/shared/README.md`](aws/shared/README.md).
- Bootstrapping the CI/CD foundation, the execution role, or which values a deploy needs →
  the CI/CD pipeline documentation (the pipeline templates are maintained separately and are
  not included in this sample; see [`SETUP.md`](SETUP.md) for how to deploy with only what ships).

## Local checks, no AWS credentials needed

```bash
pip install cfn-lint==1.58.0
cfn-lint aws/shared/platform-buckets.yaml
for f in aws/app/platform*.yaml; do cfn-lint "$f"; done
./aws/shared/test-posture-gate.sh
trivy config .        # reads trivy.yaml, which applies ../.trivyignore.yaml
```

Scanner findings that are false positives or accepted by design are recorded, each with its
reason, in [`../.trivyignore.yaml`](../.trivyignore.yaml). trivy only reads that file through
`trivy.yaml` (here and at the repository root) or `--ignorefile .trivyignore.yaml`; its default is a
plain `.trivyignore`.

`test-posture-gate.sh` is the one worth knowing about: it runs the real bucket-posture gate,
extracted from `buildspec-validate.yml`, against the committed template and against copies
mutated the way live drift would mutate them. A gate is a claim about what it would *refuse*,
and that claim is untested until something hands it a policy it should refuse.

The `E3004` circular-dependency finding that the old all-in-one template carried on the Cognito
trigger role and user pool is **fixed**, not tolerated: `platform-identity.yaml` breaks the cycle
by moving the `cognito-idp:AdminAddUserToGroup` grant into a standalone `AWS::IAM::Policy`
attached to the role, so the role no longer has to reference the pool it is referenced by. Treat
any `E3004` here as new.

## Two properties worth knowing before you change anything here

**Published artifacts are consumed by version-only key.** Stacks fetch
`lambda/v<release>/<service>/<service>.zip`, and the app template's published pointer is a
stable URL. So overwriting an already-released key changes what an existing stack fetches on
its next update with no signal that anything moved. Publishers hold no `DeleteObject`, and
`DeleteObjectVersion` is granted to nobody, but `PutObject` on an existing key still replaces
it — the release-immutability guard is a buildspec step, not an S3 property. Treat a release
key as immutable even though S3 is not enforcing it for you.

**The app templates are published to be deployed unmodified.** That makes every
parameter default a posture decision, not a local convenience — which
is why the origin list and the Cognito redirect URIs have no defaults at all. If you add a
parameter that affects who can reach the API or where a credential can be sent, give it no
default rather than a permissive one.

**A tier boundary is a parameter, never an `Fn::ImportValue`.** Imports would lock the eight
stacks into one deletion order and one account's naming, and a customer deploying tier 5 could
not see what it is being told. Outputs-to-parameters keeps each stack independently deployable
and auditable — at the cost of a documented wiring table, which `aws/app/README.md` carries.

## What is not in this folder

| Thing | Where |
|---|---|
| The pipelines, the CloudFormation execution role, artifact bucket and CMK | the separate CI/CD setup (not included in this sample) |
| Service source and the zips this deploys | [`services/`](../services/README.md) at the repository root, published by `services/buildspec-publish.yml` |
| The portal application | [`portal/`](../portal/README.md) at the repository root — `platform-portal.yaml` builds the published source zip in-account and serves it from Lambda behind CloudFront |
| The desktop client | [`desktop/`](../desktop/README.md) at the repository root — this stack only serves its installers |

## Important Notes

- **This is sample code, not a production service.** These templates demonstrate how to deploy an
  AI-assisted workshop platform on AWS. They are provided as a starting point for your own
  implementation, not as a maintained software product.
- **No warranty.** This code is provided as-is. Review, test, and adapt it for your environment
  before any production use.
- **Your responsibility.** Once deployed in your account, you are responsible for the security,
  cost, and operational management of these resources per the
  [AWS Shared Responsibility Model](https://aws.amazon.com/compliance/shared-responsibility-model/).
- **Not published to package indexes.** These samples are not available via pip, npm, or Maven.
  Clone this repository to use them.
- **Feedback welcome.** File issues or pull requests on GitHub. We review contributions but cannot
  guarantee response times.

## License

This library is licensed under the MIT-0 License. See the `LICENSE.md` file in the repository root.
