/**
 * ── ⚠ A SHARED-STORE SEND QUOTA, BECAUSE AN IN-MEMORY ONE WOULD NOT BOUND THIS ──────────────
 *
 * SECURITY FINDING (Medium — "Unmetered branded-email relay: /v1/notify/* is gated
 * only by a three-role set, and /v1/auth/feedback reaches the same SES sink with a synthesised
 * ADMIN identity"). There was no limiter anywhere in notify/src or identity/src, so the only cap
 * on volume was SES account state.
 *
 * ⚠ THE PORTAL ALREADY LEARNED THIS LESSON THE EXPENSIVE WAY, and its rate limiter's header says
 * so at length: an in-process sliding window on Lambda gives an attacker "N independent stores"
 * for N concurrent requests, so "the effective ceiling RISES WITH ATTACK INTENSITY — it is
 * weakest at exactly the moment it is needed", and it names the fix: "a shared store (DynamoDB
 * conditional writes are the cheap fit here)". This is that. Copying the in-memory version into
 * another service would have been quicker and would have bounded nothing that matters, because
 * what is being protected — SES sending quota and the platform's sender reputation — is
 * account-wide rather than per-process.
 *
 * ── HOW IT WORKS ──
 *
 * One atomic UpdateItem per attempt:
 *
 *     ADD sends :one
 *     SET expiresAt = :ttl
 *     ConditionExpression: attribute_not_exists(sends) OR sends < :max
 *
 * DynamoDB evaluates the condition and applies the increment as ONE operation, so two concurrent
 * requests cannot both read `max - 1` and both proceed. A refusal arrives as
 * ConditionalCheckFailedException, which is the ONLY error swallowed — see `consume`.
 *
 * ⚠ THE COUNTER IS A FIXED WINDOW, NOT A SLIDING ONE, and the difference is worth stating rather
 * than discovering: a caller can spend a full allowance at the end of one window and another at
 * the start of the next, so the true short-term burst is up to 2×max. A sliding window needs
 * either a stored timestamp list (a much larger item, rewritten on every call) or a second
 * conditional write, and neither earns its cost here: the purpose is to make bulk abuse expensive
 * and visible, not to smooth traffic.
 *
 * ⚠ IT FAILS OPEN, DELIBERATELY, AND THAT IS A JUDGEMENT CALL. If DynamoDB is unreachable the
 * send proceeds. The alternative is that a table problem stops invitation and
 * password-reset email — turning a quota outage into an access outage — and this is a quota, not
 * an authorization gate: the role check in front of it is what decides who may send at all.
 * Every fail-open is logged so it cannot be silent, and the counter is not the last line: SES's
 * own account quota still exists.
 */

import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DocClient } from "./dynamo.js";

/** Result of an attempt to spend one unit of a caller's allowance. */
export interface QuotaVerdict {
  /** False only when the allowance is provably exhausted. */
  allowed: boolean;
  /** How many are permitted per window, for the refusal message and headers. */
  limit: number;
  /** Seconds until the current window ends, for Retry-After. */
  retryAfterSeconds: number;
}

export interface SendQuotaConfig {
  client: DocClient;
  tableName: string;
  /** Window length. One hour is the default because these are human-initiated sends. */
  windowSeconds?: number;
  /** Sends permitted per key per window. */
  maxPerWindow: number;
  /**
   * Distinguishes one counter's purpose from another in the same table, so notify's per-sender
   * budget and identity's per-reporter budget cannot consume each other.
   */
  scope: string;
}

const DEFAULT_WINDOW_SECONDS = 3600;

/**
 * ⚠ THE KEY INCLUDES THE WINDOW, WHICH IS WHAT MAKES EXPIRY FREE. A new window is a new item
 * rather than a reset of an old one, so nothing has to run at the boundary and there is no
 * read-modify-write to lose a race in. TTL then removes the dead items whenever DynamoDB gets
 * around to it — TTL deletion is not prompt, and nothing here depends on it being so.
 */
function keyFor(scope: string, subject: string, windowStart: number): string {
  return `${scope}#${subject}#${windowStart}`;
}

export function createSendQuota(config: SendQuotaConfig) {
  const windowSeconds = config.windowSeconds ?? DEFAULT_WINDOW_SECONDS;

  return {
    /**
     * Spend one unit for `subject`. Returns whether the caller may proceed.
     *
     * @param subject the identity being metered — a user id, never an email address
     */
    async consume(subject: string): Promise<QuotaVerdict> {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const windowStart = nowSeconds - (nowSeconds % windowSeconds);
      const windowEnd = windowStart + windowSeconds;
      const verdict: QuotaVerdict = {
        allowed: true,
        limit: config.maxPerWindow,
        retryAfterSeconds: Math.max(1, windowEnd - nowSeconds),
      };

      try {
        await config.client.send(
          new UpdateCommand({
            TableName: config.tableName,
            Key: { id: keyFor(config.scope, subject, windowStart) },
            UpdateExpression: "ADD #sends :one SET #expiresAt = :ttl",
            // `sends` and `expiresAt` are both reserved-word risks in DynamoDB's grammar; naming
            // them through ExpressionAttributeNames costs nothing and removes the question.
            ExpressionAttributeNames: { "#sends": "sends", "#expiresAt": "expiresAt" },
            ExpressionAttributeValues: {
              ":one": 1,
              ":max": config.maxPerWindow,
              // A grace period past the window end so a slow clock cannot delete a live counter.
              ":ttl": windowEnd + windowSeconds,
            },
            ConditionExpression: "attribute_not_exists(#sends) OR #sends < :max",
          })
        );
        return verdict;
      } catch (err) {
        const name = (err as { name?: string })?.name;
        if (name === "ConditionalCheckFailedException") {
          return { ...verdict, allowed: false };
        }
        /**
         * ⚠ FAIL OPEN, AND LOUDLY. See the header for why this is not silently generous: a quota
         * store outage must not stop invitation or password-reset mail. The log line is what makes
         * the decision reviewable — if it appears in volume, the quota is not being enforced and
         * that is worth knowing before an incident rather than during one.
         */
        console.error("[send-quota] store unavailable — ALLOWING the send unmetered", {
          scope: config.scope,
          error: name || String(err),
        });
        return verdict;
      }
    },
  };
}

export type SendQuota = ReturnType<typeof createSendQuota>;
