import { checkInstitutionDeletion } from "@/features/tournament/application/stateGuards";
import type { Institution } from "@/types";
import { recordKey, type OpDef } from "../types";
import {
  cloneValue,
  insertAt,
  isNonEmptyText,
  violationsToErrors,
} from "./helpers";

export interface InstitutionCreatePayload {
  institution: Institution;
  index?: number;
}

export interface InstitutionUpdatePayload {
  institution: Institution;
  previous?: Institution;
}

export interface InstitutionDeletePayload {
  institutionId: string;
  previous?: Institution;
  previousIndex?: number;
}

export const institutionCreateOp: OpDef<InstitutionCreatePayload> = {
  type: "institution.create",
  permission: "participants.edit",
  category: "participants",
  visibility: "private",
  lock: false,
  reads(_state, payload) {
    return [recordKey("institution", payload.institution.id)];
  },
  writes(_state, payload) {
    return [recordKey("institution", payload.institution.id)];
  },
  validate(state, payload) {
    const errors: string[] = [];
    const { institution } = payload;
    if (!isNonEmptyText(institution.id)) {
      errors.push("Institution id must not be empty.");
    } else if (state.institutions.some((item) => item.id === institution.id)) {
      errors.push(`Institution ${institution.id} already exists.`);
    }
    if (!isNonEmptyText(institution.name)) {
      errors.push("Institution name must not be empty.");
    }
    if (!isNonEmptyText(institution.code)) {
      errors.push("Institution code must not be empty.");
    }
    return errors;
  },
  apply(state, payload) {
    const created = cloneValue(payload.institution);
    return {
      state: {
        ...state,
        institutions: insertAt(state.institutions, created, payload.index),
      },
      committedPayload: {
        institution: cloneValue(created),
        ...(payload.index !== undefined ? { index: payload.index } : {}),
      },
    };
  },
  inverse(committedPayload) {
    return {
      type: "institution.delete",
      payload: {
        institutionId: committedPayload.institution.id,
      },
    };
  },
};

export const institutionUpdateOp: OpDef<InstitutionUpdatePayload> = {
  type: "institution.update",
  permission: "participants.edit",
  category: "participants",
  visibility: "private",
  lock: false,
  reads(_state, payload) {
    return [recordKey("institution", payload.institution.id)];
  },
  writes(_state, payload) {
    return [recordKey("institution", payload.institution.id)];
  },
  validate(state, payload) {
    const errors: string[] = [];
    const { institution } = payload;
    if (!isNonEmptyText(institution.id)) {
      errors.push("Institution id must not be empty.");
    } else if (!state.institutions.some((item) => item.id === institution.id)) {
      errors.push(`Institution ${institution.id} does not exist.`);
    }
    if (!isNonEmptyText(institution.name)) {
      errors.push("Institution name must not be empty.");
    }
    if (!isNonEmptyText(institution.code)) {
      errors.push("Institution code must not be empty.");
    }
    return errors;
  },
  apply(state, payload) {
    const existing = state.institutions.find(
      (item) => item.id === payload.institution.id,
    )!;
    const previous = cloneValue(existing);
    const updated = cloneValue(payload.institution);
    return {
      state: {
        ...state,
        institutions: state.institutions.map((item) =>
          item.id === updated.id ? updated : item,
        ),
      },
      committedPayload: {
        institution: cloneValue(updated),
        previous,
      },
    };
  },
  inverse(committedPayload) {
    if (!committedPayload.previous) {
      return null;
    }
    return {
      type: "institution.update",
      payload: {
        institution: cloneValue(committedPayload.previous),
      },
    };
  },
};

export const institutionDeleteOp: OpDef<InstitutionDeletePayload> = {
  type: "institution.delete",
  permission: "participants.edit",
  category: "participants",
  visibility: "private",
  lock: false,
  reads(state, payload) {
    return [
      recordKey("institution", payload.institutionId),
      ...state.teams.map((team) => recordKey("team", team.id)),
      ...state.adjudicators.map((adj) => recordKey("adjudicator", adj.id)),
    ];
  },
  writes(_state, payload) {
    return [recordKey("institution", payload.institutionId)];
  },
  validate(state, payload) {
    const existing = state.institutions.find(
      (item) => item.id === payload.institutionId,
    );
    if (!existing) {
      return [`Institution ${payload.institutionId} does not exist.`];
    }
    return violationsToErrors(
      checkInstitutionDeletion(existing, {
        debates: state.debates,
        ballots: state.ballots,
        teams: state.teams,
        adjudicators: state.adjudicators,
      }),
    );
  },
  apply(state, payload) {
    const index = state.institutions.findIndex(
      (item) => item.id === payload.institutionId,
    );
    const previous = cloneValue(state.institutions[index]!);
    return {
      state: {
        ...state,
        institutions: state.institutions.filter(
          (item) => item.id !== payload.institutionId,
        ),
      },
      committedPayload: {
        institutionId: payload.institutionId,
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
      type: "institution.create",
      payload: {
        institution: cloneValue(committedPayload.previous),
        index: committedPayload.previousIndex,
      },
    };
  },
};
