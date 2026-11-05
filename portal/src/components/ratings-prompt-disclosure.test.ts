import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE PROMPT DISCLOSURE beside the Analyze button, and the one property that makes it worth having.
 *
 * The panel tells an executive what the model was asked before it judged a named person's craft. Its
 * value is entirely conditional on being TRUE, so the assertions here are about where the text comes
 * from and who can see it, not about the prose, which is served by the AI service and would be
 * tested against itself if it were duplicated here.
 *
 * Source assertions, the idiom `insights-defaults.test.ts` already uses on this page: `vitest.config.mts`
 * runs `environment: "node"` with no DOM, so focus behaviour and the dialog's render belong to
 * Playwright. These are structural facts a string check can hold honestly.
 */

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const PANEL = read("./RatingsPromptDisclosure.tsx");
const INSIGHTS = read("../app/w/[workshopId]/t/[teamId]/insights/page.tsx");
const ROUTER = read("../lib/trpc/routers/rating.ts");

/** Strip comments: they discuss what the code must NOT do, so they defeat absence checks. */
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the prompt text is SERVED, never declared in the portal", () => {
  /**
   * ⚠ THIS IS THE WHOLE POINT OF THE FEATURE.
   *
   * `InsightsMethodology` hardcodes its four weights and carries a warning to keep them in step
   * with the computation beside it. A system prompt is different in kind: it lives in another
   * repository, and a copy here that fell behind would state something false about how a judgement
   * of a person was produced, in the one panel whose only job is being accurate.
   */
  it("holds no copy of either system prompt", () => {
    const body = code(PANEL);
    // Distinctive clauses from each prompt. If either appears, someone inlined the text.
    expect(body).not.toMatch(/You assess how effectively ONE person/);
    expect(body).not.toMatch(/You write a short, factual summary/);
    expect(body).not.toMatch(/aiKnowledgeScore/);
  });

  it("renders whatever the service sent, from props", () => {
    // The prompt arrives as data and is rendered verbatim; the component chooses no wording.
    expect(PANEL).toMatch(/prompts\.map/);
    expect(PANEL).toMatch(/\{p\.system\}/);
  });

  it("preserves the prompt's own line breaks", () => {
    /**
     * The prompts are newline-structured and end in a mandatory JSON schema. Collapsed whitespace
     * would display a prompt that is not the one sent, a subtler version of the same lie.
     */
    expect(PANEL).toMatch(/whitespace-pre-wrap/);
  });

  it("reports a failed fetch instead of rendering an empty panel", () => {
    /**
     * An empty disclosure reads as "nothing is sent to the model", which is the opposite of the
     * truth. Same reasoning as the coaching card's separate `loadError`.
     */
    expect(PANEL).toMatch(/role="alert"/);
    expect(code(PANEL)).toMatch(/error\s*&&/);
  });
});

describe("the disclosure is EXECUTIVE-only and cannot bill", () => {
  it("renders inside the same gate as the Analyze button", () => {
    /**
     * It describes what that button sends, so it belongs to exactly the role that can press it. The
     * service refuses everyone else anyway; this stops the UI offering a control whose request it
     * knows is a 403.
     */
    const body = code(INSIGHTS);
    const gate = body.indexOf("{canAnalyze && (");
    expect(gate).toBeGreaterThan(-1);
    const disclosure = body.indexOf("<RatingsPromptDisclosure");
    expect(disclosure).toBeGreaterThan(gate);
    // Inside the gate's block, ahead of the button it annotates.
    expect(disclosure).toBeLessThan(body.indexOf("onClick={onAnalyze}"));
  });

  it("gates the query on being an executive member, like the analysis read", () => {
    // A request the service would 403 must not be fired. Mirrors `analysisQuery`'s condition.
    expect(code(INSIGHTS)).toMatch(
      /trpc\.rating\.prompts\.useQuery\(\s*\{\s*teamId\s*\}\s*,\s*\{\s*enabled:\s*isExecutive && membership === "member"/
    );
  });

  it("is a protectedProcedure, NOT billableProcedure", () => {
    /**
     * ⚠ THE ADJACENT ROUTE IS THE BILLABLE ONE. `analyze` spends one Bedrock call per member and is
     * rate-limited for it; this serves two constants and cannot bill, which is what makes it safe to
     * run on render. Marking it billable would spend the executive's tight per-user window on a
     * read that costs nothing, and the window exists to bound Bedrock spend.
     */
    const prompts = ROUTER.slice(ROUTER.indexOf("  prompts: "));
    const decl = prompts.slice(0, prompts.indexOf(".query("));
    expect(decl).toMatch(/protectedProcedure/);
    expect(decl).not.toMatch(/billableProcedure/);
  });
});
