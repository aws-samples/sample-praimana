// ── ⚠ A FIELD THE SCHEMA DROPS IS WORSE THAN A FIELD IT REJECTS ──────────────────────────
//
// REPORTED: "its not showing the format field in the settings page to update".
//
// THE CAUSE WAS TWO BUGS STACKED, and the second is the one worth a test. The settings form had no
// Format input, but even if it had, `workshop.update`'s zod schema did not list `format`, and zod's
// default behaviour is to STRIP unknown keys rather than reject them. So the mutation would have
// accepted the request, called PATCH without the field, and reported SUCCESS while changing nothing.
//
// ⚠ THE BACKEND ACCEPTED IT ALL ALONG. `the workshop service's `routes.ts``'s PATCH allowlist has
// always included `format`, `maxTeamSize` and `minTeamSize`. Only the BFF was narrowing them away,
// which is the most confusing possible arrangement: the API supports the edit, the UI appears to
// make it, and nothing anywhere says no.
//
// This test asserts the schema ACCEPTS those fields, so a future tidy-up cannot silently re-narrow
// it. It tests the zod schema directly rather than through a mocked tRPC caller, the schema IS the
// bug surface, and going through the router would prove the mock more than the code.

import { describe, it, expect } from "vitest";
import { workshopRouter } from "./workshop";

/** The input schema tRPC built for `workshop.update`. */
function updateSchema() {
  // `_def.inputs` is tRPC's parsed input chain; one entry, the zod object.
  const proc = (workshopRouter as unknown as {
    _def: { procedures: Record<string, { _def: { inputs: unknown[] } }> };
  })._def.procedures.update;
  const schema = proc._def.inputs[0] as {
    safeParse: (v: unknown) => { success: boolean; data?: Record<string, unknown> };
  };
  return schema;
}

const base = { id: "01KZ156Z8E95B9GC4SGBW6DA4D" };

describe("⚠ workshop.update must not silently drop editable fields", () => {
  /**
   * THE REGRESSION GUARD. If `format` is removed from the schema again, `parsed.data.format` becomes
   * undefined here, a save that appears to work and changes nothing.
   */
  it("KEEPS format in the parsed output", () => {
    const parsed = updateSchema().safeParse({ ...base, format: "Workshop" });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.format, "zod stripped it, the save would be a silent no-op").toBe(
      "Workshop"
    );
  });

  it.each([
    ["maxTeamSize", 8],
    ["minTeamSize", 4],
  ])("KEEPS %s in the parsed output", (field, value) => {
    const parsed = updateSchema().safeParse({ ...base, [field]: value });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.[field]).toBe(value);
  });

  it("still accepts a patch carrying none of them, it is a PARTIAL patch", () => {
    // The settings page has two independent save buttons; requiring these on every patch would mean
    // toggling an assistant needed the format re-sent.
    const parsed = updateSchema().safeParse({ ...base, name: "Retail" });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.format).toBeUndefined();
  });

  it("mirrors create's bounds, so the two paths cannot disagree on what is legal", () => {
    // 11 is above the platform ceiling of 10; 1 is below the floor of 2.
    expect(updateSchema().safeParse({ ...base, maxTeamSize: 11 }).success).toBe(false);
    expect(updateSchema().safeParse({ ...base, maxTeamSize: 1 }).success).toBe(false);
    expect(updateSchema().safeParse({ ...base, format: "" }).success).toBe(false);
  });

  /**
   * ⚠ "Workshop" IS A LEGAL FORMAT VALUE AND MUST STAY ONE.
   *
   * The UI is being renamed from "workshop" to "Experience" throughout, but `format` is a stored
   * VALUE whose options include a format literally called "Workshop" (alongside Hackathon,
   * Bootcamp…). Renaming the value would break existing records and the lookup they come from, only
   * the surrounding chrome is renamed. This pins that distinction so a search-and-replace cannot
   * quietly take the data with it.
   */
  it.each(["Workshop", "Hackathon", "Bootcamp", "Accelerator"])("accepts the format %j", (f) => {
    expect(updateSchema().safeParse({ ...base, format: f }).success).toBe(true);
  });
});
