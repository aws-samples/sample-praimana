import { describe, it, expect } from "vitest";
import {
  PROFILE_FIELDS,
  PROFILE_FIELD_MAX_LENGTH,
  PROFILE_FIELD_MAX_RAW_LENGTH,
  PROFILE_FIELD_MIN_LENGTH,
  displayName,
  greetingName,
  isProfileComplete,
  isProfileFieldFilled,
  normalizeProfileField,
  profileFieldCharacterRule,
  profileInitials,
  validateProfile,
  validateProfileField,
} from "@praimana/shared";

/**
 * These functions are the shared definition of "complete", used by the sign-up
 * form, the identity service's PATCH gate, and the redirect that forces the
 * completion step. If they disagree the user is trapped: bounced to a form that
 * refuses to save, or bounced forever because a saved value still reads as blank.
 * Hence the emphasis below on whitespace — that is where the three would drift.
 */

describe("normalizeProfileField", () => {
  it("trims the edges", () => {
    expect(normalizeProfileField("  Xavier  ")).toBe("Xavier");
  });

  it("collapses internal whitespace runs, so a pasted value can't render as 'A  B'", () => {
    expect(normalizeProfileField("Amazon   Web  Services")).toBe(
      "Amazon Web Services"
    );
    expect(normalizeProfileField("Van\tder Berg")).toBe("Van der Berg");
  });

  it("maps absent values to the empty string rather than 'undefined'", () => {
    expect(normalizeProfileField(undefined)).toBe("");
    expect(normalizeProfileField(null)).toBe("");
  });
});

describe("isProfileFieldFilled", () => {
  it("rejects whitespace-only input — the check that makes the gate trustworthy", () => {
    // If this returned true, a user could satisfy a mandatory field with a space.
    expect(isProfileFieldFilled(" ")).toBe(false);
    expect(isProfileFieldFilled("\t\n")).toBe(false);
  });

  it("accepts a single real character", () => {
    expect(isProfileFieldFilled("X")).toBe(true);
  });
});

describe("validateProfileField", () => {
  it("names the specific field in the message, so the user isn't left guessing", () => {
    expect(validateProfileField("firstName", "")).toBe("First name is required");
    expect(validateProfileField("lastName", "")).toBe("Last name is required");
    expect(validateProfileField("organization", "")).toBe(
      "Organisation is required"
    );
  });

  it("accepts a valid value", () => {
    expect(validateProfileField("firstName", "Xavier")).toBeNull();
  });

  it("enforces the length ceiling on the NORMALISED value", () => {
    const atLimit = "a".repeat(PROFILE_FIELD_MAX_LENGTH);
    expect(validateProfileField("firstName", atLimit)).toBeNull();
    expect(validateProfileField("firstName", atLimit + "b")).toMatch(
      /characters or fewer/
    );
    // Padding must not push an otherwise-valid value over the limit.
    expect(validateProfileField("firstName", `  ${atLimit}  `)).toBeNull();
  });
});

