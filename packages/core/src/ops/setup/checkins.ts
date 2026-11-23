import { setRoundAvailability } from "@/lib/roundAvailability";
import { selfCheckInError } from "@/lib/selfCheckIn";
import type { Adjudicator, Team } from "@/types";
import { recordKey, type OpDef, type TournamentState } from "../types";
import { cloneValue, isNonEmptyText } from "./helpers";

export interface CheckinRestorePrevious {
  hadRoundAvailability: boolean;
  previousValue?: boolean;
}

export interface CheckinParticipantPayload {
  entityType: "team" | "adjudicator";
  entityId: string;
  roundId: string;
  available: boolean;
  restorePrevious?: CheckinRestorePrevious;
}

export interface CheckinSetVenuePayload {
  venueId: string;
  checkedIn: boolean;
  clearCheckedIn?: boolean;
  previousCheckedIn?: boolean | null;
}

function findParticipant(
  state: TournamentState,
  entityType: "team" | "adjudicator",
  entityId: string,
): Team | Adjudicator | undefined {
  return entityType === "team"
    ? state.teams.find((item) => item.id === entityId)
    : state.adjudicators.find((item) => item.id === entityId);
}

function applyParticipantAvailability(
  state: TournamentState,
  payload: CheckinParticipantPayload,
): { state: TournamentState; committedPayload: CheckinParticipantPayload } {
  const existing = findParticipant(state, payload.entityType, payload.entityId)!;
  const hadRoundAvailability = existing.roundAvailability !== undefined;
  const previousValue = existing.roundAvailability?.[payload.roundId];

  const restorePrevious: CheckinRestorePrevious = {
    hadRoundAvailability,
    ...(previousValue !== undefined ? { previousValue } : {}),
  };

  let updated: Team | Adjudicator;
  if (payload.restorePrevious !== undefined) {
    const cloned = cloneValue(existing);
    if (!payload.restorePrevious.hadRoundAvailability) {
      delete cloned.roundAvailability;
    } else if (payload.restorePrevious.previousValue === undefined) {
      const nextAvailability = { ...cloned.roundAvailability };
      delete nextAvailability[payload.roundId];
      cloned.roundAvailability = nextAvailability;
    } else {
      cloned.roundAvailability = {
        ...cloned.roundAvailability,
        [payload.roundId]: payload.restorePrevious.previousValue,
      };
    }
    updated = cloned;
  } else {
    updated = setRoundAvailability(
      cloneValue(existing),
      payload.roundId,
      payload.available,
    );
  }

  const nextState: TournamentState =
    payload.entityType === "team"
      ? {
          ...state,
          teams: state.teams.map((item) =>
            item.id === updated.id ? (updated as Team) : item,
          ),
        }
      : {
          ...state,
          adjudicators: state.adjudicators.map((item) =>
            item.id === updated.id ? (updated as Adjudicator) : item,
          ),
        };

  return {
    state: nextState,
    committedPayload: {
      ...cloneValue(payload),
      restorePrevious,
    },
  };
}

function validateParticipantAvailability(
  state: TournamentState,
  payload: CheckinParticipantPayload,
): string[] {
  const errors: string[] = [];
  if (payload.entityType !== "team" && payload.entityType !== "adjudicator") {
    errors.push("entityType must be team or adjudicator.");
    return errors;
  }
  if (!isNonEmptyText(payload.entityId)) {
    errors.push("entityId must not be empty.");
  } else if (!findParticipant(state, payload.entityType, payload.entityId)) {
    errors.push(`${payload.entityType} ${payload.entityId} does not exist.`);
  }
  if (!isNonEmptyText(payload.roundId)) {
    errors.push("roundId must not be empty.");
  } else if (!state.rounds.some((round) => round.id === payload.roundId)) {
    errors.push(`Round ${payload.roundId} does not exist.`);
  }
  if (typeof payload.available !== "boolean") {
    errors.push("available must be a boolean.");
  }
  return errors;
}

