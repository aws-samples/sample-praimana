// ── ⚠ WORKSHOP RESOURCES: THE AUTHORIZATION TABLE, ASSERTED ───────────────────────────────────
//
// THE RULE: only the facilitator can add or delete; every other role can
// read them. Two gates carry that, and both are gates this service already owned:
//
//   READ  → requireWorkshopRead   (owner, entitled judge, team member; an ADMIN only for their own)
//   WRITE → ownership alone       (the same rule that guards renaming an experience)
//
// These tests exist because a resource is readable by EVERY role in the experience, so a crossed
// boundary here is a disclosure rather than a mess — and because the write gate is the kind of rule
// that is easy to write and easy to leave off one route out of three. Every write route is asserted
// against a non-owner independently; a loop over "the write routes" would pass if one of them silently
// stopped being in the loop.
import { describe, it, expect, beforeAll } from "vitest";
import { InMemoryPublisher } from "@praimana/service-shared";
import { createWorkshopRoutes } from "./routes.js";
import {
  NoWorkshopMembership,
  type TeamAccess,
  type WorkshopEntitlements,
  type WorkshopMembership,
} from "./authz.js";
import {
  ZeroWorkshopStats,
  type FormatRepository,
  type PhaseRepository,
  type TeamPhaseRepository,
  type Workshop,
  type WorkshopRepository,
} from "./domain.js";
import type { ResourceStore } from "./resource-store.js";
import { MAX_RESOURCE_BYTES, PART_SIZE_BYTES, resourceKey } from "./resource-policy.js";

const INTERNAL_TOKEN = "test-internal-token";
beforeAll(() => {
  process.env.INTERNAL_SERVICE_TOKEN = INTERNAL_TOKEN;
});

const OWNER = "facilitator-1";
const WORKSHOP_ID = "W1";

function asUser(identity: { id: string; role: string }) {
  return {
    "x-internal-token": INTERNAL_TOKEN,
    "x-identity-id": identity.id,
    "x-identity-role": identity.role,
    "content-type": "application/json",
  };
}

function workshop(over: Partial<Workshop> = {}): Workshop {
  return {
    id: WORKSHOP_ID,
    name: "Experience",
    format: "workshop",
    status: "DRAFT",
    maxTeamSize: 5,
    ownerId: OWNER,
    ...over,
  } as Workshop;
}

/**
 * A ResourceStore that records what it was asked to do.
 *
 * ⚠ IT RECORDS RATHER THAN MERELY ANSWERING, because the assertions that matter most are about calls
 * that must NOT happen: a refused delete must not reach `remove`, and an over-size upload must reach it.
 * "It returned 403" and "it returned 403 and touched nothing" are different guarantees.
 */
class FakeResources implements ResourceStore {
  begun: { key: string; contentType: string; filename: string; uploadedBy: string }[] = [];
  completed: { key: string; uploadId: string }[] = [];
  aborted: { key: string; uploadId: string }[] = [];
  removed: string[] = [];
  presignedDownloads: { key: string; filename: string }[] = [];
  objects: { key: string; bytes: number; lastModified?: Date }[] = [];
  /** What `sizeOf` reports after completion — the honest size, which may exceed what was declared. */
  actualSize: number | null = 1024;
  failComplete = false;

  async beginUpload(a: { key: string; contentType: string; filename: string; uploadedBy: string }) {
    this.begun.push(a);
    return "upload-id-1";
  }
  async presignParts(a: { key: string; uploadId: string; partCount: number }) {
    return Array.from({ length: a.partCount }, (_, i) => `https://s3.example/part/${i + 1}`);
  }
  async completeUpload(a: { key: string; uploadId: string }) {
    if (this.failComplete) throw new Error("InvalidPart");
    this.completed.push({ key: a.key, uploadId: a.uploadId });
  }
  async abortUpload(a: { key: string; uploadId: string }) {
    this.aborted.push(a);
  }
  async sizeOf() {
    return this.actualSize;
  }
  async list(prefix: string) {
    return this.objects.filter((o) => o.key.startsWith(prefix));
  }
  /** What HEAD reports. `uploadedByEmail` is what the list surfaces as the uploader. */
  describedEmail = "facilitator@example.com";
  describeCalls = 0;
  async describe() {
    this.describeCalls++;
    return {
      contentType: "application/pdf",
      filename: "brief.pdf",
      uploadedBy: OWNER,
      uploadedByEmail: this.describedEmail,
    };
  }
  async remove(key: string) {
    this.removed.push(key);
  }
  async presignDownload(a: { key: string; filename: string }) {
    this.presignedDownloads.push(a);
    return "https://s3.example/download";
  }
}

