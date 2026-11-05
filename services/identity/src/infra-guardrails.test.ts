import { describe, it, expect } from "vitest";
import {
  hasInfrastructureTemplate,
  infrastructureTemplateText,
  TEMPLATE_ABSENT_TODO,
} from "@praimana/service-shared";

/**
 * ── ⚠ TWO INFRASTRUCTURE PROPERTIES THAT NOTHING ELSE CAN CATCH ────────────────────────────
 *
 * Both were added after an audit, and both fail SILENTLY if reverted: a widened IAM role
 * deploys green and works perfectly, and a table without point-in-time recovery behaves identically to one
 * with it right up until the moment somebody needs to restore it.
 *
 * No unit test exercises IAM. No unit test exercises backups. A template assertion is the only place this
 * knowledge can live, so it lives here — next to the service that prompted both changes.
 *
 * ⚠ THIS CANNOT PROVE THE DEPLOYED STACK MATCHES THE TEMPLATE. That takes a probe against a deployed account
 * (`describe-continuous-backups`, `get-role-policy`), which is how such gaps are found.
 */

/**
 * ⚠ `infrastructureTemplateText()` RETURNS "" WHEN THE TEMPLATE IS ABSENT, NOT NULL, and the
 * difference decides whether this file loads. Module-scope helpers below derive values from
 * TEMPLATE during COLLECTION, before any `describe` runs, so a null would throw and the file would
 * FAIL rather than skip. `HAS_TEMPLATE` is what gates the assertions.
 */
const TEMPLATE = infrastructureTemplateText();
const HAS_TEMPLATE = hasInfrastructureTemplate();

