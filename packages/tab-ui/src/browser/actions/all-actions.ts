import type { AnyAction } from "./action";
import { DEVICES_ACTIONS } from "./devices-actions";
import { PROPOSALS_ACTIONS } from "./proposals-actions";
import { RELEASES_ACTIONS } from "./releases-actions";

/** Every SimpleTab action. Each becomes a command (see action-commands.ts). */
export const ALL_ACTIONS: readonly AnyAction[] = [
  ...PROPOSALS_ACTIONS,
  ...RELEASES_ACTIONS,
  ...DEVICES_ACTIONS,
];

export const ALL_ACTION_IDS: ReadonlySet<string> = new Set(ALL_ACTIONS.map((action) => action.id));
