/**
 * ── ⚠ A MODEL ID IS RENDERER INPUT THAT REACHES argv ──────────────────────────────────────────
 *
 * On Windows that argv travelled through `cmd.exe` (because `claude` and `codex` are `.cmd` shims), where a
 * defect in the command-line construction made `--model "sonnet & calc.exe"` execute `calc.exe`.
 *
 * The construction is fixed (windows-launch.ts) and the character set that guards it is now strict
 * enough on its own. This exists because BOTH would have had to be wrong for that hole to open, and
 * only one of them was:
 *
 *   · the quoting bug made metacharacters live
 *   · nothing anywhere established that a model id is not an arbitrary string
 *
 * ⚠ SO THIS IS THE LAYER THAT DOES NOT DEPEND ON GETTING cmd.exe RIGHT. It is a validation of what the
 * value IS, at the boundary where it arrives, and it would have closed the vector on a platform whose
 * quoting rules nobody had verified. That is the more durable of the two guarantees.
 *
 * ── WHAT A MODEL ID ACTUALLY LOOKS LIKE ──
 *
 * Measured against the catalogues this app already reads, not invented:
 *
 *     claude    sonnet, opus, haiku, claude-sonnet-4-5-20250929
 *     codex     gpt-5.6-sol, gpt-5.5, o3-mini
 *     kiro-cli  claude-sonnet-4.5, amazon-nova-pro-v1:0   (a colon, from the Bedrock model id)
 *
 * Letters, digits, dot, hyphen, underscore, colon. Nothing else has ever appeared, and a value that
 * needs anything else is not a model id.
 */

/**
 * The shape every shipped model id fits.
 *
 * ⚠ AN ALLOWLIST OF CHARACTERS, NOT A DENYLIST OF DANGEROUS ONES. A denylist has to anticipate the
 * syntax of every interpreter the value might one day pass through — which is exactly the reasoning
 * that failed in windows-launch.ts. This says what is permitted and refuses the rest, so it stays
 * correct even if the value later reaches somewhere nobody has considered.
 *
 * Anchored, so a well-formed prefix cannot carry a hostile suffix.
 */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * The model id to use, or `undefined` when the caller supplied none or supplied something that is not
 * a model id.
 *
 * ⚠ RETURNS `undefined` RATHER THAN THROWING, deliberately. Omitting `--model` is a complete, correct
 * behaviour — the CLI then uses its own default, which is what happens on every turn where the user has
 * not chosen a model. Throwing would turn a malformed value into a failed chat turn; dropping it
 * degrades to the default and logs. The renderer only ever sends ids it read from the CLI's own
 * catalogue, so a rejection here means something is wrong rather than someone is choosing.
 */
export function safeModelId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (MODEL_ID.test(value)) return value;

  /**
   * Logged, and the VALUE is not logged with it. A rejected id is attacker-controlled text, and this
   * line ends up in a file the user is invited to export (`telemetry:openLog`).
   */
  console.warn("[model-id] ignoring a model id that is not well-formed; using the CLI's default");
  return undefined;
}

/** True if `value` is a well-formed model id. Exported for tests and for callers that must branch. */
export function isSafeModelId(value: unknown): boolean {
  return typeof value === "string" && MODEL_ID.test(value);
}
