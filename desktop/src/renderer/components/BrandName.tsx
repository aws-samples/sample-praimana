/**
 * ── THE WORD "Praimana", WITH ITS "ai" PICKED OUT ──────────────────────────────────────────
 *
 * The name was chosen so that it contains "AI", and this is where the UI says so: `Pr` + `ai` + `mana`,
 * the middle two letters in `brand-accent`. One component, used at every place the product name is
 * shown as a node, because a split that is pasted into five files is a split that drifts in four of them
 * (`brand-parity.test.ts` exists for the same reason, for the plain-string copies).
 *
 * ⚠ IT RENDERS A FRAGMENT WITH ONE INLINE `<span>`, AND NOTHING ELSE. No wrapper element, so the size,
 * weight and colour of the surrounding `<h1>`, lockup or sentence apply unchanged and the component
 * cannot alter layout; the only thing it adds is the colour of two letters.
 *
 * ⚠ THE ACCESSIBLE NAME IS LEFT ALONE ON PURPOSE. Text nodes inside inline elements concatenate in the
 * accessibility tree, so `Pr<span>ai</span>mana` is announced and computed as "Praimana" with no help.
 * That is why there is NO `aria-hidden` on the span (it would read "Prmana") and NO `aria-label` on a
 * wrapper (it would announce the name twice, or override the surrounding sentence). The markup is also
 * written with no whitespace between the pieces: a line break inside JSX text is harmless, but one
 * between the elements would render a visible gap in the word.
 *
 * ⚠ COLOUR IS DECORATION HERE, NOT A SIGNAL. The word reads identically with or without the tint, so
 * nothing is lost to someone who cannot see the difference and no second affordance is needed — this
 * is not a status. `brand-accent` is the token documented as legal AS TEXT on every surface in the app
 * (8.14:1 on `surface-panel`, 9.84:1 on `surface-bg`); `claude-accent` is not, and must not be used.
 *
 * NOT USED for the copyright footers, which stay plain text: a legal line names the owner and should
 * read as neutrally as possible, and small muted text is where an accent would pull the eye the most.
 */
export function BrandName() {
  return (
    <>
      Pr<span className="text-brand-accent">ai</span>mana
    </>
  );
}