/** Only the one method these routes call. Cast at the injection point, as the sibling fakes are. */
class OneWorkshop {
  constructor(private readonly row: Workshop | null) {}
  async getById(id: string) {
    return this.row && this.row.id === id ? this.row : null;
  }
}

class MemberOf implements WorkshopMembership {
  constructor(private readonly member: boolean) {}
  async isMember() {
    return this.member;
  }
}

class EntitledTo implements WorkshopEntitlements {
  constructor(private readonly ids: string[] = []) {}
  async listEntitledWorkshopIds() {
    return { workshopIds: this.ids, truncated: false };
  }
}

function harness(
  over: {
    row?: Workshop | null;
    /** `null` means NOT WIRED — a deployment with no bucket. `undefined` means "give me the fake". */
    resources?: ResourceStore | null;
    membership?: WorkshopMembership;
    entitlements?: WorkshopEntitlements;
  } = {}
) {
  const resources = over.resources === undefined ? new FakeResources() : over.resources ?? undefined;
  const deps = {
    workshops: new OneWorkshop(over.row === undefined ? workshop() : over.row) as unknown as WorkshopRepository,
    resources,
    phases: { listByWorkshop: async () => [], put: async () => {}, remove: async () => {} } as unknown as PhaseRepository,
    teamPhases: {} as TeamPhaseRepository,
    formats: { listByCategory: async () => [] } as unknown as FormatRepository,
    stats: new ZeroWorkshopStats(),
    events: new InMemoryPublisher(),
    teamAccess: { canRead: async () => true, canWrite: async () => true } as unknown as TeamAccess,
    membership: over.membership ?? new NoWorkshopMembership(),
    entitlements: over.entitlements ?? new EntitledTo(),
  };
  return { app: createWorkshopRoutes(deps as never), resources: resources as FakeResources };
}

const base = `/v1/workshops/${WORKSHOP_ID}/resources`;

