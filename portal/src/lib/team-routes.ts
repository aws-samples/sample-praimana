/**
 * WHERE "THE TEAM TAB" IS, in one place.
 *
 * Eight call sites now need this path: the tab itself, the focus fallback in the workspace
 * layout, and the member-only notice on each of the six content pages. Every one of them
 * templates `/w/<workshopId>/t/<teamId>/team` from route params, and a typo in any of them
 * produces a 404 on the one link whose entire job is to be the way out of a dead end, the
 * failure an operator hits at the exact moment they have nowhere else to go.
 *
 * Deliberately NOT a full route table. The other seven sections are only ever linked from
 * the layout's own `navItems` array, which is already one place; adding them here would be
 * indirection for its own sake.
 */
export function teamTabHref(workshopId: string, teamId: string): string {
  return `/w/${workshopId}/t/${teamId}/team`;
}
