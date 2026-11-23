import { applyNameGenerators } from "@/lib/registration/names";
import {
  buildAdjudicatorFromSubmission,
  buildTeamFromSubmission,
  matchInstitution,
  suggestInstitutionCode,
} from "@/lib/registration/review";
import type {
  RegistrationSettings,
  RegistrationSubmission,
} from "@/lib/registration/types";
import {
  defaultRegistrationSettings,
  parseRegistrationEntry,
  spamSignal,
} from "@/lib/registration/validation";
import type { Adjudicator, Institution, Team } from "@/types";
import {
  cloneValue,
  dedupeKeys,
  isFiniteNumber,
  isNonEmptyText,
  isValidIsoInstant,
} from "../setup/helpers";
import { recordKey, type OpDef, type TournamentState } from "../types";

export interface RegistrationReceivePayload {
  submissionId: string;
  entry: unknown;
  receivedAt: string;
  honeypot?: unknown;
  startedAt?: number;
  settings?: RegistrationSettings;
  sourceHash?: string;
}

export interface RegistrationAcceptPayload {
  submissionId: string;
  entityId: string;
  speakerIds?: string[];
  createdInstitutionId?: string;
  adjudicatorBaseScore?: number;
  reviewedAt?: string;
  approvedEntityKind?: "team" | "adjudicator";
  approvedEntityId?: string;
  createdInstitutionIdUsed?: string;
  unmatchedConflicts?: string[];
}

function effectiveRegistrationSettings(
  state: TournamentState,
  override?: RegistrationSettings,
): RegistrationSettings {
  return (
    override ??
    state.registrationSettings ??
    defaultRegistrationSettings(
      state.tournament.name,
      state.tournament.preferences.substantiveSpeakers,
    )
  );
}

export const registrationReceiveOp: OpDef<RegistrationReceivePayload> = {
  type: "registration.receive",
  permission: "service",
  category: "registration",
  visibility: "private",
  lock: false,
  reads(state, payload) {
    return [
      recordKey("tournament", state.tournament.id),
      recordKey("registration", payload.submissionId),
    ];
  },
  writes(_state, payload) {
    return [recordKey("registration", payload.submissionId)];
  },
  validate(state, payload) {
    const errors: string[] = [];
    if (!isNonEmptyText(payload.submissionId)) {
      errors.push("submissionId must not be empty.");
    } else if (
      state.registrations.some((item) => item.id === payload.submissionId)
    ) {
      errors.push(`Registration ${payload.submissionId} already exists.`);
    }
    if (!isValidIsoInstant(payload.receivedAt)) {
      errors.push("receivedAt must be a valid ISO 8601 instant.");
      return errors;
    }

    const spam = spamSignal(
      { honeypot: payload.honeypot, startedAt: payload.startedAt },
      Date.parse(payload.receivedAt),
    );
    if (spam !== null) {
      errors.push(`Registration flagged as automated (${spam}).`);
    }

    const settings = effectiveRegistrationSettings(state, payload.settings);
    try {
      parseRegistrationEntry(payload.entry, settings);
    } catch (error) {
      errors.push(
        error instanceof Error
          ? error.message
          : "Invalid registration entry.",
      );
    }
    return errors;
  },
  apply(state, payload) {
    const settings = effectiveRegistrationSettings(state, payload.settings);
    const parsedEntry = parseRegistrationEntry(payload.entry, settings);
    const submission: RegistrationSubmission = {
      ...parsedEntry,
      id: payload.submissionId,
      status: "pending",
      submittedAt: payload.receivedAt,
      updatedAt: payload.receivedAt,
      revision: 1,
      ...(payload.sourceHash ? { sourceHash: payload.sourceHash } : {}),
    };

    return {
      state: {
        ...state,
        registrations: [...state.registrations, submission],
      },
      committedPayload: cloneValue(payload),
    };
  },
  inverse() {
    return null;
  },
};

