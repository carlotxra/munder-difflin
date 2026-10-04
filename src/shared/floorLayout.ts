/**
 * Hide / restore the office floor (T-031). Pure rules shared by the store,
 * the splitter and App so they can be tested without a DOM.
 */

/** localStorage key for the hidden flag; sits next to cth.sidebarWidth. */
export const LS_FLOOR_HIDDEN = 'cth.floorHidden';

/** Dragging the splitter until the floor would be narrower than this hides
 *  the floor instead of clamping it. */
export const FLOOR_SNAP_PX = 120;

/** The main row's horizontal padding (16 each side) plus the splitter (10). */
export const FLOOR_ROW_CHROME_PX = 16 * 2 + 10;

/** Only the literal '1' means hidden; anything else (missing, junk) shows it. */
export function parseFloorHidden(raw: string | null | undefined): boolean {
  return raw === '1';
}

export function serializeFloorHidden(hidden: boolean): string {
  return hidden ? '1' : '0';
}

/** Would a drag to this (unclamped) sidebar width leave the floor so thin that
 *  it should snap shut? */
export function shouldSnapCloseFloor(desiredSidebarWidth: number, viewportWidth: number): boolean {
  const floorWidth = viewportWidth - FLOOR_ROW_CHROME_PX - desiredSidebarWidth;
  return floorWidth < FLOOR_SNAP_PX;
}

/** The floor is only actually hidden while there are agents: with none, the
 *  empty-floor "add agent" prompt (and the boot screen) live on the floor. */
export function isFloorEffectivelyHidden(floorHidden: boolean, agentCount: number): boolean {
  return floorHidden && agentCount > 0;
}
