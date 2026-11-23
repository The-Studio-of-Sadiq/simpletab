import {
  roundBreakLiveness,
  type LivenessStatus,
  type RoundLiveness,
} from "@simpletab/core/lib/breakqual/liveness";
import {
  effectiveSpeakerCategories,
  speakerRowsInCategory,
} from "@simpletab/core/lib/speakerCategories";
import { calculateStandingsAsOf } from "@simpletab/core/lib/standings/asOfRound";
import { breakCategoryStandings } from "@simpletab/core/lib/standings/categoryStandings";
import {
  formatMetricValue,
  SPEAKER_METRIC_LABELS,
  TEAM_METRIC_LABELS,
} from "@simpletab/core/lib/standings/metrics";
import {
  resolveSpeakerExtra,
  resolveSpeakerPrecedence,
  resolveTeamExtra,
  resolveTeamPrecedence,
  teamPrecedenceValues,
} from "@simpletab/core/lib/standings/precedence";
import type {
  MetricValue,
  SpeakerMetricId,
  SpeakerStandingRow,
  TeamMetricId,
  TeamStandingRow,
} from "@simpletab/core/types";
import type {
  HostCancelLongResult,
  HostStatus,
  ProjectedState,
} from "@simpletab/host/lib/common/host-protocol";
import * as React from "@theia/core/shared/react";
import { t } from "../i18n";
import { stateHasPermission } from "../lib/permissions";
import { LockBanner } from "./lock-banner";

export interface StandingsViewProps {
  state: ProjectedState | null;
  status: HostStatus;
  onCancelLock?: (lockId: string) => Promise<HostCancelLongResult | void>;
  onOpenSetup?: () => void;
}

type StandingsTabId =
  | "teams"
  | "speakers"
  | "replies"
  | `break:${string}`
  | `speaker:${string}`;

function countRanks(rows: readonly { rank: number; ineligible?: boolean }[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const row of rows) {
    if (row.ineligible || row.rank <= 0) {
      continue;
    }
    counts.set(row.rank, (counts.get(row.rank) ?? 0) + 1);
  }
  return counts;
}

function formatSharedRank(
  rank: number,
  rankCounts: ReadonlyMap<number, number>,
  ineligible?: boolean,
): string {
  if (ineligible) {
    return t("standings.ineligible");
  }
  if (rank <= 0) {
    return "—";
  }
  return (rankCounts.get(rank) ?? 0) > 1 ? `=${rank}` : String(rank);
}

function livenessLabel(statusValue: LivenessStatus): string {
  switch (statusValue) {
    case "safe":
      return t("standings.livenessSafe");
    case "live":
      return t("standings.livenessLive");
    case "dead":
      return t("standings.livenessDead");
  }
}

function livenessBadgeClass(statusValue: LivenessStatus): string {
  switch (statusValue) {
    case "safe":
      return "simpletab-badge-add";
    case "live":
      return "simpletab-badge-match";
    case "dead":
      return "simpletab-badge-error";
  }
}

interface TeamColumnSpec {
  key: string;
  label: string;
  read: (row: TeamStandingRow) => MetricValue;
}

function buildTeamColumns(
  precedence: readonly TeamMetricId[],
  extra: readonly TeamMetricId[],
): TeamColumnSpec[] {
  const columns: TeamColumnSpec[] = precedence.map((metric, idx) => ({
    key: `p-${metric}-${idx}`,
    label: TEAM_METRIC_LABELS[metric],
    read: (row) => teamPrecedenceValues(row, [...precedence])[idx],
  }));
  const seen = new Set<TeamMetricId>(precedence);
  for (const metric of extra) {
    if (seen.has(metric)) {
      continue;
    }
    seen.add(metric);
    columns.push({
      key: `e-${metric}`,
      label: TEAM_METRIC_LABELS[metric],
      read: (row) => row.metrics[metric],
    });
  }
  return columns;
}

interface SpeakerColumnSpec {
  key: string;
  label: string;
  read: (row: SpeakerStandingRow) => MetricValue;
}

