import type { AnyAction } from "./action";
import { ALLOCATION_ACTIONS } from "./allocation-actions";
import { BREAK_ACTIONS } from "./break-actions";
import { CHANGELOG_ACTIONS } from "./changelog-actions";
import { CHECKIN_ACTIONS } from "./checkin-actions";
import { CREDENTIALS_ACTIONS } from "./credentials-actions";
import { CSV_IMPORT_ACTIONS } from "./csv-import-actions";
import { DEVICE_MODE_ACTIONS } from "./device-mode-actions";
import { DEVICES_ACTIONS } from "./devices-actions";
import { DRAW_ACTIONS } from "./draw-actions";
import { FEEDBACK_ACTIONS } from "./feedback-actions";
import { LINKS_ACTIONS } from "./links-actions";
import { MOTIONS_ACTIONS } from "./motions-actions";
import { NAVIGATION_ACTIONS } from "./navigation-actions";
import { PARTICIPANT_ACTIONS } from "./participants-actions";
import { PROJECTOR_ACTIONS } from "./projector-actions";
import { PROPOSALS_ACTIONS } from "./proposals-actions";
import { RELEASES_ACTIONS } from "./releases-actions";
import { SETUP_ACTIONS } from "./setup-actions";
import { STATUS_ACTIONS } from "./status-actions";
import { RESULTS_ACTIONS } from "./results-actions";

/** Every SimpleTab action. Each becomes a command (see action-commands.ts). */
export const ALL_ACTIONS: readonly AnyAction[] = [
  ...NAVIGATION_ACTIONS,
  ...PROPOSALS_ACTIONS,
  ...RELEASES_ACTIONS,
  ...DEVICES_ACTIONS,
  ...DRAW_ACTIONS,
  ...ALLOCATION_ACTIONS,
  ...CHECKIN_ACTIONS,
  ...CREDENTIALS_ACTIONS,
  ...DEVICE_MODE_ACTIONS,
  ...MOTIONS_ACTIONS,
  ...PROJECTOR_ACTIONS,
  ...RESULTS_ACTIONS,
  ...STATUS_ACTIONS,
  ...FEEDBACK_ACTIONS,
  ...BREAK_ACTIONS,
  ...CHANGELOG_ACTIONS,
  ...PARTICIPANT_ACTIONS,
  ...CSV_IMPORT_ACTIONS,
  ...LINKS_ACTIONS,
  ...SETUP_ACTIONS,
];

/** Every registered command id, for the inventory tests. */
export const ALL_ACTION_IDS: ReadonlySet<string> = new Set(ALL_ACTIONS.map((action) => action.id));
