# Creating the first ADMIN user

The platform has **no self-service sign-up**. The Cognito user pool is created with
`AllowAdminCreateUserOnly: true`, so the `SignUp` API is refused outright, and the pre-signup
Lambda trigger gates the admin-create path too — an `AdminCreateUser` call for an address with no
matching invitation row is rejected with *"Registration is by invitation only."* and no account is
created.

Once **any** ADMIN exists, every further account (admins included) is provisioned the normal way:
`POST /v1/user-access/provision`, which does the whole sequence — invitation lookup →
`AdminCreateUser` → group assignment → profile row — synchronously behind an ADMIN token. That
service **cannot mint the first admin**, because it needs an ADMIN token to call it. `ROLES.md`
states the rule: *"A FACILITATOR cannot mint an ADMIN. The first admin comes from the seeded
bootstrap."*

This document is that bootstrap. It is the authoritative, step-by-step version of the procedure
summarised in the header of [`aws/app/platform-identity.yaml`](aws/app/platform-identity.yaml) and
referenced from [`SETUP.md`](SETUP.md) §2.6.

> ⚠ **This is the one part of the platform CloudFormation cannot deliver.** Steps 1, 3 and 4 write
> **data**, not resources. They never appear as stack drift and a customer does not get them by
> deploying a template. Whoever stands up an environment runs them **once**.

---

## Why four steps, and why in this order

The admin-create path does **not** reuse the self-signup machinery, so three of the side effects
the self-signup triggers would perform have to be done explicitly:

| | What runs it on self-signup | On admin-create |
|---|---|---|
| Admit the registration | pre-signup trigger (reads the invitation) | **same trigger still fires** — so the invitation row must exist **first** (step 1) |
| Create the account | the user, via `SignUp` | you, via `AdminCreateUser` (step 2) |
| Assign the Cognito group | post-confirmation trigger | **nothing does this** — assign it yourself (step 3) |
| Write the profile row | post-confirmation trigger | **nothing does this** — write it yourself (step 4) |

The post-confirmation trigger serves the self-signup path only. Measured on a live pool: an
admin-created user completing their forced password change reaches `UserStatus: CONFIRMED` and that
function produces **zero** log events — no group, no profile row. That is why steps 3 and 4 are
manual here.

The **order matters**: the invitation (step 1) must exist before `AdminCreateUser` (step 2), or the
pre-signup gate refuses the account.

---

## Prerequisites

- Admin-level AWS credentials for the account the platform is deployed into (CloudFormation,
  Cognito, DynamoDB). See `SETUP.md` for how this deployment reaches its account.
- The `praimana-identity` stack deployed, so the user pool exists.
- The target email in **lowercase** — the pre-signup/post-confirmation triggers query the
  invitations `email-index` by the address exactly as given.

Collect these values from the `praimana-identity` stack and set them as shell variables so the
commands below are copy-pasteable:

```bash
REGION=us-east-1

POOL=$(aws cloudformation describe-stacks --stack-name praimana-identity --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)

EMAIL=admin@example.com          # <-- the admin's email, LOWERCASE

echo "pool=$POOL  email=$EMAIL"
```

Table names are fixed by the templates: invitations are in `praimana-invitations` (with an
`email-index` GSI) and profiles in `praimana-users` (partition key `id`).

---

## Step 1 — Seed the invitation

`teamId` is the invitations table's **partition key**, and DynamoDB will not store an item without
one. A platform-level (team-less) invitation uses the sentinel `"PLATFORM"`.

```bash
aws dynamodb put-item --table-name praimana-invitations --region "$REGION" --item "{
  \"teamId\":       {\"S\": \"PLATFORM\"},
  \"email\":        {\"S\": \"$EMAIL\"},
  \"scope\":        {\"S\": \"PLATFORM\"},
  \"platformRole\": {\"S\": \"ADMIN\"},
  \"status\":       {\"S\": \"PENDING\"}
}"
```

Rules the triggers enforce on this row:

- ⚠ **`email` must be lowercase** — the trigger queries `email-index` by the address as given.
- ⚠ **`status` must be `PENDING`** — `ACCEPTED` or `REVOKED` is refused. (A missing `status` counts
  as `PENDING`, but write it explicitly.)
- ⚠ **`platformRole` is where the role comes from** — never from the client. Absent means
  `PARTICIPANT`.
- `expiresAt` is optional; a **missing** value counts as **not expired**.

Verify it is queryable the way the trigger will read it:

```bash
aws dynamodb query --table-name praimana-invitations --region "$REGION" --index-name email-index \
  --key-condition-expression "email = :e" \
  --expression-attribute-values "{\":e\":{\"S\":\"$EMAIL\"}}" \
  --query "Items[].{email:email.S,role:platformRole.S,status:status.S,scope:scope.S}" --output json
```

## Step 2 — Create the Cognito account

The pre-signup gate now passes because the invitation exists.

```bash
aws cognito-idp admin-create-user --user-pool-id "$POOL" --region "$REGION" \
  --username "$EMAIL" \
  --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true \
  --query 'User.{username:Username,status:UserStatus,enabled:Enabled}' --output json
```

Expected: `UserStatus: FORCE_CHANGE_PASSWORD`, `Enabled: true`.

Cognito emails a **temporary password**. With no SES/`EmailFrom` configured it is sent by Cognito's
own sender (rate-limited, roughly 50/day), so the address must be one you can actually receive at.

> If the email does not arrive (default Cognito emails are sometimes filtered, and a `+` alias can
> trip spam rules), set a password directly instead:
>
> ```bash
> aws cognito-idp admin-set-user-password --user-pool-id "$POOL" --region "$REGION" \
>   --username "$EMAIL" --password '<a-strong-temporary-password>'   # omit --permanent to force a reset at first login
> ```