function buildSpeakerColumns(
  precedence: readonly SpeakerMetricId[],
  extra: readonly SpeakerMetricId[],
): SpeakerColumnSpec[] {
  const columns: SpeakerColumnSpec[] = precedence.map((metric, idx) => ({
    key: `p-${metric}-${idx}`,
    label: SPEAKER_METRIC_LABELS[metric],
    read: (row) => row.metrics[metric],
  }));
  const seen = new Set<SpeakerMetricId>(precedence);
  for (const metric of extra) {
    if (seen.has(metric)) {
      continue;
    }
    seen.add(metric);
    columns.push({
      key: `e-${metric}`,
      label: SPEAKER_METRIC_LABELS[metric],
      read: (row) => row.metrics[metric],
    });
  }
  return columns;
}

export const StandingsView: React.FC<StandingsViewProps> = ({
  state,
  status,
  onCancelLock,
  onOpenSetup,
}) => {
  const baseId = React.useId();
  const [asOfRoundId, setAsOfRoundId] = React.useState("");
  const [activeTab, setActiveTab] = React.useState<StandingsTabId>("teams");

  const prelimRounds = React.useMemo(() => {
    if (state === null) {
      return [];
    }
    return state.rounds
      .filter((round) => round.stage === "preliminary" && round.cancelled !== true)
      .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
  }, [state]);

  React.useEffect(() => {
    if (asOfRoundId.length > 0 && !prelimRounds.some((round) => round.id === asOfRoundId)) {
      setAsOfRoundId("");
    }
  }, [asOfRoundId, prelimRounds]);

  const speakerCategories = React.useMemo(() => {
    if (state === null) {
      return [];
    }
    return effectiveSpeakerCategories(
      state.tournament.preferences.speakerCategories,
      state.teams,
    );
  }, [state]);

  const sortedBreakCategories = React.useMemo(() => {
    if (state === null) {
      return [];
    }
    return [...state.breakCategories].sort(
      (left, right) => left.seq - right.seq || left.name.localeCompare(right.name),
    );
  }, [state]);

  const standings = React.useMemo(() => {
    if (state === null) {
      return null;
    }
    return calculateStandingsAsOf(
      state.tournament,
      state.rounds,
      state.teams,
      state.debates,
      state.ballots,
      asOfRoundId.length > 0 ? asOfRoundId : null,
    );
  }, [state, asOfRoundId]);

  const hasRepliesTab = React.useMemo(() => {
    if (state === null || standings === null) {
      return false;
    }
    const isBp = state.tournament.format === "bp";
    return (
      (!isBp && state.tournament.preferences.replyScoresEnabled === true) ||
      standings.replies.length > 0
    );
  }, [state, standings]);

  const availableTabs = React.useMemo(() => {
    const tabs: { id: StandingsTabId; label: string }[] = [
      { id: "teams", label: t("standings.tabTeams") },
      { id: "speakers", label: t("standings.tabSpeakers") },
    ];
    if (hasRepliesTab) {
      tabs.push({ id: "replies", label: t("standings.tabReplies") });
    }
    for (const cat of sortedBreakCategories) {
      tabs.push({
        id: `break:${cat.id}`,
        label: t("standings.tabBreakCategory", { name: cat.name }),
      });
    }
    for (const cat of speakerCategories) {
      tabs.push({
        id: `speaker:${cat.id}`,
        label: t("standings.tabSpeakerCategory", { name: cat.name }),
      });
    }
    return tabs;
  }, [hasRepliesTab, sortedBreakCategories, speakerCategories]);

  React.useEffect(() => {
    if (!availableTabs.some((tab) => tab.id === activeTab)) {
      setActiveTab("teams");
    }
  }, [availableTabs, activeTab]);

  const liveness: RoundLiveness | null = React.useMemo(() => {
    if (state === null || state.breakCategories.length === 0) {
      return null;
    }
    const source = {
      tournament: state.tournament,
      rounds: state.rounds,
      teams: state.teams,
      debates: state.debates,
      ballots: state.ballots,
      breakCategories: state.breakCategories,
    };
    if (asOfRoundId.length > 0) {
      const selected = prelimRounds.find((round) => round.id === asOfRoundId);
      const nextPrelim = selected
        ? prelimRounds.find((round) => round.seq > selected.seq)
        : undefined;
      return nextPrelim ? roundBreakLiveness(source, nextPrelim) : null;
    }
    return roundBreakLiveness(source);
  }, [state, asOfRoundId, prelimRounds]);

  if (state === null || standings === null) {
    return (
      <div className="simpletab-page">
        <div className="simpletab-header">
          <h1 className="simpletab-title">{t("standings.title")}</h1>
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
  const canView = stateHasPermission(state, "standings.view");
  const teamPrecedence = resolveTeamPrecedence(
    state.tournament.format,
    state.tournament.preferences,
  );
  const teamExtra = resolveTeamExtra(state.tournament.preferences);
  const teamColumns = buildTeamColumns(teamPrecedence, teamExtra);

  const speakerPrecedence = resolveSpeakerPrecedence(state.tournament.preferences);
  const speakerExtra = resolveSpeakerExtra(state.tournament.preferences);
  const speakerColumns = buildSpeakerColumns(speakerPrecedence, speakerExtra);

  const teamsById = new Map(state.teams.map((team) => [team.id, team]));
  const breakCategoriesById = new Map(
    sortedBreakCategories.map((cat) => [cat.id, cat]),
  );

  const renderLivenessCell = (
    teamId: string,
    onlyCategoryId?: string,
  ): React.ReactNode => {
    if (liveness === null) {
      return null;
    }
    const entries = (liveness.byTeam.get(teamId) ?? []).filter(
      (entry) => onlyCategoryId === undefined || entry.categoryId === onlyCategoryId,
    );
    if (entries.length === 0) {
      return "—";
    }
    return entries.map((entry) => {
      const statusText = livenessLabel(entry.status);
      const catName = breakCategoriesById.get(entry.categoryId)?.name ?? entry.categoryId;
      const text =
        onlyCategoryId !== undefined || entries.length === 1
          ? statusText
          : t("standings.livenessNamed", { category: catName, status: statusText });
      return (
        <span
          key={entry.categoryId}
          className={`simpletab-badge ${livenessBadgeClass(entry.status)}`}
        >
          {text}
        </span>
      );
    });
  };

  const renderTeamTable = (
    rows: TeamStandingRow[],
    caption: string,
    emptyMessage: string,
    onlyCategoryId?: string,
  ): React.ReactNode => {
    if (rows.length === 0) {
      return <p className="simpletab-empty">{emptyMessage}</p>;
    }
    const rankCounts = countRanks(rows);
    const showInstitution = rows.some((row) => (row.institutionCode?.length ?? 0) > 0);
    const showLiveness = liveness !== null;

    return (
      <>
        <div className="simpletab-hint">
          {t("standings.precedenceHint", {
            metrics: teamPrecedence.map((m) => TEAM_METRIC_LABELS[m]).join(" → "),
          })}
        </div>
        <div className="simpletab-table-wrap">
          <table className="simpletab-table">
            <caption>{caption}</caption>
            <thead>
              <tr>
                <th scope="col">{t("standings.colRank")}</th>
                <th scope="col">{t("standings.colTeam")}</th>
                {showInstitution ? (
                  <th scope="col">{t("standings.colInstitution")}</th>
                ) : null}
                {teamColumns.map((col) => (
                  <th key={col.key} scope="col">
                    {col.label}
                  </th>
                ))}
                {showLiveness ? (
                  <th scope="col">{t("standings.colLiveness")}</th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.teamId}>
                  <td>{formatSharedRank(row.rank, rankCounts)}</td>
                  <td>{row.teamName}</td>
                  {showInstitution ? <td>{row.institutionCode || "—"}</td> : null}
                  {teamColumns.map((col) => (
                    <td key={col.key}>{formatMetricValue(col.read(row))}</td>
                  ))}
                  {showLiveness ? (
                    <td>{renderLivenessCell(row.teamId, onlyCategoryId)}</td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  };

  const renderSpeakerTable = (
    rows: SpeakerStandingRow[],
    caption: string,
    emptyMessage: string,
    isReplies: boolean,
  ): React.ReactNode => {
    if (rows.length === 0) {
      return <p className="simpletab-empty">{emptyMessage}</p>;
    }
    const rankCounts = countRanks(rows);
    const cols: SpeakerColumnSpec[] = isReplies
      ? [
          {
            key: "reply_avg",
            label: SPEAKER_METRIC_LABELS.reply_avg,
            read: (row) => row.metrics.reply_avg,
          },
          {
            key: "reply_sum",
            label: SPEAKER_METRIC_LABELS.reply_sum,
            read: (row) => row.metrics.reply_sum,
          },
          {
            key: "reply_count",
            label: SPEAKER_METRIC_LABELS.reply_count,
            read: (row) => row.metrics.reply_count,
          },
        ]
      : speakerColumns;

    return (
      <>
        {!isReplies ? (
          <div className="simpletab-hint">
            {t("standings.precedenceHint", {
              metrics: speakerPrecedence.map((m) => SPEAKER_METRIC_LABELS[m]).join(" → "),
            })}
          </div>
        ) : null}
        <div className="simpletab-table-wrap">
          <table className="simpletab-table">
            <caption>{caption}</caption>
            <thead>
              <tr>
                <th scope="col">{t("standings.colRank")}</th>
                <th scope="col">{t("standings.colSpeaker")}</th>
                <th scope="col">{t("standings.colTeam")}</th>
                {cols.map((col) => (
                  <th key={col.key} scope="col">
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.speakerId}>
                  <td>{formatSharedRank(row.rank, rankCounts, row.ineligible)}</td>
                  <td>{row.speakerName}</td>
                  <td>{row.teamName || "—"}</td>
                  {cols.map((col) => (
                    <td key={col.key}>{formatMetricValue(col.read(row))}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  };

  let panelContent: React.ReactNode = null;
  if (activeTab === "teams") {
    panelContent = renderTeamTable(
      standings.teams,
      t("standings.teamsCaption"),
      t("standings.emptyTeams"),
    );
  } else if (activeTab === "speakers") {
    panelContent = renderSpeakerTable(
      standings.speakers,
      t("standings.speakersCaption"),
      t("standings.emptySpeakers"),
      false,
    );
  } else if (activeTab === "replies") {
    panelContent = renderSpeakerTable(
      standings.replies,
      t("standings.repliesCaption"),
      t("standings.emptyReplies"),
      true,
    );
  } else if (activeTab.startsWith("break:")) {
    const catId = activeTab.slice("break:".length);
    const cat = breakCategoriesById.get(catId);
    if (cat !== undefined) {
      const catRows = breakCategoryStandings(
        standings.teams,
        cat,
        teamsById,
        teamPrecedence,
      );
      panelContent = renderTeamTable(
        catRows,
        t("standings.breakCategoryCaption", { name: cat.name }),
        t("standings.emptyTeams"),
        cat.id,
      );
    }
  } else if (activeTab.startsWith("speaker:")) {
    const catId = activeTab.slice("speaker:".length);
    const cat = speakerCategories.find((item) => item.id === catId);
    if (cat !== undefined) {
      const catRows = speakerRowsInCategory(
        standings.speakers,
        cat.id,
        speakerCategories,
      );
      panelContent = renderSpeakerTable(
        catRows,
        t("standings.speakerCategoryCaption", { name: cat.name }),
        t("standings.emptySpeakers"),
        false,
      );
    }
  }

  return (
    <div className="simpletab-page">
      <div className="simpletab-header">
        <h1 className="simpletab-title">{t("standings.title")}</h1>
        <div className="simpletab-round-picker">
          <label htmlFor={`${baseId}-as-of`}>{t("standings.asOfLabel")}</label>
          <select
            id={`${baseId}-as-of`}
            value={asOfRoundId}
            onChange={(e) => setAsOfRoundId(e.target.value)}
          >
            <option value="">{t("standings.asOfAll")}</option>
            {prelimRounds.map((round) => (
              <option key={round.id} value={round.id}>
                {round.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <LockBanner
        locks={status.locks}
        rounds={state.rounds}
        isHostOwner={isHostOwner}
        onCancelLock={onCancelLock}
      />

      {!canView ? (
        <div className="simpletab-alert" role="status">
          {t("standings.noPermission")}
        </div>
      ) : (
        <>
          <div
            className="simpletab-tabs"
            role="tablist"
            aria-label={t("standings.tabListLabel")}
          >
            {availableTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`${baseId}-tab-${tab.id}`}
                aria-selected={activeTab === tab.id}
                aria-controls={`${baseId}-tabpanel`}
                className="simpletab-tab"
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <section
            id={`${baseId}-tabpanel`}
            role="tabpanel"
            aria-labelledby={`${baseId}-tab-${activeTab}`}
            className="simpletab-section"
          >
            {panelContent}
          </section>
        </>
      )}
    </div>
  );
};
