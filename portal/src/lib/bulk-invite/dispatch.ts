// ── HANDING A VALIDATED PLAN TO THE WORKER ───────────────────────────────────────────────
//
// The BFF validates the CSV, turns it into a normalised JSON plan, and hands it off. It does NOT do
// the work: the worker does, and reports the outcome by email.
//
// ⚠ THE ENQUEUE GOES THROUGH THE TEAM SERVICE, NOT DIRECTLY TO AWS. The portal has no AWS SDK -
// services own AWS, the BFF orchestrates over HTTP, so publishing from here would need
// `events:PutEvents` on the Amplify compute role plus a new dependency. Team already has
// `deps.events.publish`, so routing through it costs no new IAM anywhere.
//
// ⚠ THE SYNCHRONOUS PATH IN `./apply.ts` IS DELIBERATELY STILL PRESENT, and is not dead by accident.
// It works, it has 17 tests, and the worker has NEVER RUN AGAINST REAL AWS. Deleting it in the same
// change that stops using it would trade a proven path for an unproven one with no way back. It comes
// out once the worker is verified live.

import { backendFetch } from "@/lib/backend";
import type { BulkPlan } from "./validate";

export interface BulkProvisionRequest {
  workshopId: string;
  plan: BulkPlan;
  /** Who to hold accountable, and who the worker emails the report to. */
  requestedBy: {
    id: string;
    email: string;
    name?: string;
    role: string;
  };
  /** The caller's bearer, re-presented to the Team service, the only pattern the gateway accepts. */
  token: string;
}

export interface BulkProvisionAccepted {
  /** The Team service's id for this run. Shown to the operator and used to correlate logs. */
  batchId: string;
}

/**
 * True when a hand-off is possible.
 *
 * ⚠ THIS CANNOT BE ANSWERED HONESTLY FROM HERE, and pretending otherwise was the previous version's
 * mistake. Whether the worker exists depends on `EnableBulkProvision` in the deployed stack, which the
 * BFF cannot see. So this returns true and the REAL answer comes from the enqueue attempt: an
 * undeployed Team route answers 404 and the route reports that plainly, rather than this function
 * guessing.
 */
export function isBulkDispatchConfigured(): boolean {
  return true;
}

/**
 * Enqueue the plan. Resolves once the Team service has DURABLY accepted it (published the event), not
 * once the work is finished, that is the whole point of the acknowledgement.
 *
 * ⚠ NO CREDENTIAL CROSSES INTO THE JOB. The caller's bearer authenticates THIS call and stops here;
 * the event carries only the requester's identity, which the worker asserts. A bearer at rest in an
 * event bus and its DLQ is exactly what was refused for the temporary password.
 */
export async function dispatchBulkProvision(
  request: BulkProvisionRequest
): Promise<BulkProvisionAccepted> {
  const res = await backendFetch(
    `/v1/workshops/${encodeURIComponent(request.workshopId)}/bulk-provision`,
    {
      method: "POST",
      body: JSON.stringify({ plan: request.plan }),
      token: request.token,
      /**
       * A generous ceiling for what is one authorization hop plus a `PutEvents`. It is NOT the
       * duration of the work, that is precisely what this hand-off exists to avoid waiting for.
       */
      timeoutMs: 20_000,
    }
  );

  const batchId = res?.batchId;
  if (!batchId) {
    // A 2xx with no id means we cannot tell the operator which run is theirs, and cannot correlate
    // logs. Treated as a failure rather than shrugged at.
    throw new Error("The plan was accepted but no batch id came back.");
  }
  return { batchId };
}
