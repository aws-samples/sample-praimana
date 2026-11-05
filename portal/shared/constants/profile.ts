/**
 * The MANDATORY profile fields — first name, last name, organisation — and the one
 * validation + display contract that every surface shares.
 *
 * Why this lives in `shared` rather than in the portal or the identity service:
 * three places have to agree on exactly what "complete" means, and they run in
 * different processes.
 *
 *   1. The sign-up form, which must not let someone submit a blank organisation.
 *   2. The identity service's PATCH handler, which is the real gate — a client can
 *      always skip the form and call the API directly, so validation there is the
 *      control and validation in the form is only courtesy.
 *   3. The completion gate, which decides whether to force someone back to the
 *      profile step before they can use the app.
 *
 * If those three disagree the failure is nasty and silent: a user is bounced to a
 * form that then refuses to save, or worse, saves a value the gate still reads as
 * incomplete — an inescapable redirect loop. One module, one answer.
 */

/** Longest accepted value for any single profile field, in CODE POINTS. */
export const PROFILE_FIELD_MAX_LENGTH = 25;

/**
 * Shortest accepted value for any single profile field, in CODE POINTS.
 *
 * 2, not 3, precisely so that real short names pass: Li, Bo, Xi, An, Al, Jo, Ng and
 * Ho are given names and surnames people actually have, and refusing them would be a
 * defect on the one field a person is least willing to be told is wrong.
 *
 * 2 rather than 1 because a single character is almost always a typo or a
 * placeholder ("a", "x", "."), and it makes the derivations built on these fields
 * meaningless — a one-letter surname yields a monogram indistinguishable from a
 * first-name-only one and a display name that reads as truncated. The cost of being
 * wrong here is low and self-correcting: the user sees the message and types the
 * rest.
 */
export const PROFILE_FIELD_MIN_LENGTH = 2;

/**
 * Absolute cap on the RAW, un-normalised string a transport layer will accept.
 *
 * Not the same rule as PROFILE_FIELD_MAX_LENGTH, and deliberately looser: the
 * length rules above apply to the NORMALISED value, so a pasted "  Analytical
 * Engines  " must survive the transport check and be judged after its padding is
 * collapsed. A tight raw cap would reject values the real validator accepts —
 * exactly the drift this module exists to prevent.
 *
 * 4x the ceiling: enough headroom for any plausible amount of pasted whitespace,
 * while still bounding the payload so an absurd megabyte string never reaches the
 * validator or the round trip. It is a payload bound, not a business rule.
 */
export const PROFILE_FIELD_MAX_RAW_LENGTH = PROFILE_FIELD_MAX_LENGTH * 4;

/**
 * The character classes a profile field may be built from, as SOURCE fragments so
 * the same definition can produce both a JS RegExp and an HTML `pattern` attribute.
 * One definition, two surfaces — writing the class twice is how the form starts
 * accepting something the API refuses.
 *
 * `\p{L}` (any letter, any script) and `\p{M}` (combining marks) rather than A-Z.
 * This is not politeness, it is correctness: an A-Z rule rejects José, Müller,
 * Škoda, Đukić, 田中 and عبد الله, and it does so INVISIBLY to anyone testing in
 * English. `\p{M}` is needed because "José" may arrive decomposed (e + U+0301) from
 * a Mac keyboard or an iOS paste, in which case the accent is a separate code point
 * that is not itself a letter.
 *
 * Punctuation allowed, and why each one is here rather than merely tolerated:
 *   '  and  ’   O'Brien, D’Angelo — apostrophe-bearing surnames are everywhere, and
 *               the curly form is what iOS and Word actually produce.
 *   -           Anne-Marie, Sacha-Baron Cohen.
 *   (space)     van der Berg, De La Cruz, Amazon Web Services.
 *   .           Jr., St. John, Acme Inc.
 *
 * Rejected: digits in names (the stated requirement), and every other symbol —
 * @ # $ % / \ < > ( ) & , : ; " ! ? + = * _ ~ | ^ and control characters. Denying by
 * default is the point; the set above is the allowlist.
 *
 * NOT allowed, as a conscious call rather than an oversight: the zero-width joiner
 * and non-joiner (U+200D / U+200C), which some Persian and Indic names use for
 * correct rendering. They are invisible, which makes them both a homograph vector
 * and impossible for a user to see in a rejection message. If a real user is blocked
 * by this, the fix is to add them here with a note — not to widen the class blindly.
 */
