import {
  checkSettingsChange,
  type RuleOverride,
} from "@/features/tournament/application/stateGuards";
import {
  debateWithBallotTotals,
  recomputeStoredBallots,
} from "@/lib/ballots/resave";
import {
  describePreferenceProblems,
  isKnownPreference,
  preferenceChangeProblems,
} from "@/lib/setup/preferenceValidation";
import {
  normalizeCustomGroups,
  validateCustomGroups,
  type CustomPermissionGroup,
} from "@/lib/staffPermissions";
import type { Tournament, TournamentPreferences } from "@/types";
import { recordKey, type OpDef, type RecordKey } from "../types";
import { cloneValue, isNonEmptyText, violationsToErrors } from "./helpers";

export interface SettingsUpdatePrevious {
  preferences: Partial<TournamentPreferences>;
  removedPreferenceKeys: (keyof TournamentPreferences)[];
  name?: string;
  shortName?: string;
  format?: Tournament["format"];
}

export interface SettingsUpdatePayload {
  preferences: Partial<TournamentPreferences>;
  removePreferenceKeys?: (keyof TournamentPreferences)[];
  name?: string;
  shortName?: string;
  format?: Tournament["format"];
  override?: RuleOverride;
  previous?: SettingsUpdatePrevious;
}

export interface SettingsResaveBallotsPayload {
  changedKeys: (keyof TournamentPreferences)[];
  preferences?: Partial<TournamentPreferences>;
  override?: RuleOverride;
  updatedBallotIds?: string[];
  updatedDebateIds?: string[];
  resultChangedIds?: string[];
  skipped?: { ballotId: string; reason: string }[];
}

export interface RolesUpdatePayload {
  customGroups: CustomPermissionGroup[];
  previous?: CustomPermissionGroup[];
}

function buildNextTournament(
  current: Tournament,
  payload: Pick<
    SettingsUpdatePayload,
    "preferences" | "removePreferenceKeys" | "name" | "shortName" | "format"
  >,
): Tournament {
  const nextPreferences: Record<string, unknown> = {
    ...cloneValue(current.preferences),
  };

  if (payload.removePreferenceKeys) {
    for (const key of payload.removePreferenceKeys) {
      delete nextPreferences[key];
    }
  }

  for (const [key, value] of Object.entries(payload.preferences)) {
    if (value !== undefined) {
      nextPreferences[key] = cloneValue(value);
    }
  }

  return {
    ...cloneValue(current),
    ...(payload.name !== undefined ? { name: payload.name } : {}),
    ...(payload.shortName !== undefined ? { shortName: payload.shortName } : {}),
    ...(payload.format !== undefined ? { format: payload.format } : {}),
    preferences: nextPreferences as unknown as TournamentPreferences,
  };
}

