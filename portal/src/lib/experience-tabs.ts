/**
 * ── WHICH NAVIGATING TAB AN EXPERIENCE VIEWER IS OFFERED ─────────────────────────────────
 *
 * The experience detail page has three tabs that navigate to their own routes rather than rendering
 * a panel: Settings, Submissions and Results. They have three different audiences.
 *
 * ── ⚠ THIS REPLACED A SINGLE FLAG, AND THE SINGLE FLAG WOULD NOW BE A BUG ──
 *
 * The page used to read `if (navigates && !canOpenSettings) return null`, correct while Settings was
 * the ONLY navigating tab, and wrong the moment a second one existed with a different audience: it
 * would have hidden the judging worklist from every judge, which is the one thing a judge is on the
 * platform to do.
 *
 * ── THE BAR THIS HOLDS ITSELF TO ──
 *
 * The team workspace's nav states it plainly: every visible tab must lead to a page that
 * demonstrably LOADS. So a tab is not simply shown to everyone, a Submissions tab offered to a
 * participant leads to a refusal, which is the visible half of exactly the defect that nav was fixed
 * for. It is also not the security boundary: every page re-checks with the evaluation service, which
 * decides on entitlement and ownership against the store.
 *
 * Extracted here so it can be tested without rendering the page, the same reason `route-gates.ts`
 * exists.
 */

export type NavigatingTab = "settings" | "submissions" | "results" | "activity" | "resources";

export interface ExperienceViewer {
  role: string | undefined;
  /** ADMIN, or the owner of THIS experience, the page derives this from the loaded workshop. */
  canManage: boolean;
  /** Whether the role may configure an experience at all (`canManageWorkshopSettings`). */
  canManageSettings: boolean;
}

export function canOpenExperienceTab(tab: NavigatingTab, viewer: ExperienceViewer): boolean {
  switch (tab) {
    /** Configuring the experience: the role must permit it AND they must own it (or be ADMIN). */
    case "settings":
      return viewer.canManageSettings && viewer.canManage;

    /**
     * The judging worklist.
     *
     * A JUDGE is offered it because judging is their entire reason for being here; WHICH experiences
     * they may judge is per-workshop entitlement, which only the service can answer, and the page
     * distinguishes "not entitled" from "nothing released yet".
     *
     * ADMIN and the owner are offered it because they supervise the panel, coverage is what gates
     * publishing, so they need to see who has scored.
     *
     * ⚠ A PARTICIPANT IS NOT. A team member has no claim on other teams' released work, and an
     * EXECUTIVE's route to their own team's submission is the team workspace's Submit tab.
     */
    case "submissions":
      return viewer.role === "JUDGE" || viewer.canManage;

    /**
     * The outcome.
     *
     * ⚠ OFFERED TO EVERYONE, and that is safe because BOTH outcomes load: an entitled reader sees
     * the published places, and everyone else, including someone entitled who arrives early, sees
     * "not published yet". Neither is a refusal.
     */
    case "results":
      return true;

    /**
     * The operational view of RUNNING the experience, how each team is doing, who has gone quiet.
     *
     * ⚠ ADMIN OR THE OWNER ONLY, and deliberately NOT a judge or a participant. It is not that the
     * numbers are secret; it is that they are somebody's JOB. A participant seeing "your team has been
     * quiet for 6 hours" is being managed by a dashboard, and a judge has no operational role at all.
     *
     * ⚠ The SERVICE gates on the stored `ownerId` regardless, a facilitator who does not own this
     * experience is refused there even though `canManage` is what hides the tab here.
     */
    case "activity":
      return viewer.canManage;

    /**
     * The facilitator's material for this experience, briefs, decks, datasets.
     *
     * ⚠ OFFERED TO EVERYONE, like `results`, and for the rule's own reason: only the facilitator can
     * add or delete, and every other role can read them. READING is the common case, a
     * participant opens this tab to GET the brief, so hiding it from them would hide the feature from
     * the people it exists to serve.
     *
     * It meets this module's bar that a visible tab must LOAD: the page's own list is gated on
     * `requireWorkshopRead`, which is the same rule that let the viewer open this experience at all.
     * Anyone seeing this header has already passed it, so the page cannot refuse them. The upload and
     * delete controls are hidden from non-owners by the page, and the service refuses them regardless.
     *
     * ⚠ THIS CASE MISSING IS WHAT HID THE TAB IN 0.6.22. The key was added to the header's TABS array
     * but not to this union, and the call site casts (`tab.key as NavigatingTab`), so the compiler did
     * not object, the switch matched nothing, returned `undefined`, and the tab rendered `null` on a
     * deployed build that had every other sign of being correct. `experience-tabs.test.ts` now asserts
     * every navigating tab resolves to a real boolean, so the next omission fails a test instead.
     */
    case "resources":
      return true;
  }
}
