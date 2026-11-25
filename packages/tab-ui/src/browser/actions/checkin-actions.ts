import { recordKey, type OpRound, type RecordKey } from "@simpletab/core/ops";
import type {
  ProjectedState,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import { t } from "../i18n";
import { stateHasPermission } from "../lib/permissions";
import type { TournamentStoreSnapshot } from "../store/tournament-store";
import { defineAction, type ActionContext } from "./action";

/** Widget id of the Check-in page. */
export const CHECKIN_PAGE = "simpletab-checkin-widget";

export type CheckinEntityType = "team" | "adjudicator";

function stateOf(ctx: ActionContext): ProjectedState {
  const state = ctx.store.getState();
  if (state === null) {
    throw new Error(t("common.noTournamentPrompt"));
  }
  return state;
}

function canCheckIn(snapshot: TournamentStoreSnapshot): boolean {
  return (
    snapshot.state !== null &&
    snapshot.status.open &&
    stateHasPermission(snapshot.state, "checkins.edit")
  );
}

function versionOf(state: ProjectedState, key: RecordKey): number {
  return state.versions[key] ?? 0;
}

function activeRounds(state: ProjectedState): OpRound[] {
  return state.rounds
    .filter((round) => round.cancelled !== true)
    .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
}

export interface SetVenueArgs {
  venueId: string;
  checkedIn: boolean;
}

export const setVenueAction = defineAction<SetVenueArgs, SubmitResult>({
  id: "simpletab.checkin.set-venue",
  labelKey: "action.checkin.setVenue",
  page: CHECKIN_PAGE,
  isEnabled: canCheckIn,
  async prompt(ctx) {
    const state = ctx.store.getState();
    if (state === null) {
      return undefined;
    }
    const venueId = await ctx.prompts.pick(
      state.venues.map((venue) => ({ label: venue.name, value: venue.id })),
      t("action.checkin.pickVenue"),
    );
    if (venueId === undefined) {
      return undefined;
    }
    const checkedIn = await ctx.prompts.pick(
      [
        { label: t("checkin.statusCheckedIn"), value: true },
        { label: t("checkin.statusNotCheckedIn"), value: false },
      ],
      t("action.checkin.pickVenueState"),
    );
    return checkedIn === undefined ? undefined : { venueId, checkedIn };
  },
  run(ctx, { venueId, checkedIn }) {
    const state = stateOf(ctx);
    const key = recordKey("venue", venueId);
    return ctx.store.submit({
      type: "checkin.set_venue",
      expectedVersions: { [key]: versionOf(state, key) },
      payload: { venueId, checkedIn },
    });
  },
});

export interface SetParticipantArgs {
  entityType: CheckinEntityType;
  entityId: string;
  roundId: string;
  available: boolean;
}

export const setParticipantAction = defineAction<SetParticipantArgs, SubmitResult>(
  {
    id: "simpletab.checkin.set-participant",
    labelKey: "action.checkin.setParticipant",
    page: CHECKIN_PAGE,
    isEnabled(snapshot) {
      const state = snapshot.state;
      return (
        canCheckIn(snapshot) &&
        state !== null &&
        activeRounds(state).length > 0
      );
    },
    async prompt(ctx) {
      const state = ctx.store.getState();
      if (state === null) {
        return undefined;
      }
      const entityType = await ctx.prompts.pick(
        [
          { label: t("action.checkin.participantTeam"), value: "team" as const },
          {
            label: t("action.checkin.participantAdjudicator"),
            value: "adjudicator" as const,
          },
        ],
        t("action.checkin.pickParticipantType"),
      );
      if (entityType === undefined) {
        return undefined;
      }
      const items =
        entityType === "team"
          ? state.teams.map((team) => ({ label: team.name, value: team.id }))
          : state.adjudicators.map((adj) => ({
              label: adj.name,
              value: adj.id,
            }));
      const entityId = await ctx.prompts.pick(
        items,
        t("action.checkin.pickParticipant"),
      );
      if (entityId === undefined) {
        return undefined;
      }
      const roundId = await ctx.prompts.pick(
        activeRounds(state).map((round) => ({
          label: round.name,
          value: round.id,
        })),
        t("action.checkin.pickRound"),
      );
      if (roundId === undefined) {
        return undefined;
      }
      const available = await ctx.prompts.pick(
        [
          { label: t("checkin.statusAvailable"), value: true },
          { label: t("checkin.statusUnavailable"), value: false },
        ],
        t("action.checkin.pickParticipantState"),
      );
      return available === undefined
        ? undefined
        : { entityType, entityId, roundId, available };
    },
    run(ctx, { entityType, entityId, roundId, available }) {
      const state = stateOf(ctx);
      const key = recordKey(entityType, entityId);
      return ctx.store.submit({
        type: "checkin.set_participant",
        expectedVersions: { [key]: versionOf(state, key) },
        payload: { entityType, entityId, roundId, available },
      });
    },
  },
);

export const CHECKIN_ACTIONS = [setVenueAction, setParticipantAction] as const;