export const settingsUpdateOp: OpDef<SettingsUpdatePayload> = {
  type: "settings.update",
  permission: "settings.edit",
  category: "tournament",
  visibility: "private",
  lock: false,
  reads(state) {
    return [recordKey("tournament", state.tournament.id)];
  },
  writes(state) {
    return [recordKey("tournament", state.tournament.id)];
  },
  validate(state, payload) {
    const errors: string[] = [];
    if (payload.preferences === null || typeof payload.preferences !== "object" || Array.isArray(payload.preferences)) {
      return ["preferences must be an object."];
    }
    if (payload.format === "poly") {
      errors.push("Only BP and two-team formats are supported.");
    }
    if (payload.name !== undefined && !isNonEmptyText(payload.name)) {
      errors.push("Tournament name must not be empty.");
    }
    if (payload.shortName !== undefined && !isNonEmptyText(payload.shortName)) {
      errors.push("Tournament short name must not be empty.");
    }
    if (errors.length > 0) {
      return errors;
    }

    const nextTournament = buildNextTournament(state.tournament, payload);
    const problems = preferenceChangeProblems(
      state.tournament.preferences,
      nextTournament.preferences,
      {
        format: nextTournament.format,
        rounds: state.rounds,
      },
    );
    if (problems.length > 0) {
      errors.push(describePreferenceProblems(problems));
    }

    const guardViolations = checkSettingsChange(
      state.tournament,
      nextTournament,
      state.ballots,
      state.rounds,
    );
    errors.push(...violationsToErrors(guardViolations, payload.override));
    return errors;
  },
  apply(state, payload) {
    const prevPrefs = state.tournament.preferences as unknown as Record<string, unknown>;
    const previousPreferences: Record<string, unknown> = {};
    const removedPreferenceKeys: (keyof TournamentPreferences)[] = [];

    for (const key of Object.keys(payload.preferences)) {
      if (Object.prototype.hasOwnProperty.call(prevPrefs, key) && prevPrefs[key] !== undefined) {
        previousPreferences[key] = cloneValue(prevPrefs[key]);
      } else {
        removedPreferenceKeys.push(key as keyof TournamentPreferences);
      }
    }
    if (payload.removePreferenceKeys) {
      for (const key of payload.removePreferenceKeys) {
        if (Object.prototype.hasOwnProperty.call(prevPrefs, key) && prevPrefs[key] !== undefined) {
          previousPreferences[key] = cloneValue(prevPrefs[key]);
        }
      }
    }

    const previous: SettingsUpdatePrevious = {
      preferences: previousPreferences as Partial<TournamentPreferences>,
      removedPreferenceKeys,
      ...(payload.name !== undefined ? { name: state.tournament.name } : {}),
      ...(payload.shortName !== undefined ? { shortName: state.tournament.shortName } : {}),
      ...(payload.format !== undefined ? { format: state.tournament.format } : {}),
    };

    const nextTournament = buildNextTournament(state.tournament, payload);
    return {
      state: {
        ...state,
        tournament: nextTournament,
      },
      committedPayload: {
        ...cloneValue(payload),
        previous,
      },
    };
  },
  inverse(committedPayload) {
    const previous = committedPayload.previous;
    if (!previous) {
      return null;
    }
    return {
      type: "settings.update",
      payload: {
        preferences: cloneValue(previous.preferences),
        ...(previous.removedPreferenceKeys.length > 0
          ? { removePreferenceKeys: [...previous.removedPreferenceKeys] }
          : {}),
        ...(previous.name !== undefined ? { name: previous.name } : {}),
        ...(previous.shortName !== undefined ? { shortName: previous.shortName } : {}),
        ...(previous.format !== undefined ? { format: previous.format } : {}),
        override: { reason: "Undo settings.update" },
      },
    };
  },
};

