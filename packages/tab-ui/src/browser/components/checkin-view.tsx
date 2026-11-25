import { getEligibleTeamsForRound } from "@simpletab/core/lib/draw/generator";
import { isAvailableForRound } from "@simpletab/core/lib/roundAvailability";
import { isVenueCheckedIn } from "@simpletab/core/lib/venues/venues";
import type { Adjudicator, Team, Venue } from "@simpletab/core/types";
import type {
  HostStatus,
  ProjectedState,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import * as React from "@theia/core/shared/react";
import type { ActionRunner, SimpleTabAction } from "../actions/action";
import { setParticipantAction, setVenueAction } from "../actions/checkin-actions";
import { openSetupAction } from "../actions/releases-actions";
import { t } from "../i18n";
import { InlineOpError, type InlineOpErrorData } from "./inline-op-error";
import { LockBanner } from "./lock-banner";
import { getDefaultRoundId, RoundPicker } from "./round-picker";

export type CheckinTabId = "teams" | "adjudicators" | "venues";
export type CheckinStatusFilter = "all" | "available" | "unavailable";

const TAB_ORDER: readonly CheckinTabId[] = ["teams", "adjudicators", "venues"];

export interface CheckinViewProps {
  state: ProjectedState | null;
  status: HostStatus;
  selectedRoundId?: string;
  onSelectRound?: (roundId: string) => void;
  /** Runs the same commands as the palette; no op building happens here. */
  run: ActionRunner;
}

interface RowErrorState {
  error: InlineOpErrorData;
  retry: (runner: ActionRunner) => Promise<SubmitResult>;
}

function buildRowKey(tab: CheckinTabId, id: string): string {
  return `${tab}:${id}`;
}

export const CheckinView: React.FC<CheckinViewProps> = ({
  state,
  status,
  selectedRoundId: controlledRoundId,
  onSelectRound,
  run,
}) => {
  const baseId = React.useId();
  const [activeTab, setActiveTab] = React.useState<CheckinTabId>("teams");
  const [uncontrolledRoundId, setUncontrolledRoundId] = React.useState<string>("");
  const [searchQuery, setSearchQuery] = React.useState("");
  const [statusFilter, setStatusFilter] =
    React.useState<CheckinStatusFilter>("all");
  const [rowErrors, setRowErrors] = React.useState<Record<string, RowErrorState>>(
    {},
  );
  const [bulkBusy, setBulkBusy] = React.useState(false);
  const [bulkMessage, setBulkMessage] = React.useState<string | null>(null);
  const tabRefs = React.useRef<
    Partial<Record<CheckinTabId, HTMLButtonElement | null>>
  >({});

  React.useEffect(() => {
    if (state === null) {
      return;
    }
    const candidate = controlledRoundId ?? uncontrolledRoundId;
    const exists = state.rounds.some((round) => round.id === candidate);
    if (!exists) {
      const nextDefault = getDefaultRoundId(state);
      if (controlledRoundId === undefined) {
        setUncontrolledRoundId(nextDefault);
      } else if (onSelectRound !== undefined && nextDefault.length > 0) {
        onSelectRound(nextDefault);
      }
    }
  }, [state, controlledRoundId, uncontrolledRoundId, onSelectRound]);

  const effectiveRoundId = React.useMemo(() => {
    if (state === null) {
      return "";
    }
    if (
      controlledRoundId !== undefined &&
      state.rounds.some((round) => round.id === controlledRoundId)
    ) {
      return controlledRoundId;
    }
    if (state.rounds.some((round) => round.id === uncontrolledRoundId)) {
      return uncontrolledRoundId;
    }
    return getDefaultRoundId(state);
  }, [state, controlledRoundId, uncontrolledRoundId]);

  const selectedRound = React.useMemo(
    () =>
      state?.rounds.find((round) => round.id === effectiveRoundId),
    [state?.rounds, effectiveRoundId],
  );

  const eligibleTeams = React.useMemo(
    () =>
      state === null || selectedRound === undefined
        ? []
        : getEligibleTeamsForRound(state.teams, selectedRound),
    [state, selectedRound],
  );

  if (state === null) {
    return (
      <div className="simpletab-page">
        <div className="simpletab-header">
          <h1 className="simpletab-title">{t("checkin.title")}</h1>
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

  const isHostOwner = state.roleId === "host_owner";
  const expiryHours = state.tournament.preferences.checkInExpiresAfterHours;
  const venueExpiryHours =
    state.tournament.preferences.venueCheckInExpiresAfterHours;

  const isTeamAvailable = (team: Team): boolean =>
    selectedRound !== undefined &&
    isAvailableForRound(team, selectedRound, expiryHours);

  const isAdjAvailable = (adj: Adjudicator): boolean =>
    selectedRound !== undefined &&
    isAvailableForRound(adj, selectedRound, expiryHours);

  const isVenueReady = (venue: Venue): boolean =>
    isVenueCheckedIn(venue, venueExpiryHours);

  const teamsAvailableCount = eligibleTeams.filter(isTeamAvailable).length;
  const adjsAvailableCount = state.adjudicators.filter(isAdjAvailable).length;
  const venuesCheckedInCount = state.venues.filter(isVenueReady).length;

  const normalizedQuery = searchQuery.trim().toLowerCase();

  const matchesSearch = (parts: Array<string | undefined>): boolean => {
    if (normalizedQuery.length === 0) {
      return true;
    }
    return parts.some(
      (part) =>
        part !== undefined && part.toLowerCase().includes(normalizedQuery),
    );
  };

  const matchesFilter = (available: boolean): boolean => {
    if (statusFilter === "available") {
      return available;
    }
    if (statusFilter === "unavailable") {
      return !available;
    }
    return true;
  };

  const filteredTeams = eligibleTeams.filter((team) => {
    const available = isTeamAvailable(team);
    return (
      matchesFilter(available) &&
      matchesSearch([
        team.name,
        team.codeName,
        team.institutionName,
        ...team.speakers.map((spk) => spk.name),
      ])
    );
  });

  const filteredAdjudicators = state.adjudicators.filter((adj) => {
    const available = isAdjAvailable(adj);
    return (
      matchesFilter(available) &&
      matchesSearch([adj.name, adj.codeName, adj.institutionName])
    );
  });

  const filteredVenues = state.venues.filter((venue) => {
    const checkedIn = isVenueReady(venue);
    return (
      matchesFilter(checkedIn) &&
      matchesSearch([venue.name, venue.category, ...(venue.categories ?? [])])
    );
  });

  const handleSelectRound = (roundId: string): void => {
    setBulkMessage(null);
    setRowErrors({});
    if (controlledRoundId === undefined) {
      setUncontrolledRoundId(roundId);
    }
    onSelectRound?.(roundId);
  };

  const selectTab = (tab: CheckinTabId): void => {
    setActiveTab(tab);
    setBulkMessage(null);
  };

  const handleTabKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    tab: CheckinTabId,
  ): void => {
    const idx = TAB_ORDER.indexOf(tab);
    let nextIdx = idx;
    if (event.key === "ArrowRight") {
      nextIdx = (idx + 1) % TAB_ORDER.length;
    } else if (event.key === "ArrowLeft") {
      nextIdx = (idx - 1 + TAB_ORDER.length) % TAB_ORDER.length;
    } else if (event.key === "Home") {
      nextIdx = 0;
    } else if (event.key === "End") {
      nextIdx = TAB_ORDER.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    const nextTab = TAB_ORDER[nextIdx];
    selectTab(nextTab);
    tabRefs.current[nextTab]?.focus();
  };

  const describeCurrentRowValue = (tab: CheckinTabId, id: string): string => {
    if (tab === "teams") {
      const item = state.teams.find((tm) => tm.id === id);
      if (!item) {
        return id;
      }
      return `${item.name}: ${isTeamAvailable(item) ? t("checkin.statusAvailable") : t("checkin.statusUnavailable")}`;
    }
    if (tab === "adjudicators") {
      const item = state.adjudicators.find((adj) => adj.id === id);
      if (!item) {
        return id;
      }
      return `${item.name}: ${isAdjAvailable(item) ? t("checkin.statusAvailable") : t("checkin.statusUnavailable")}`;
    }
    const venue = state.venues.find((v) => v.id === id);
    if (!venue) {
      return id;
    }
    return `${venue.name}: ${isVenueReady(venue) ? t("checkin.statusCheckedIn") : t("checkin.statusNotCheckedIn")}`;
  };

  const submitRowToggleResult = async <A,>(
    runner: ActionRunner,
    action: SimpleTabAction<A, SubmitResult>,
    args: A,
    tab: CheckinTabId,
    id: string,
  ): Promise<SubmitResult> => {
    const rKey = buildRowKey(tab, id);
    setRowErrors((prev) => {
      if (!(rKey in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[rKey];
      return next;
    });

    const result = await runner(action, args);
    if (!result.ok) {
      setRowErrors((prev) => ({
        ...prev,
        [rKey]: {
          error: {
            code: result.code,
            errors: result.errors,
            current: result.current,
            currentSummary: describeCurrentRowValue(tab, id),
          },
          retry: (currentRun) =>
            submitRowToggleResult(currentRun, action, args, tab, id),
        },
      }));
      return result;
    }
    return result;
  };

  const submitRowToggle = async <A,>(
    runner: ActionRunner,
    action: SimpleTabAction<A, SubmitResult>,
    args: A,
    tab: CheckinTabId,
    id: string,
  ): Promise<boolean> =>
    (await submitRowToggleResult(runner, action, args, tab, id)).ok;

  const handleToggleVenue = async (venue: Venue): Promise<boolean> =>
    submitRowToggle(
      run,
      setVenueAction,
      { venueId: venue.id, checkedIn: !isVenueReady(venue) },
      "venues",
      venue.id,
    );

  const handleToggleParticipant = async (
    tab: "teams" | "adjudicators",
    id: string,
    targetAvailable: boolean,
  ): Promise<boolean> => {
    if (selectedRound === undefined) {
      return false;
    }
    return submitRowToggle(
      run,
      setParticipantAction,
      {
        entityType: tab === "teams" ? "team" : "adjudicator",
        entityId: id,
        roundId: selectedRound.id,
        available: targetAvailable,
      },
      tab,
      id,
    );
  };

  const handleBulkToggle = async (targetAvailable: boolean): Promise<void> => {
    setBulkMessage(null);
    const idsToUpdate: string[] = [];
    if (activeTab === "teams") {
      for (const team of filteredTeams) {
        if (isTeamAvailable(team) !== targetAvailable) {
          idsToUpdate.push(team.id);
        }
      }
    } else if (activeTab === "adjudicators") {
      for (const adj of filteredAdjudicators) {
        if (isAdjAvailable(adj) !== targetAvailable) {
          idsToUpdate.push(adj.id);
        }
      }
    } else {
      for (const venue of filteredVenues) {
        if (isVenueReady(venue) !== targetAvailable) {
          idsToUpdate.push(venue.id);
        }
      }
    }

    if (idsToUpdate.length === 0) {
      setBulkMessage(t("checkin.bulkNoChanges"));
      return;
    }

    setBulkBusy(true);
    let succeeded = 0;
    let failed = 0;
    try {
      for (const id of idsToUpdate) {
        let ok: boolean;
        if (activeTab === "venues") {
          const venue = state.venues.find((item) => item.id === id);
          ok = venue === undefined ? false : await handleToggleVenue(venue);
        } else {
          ok = await handleToggleParticipant(activeTab, id, targetAvailable);
        }
        if (ok) {
          succeeded += 1;
        } else {
          failed += 1;
        }
      }
      setBulkMessage(t("checkin.bulkSummary", { succeeded, failed }));
    } finally {
      setBulkBusy(false);
    }
  };

  const renderRowError = (tab: CheckinTabId, id: string): React.ReactNode => {
    const rKey = buildRowKey(tab, id);
    const entry = rowErrors[rKey];
    if (entry === undefined) {
      return null;
    }
    return (
      <InlineOpError
        error={{
          ...entry.error,
          currentSummary: describeCurrentRowValue(tab, id),
        }}
        onRetry={() => {
          void entry.retry(run);
        }}
        onDismiss={() => {
          setRowErrors((prev) => {
            const next = { ...prev };
            delete next[rKey];
            return next;
          });
        }}
      />
    );
  };

  const tabLabel = (tab: CheckinTabId): string => {
    switch (tab) {
      case "teams":
        return t("checkin.tabTeams", { count: eligibleTeams.length });
      case "adjudicators":
        return t("checkin.tabAdjudicators", {
          count: state.adjudicators.length,
        });
      case "venues":
        return t("checkin.tabVenues", { count: state.venues.length });
    }
  };

  const activeCountSummary =
    activeTab === "teams"
      ? t("checkin.teamsCount", {
          available: teamsAvailableCount,
          total: eligibleTeams.length,
        })
      : activeTab === "adjudicators"
        ? t("checkin.adjudicatorsCount", {
            available: adjsAvailableCount,
            total: state.adjudicators.length,
          })
        : t("checkin.venuesCount", {
            available: venuesCheckedInCount,
            total: state.venues.length,
          });

  return (
    <div className="simpletab-page">
      <div className="simpletab-header">
        <h1 className="simpletab-title">{t("checkin.title")}</h1>
        <RoundPicker
          rounds={state.rounds}
          selectedRoundId={effectiveRoundId}
          onSelectRound={handleSelectRound}
        />
      </div>

      <LockBanner
        locks={status.locks}
        rounds={state.rounds}
        isHostOwner={isHostOwner}
        run={run}
      />

      {selectedRound === undefined ? (
        <div className="simpletab-alert" role="status">
          {t("checkin.noRounds")}
        </div>
      ) : (
        <>
          <div
            className="simpletab-tabs"
            role="tablist"
            aria-label={t("checkin.title")}
          >
            {TAB_ORDER.map((tab) => {
              const selected = activeTab === tab;
              return (
                <button
                  key={tab}
                  ref={(el) => {
                    tabRefs.current[tab] = el;
                  }}
                  id={`${baseId}-tab-${tab}`}
                  type="button"
                  data-view-only
                  role="tab"
                  aria-selected={selected}
                  aria-controls={`${baseId}-panel-${tab}`}
                  tabIndex={selected ? 0 : -1}
                  className="simpletab-tab"
                  onClick={() => selectTab(tab)}
                  onKeyDown={(e) => handleTabKeyDown(e, tab)}
                >
                  {tabLabel(tab)}
                </button>
              );
            })}
          </div>

          <section className="simpletab-section">
            <div className="simpletab-toolbar">
              <div className="simpletab-count-summary" role="status">
                {activeCountSummary}
              </div>
              <div className="simpletab-actions">
                <button
                  type="button"
                  className="theia-button"
                  data-action={
                    activeTab === "venues"
                      ? setVenueAction.id
                      : setParticipantAction.id
                  }
                  disabled={bulkBusy}
                  onClick={() => {
                    void handleBulkToggle(true);
                  }}
                >
                  {t("checkin.markAllAvailable")}
                </button>
                <button
                  type="button"
                  className="theia-button secondary"
                  data-action={
                    activeTab === "venues"
                      ? setVenueAction.id
                      : setParticipantAction.id
                  }
                  disabled={bulkBusy}
                  onClick={() => {
                    void handleBulkToggle(false);
                  }}
                >
                  {t("checkin.markAllUnavailable")}
                </button>
              </div>
            </div>

            <div className="simpletab-form-grid">
              <div className="simpletab-field">
                <label htmlFor={`${baseId}-search`}>
                  {t("checkin.searchLabel")}
                </label>
                <input
                  id={`${baseId}-search`}
                  type="text"
                  placeholder={t("checkin.searchPlaceholder")}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
              <div className="simpletab-field">
                <label htmlFor={`${baseId}-filter`}>
                  {t("checkin.filterLabel")}
                </label>
                <select
                  id={`${baseId}-filter`}
                  value={statusFilter}
                  onChange={(e) =>
                    setStatusFilter(e.target.value as CheckinStatusFilter)
                  }
                >
                  <option value="all">{t("checkin.filterAll")}</option>
                  <option value="available">
                    {t("checkin.filterAvailable")}
                  </option>
                  <option value="unavailable">
                    {t("checkin.filterUnavailable")}
                  </option>
                </select>
              </div>
            </div>

            {bulkBusy ? (
              <div className="simpletab-hint" role="status">
                {t("checkin.bulkProgress")}
              </div>
            ) : null}
            {bulkMessage !== null ? (
              <div className="simpletab-alert" role="status">
                {bulkMessage}
              </div>
            ) : null}
          </section>

          {activeTab === "teams" ? (
            <div
              id={`${baseId}-panel-teams`}
              role="tabpanel"
              aria-labelledby={`${baseId}-tab-teams`}
            >
              {filteredTeams.length === 0 ? (
                <p className="simpletab-empty">{t("checkin.emptyTeams")}</p>
              ) : (
                <div className="simpletab-table-wrap">
                  <table className="simpletab-table">
                    <caption>
                      {t("checkin.teamsCaption", { round: selectedRound.name })}
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">{t("checkin.colName")}</th>
                        <th scope="col">{t("checkin.colInstitution")}</th>
                        <th scope="col">{t("checkin.colDetails")}</th>
                        <th scope="col">{t("checkin.colStatus")}</th>
                        <th scope="col">{t("checkin.colAction")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredTeams.map((team) => {
                        const available = isTeamAvailable(team);
                        return (
                          <tr key={team.id}>
                            <td>
                              <div>{team.name}</div>
                              {renderRowError("teams", team.id)}
                            </td>
                            <td>{team.institutionName ?? t("common.none")}</td>
                            <td>
                              {team.isSwing ? (
                                <span className="simpletab-badge">
                                  {t("checkin.swingBadge")}
                                </span>
                              ) : null}
                              {team.speakers.map((s) => s.name).join(", ")}
                            </td>
                            <td>
                              <span
                                className={`simpletab-badge ${
                                  available
                                    ? "simpletab-badge-add"
                                    : "simpletab-badge-error"
                                }`}
                              >
                                {available
                                  ? t("checkin.statusAvailable")
                                  : t("checkin.statusUnavailable")}
                              </span>
                            </td>
                            <td>
                              <button
                                type="button"
                                className="theia-button secondary"
                                data-action={setParticipantAction.id}
                                aria-pressed={available}
                                aria-label={t("checkin.toggleAria", {
                                  name: team.name,
                                })}
                                onClick={() => {
                                  void handleToggleParticipant(
                                    "teams",
                                    team.id,
                                    !available,
                                  );
                                }}
                              >
                                {available
                                  ? t("checkin.setUnavailable")
                                  : t("checkin.setAvailable")}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : null}

          {activeTab === "adjudicators" ? (
            <div
              id={`${baseId}-panel-adjudicators`}
              role="tabpanel"
              aria-labelledby={`${baseId}-tab-adjudicators`}
            >
              {filteredAdjudicators.length === 0 ? (
                <p className="simpletab-empty">
                  {t("checkin.emptyAdjudicators")}
                </p>
              ) : (
                <div className="simpletab-table-wrap">
                  <table className="simpletab-table">
                    <caption>
                      {t("checkin.adjudicatorsCaption", {
                        round: selectedRound.name,
                      })}
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">{t("checkin.colName")}</th>
                        <th scope="col">{t("checkin.colInstitution")}</th>
                        <th scope="col">{t("checkin.colDetails")}</th>
                        <th scope="col">{t("checkin.colStatus")}</th>
                        <th scope="col">{t("checkin.colAction")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredAdjudicators.map((adj) => {
                        const available = isAdjAvailable(adj);
                        return (
                          <tr key={adj.id}>
                            <td>
                              <div>{adj.name}</div>
                              {renderRowError("adjudicators", adj.id)}
                            </td>
                            <td>
                              {adj.independent
                                ? t("checkin.independentLabel")
                                : (adj.institutionName ?? t("common.none"))}
                            </td>
                            <td>
                              <span className="simpletab-badge">
                                {adj.trainee
                                  ? t("checkin.traineeBadge")
                                  : t("checkin.voterBadge")}
                              </span>
                              <span>
                                {t("checkin.baseScoreLabel", {
                                  score: adj.baseScore,
                                })}
                              </span>
                            </td>
                            <td>
                              <span
                                className={`simpletab-badge ${
                                  available
                                    ? "simpletab-badge-add"
                                    : "simpletab-badge-error"
                                }`}
                              >
                                {available
                                  ? t("checkin.statusAvailable")
                                  : t("checkin.statusUnavailable")}
                              </span>
                            </td>
                            <td>
                              <button
                                type="button"
                                className="theia-button secondary"
                                data-action={setParticipantAction.id}
                                aria-pressed={available}
                                aria-label={t("checkin.toggleAria", {
                                  name: adj.name,
                                })}
                                onClick={() => {
                                  void handleToggleParticipant(
                                    "adjudicators",
                                    adj.id,
                                    !available,
                                  );
                                }}
                              >
                                {available
                                  ? t("checkin.setUnavailable")
                                  : t("checkin.setAvailable")}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : null}

          {activeTab === "venues" ? (
            <div
              id={`${baseId}-panel-venues`}
              role="tabpanel"
              aria-labelledby={`${baseId}-tab-venues`}
            >
              {filteredVenues.length === 0 ? (
                <p className="simpletab-empty">{t("checkin.emptyVenues")}</p>
              ) : (
                <div className="simpletab-table-wrap">
                  <table className="simpletab-table">
                    <caption>{t("checkin.venuesCaption")}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{t("checkin.colName")}</th>
                        <th scope="col">{t("checkin.colDetails")}</th>
                        <th scope="col">{t("checkin.colStatus")}</th>
                        <th scope="col">{t("checkin.colAction")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredVenues.map((venue) => {
                        const checkedIn = isVenueReady(venue);
                        return (
                          <tr key={venue.id}>
                            <td>
                              <div>{venue.name}</div>
                              {renderRowError("venues", venue.id)}
                            </td>
                            <td>
                              <span>
                                {t("checkin.priorityLabel", {
                                  priority: venue.priority,
                                })}
                              </span>
                              {venue.category ? ` · ${venue.category}` : ""}
                            </td>
                            <td>
                              <span
                                className={`simpletab-badge ${
                                  checkedIn
                                    ? "simpletab-badge-add"
                                    : "simpletab-badge-error"
                                }`}
                              >
                                {checkedIn
                                  ? t("checkin.statusCheckedIn")
                                  : t("checkin.statusNotCheckedIn")}
                              </span>
                            </td>
                            <td>
                              <button
                                type="button"
                                className="theia-button secondary"
                                data-action={setVenueAction.id}
                                aria-pressed={checkedIn}
                                aria-label={t("checkin.toggleAria", {
                                  name: venue.name,
                                })}
                                onClick={() => {
                                  void handleToggleVenue(venue);
                                }}
                              >
                                {checkedIn
                                  ? t("checkin.setNotCheckedIn")
                                  : t("checkin.setCheckedIn")}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
};
