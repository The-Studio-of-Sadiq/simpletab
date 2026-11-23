import type { OpDef } from "../types";
import {
  adjudicatorCreateOp,
  adjudicatorDeleteOp,
  adjudicatorUpdateOp,
  adjudicatorUpdateScoresOp,
} from "./adjudicators";
import {
  checkinSelfCheckinOp,
  checkinSetParticipantOp,
  checkinSetVenueOp,
} from "./checkins";
import {
  conflictSetTeamInstitutionsOp,
  conflictUpdateAdjudicatorOp,
} from "./conflicts";
import { eraseOpType } from "./helpers";
import {
  institutionCreateOp,
  institutionDeleteOp,
  institutionUpdateOp,
} from "./institutions";
import {
  roundCancelOp,
  roundCreateOp,
  roundDeleteOp,
  roundSetBallotDeadlineOp,
  roundSetCompletionOp,
  roundSetPrelimCountOp,
  roundUpdateOp,
} from "./rounds";
import {
  rolesUpdateOp,
  settingsResaveBallotsOp,
  settingsUpdateOp,
} from "./settings";
import { teamCreateOp, teamDeleteOp, teamUpdateOp } from "./teams";
import { venueCreateOp, venueDeleteOp, venueUpdateOp } from "./venues";

export * from "./adjudicators";
export * from "./checkins";
export * from "./conflicts";
export * from "./helpers";
export * from "./institutions";
export * from "./rounds";
export * from "./settings";
export * from "./teams";
export * from "./venues";

export const SETUP_OPS: readonly OpDef<unknown>[] = [
  eraseOpType(settingsUpdateOp),
  eraseOpType(settingsResaveBallotsOp),
  eraseOpType(rolesUpdateOp),
  eraseOpType(institutionCreateOp),
  eraseOpType(institutionUpdateOp),
  eraseOpType(institutionDeleteOp),
  eraseOpType(teamCreateOp),
  eraseOpType(teamUpdateOp),
  eraseOpType(teamDeleteOp),
  eraseOpType(adjudicatorCreateOp),
  eraseOpType(adjudicatorUpdateOp),
  eraseOpType(adjudicatorDeleteOp),
  eraseOpType(adjudicatorUpdateScoresOp),
  eraseOpType(conflictUpdateAdjudicatorOp),
  eraseOpType(conflictSetTeamInstitutionsOp),
  eraseOpType(venueCreateOp),
  eraseOpType(venueUpdateOp),
  eraseOpType(venueDeleteOp),
  eraseOpType(checkinSetParticipantOp),
  eraseOpType(checkinSetVenueOp),
  eraseOpType(checkinSelfCheckinOp),
  eraseOpType(roundCreateOp),
  eraseOpType(roundUpdateOp),
  eraseOpType(roundDeleteOp),
  eraseOpType(roundSetPrelimCountOp),
  eraseOpType(roundSetCompletionOp),
  eraseOpType(roundCancelOp),
  eraseOpType(roundSetBallotDeadlineOp),
];
