/**
 * THE ASSESSMENT PROMPT DISCLOSURE — the browser-only contract.
 *
 * ── WHAT THIS COVERS THAT `ratings-prompt-disclosure.test.ts` CANNOT ──
 *
 * That unit file runs under `environment: "node"` with no DOM, so it asserts STRUCTURE: that no
 * copy of either prompt exists in this repo, that the panel renders from props, that the query is
 * gated and non-billable. All true, all worth pinning, and none of it observes:
 *
 *   1. that the text on screen is BYTE-FOR-BYTE what the transport served, newlines and JSON
 *      schema intact — the one property the whole feature rests on, and a string check against a
 *      local constant cannot prove it because there is no local constant to check against;
 *   2. where `document.activeElement` lands when the dialog opens, and that Escape returns it to
 *      the trigger — this panel deliberately moves focus INSIDE on open, unlike
 *      `InsightsMethodology`, because it scrolls;
 *   3. that opening it repeatedly puts exactly ONE prompts request on the wire.
 *
 * (3) is the billing-adjacent one. `staleTime: Infinity` is the reason, and a mocked client would
 * only prove a mocked client was called once — so it is counted with `page.on("request")`, the
 * same technique and for the same reason as `remove-member.spec.ts` priority #4.
 *
 * ── NO SLEEPS ──
 * Every wait is a Playwright web-first assertion. Nothing here races a fast response: the panel's
 * content is stable once its query has resolved, and the assertions run against that stable state.
 */

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { readNextAuthSecret, missingSecretMessage } from "./fixtures/env";
import { signInAs } from "./fixtures/session";
import { serveTrpc, countTrpcCalls, type TrpcCallLog } from "./fixtures/trpc";
import {
  EXECUTIVE_SELF,
  TEAM_ID,
  WORKSHOP_ID,
  meFixture,
  selfMember,
  teamFixture,
} from "./fixtures/data";
import { activeElement, expectFocusInsideDialog, expectFocusOn } from "./fixtures/focus";

const { secret, whereLooked } = readNextAuthSecret();

const INSIGHTS_URL = `/w/${WORKSHOP_ID}/t/${TEAM_ID}/insights`;

/**
 * ⚠ SERVED PROMPTS CARRY MARKERS THE PORTAL COULD NOT HAVE INVENTED.
 *
 * The point of the feature is that the portal shows what the SERVICE sent. A fixture repeating the
 * real prompt would pass equally well against a portal that hardcoded it — the bug this guards
 * against — so these are deliberately NOT the production text: a nonce, a blank line and a JSON
 * schema line whose exact spacing must survive to the DOM.
 */
const KNOWLEDGE_SYSTEM = [
  "SERVED-BY-FIXTURE-a7f3 knowledge prompt.",
  "",
  "RULES:",
  "- NEVER compare people to each other.",
  '{"handle":"<given>","aiKnowledgeScore":<0-100>}',
].join("\n");

const SUMMARY_SYSTEM = [
  "SERVED-BY-FIXTURE-b9e1 summary prompt.",
  "",
  '{"teamSummary":"<2-4 sentences>"}',
].join("\n");

const PROMPTS_FIXTURE = [
  {
    key: "knowledge" as const,
    title: "Per-member coaching",
    system: KNOWLEDGE_SYSTEM,
    inputs: ["One member at a time.", "An opaque handle (M1, M2, …)."],
    audience: "Read by executives on this team.",
  },
  {
    key: "summary" as const,
    title: "Team summary",
    system: SUMMARY_SYSTEM,
    inputs: ["Team-wide TOTALS only.", "⚠ No message text and no per-member rows."],
    audience: "Once published, readable by facilitators, off-team executives and judges.",
  },
];

/** A stored assessment, which is what opens the dashboard rather than the pre-run screen. */
const ANALYSIS_FIXTURE = {
  members: [
    {
      userId: EXECUTIVE_SELF.id,
      aiKnowledgeScore: 62,
      rationale: "Prompts often omit constraints.",
      strengths: ["Decomposes before asking"],
      improvements: ["State the constraint up front"],
    },
  ],
  teamSummary: "The team completed most of what it opened.",
  generatedAt: "2026-08-29T09:00:00.000Z",
  generationId: "01KZE2EGENERATION",
  publishedAt: null,
  coverage: ["Counts activity, not quality."],
};

/**
 * Put a signed-in EXECUTIVE MEMBER on the insights dashboard.
 *
 * Both halves matter and neither is incidental: the disclosure renders inside the page's
 * `canAnalyze` gate, which is EXECUTIVE-only, and every ratings query is additionally gated on
 * this user appearing in the roster. A fixture that got either wrong would render the page with no
 * card at all and the spec would fail on a selector rather than on the behaviour.
 */