export const settingsResaveBallotsOp: OpDef<SettingsResaveBallotsPayload> = {
  type: "settings.resave_ballots",
  permission: "settings.edit",
  category: "tournament",
  visibility: "private",
  lock: true,
  reads(state) {
    return [
      recordKey("tournament", state.tournament.id),
      ...state.ballots.map((ballot) => recordKey("ballot", ballot.id)),
      ...state.debates.map((debate) => recordKey("debate", debate.id)),
    ];
  },
  writes(state, payload) {
    const keys: RecordKey[] = [];
    if (payload.preferences !== undefined) {
      keys.push(recordKey("tournament", state.tournament.id));
    }
    if (payload.updatedBallotIds && payload.updatedDebateIds) {
      for (const id of payload.updatedBallotIds) {
        keys.push(recordKey("ballot", id));
      }
      for (const id of payload.updatedDebateIds) {
        keys.push(recordKey("debate", id));
      }
      return keys;
    }
    const nextTournament = payload.preferences
      ? buildNextTournament(state.tournament, { preferences: payload.preferences })
      : state.tournament;
    const outcome = recomputeStoredBallots(state.ballots, {
      tournament: nextTournament,
      rounds: state.rounds,
      debates: state.debates,
    });
    for (const ballot of outcome.updated) {
      keys.push(recordKey("ballot", ballot.id));
    }
    const confirmedDebateIds = new Set(
      outcome.updated.filter((ballot) => ballot.confirmed).map((ballot) => ballot.debateId),
    );
    for (const debate of state.debates) {
      if (confirmedDebateIds.has(debate.id)) {
        keys.push(recordKey("debate", debate.id));
      }
    }
    return keys;
  },
  validate(state, payload) {
    const errors: string[] = [];
    if (!Array.isArray(payload.changedKeys) || payload.changedKeys.length === 0) {
      errors.push("changedKeys must contain at least one preference key.");
    } else {
      for (const key of payload.changedKeys) {
        if (!isKnownPreference(String(key))) {
          errors.push(`Unknown preference key: ${String(key)}.`);
        }
      }
    }
    const nextTournament = payload.preferences
      ? buildNextTournament(state.tournament, { preferences: payload.preferences })
      : state.tournament;

    if (payload.preferences) {
      const problems = preferenceChangeProblems(
        state.tournament.preferences,
        nextTournament.preferences,
        {
          format: nextTournament.format,
          rounds: state.rounds,
        },
      );
      if (problems.length > 0) {
        errors.push(describePreferenceProblems(problems));
      }
    }

    const guardViolations = checkSettingsChange(
      state.tournament,
      nextTournament,
      state.ballots,
      state.rounds,
    );
    errors.push(...violationsToErrors(guardViolations, payload.override));
    return errors;
  },
  apply(state, payload) {
    const nextTournament = payload.preferences
      ? buildNextTournament(state.tournament, { preferences: payload.preferences })
      : cloneValue(state.tournament);

    const outcome = recomputeStoredBallots(state.ballots, {
      tournament: nextTournament,
      rounds: state.rounds,
      debates: state.debates,
    });

    const updatedById = new Map(outcome.updated.map((ballot) => [ballot.id, ballot]));
    const nextBallots = state.ballots.map(
      (ballot) => updatedById.get(ballot.id) ?? ballot,
    );

    const confirmedByDebate = new Map(
      outcome.updated
        .filter((ballot) => ballot.confirmed)
        .map((ballot) => [ballot.debateId, ballot]),
    );
    const updatedDebateIds: string[] = [];
    const nextDebates = state.debates.map((debate) => {
      const ballot = confirmedByDebate.get(debate.id);
      if (!ballot) {
        return debate;
      }
      updatedDebateIds.push(debate.id);
      return debateWithBallotTotals(debate, ballot);
    });

    return {
      state: {
        ...state,
        tournament: nextTournament,
        ballots: nextBallots,
        debates: nextDebates,
      },
      committedPayload: {
        ...cloneValue(payload),
        updatedBallotIds: outcome.updated.map((ballot) => ballot.id),
        updatedDebateIds,
        resultChangedIds: outcome.resultChangedIds,
        skipped: outcome.skipped,
      },
    };
  },
  inverse() {
    return null;
  },
};

export const rolesUpdateOp: OpDef<RolesUpdatePayload> = {
  type: "roles.update",
  permission: "roles.manage",
  category: "tournament",
  visibility: "private",
  lock: false,
  reads() {
    return [recordKey("role", "custom_groups")];
  },
  writes() {
    return [recordKey("role", "custom_groups")];
  },
  validate(_state, payload) {
    return validateCustomGroups(payload.customGroups);
  },
  apply(state, payload) {
    const previous = cloneValue(state.roles);
    const normalized = normalizeCustomGroups(payload.customGroups);
    return {
      state: {
        ...state,
        roles: normalized,
      },
      committedPayload: {
        customGroups: cloneValue(normalized),
        previous,
      },
    };
  },
  inverse(committedPayload) {
    return {
      type: "roles.update",
      payload: {
        customGroups: cloneValue(committedPayload.previous ?? []),
      },
    };
  },
};
