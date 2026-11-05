# Praimana

**Know how your team works with AI.**

Praimana is a self-hosted platform for running AI-assisted team workshops and seeing what actually
happened in them. Teams work on real problems with the AI coding assistant they already use, on
their own machines, in your own AWS account, and the work they produce (conversations, artefacts,
phase timings, consumption) becomes evidence you can review after the room empties.

The product's value is in **making the work visible**, not in mediating it. Praimana does not host a
model, choose prompts, or sit between a developer and their assistant. The assistant runs locally
under the participant's own subscription; Praimana captures and surfaces the record.

> The name is a respelling of the Sanskrit *pramāṇa* ("a means of valid knowledge", proof,
> evidence), with the letters **AI** inside it.

---

## What it is for

Praimana answers two questions an organisation running AI enablement actually has:

1. **Is AI-assisted development working for our teams?**
2. **How do we get better at it?**

The second is answered by the platform's main output: a per-member, coaching-oriented assessment of
how each person works with their assistant, drawn from that person's own conversations.

**What it is deliberately *not*:**

- Not an assistant bake-off, it works with whatever assistant a team already uses and ranks none.
- Not a cross-team league table.
- Not an individual performance instrument, the per-member output is coaching, read by an
  executive on the team, not a rating to manage people by.

---

## How it works

- A **facilitator** creates an experience, picks a format, and provisions teams from a spreadsheet.
- **Participants** install the desktop app, sign in with their invited email, and choose their
  assistant (Claude, Codex, or Kiro, whichever they already have).
- Teams work through three fixed phases, **Ideation → Build → Demo**, in their own repositories.
  Prompts, tool calls and replies happen locally; team chat, shared artefacts and phase progress
  keep everyone aligned.
- The facilitator watches without interrupting, and after the session the record stays: what each
  team built, how they got there, what it consumed, and the per-member coaching assessment.

Formats available: **Accelerator**, **Hackathon**, **Programme**, **Workshop**. Roles (each a Cognito
group): **Participant, Facilitator, Executive, Judge, Admin**.

---

## Demo

| Portal | Desktop |
|---|---|

https://github.com/user-attachments/assets/0a2bc49c-0a07-4335-9083-bda267ee683a

https://github.com/user-attachments/assets/39b1a1a8-07eb-4b8b-a577-94a683b5f8d0

---

## Architecture

Praimana is local-first at the edge and serverless in the middle. Everything deploys into **your own
AWS account**.

```
Desktop app ─┐
             ├─> API Gateway (JWT authorizer, rate limit) ─> ~15 Lambda services
Portal ──────┘                                                 │
                                                               ├─ DynamoDB (per-team state)
                                                               ├─ EventBridge (read-model sync)
                                                               ├─ S3 (docs, resources, artifacts)
                                                               ├─ SQS (dead-letter)
                                                               ├─ Cognito (identity, invite-only)
                                                               └─ CloudFront + Lambda (portal SSR)
```

### Repository layout

This repository is organized into top-level folders, one per component:

| Folder | What it is |
|---|---|
| **`portal/`** | Next.js facilitator/executive web app (SSR on Lambda behind CloudFront). Create experiences, provision teams, read team work, download the desktop app. |
| **`desktop/`** | Electron participant client. Runs the local AI assistant, team chat, a shared board, phases, and the repository the team works in. Distributed as a run-from-source zip. |
| **`services/`** | 15 Lambda packages behind the API — the HTTP services `identity`, `user-access`, `team`, `workshop`, `collaboration`, `evaluation`, `notify`, `docs`, `source`, `ai`, `desktop`, and the event/trigger Lambdas `bulk-provision`, `user-projection`, and the two Cognito triggers — plus two shared libraries. See `services/README.md` for the full accounting. |
| **`infra/`** | The CloudFormation that a customer deploys (`aws/app/` tiers, `aws/shared/` buckets). |

