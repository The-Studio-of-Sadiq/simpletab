import {
  checkSpeakerRemoval,
  checkTeamDeletion,
} from "@/features/tournament/application/stateGuards";
import { withoutRealNameCodeName } from "@/lib/codeNames";
import type { Team } from "@/types";
import { recordKey, type OpDef } from "../types";
import {
  cloneValue,
  insertAt,
  isNonEmptyText,
  violationsToErrors,
} from "./helpers";

export interface TeamCreatePayload {
  team: Team;
  index?: number;
}

export interface TeamUpdatePayload {
  team: Team;
  previous?: Team;
}

export interface TeamDeletePayload {
  teamId: string;
  previous?: Team;
  previousIndex?: number;
}

function sanitizeTeamCodeName(team: Team, previousName?: string): Team {
  const sanitized = withoutRealNameCodeName(team, previousName);
  if (sanitized.codeName === undefined && "codeName" in sanitized) {
    const { codeName: _removed, ...rest } = sanitized;
    return rest as Team;
  }
  return sanitized;
}

export const teamCreateOp: OpDef<TeamCreatePayload> = {
  type: "team.create",
  permission: "participants.edit",
  category: "participants",
  visibility: "private",
  lock: false,
  reads(_state, payload) {
    return [recordKey("team", payload.team.id)];
  },
  writes(_state, payload) {
    return [recordKey("team", payload.team.id)];
  },
  validate(state, payload) {
    const errors: string[] = [];
    const { team } = payload;
    if (!isNonEmptyText(team.id)) {
      errors.push("Team id must not be empty.");
    } else if (state.teams.some((item) => item.id === team.id)) {
      errors.push(`Team ${team.id} already exists.`);
    }
    if (!isNonEmptyText(team.name)) {
      errors.push("Team name must not be empty.");
    }
    if (!Array.isArray(team.speakers)) {
      errors.push("Team speakers must be a list.");
    }
    return errors;
  },
  apply(state, payload) {
    const created = sanitizeTeamCodeName(cloneValue(payload.team));
    return {
      state: {
        ...state,
        teams: insertAt(state.teams, created, payload.index),
      },
      committedPayload: {
        team: cloneValue(created),
        ...(payload.index !== undefined ? { index: payload.index } : {}),
      },
    };
  },
  inverse(committedPayload) {
    return {
      type: "team.delete",
      payload: {
        teamId: committedPayload.team.id,
      },
    };
  },
};

export const teamUpdateOp: OpDef<TeamUpdatePayload> = {
  type: "team.update",
  permission: "participants.edit",
  category: "participants",
  visibility: "private",
  lock: false,
  reads(state, payload) {
    return [
      recordKey("team", payload.team.id),
      ...state.ballots.map((ballot) => recordKey("ballot", ballot.id)),
    ];
  },
  writes(_state, payload) {
    return [recordKey("team", payload.team.id)];
  },
  validate(state, payload) {
    const errors: string[] = [];
    const { team } = payload;
    const existing = isNonEmptyText(team.id)
      ? state.teams.find((item) => item.id === team.id)
      : undefined;
    if (!isNonEmptyText(team.id)) {
      errors.push("Team id must not be empty.");
    } else if (!existing) {
      errors.push(`Team ${team.id} does not exist.`);
    }
    if (!isNonEmptyText(team.name)) {
      errors.push("Team name must not be empty.");
    }
    if (!Array.isArray(team.speakers)) {
      errors.push("Team speakers must be a list.");
    }
    if (errors.length > 0 || !existing) {
      return errors;
    }

    return violationsToErrors(
      checkSpeakerRemoval(existing, team, { ballots: state.ballots }),
    );
  },
  apply(state, payload) {
    const existing = state.teams.find((item) => item.id === payload.team.id)!;
    const previous = cloneValue(existing);
    const updated = sanitizeTeamCodeName(cloneValue(payload.team), existing.name);
    return {
      state: {
        ...state,
        teams: state.teams.map((item) =>
          item.id === updated.id ? updated : item,
        ),
      },
      committedPayload: {
        team: cloneValue(updated),
        previous,
      },
    };
  },
  inverse(committedPayload) {
    if (!committedPayload.previous) {
      return null;
    }
    return {
      type: "team.update",
      payload: {
        team: cloneValue(committedPayload.previous),
      },
    };
  },
};

export const teamDeleteOp: OpDef<TeamDeletePayload> = {
  type: "team.delete",
  permission: "participants.edit",
  category: "participants",
  visibility: "private",
  lock: false,
  reads(state, payload) {
    return [
      recordKey("team", payload.teamId),
      ...state.debates.map((debate) => recordKey("debate", debate.id)),
      ...state.ballots.map((ballot) => recordKey("ballot", ballot.id)),
      ...state.feedback.map((item) => recordKey("feedback", item.id)),
    ];
  },
  writes(_state, payload) {
    return [recordKey("team", payload.teamId)];
  },
  validate(state, payload) {
    const existing = state.teams.find((item) => item.id === payload.teamId);
    if (!existing) {
      return [`Team ${payload.teamId} does not exist.`];
    }
    return violationsToErrors(
      checkTeamDeletion(existing, {
        debates: state.debates,
        ballots: state.ballots,
        feedback: state.feedback,
      }),
    );
  },
  apply(state, payload) {
    const index = state.teams.findIndex((item) => item.id === payload.teamId);
    const previous = cloneValue(state.teams[index]!);
    return {
      state: {
        ...state,
        teams: state.teams.filter((item) => item.id !== payload.teamId),
      },
      committedPayload: {
        teamId: payload.teamId,
        previous,
        previousIndex: index,
      },
    };
  },
  inverse(committedPayload) {
    if (!committedPayload.previous) {
      return null;
    }
    return {
      type: "team.create",
      payload: {
        team: cloneValue(committedPayload.previous),
        index: committedPayload.previousIndex,
      },
    };
  },
};
