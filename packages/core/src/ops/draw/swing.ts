import {
  buildSwingTeam,
  validateSwingTeam,
  withoutSwingRound,
  withSwingRound,
  type SwingSpeakerInput,
} from "@/features/tournament/application/swingTeams";
import type { Team } from "@/types";
import { cloneValue, dedupeKeys, isNonEmptyText } from "../setup/helpers";
import { recordKey, type OpDef, type TournamentState } from "../types";

export interface SwingCreatePayload {
  roundId: string;
  name: string;
  speakers: SwingSpeakerInput[];
  teamId?: string;
  createdTeamId?: string;
}

export interface SwingToggleRoundPayload {
  teamId: string;
  roundId: string;
  enabled?: boolean;
  previousEnabled?: boolean;
  previousSwingRoundIds?: string[] | null;
  previousRoundAvailability?: Record<string, boolean> | null;
  restoreSwingRoundIds?: string[] | null;
  restoreRoundAvailability?: Record<string, boolean> | null;
}

function nextUniqueSwingTeamId(
  roundId: string,
  teams: readonly Team[],
): string {
  const taken = new Set(teams.map((team) => team.id));
  let index = 1;
  while (taken.has(`swing-${roundId}-${index}`)) {
    index += 1;
  }
  return `swing-${roundId}-${index}`;
}

function resolveSwingTeamId(
  state: TournamentState,
  payload: SwingCreatePayload,
): string {
  if (payload.createdTeamId) {
    return payload.createdTeamId;
  }
  if (payload.teamId) {
    return payload.teamId;
  }
  return nextUniqueSwingTeamId(payload.roundId, state.teams);
}

export const swingCreateOp: OpDef<SwingCreatePayload> = {
  type: "swing.create",
  permission: "participants.edit",
  category: "draw",
  visibility: "public",
  releaseGate: "draw_released",
  lock: false,
  reads(state, payload) {
    return dedupeKeys([
      recordKey("round", payload.roundId),
      ...state.teams.map((team) => recordKey("team", team.id)),
    ]);
  },
  writes(state, payload) {
    return [recordKey("team", resolveSwingTeamId(state, payload))];
  },
  validate(state, payload) {
    const errors: string[] = [];
    const round = state.rounds.find((item) => item.id === payload.roundId);
    if (!round) {
      return [`Round ${payload.roundId} does not exist.`];
    }
    if (payload.teamId !== undefined) {
      if (!isNonEmptyText(payload.teamId)) {
        errors.push("Swing team id must not be empty.");
      } else if (state.teams.some((team) => team.id === payload.teamId)) {
        errors.push(`Team ${payload.teamId} already exists.`);
      }
    }
    if (!Array.isArray(payload.speakers)) {
      errors.push("Swing team speakers must be a list.");
      return errors;
    }

    errors.push(
      ...validateSwingTeam({
        name: payload.name,
        speakers: payload.speakers,
        round,
        teams: state.teams,
        tournament: state.tournament,
      }),
    );
    return errors;
  },
  apply(state, payload) {
    const round = state.rounds.find((item) => item.id === payload.roundId)!;
    const teamId = resolveSwingTeamId(state, payload);
    const body = buildSwingTeam(
      {
        name: payload.name,
        speakers: payload.speakers,
        round,
        teams: state.teams,
        tournament: state.tournament,
      },
      (index) => `${teamId}-s${index + 1}`,
    );
    const created: Team = {
      id: teamId,
      tournamentId: state.tournament.id,
      ...body,
    };

    return {
      state: {
        ...state,
        teams: [...state.teams, created],
      },
      committedPayload: {
        ...cloneValue(payload),
        createdTeamId: teamId,
      },
    };
  },
  inverse(committedPayload) {
    if (!committedPayload.createdTeamId) {
      return null;
    }
    return {
      type: "team.delete",
      payload: {
        teamId: committedPayload.createdTeamId,
      },
    };
  },
};

export const swingToggleRoundOp: OpDef<SwingToggleRoundPayload> = {
  type: "swing.toggle_round",
  permission: "participants.edit",
  category: "draw",
  visibility: "public",
  releaseGate: "draw_released",
  lock: false,
  reads(_state, payload) {
    return [
      recordKey("team", payload.teamId),
      recordKey("round", payload.roundId),
    ];
  },
  writes(_state, payload) {
    return [recordKey("team", payload.teamId)];
  },
  validate(state, payload) {
    const team = state.teams.find((item) => item.id === payload.teamId);
    if (!team) {
      return [`Team ${payload.teamId} does not exist.`];
    }
    if (!team.isSwing) {
      return [`${team.name} is not a swing team.`];
    }
    const round = state.rounds.find((item) => item.id === payload.roundId);
    if (!round) {
      return [`Round ${payload.roundId} does not exist.`];
    }
    const currentlyEnabled = Boolean(team.swingRoundIds?.includes(round.id));
    const nextEnabled = payload.enabled ?? !currentlyEnabled;
    if (nextEnabled && round.stage !== "preliminary") {
      return ["Swing teams can only debate in preliminary rounds."];
    }
    return [];
  },
  apply(state, payload) {
    const existing = state.teams.find((item) => item.id === payload.teamId)!;
    const round = state.rounds.find((item) => item.id === payload.roundId)!;
    const previousEnabled = Boolean(existing.swingRoundIds?.includes(round.id));
    const previousSwingRoundIds =
      existing.swingRoundIds === undefined ? null : [...existing.swingRoundIds];
    const previousRoundAvailability =
      existing.roundAvailability === undefined
        ? null
        : { ...existing.roundAvailability };

    let updated: Team;
    if (
      payload.restoreSwingRoundIds !== undefined ||
      payload.restoreRoundAvailability !== undefined
    ) {
      updated = cloneValue(existing);
      if (payload.restoreSwingRoundIds === null) {
        delete updated.swingRoundIds;
      } else if (payload.restoreSwingRoundIds !== undefined) {
        updated.swingRoundIds = [...payload.restoreSwingRoundIds];
      }
      if (payload.restoreRoundAvailability === null) {
        delete updated.roundAvailability;
      } else if (payload.restoreRoundAvailability !== undefined) {
        updated.roundAvailability = { ...payload.restoreRoundAvailability };
      }
    } else {
      const nextEnabled = payload.enabled ?? !previousEnabled;
      const cloned = cloneValue(existing);
      updated = nextEnabled
        ? withSwingRound(cloned, round)
        : withoutSwingRound(cloned, round);
    }

    return {
      state: {
        ...state,
        teams: state.teams.map((item) =>
          item.id === updated.id ? updated : item,
        ),
      },
      committedPayload: {
        ...cloneValue(payload),
        previousEnabled,
        previousSwingRoundIds,
        previousRoundAvailability,
      },
    };
  },
  inverse(committedPayload) {
    if (committedPayload.previousEnabled === undefined) {
      return null;
    }
    return {
      type: "swing.toggle_round",
      payload: {
        teamId: committedPayload.teamId,
        roundId: committedPayload.roundId,
        enabled: committedPayload.previousEnabled,
        ...(committedPayload.previousSwingRoundIds !== undefined
          ? { restoreSwingRoundIds: committedPayload.previousSwingRoundIds }
          : {}),
        ...(committedPayload.previousRoundAvailability !== undefined
          ? { restoreRoundAvailability: committedPayload.previousRoundAvailability }
          : {}),
      },
    };
  },
};