export const registrationAcceptOp: OpDef<RegistrationAcceptPayload> = {
  type: "registration.accept",
  permission: "registration.manage",
  category: "registration",
  visibility: "private",
  lock: false,
  reads(state, payload) {
    return dedupeKeys([
      recordKey("registration", payload.submissionId),
      ...state.institutions.map((inst) => recordKey("institution", inst.id)),
      ...state.teams.map((team) => recordKey("team", team.id)),
      ...state.adjudicators.map((adj) => recordKey("adjudicator", adj.id)),
      ...state.breakCategories.map((cat) => recordKey("breakCategory", cat.id)),
    ]);
  },
  writes(state, payload) {
    const submission = state.registrations.find(
      (item) => item.id === payload.submissionId,
    );
    const keys = [recordKey("registration", payload.submissionId)];
    if (submission?.kind === "team") {
      keys.push(recordKey("team", payload.entityId));
    } else if (submission?.kind === "adjudicator") {
      keys.push(recordKey("adjudicator", payload.entityId));
    }
    if (payload.createdInstitutionIdUsed) {
      keys.push(recordKey("institution", payload.createdInstitutionIdUsed));
    } else if (submission?.institution) {
      const matched = matchInstitution(
        submission.institution.name,
        state.institutions,
      );
      if (!matched) {
        keys.push(
          recordKey(
            "institution",
            payload.createdInstitutionId ?? `inst-reg-${submission.id}`,
          ),
        );
      }
    }
    return dedupeKeys(keys);
  },
  validate(state, payload) {
    if (!isNonEmptyText(payload.submissionId)) {
      return ["submissionId must not be empty."];
    }
    const submission = state.registrations.find(
      (item) => item.id === payload.submissionId,
    );
    if (!submission) {
      return [`Registration ${payload.submissionId} does not exist.`];
    }
    if (submission.status !== "pending") {
      return ["Only pending submissions can be approved."];
    }
    if (submission.kind === "institution") {
      return ["Give an institution registration its places instead."];
    }
    if (!isNonEmptyText(payload.entityId)) {
      return ["entityId must not be empty."];
    }
    if (submission.kind === "team") {
      if (state.teams.some((team) => team.id === payload.entityId)) {
        return [`Team ${payload.entityId} already exists.`];
      }
    } else if (
      state.adjudicators.some((adj) => adj.id === payload.entityId)
    ) {
      return [`Adjudicator ${payload.entityId} already exists.`];
    }
    if (
      payload.adjudicatorBaseScore !== undefined &&
      !isFiniteNumber(payload.adjudicatorBaseScore)
    ) {
      return ["adjudicatorBaseScore must be a finite number."];
    }
    if (
      payload.reviewedAt !== undefined &&
      !isValidIsoInstant(payload.reviewedAt)
    ) {
      return ["reviewedAt must be a valid ISO 8601 instant."];
    }
    return [];
  },
  apply(state, payload, actor) {
    const submission = state.registrations.find(
      (item) => item.id === payload.submissionId,
    )!;
    const reviewedAt =
      payload.reviewedAt ?? state.runtime?.now ?? state.tournament.updatedAt;

    let institution: Institution | undefined;
    let createdInstitution: Institution | undefined;
    if (submission.institution) {
      const match = matchInstitution(
        submission.institution.name,
        state.institutions,
      );
      institution =
        match &&
        state.institutions.find((inst) => inst.id === match.id);
      if (!institution) {
        const instId =
          payload.createdInstitutionId ?? `inst-reg-${submission.id}`;
        createdInstitution = {
          id: instId,
          tournamentId: state.tournament.id,
          name: submission.institution.name,
          code: suggestInstitutionCode(
            submission.institution.name,
            state.institutions.map((inst) => inst.code),
          ),
        };
        institution = createdInstitution;
      }
    }

    const nextInstitutions = createdInstitution
      ? [...state.institutions, createdInstitution]
      : state.institutions;

    let nextTeams = state.teams;
    let nextAdjudicators = state.adjudicators;
    let approvedEntityName = "";
    let unmatchedConflicts: string[] = [];

    if (submission.kind === "team") {
      let speakerIdx = 0;
      const createSpeakerId = (): string => {
        const explicit = payload.speakerIds?.[speakerIdx];
        speakerIdx += 1;
        return explicit && isNonEmptyText(explicit)
          ? explicit
          : `${payload.entityId}-s${speakerIdx}`;
      };
      const built = applyNameGenerators(
        buildTeamFromSubmission(
          submission,
          institution,
          createSpeakerId,
          {
            teams: state.teams,
            breakCategoryIds: state.breakCategories.map((cat) => cat.id),
          },
        ),
        {
          settings: state.registrationSettings ?? {},
          institutionName: institution?.name,
          teams: state.teams,
        },
      );
      const team: Team = {
        ...built,
        id: payload.entityId,
        tournamentId: state.tournament.id,
      };
      nextTeams = [...state.teams, team];
      approvedEntityName = team.name;
    } else {
      const built = buildAdjudicatorFromSubmission(submission, {
        institution,
        institutions: nextInstitutions,
        teams: state.teams,
        baseScore: payload.adjudicatorBaseScore ?? 5,
      });
      unmatchedConflicts = built.unmatchedConflicts;
      const adj: Adjudicator = {
        ...built.adjudicator,
        id: payload.entityId,
        tournamentId: state.tournament.id,
      };
      if (adj.email === undefined) {
        delete adj.email;
      }
      nextAdjudicators = [...state.adjudicators, adj];
      approvedEntityName = adj.name;
    }

    const updatedSubmission: RegistrationSubmission = {
      ...cloneValue(submission),
      status: "approved",
      approvedEntityId: payload.entityId,
      approvedEntityName,
      reviewedAt,
      ...(actor?.ref ? { reviewedBy: actor.ref } : {}),
      updatedAt: reviewedAt,
      revision: submission.revision + 1,
    };

    const nextRegistrations = state.registrations.map((item) =>
      item.id === updatedSubmission.id ? updatedSubmission : item,
    );

    return {
      state: {
        ...state,
        institutions: nextInstitutions,
        teams: nextTeams,
        adjudicators: nextAdjudicators,
        registrations: nextRegistrations,
      },
      committedPayload: {
        ...cloneValue(payload),
        approvedEntityKind: submission.kind as "team" | "adjudicator",
        approvedEntityId: payload.entityId,
        ...(createdInstitution
          ? { createdInstitutionIdUsed: createdInstitution.id }
          : {}),
        ...(unmatchedConflicts.length > 0 ? { unmatchedConflicts } : {}),
      },
    };
  },
  inverse(committedPayload) {
    if (!committedPayload.approvedEntityId) {
      return null;
    }
    if (committedPayload.approvedEntityKind === "team") {
      return {
        type: "team.delete",
        payload: { teamId: committedPayload.approvedEntityId },
      };
    }
    if (committedPayload.approvedEntityKind === "adjudicator") {
      return {
        type: "adjudicator.delete",
        payload: { adjudicatorId: committedPayload.approvedEntityId },
      };
    }
    return null;
  },
};
