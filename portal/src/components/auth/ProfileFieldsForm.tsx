"use client";

import {
  PROFILE_FIELDS,
  PROFILE_FIELD_MAX_LENGTH,
  PROFILE_FIELD_MIN_LENGTH,
  profileFieldCharacterRule,
  type ProfileFieldKey,
  type ProfileFields,
} from "@praimana/shared";
import { AuthField } from "./AuthShell";

/**
 * The three mandatory profile fields, rendered from the shared PROFILE_FIELDS list.
 *
 * Driven off that list rather than three hand-written inputs so a field added to the
 * contract cannot be forgotten here, the alternative is a field the API demands and
 * the form never asks for, which locks the user out of an app they can't fix.
 *
 * The `autoComplete` values come from the same list: "given-name" / "family-name" /
 * "organization" are what let a browser or password manager fill this in one click.
 */
export function ProfileFieldsForm({
  values,
  errors,
  onChange,
  disabled,
  autoFocusFirst,
}: {
  values: ProfileFields;
  errors: Partial<Record<ProfileFieldKey, string>>;
  onChange: (key: ProfileFieldKey, value: string) => void;
  disabled?: boolean;
  autoFocusFirst?: boolean;
}) {
  return (
    <>
      {PROFILE_FIELDS.map((field, index) => {
        const rule = profileFieldCharacterRule(field.key);
        return (
          <AuthField
            key={field.key}
            id={field.key}
            label={field.label}
            type="text"
            autoComplete={field.autoComplete}
            value={values[field.key]}
            onChange={(e) => onChange(field.key, e.target.value)}
            error={errors[field.key]}
            disabled={disabled}
            autoFocus={autoFocusFirst && index === 0}
            // `required` is a courtesy that catches the empty case before a round
            // trip; whitespace-only still needs the shared validator, and the real
            // gate is the identity service's PATCH handler.
            required
            // maxLength genuinely STOPS the 26th character being typed, which is why
            // it is the one constraint worth having here: the user cannot get into
            // the over-length state at all.
            maxLength={PROFILE_FIELD_MAX_LENGTH}
            // minLength and pattern are HINTS ONLY, the browser applies them on
            // submit, they are removable with dev tools, and `pattern` is matched
            // against the RAW value while our rule is applied to the normalised one.
            // So a value with a trailing space can fail here and pass the real
            // validator; that is acceptable for a hint and is exactly why the shared
            // validator still runs on every submit in AuthFlow and /profile.
            minLength={PROFILE_FIELD_MIN_LENGTH}
            pattern={rule.htmlPattern}
            // The rule stated UP FRONT rather than only after a rejection. An error
            // the user could have avoided is a worse experience than a hint they
            // didn't need, and it is wired to the input via aria-describedby by
            // AuthField, so a screen reader reads it with the field.
            hint={`${PROFILE_FIELD_MIN_LENGTH}–${PROFILE_FIELD_MAX_LENGTH} characters; ${rule.describe}.`}
          />
        );
      })}
    </>
  );
}

/** An all-empty value set, the starting state for a new sign-up. */
export const EMPTY_PROFILE_FIELDS: ProfileFields = {
  firstName: "",
  lastName: "",
  organization: "",
};