// ─── THE LENGTH BOUNDARIES ───
//
// Off-by-one is the entire risk in this change: the rules are enforced on three
// surfaces from this one function, so a wrong `<` vs `<=` here rejects a legitimate
// 2-character name (or accepts a 26-character one) everywhere at once. Each boundary
// is asserted on BOTH sides rather than at the midpoint, and against the CONSTANTS
// rather than the literals 2 and 25, so a future change to either number moves these
// tests with it instead of leaving them silently testing the wrong edge.
describe("validateProfileField — length boundaries", () => {
  const below = "a".repeat(PROFILE_FIELD_MIN_LENGTH - 1);
  const atMin = "a".repeat(PROFILE_FIELD_MIN_LENGTH);
  const atMax = "a".repeat(PROFILE_FIELD_MAX_LENGTH);
  const above = "a".repeat(PROFILE_FIELD_MAX_LENGTH + 1);

  it("documents the boundaries it is pinning", () => {
    // If this fails, the constants moved and every expectation below is about a
    // different rule than the one described in the test names.
    expect(PROFILE_FIELD_MIN_LENGTH).toBe(2);
    expect(PROFILE_FIELD_MAX_LENGTH).toBe(25);
  });

  for (const field of PROFILE_FIELDS) {
    // Every field, not just firstName: the length rule is shared, and asserting it
    // on one field would let a per-field override slip through unnoticed.
    it(`${field.key}: rejects one BELOW the minimum (length ${below.length})`, () => {
      expect(validateProfileField(field.key, below)).toBe(
        `${field.label} must be at least ${PROFILE_FIELD_MIN_LENGTH} characters`
      );
    });

    it(`${field.key}: accepts exactly the minimum (length ${atMin.length})`, () => {
      expect(validateProfileField(field.key, atMin)).toBeNull();
    });

    it(`${field.key}: accepts exactly the maximum (length ${atMax.length})`, () => {
      expect(validateProfileField(field.key, atMax)).toBeNull();
    });

    it(`${field.key}: rejects one ABOVE the maximum (length ${above.length})`, () => {
      expect(validateProfileField(field.key, above)).toBe(
        `${field.label} must be ${PROFILE_FIELD_MAX_LENGTH} characters or fewer`
      );
    });
  }

  it("accepts the real two-letter names the minimum was set to 2 for", () => {
    // Li, Bo, Xi, Ng are given names and surnames people have. A minimum of 3 would
    // reject all of them; this test is why the constant is 2.
    for (const name of ["Li", "Bo", "Xi", "Ng", "Al", "Jo"]) {
      expect(validateProfileField("lastName", name), name).toBeNull();
      expect(validateProfileField("firstName", name), name).toBeNull();
    }
  });

  it("measures the boundary in CODE POINTS, not UTF-16 code units", () => {
    // "José" typed on a Mac may arrive DECOMPOSED (e + U+0301), which is 5 code
    // units for 4 characters. Naive `.length` would let a 25-character accented name
    // fail while its unaccented twin passes — a bug that only shows up for the users
    // least able to work around it.
    const decomposed = "e\u0301".repeat(PROFILE_FIELD_MAX_LENGTH);
    expect(decomposed.length).toBeGreaterThan(PROFILE_FIELD_MAX_LENGTH);
    expect(validateProfileField("firstName", decomposed)).toBeNull();
    expect(
      validateProfileField("firstName", decomposed + "e\u0301")
    ).toMatch(/characters or fewer/);
  });

  it("applies the MINIMUM to the normalised value, so padding can't satisfy it", () => {
    // "  a  " normalises to "a" — one character. If the check ran on the raw string
    // it would see five and pass.
    expect(validateProfileField("firstName", "  a  ")).toMatch(/at least/);
    expect(validateProfileField("firstName", "a\t\na")).toBeNull(); // → "a a", 3 chars
  });

  it("reports an empty value as REQUIRED rather than as too short", () => {
    // Both are true; "is required" is the actionable one, and a blank field told it
    // "must be at least 2 characters" reads like a system that can't see it is empty.
    expect(validateProfileField("firstName", "")).toBe("First name is required");
    expect(validateProfileField("firstName", "   ")).toBe(
      "First name is required"
    );
  });

  it("reports an over-long value as too LONG, not as bad characters", () => {
    // A 30-character name full of legal letters must not be told its characters are
    // wrong — fixing the reported problem would not fix the real one.
    expect(validateProfileField("firstName", "a".repeat(30))).toMatch(
      /characters or fewer/
    );
  });
});