describe("⚠ WRITE is the owning facilitator alone", () => {
  /**
   * ⚠ A FACILITATOR WHO DOES NOT OWN THIS EXPERIENCE IS NOT AN EDITOR OF IT. This is the case the role
   * name invites you to get wrong: the rule is ownership, not role. `routes.ts` states why — "a role
   * that cannot READ another owner's experience must not be able to WRITE it".
   */
  it("refuses a different facilitator, and touches nothing", async () => {
    const { app, resources } = harness({ membership: new MemberOf(true) });
    const res = await app.request(`${base}/uploads`, {
      method: "POST",
      headers: asUser({ id: "facilitator-2", role: "FACILITATOR" }),
      body: JSON.stringify({ filename: "brief.pdf", bytes: 100 }),
    });
    expect(res.status).toBe(403);
    expect(resources.begun).toEqual([]);
  });

  /** An ADMIN who did not create the experience cannot read it, so it cannot write it either. */
  it("refuses an admin who does not own the experience", async () => {
    const { app, resources } = harness();
    const res = await app.request(`${base}/uploads`, {
      method: "POST",
      headers: asUser({ id: "admin-9", role: "ADMIN" }),
      body: JSON.stringify({ filename: "brief.pdf", bytes: 100 }),
    });
    expect(res.status).toBe(403);
    expect(resources.begun).toEqual([]);
  });

  it("refuses a participant who can READ the experience", async () => {
    const { app, resources } = harness({ membership: new MemberOf(true) });
    const res = await app.request(`${base}/uploads`, {
      method: "POST",
      headers: asUser({ id: "p-1", role: "PARTICIPANT" }),
      body: JSON.stringify({ filename: "brief.pdf", bytes: 100 }),
    });
    expect(res.status).toBe(403);
    expect(resources.begun).toEqual([]);
  });

  /** Asserted per route, not in a loop — see the file header. */
  it("refuses a non-owner on DELETE, and does not remove", async () => {
    const { app, resources } = harness({ membership: new MemberOf(true) });
    resources.objects = [
      { key: resourceKey({ workshopId: WORKSHOP_ID, resourceId: "R1", filename: "brief.pdf" }), bytes: 10 },
    ];
    const res = await app.request(`${base}/R1`, {
      method: "DELETE",
      headers: asUser({ id: "p-1", role: "PARTICIPANT" }),
    });
    expect(res.status).toBe(403);
    expect(resources.removed).toEqual([]);
  });

  it("refuses a non-owner on COMPLETE, and does not complete", async () => {
    const { app, resources } = harness({ membership: new MemberOf(true) });
    const res = await app.request(`${base}/uploads/complete`, {
      method: "POST",
      headers: asUser({ id: "p-1", role: "PARTICIPANT" }),
      body: JSON.stringify({ key: "x", uploadId: "y", parts: [{ partNumber: 1, etag: "e" }] }),
    });
    expect(res.status).toBe(403);
    expect(resources.completed).toEqual([]);
  });

  it("admits the owning facilitator", async () => {
    const { app, resources } = harness();
    const res = await app.request(`${base}/uploads`, {
      method: "POST",
      headers: asUser({ id: OWNER, role: "FACILITATOR" }),
      body: JSON.stringify({ filename: "brief.pdf", bytes: 2 * PART_SIZE_BYTES }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { partUrls: string[]; partSize: number; resourceId: string };
    expect(body.partUrls).toHaveLength(2);
    expect(body.partSize).toBe(PART_SIZE_BYTES);
    expect(resources.begun[0].uploadedBy).toBe(OWNER);
    // Server-chosen content type, never the client's.
    expect(resources.begun[0].contentType).toBe("application/pdf");
  });

  /** An ADMIN who CREATED the experience is its owner and passes — the rule is ownership, not role. */
  it("admits an admin who owns the experience", async () => {
    const { app } = harness({ row: workshop({ ownerId: "admin-7" }) });
    const res = await app.request(`${base}/uploads`, {
      method: "POST",
      headers: asUser({ id: "admin-7", role: "ADMIN" }),
      body: JSON.stringify({ filename: "brief.pdf", bytes: 100 }),
    });
    expect(res.status).toBe(200);
  });
});

describe("⚠ READ is every role that can see the experience", () => {
  it("lets a participant on the team list resources", async () => {
    const { app, resources } = harness({ membership: new MemberOf(true) });
    resources.objects = [
      { key: resourceKey({ workshopId: WORKSHOP_ID, resourceId: "R1", filename: "brief.pdf" }), bytes: 10 },
    ];
    const res = await app.request(base, { headers: asUser({ id: "p-1", role: "PARTICIPANT" }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resources: { filename: string }[] };
    expect(body.resources.map((r) => r.filename)).toEqual(["brief.pdf"]);
  });

  it("lets an entitled judge list resources", async () => {
    const { app } = harness({ entitlements: new EntitledTo([WORKSHOP_ID]) });
    const res = await app.request(base, { headers: asUser({ id: "j-1", role: "JUDGE" }) });
    expect(res.status).toBe(200);
  });

  /** The gate is inherited, so someone who cannot see the experience cannot see its material. */
  it("refuses someone with no route into the experience", async () => {
    const { app } = harness();
    const res = await app.request(base, { headers: asUser({ id: "p-9", role: "PARTICIPANT" }) });
    expect(res.status).toBe(403);
  });

  it("lets a participant download, with a filename resolved by us", async () => {
    const { app, resources } = harness({ membership: new MemberOf(true) });
    resources.objects = [
      { key: resourceKey({ workshopId: WORKSHOP_ID, resourceId: "R1", filename: "brief.pdf" }), bytes: 10 },
    ];
    const res = await app.request(`${base}/R1/download`, {
      headers: asUser({ id: "p-1", role: "PARTICIPANT" }),
    });
    expect(res.status).toBe(200);
    expect(resources.presignedDownloads[0].filename).toBe("brief.pdf");
  });
});

describe("⚠ one experience cannot reach another's objects", () => {
  /**
   * The key arrives from the client on COMPLETE because that is where the multipart upload is named.
   * It is therefore re-verified against the prefix of the experience this request was authorized for.
   */
  it("refuses a completion whose key belongs to another experience", async () => {
    const { app, resources } = harness();
    const foreign = resourceKey({ workshopId: "W2", resourceId: "R1", filename: "brief.pdf" });
    const res = await app.request(`${base}/uploads/complete`, {
      method: "POST",
      headers: asUser({ id: OWNER, role: "FACILITATOR" }),
      body: JSON.stringify({ key: foreign, uploadId: "u", parts: [{ partNumber: 1, etag: "e" }] }),
    });
    expect(res.status).toBe(400);
    expect(resources.completed).toEqual([]);
  });

  it("refuses an abort whose key belongs to another experience", async () => {
    const { app, resources } = harness();
    const foreign = resourceKey({ workshopId: "W2", resourceId: "R1", filename: "brief.pdf" });
    const res = await app.request(`${base}/uploads/abort`, {
      method: "POST",
      headers: asUser({ id: OWNER, role: "FACILITATOR" }),
      body: JSON.stringify({ key: foreign, uploadId: "u" }),
    });
    expect(res.status).toBe(400);
    expect(resources.aborted).toEqual([]);
  });

  /**
   * ⚠ THE OTHER PARAMETER. `resourceId` becomes part of a LIST prefix, so a traversal in it would widen
   * the listing past this experience — the same concatenation bug the filename policy prevents, arriving
   * through the id instead.
   */
  it("refuses a resourceId that is not a bare id", async () => {
    const { app, resources } = harness();
    for (const bad of ["..", "../..", "R1/x", "a.b"]) {
      const res = await app.request(`${base}/${encodeURIComponent(bad)}`, {
        method: "DELETE",
        headers: asUser({ id: OWNER, role: "FACILITATOR" }),
      });
      expect(res.status, `${bad} was accepted`).toBe(404);
    }
    expect(resources.removed).toEqual([]);
  });

  /** A stray object under the prefix is omitted rather than listed with a nonsense name. */
  it("omits objects that do not match the key layout", async () => {
    const { app, resources } = harness({ membership: new MemberOf(true) });
    resources.objects = [
      { key: `workshops/${WORKSHOP_ID}/resources/leftover.pdf`, bytes: 1 },
      { key: resourceKey({ workshopId: WORKSHOP_ID, resourceId: "R1", filename: "ok.pdf" }), bytes: 2 },
    ];
    const res = await app.request(base, { headers: asUser({ id: "p-1", role: "PARTICIPANT" }) });
    const body = (await res.json()) as { resources: { filename: string }[] };
    expect(body.resources.map((r) => r.filename)).toEqual(["ok.pdf"]);
  });
});

describe("⚠ the ceiling is enforced against the real size, not the declared one", () => {
  /**
   * THE WHOLE REASON `exceedsCeiling` EXISTS. A presigned part URL does not constrain the bytes pushed
   * through it, so a client can declare 1KB and upload 300MB. The limit is only real if the assembled
   * object is measured — and only honest if an over-size upload is DELETED rather than kept.
   */
  it("discards an upload that declared a small size and landed over the limit", async () => {
    const { app, resources } = harness();
    resources.actualSize = MAX_RESOURCE_BYTES + 1;
    const key = resourceKey({ workshopId: WORKSHOP_ID, resourceId: "R1", filename: "big.mp4" });

    const res = await app.request(`${base}/uploads/complete`, {
      method: "POST",
      headers: asUser({ id: OWNER, role: "FACILITATOR" }),
      body: JSON.stringify({ key, uploadId: "u", parts: [{ partNumber: 1, etag: "e" }] }),
    });

    expect(res.status).toBe(413);
    expect(resources.removed, "an upload refused for size must not remain stored").toEqual([key]);
  });

  it("keeps an upload that is exactly at the limit", async () => {
    const { app, resources } = harness();
    resources.actualSize = MAX_RESOURCE_BYTES;
    const key = resourceKey({ workshopId: WORKSHOP_ID, resourceId: "R1", filename: "big.mp4" });
    const res = await app.request(`${base}/uploads/complete`, {
      method: "POST",
      headers: asUser({ id: OWNER, role: "FACILITATOR" }),
      body: JSON.stringify({ key, uploadId: "u", parts: [{ partNumber: 1, etag: "e" }] }),
    });
    expect(res.status).toBe(200);
    expect(resources.removed).toEqual([]);
  });

  it("refuses an over-size file at the start too, without opening an upload", async () => {
    const { app, resources } = harness();
    const res = await app.request(`${base}/uploads`, {
      method: "POST",
      headers: asUser({ id: OWNER, role: "FACILITATOR" }),
      body: JSON.stringify({ filename: "big.mp4", bytes: MAX_RESOURCE_BYTES + 1 }),
    });
    expect(res.status).toBe(400);
    expect(resources.begun).toEqual([]);
  });

  /** Parts left behind by a failed completion are billed and invisible; abort now, not eventually. */
  it("aborts the upload when completion fails", async () => {
    const { app, resources } = harness();
    resources.failComplete = true;
    const key = resourceKey({ workshopId: WORKSHOP_ID, resourceId: "R1", filename: "brief.pdf" });
    const res = await app.request(`${base}/uploads/complete`, {
      method: "POST",
      headers: asUser({ id: OWNER, role: "FACILITATOR" }),
      body: JSON.stringify({ key, uploadId: "u", parts: [{ partNumber: 1, etag: "e" }] }),
    });
    expect(res.status).toBe(400);
    expect(resources.aborted).toEqual([{ key, uploadId: "u" }]);
  });
});

describe("⚠ an unwired deployment refuses rather than pretends", () => {
  /**
   * The polarity `userRoles` established: absent dependency means a loud 501. The alternative — treating
   * a missing bucket as "no resources" — would show a facilitator an empty list and accept uploads that
   * went nowhere.
   */
  it("answers 501 on every resource route when no store is configured", async () => {
    const { app } = harness({ resources: null });
    const calls: [string, RequestInit][] = [
      [base, { headers: asUser({ id: OWNER, role: "FACILITATOR" }) }],
      [
        `${base}/uploads`,
        {
          method: "POST",
          headers: asUser({ id: OWNER, role: "FACILITATOR" }),
          body: JSON.stringify({ filename: "a.pdf", bytes: 10 }),
        },
      ],
      [`${base}/R1`, { method: "DELETE", headers: asUser({ id: OWNER, role: "FACILITATOR" }) }],
      [`${base}/R1/download`, { headers: asUser({ id: OWNER, role: "FACILITATOR" }) }],
    ];
    for (const [path, init] of calls) {
      const res = await app.request(path, init);
      expect(res.status, `${path} did not refuse`).toBe(501);
    }
  });
});

describe("input validation", () => {
  it("refuses a disallowed type with a reason naming what is allowed", async () => {
    const { app } = harness();
    const res = await app.request(`${base}/uploads`, {
      method: "POST",
      headers: asUser({ id: OWNER, role: "FACILITATOR" }),
      body: JSON.stringify({ filename: "payload.exe", bytes: 10 }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain("pdf");
  });

  it("refuses a body that is not JSON", async () => {
    const { app } = harness();
    const res = await app.request(`${base}/uploads`, {
      method: "POST",
      headers: asUser({ id: OWNER, role: "FACILITATOR" }),
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("refuses a completion with no parts", async () => {
    const { app } = harness();
    const key = resourceKey({ workshopId: WORKSHOP_ID, resourceId: "R1", filename: "a.pdf" });
    const res = await app.request(`${base}/uploads/complete`, {
      method: "POST",
      headers: asUser({ id: OWNER, role: "FACILITATOR" }),
      body: JSON.stringify({ key, uploadId: "u", parts: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("404s a missing experience before anything else", async () => {
    const { app } = harness({ row: null });
    const res = await app.request(base, { headers: asUser({ id: OWNER, role: "FACILITATOR" }) });
    expect(res.status).toBe(404);
  });
});

describe("⚠ who uploaded it", () => {
  /**
   * The uploader comes from the VERIFIED claims at upload time, not from the request body — a
   * client-supplied name would let a facilitator attribute an upload to someone else.
   */
  it("records the email from the verified claims, never the body", async () => {
    const { app, resources } = harness();
    await app.request(`${base}/uploads`, {
      method: "POST",
      headers: {
        ...asUser({ id: OWNER, role: "FACILITATOR" }),
        "x-identity-email": "claimed@example.com",
      },
      body: JSON.stringify({ filename: "brief.pdf", bytes: 10, uploadedBy: "someone-else@evil" }),
    });
    expect(resources.begun[0].uploadedBy).toBe(OWNER);
    // Whatever the body said is absent; only the identity the gateway vouched for is stored.
    expect(JSON.stringify(resources.begun[0])).not.toContain("evil");
  });

  it("surfaces the uploader on the list", async () => {
    const { app, resources } = harness({ membership: new MemberOf(true) });
    resources.objects = [
      { key: resourceKey({ workshopId: WORKSHOP_ID, resourceId: "R1", filename: "a.pdf" }), bytes: 1 },
    ];
    const res = await app.request(base, { headers: asUser({ id: "p-1", role: "PARTICIPANT" }) });
    const body = (await res.json()) as { resources: { uploadedBy: string }[] };
    expect(body.resources[0].uploadedBy).toBe("facilitator@example.com");
  });

  /**
   * ⚠ A FAILED HEAD MUST DEGRADE THE ROW, NOT THE LIST. The uploader is cosmetic; the name, size and
   * date are not. Letting one unreadable object fail the response turns a blank cell into
   * "resources could not be loaded" for every file on the experience.
   */
  it("still lists a resource whose metadata cannot be read", async () => {
    const { app, resources } = harness({ membership: new MemberOf(true) });
    resources.objects = [
      { key: resourceKey({ workshopId: WORKSHOP_ID, resourceId: "R1", filename: "a.pdf" }), bytes: 7 },
    ];
    resources.describe = async () => {
      throw new Error("AccessDenied");
    };
    const res = await app.request(base, { headers: asUser({ id: "p-1", role: "PARTICIPANT" }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resources: { filename: string; bytes: number; uploadedBy: string }[] };
    expect(body.resources[0].filename).toBe("a.pdf");
    expect(body.resources[0].bytes).toBe(7);
    expect(body.resources[0].uploadedBy).toBe("");
  });

  it("leaves the uploader empty for objects written before it was stored", async () => {
    const { app, resources } = harness({ membership: new MemberOf(true) });
    resources.objects = [
      { key: resourceKey({ workshopId: WORKSHOP_ID, resourceId: "R1", filename: "a.pdf" }), bytes: 1 },
    ];
    resources.describedEmail = "";
    const res = await app.request(base, { headers: asUser({ id: "p-1", role: "PARTICIPANT" }) });
    const body = (await res.json()) as { resources: { uploadedBy: string }[] };
    expect(body.resources[0].uploadedBy).toBe("");
  });

  /**
   * ⚠ ONE HEAD PER OBJECT, AND NOT MORE. The enrichment is an N+1 against S3 by design; this pins that
   * it is exactly N, so a later refactor cannot turn it into N per worker or N².
   */
  it("issues exactly one HEAD per listed object", async () => {
    const { app, resources } = harness({ membership: new MemberOf(true) });
    resources.objects = Array.from({ length: 12 }, (_, i) => ({
      key: resourceKey({ workshopId: WORKSHOP_ID, resourceId: `R${i}`, filename: `f${i}.pdf` }),
      bytes: 1,
    }));
    await app.request(base, { headers: asUser({ id: "p-1", role: "PARTICIPANT" }) });
    expect(resources.describeCalls).toBe(12);
  });
});
