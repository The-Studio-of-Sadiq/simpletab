import type { ProjectedState, SubmitResult } from "@simpletab/host/lib/common/host-protocol";
import type { TournamentStoreSnapshot } from "../store/tournament-store";
import { t } from "../i18n";
import { defineAction, type ActionContext } from "./action";

/** Widget id of the Proposals page (kept here so actions do not import widget classes). */
export const PROPOSALS_PAGE = "simpletab.proposals";

/** Same rule as the Proposals page: the host checks the real permission when it applies. */
export function canDecideProposals(state: ProjectedState | null): boolean {
  return state !== null && state.roleId !== "ai" && (state.permissions?.length ?? 0) > 0;
}

function pendingProposals(snapshot: TournamentStoreSnapshot) {
  return (snapshot.state?.proposals ?? [])
    .filter((proposal) => proposal.status === "pending")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function hasPendingDecision(snapshot: TournamentStoreSnapshot): boolean {
  return canDecideProposals(snapshot.state) && pendingProposals(snapshot).length > 0;
}

async function pickPending(ctx: ActionContext): Promise<string | undefined> {
  const items = pendingProposals(ctx.store.getSnapshot()).map((proposal) => ({
    label: proposal.op.type,
    description: `${proposal.proposedBy.role.name} · ${proposal.proposedBy.ref}`,
    detail: new Date(proposal.createdAt).toLocaleString(),
    value: proposal.id,
  }));
  return ctx.prompts.pick(items, t("action.proposals.pickProposal"));
}

export interface ProposalArgs {
  proposalId: string;
}

export interface RejectProposalArgs extends ProposalArgs {
  reason?: string;
}

export const acceptProposalAction = defineAction<ProposalArgs, SubmitResult>({
  id: "simpletab.proposals.accept",
  labelKey: "action.proposals.accept",
  page: PROPOSALS_PAGE,
  isEnabled: hasPendingDecision,
  async prompt(ctx) {
    const proposalId = await pickPending(ctx);
    return proposalId === undefined ? undefined : { proposalId };
  },
  run: (ctx, { proposalId }) =>
    ctx.store.submit({ type: "proposal.accept", payload: { proposalId } }),
});

export const rejectProposalAction = defineAction<RejectProposalArgs, SubmitResult>({
  id: "simpletab.proposals.reject",
  labelKey: "action.proposals.reject",
  page: PROPOSALS_PAGE,
  isEnabled: hasPendingDecision,
  async prompt(ctx) {
    const proposalId = await pickPending(ctx);
    if (proposalId === undefined) return undefined;
    const reason = await ctx.prompts.input(t("action.proposals.reasonPrompt"), { optional: true });
    if (reason === undefined) return undefined;
    return reason.trim() === "" ? { proposalId } : { proposalId, reason: reason.trim() };
  },
  run: (ctx, { proposalId, reason }) =>
    ctx.store.submit({
      type: "proposal.reject",
      payload: reason !== undefined && reason.trim() !== "" ? { proposalId, reason: reason.trim() } : { proposalId },
    }),
});

export const PROPOSALS_ACTIONS = [acceptProposalAction, rejectProposalAction] as const;
