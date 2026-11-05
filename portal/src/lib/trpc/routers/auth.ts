import { z } from "zod";
import { router, protectedProcedure } from "../trpc";
import { backendFetch } from "@/lib/backend";
import {
  PROFILE_FIELD_MAX_RAW_LENGTH,
  PROFILE_FIELDS,
  normalizeProfileField,
  validateProfileField,
  type ProfileFieldKey,
} from "@praimana/shared";

/**
 * The caller's own identity and profile.
 *
 * Every procedure here is scoped to the CALLER by construction: the identity
 * service resolves the subject from the verified token it is handed, and neither
 * route accepts a user id. That is deliberate, a profile endpoint that took an id
 * would need its own authorization rules, and the only thing this feature needs is
 * "me".
 */

/** What GET/PATCH /v1/auth/me returns. */
export interface Me {
  id: string;
  email: string;
  role: string;
  name: string;
  firstName?: string;
  lastName?: string;
  organization?: string;
  authProvider?: string;
  /** Computed server-side from the three mandatory fields. */
  profileComplete: boolean;
}

/**
 * One profile field: bounded raw, then NORMALISED, and the normalisation is a fix.
 *
 * ⚠ THE VALIDATED STRING AND THE PERSISTED STRING WERE NOT THE SAME STRING. `validateProfileField`
 * normalises internally, `value.replace(/\s+/g, " ").trim()`, and tests every rule, including
 * the `[\p{L}\p{M}'\-. ]` allowlist, against that normalised value. The mutation then sent the RAW
 * object. JavaScript `\s` covers `\n`, `\r`, `\t`, `\v`, `\f`, U+0020, U+00A0, U+1680,
 * U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF (the BOM), so
 * `"Ada\nLovelace"` normalised to the perfectly legal `"Ada Lovelace"`, passed the gate, and was
 * stored WITH the embedded newline; `"Ada" + U+FEFF + "Lovelace"` stored an invisible code point.
 * That defeated the module's own stated rule, control characters are listed among the rejected set and
 * invisible code points are refused deliberately as "a homograph vector", and fanned CR/LF and
 * zero-width characters out to the identity service, the users read-model and every roster,
 * directory and insights surface, plus newline injection into whatever the identity service logs.
 *
 * `.transform` BEFORE the `.superRefine` below is what closes it: the refine and the sink now
 * operate on one string, so whatever passed validation is exactly what is persisted. No caller
 * changes, both in-repo clients already normalised before sending, which is why only a direct
 * tRPC call (any signed-in user with a session cookie) ever exercised the gap.
 *
 * The two layers this had, both kept:
 *
 *   1. `.max(PROFILE_FIELD_MAX_RAW_LENGTH)` on the RAW string, a payload bound, so
 *      an absurd megabyte value is refused before any regex runs on it. Deliberately
 *      looser than the business ceiling, because the length RULE applies to the
 *      normalised value and a padded-but-legal paste must survive to be normalised.
 *      Ordered before the transform for exactly that reason.
 *
 *   2. `validateProfileField()` from @praimana/shared, the min/max length and
 *      the per-field character rule. Called rather than re-expressed as zod
 *      constraints, which is the whole point: the rules live in ONE module, and the
 *      identity service's PATCH handler (the real gate) evaluates the same function
 *      on the same normalised value. A `.min(2)` written out here would be a second
 *      copy to forget, and the failure mode of forgetting is a user bounced to a form
 *      whose Save is refused.
 *
 * ⚠ NOT A SUBSTITUTE FOR THE SERVICE'S OWN CHECK. The identity service validates independently
 * because a client can skip the portal entirely, but it "evaluates the same function on the same
 * normalised value", so it had the same defect and was never a backstop for this one.
 */
const profileField = () =>
  z.string().max(PROFILE_FIELD_MAX_RAW_LENGTH).transform(normalizeProfileField);

/**
 * The BFF's gate on the three mandatory fields. See {@link profileField}.
 *
 * ⚠ EXPORTED FOR ITS TESTS. What this schema OUTPUTS is now a security property, the sink
 * persists it verbatim, so "a newline is stored collapsed rather than raw" has to be assertable
 * without standing up a session and a backend. `auth.profile-normalisation.test.ts` is the caller.
 */
export const profileInput = z
  .object({
    firstName: profileField(),
    lastName: profileField(),
    organization: profileField(),
  })
  // The `satisfies` is the drift guard, not decoration: adding a fourth key to
  // ProfileFieldKey without a rule here fails type-check rather than shipping an
  // unvalidated field.
  .superRefine((value: Record<ProfileFieldKey, string>, ctx) => {
    // Driven off PROFILE_FIELDS so a field added to the contract is validated here
    // automatically, the loop cannot be "forgotten" for one key.
    for (const field of PROFILE_FIELDS) {
      const message = validateProfileField(field.key, value[field.key]);
      if (message) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          // Pathed to the field so the client can show the message in place rather
          // than as one opaque form-level error.
          path: [field.key],
          message,
        });
      }
    }
  }) satisfies z.ZodType<Record<ProfileFieldKey, string>>;

export const authRouter = router({
  me: protectedProcedure.query(async ({ ctx }) => {
    const data = await backendFetch("/v1/auth/me", { token: ctx.token });
    return data.user as Me;
  }),

  updateProfile: protectedProcedure
    .input(profileInput)
    .mutation(async ({ ctx, input }) => {
      /**
       * ⚠ `input` IS THE NORMALISED OBJECT, NOT THE RAW ONE, AND THAT IS THE FIX. `profileField`
       * transforms before the refine runs, so the value forwarded here is character-for-character
       * the value the allowlist accepted. It used to be the raw body, which is how a newline or a
       * BOM entered the platform display name, see {@link profileField}. Anything added to this
       * body must come from `input` for the same reason.
       */
      const data = await backendFetch("/v1/auth/me", {
        method: "PATCH",
        token: ctx.token,
        body: JSON.stringify(input),
      });
      return data.user as Me;
    }),
});