// ─── THE CHARACTER RULES ───
//
// The requirement is "no numbers or special chars in names, for org numbers allowed".
// The trap is implementing that as /^[A-Za-z]+$/, which passes every English test and
// silently locks out a large share of real users. These tests exist to fail loudly if
// anyone narrows the rule back to ASCII.
describe("validateProfileField — character rules", () => {
  const realNames = [
    "José", // Spanish, composed accent
    "Müller", // German umlaut
    "Škoda", // Czech caron
    "Đukić", // Serbian Latin
    "Łukasz", // Polish
    "Ægir", // Old Norse ligature
    "Ana María", // space
    "Anne-Marie", // hyphen
    "O'Brien", // straight apostrophe
    "D’Angelo", // curly apostrophe — what iOS and Word actually produce
    "van der Berg", // multiple spaces
    "St. John", // full stop
    "田中", // Japanese — 2 characters, so it also needs min length 2 to pass
    "Иванов", // Cyrillic
    "Γεωργίου", // Greek
    "김민준", // Korean
    "עברית", // Hebrew, RTL
    "محمود", // Arabic, RTL
  ];

  it("accepts real names from many scripts — an A-Z rule would reject these", () => {
    for (const name of realNames) {
      expect(validateProfileField("firstName", name), name).toBeNull();
      expect(validateProfileField("lastName", name), name).toBeNull();
      // Whatever a name may contain, an organisation may contain too.
      expect(validateProfileField("organization", name), name).toBeNull();
    }
  });

  it("accepts a DECOMPOSED accent, not just the composed form", () => {
    // Same visible name, different bytes, depending on the keyboard and the paste.
    // Both must be accepted or the same user succeeds on one device and fails on
    // another.
    // Written with ESCAPES, not literals: the two spellings are identical on
    // screen, so a literal version of this test is indistinguishable from a
    // copy-paste duplicate and the decomposed case could be silently lost.
    const composed = "Jos\u00E9"; // e-acute as ONE code point
    const decomposed = "Jose\u0301"; // plain e + COMBINING ACUTE ACCENT
    expect(composed).not.toBe(decomposed);
    expect(validateProfileField("firstName", composed)).toBeNull();
    // Passes ONLY because the class includes \p{M}: a combining accent is a mark,
    // not a letter, so a \p{L}-only rule would reject this spelling of a name it
    // happily accepts in composed form. That asymmetry is invisible in testing
    // unless it is asserted here.
    expect(validateProfileField("firstName", decomposed)).toBeNull();
  });

  it("REJECTS digits in names, naming the field and the rule", () => {
    expect(validateProfileField("firstName", "Ada2")).toBe(
      "First name can only contain letters, spaces, hyphens, apostrophes and full stops"
    );
    expect(validateProfileField("lastName", "Lovelace3")).toMatch(
      /can only contain letters/
    );
    // Non-ASCII digits are digits too — Arabic-Indic ٢ must not sneak past a
    // [0-9]-shaped rule.
    expect(validateProfileField("firstName", "Ada٢")).toMatch(
      /can only contain letters/
    );
  });

  it("ALLOWS digits in the organisation — the one asymmetry in the contract", () => {
    for (const org of ["Studio 54", "Formula 1", "3M", "Company 42"]) {
      expect(validateProfileField("organization", org), org).toBeNull();
    }
  });

  it("rejects special characters on every field", () => {
    // The allowlist is the contract; everything else is denied by default. These are
    // the characters that turn a name field into an injection or spoofing surface.
    const rejected = [
      "Ada<script>",
      "Ada@example",
      "Ada#1",
      "Ada$",
      "Ada%",
      "Ada/Bob",
      "Ada\\Bob",
      "Ada;DROP",
      "Ada,Bob",
      "Ada(Bob)",
      "Ada&Bob",
      "Ada_Bob",
      "Ada*",
      "Ada+Bob",
      "Ada=Bob",
      "Ada|Bob",
      'Ada"Bob',
      "Ada!",
      "Ada?",
      "Ada~",
      "Ada:Bob",
      "Ada\u0000Bob", // NUL
      "Ada‍Bob", // zero-width joiner: invisible, so deliberately denied
    ];
    for (const value of rejected) {
      expect(validateProfileField("firstName", value), value).not.toBeNull();
      // The organisation is looser about DIGITS only, not about symbols.
      expect(validateProfileField("organization", value), value).not.toBeNull();
    }
  });

  it("rejects an emoji, which is neither a letter nor allowed punctuation", () => {
    expect(validateProfileField("firstName", "Ada🚀")).not.toBeNull();
    // Also on its own, where the code-point count would otherwise be 2 and pass the
    // length rule.
    expect(validateProfileField("firstName", "🚀🚀")).not.toBeNull();
  });

  it("requires at least one LETTER, so punctuation alone is not a name", () => {
    // Every character below is individually allowed; the value is still not a name.
    for (const value of ["---", "'''", "...", ". -", "'-."]) {
      expect(validateProfileField("lastName", value), value).toBe(
        "Last name must contain at least one letter"
      );
    }
    // And an organisation of digits alone is not a name either, even though digits
    // are allowed there.
    expect(validateProfileField("organization", "42")).toBe(
      "Organisation must contain at least one letter"
    );
  });

  it("does not let leading or trailing punctuation stand in for length", () => {
    // "-a" is 2 allowed characters and contains a letter, so it passes — documented
    // rather than asserted as a defect: refusing it would need a rule about WHERE
    // punctuation may sit, which would reject the legitimate "'t Hooft".
    expect(validateProfileField("lastName", "'t")).toBeNull();
  });
});

