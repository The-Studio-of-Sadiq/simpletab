import {
  GENESIS_HASH,
  verifyChain,
  type ActorType,
  type PublicChainItem,
  type VerifyChainResult,
} from "@simpletab/core/changelog";
import type {
  HostCancelLongResult,
  HostStatus,
  OpUndoInfo,
  ProjectedState,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import * as React from "@theia/core/shared/react";
import { t } from "../i18n";
import { InlineOpError, type InlineOpErrorData } from "./inline-op-error";
import { LockBanner } from "./lock-banner";

export interface ChangelogViewProps {
  state: ProjectedState | null;
  status: HostStatus;
  onGetChangelog: () => Promise<PublicChainItem[]>;
  onGetOpUndoInfo?: () => Promise<OpUndoInfo[]>;
  onUndoOp: (seq: number) => Promise<SubmitResult>;
  onCancelLock?: (lockId: string) => Promise<HostCancelLongResult | void>;
  onOpenSetup?: () => void;
}

function actorTypeLabel(actorType: ActorType): string {
  switch (actorType) {
    case "human":
      return t("changelog.actorTypeHuman");
    case "ai":
      return t("changelog.actorTypeAi");
    case "system":
      return t("changelog.actorTypeSystem");
    case "service":
      return t("changelog.actorTypeService");
  }
}

export const ChangelogView: React.FC<ChangelogViewProps> = ({
  state,
  status,
  onGetChangelog,
  onGetOpUndoInfo,
  onUndoOp,
  onCancelLock,
  onOpenSetup,
}) => {
  const baseId = React.useId();
  const [items, setItems] = React.useState<PublicChainItem[]>([]);
  const [undoInfoBySeq, setUndoInfoBySeq] = React.useState<
    ReadonlyMap<number, OpUndoInfo>
  >(new Map());
  const [loading, setLoading] = React.useState(false);
  const [verifying, setVerifying] = React.useState(false);
  const [verifyResult, setVerifyResult] = React.useState<{
    result: VerifyChainResult;
    count: number;
  } | null>(null);
  const [categoryFilter, setCategoryFilter] = React.useState("");
  const [actorFilter, setActorFilter] = React.useState("");
  const [actorTypeFilter, setActorTypeFilter] = React.useState<"" | ActorType>("");
  const [undoingSeq, setUndoingSeq] = React.useState<number | null>(null);
  const [undoErrors, setUndoErrors] = React.useState<Record<number, InlineOpErrorData>>(
    {},
  );
  const [undoSuccess, setUndoSuccess] = React.useState<string | null>(null);

  const loadData = React.useCallback(async (): Promise<PublicChainItem[]> => {
    if (state === null) {
      setItems([]);
      setUndoInfoBySeq(new Map());
      return [];
    }
    setLoading(true);
    try {
      const [changelogItems, undoInfos] = await Promise.all([
        onGetChangelog(),
        onGetOpUndoInfo ? onGetOpUndoInfo() : Promise.resolve([]),
      ]);
      setItems(changelogItems);
      setUndoInfoBySeq(new Map(undoInfos.map((info) => [info.seq, info])));
      return changelogItems;
    } finally {
      setLoading(false);
    }
  }, [state, onGetChangelog, onGetOpUndoInfo]);

  React.useEffect(() => {
    void loadData();
  }, [loadData, state?.seq, status.headSeq]);

  if (state === null) {
    return (
      <div className="simpletab-page">
        <div className="simpletab-header">
          <h1 className="simpletab-title">{t("changelog.title")}</h1>
        </div>
        <div className="simpletab-alert">
          <p>{t("common.noTournamentPrompt")}</p>
          {onOpenSetup !== undefined ? (
            <button type="button" className="theia-button" onClick={onOpenSetup}>
              {t("common.openSetupButton")}
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  const isHostOwner = state.roleId === "host_owner";
  const headItem = items.length > 0 ? items[items.length - 1] : undefined;
  const headSeq = headItem?.entry.seq ?? 0;
  const headHash = headItem?.entryHash ?? GENESIS_HASH;

  const categories = [...new Set(items.map((item) => item.entry.category))].sort();
  const actors = [...new Set(items.map((item) => item.entry.actorRef))].sort();

  const filteredNewestFirst = [...items]
    .reverse()
    .filter((item) => {
      if (categoryFilter.length > 0 && item.entry.category !== categoryFilter) {
        return false;
      }
      if (actorFilter.length > 0 && item.entry.actorRef !== actorFilter) {
        return false;
      }
      if (actorTypeFilter.length > 0 && item.entry.actorType !== actorTypeFilter) {
        return false;
      }
      return true;
    });

  const handleVerifyChain = async (): Promise<void> => {
    setVerifying(true);
    try {
      const freshItems = await loadData();
      const result = await verifyChain(freshItems);
      setVerifyResult({ result, count: freshItems.length });
    } finally {
      setVerifying(false);
    }
  };

  const handleUndo = async (seq: number): Promise<void> => {
    setUndoSuccess(null);
    setUndoErrors((prev) => {
      if (!(seq in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[seq];
      return next;
    });
    setUndoingSeq(seq);
    try {
      const res = await onUndoOp(seq);
      if (!res.ok) {
        setUndoErrors((prev) => ({
          ...prev,
          [seq]: {
            code: res.code,
            errors: res.errors,
            current: res.current,
            blockingSeqs: res.blockingSeqs,
          },
        }));
        return;
      }
      setUndoSuccess(t("changelog.undoSuccess", { seq, newSeq: res.seq }));
      await loadData();
    } finally {
      setUndoingSeq((prev) => (prev === seq ? null : prev));
    }
  };

  return (
    <div className="simpletab-page">
      <div className="simpletab-header">
        <h1 className="simpletab-title">{t("changelog.title")}</h1>
        <div className="simpletab-actions">
          <button
            type="button"
            className="theia-button"
            disabled={verifying}
            onClick={() => {
              void handleVerifyChain();
            }}
          >
            {verifying ? t("changelog.verifying") : t("changelog.verifyButton")}
          </button>
          <button
            type="button"
            className="theia-button secondary"
            disabled={loading}
            onClick={() => {
              void loadData();
            }}
          >
            {t("changelog.refreshButton")}
          </button>
        </div>
      </div>

      <LockBanner
        locks={status.locks}
        rounds={state.rounds}
        isHostOwner={isHostOwner}
        onCancelLock={onCancelLock}
      />

      <section className="simpletab-section">
        <div className="simpletab-field">
          <strong>{t("changelog.headHashLabel", { seq: headSeq })}</strong>
          <code className="simpletab-hash">{headHash}</code>
        </div>

        {verifyResult !== null ? (
          verifyResult.result.ok ? (
            <div className="simpletab-alert simpletab-alert-success" role="status">
              {t("changelog.verifyOk", {
                count: verifyResult.count,
                head: verifyResult.result.head,
              })}
            </div>
          ) : (
            <div className="simpletab-alert simpletab-alert-error" role="alert">
              {t("changelog.verifyFailed", {
                seq: verifyResult.result.seq,
                reason: verifyResult.result.reason,
              })}
            </div>
          )
        ) : null}

        {undoSuccess !== null ? (
          <div className="simpletab-alert simpletab-alert-success" role="status">
            {undoSuccess}
          </div>
        ) : null}
      </section>

      <section className="simpletab-section">
        <div className="simpletab-filter-bar">
          <div className="simpletab-field">
            <label htmlFor={`${baseId}-cat`}>{t("changelog.filterCategory")}</label>
            <select
              id={`${baseId}-cat`}
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
            >
              <option value="">{t("changelog.filterAll")}</option>
              {categories.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
          </div>

          <div className="simpletab-field">
            <label htmlFor={`${baseId}-actor`}>{t("changelog.filterActor")}</label>
            <select
              id={`${baseId}-actor`}
              value={actorFilter}
              onChange={(e) => setActorFilter(e.target.value)}
            >
              <option value="">{t("changelog.filterAll")}</option>
              {actors.map((actorRef) => (
                <option key={actorRef} value={actorRef}>
                  {actorRef}
                </option>
              ))}
            </select>
          </div>

          <div className="simpletab-field">
            <label htmlFor={`${baseId}-atype`}>
              {t("changelog.filterActorType")}
            </label>
            <select
              id={`${baseId}-atype`}
              value={actorTypeFilter}
              onChange={(e) => setActorTypeFilter(e.target.value as "" | ActorType)}
            >
              <option value="">{t("changelog.filterAll")}</option>
              <option value="human">{t("changelog.actorTypeHuman")}</option>
              <option value="ai">{t("changelog.actorTypeAi")}</option>
              <option value="system">{t("changelog.actorTypeSystem")}</option>
              <option value="service">{t("changelog.actorTypeService")}</option>
            </select>
          </div>
        </div>

        {filteredNewestFirst.length === 0 ? (
          <p className="simpletab-empty">{t("changelog.empty")}</p>
        ) : (
          <div className="simpletab-table-wrap">
            <table className="simpletab-table">
              <caption>{t("changelog.tableCaption")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("changelog.colSeq")}</th>
                  <th scope="col">{t("changelog.colTime")}</th>
                  <th scope="col">{t("changelog.colActor")}</th>
                  <th scope="col">{t("changelog.colOp")}</th>
                  <th scope="col">{t("changelog.colSummary")}</th>
                  <th scope="col">{t("changelog.colVisibility")}</th>
                  <th scope="col">{t("changelog.colActions")}</th>
                </tr>
              </thead>
              <tbody>
                {filteredNewestFirst.map((item) => {
                  const { entry } = item;
                  const info = undoInfoBySeq.get(entry.seq);
                  const rowError = undoErrors[entry.seq];
                  const isPublic = entry.visibility === "public";
                  const notUndoable = info !== undefined && !info.hasInverse;

                  return (
                    <tr key={entry.seq}>
                      <td>
                        <div>#{entry.seq}</div>
                        {info?.inverseOf !== null && info?.inverseOf !== undefined ? (
                          <span className="simpletab-badge simpletab-badge-match">
                            {t("changelog.inverseOfBadge", { seq: info.inverseOf })}
                          </span>
                        ) : null}
                      </td>
                      <td>{entry.ts}</td>
                      <td>
                        <span>{entry.actorRef} </span>
                        <span
                          className={`simpletab-badge ${
                            entry.actorType === "ai" ? "simpletab-badge-ai" : ""
                          }`}
                        >
                          {actorTypeLabel(entry.actorType)}
                        </span>
                      </td>
                      <td>
                        <div>
                          <code className="simpletab-code">{entry.opType}</code>
                        </div>
                        <div className="simpletab-hint">{entry.category}</div>
                      </td>
                      <td>
                        <div>{entry.summary}</div>
                        {info && info.writes.length > 0 ? (
                          <div className="simpletab-hint">
                            {t("changelog.writesHint", {
                              writes: info.writes.join(", "),
                            })}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <span
                          className={`simpletab-badge ${
                            isPublic ? "simpletab-badge-add" : ""
                          }`}
                        >
                          {isPublic
                            ? t("changelog.visibilityPublic")
                            : t("changelog.visibilityPrivate")}
                        </span>
                      </td>
                      <td>
                        {notUndoable ? (
                          <span className="simpletab-hint">
                            {t("changelog.notUndoable")}
                          </span>
                        ) : (
                          <div>
                            <button
                              type="button"
                              className="theia-button secondary simpletab-compact-btn"
                              disabled={undoingSeq === entry.seq}
                              aria-label={`${t("changelog.undoButton")} #${entry.seq}`}
                              onClick={() => {
                                void handleUndo(entry.seq);
                              }}
                            >
                              {undoingSeq === entry.seq
                                ? t("changelog.undoing")
                                : t("changelog.undoButton")}
                            </button>
                            {info && info.blockingSeqs.length > 0 ? (
                              <div className="simpletab-hint">
                                {t("changelog.blockedHint", {
                                  seqs: info.blockingSeqs
                                    .map((s) => `#${s}`)
                                    .join(", "),
                                })}
                              </div>
                            ) : null}
                            {rowError !== undefined ? (
                              <InlineOpError
                                error={rowError}
                                onDismiss={() => {
                                  setUndoErrors((prev) => {
                                    const next = { ...prev };
                                    delete next[entry.seq];
                                    return next;
                                  });
                                }}
                              />
                            ) : null}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};