async function openInsights(
  page: Page,
  context: BrowserContext
): Promise<{ calls: TrpcCallLog }> {
  await signInAs(context, EXECUTIVE_SELF, secret!);
  const calls = countTrpcCalls(page);

  await serveTrpc(page, {
    "auth.me": () => meFixture(EXECUTIVE_SELF),
    // The executive is ON the roster — see the note above.
    "team.getById": () => teamFixture([selfMember(EXECUTIVE_SELF)]),
    "team.listInvitations": () => [],
    "rating.analysis": () => ANALYSIS_FIXTURE,
    "rating.prompts": () => ({ prompts: PROMPTS_FIXTURE }),
    "rating.summary": () => ({
      summary: null,
      generatedAt: null,
      publishedAt: null,
      coverage: [],
      memberCount: null,
      notPublished: true,
    }),
    /**
     * The dashboard's analytics queries. Empty is fine — this spec asserts nothing about them.
     *
     * ⚠ THE SHAPES ARE COPIED FROM THE ROUTERS, NOT GUESSED. `ai.getThreads` and `task.list`
     * return BARE ARRAYS; `ai.tokenUsage` and `message.list` return objects. Wrapping the first
     * two crashed the page with "Cannot read properties of undefined (reading 'length')" and every
     * test in this file failed in SETUP — which is the config's documented tell for a harness
     * fault rather than a defect in the code under test.
     */
    "ai.getThreads": () => [],
    "ai.tokenUsage": () => ({ threads: [], truncated: false, totalThreads: 0 }),
    "task.list": () => [],
    "message.list": () => ({ messages: [], nextCursor: undefined }),
  });

  await page.goto(INSIGHTS_URL);
  // The coaching card's heading proves the page rendered AND the stored analysis resolved — one
  // condition covering both, rather than a load event that says nothing about content.
  await expect(
    page.getByRole("heading", { name: "Working with an AI assistant" })
  ).toBeVisible();
  return { calls };
}

/** The disclosure's trigger, by the accessible name the component sets. */
const infoIcon = (page: Page) =>
  page.getByRole("button", { name: "What this sends to the model" });