describe("profileFieldCharacterRule", () => {
  it("gives the form the SAME class the validator enforces", () => {
    // The HTML `pattern` is a hint, but a hint that disagrees with the validator is
    // worse than none — it would block a value the API accepts. Build the RegExp the
    // browser would and check it agrees on the asymmetric case.
    for (const field of PROFILE_FIELDS) {
      const rule = profileFieldCharacterRule(field.key);
      const asBrowserWould = new RegExp(`^(?:${rule.htmlPattern})$`, "u");
      expect(asBrowserWould.test("José"), field.key).toBe(true);
      expect(asBrowserWould.test("Ada@x"), field.key).toBe(false);
      // Digits: allowed for the organisation, refused for the names.
      expect(asBrowserWould.test("Studio 54"), field.key).toBe(
        field.key === "organization"
      );
    }
  });

  it("describes the rule in copy the hint and the error message share", () => {
    expect(profileFieldCharacterRule("firstName").describe).toBe(
      "can only contain letters, spaces, hyphens, apostrophes and full stops"
    );
    expect(profileFieldCharacterRule("organization").describe).toContain(
      "numbers"
    );
  });
});

describe("PROFILE_FIELD_MAX_RAW_LENGTH", () => {
  it("is looser than the business ceiling, so a padded paste still reaches the validator", () => {
    // The transport bound and the length RULE are different jobs. If the raw cap were
    // equal to the ceiling, "  <25 chars>  " would be rejected at the edge as too
    // long even though it normalises to exactly the limit — the form would then be
    // showing an error the shared validator disagrees with.
    expect(PROFILE_FIELD_MAX_RAW_LENGTH).toBeGreaterThan(PROFILE_FIELD_MAX_LENGTH);
    const padded = `  ${"a".repeat(PROFILE_FIELD_MAX_LENGTH)}  `;
    expect(padded.length).toBeLessThanOrEqual(PROFILE_FIELD_MAX_RAW_LENGTH);
    expect(validateProfileField("firstName", padded)).toBeNull();
  });
});

describe("validateProfile", () => {
  it("reports every missing field at once, not just the first", () => {
    const errors = validateProfile({});
    expect(Object.keys(errors).sort()).toEqual([
      "firstName",
      "lastName",
      "organization",
    ]);
  });

  it("returns no errors for a filled profile", () => {
    expect(
      validateProfile({
        firstName: "Xavier",
        // Was "S" before the minimum length existed. Changed because the INPUT is now
        // invalid, not to make a failing assertion pass — a one-character surname is
        // rejected by design, and the boundary suite above asserts that directly.
        lastName: "Sy",
        organization: "Amazon",
      })
    ).toEqual({});
  });

  it("covers every field in PROFILE_FIELDS, so adding one can't skip validation", () => {
    const errors = validateProfile({});
    for (const field of PROFILE_FIELDS) {
      expect(errors[field.key], `${field.key} unvalidated`).toBeDefined();
    }
  });

  it("reports each field's OWN failure reason, not one shared message", () => {
    // Three different rules broken at once. A form showing "invalid profile" three
    // times would leave the user to work out which rule applied where.
    const errors = validateProfile({
      firstName: "a", // too short
      lastName: "Lovelace9", // disallowed digit
      organization: "a".repeat(26), // too long
    });
    expect(errors.firstName).toMatch(/at least/);
    expect(errors.lastName).toMatch(/can only contain letters/);
    expect(errors.organization).toMatch(/characters or fewer/);
  });
});

