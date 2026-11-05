/**
 * ── NAMING THE MODEL THE ASSISTANT WILL ACTUALLY USE ──
 *
 * The composer said "Uses CLI default", which tells the reader that a default exists and
 * withholds the only interesting part — WHICH one. `cli:getModels` has returned `defaultModel` all along;
 * the renderer simply threw it away.
 *
 * ── ⚠ THE PREFIX MISMATCH THAT MAKES THIS NON-TRIVIAL ──
 *
 * Read from the real settings on this machine rather than assumed:
 *
 *   model:           "global.anthropic.claude-opus-5[1m]"
 *   availableModels: ["claude-opus-4-6[1m]", …, "claude-opus-5[1m]", "claude-opus-5", …]
 *
 * The default carries a `global.anthropic.` routing prefix and the list does NOT. So matching the default
 * against the list by string equality finds nothing, and a naive implementation would render the raw id —
 * swapping one unhelpful string ("Uses CLI default") for a worse one
 * ("global.anthropic.claude-opus-5[1m]"). Every function here is built around that fact.
 *
 * Pure and separate from the component because this is the part that can be WRONG, and this package's
 * vitest is node-only with no jsdom, so a pure module is the only part that can be tested at all.
 */

/**
 * Strip provider/routing prefixes so two ids for the same model compare equal.
 *
 * `global.anthropic.claude-opus-5[1m]` → `claude-opus-5[1m]`. Also handles the Bedrock-style
 * `us.anthropic.` and `eu.anthropic.` prefixes, which the same settings file can carry when the CLI is
 * pointed at a regional endpoint.
 *
 * ⚠ DELIBERATELY NOT a blanket "take the text after the last dot": model ids CONTAIN dots in the wild
 * (`claude-3.5-sonnet`), so that rule would turn a version into a model name. This removes a KNOWN prefix
 * shape — `<region>.<vendor>.` — and leaves anything else alone.
 */
export function stripModelPrefix(id: string): string {
  return id.replace(/^[a-z]{2,8}\.anthropic\./i, "");
}

/** `[1m]` marks the extended (1M) context variant. */
export function isExtendedContext(id: string): boolean {
  return id.includes("[1m]");
}

/**
 * A human name for a model id: `claude-opus-5[1m]` → `Opus 5`.
 *
 * Built from the id's own parts rather than a lookup table, and that is the important choice: Anthropic
 * ships new models faster than this app is released, and a table would render `claude-opus-6` as a raw id
 * the day it appears. A pattern degrades gracefully instead.
 *
 * The `[1m]` suffix is NOT rendered here — see `describeModel`, which puts it in a separate badge so the
 * name stays short and the capability is still visible.
 */
export function modelDisplayName(id: string): string {
  const base = stripModelPrefix(id).replace("[1m]", "");

  // `claude-opus-4-6` → family "opus", version "4.6". The version is dash-joined in the id and
  // dot-joined when spoken, which is the whole reason this is not a straight capitalisation.
  const match = base.match(/^claude-([a-z]+)-?(\d+(?:-\d+)*)?$/i);  // nosemgrep: detect-redos
  if (match) {
    const family = match[1];
    const titled = family.charAt(0).toUpperCase() + family.slice(1);
    return match[2] ? `${titled} ${match[2].replace(/-/g, ".")}` : titled;
  }

  // A bare tier alias — `opus`, `sonnet`, `haiku` — which is what a project's `model` field often holds.
  if (/^[a-z]+$/i.test(base)) return base.charAt(0).toUpperCase() + base.slice(1);

  // Anything unrecognised is shown AS IS rather than mangled. An unfamiliar id the reader can look up
  // beats a confident guess at a name that does not exist.
  return base;
}

/**
 * The one-line capability note beside the picker.
 *
 * Returns null rather than "" for an unrecognised family, so the caller omits the element instead of
 * rendering an empty one that still occupies its gap.
 */
export function modelTagline(id: string): string | null {
  const base = stripModelPrefix(id).toLowerCase();
  if (base.includes("opus")) return "Most intelligent";
  if (base.includes("sonnet")) return "Fast & capable";
  if (base.includes("haiku")) return "Fastest";
  if (base.includes("fable")) return "Creative writing";
  return null;
}

export interface ModelOption {
  id: string;
  label: string;
  tier: string;
  isExtended: boolean;
  /**
   * Codex's own one-line description of the model, when it supplied one.
   *
   * ⚠ OPTIONAL BECAUSE ONLY CODEX HAS IT. Claude's taglines are DERIVED from the model family by
   * `resolveModel`; Codex states its own ("Latest frontier agentic coding model"), and inventing one for it
   * would put words in a vendor's mouth.
   */
  tagline?: string;
}

export interface ResolvedModel {
  /** What to print as the model's name. Never an empty string. */
  name: string;
  /** The capability note, or null when the family is unknown. */
  tagline: string | null;
  /** Show the "1M" badge. */
  extended: boolean;
  /**
   * True when this is the CLI's own default rather than an explicit choice — the composer says so, since
   * "the default happens to be Opus 5" and "I picked Opus 5" are different states and a reader who cannot
   * tell them apart cannot tell whether their selection took effect.
   */
  isDefault: boolean;
}

/**
 * Work out what to show beside the picker.
 *
 * @param selectedId The user's explicit pick, or "" for "use the default".
 * @param defaultId  `defaultModel` from `cli:getModels` — may carry a routing prefix.
 * @param options    The list offered in the dropdown, whose ids do NOT carry the prefix.
 *
 * The `options` lookup is what makes the prefix handling worth having: when the default resolves to a
 * listed model, its own `label` is preferred over a name derived here, so the dropdown and the line beneath
 * it cannot describe the same model differently.
 */
export function resolveModel(
  selectedId: string,
  defaultId: string | null | undefined,
  options: ModelOption[]
): ResolvedModel {
  const isDefault = !selectedId;
  const id = selectedId || defaultId || "";

  if (!id) {
    /**
     * NEITHER a selection NOR a reported default. Reachable: `cli:getModels` can fail, and its catch
     * branch returns a fallback list — but a project could also be configured with no `model` at all.
     * "Default" alone is honest; inventing "Opus" here would state something unverified.
     */
    return { name: "Default", tagline: null, extended: false, isDefault: true };
  }

  // Compare on the STRIPPED form, since the default is prefixed and the list is not.
  const bare = stripModelPrefix(id);
  const listed = options.find((o) => stripModelPrefix(o.id) === bare);

  return {
    // A listed model's own label wins, so the two places a model is named always agree.
    name: listed ? listed.label.replace(" (Extended)", "") : modelDisplayName(id),
    tagline: modelTagline(id),
    extended: isExtendedContext(id),
    isDefault,
  };
}
