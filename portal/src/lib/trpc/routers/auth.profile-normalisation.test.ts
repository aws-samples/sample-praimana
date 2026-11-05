// ── ⚠ THE VALUE THAT WAS VALIDATED IS THE VALUE THAT IS PERSISTED ─────────────────────────────
//
// A code review found `auth.updateProfile` validating the NORMALISED string and persisting the RAW
// one. `validateProfileField` normalises internally, `value.replace(/\s+/g, " ").trim()`, and
// applies the `[\p{L}\p{M}'\-. ]` allowlist to the result; the mutation then sent
// `JSON.stringify(input)`, the untransformed object.
//
// JavaScript `\s` includes `\n`, `\r`, `\t`, `\v`, `\f`, U+00A0, U+1680, U+2000-U+200A, U+2028,
// U+2029, U+202F, U+205F, U+3000 and U+FEFF. So "Ada\nLovelace" normalised to the perfectly legal
// "Ada Lovelace", PASSED the character allowlist, and was stored with the newline still in it -
// defeating the module's own stated rule, which lists control characters among the rejected set and
// refuses invisible code points deliberately as "a homograph vector". The stored value then fanned
// out to the identity service and every roster, directory and insights surface.
//
// THE ASSERTION THAT MATTERS is therefore about the schema's OUTPUT, not just its verdict: for
// every one of those code points, the parsed value must contain no whitespace other than single
// U+0020 spaces. The downstream identity service "evaluates the same function on the same
// normalised value" and so had the same defect, it was never a backstop for this.

import { describe, it, expect } from "vitest";
import { profileInput } from "./auth";
import { PROFILE_FIELD_MAX_RAW_LENGTH } from "@praimana/shared";

const base = { firstName: "Ada", lastName: "Lovelace", organization: "Analytical Engines" };

/** The object the mutation would forward, or `null` when the schema refused it. */
function persisted(patch: Record<string, string>) {
  const result = profileInput.safeParse({ ...base, ...patch });
  return result.success ? result.data : null;
}

/**
 * Every code point JavaScript's `\s` matches, minus the plain space. These are exactly the
 * characters that used to survive validation and reach the store.
 */
const WHITESPACE_CODE_POINTS = [
  "\n", "\r", "\t", "\v", "\f",
  " ", " ", " ", " ", " ", " ", " ", " ",
  " ", " ", " ", " ", " ", " ", " ", " ",
  " ", "　", "﻿",
];

describe("auth.updateProfile, what is persisted is what was validated", () => {
  it.each(WHITESPACE_CODE_POINTS.map((ch) => [JSON.stringify(ch), ch] as const))(
    "stores %s collapsed rather than raw",
    (_label, ch) => {
      const out = persisted({ firstName: `Ada${ch}Lovelace` });
      // Either refused outright or stored collapsed, both satisfy the module's stated rule. What
      // must never happen is the third outcome the finding describes: accepted AND stored raw.
      if (out === null) return;
      expect(out.firstName).toBe("Ada Lovelace");
      expect(out.firstName).not.toContain(ch);
    }
  );

  it("stores no control or invisible character in ANY of the three fields", () => {
    // The finding named firstName, but the transform is applied per-field and the loop in the
    // refine is driven off PROFILE_FIELDS, so a regression on one field is a regression on all.
    for (const ch of WHITESPACE_CODE_POINTS) {
      const out = persisted({
        firstName: `A${ch}da`,
        lastName: `Love${ch}lace`,
        organization: `Ana${ch}lytical`,
      });
      if (out === null) continue;
      for (const value of [out.firstName, out.lastName, out.organization]) {
        expect(value, `${JSON.stringify(ch)} survived in ${JSON.stringify(value)}`).not.toContain(ch);
      }
    }
  });

  it("collapses runs and trims, not just single characters", () => {
    const out = persisted({ firstName: "  Ada\n\n\tLovelace  " });
    expect(out?.firstName).toBe("Ada Lovelace");
  });

  it("leaves a legitimate name exactly as typed", () => {
    // The transform must be invisible to real input, or it becomes a bug report about names.
    for (const name of ["Ada Lovelace", "O'Brien", "Jean-Luc", "Ada M. Lovelace", "鳳凰"]) {
      expect(persisted({ firstName: name })?.firstName, name).toBe(name);
    }
  });

  it("still refuses a genuinely disallowed character rather than normalising it away", () => {
    // U+200B is NOT in `\s`, so it is not collapsed, it must be REFUSED by the allowlist. This is
    // the branch that proves normalisation did not become a way to launder bad input.
    expect(persisted({ firstName: "Ada​Lovelace" })).toBeNull();
    expect(persisted({ firstName: "Ada<script>" })).toBeNull();
    expect(persisted({ firstName: "" })).toBeNull();
  });

  it("keeps the raw payload bound ahead of the transform", () => {
    // ⚠ ORDER MATTERS. `.max(PROFILE_FIELD_MAX_RAW_LENGTH)` must run BEFORE normalisation, so a
    // megabyte of whitespace is refused rather than collapsed into a legal two-character name.
    const padded = " ".repeat(PROFILE_FIELD_MAX_RAW_LENGTH + 1) + "Ada";
    expect(persisted({ firstName: padded })).toBeNull();
  });
});