export const checkinSetParticipantOp: OpDef<CheckinParticipantPayload> = {
  type: "checkin.set_participant",
  permission: "checkins.edit",
  category: "checkins",
  visibility: "private",
  lock: false,
  reads(_state, payload) {
    return [
      recordKey(payload.entityType, payload.entityId),
      recordKey("round", payload.roundId),
    ];
  },
  writes(_state, payload) {
    return [recordKey(payload.entityType, payload.entityId)];
  },
  validate(state, payload) {
    return validateParticipantAvailability(state, payload);
  },
  apply(state, payload) {
    return applyParticipantAvailability(state, payload);
  },
  inverse(committedPayload) {
    if (!committedPayload.restorePrevious) {
      return null;
    }
    return {
      type: "checkin.set_participant",
      payload: {
        entityType: committedPayload.entityType,
        entityId: committedPayload.entityId,
        roundId: committedPayload.roundId,
        available:
          committedPayload.restorePrevious.previousValue ??
          !committedPayload.available,
        restorePrevious: cloneValue(committedPayload.restorePrevious),
      },
    };
  },
};

export const checkinSetVenueOp: OpDef<CheckinSetVenuePayload> = {
  type: "checkin.set_venue",
  permission: "checkins.edit",
  category: "checkins",
  visibility: "private",
  lock: false,
  reads(_state, payload) {
    return [recordKey("venue", payload.venueId)];
  },
  writes(_state, payload) {
    return [recordKey("venue", payload.venueId)];
  },
  validate(state, payload) {
    const errors: string[] = [];
    if (!isNonEmptyText(payload.venueId)) {
      errors.push("venueId must not be empty.");
    } else if (!state.venues.some((venue) => venue.id === payload.venueId)) {
      errors.push(`Venue ${payload.venueId} does not exist.`);
    }
    if (typeof payload.checkedIn !== "boolean") {
      errors.push("checkedIn must be a boolean.");
    }
    return errors;
  },
  apply(state, payload) {
    const existing = state.venues.find((venue) => venue.id === payload.venueId)!;
    const previousCheckedIn = existing.checkedIn ?? null;
    const updated = cloneValue(existing);
    if (payload.clearCheckedIn) {
      delete updated.checkedIn;
    } else {
      updated.checkedIn = payload.checkedIn;
    }

    return {
      state: {
        ...state,
        venues: state.venues.map((venue) =>
          venue.id === updated.id ? updated : venue,
        ),
      },
      committedPayload: {
        ...cloneValue(payload),
        previousCheckedIn,
      },
    };
  },
  inverse(committedPayload) {
    if (committedPayload.previousCheckedIn === undefined) {
      return null;
    }
    if (committedPayload.previousCheckedIn === null) {
      return {
        type: "checkin.set_venue",
        payload: {
          venueId: committedPayload.venueId,
          checkedIn: false,
          clearCheckedIn: true,
        },
      };
    }
    return {
      type: "checkin.set_venue",
      payload: {
        venueId: committedPayload.venueId,
        checkedIn: committedPayload.previousCheckedIn,
      },
    };
  },
};

export const checkinSelfCheckinOp: OpDef<CheckinParticipantPayload> = {
  type: "checkin.self_checkin",
  permission: "service",
  category: "checkins",
  visibility: "private",
  lock: false,
  reads(state, payload) {
    return [
      recordKey("tournament", state.tournament.id),
      recordKey("round", payload.roundId),
      recordKey(payload.entityType, payload.entityId),
    ];
  },
  writes(_state, payload) {
    return [recordKey(payload.entityType, payload.entityId)];
  },
  validate(state, payload) {
    const errors = validateParticipantAvailability(state, payload);
    if (errors.length > 0) {
      return errors;
    }
    if (payload.restorePrevious !== undefined) {
      return [];
    }
    const selfError = selfCheckInError(
      state.tournament.preferences,
      state.rounds,
      { roundId: payload.roundId, available: payload.available },
    );
    return selfError ? [selfError] : [];
  },
  apply(state, payload) {
    return applyParticipantAvailability(state, payload);
  },
  inverse(committedPayload) {
    if (!committedPayload.restorePrevious) {
      return null;
    }
    return {
      type: "checkin.self_checkin",
      payload: {
        entityType: committedPayload.entityType,
        entityId: committedPayload.entityId,
        roundId: committedPayload.roundId,
        available:
          committedPayload.restorePrevious.previousValue ??
          !committedPayload.available,
        restorePrevious: cloneValue(committedPayload.restorePrevious),
      },
    };
  },
};