test.describe("The assessment prompt disclosure", () => {
  test.beforeEach(() => {
    // Skipped, never silently passed, and the message names the variable. See fixtures/env.ts.
    test.skip(!secret, missingSecretMessage(whereLooked));
  });

  test("shows the SERVED prompt text verbatim, newlines and JSON schema intact", async ({
    page,
    context,
  }) => {
    /**
     * ── THE ASSERTION THE WHOLE FEATURE RESTS ON ──
     *
     * An executive is being told how a named person was judged. If the panel showed anything other
     * than what the model received, it would be a confident falsehood about a judgement of a
     * colleague — worse than showing nothing. The fixture text is deliberately not the production
     * prompt, so a portal that hardcoded the real one would FAIL here.
     */
    await openInsights(page, context);
    await infoIcon(page).click();

    const dialog = page.getByRole("dialog", { name: "What this sends to the model" });
    await expect(dialog).toBeVisible();

    // `textContent`, not `innerText`: innerText normalises whitespace, which would hide exactly
    // the collapsed-newline defect `whitespace-pre-wrap` exists to prevent.
    const blocks = await dialog.locator("pre").allTextContents();
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toBe(KNOWLEDGE_SYSTEM);
    expect(blocks[1]).toBe(SUMMARY_SYSTEM);

    // The blank line and the JSON schema survived to the DOM, not merely the visible words.
    expect(blocks[0]).toContain("\n\n");
    expect(blocks[0]).toContain('{"handle":"<given>","aiKnowledgeScore":<0-100>}');
  });

  test("states what each call RECEIVES above the prompt, not only what it is told", async ({
    page,
    context,
  }) => {
    /**
     * The summary prompt says "NEVER refer to an individual"; a reader who meets that rule first
     * concludes the guarantee is the instruction. It is not — that call receives team totals, so it
     * cannot name someone it never saw. This asserts the ORDER, which is the part that carries the
     * meaning and the part no unit test can see.
     */
    await openInsights(page, context);
    await infoIcon(page).click();

    const summarySection = page
      .getByRole("dialog")
      .locator("section")
      .filter({ hasText: "Team summary" });

    const body = (await summarySection.textContent()) ?? "";
    const inputsAt = body.indexOf("What it receives");
    const promptAt = body.indexOf("Instructions sent");
    expect(inputsAt).toBeGreaterThan(-1);
    expect(promptAt).toBeGreaterThan(inputsAt);

    // The load-bearing caveat reached the screen rather than being trimmed as decoration.
    await expect(summarySection).toContainText("No message text and no per-member rows");
  });

  test("moves focus INTO the dialog on open, and Escape returns it to the icon", async ({
    page,
    context,
  }) => {
    /**
     * ⚠ THIS IS WHERE THE PANEL DIVERGES FROM `InsightsMethodology`, DELIBERATELY.
     *
     * That popover leaves focus on the trigger, which is defensible for four short lines. This one
     * SCROLLS, so a keyboard or screen-reader user left outside it cannot reach the thing it exists
     * to show. Focus therefore lands inside on open — and must come back to the icon on Escape, or
     * dismissing the dialog would drop the user at <body>.
     */
    await openInsights(page, context);
    const icon = infoIcon(page);
    await icon.focus();
    await page.keyboard.press("Enter");

    await expect(page.getByRole("dialog")).toBeVisible();
    await expectFocusInsideDialog(page, "the dialog scrolls, so focus must not stay outside it");

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    // Matched on the trigger's aria-label, which is how every control in this suite is addressed.
    await expectFocusOn(
      page,
      "What this sends to the model",
      "Escape must return focus to the trigger, not drop it on <body>"
    );
  });

  test("a click outside dismisses it", async ({ page, context }) => {
    await openInsights(page, context);
    await infoIcon(page).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // The backdrop, outside the panel — the same gesture a reader uses to dismiss it.
    await page.mouse.click(5, 5);
    await expect(page.getByRole("dialog")).toBeHidden();
  });

  test("costs exactly ONE prompts request however often it is opened", async ({
    page,
    context,
  }) => {
    /**
     * `staleTime: Infinity`, because a prompt changes only when the service is redeployed. Asserted
     * ON THE WIRE with `page.on("request")` rather than against the client, so it observes HTTP the
     * browser genuinely emitted — the same reasoning as remove-member's double-submit count.
     *
     * The route cannot bill, so this is not a spend guard; it is a noise guard. Refetching a
     * constant would put avoidable load on a route reachable by every executive at the end of
     * every workshop.
     *
     * ── ⚠ THE VISIBILITY CYCLE IS WHAT GIVES THIS TEST TEETH, AND IT WAS ADDED AFTER A MUTATION
     *      CHECK CAUGHT ITS ABSENCE ──
     *
     * Opening and closing the panel alone does NOT exercise `staleTime`: the query lives at page
     * level and stays mounted, so no refetch is due either way — measured, by deleting
     * `staleTime: Infinity` and watching this test still pass. That is a test asserting a true fact
     * for a reason unrelated to the one it claims.
     *
     * `refetchOnWindowFocus` is unset in providers.tsx, so it is React Query's default TRUE, and
     * query-core v5's focusManager listens for `visibilitychange` ON `window`. Dispatching it is
     * therefore the real path a returning executive takes when they switch back to the tab — and
     * with a stale query it is a second request. Re-checked: with `staleTime` removed this now
     * fails with 2.
     */
    const { calls } = await openInsights(page, context);
    const icon = infoIcon(page);

    for (let i = 0; i < 3; i++) {
      await icon.click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toBeHidden();
    }

    // The tab loses and regains focus, twice — what actually happens to a page left open.
    for (let i = 0; i < 2; i++) {
      await page.evaluate(() =>
        window.dispatchEvent(new Event("visibilitychange", { bubbles: true }))
      );
    }
    // Re-open afterwards, so a refetch triggered by the cycle has been given a render to land in.
    await icon.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog").locator("pre").first()).toContainText(
      "SERVED-BY-FIXTURE-a7f3"
    );

    expect(calls.countOf("rating.prompts")).toBe(1);
  });

  test("reports a failed fetch instead of rendering an empty panel", async ({
    page,
    context,
  }) => {
    /**
     * An empty disclosure reads as "nothing is sent to the model", which is the opposite of the
     * truth. The panel must say it could not load — the same distinction the coaching card draws
     * between a failed READ and a failed generation.
     */
    await signInAs(context, EXECUTIVE_SELF, secret!);
    await serveTrpc(page, {
      "auth.me": () => meFixture(EXECUTIVE_SELF),
      "team.getById": () => teamFixture([selfMember(EXECUTIVE_SELF)]),
      "team.listInvitations": () => [],
      "rating.analysis": () => ANALYSIS_FIXTURE,
      "rating.prompts": () => {
        throw new Error("the AI service is unreachable");
      },
      "rating.summary": () => ({
        summary: null,
        generatedAt: null,
        publishedAt: null,
        coverage: [],
        memberCount: null,
        notPublished: true,
      }),
      "ai.getThreads": () => [],
      "ai.tokenUsage": () => ({ threads: [], truncated: false, totalThreads: 0 }),
      "task.list": () => [],
      "message.list": () => ({ messages: [], nextCursor: undefined }),
    });
    await page.goto(INSIGHTS_URL);
    await expect(
      page.getByRole("heading", { name: "Working with an AI assistant" })
    ).toBeVisible();

    await infoIcon(page).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // The failure is announced, and no prompt block is rendered beside it.
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(dialog.locator("pre")).toHaveCount(0);

    // Focus still landed inside: an error panel a keyboard user cannot reach is no better.
    const where = await activeElement(page);
    expect(where.insideDialog).toBe(true);
  });
});