/** A resource's YAML block: from `  Name:` to the next top-level-indented resource. */
function resourceBlock(logicalId: string): string {
  // ⚠ NO-OP WITHOUT THE TEMPLATE — the `expect` below would fail the FILE rather than skip it.
  // Module scope and describe bodies run during collection, before `describe.skipIf` applies.
  if (!HAS_TEMPLATE) return "";
  const start = TEMPLATE.indexOf(`\n  ${logicalId}:\n`);
  expect(start, `${logicalId} must exist in the template`).toBeGreaterThan(-1);
  const rest = TEMPLATE.slice(start + 1);
  const next = rest.search(/\n {2}[A-Za-z][A-Za-z0-9]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

/** Strip comments — assertions about PERMISSIONS must read what IAM receives, not the prose above it. */
const code = (block: string) =>
  block
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");

describe.skipIf(!HAS_TEMPLATE)("⚠ identity does not share a role with the other fourteen functions", () => {
  /**
   * WHY THIS MATTERS. The health and spend panels need `cloudwatch:DescribeAlarms` and
   * `ce:GetCostAndUsage`, and NEITHER can be resource-scoped (the alarm one was tried, deployed, and
   * returned AccessDenied live). On the shared `LambdaExecutionRole` that meant every service could read the
   * account's alarm states and its bill so that two panels could exist on one admin screen.
   */
  const shared = code(resourceBlock("LambdaExecutionRole"));
  const identityRole = code(resourceBlock("IdentityFunctionRole"));
  const identityFn = code(resourceBlock("IdentityFunction"));

  it("the account-wide reads are NOT on the shared role", () => {
    expect(shared).not.toMatch(/cloudwatch:DescribeAlarms/);
    expect(shared).not.toMatch(/ce:GetCostAndUsage/);
  });

  it("they ARE on identity's own role", () => {
    expect(identityRole).toMatch(/cloudwatch:DescribeAlarms/);
    expect(identityRole).toMatch(/ce:GetCostAndUsage/);
  });

  it("and the identity function actually USES that role", () => {
    // The half that would be easy to forget: a new role nothing references changes nothing.
    expect(identityFn).toMatch(/Role: !GetAtt IdentityFunctionRole\.Arn/);
    expect(identityFn, "it must no longer take the shared role").not.toMatch(/LambdaExecutionRole/);
  });

  it("⚠ is TIGHTER than the shared role, not just a copy of it — three tables, not the wildcard", () => {
    /**
     * Identity names exactly three tables in its own source (TABLE_USERS, TABLE_FEEDBACK,
     * TABLE_COST_CACHE). Scoping to them means it cannot reach the other 31 — which is the actual
     * least-privilege win, as distinct from merely relocating two grants.
     */
    expect(identityRole).not.toMatch(/table\/praimana-\*/);
    for (const table of ["praimana-users", "praimana-feedback", "praimana-cost-cache"]) {
      expect(identityRole, table).toContain(table);
    }
  });

  it("⚠ grants no DELETE and no batch/transactional writes", () => {
    // `grep "new .*Command"` across apps/services/identity/src returns Get/Put/Update/Query/Scan/BatchGet
    // and nothing else. Granting the destructive forms anyway is how a wildcard creeps back in by default.
    for (const action of ["dynamodb:DeleteItem", "dynamodb:BatchWriteItem", "dynamodb:TransactWriteItems"]) {
      expect(identityRole, action).not.toContain(action);
    }
  });

  it("does not carry the workshop invoke grant it never used", () => {
    // Identity's only east-west call is to notify (notifier.http.ts is the sole callService site).
    expect(identityRole).not.toMatch(/function:praimana-workshop/);
    expect(identityRole, "but it does still reach notify").toMatch(/function:praimana-notify/);
  });

  it("keeps the shared role intact for everyone else", () => {
    // Trimming two grants must not have removed anything the other fourteen functions rely on.
    for (const kept of ["DynamoDBAccess", "EventBridgePublish", "NotifyServiceInvoke"]) {
      expect(shared, kept).toContain(kept);
    }
    // KMS use arrives as the shared customer-managed policy rather than an inline statement.
    expect(shared, "KmsUsePolicy").toContain("!Ref KmsUsePolicy");
    // And the audit table's append-only Deny — the one thing in that role that is a safety property.
    expect(shared).toMatch(/Effect: Deny/);
    expect(shared).toContain("praimana-audit");
  });
});

describe.skipIf(!HAS_TEMPLATE)("⚠ point-in-time recovery covers the data nobody can reconstruct", () => {
  /**
   * The audit that prompted this: 27 of 34 tables had no PITR, including `submissions-v2`, `scores` and
   * `workshop-results` — the judged work, the judges' scores, and the published places. A platform whose
   * entire output is a ranked result could not recover that result.
   */
  const SOURCE_OF_TRUTH = [
    "SubmissionsTable",
    "ScoresTable",
    "WorkshopResultsTable",
    "TeamPhasesTable",
    "PhasesTable",
    "MessagesTable",
    "AIThreadsTable",
    "AIMessagesTable",
    "TasksTable",
    "TeamMembersTable",
    "InvitationsTable",
    "DocsTable",
    "GitCommitsTable",
    "GitFilesTable",
    "MemberRatingsTable",
    "AccountsTable",
    "FeedbackTable",
    // Already had it before the audit — asserted so a later edit cannot quietly drop them.
    "UsersTable",
    "TeamsTable",
    "WorkshopsTable",
    "AuditTable",
  ];

  for (const table of SOURCE_OF_TRUTH) {
    it(`${table} is recoverable`, () => {
      expect(code(resourceBlock(table))).toMatch(/PointInTimeRecoveryEnabled: true/);
    });
  }

  /**
   * The derived tables are asserted too. They are rebuildable — the `*-users-readmodel` tables from the
   * DynamoDB Stream on `praimana-users`, and the cost cache by expiring — so a restore is never the way
   * to repair them. PITR is enabled on them anyway, because every table in this platform is encrypted
   * and recoverable by policy; asserting it keeps a later edit from quietly dropping it.
   */
  const REBUILDABLE = [
    "AiUsersReadModel",
    "TeamUsersReadModel",
    "CollaborationUsersReadModel",
    "EvaluationUsersReadModel",
    "SourceUsersReadModel",
    "DocsUsersReadModel",
    "CostCacheTable",
  ];

  for (const table of REBUILDABLE) {
    it(`${table} is recoverable too, though it is derived`, () => {
      expect(code(resourceBlock(table))).toMatch(/PointInTimeRecoveryEnabled: true/);
    });
  }

  it("every DynamoDB table in the templates has PITR", () => {
    const tables = [...TEMPLATE.matchAll(/^ {2}(\w+):\n {4}Type: AWS::DynamoDB::Table$/gm)].map((m) => m[1]);
    expect(tables.length, "no DynamoDB tables found — did the template layout change?").toBeGreaterThan(0);
    for (const table of tables) {
      expect(code(resourceBlock(table)), table).toMatch(/PointInTimeRecoveryEnabled: true/);
    }
  });

  it("EvaluationActivityReadModel keeps its PITR even though it is a read-model", () => {
    /**
     * ⚠ THE EXCEPTION THAT PROVES THE RULE IS ABOUT REBUILDABILITY, NOT ABOUT THE WORD "read-model". This
     * one is fed by EventBridge events, which are transient — once they are gone the counters cannot be
     * recomputed from anything. The `*-users-readmodel` tables are fed by a DynamoDB Stream from a table
     * that still holds the truth, which is why they are the ones that can be dropped.
     */
    expect(code(resourceBlock("EvaluationActivityReadModel"))).toMatch(/PointInTimeRecoveryEnabled: true/);
  });
});

describe.skipIf(!HAS_TEMPLATE)("⚠ customer content buckets are encrypted with the platform CMK", () => {
  /**
   * DocsBucket holds team documents and ResourcesBucket holds facilitator workshop material — the two
   * buckets with customer content. Both use SSE-KMS with the platform key. A scanner cannot confirm
   * this (the key is a `!Ref` to a required parameter), so `.trivyignore.yaml` records the finding as
   * a false positive for the whole file — and this test is what stops a revert to SSE-S3 hiding behind
   * that entry.
   */
  for (const bucket of ["DocsBucket", "ResourcesBucket"]) {
    it(`${bucket} uses SSE-KMS with the platform key and an S3 Bucket Key`, () => {
      const block = code(resourceBlock(bucket));
      expect(block).toMatch(/SSEAlgorithm: aws:kms/);
      expect(block).toMatch(/KMSMasterKeyID: !Ref KmsKeyArn/);
      expect(block).toMatch(/BucketKeyEnabled: true/);
      expect(block).not.toMatch(/SSEAlgorithm: AES256/);
    });
  }
});

describe.skipIf(!HAS_TEMPLATE)("⚠ the portal edge never accepts TLS 1.0 or 1.1", () => {
  /**
   * The default *.cloudfront.net certificate fixes the viewer policy at TLSv1. Only an alias with its
   * own ACM certificate can raise the floor, so the domain and certificate are required parameters and
   * the viewer certificate is unconditional. A revert to an optional domain would deploy green.
   */
  const distribution = code(resourceBlock("PortalDistribution"));

  it("always serves the custom domain with its own certificate at TLSv1.2_2021", () => {
    expect(distribution).toMatch(/Aliases: \[!Ref PortalDomainName\]/);
    expect(distribution).toMatch(/AcmCertificateArn: !Ref PortalCertificateArn/);
    expect(distribution).toMatch(/MinimumProtocolVersion: TLSv1\.2_2021/);
    expect(distribution).toMatch(/SslSupportMethod: sni-only/);
  });

  it("has no branch back to the default certificate", () => {
    expect(distribution).not.toMatch(/CloudFrontDefaultCertificate/);
    expect(distribution).not.toMatch(/ViewerCertificate: !If/);
    expect(TEMPLATE).not.toMatch(/HasPortalDomain/);
  });

  it("requires the domain and certificate parameters", () => {
    for (const parameter of ["PortalDomainName", "PortalCertificateArn"]) {
      const blocks = TEMPLATE.split(`\n  ${parameter}:\n`).slice(1);
      expect(blocks.length, `${parameter} must be declared`).toBeGreaterThan(0);
      for (const block of blocks) {
        const declaration = block.slice(0, block.search(/\n {2}[A-Za-z]/));
        expect(declaration, `${parameter} must have no default`).not.toMatch(/\n {4}Default:/);
        expect(declaration, `${parameter} must not accept empty`).not.toMatch(/AllowedPattern: "\^\$\|/);
      }
    }
  });
});

describe.skipIf(!HAS_TEMPLATE)("⚠ the portal session key lives in Secrets Manager, not in Lambda config", () => {
  /**
   * NEXTAUTH_SECRET mints a session for any user at any role. As a Lambda environment variable it was
   * readable in plaintext with lambda:GetFunctionConfiguration. The function now holds only the
   * secret's ARN and reads the value at cold start.
   */
  const secret = code(resourceBlock("PortalSessionSecret"));
  const fn = code(resourceBlock("PortalFunction"));
  const role = code(resourceBlock("PortalFunctionRole"));
  const build = code(resourceBlock("PortalBuildProject"));

  it("the secret is generated in-stack and encrypted with the platform key", () => {
    expect(secret).toMatch(/Type: AWS::SecretsManager::Secret/);
    expect(secret).toMatch(/KmsKeyId: !Ref KmsKeyArn/);
    expect(secret).toMatch(/GenerateStringKey: NEXTAUTH_SECRET/);
    expect(secret, "no literal value in the template").not.toMatch(/^\s+SecretString:/m);
  });

  it("the function carries the ARN and not the value", () => {
    expect(fn).toMatch(/NEXTAUTH_SECRET_ARN: !Ref PortalSessionSecret/);
    expect(fn).not.toMatch(/^\s+NEXTAUTH_SECRET:/m);
    expect(TEMPLATE).not.toMatch(/PortalNextAuthSecret/);
  });

  it("the function role can read that one secret and no other", () => {
    expect(role).toMatch(/secretsmanager:GetSecretValue/);
    const grant = role.slice(role.indexOf("secretsmanager:GetSecretValue"));
    expect(grant).toMatch(/Resource: !Ref PortalSessionSecret/);
    expect(role).not.toMatch(/secretsmanager:\*/);
  });

  it("the Lambda package starts through the secret loader", () => {
    expect(build).toMatch(/cp lambda\/load-session-secret\.cjs \/pkg\/load-session-secret\.cjs/);
    expect(build).toMatch(/exec node load-session-secret\.cjs/);
    expect(build).not.toMatch(/exec node server\.js/);
  });
});

describe.skipIf(!HAS_TEMPLATE)("⚠ the docs and desktop functions get their bucket AND its owner from the template", () => {
  /**
   * Both stores throw at start-up when either value is missing (no fallback bucket name, because S3
   * names are global), and send the owner as ExpectedBucketOwner on every request. Dropping one of
   * these variables would deploy green and then fail every docs or installer request.
   */
  const docsFn = code(resourceBlock("DocsFunction"));
  const desktopFn = code(resourceBlock("DesktopFunction"));

  it("docs: the bucket is this account's, so the owner is AWS::AccountId", () => {
    expect(docsFn).toMatch(/DOCS_BUCKET: !Ref DocsBucketName/);
    expect(docsFn).toMatch(/DOCS_BUCKET_OWNER: !Ref AWS::AccountId/);
  });

  it("desktop: the owner is the configured shared account, else this account", () => {
    expect(desktopFn).toMatch(/DESKTOP_BUCKET: !Ref DesktopBucket\n/);
    expect(desktopFn).toMatch(
      /DESKTOP_BUCKET_OWNER: !If \[HasDesktopBucketOwner, !Ref DesktopBucketOwnerAccountId, !Ref AWS::AccountId\]/
    );
  });
});

describe.skipIf(!HAS_TEMPLATE)("⚠ the KMS key lets CloudWatch publish only for this account's praimana-* alarms", () => {
  /**
   * The platform key encrypts AlertsTopic. CloudWatch's key statement is limited to this account and
   * to alarms named praimana-* (aws:SourceArn). That condition fails SILENTLY for any other name: KMS
   * refuses, SNS drops the notification, and the alarm still shows ALARM in the console. So every alarm
   * that notifies the topic must carry the prefix, and this test is where that rule is enforced.
   *
   * EventBridge has its own statement with no condition, because SNS does not support source
   * conditions for EventBridge publishing to an encrypted topic (see SECURITY.md).
   */
  const key = code(resourceBlock("PlatformKey"));
  const statement = (sid: string) => {
    const start = key.indexOf(`- Sid: ${sid}\n`);
    expect(start, `${sid} must exist in the key policy`).toBeGreaterThan(-1);
    const rest = key.slice(start + 1);
    const next = rest.search(/\n {10}- Sid: /);
    return next === -1 ? rest : rest.slice(0, next);
  };

  it("CloudWatch is limited to this account and its praimana-* alarms", () => {
    const cw = statement("AllowCloudWatchAlarmsToPublish");
    expect(cw).toMatch(/Service: cloudwatch\.amazonaws\.com/);
    expect(cw).not.toMatch(/events\.amazonaws\.com/);
    expect(cw).toMatch(/aws:SourceAccount: !Ref "AWS::AccountId"/);
    expect(cw).toMatch(
      /aws:SourceArn: !Sub "arn:\$\{AWS::Partition\}:cloudwatch:\$\{AWS::Region\}:\$\{AWS::AccountId\}:alarm:praimana-\*"/
    );
  });

  it("EventBridge has its own statement, scoped to the key's publish actions only", () => {
    const eb = statement("AllowEventBridgeToPublish");
    expect(eb).toMatch(/Service: events\.amazonaws\.com/);
    expect(eb).not.toMatch(/cloudwatch\.amazonaws\.com/);
    expect(eb).toMatch(/- kms:Decrypt\n\s+- kms:GenerateDataKey\*\n/);
    expect(key, "the combined statement must not come back").not.toMatch(/AllowCloudWatchAlarmsAndEventsToPublish/);
  });

  it("the TOPIC policy lets CloudWatch publish too, with the same scope", () => {
    /**
     * A custom topic policy REPLACES the SNS default, so a principal it does not name cannot publish at
     * all. AlertsTopicPolicy named only EventBridge, and every alarm's action failed with "CloudWatch
     * Alarms is not authorized to perform: SNS:Publish" — invisible until somebody read the alarm's
     * action history. The key policy is the second gate; this is the first.
     */
    const topicPolicy = code(resourceBlock("AlertsTopicPolicy"));
    const start = topicPolicy.indexOf("- Sid: AllowCloudWatchAlarmsPublish\n");
    expect(start, "AllowCloudWatchAlarmsPublish must exist in AlertsTopicPolicy").toBeGreaterThan(-1);
    const cw = topicPolicy.slice(start);
    expect(cw).toMatch(/Service: cloudwatch\.amazonaws\.com/);
    expect(cw).toMatch(/Action: sns:Publish/);
    expect(cw).toMatch(/Resource: !Ref AlertsTopic/);
    expect(cw).toMatch(/aws:SourceAccount: !Ref "AWS::AccountId"/);
    expect(cw).toMatch(/:alarm:praimana-\*"/);
  });

  it("every alarm that notifies AlertsTopic is named praimana-*, or its notification would be dropped", () => {
    const alarms = [...TEMPLATE.matchAll(/\n {2}([A-Za-z0-9]+):\n {4}Type: AWS::CloudWatch::(?:Composite)?Alarm\n/g)].map(
      (m) => m[1]
    );
    const notifying = alarms.filter((id) => /AlertsTopic/.test(code(resourceBlock(id))));
    expect(notifying.length, "the alarms that notify AlertsTopic").toBeGreaterThan(0);
    for (const id of notifying) {
      expect(code(resourceBlock(id)), id).toMatch(/\n {6}AlarmName: praimana-/);
    }
  });
});

/**
 * ⚠ ABSENT SIBLING REPO ⇒ A TODO, NEVER A SILENT PASS. Every assertion above is skipped when the
 * infrastructure repo is not checked out beside this one, so this reports the gap in the run summary
 * instead of leaving a low test count to be noticed by nobody. See `sibling-repo.ts`.
 */
if (!HAS_TEMPLATE) {
  describe("the infrastructure template", () => {
    it.todo(TEMPLATE_ABSENT_TODO);
  });
}