The platform is **invite-only**: Cognito is configured `AllowAdminCreateUserOnly`, so there is no
self-service sign-up. The first admin is bootstrapped out-of-band (see `infra/ADMIN-SETUP.md`), and
every subsequent account is provisioned by an existing admin.

---

## Getting started

### Deploy the platform

The application deploys as a set of CloudFormation tiers
(`kms → dynamodb → plumbing → [ses] → identity → api → portal → observability`). Full instructions,
including the two-apply Cognito callback cycle and the required S3 bucket-name suffix, are in:

- **`infra/SETUP.md`**, end-to-end deployment guide.
- **`infra/ADMIN-SETUP.md`**, bootstrapping the first admin user.
- **`infra/aws/app/README.md`**, tier-by-tier output→parameter wiring and seed data (formats,
  first admin).

SES/email is optional: without it the platform works fully (notifications fall back to a console
transport and email-OTP MFA is off).

### Run a component locally

Each component has its own README with build and run instructions:

- `portal/README.md`
- `desktop/README.md` (and `desktop/START-HERE.md` for the run-from-source flow)
- `services/README.md`
- `infra/README.md`

Typical loop (per component): install dependencies and build with the project's package manager, then
run its dev server or test suite. The portal and services use pnpm with the public npm registry; the
desktop client ships `start.sh` / `start.bat` that install, build and launch it from source.

### Install the desktop client

Participants download a source zip from the portal, drop a `connect.json` (the experience's config)
next to the start script, and run `./start.sh` (macOS/Linux) or `start.bat` (Windows). The app builds
on first run and opens on a Connect screen pre-filled for the platform. See `desktop/START-HERE.md`.

---

## Security model

- **Private by default.** The repository is never uploaded; the assistant runs locally under the
  participant's own credentials. Conversation transcripts do sync (that is the product), and the
  platform is explicit about that.
- **Invite-only identity.** Admin-provisioned Cognito accounts; roles are Cognito groups, and
  authorization is enforced server-side with deny-by-default grant matrices.
- **Deployed into the customer's account.** No multi-tenant shared data plane; each customer runs
  their own stack.

Security scanning uses SAST (Semgrep), IaC scanning (Checkov, cfn-nag), secret scanning, and
dependency vulnerability (SCA) gates. Controls that trip a scanner but are false positives or
accepted residuals carry inline suppressions with reasons.

See [SECURITY.md](SECURITY.md) for how to report a vulnerability and for the platform's STRIDE
threat model.

---

## Roadmap

Planned features include @mentions and pinned messages in team chat, automatic teammate notification
and live relay for shared AI chats, single sign-on for the portal and desktop, showing the model used
in each AI chat, and AI response analysis across models and assistants. See
[ROADMAP.md](ROADMAP.md) for details, and [RELEASE-NOTES.md](RELEASE-NOTES.md) for what shipped in
each release.

---

## Important Notes

This is sample code, for non-production usage. You should work with your security and legal teams
to meet your organizational security, regulatory and compliance requirements before deployment.

- **This is sample code, not a production service.** Praimana demonstrates how to use AWS services
  to run and observe AI-assisted team workshops. It is provided as a starting point for your own
  implementation, not as a maintained software product.
- **No warranty.** This code is provided as-is. Review, test, and adapt it for your environment
  before any production use.
- **Your responsibility.** Once deployed in your account, you are responsible for the security,
  cost, and operational management of these resources per the
  [AWS Shared Responsibility Model](https://aws.amazon.com/compliance/shared-responsibility-model/).
- **Not published to package indexes.** These samples are not available via pip, npm, or Maven.
  Clone this repository to use them.
- **Feedback welcome.** File issues or pull requests on GitHub. We review contributions but cannot
  guarantee response times. See [CONTRIBUTING.md](CONTRIBUTING.md) and the
  [Code of Conduct](CODE_OF_CONDUCT.md).

## License

This library is licensed under the MIT-0 License. See the [LICENSE](LICENSE) file.
