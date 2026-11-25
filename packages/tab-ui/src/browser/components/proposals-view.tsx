import type { ProposalRecord } from "@simpletab/core/ops";
import type {
  ProjectedState,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import * as React from "@theia/core/shared/react";
import { t } from "../i18n";
import { InlineOpError, type InlineOpErrorData } from "./inline-op-error";

export interface ProposalDecision {
  kind: "accept" | "reject";
  proposalId: string;
  reason?: string;
}

export interface ProposalsViewProps {
  state: ProjectedState | null;
  onDecide: (decision: ProposalDecision) => Promise<SubmitResult>;
}

function instantOf(iso: string | undefined): number {
  if (iso === undefined) {
    return 0;
  }
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

function pendingProposals(state: ProjectedState): ProposalRecord[] {
  return (state.proposals ?? [])
    .filter((proposal) => proposal.status === "pending")
    .sort((a, b) => instantOf(a.createdAt) - instantOf(b.createdAt));
}

function decidedProposals(state: ProjectedState): ProposalRecord[] {
  return (state.proposals ?? [])
    .filter((proposal) => proposal.status !== "pending")
    .sort(
      (a, b) =>
        instantOf(b.resolvedAt ?? b.createdAt) -
        instantOf(a.resolvedAt ?? a.createdAt),
    );
}

function failureOf(result: SubmitResult): InlineOpErrorData | null {
  if (result.ok) {
    return null;
  }
  return {
    code: result.code,
    errors: result.errors,
    current: result.current,
    blockingSeqs: result.blockingSeqs,
  };
}

/**
 * The Proposals page (design section 6): an AI device cannot change the tournament itself, so each
 * change it suggests waits here until a person accepts (applied) or rejects it (with a reason).
 */
export const ProposalsView: React.FC<ProposalsViewProps> = ({
  state,
  onDecide,
}) => {
  const baseId = React.useId();
  const [reasons, setReasons] = React.useState<Record<string, string>>({});
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [errors, setErrors] = React.useState<Record<string, InlineOpErrorData>>(
    {},
  );
  const [localErrors, setLocalErrors] = React.useState<
    Record<string, string>
  >({});

  if (state === null) {
    return <p className="simpletab-hint">{t("proposals.noTournament")}</p>;
  }

  const canDecide =
    state.roleId !== "ai" && (state.permissions?.length ?? 0) > 0;
  const pending = pendingProposals(state);
  const decided = decidedProposals(state);

  const decide = async (
    proposal: ProposalRecord,
    kind: "accept" | "reject",
  ): Promise<void> => {
    const reason = (reasons[proposal.id] ?? "").trim();
    setBusyId(proposal.id);
    setErrors((current) => {
      const next = { ...current };
      delete next[proposal.id];
      return next;
    });
    setLocalErrors((current) => {
      const next = { ...current };
      delete next[proposal.id];
      return next;
    });
    try {
      const result = await onDecide(
        kind === "reject"
          ? {
              kind,
              proposalId: proposal.id,
              ...(reason.length > 0 ? { reason } : {}),
            }
          : { kind, proposalId: proposal.id },
      );
      const failure = failureOf(result);
      if (failure !== null) {
        setErrors((current) => ({ ...current, [proposal.id]: failure }));
      } else if (kind === "reject") {
        setReasons((current) => {
          const next = { ...current };
          delete next[proposal.id];
          return next;
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLocalErrors((current) => ({ ...current, [proposal.id]: message }));
    } finally {
      setBusyId(null);
    }
  };

  const renderDecisionControls = (
    proposal: ProposalRecord,
  ): React.ReactNode => {
    const busy = busyId === proposal.id;
    const error = errors[proposal.id];
    const localError = localErrors[proposal.id];
    const reasonId = `${baseId}-reason-${proposal.id}`;
    return (
      <>
        <div className="simpletab-field">
          <label htmlFor={reasonId}>{t("proposals.reasonLabel")}</label>
          <input
            id={reasonId}
            type="text"
            value={reasons[proposal.id] ?? ""}
            disabled={busy}
            onChange={(e) => {
              const value = e.target.value;
              setReasons((current) => ({ ...current, [proposal.id]: value }));
            }}
          />
        </div>
        <div className="simpletab-actions">
          <button
            type="button"
            className="theia-button"
            disabled={busy}
            onClick={() => {
              void decide(proposal, "accept");
            }}
          >
            {t("proposals.accept")}
          </button>
          <button
            type="button"
            className="theia-button secondary"
            disabled={busy}
            onClick={() => {
              void decide(proposal, "reject");
            }}
          >
            {t("proposals.reject")}
          </button>
        </div>
        {error !== undefined ? (
          <InlineOpError
            error={error}
            onDismiss={() => {
              setErrors((current) => {
                const next = { ...current };
                delete next[proposal.id];
                return next;
              });
            }}
          />
        ) : null}
        {localError !== undefined ? (
          <p className="simpletab-alert simpletab-alert-error" role="alert">
            {t("proposals.decideFailed", { message: localError })}
          </p>
        ) : null}
      </>
    );
  };

  return (
    <div className="simpletab-page">
      <h2 className="simpletab-title">{t("proposals.title")}</h2>
      <p className="simpletab-hint">{t("proposals.hint")}</p>

      {canDecide ? null : (
        <p className="simpletab-hint">{t("proposals.noPermission")}</p>
      )}

      <section
        className="simpletab-section"
        aria-labelledby={`${baseId}-pending`}
      >
        <h3 id={`${baseId}-pending`} className="simpletab-subtitle">
          {t("proposals.pendingTitle")}
        </h3>
        {pending.length === 0 ? (
          <p className="simpletab-hint">{t("proposals.pendingEmpty")}</p>
        ) : (
          <ul>
            {pending.map((proposal) => (
              <li key={proposal.id} className="simpletab-card">
                <p>{t("proposals.changeType", { type: proposal.op.type })}</p>
                <p>
                  {t("proposals.proposedBy", {
                    role: proposal.proposedBy.role.name,
                    ref: proposal.proposedBy.ref,
                  })}
                </p>
                <p>
                  {t("proposals.proposedAt", {
                    time: new Date(proposal.createdAt).toLocaleString(),
                  })}
                </p>
                <details>
                  <summary>{t("proposals.details")}</summary>
                  <pre>{JSON.stringify(proposal.op.payload, null, 2)}</pre>
                </details>
                {canDecide ? (
                  renderDecisionControls(proposal)
                ) : (
                  <p className="simpletab-hint">
                    {t("proposals.cannotDecide")}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        className="simpletab-section"
        aria-labelledby={`${baseId}-decided`}
      >
        <h3 id={`${baseId}-decided`} className="simpletab-subtitle">
          {t("proposals.decidedTitle")}
        </h3>
        {decided.length === 0 ? (
          <p className="simpletab-hint">{t("proposals.decidedEmpty")}</p>
        ) : (
          <ul>
            {decided.map((proposal) => (
              <li key={proposal.id} className="simpletab-card">
                <p>{t("proposals.changeType", { type: proposal.op.type })}</p>
                <p>
                  <strong>
                    {proposal.status === "accepted"
                      ? t("proposals.statusAccepted")
                      : t("proposals.statusRejected")}
                  </strong>
                </p>
                {proposal.resolvedBy !== undefined ? (
                  <p>
                    {t("proposals.decidedBy", { by: proposal.resolvedBy })}
                  </p>
                ) : null}
                {proposal.reason !== undefined &&
                proposal.reason.trim().length > 0 ? (
                  <p>{t("proposals.reasonLine", { reason: proposal.reason })}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};
