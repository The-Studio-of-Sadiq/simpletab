import type { LinkRole } from "@simpletab/core/crypto";
import type { HostStatus, ProjectedState } from "@simpletab/host/lib/common/host-protocol";
import * as React from "@theia/core/shared/react";
import type { ActionRunner } from "../actions/action";
import {
  buildRegenerateLinksRequest,
  generateLinksAction,
  regenerateLinksAction,
} from "../actions/links-actions";
import { openCredentialsPageAction } from "../actions/navigation-actions";
import { openSetupAction } from "../actions/releases-actions";
import { t } from "../i18n";
import { stateHasPermission } from "../lib/permissions";
import {
  collectParticipantTargets,
  isValidCdnHost,
  renderQrSvgData,
  resolveBallotsOrigin,
  resolveParticipantLinks,
  type ResolvedParticipantLink,
} from "../lib/links-generator";
import { InlineOpError, type InlineOpErrorData } from "./inline-op-error";

export interface LinksViewProps {
  state: ProjectedState | null;
  status: HostStatus;
  run: ActionRunner;
}

function roleLabel(role: LinkRole): string {
  switch (role) {
    case "adjudicator":
      return t("links.roleAdjudicator");
    case "team":
      return t("links.roleTeam");
    case "speaker":
      return t("links.roleSpeaker");
  }
}

