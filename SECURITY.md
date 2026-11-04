# Security Threat Model — Praimana

## Reporting a vulnerability

If you discover a potential security issue in this project, notify AWS/Amazon Security via the
[vulnerability reporting page](http://aws.amazon.com/security/vulnerability-reporting/). Please do
**not** create a public GitHub issue.

## About this threat model

A STRIDE threat model of the platform, with every mitigation checked against the code. The
machine-readable model and the full report are committed alongside this file under
[`.threatmodel/`](.threatmodel/): `praimana-threat-model.tc.json` (importable into
[AWS Threat Composer](https://awslabs.github.io/threat-composer/)) and `praimana-threat-model.md`.

## System summary

Praimana is a self-hosted, **single-tenant** platform for running AI-assisted team workshops and
reviewing the record afterwards. It deploys into the customer's own AWS account: a local-first
Electron desktop client + a Next.js portal (SSR on Lambda behind CloudFront) + ~15 Lambda services
behind an API Gateway HTTP API with a Cognito JWT authorizer, backed by DynamoDB, S3, EventBridge,
SQS, Cognito, Amazon Bedrock, SES, and a customer-managed KMS key. The platform is **invite-only**
(Cognito `AllowAdminCreateUserOnly`). The AI coding assistant runs **locally** under the
participant's own subscription; only the conversation transcript syncs upstream.

Data classification: **Confidential** (AI transcripts, per-member coaching assessments, user PII),
with **Restricted** material (invitation grants, authentication tokens). Applicable regimes: GDPR,
CCPA/CPRA.

## Residual risk at a glance

| Metric | Value |
|---|---|
| Total threats | 23 |
| Threats at **HIGH** or **CRITICAL** residual severity | **0** |
| Threats with residual decision *Open* | **0** |

No threat remains at HIGH residual severity once the implemented controls are taken into account,
and none is left *Open*.

## Risk Summary

Counts are by **inherent** severity (the threat's severity before mitigation), so the table reflects
the real STRIDE spread the model identified. Residual severity after the verified controls is lower
for almost every row — see the per-threat residual decisions in the detailed findings.

| STRIDE Category | CRITICAL | HIGH | MEDIUM | LOW | Total |
|---|---|---|---|---|---|
| Spoofing | 0 | 2 | 3 | 0 | 5 |
| Tampering | 0 | 1 | 3 | 0 | 4 |
| Repudiation | 0 | 0 | 1 | 1 | 2 |
| Information Disclosure | 0 | 2 | 2 | 1 | 5 |
| Denial of Service | 0 | 0 | 2 | 1 | 3 |
| Elevation of Privilege | 1 | 2 | 1 | 0 | 4 |
| **Total** | **1** | **7** | **12** | **3** | **23** |

Residual-risk disposition, after the controls were validated against the code:

| Residual decision | Count | Threats |
|---|---|---|
| Mitigated | 13 | T003, T005, T006, T009, T010, T011, T012, T013, T015, T018, T019, T020, T022 |
| Accepted | 10 | T001, T002, T004, T007, T008, T014, T016, T017, T021, T023 |

## Key implemented controls (verified against code)

- **Amazon Bedrock Guardrails on every model call** (T005): the AI service's Converse calls are
  evaluated against `RatingsGuardrail` — HIGH prompt-attack and content filters on the
  transcript-derived input; content filters, the managed profanity list and PII anonymisation on
  the reply. The service refuses to call the model without a guardrail configured, and a blocked
  reply is refused (previous snapshot kept) and counted as `GUARDRAIL_INTERVENED` on the Bedrock
  refusal alarm. Model output drives no privileged action.
  (`infra/aws/app/platform-api.yaml`, `services/ai/src/analyst.bedrock.ts`)
- **Invitation = account-mint hardening** (the highest-value escalation path, T019 Critical →
  residual Low): deny-by-default `ROLE_GRANTS` matrix gates every invitation write; `user-access`
  holds invitations **read-only**; the Cognito PreSignUp gate fails closed; PostConfirmation resolves
  the role from the invitation, never from the client.
  (`services/service-shared/src/roles.ts`, `services/cognito-presignup/src/handler.ts`)
- **Prototype-safe authorization matrices** (T020): `grantRow` uses
  `Object.prototype.hasOwnProperty.call` + `Array.isArray`, closing a `canInvite("constructor")`
  fail-open. (`services/service-shared/src/roles.ts`)
- **Edge JWT + server-side identity** (T001, T004): API Gateway Cognito authorizer validates RS256
  signature/issuer/audience; services re-derive identity from verified claims; the forgeable
  `x-identity-*` path is inert (`INTERNAL_SERVICE_TOKEN` unset).
  (`services/service-shared/src/edge-identity.ts`)
- **Desktop credential protection** (T002): tokens encrypted via OS keychain (Electron
  `safeStorage`), SQLite `0o600`, plaintext writes refused. (`desktop/src/main/database.ts`)
- **Desktop process confinement** (T007): real-path `cwd` confinement that throws rather than falling
  back to `$HOME`, `shell: false` always, IPC sender validation.
  (`desktop/src/main/spawn-confined.ts`, `desktop/src/main/ipc-guard.ts`)
- **Member-only, fail-closed authorization** (T006, T012): `HttpTeamAccess` returns `DENY_ALL` on any
  non-2xx/timeout/missing context. (`services/collaboration/src/team-access.http.ts`)
- **Append-only audit** (T009, T010): explicit IAM `Deny` on
  Update/Delete/BatchWrite/TransactWrite for `praimana-audit` across every execution role.
- **WebSocket lifetime bound to token expiry** (T018): socket closes at `exp` (code 4001).
  (`services/collaboration/src/ws-server.ts`)
- **Explicit CORS origins** (T011): `ApiAllowedOrigins` is a required template parameter with no
  default, so the cross-origin allow-list is always a deliberate deployment decision;
  `AllowCredentials` is unset, so a bearer is still required. (`infra/aws/app/platform-api.yaml`,
  `infra/aws/app/platform.yaml`)
- **OAuth loopback hardening** (T003): state-nonce-first ordering, Host/sec-fetch-site checks,
  OIDC-discovery endpoints, PKCE public client. (`desktop/src/main/cognito-oauth.ts`)

## Detailed Findings

Each threat below lists inherent severity, affected component(s)/file(s), the residual decision, and
the recommended mitigation. STRIDE category is taken from each threat's own record.

### Spoofing

- **[HIGH] T001 — Bearer-token replay against `/v1/*`.** Component: API Gateway / desktop / portal
  (`infra/aws/app/platform-api.yaml`, `services/service-shared/src/edge-identity.ts`). Residual:
  **Accepted** (Medium). Mitigation: edge Cognito JWT validation + server-side identity derivation;
  keep access tokens short-lived and set `ApiAllowedOrigins` to the portal origin only (see T011).
- **[MEDIUM] T002 — Refresh-token / keychain theft on the participant machine.** Component: desktop /
  local SQLite (`desktop/src/main/database.ts`). Residual: **Accepted** (Medium). Mitigation: OS
  keychain encryption, no plaintext writes; revoke via account disable; consider a shorter refresh
  lifetime.
- **[MEDIUM] T003 — Authorization-code injection into the loopback listener.** Component: desktop /
  Cognito (`desktop/src/main/cognito-oauth.ts`). Residual: **Mitigated** (Low). Mitigation:
  state-nonce-first ordering, Host/sec-fetch-site checks, OIDC discovery, PKCE.
- **[HIGH] T004 — Fabricated `authorizer.jwt.claims` on the east-west direct-invoke path.**
  Component: bulk-provision / user-access / team (`services/service-shared/src/edge-identity.ts`).
  Residual: **Accepted** (Low). Mitigation: forgeable header path inert
  (`INTERNAL_SERVICE_TOKEN` unset); direct-invoke bounded by scoped `lambda:InvokeFunction`; requires
  a service foothold.
- **[MEDIUM] T023 — Desktop account switching without re-authentication.** Component: desktop
  (`auth:switchAccount` in `desktop/src/main/handlers/ai.ts`, `desktop/src/main/accounts.ts`).
  Several accounts can be stored on one machine, and switching installs another stored account's
  session (its encrypted Cognito refresh token) with no password, MFA or OS prompt. Anyone using
  the same OS user, or code running in the renderer, can therefore act as any account stored there
  until it is signed out, removed, or its 30-day refresh token expires. Residual: **Accepted**
  (Medium). Rationale: the app models one person with several addresses (one per experience or
  team), so this is intended. Controls: tokens are bound to the OS user by `safeStorage`;
  malformed or unknown account IDs are refused; every switch is audited as `account.switch` and
  every user-action record names the acting identity; signing out or removing an account revokes
  its refresh token at Cognito. **Deployers:** on a machine where several people share one OS
  user, tell participants to sign out or remove their account before leaving.

### Tampering

- **[HIGH] T005 — Indirect prompt injection via synced transcripts.** Component: local AI assistant /
  AI service / Bedrock (`AIServiceRole`, `infra/aws/app/platform-api.yaml`). Residual: **Mitigated**
  (Low). Mitigation: every Converse call is evaluated against the `RatingsGuardrail` Amazon Bedrock
  guardrail (prompt-attack and content filters on input; content, profanity and PII on output), the
  service refuses to call the model without one, model output drives no privileged action, and the
  analyze route is throttled 1rps/5burst. Residual: an injection that evades the prompt-attack filter
  can still skew that team's own assessment.
- **[MEDIUM] T006 — Cross-team IDOR on mutating routes.** Component: shared services / collaboration
  (`services/collaboration/src/team-access.http.ts`). Residual: **Mitigated** (Low). Mitigation:
  deny-by-default member-only authorization, fail-closed.
- **[MEDIUM] T007 — IPC / spawn escape from a compromised renderer.** Component: desktop
  (`desktop/src/main/spawn-confined.ts`, `ipc-guard.ts`). Residual: **Accepted** (Low). Mitigation:
  real-path cwd confinement (throws, no `$HOME` fallback), `shell:false`, IPC sender validation.
  One direct `spawn` remains outside `spawnConfined`: `openProfileWindow` in
  `desktop/src/main/profile.ts`, which re-executes the app's own binary (`process.execPath`) without
  a shell and passes only a sanitised profile id, so no renderer-chosen command or working
  directory reaches it.
- **[MEDIUM] T008 — Hostile backend origin exfiltrates bearers/transcripts.** Component: desktop
  (`desktop/src/csp-policy.ts`). Residual: **Accepted** (Medium). Mitigation: strict prod CSP;
  validate/pin the Connect-screen origin (`connect-src *` is a documented residual of the
  runtime-configurable origin).

### Repudiation

- **[MEDIUM] T009 — Denial of a privileged action.** Component: user-access / team. Residual:
  **Mitigated** (Low). Mitigation: append-only audit log of privileged identity actions.
- **[LOW] T010 — Audit-record tampering.** Component: user-access. Residual: **Mitigated** (Low).
  Mitigation: IAM `Deny` on `praimana-audit` mutate across all roles.

### Information Disclosure

- **[HIGH] T011 — Wildcard-CORS cross-origin reads of `/v1/*`.** Component: API Gateway
  (`infra/aws/app/platform-api.yaml`). Residual: **Mitigated** (Low). Mitigation:
  `ApiAllowedOrigins` is required with no default, and `infra/SETUP.md` sets it to the portal
  origin. Residual risk remains only if a deployer deliberately supplies `*`.
- **[HIGH] T012 — Unauthorized read of coaching assessments / draft submissions.** Component:
  evaluation service. Residual: **Mitigated** (Low). Mitigation: draft-visibility gating +
  member-only access, fail-closed.
- **[MEDIUM] T013 — Invitation / membership enumeration via anonymous routes.** Component: API
  Gateway (`services/cognito-presignup/src/handler.ts`). Residual: **Mitigated** (Low). Mitigation:
  lookup-by-email unmapped at the gateway; token-only anonymous lookup.
- **[MEDIUM] T014 — Lateral disclosure via an over-broad IAM grant.** Component: shared services.
  Residual: **Accepted** (Low). Mitigation: per-service least-privilege roles. Follow-up: the
  `WorkshopResourcesAccess` S3 policy sits on the shared `LambdaExecutionRole`, so it reaches the
  workshop, collaboration, evaluation and source functions; move it to a role used only by the
  function that serves the resources bucket.
- **[LOW] T015 — Secondary disclosure via logs.** Component: AI service / API Gateway. Residual:
  **Mitigated** (Low). Mitigation: log minimization (sub not email), no team content logged, CMK on
  service log groups.

### Denial of Service

- **[MEDIUM] T016 — API flood (no per-caller fairness).** Component: API Gateway. Residual:
  **Accepted** (Medium). Mitigation: per-stage throttling + hardened analyze route; single-tenant
  deployment bounds impact; optional WAF/usage plans for per-caller fairness.
- **[MEDIUM] T017 — Cost / SES-quota amplification.** Component: AI service / notify. Residual:
  **Accepted** (Medium). Mitigation: analyze route 1rps/5burst, SES send-quota counter; recommend
  budget alarms.
- **[LOW] T018 — Post-revocation WebSocket data receipt.** Component: collaboration WS
  (`services/collaboration/src/ws-server.ts`). Residual: **Mitigated** (Low). Mitigation: socket
  bound to token `exp` (closes code 4001), fail-closed team access.

### Elevation of Privilege

- **[CRITICAL] T019 — Invitation row grants ADMIN (account mint).** Component: team / Cognito
  triggers / user-access (`services/service-shared/src/roles.ts`,
  `services/cognito-presignup/src/handler.ts`). Residual: **Mitigated** (Low). Mitigation:
  `ROLE_GRANTS`-gated invitation write, read-only in user-access, fail-closed invite gate,
  server-resolved role; matrix drift guarded by `routes.test.ts`.
- **[HIGH] T020 — Facilitator mints a role above their authority / prototype-chain fail-open.**
  Component: team / user-access (`services/service-shared/src/roles.ts`). Residual: **Mitigated**
  (Low). Mitigation: deny-by-default grant matrices with prototype-safe lookup.
- **[HIGH] T021 — Over-broad IAM widens blast radius.** Component: AI service (`AIServiceRole`) and
  identity service (`IdentityFunctionRole`). Residual: **Accepted** (Medium). Mitigation: Bedrock on
  `AIServiceRole` narrowed to in-account inference profiles and the `amazon.nova-*` /
  `anthropic.claude-*` model families. The resource-less `cloudwatch:DescribeAlarms` and
  `ce:GetCostAndUsage` grants are on `IdentityFunctionRole`, are read-only, and are bounded by the
  query (see [Wildcard IAM grants](#wildcard-iam-grants)). The foundation-model ARNs use a wildcard
  Region because cross-Region
  inference profiles route requests to models in other Regions. Follow-up: narrow that wildcard to
  the Regions the chosen inference profile routes to.
- **[MEDIUM] T022 — Client-supplied role self-assignment.** Component: Cognito triggers / Cognito
  (`services/cognito-postconfirmation`). Residual: **Mitigated** (Low). Mitigation: role resolved
  server-side from the invitation; unrecognised groups degrade to PARTICIPANT.

## Wildcard IAM grants

Every IAM statement in the templates that uses `Resource: "*"` is listed here. Each is an action
whose AWS API takes no resource ARN, so IAM cannot scope it to one; all are read-only or limited by
a condition, and each sits on a role used by one function only.

| Role | Action | Template | Why it cannot be scoped | What bounds it |
|---|---|---|---|---|
| `IdentityFunctionRole` | `cloudwatch:DescribeAlarms` | `infra/aws/app/platform-api.yaml` (`PlatformHealthRead`) | CloudWatch authorises this list call against `*`. Scoping it to `alarm:praimana-*` passes IAM policy simulation but returned `AccessDenied` when deployed; `services/identity/src/health.iam.test.ts` keeps it unscoped for that reason. | Read-only. The health panel asks only for alarms named `praimana-*` (`AlarmNamePrefix`, at most 100). |
| `IdentityFunctionRole` | `ce:GetCostAndUsage` | `infra/aws/app/platform-api.yaml` (`PlatformSpendRead`) | Cost Explorer has no resource type for this action; it reads the account's cost data as a whole. | Read-only. The spend panel groups month-to-date cost by service and by the `ApplicationName` tag (`services/identity/src/cost.explorer.ts`). |
| `UserProjectionRole` | `dynamodb:ListStreams` | `infra/aws/app/platform-api.yaml` (`UserProjectionWrite`) | `ListStreams` is an account-level call with no resource type. The Lambda event source mapping for the users-table stream needs it. | Returns stream ARNs and metadata only, never records. Reading stream records (`DescribeStream`, `GetRecords`, `GetShardIterator`) is scoped to `table/praimana-users/stream/*`. |
| `CanaryRole` | `s3:ListAllMyBuckets` | `infra/aws/app/platform-observability.yaml` (`canary-run`) | An account-level call with no resource type, required by the CloudWatch Synthetics runtime ([required canary permissions](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Synthetics_Canaries_CanaryPermissions.html)). | Returns bucket names only. Writing artifacts (`s3:PutObject`) is scoped to the canary artifacts bucket. |
| `CanaryRole` | `cloudwatch:PutMetricData` | `infra/aws/app/platform-observability.yaml` (`canary-run`) | CloudWatch metric data has no resource type. | A `cloudwatch:namespace` condition limits writes to the `CloudWatchSynthetics` namespace. |

The AWS KMS key policy in `infra/aws/app/platform-kms.yaml` also uses `Resource: "*"`. In a key
policy that means the key the policy is attached to, not every resource.

### AWS service principals in the KMS key policy

The platform key encrypts the alerts topic (`AlertsTopic` in `infra/aws/app/platform-observability.yaml`),
so the services that publish to it need `kms:Decrypt` and `kms:GenerateDataKey*` on the key. Each
statement is limited to the narrowest caller the service supports:

| Statement | Principal | Condition |
|---|---|---|
| `AllowCloudWatchAlarmsToPublish` | `cloudwatch.amazonaws.com` | `aws:SourceAccount` is this account, and `aws:SourceArn` matches this account's `praimana-*` alarms in this Region. Every alarm that notifies the topic is named `praimana-*`; an alarm with another name could not publish. The topic policy (`AlertsTopicPolicy`, statement `AllowCloudWatchAlarmsPublish`) grants `sns:Publish` with the same two conditions. |
| `AllowEventBridgeToPublish` | `events.amazonaws.com` | **None.** Amazon SNS does not support `aws:SourceAccount`, `aws:SourceArn` or `aws:SourceOrgID` in the key policy for EventBridge publishing to an encrypted topic ([Amazon SNS key management](https://docs.aws.amazon.com/sns/latest/dg/sns-key-management.html)), so adding them would stop the `praimana-kms-key-lifecycle` rule from delivering. What bounds it instead: the topic policy (`AlertsTopicPolicy`) allows `events.amazonaws.com` to publish only to `AlertsTopic` and only when `aws:SourceAccount` is this account, and the key grant is limited to decrypting and generating data keys for this one key. |
| `AllowSesToPublish`, `AllowLogDelivery` | `ses.amazonaws.com`, `delivery.logs.amazonaws.com` | `aws:SourceAccount` is this account. |

## Threat actors considered

Relevant (prioritized): External Attacker, Privileged User, Third Party (compromised local AI
assistant), Insider, Disgruntled Employee, Organized Crime. Excluded as low-relevance for a
single-tenant enterprise workshop sample: Nation-state, Terrorist Organization, Private-Sector
Offensive Actor, Script Kiddie (subsumed), Hacktivist, Competitor (subsumed).

---

*Methodology: STRIDE across six categories. Steps: business context → architecture (17 components,
10 data stores, 35 connections) → threat actors → trust boundaries (6 zones, 11 crossing points,
4 boundaries) → asset flows (7 assets, 13 flows) → threat identification (23 threats) → mitigation
planning (20 mitigations) → evidence-based code validation (23/23 threats and 20/20 mitigations with
file-level evidence) → residual-risk assessment → export. AWS service security configurations were assessed against AWS security best practices
(API Gateway JWT authorizers, least-privilege IAM, S3 public-access-block + TLS-only, KMS CMK,
AWS Secrets Manager for the portal session-signing key, a TLSv1.2_2021 floor at the CloudFront edge,
Amazon Bedrock Guardrails).*
