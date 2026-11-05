# Release notes

## v1.0.0 — first public release

The first public release of Praimana as an AWS sample. The portal, desktop client, services and
infrastructure templates all ship as one release at version `1.0.0`. The CloudFormation tiers default
`ReleaseVersion` and `PortalReleaseVersion` to `1.0.0`, matching each component's `package.json`.

This is sample code for non-production use. See [Important Notes](README.md#important-notes).

### Highlights

**Workshops end to end**

- Facilitators create an experience in one of four formats (Accelerator, Hackathon, Programme,
  Workshop) and provision teams from a spreadsheet.
- Teams work through three phases, Ideation → Build → Demo, in their own repositories.
- Five roles, each a Cognito group: Participant, Facilitator, Executive, Judge, Admin.
- Submission and judging: a team drafts one submission, its executive releases it, and judges score
  a pinned snapshot of the released work. Scores are immutable once submitted and visible only to
  the facilitator.
- After the session, a per-member coaching assessment of how each person works with their AI
  assistant, drawn from their own conversations.

**Desktop client** (`desktop/`)

- Runs the participant's own AI coding assistant locally: Claude, Codex or Kiro, under the
  participant's own subscription and credentials.
- Team chat, shared board, phases and team documents, with live push updates and unread badges.
- Share an AI chat with the team, and read teammates' shared chats in the **Team** tab.
- Native in-app sign-in with MFA (authenticator app, email code or SMS code).
- Distributed as a run-from-source zip with `start.sh` / `start.bat` and a `connect.json` from the
  portal.
- Full feature inventory: [desktop/RELEASE-NOTES.md](desktop/RELEASE-NOTES.md).

**Portal** (`portal/`)

- Next.js web app for facilitators, executives, judges and admins, server-rendered on Lambda behind
  CloudFront.
- Create experiences, provision teams, read team work and download the desktop client.

**Services** (`services/`)

- 15 Lambda packages behind API Gateway with a JWT authorizer and rate limiting, plus two shared
  libraries.
- DynamoDB for per-team state, EventBridge for read-model sync, S3 for documents and artifacts, and
  SQS dead-letter queues.

**Infrastructure** (`infra/`)

- CloudFormation tiers deployed into your own AWS account:
  `kms → dynamodb → plumbing → [ses] → identity → api → portal → observability`.
- Customer-managed KMS key for DynamoDB tables, log groups, secrets, SNS and SQS.
- Optional SES; without it, notifications fall back to a console transport.
- Guides: [infra/SETUP.md](infra/SETUP.md) and [infra/ADMIN-SETUP.md](infra/ADMIN-SETUP.md).

### Security

- Invite-only identity: Cognito with admin-only account creation and server-side, deny-by-default
  authorization.
- The repository a team works in is never uploaded. Conversation transcripts do sync, by design.
- STRIDE threat model and vulnerability reporting in [SECURITY.md](SECURITY.md).
- Scanned with Semgrep, Checkov, cfn-nag, trivy, gitleaks and dependency (SCA) checks. Accepted
  findings are recorded with reasons in [.trivyignore.yaml](.trivyignore.yaml) and as inline
  suppressions in the templates.

### Known limitations

- X-Ray tracing is off for the portal Lambda function. Backend functions trace by default. To enable
  it, see the AWS-0066 entry in [.trivyignore.yaml](.trivyignore.yaml).
- Teams have no route to judge feedback. This follows from restricting score visibility to the
  facilitator.
- No single sign-on yet. It is planned, along with other features, in [ROADMAP.md](ROADMAP.md).
