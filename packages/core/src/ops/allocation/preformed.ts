import {
  autoFillPreformedPanels,
  validatePreformedPanels,
} from "@/features/tournament/application/preformedPanels";
import type { PreformedPanel } from "@/types";
import { cloneValue, dedupeKeys } from "../setup/helpers";
import { recordKey, type OpDef, type OpRound } from "../types";

export interface AllocationPreformedSavePayload {
  roundId: string;
  panels: PreformedPanel[];
  clearPreformedPanels?: boolean;
  previousPanels?: PreformedPanel[] | null;
}

export interface AllocationPreformedAutofillPayload {
  roundId: string;
  panels?: PreformedPanel[];
  previousPanels?: PreformedPanel[] | null;
  filledPanels?: PreformedPanel[];
  warnings?: string[];
}

export const allocationPreformedSaveOp: OpDef<AllocationPreformedSavePayload> = {
  type: "allocation.preformed_save",
  permission: "allocation.edit",
  category: "allocation",
  visibility: "public",
  releaseGate: "draw_released",
  lock: false,
  reads(state, payload) {
    return dedupeKeys([
      recordKey("round", payload.roundId),
      ...state.adjudicators.map((adj) => recordKey("adjudicator", adj.id)),
    ]);
  },
  writes(_state, payload) {
    return [recordKey("round", payload.roundId)];
  },
  validate(state, payload) {
    const round = state.rounds.find((item) => item.id === payload.roundId);
    if (!round) {
      return [`Round ${payload.roundId} does not exist.`];
    }
    if (!Array.isArray(payload.panels)) {
      return ["panels must be an array."];
    }
    return validatePreformedPanels(payload.panels, state.adjudicators);
  },
  apply(state, payload) {
    const existing = state.rounds.find((item) => item.id === payload.roundId)!;
    const previousPanels =
      existing.preformedPanels === undefined
        ? null
        : cloneValue(existing.preformedPanels);

    const updated: OpRound = cloneValue(existing);
    if (payload.clearPreformedPanels) {
      delete updated.preformedPanels;
    } else {
      updated.preformedPanels = cloneValue(payload.panels);
    }

    return {
      state: {
        ...state,
        rounds: state.rounds.map((item) =>
          item.id === updated.id ? updated : item,
        ),
      },
      committedPayload: {
        ...cloneValue(payload),
        previousPanels,
      },
    };
  },
  inverse(committedPayload) {
    if (committedPayload.previousPanels === undefined) {
      return null;
    }
    if (committedPayload.previousPanels === null) {
      return {
        type: "allocation.preformed_save",
        payload: {
          roundId: committedPayload.roundId,
          panels: [],
          clearPreformedPanels: true,
        },
      };
    }
    return {
      type: "allocation.preformed_save",
      payload: {
        roundId: committedPayload.roundId,
        panels: cloneValue(committedPayload.previousPanels),
      },
    };
  },
};

export const allocationPreformedAutofillOp: OpDef<AllocationPreformedAutofillPayload> =
  {
    type: "allocation.preformed_autofill",
    permission: "allocation.edit",
    category: "allocation",
    visibility: "public",
    releaseGate: "draw_released",
    lock: true,
    reads(state, payload) {
      return dedupeKeys([
        recordKey("round", payload.roundId),
        ...state.adjudicators.map((adj) => recordKey("adjudicator", adj.id)),
        ...state.debates.map((debate) => recordKey("debate", debate.id)),
        ...state.feedback.map((item) => recordKey("feedback", item.id)),
      ]);
    },
    writes(_state, payload) {
      return [recordKey("round", payload.roundId)];
    },
    validate(state, payload) {
      const round = state.rounds.find((item) => item.id === payload.roundId);
      if (!round) {
        return [`Round ${payload.roundId} does not exist.`];
      }
      if (round.cancelled) {
        return [`${round.name} is cancelled.`];
      }
      if (payload.panels !== undefined && !Array.isArray(payload.panels)) {
        return ["panels must be an array when provided."];
      }
      const targetPanels = payload.panels ?? round.preformedPanels ?? [];
      try {
        const result = autoFillPreformedPanels(round, cloneValue(targetPanels), {
          tournament: state.tournament,
          rounds: state.rounds,
          debates: state.debates,
          adjudicators: state.adjudicators,
          feedback: state.feedback,
        });
        return validatePreformedPanels(result.panels, state.adjudicators);
      } catch (error) {
        return [
          error instanceof Error
            ? error.message
            : "Failed to autofill preformed panels.",
        ];
      }
    },
    apply(state, payload) {
      const existing = state.rounds.find((item) => item.id === payload.roundId)!;
      const previousPanels =
        existing.preformedPanels === undefined
          ? null
          : cloneValue(existing.preformedPanels);
      const targetPanels = payload.panels ?? existing.preformedPanels ?? [];
      const result = autoFillPreformedPanels(
        existing,
        cloneValue(targetPanels),
        {
          tournament: state.tournament,
          rounds: state.rounds,
          debates: state.debates,
          adjudicators: state.adjudicators,
          feedback: state.feedback,
        },
      );
      const filledPanels = cloneValue(result.panels);
      const updated: OpRound = {
        ...cloneValue(existing),
        preformedPanels: cloneValue(filledPanels),
      };

      return {
        state: {
          ...state,
          rounds: state.rounds.map((item) =>
            item.id === updated.id ? updated : item,
          ),
        },
        committedPayload: {
          ...cloneValue(payload),
          previousPanels,
          filledPanels,
          warnings: [...result.warnings],
        },
      };
    },
    inverse(committedPayload) {
      if (committedPayload.previousPanels === undefined) {
        return null;
      }
      if (committedPayload.previousPanels === null) {
        return {
          type: "allocation.preformed_save",
          payload: {
            roundId: committedPayload.roundId,
            panels: [],
            clearPreformedPanels: true,
          },
        };
      }
      return {
        type: "allocation.preformed_save",
        payload: {
          roundId: committedPayload.roundId,
          panels: cloneValue(committedPayload.previousPanels),
        },
      };
    },
  };