const NAME_CHARACTER_CLASS = "[\\p{L}\\p{M}'’\\-. ]";

/**
 * The organisation class: the name class plus DECIMAL DIGITS of any script
 * (`\p{Nd}`), because an organisation legitimately carries a number — "Studio 54",
 * "Formula 1", "3M".
 *
 * Still no ampersand or comma, so "AT&T" and "Acme, Inc" are refused. That follows
 * the stated rule ("for org numbers allowed") literally rather than guessing at a
 * wider set; it is the likeliest source of a real complaint on this field and the
 * cheapest thing to widen if one arrives.
 */
const ORGANIZATION_CHARACTER_CLASS = "[\\p{L}\\p{M}\\p{Nd}'’\\-. ]";

/**
 * The per-field character rules, defined once and shared by the two name fields.
 *
 * The RegExp objects are built at module load and reused: no pattern is compiled
 * per validation call, and none carries the `g` flag, so there is no `lastIndex`
 * state to make a shared instance unsafe.
 *
 * `describe` is a copy fragment that reads correctly after any field label, so the
 * message stays specific to the field the user is looking at.
 */
const PROFILE_CHARACTER_RULES = {
  name: {
    pattern: new RegExp(`^${NAME_CHARACTER_CLASS}+$`, "u"),
    htmlPattern: `${NAME_CHARACTER_CLASS}+`,
    describe:
      "can only contain letters, spaces, hyphens, apostrophes and full stops",
  },
  organization: {
    pattern: new RegExp(`^${ORGANIZATION_CHARACTER_CLASS}+$`, "u"),
    htmlPattern: `${ORGANIZATION_CHARACTER_CLASS}+`,
    describe:
      "can only contain letters, numbers, spaces, hyphens, apostrophes and full stops",
  },
} as const;

/** Which character rule a field follows. */
export type ProfileCharacterRuleKey = keyof typeof PROFILE_CHARACTER_RULES;

/**
 * At least one LETTER must be present, whatever else is allowed.
 *
 * Without this, "---" and "'''" are three legal characters and would pass as a
 * surname, and "..." would pass as an organisation. The character rule alone says
 * what may appear, not that anything meaningful did.
 */
const CONTAINS_LETTER = /\p{L}/u;

/**
 * The three fields, in display order. Used to render the form and to drive the
 * completeness check, so a field can never be added to one and forgotten in the
 * other. `characterRule` is part of that: it is read by the validator and by the
 * form, so a fourth field cannot be added without choosing which rule it follows.
 */
export const PROFILE_FIELDS = [
  {
    key: "firstName",
    label: "First name",
    /** Maps to the Cognito standard attribute of the same meaning. */
    cognitoAttribute: "given_name",
    autoComplete: "given-name",
    characterRule: "name",
  },
  {
    key: "lastName",
    label: "Last name",
    cognitoAttribute: "family_name",
    autoComplete: "family-name",
    characterRule: "name",
  },
  {
    key: "organization",
    label: "Organisation",
    // A CUSTOM attribute: Cognito has no standard claim for employer. The pool
    // defines it as custom:organization (mutable, not required at the pool level —
    // required-ness is OUR rule, enforced here and in the identity service).
    cognitoAttribute: "custom:organization",
    autoComplete: "organization",
    characterRule: "organization",
  },
] as const satisfies readonly {
  key: string;
  label: string;
  cognitoAttribute: string;
  autoComplete: string;
  characterRule: ProfileCharacterRuleKey;
}[];

/** The key of one mandatory profile field. */
export type ProfileFieldKey = (typeof PROFILE_FIELDS)[number]["key"];

/** The three mandatory fields as a plain record. */
export type ProfileFields = Record<ProfileFieldKey, string>;

/**
 * Normalise one submitted value: trim the edges and collapse internal runs of
 * whitespace.
 *
 * Trimming is what makes the completeness check trustworthy — " " must not count
 * as a supplied first name, and a trailing space must not produce a display name
 * that renders as "Xavier  S". Collapsing internal runs keeps a pasted value from
 * carrying a tab or a double space into the header.
 */
