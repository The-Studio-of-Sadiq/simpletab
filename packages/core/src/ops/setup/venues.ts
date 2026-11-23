import { checkVenueDeletion } from "@/features/tournament/application/stateGuards";
import type { Venue } from "@/types";
import { recordKey, type OpDef } from "../types";
import {
  cloneValue,
  insertAt,
  isFiniteNumber,
  isNonEmptyText,
  violationsToErrors,
} from "./helpers";

export interface VenueCreatePayload {
  venue: Venue;
  index?: number;
}

export interface VenueUpdatePayload {
  venue: Venue;
  previous?: Venue;
}

export interface VenueDeletePayload {
  venueId: string;
  previous?: Venue;
  previousIndex?: number;
}

export const venueCreateOp: OpDef<VenueCreatePayload> = {
  type: "venue.create",
  permission: "venues.edit",
  category: "venues",
  visibility: "private",
  lock: false,
  reads(_state, payload) {
    return [recordKey("venue", payload.venue.id)];
  },
  writes(_state, payload) {
    return [recordKey("venue", payload.venue.id)];
  },
  validate(state, payload) {
    const errors: string[] = [];
    const { venue } = payload;
    if (!isNonEmptyText(venue.id)) {
      errors.push("Venue id must not be empty.");
    } else if (state.venues.some((item) => item.id === venue.id)) {
      errors.push(`Venue ${venue.id} already exists.`);
    }
    if (!isNonEmptyText(venue.name)) {
      errors.push("Venue name must not be empty.");
    }
    if (!isFiniteNumber(venue.priority)) {
      errors.push("Venue priority must be a finite number.");
    }
    return errors;
  },
  apply(state, payload) {
    const created = cloneValue(payload.venue);
    return {
      state: {
        ...state,
        venues: insertAt(state.venues, created, payload.index),
      },
      committedPayload: {
        venue: cloneValue(created),
        ...(payload.index !== undefined ? { index: payload.index } : {}),
      },
    };
  },
  inverse(committedPayload) {
    return {
      type: "venue.delete",
      payload: {
        venueId: committedPayload.venue.id,
      },
    };
  },
};

export const venueUpdateOp: OpDef<VenueUpdatePayload> = {
  type: "venue.update",
  permission: "venues.edit",
  category: "venues",
  visibility: "private",
  lock: false,
  reads(_state, payload) {
    return [recordKey("venue", payload.venue.id)];
  },
  writes(_state, payload) {
    return [recordKey("venue", payload.venue.id)];
  },
  validate(state, payload) {
    const errors: string[] = [];
    const { venue } = payload;
    if (!isNonEmptyText(venue.id)) {
      errors.push("Venue id must not be empty.");
    } else if (!state.venues.some((item) => item.id === venue.id)) {
      errors.push(`Venue ${venue.id} does not exist.`);
    }
    if (!isNonEmptyText(venue.name)) {
      errors.push("Venue name must not be empty.");
    }
    if (!isFiniteNumber(venue.priority)) {
      errors.push("Venue priority must be a finite number.");
    }
    return errors;
  },
  apply(state, payload) {
    const existing = state.venues.find((item) => item.id === payload.venue.id)!;
    const previous = cloneValue(existing);
    const updated = cloneValue(payload.venue);
    return {
      state: {
        ...state,
        venues: state.venues.map((item) =>
          item.id === updated.id ? updated : item,
        ),
      },
      committedPayload: {
        venue: cloneValue(updated),
        previous,
      },
    };
  },
  inverse(committedPayload) {
    if (!committedPayload.previous) {
      return null;
    }
    return {
      type: "venue.update",
      payload: {
        venue: cloneValue(committedPayload.previous),
      },
    };
  },
};

export const venueDeleteOp: OpDef<VenueDeletePayload> = {
  type: "venue.delete",
  permission: "venues.edit",
  category: "venues",
  visibility: "private",
  lock: false,
  reads(state, payload) {
    return [
      recordKey("venue", payload.venueId),
      ...state.debates.map((debate) => recordKey("debate", debate.id)),
      ...state.ballots.map((ballot) => recordKey("ballot", ballot.id)),
    ];
  },
  writes(_state, payload) {
    return [recordKey("venue", payload.venueId)];
  },
  validate(state, payload) {
    const existing = state.venues.find((item) => item.id === payload.venueId);
    if (!existing) {
      return [`Venue ${payload.venueId} does not exist.`];
    }
    return violationsToErrors(
      checkVenueDeletion(existing, {
        debates: state.debates,
        ballots: state.ballots,
      }),
    );
  },
  apply(state, payload) {
    const index = state.venues.findIndex((item) => item.id === payload.venueId);
    const previous = cloneValue(state.venues[index]!);
    return {
      state: {
        ...state,
        venues: state.venues.filter((item) => item.id !== payload.venueId),
      },
      committedPayload: {
        venueId: payload.venueId,
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
      type: "venue.create",
      payload: {
        venue: cloneValue(committedPayload.previous),
        index: committedPayload.previousIndex,
      },
    };
  },
};
