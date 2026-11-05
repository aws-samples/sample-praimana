# Roadmap

Planned features for Praimana. Nothing here is committed to a date, and scope may change as the
features are designed. Suggestions and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

| # | Feature | Area | Status |
|---|---|---|---|
| 1 | [@mentions and pinned messages in team chat](#1-mentions-and-pinned-messages-in-team-chat) | Desktop, collaboration service | Planned |
| 2 | [Automatic teammate notification on shared AI chats](#2-automatic-teammate-notification-on-shared-ai-chats) | Desktop, AI and notify services | Planned |
| 3 | [Live relay of shared AI chats](#3-live-relay-of-shared-ai-chats) | Desktop, AI service | Planned |
| 4 | [Single sign-on for the portal and desktop](#4-single-sign-on-for-the-portal-and-desktop) | Identity, portal, desktop, infra | Planned |
| 5 | [Show the model used in each AI chat](#5-show-the-model-used-in-each-ai-chat) | Desktop, portal, AI service | Planned |
| 6 | [AI response analysis across models and assistants](#6-ai-response-analysis-across-models-and-assistants) | Portal, AI and evaluation services | Planned |

---

## 1. @mentions and pinned messages in team chat

**Today:** team chat recognises file names in a message but not people. There is no way to direct a
message at one member or keep an important message in view.

**Planned:**

- Type `@` in team chat to pick a member of your own team from a list. The mention is stored as the
  member's user ID, not as display text, so it survives a name change.
- A mentioned member gets a distinct unread badge and chime, even when team chat notifications are
  otherwise quiet.
- Any team member can pin a message. Pinned messages appear in a strip at the top of team chat until
  someone unpins them, and the strip shows who pinned each one.
- Mentioning someone and pinning are separate actions, so a pin is not a way to page a person.

**Design notes:** mentions are limited to the sender's own team, and the collaboration service
checks this server-side. A cap on pinned messages per team keeps the strip readable.

## 2. Automatic teammate notification on shared AI chats

**Today:** a member can share an AI chat, and teammates can read it in the **Team** tab. Nobody is
told when the assistant's reply is waiting on a decision that someone else on the team should make,
so the owner has to notice, switch to team chat and explain.

**Planned:**

- When an assistant reply in a shared AI chat needs input, Praimana notifies teammates automatically.
  A reply needs input when it ends by asking a question, offers options to choose between, or is
  waiting on a permission or approval.
- Teammates who are named in the reply, or who wrote files the reply refers to, are notified first.
  When no one is identified, every teammate following the chat is notified.
- The notification opens the shared chat at that reply. A teammate answers with a comment, and the
  owner chooses whether to include it in the next prompt, so the assistant runs only when the owner
  decides.
- The owner turns automatic notifications on or off per shared chat, and can also notify a teammate
  by hand from any reply.
- A pending request shows as open until answered or dismissed, so the team can see what is waiting
  on whom.

**Design notes:** detection runs on the owner's desktop when the reply completes, so no extra
transcript content leaves the machine beyond what sharing already syncs. Notifications are
rate-limited per chat so a long session cannot flood the team. Teammates never prompt the owner's
assistant directly, because it runs locally under the owner's credentials. Requests, comments and
their timing become part of the session record the facilitator reviews.

## 3. Live relay of shared AI chats

**Today:** a shared AI chat is a snapshot that teammates open from the **Team** tab. New turns appear
only when they reopen it.

**Planned:**

- When sharing, the owner can turn on **Live**. New turns then stream to teammates who have the chat
  open, and others see an unread badge on the **Team** tab.
- The owner can pause or stop the relay at any time, and a banner on their chat shows while it is on.
- Teammates can follow a live chat in the second pane next to their own work.

**Design notes:** the relay is opt-in per chat and off by default, because a live view of someone's
prompts is more exposing than a finished snapshot. It reuses the existing push channel for team
events.

## 4. Single sign-on for the portal and desktop

**Today:** every account is a Cognito user provisioned by an admin, and users sign in with an email
and password plus MFA. Organisations with a corporate identity provider still have to manage a
separate Praimana password for each person.

**Planned:**

- Optional federation of the Cognito user pool with a SAML 2.0 or OpenID Connect identity provider,
  for example Microsoft Entra ID, Okta or AWS IAM Identity Center. Federation is configured through
  CloudFormation parameters, and no identity provider is configured by default.
- Portal: a **Sign in with your organisation** button through Cognito Managed Login.
- Desktop: the same sign-in through the system browser, using the existing PKCE loopback flow. The
  native email-and-password sign-in stays available when SSO is not configured.
- The platform remains invite-only. A federated user can sign in only if an admin has invited that
  email, and roles still come from Praimana's Cognito groups, not from the identity provider.

**Design notes:** federated sign-ins are linked to the invited account by email. Group mapping from
identity provider claims is out of scope at first, to avoid a provider claim granting the Admin or
Executive role. MFA is left to the identity provider for federated users.

## 5. Show the model used in each AI chat

**Today:** each AI chat records which assistant ran it (Claude, Codex or Kiro), but not which model
answered. A chat can switch models partway through, and neither the owner nor a reviewer can tell.

**Planned:**

- Every assistant reply records the model that produced it, as reported by the assistant CLI (for
  example a Claude Sonnet or Opus model ID, or the Bedrock model ID when the assistant runs through
  Amazon Bedrock).
- The desktop shows the model on each reply and in the chat header, and marks the point where the
  model changed.
- Shared chats in the **Team** tab, and the transcripts facilitators and executives read in the
  portal, show the same model labels.

**Design notes:** the model is captured from the assistant's own output, never inferred from
settings, because a wrapper or profile can override the configured model. When an assistant does not
report it, the reply is labelled **Model not reported** rather than guessed. Older chats without
model data show the assistant only.

## 6. AI response analysis across models and assistants

**Today:** the per-member coaching assessment describes how each person works with their assistant.
It deliberately does not compare assistants, and there is no view of how different models performed
on the same experience.

**Planned:**

- A portal view for facilitators and executives that compares AI responses by assistant and by
  model across an experience, using the model data from feature 5.
- Measures already captured or derivable from the transcript: response time, token use and cost,
  number of turns to finish a task, tool calls, and how often the participant rejected, retried or
  rewrote a reply.
- Filters by phase (Ideation, Build, Demo), team and date, and drill-down from any figure to the
  replies behind it.
- Results can be exported as CSV for the organisation's own analysis.

**Design notes:** this sits alongside the coaching assessment, not inside it, and keeps the
platform's stance that Praimana is not an assistant bake-off or a league table. Comparisons are
shown with sample sizes and are only drawn between teams doing the same experience, because
different tasks make raw numbers misleading. Figures are aggregated by assistant and model, never
ranked by person.