## Step 3 — Assign the ADMIN group

The Cognito group drives the `cognito:groups` claim, which is the role source of truth. Nothing does
this for an admin-created user.

```bash
aws cognito-idp admin-add-user-to-group --user-pool-id "$POOL" --region "$REGION" \
  --username "$EMAIL" --group-name ADMIN
```

Verify:

```bash
aws cognito-idp admin-list-groups-for-user --user-pool-id "$POOL" --username "$EMAIL" \
  --region "$REGION" --query "Groups[].GroupName" --output json      # ["ADMIN"]
```

## Step 4 — Write the profile row

The profile store `praimana-users` is keyed by the Cognito **`sub`** (not the email). Resolve the
sub from the account, then write the row. The field shape mirrors
`services/user-access/src/domain.ts` and `services/cognito-postconfirmation/src/handler.ts`, which
are required to agree — read one of them rather than inventing fields.

```bash
SUB=$(aws cognito-idp admin-get-user --user-pool-id "$POOL" --username "$EMAIL" --region "$REGION" \
  --query "UserAttributes[?Name=='sub'].Value | [0]" --output text)

NOW=$(python3 -c 'import datetime;print(datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"))')

aws dynamodb put-item --table-name praimana-users --region "$REGION" \
  --condition-expression "attribute_not_exists(id)" --item "{
  \"id\":           {\"S\": \"$SUB\"},
  \"email\":        {\"S\": \"$EMAIL\"},
  \"role\":         {\"S\": \"ADMIN\"},
  \"authProvider\": {\"S\": \"COGNITO\"},
  \"name\":         {\"S\": \"$EMAIL\"},
  \"createdAt\":    {\"S\": \"$NOW\"},
  \"updatedAt\":    {\"S\": \"$NOW\"}
}"
```

Field notes:

- **`id`** is the Cognito `sub`.
- **`role`** is `ADMIN` and is authoritative — it comes from the invitation, never from a client.
- **`authProvider`** is always `COGNITO`.
- **`name`** is seeded to the email so the row always has something renderable; the user can change
  it later via `PATCH /me`.
- **`firstName` / `lastName` / `organization` are deliberately left absent.** Their absence is what
  makes `profileComplete` false, which drives the first-login completion gate. Do **not** pre-fill
  them.
- The `attribute_not_exists(id)` condition makes the write safe to retry — it refuses to clobber an
  existing row.

## Then: first sign-in

Sign in at the portal (the `PortalUrl` output of `praimana-portal-app`) or the desktop app with the
temporary password, and set a new one. On first login the profile-completeness gate asks for first
name, last name and organization — this is expected, and is why step 4 left those fields blank.

---

## Verify end-to-end

```bash
# Cognito account state
aws cognito-idp admin-get-user --user-pool-id "$POOL" --username "$EMAIL" --region "$REGION" \
  --query '{username:Username,status:UserStatus,enabled:Enabled}' --output json

# Group
aws cognito-idp admin-list-groups-for-user --user-pool-id "$POOL" --username "$EMAIL" \
  --region "$REGION" --query "Groups[].GroupName" --output json

# Profile row
SUB=$(aws cognito-idp admin-get-user --user-pool-id "$POOL" --username "$EMAIL" --region "$REGION" \
  --query "UserAttributes[?Name=='sub'].Value | [0]" --output text)
aws dynamodb get-item --table-name praimana-users --region "$REGION" \
  --key "{\"id\":{\"S\":\"$SUB\"}}" \
  --query "Item.{id:id.S,email:email.S,role:role.S,authProvider:authProvider.S}" --output json
```

A `FORCE_CHANGE_PASSWORD` (or `CONFIRMED` after first login) enabled user, a `["ADMIN"]` group, and
a profile row with `role: ADMIN` mean the admin is fully wired.

---

## Worked example — placeholder values

The same bootstrap, with every environment-specific value shown as a placeholder. Substitute your
own; nothing real (no account IDs, emails, pool IDs, bucket names, or URLs) is recorded in this repo.

| Field | Example value |
|---|---|
| Email | `admin@your-org.example` |
| User pool | `<region>_XXXXXXXXX` (the `UserPoolId` stack output) |
| ADMIN group precedence | `0` |
| Cognito `sub` / profile `id` | the user's `sub` attribute (a UUID) |
| Portal URL | the `PortalUrl` output of `praimana-portal-app` |
| Account reached via | your deployment's access path (e.g. an assumed role into the target account) |

The account is created with `UserStatus: FORCE_CHANGE_PASSWORD`; Cognito emails the temporary
password. First sign-in and password change are the user's own step.

---

## Troubleshooting

- **`AdminCreateUser` fails with "Registration is by invitation only."** — Step 1 was skipped, the
  email case differs from the invitation row, or the row's `status` is not `PENDING`. The pre-signup
  trigger reads `email-index`; re-run the verify query in step 1.
- **User signs in but has no admin powers.** — The group was not assigned (step 3) or the profile
  row's `role` is wrong (step 4). The `cognito:groups` claim is the source of truth; confirm
  `admin-list-groups-for-user` returns `["ADMIN"]`, then have the user sign out and back in so a
  fresh token carries the claim.
- **No temp-password email.** — Use the `admin-set-user-password` fallback in step 2 (omit
  `--permanent` so the user still resets it at first login).
- **A second admin, once this one exists.** — Do **not** repeat this bootstrap. Use the in-app
  invite flow / `POST /v1/user-access/provision` under this admin's token, which does all four steps
  for you.