export function normalizeProfileField(value: string | undefined | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/** A profile field is present when it has at least one non-whitespace character. */
export function isProfileFieldFilled(value: string | undefined | null): boolean {
  return normalizeProfileField(value).length > 0;
}

/**
 * The character rule a given field follows, and the HTML `pattern` fragment for it.
 *
 * Exported so the form can hint the same rule the validator enforces. The HTML
 * attribute is a UX nicety ONLY — it is trivially removed with dev tools, so
 * validateProfileField() below stays the real check on both surfaces.
 */
export function profileFieldCharacterRule(key: ProfileFieldKey): {
  htmlPattern: string;
  describe: string;
} {
  const field = PROFILE_FIELDS.find((f) => f.key === key);
  // Unknown key falls back to the STRICTER rule (names), not the looser one:
  // a field added without a rule should be over-constrained and noticed, not
  // silently allowed to accept more than intended.
  const rule = PROFILE_CHARACTER_RULES[field?.characterRule ?? "name"];
  return { htmlPattern: rule.htmlPattern, describe: rule.describe };
}

/**
 * Count of USER-PERCEIVED characters, not UTF-16 code units.
 *
 * `"José".length` is 4 or 5 depending on whether the accent arrived composed or
 * decomposed, and an emoji or a CJK extension character counts as 2 via `.length`
 * because it is a surrogate pair. Both would make the same typed name pass on one
 * keyboard and fail on another — the worst kind of validation bug, because it is
 * unreproducible for whoever is looking into it.
 *
 * Normalising to NFC first composes "e + U+0301" back into "é" so the two encodings
 * of one name agree, and the spread then counts CODE POINTS rather than code units.
 * Counting grapheme clusters would be more precise still, but needs Intl.Segmenter
 * and only differs for inputs (flags, ZWJ sequences) the character rules already
 * reject.
 */
function characterLength(normalized: string): number {
  return [...normalized.normalize("NFC")].length;
}

/**
 * Per-field validation message, or null when the value is acceptable.
 *
 * Returns a message rather than a boolean so the form and the API produce
 * identical, specific copy — "First name is required" beats a generic failure, and
 * the user should not have to guess which of three fields was rejected, or which of
 * the three rules it broke.
 *
 * ORDER MATTERS. Required, then length, then characters: telling someone their
 * empty field contains a disallowed character is nonsense, and telling them about
 * characters before length means fixing one error reveals another. Length before
 * characters also means a long value is reported as long rather than as illegal.
 *
 * Every check runs against the NORMALISED value, so trailing whitespace can neither
 * satisfy the minimum nor breach the maximum.
 */
export function validateProfileField(
  key: ProfileFieldKey,
  value: string | undefined | null
): string | null {
  const field = PROFILE_FIELDS.find((f) => f.key === key);
  const label = field?.label ?? key;
  const normalized = normalizeProfileField(value);

  if (!normalized) return `${label} is required`;

  const length = characterLength(normalized);
  if (length < PROFILE_FIELD_MIN_LENGTH) {
    return `${label} must be at least ${PROFILE_FIELD_MIN_LENGTH} characters`;
  }
  if (length > PROFILE_FIELD_MAX_LENGTH) {
    return `${label} must be ${PROFILE_FIELD_MAX_LENGTH} characters or fewer`;
  }

  // See PROFILE_CHARACTER_RULES for the allowlist and the reasoning: letters of ANY
  // script, plus apostrophe / hyphen / space / full stop, plus digits for the
  // organisation only.
  const rule = PROFILE_CHARACTER_RULES[field?.characterRule ?? "name"];
  if (!rule.pattern.test(normalized)) {
    return `${label} ${rule.describe}`;
  }
  // Checked after the pattern so "---" is reported as needing a letter rather than
  // as containing a bad character — the character rule is satisfied, the value still
  // is not a name.
  if (!CONTAINS_LETTER.test(normalized)) {
    return `${label} must contain at least one letter`;
  }

  return null;
}

/**
 * Validate all three at once. The result is keyed by field so a form can show each
 * message in place; an empty object means the profile is acceptable.
 */
export function validateProfile(
  input: Partial<ProfileFields> | undefined | null
): Partial<Record<ProfileFieldKey, string>> {
  const errors: Partial<Record<ProfileFieldKey, string>> = {};
  for (const field of PROFILE_FIELDS) {
    const message = validateProfileField(field.key, input?.[field.key]);
    if (message) errors[field.key] = message;
  }
  return errors;
}

/**
 * Whether a stored profile has all three mandatory fields.
 *
 * This is THE definition of "complete" that the gate uses. Deliberately tolerant
 * of extra properties and of `undefined`, because it is called on rows written
 * before these fields existed — those are incomplete, which is correct: the user
 * is asked once for the details nobody ever collected.
 *
 * PRESENCE, NOT VALIDITY — and that is load-bearing, not laziness. It deliberately
 * does NOT call validateProfileField(), so tightening the rules above can never
 * retroactively mark a stored profile incomplete. If it did, every user whose stored
 * name is one character, or carries a digit or a character the new allowlist refuses
 * ("J2", "Ana-María 2", an ampersand in an organisation), would be bounced to the
 * profile form by the gate on their next request — and the form's Save would then
 * refuse the very value the gate is complaining about. That is the inescapable
 * redirect loop this module's header warns about, and it would be triggered by a
 * validation change alone, with no code near the gate touched.
 *
 * The tradeoff, stated plainly: rows that predate a rule stay readable and their
 * owners keep working, and the new rule applies at the next WRITE. Data written
 * before today may not satisfy today's validator. That is the correct direction to
 * be wrong in — a stale-but-valid-looking row costs nothing, a locked-out user costs
 * a support ticket and their session.
 */
export function isProfileComplete(
  profile: Partial<ProfileFields> | undefined | null
): boolean {
  return PROFILE_FIELDS.every((field) =>
    isProfileFieldFilled(profile?.[field.key])
  );
}

/**
 * The display name built from the parts: "Xavier S".
 *
 * `name` is kept as a DERIVED field rather than replaced, because it is read in
 * several places that have nothing to do with this feature — notably the AI
 * service's users read-model. Deriving it here means those consumers keep working
 * untouched while first/last become the source of truth.
 *
 * Falls back through last-name-only, then the email's local part, then "there", so
 * a greeting never renders as an empty string or the word "undefined".
 */
export function displayName(
  profile:
    | (Partial<ProfileFields> & { name?: string; email?: string })
    | undefined
    | null
): string {
  const first = normalizeProfileField(profile?.firstName);
  const last = normalizeProfileField(profile?.lastName);
  const joined = [first, last].filter(Boolean).join(" ");
  if (joined) return joined;

  // Pre-existing rows may carry only the single `name` field.
  const existing = normalizeProfileField(profile?.name);
  if (existing) return existing;

  const email = normalizeProfileField(profile?.email);
  const localPart = email.split("@")[0];
  return localPart || "there";
}

/**
 * The greeting name — the first name alone where we have one.
 *
 * This replaces the old `session.user.name.split(" ")[0]` guess in the portal.
 * That heuristic is wrong for anyone whose given name contains a space or whose
 * display name is ordered family-name-first, and it is unnecessary now that the
 * parts are stored separately.
 */
export function greetingName(
  profile:
    | (Partial<ProfileFields> & { name?: string; email?: string })
    | undefined
    | null
): string {
  const first = normalizeProfileField(profile?.firstName);
  if (first) return first;
  // No stored first name: fall back to the first token of whatever we can display.
  return displayName(profile).split(" ")[0];
}

/**
 * Up-to-two-letter monogram for the profile avatar, e.g. "XS".
 *
 * Uppercased because it is rendered in a small circle where lowercase reads as a
 * typo. Uses the stored parts when present so it stays correct for names the
 * split-on-space heuristic would mangle.
 */
export function profileInitials(
  profile:
    | (Partial<ProfileFields> & { name?: string; email?: string })
    | undefined
    | null
): string {
  const first = normalizeProfileField(profile?.firstName);
  const last = normalizeProfileField(profile?.lastName);
  if (first || last) {
    return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase() || "?";
  }
  // Fall back to the display name's first two words ("Ada Lovelace" → "AL"), but
  // only when we actually have something to name. Deriving from displayName()'s
  // "there" placeholder would render a confident-looking "T" badge — a letter the
  // user has no connection to, which reads as a wrong initial rather than as an
  // absence. "?" is honest about not knowing.
  const known = normalizeProfileField(profile?.name) || normalizeProfileField(profile?.email);
  if (!known) return "?";

  const parts = displayName(profile).split(" ").filter(Boolean);
  const initials = parts.slice(0, 2).map((p) => p.charAt(0)).join("");
  return initials.toUpperCase() || "?";
}
