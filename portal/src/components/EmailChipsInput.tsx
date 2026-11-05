"use client";

import { useState } from "react";

/**
 * A multi-email entry field: type an address, press space/enter/comma (or blur) and
 * it becomes a chip; backspace on an empty input pops the last one.
 *
 * Extracted because there are now two invite forms, the team workspace and the
 * Administration invitations tab, and this is precisely the behaviour that drifts
 * between copies. The commit-on-blur, the backspace-pop and the address test are
 * subtle enough that two versions would diverge without anyone noticing which one
 * was right.
 *
 * The address test is deliberately loose (non-space, one @, a dot in the domain).
 * It is here to catch a typo before the user hits Send, NOT to decide what a valid
 * address is: the invitation is stored server-side against the address, and the
 * email either arrives or it doesn't. A stricter regex would reject real addresses
 * and would be a second opinion nothing downstream consults.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function EmailChipsInput({
  emails,
  onChange,
  id = "email-chips-input",
  placeholder = "Type emails separated by space",
  disabled = false,
}: {
  emails: string[];
  onChange: (emails: string[]) => void;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");

  function commit() {
    const email = draft.trim().replace(/,$/, "");
    // Silently drops an invalid or duplicate address but still clears the draft, so
    // the field never gets stuck holding text the user thinks they've entered.
    if (email && EMAIL_RE.test(email) && !emails.includes(email)) {
      onChange([...emails, email]);
    }
    setDraft("");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === " " || e.key === "Enter" || e.key === ",") {
      // Enter must not submit the surrounding form mid-entry.
      e.preventDefault();
      commit();
      return;
    }
    if (e.key === "Backspace" && !draft && emails.length > 0) {
      onChange(emails.slice(0, -1));
    }
  }

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 min-h-[42px] rounded-md border border-field-border px-3 py-2 focus-within:border-brand focus-within:ring-1 focus-within:ring-brand cursor-text"
      onClick={() => document.getElementById(id)?.focus()}
    >
      {emails.map((email) => (
        <span
          key={email}
          className="inline-flex items-center gap-1 bg-brand-subtle text-brand-text rounded-md px-2 py-0.5 text-sm"
        >
          {email}
          <button
            type="button"
            aria-label={`Remove ${email}`}
            onClick={() => onChange(emails.filter((e) => e !== email))}
            className="text-brand-text hover:text-brand-text-strong font-medium"
          >
            &times;
          </button>
        </span>
      ))}
      <input
        id={id}
        type="text"
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        // Commit on blur so a typed-but-not-delimited address isn't silently lost
        // when the user clicks Send directly.
        onBlur={commit}
        placeholder={emails.length === 0 ? placeholder : ""}
        className="flex-1 min-w-[180px] outline-none text-sm py-0.5 disabled:bg-transparent"
      />
    </div>
  );
}