export const LinksView: React.FC<LinksViewProps> = ({
  state,
  status,
  run,
}) => {
  const [busy, setBusy] = React.useState(false);
  const [showQrSlips, setShowQrSlips] = React.useState(false);
  const [roleFilter, setRoleFilter] = React.useState<"all" | LinkRole>("all");
  const [copiedId, setCopiedId] = React.useState<string | null>(null);
  const [feedback, setFeedback] = React.useState<string | null>(null);
  const [errorData, setErrorData] = React.useState<InlineOpErrorData | null>(
    null,
  );
  const [localError, setLocalError] = React.useState<string | null>(null);

  if (state === null) {
    return (
      <div className="simpletab-page">
        <div className="simpletab-header">
          <h2 className="simpletab-title">{t("links.title")}</h2>
        </div>
        <div className="simpletab-alert">
          <p>{t("common.noTournamentPrompt")}</p>
          <button
            type="button"
            className="theia-button"
            data-action={openSetupAction.id}
            onClick={() => {
              void run(openSetupAction, {});
            }}
          >
            {t("common.openSetupButton")}
          </button>
        </div>
      </div>
    );
  }

  if (!stateHasPermission(state, "links.manage")) {
    return (
      <div className="simpletab-page">
        <div className="simpletab-header">
          <h2 className="simpletab-title">{t("links.title")}</h2>
        </div>
        <div className="simpletab-alert simpletab-alert-error" role="alert">
          <strong>{t("links.restrictedTitle")}: </strong>
          {t("links.restrictedBody")}
        </div>
      </div>
    );
  }

  const online = status.onlineSettings;
  const cdnHost = online?.cdnHost?.trim() ?? "";
  const cdnValid = isValidCdnHost(cdnHost);
  const ballotsOrigin = resolveBallotsOrigin(online?.ballotsOrigin);

  const targets = collectParticipantTargets(state);
  const resolvedLinks = cdnValid
    ? resolveParticipantLinks(state, cdnHost, ballotsOrigin)
    : [];
  const existingKeys = new Set(
    (state.links ?? []).map(
      (link) => `${link.lookupId[0] ?? ""}:${link.entityId}`,
    ),
  );
  const missingCount = targets.filter((target) => {
    const letter =
      target.role === "adjudicator" ? "a" : target.role === "team" ? "t" : "s";
    return !existingKeys.has(`${letter}:${target.entityId}`);
  }).length;

  const filteredLinks: ResolvedParticipantLink[] =
    roleFilter === "all"
      ? resolvedLinks
      : resolvedLinks.filter((entry) => entry.role === roleFilter);

  const handleGenerate = async (force: boolean): Promise<void> => {
    if (!cdnValid) {
      setLocalError(t("links.missingCdnHost"));
      return;
    }
    setBusy(true);
    setFeedback(null);
    setLocalError(null);
    setErrorData(null);
    try {
      const args = { cdnHost, ballotsOrigin, force };
      const request = buildRegenerateLinksRequest(state, args);
      if (request.payload.links.length === 0) {
        setFeedback(t("links.noneMissing"));
        return;
      }
      const result = await run(force ? regenerateLinksAction : generateLinksAction, args);
      if (!result.ok) {
        setErrorData({
          code: result.code,
          errors: result.errors,
          ...(result.current !== undefined ? { current: result.current } : {}),
          ...(result.blockingSeqs !== undefined
            ? { blockingSeqs: result.blockingSeqs }
            : {}),
        });
        return;
      }
      setFeedback(
        t("links.generatedCount", { count: request.payload.links.length }),
      );
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async (link: ResolvedParticipantLink): Promise<void> => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(link.url);
      }
      setCopiedId(link.lookupId);
    } catch {
      setCopiedId(null);
    }
  };

  return (
    <div className="simpletab-page">
      <div className="simpletab-header">
        <div>
          <h2 className="simpletab-title">{t("links.title")}</h2>
          <p className="simpletab-hint">{t("links.hint")}</p>
        </div>
        <div className="simpletab-actions">
          <button
            type="button"
            className="theia-button"
            data-action={generateLinksAction.id}
            disabled={busy || !cdnValid || targets.length === 0 || (!missingCount && (state.links?.length ?? 0) > 0)}
            onClick={() => {
              void handleGenerate(false);
            }}
          >
            {t("links.generateAction")}
          </button>
          {(state.links?.length ?? 0) > 0 ? (
            <button
              type="button"
              className="theia-button secondary"
              data-action={regenerateLinksAction.id}
              disabled={busy || !cdnValid || targets.length === 0}
              onClick={() => {
                void handleGenerate(true);
              }}
            >
              {t("links.regenerateAllAction")}
            </button>
          ) : null}
          {resolvedLinks.length > 0 ? (
            <>
              <button
                type="button"
                className="theia-button secondary"
                data-view-only
                onClick={() => {
                  setShowQrSlips((prev) => !prev);
                }}
              >
                {showQrSlips
                  ? t("links.showTableAction")
                  : t("links.showQrSlipsAction")}
              </button>
              {showQrSlips ? (
                <button
                  type="button"
                  className="theia-button secondary"
                  data-view-only
                  onClick={() => {
                    window.print();
                  }}
                >
                  {t("links.printSlipsAction")}
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      {!cdnValid ? (
        <div className="simpletab-alert simpletab-alert-warning" role="note">
          <span>{t("links.missingCdnHost")}</span>
          {" "}
          <button
            type="button"
            className="theia-button secondary"
            data-action={openCredentialsPageAction.id}
            onClick={() => {
              void run(openCredentialsPageAction, {});
            }}
          >
            {t("links.openCredentialsAction")}
          </button>
        </div>
      ) : (
        <div className="simpletab-hint" style={{ marginBottom: "10px" }}>
          {t("links.configuredHosts", { cdnHost, ballotsOrigin })}
        </div>
      )}

      {localError ? (
        <div className="simpletab-alert simpletab-alert-error" role="alert">
          {localError}
        </div>
      ) : null}

      {feedback ? (
        <div className="simpletab-alert simpletab-alert-success" role="status">
          {feedback}
        </div>
      ) : null}

      {errorData ? (
        <InlineOpError
          error={errorData}
          onDismiss={() => {
            setErrorData(null);
          }}
        />
      ) : null}

      {targets.length === 0 ? (
        <div className="simpletab-alert">{t("links.noParticipants")}</div>
      ) : resolvedLinks.length === 0 && cdnValid ? (
        <div className="simpletab-alert">{t("links.emptyState")}</div>
      ) : resolvedLinks.length > 0 ? (
        <>
          <div className="simpletab-filter-bar">
            <label htmlFor="simpletab-links-role-filter">
              {t("links.filterRole")}
            </label>
            <select
              id="simpletab-links-role-filter"
              value={roleFilter}
              onChange={(e) => {
                setRoleFilter(e.target.value as "all" | LinkRole);
              }}
            >
              <option value="all">{t("links.filterAll")}</option>
              <option value="adjudicator">{t("links.roleAdjudicator")}</option>
              <option value="team">{t("links.roleTeam")}</option>
              <option value="speaker">{t("links.roleSpeaker")}</option>
            </select>
          </div>

          {showQrSlips ? (
            <div className="simpletab-qr-grid">
              {filteredLinks.map((entry) => {
                const svg = renderQrSvgData(entry.url);
                return (
                  <article key={entry.lookupId} className="simpletab-qr-slip">
                    <div className="simpletab-qr-slip-meta">
                      <strong>{entry.displayName}</strong>
                      <span className="simpletab-badge">
                        {roleLabel(entry.role)}
                      </span>
                      {entry.detail ? (
                        <div className="simpletab-hint">{entry.detail}</div>
                      ) : null}
                    </div>
                    <svg
                      className="simpletab-qr-svg"
                      viewBox={`0 0 ${svg.size} ${svg.size}`}
                      role="img"
                      aria-label={t("links.qrAriaLabel", {
                        name: entry.displayName,
                      })}
                    >
                      <rect
                        width={svg.size}
                        height={svg.size}
                        fill="#ffffff"
                      />
                      <path d={svg.path} fill="#000000" />
                    </svg>
                    <div className="simpletab-code simpletab-qr-url">
                      {entry.url}
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="simpletab-table-wrap">
              <table className="simpletab-table">
                <thead>
                  <tr>
                    <th>{t("links.colParticipant")}</th>
                    <th>{t("links.colRole")}</th>
                    <th>{t("links.colDetail")}</th>
                    <th>{t("links.colUrl")}</th>
                    <th>{t("links.colActions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLinks.map((entry) => (
                    <tr key={entry.lookupId}>
                      <td>{entry.displayName}</td>
                      <td>{roleLabel(entry.role)}</td>
                      <td>{entry.detail || t("common.none")}</td>
                      <td className="simpletab-code">{entry.url}</td>
                      <td>
                        <button
                          type="button"
                          className="theia-button secondary"
                          data-view-only
                          onClick={() => {
                            void handleCopy(entry);
                          }}
                        >
                          {copiedId === entry.lookupId
                            ? t("links.copied")
                            : t("links.copyAction")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
};