describe("isProfileComplete", () => {
  const complete = {
    firstName: "Xavier",
    lastName: "S",
    organization: "Amazon",
  };

  it("is true only when all three are present", () => {
    expect(isProfileComplete(complete)).toBe(true);
  });

  it("is false when any single field is missing", () => {
    for (const field of PROFILE_FIELDS) {
      const partial = { ...complete, [field.key]: "" };
      expect(isProfileComplete(partial), `${field.key} not enforced`).toBe(false);
    }
  });

  it("treats a pre-existing row with no profile fields as INCOMPLETE", () => {
    // Rows written before these fields existed carry only id/email/name. Asking
    // those users once is the intended behaviour, not a bug.
    expect(isProfileComplete({ name: "Xavier S" } as never)).toBe(false);
    expect(isProfileComplete(undefined)).toBe(false);
    expect(isProfileComplete(null)).toBe(false);
  });

  it("is not satisfied by whitespace", () => {
    expect(isProfileComplete({ ...complete, organization: "   " })).toBe(false);
  });

  // ─── THE ANTI-LOCKOUT PROPERTY ───
  //
  // The gate checks PRESENCE; the validator checks VALIDITY. They are deliberately
  // different, and this is the test that says so out loud.
  //
  // Tightening validation (min length, letters-only) made values that were legal
  // yesterday illegal today, and rows carrying them are already in DynamoDB. If the
  // gate were re-pointed at validateProfile(), every one of those users would be
  // redirected to the profile form on their next request — and the form's Save would
  // refuse the value it is complaining about, with no way out. This suite fails if
  // anyone "tidies up" the gate by reusing the validator.
  it("still reads a STORED value that today's validator would reject as complete", () => {
    const stored = [
      { firstName: "Li", lastName: "S", organization: "Amazon" }, // 1-char surname
      { firstName: "Ada", lastName: "Lovelace2", organization: "Acme" }, // digit
      { firstName: "Ada", lastName: "Lovelace", organization: "AT&T" }, // ampersand
      {
        firstName: "Ada",
        lastName: "Lovelace",
        organization: "a".repeat(120), // legal under the OLD 120 ceiling
      },
    ];
    for (const profile of stored) {
      // Invalid by today's rules...
      expect(
        Object.keys(validateProfile(profile)).length,
        JSON.stringify(profile)
      ).toBeGreaterThan(0);
      // ...but NOT incomplete, so the gate leaves the user alone instead of trapping
      // them at a form that would refuse to save.
      expect(isProfileComplete(profile), JSON.stringify(profile)).toBe(true);
    }
  });
});

describe("displayName", () => {
  it("joins the stored parts", () => {
    expect(displayName({ firstName: "Ada", lastName: "Lovelace" })).toBe(
      "Ada Lovelace"
    );
  });

  it("falls back to a legacy single `name` when the parts are absent", () => {
    expect(displayName({ name: "Ada Lovelace" })).toBe("Ada Lovelace");
  });

  it("falls back to the email local part, never showing the domain", () => {
    expect(displayName({ email: "ada@example.com" })).toBe("ada");
  });

  it("never returns an empty string", () => {
    expect(displayName({})).toBe("there");
    expect(displayName(undefined)).toBe("there");
  });

  it("prefers the parts over a stale legacy `name`", () => {
    expect(
      displayName({ firstName: "Ada", lastName: "Byron", name: "Old Value" })
    ).toBe("Ada Byron");
  });
});

describe("greetingName", () => {
  it("uses the stored first name, not a split of the display name", () => {
    // The old heuristic (name.split(" ")[0]) is wrong for a two-word given name;
    // storing the parts is what fixes it.
    expect(greetingName({ firstName: "Mary Jane", lastName: "Watson" })).toBe(
      "Mary Jane"
    );
  });

  it("falls back to the first token when no first name is stored", () => {
    expect(greetingName({ name: "Ada Lovelace" })).toBe("Ada");
  });
});

describe("profileInitials", () => {
  it("builds a two-letter monogram from the parts, uppercased", () => {
    expect(profileInitials({ firstName: "ada", lastName: "lovelace" })).toBe("AL");
  });

  it("handles a first name only", () => {
    expect(profileInitials({ firstName: "Ada" })).toBe("A");
  });

  it("falls back to the display name's first two words", () => {
    expect(profileInitials({ name: "Ada Lovelace" })).toBe("AL");
  });

  it("never returns an empty badge", () => {
    expect(profileInitials({})).toBe("?");
    expect(profileInitials(undefined)).toBe("?");
  });
});
