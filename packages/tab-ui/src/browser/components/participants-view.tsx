import {
  adjudicatorConflictIds,
  changeAdjudicatorInstitution,
  extraInstitutionConflictIds,
  teamConflictIds,
} from "@simpletab/core/lib/adjudicators/conflicts";
import type { OpRequest } from "@simpletab/core/ops";
import type {
  Adjudicator,
  Institution,
  Speaker,
  Team,
  Venue,
} from "@simpletab/core/types";
import type {
  ProjectedState,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import * as React from "@theia/core/shared/react";
import { t } from "../i18n";
import { CsvImportPanel } from "./csv-import-panel";

export type ParticipantsTabId =
  | "institutions"
  | "teams"
  | "adjudicators"
  | "venues"
  | "conflicts";

const TAB_ORDER: readonly ParticipantsTabId[] = [
  "institutions",
  "teams",
  "adjudicators",
  "venues",
  "conflicts",
];

export interface ParticipantsViewProps {
  state: ProjectedState | null;
  onSubmitOp: (request: OpRequest) => Promise<SubmitResult>;
  onOpenSetup?: () => void;
}

let entityIdCounter = 0;
function makeEntityId(prefix: string): string {
  entityIdCounter += 1;
  return `${prefix}-${Date.now()}-${entityIdCounter}`;
}

interface OpNotice {
  kind: "error" | "success";
  text: string;
}

function formatOpError(result: SubmitResult): string {
  if (result.ok) {
    return "";
  }
  return t("common.errorWithCode", {
    code: result.code,
    message: result.errors.join("; "),
  });
}

function defaultSpeakerDrafts(count: number): Array<{ id: string; name: string; email: string }> {
  const safeCount = Math.max(1, count);
  return Array.from({ length: safeCount }, () => ({
    id: "",
    name: "",
    email: "",
  }));
}

export const ParticipantsView: React.FC<ParticipantsViewProps> = ({
  state,
  onSubmitOp,
  onOpenSetup,
}) => {
  const baseId = React.useId();
  const [activeTab, setActiveTab] = React.useState<ParticipantsTabId>("institutions");
  const [notice, setNotice] = React.useState<OpNotice | null>(null);
  const [showCsvFor, setShowCsvFor] = React.useState<
    "institutions" | "teams" | "adjudicators" | null
  >(null);
  const tabRefs = React.useRef<Partial<Record<ParticipantsTabId, HTMLButtonElement | null>>>({});

  // Institutions form state
  const [editingInstId, setEditingInstId] = React.useState<string | null>(null);
  const [instName, setInstName] = React.useState("");
  const [instCode, setInstCode] = React.useState("");
  const [instRegion, setInstRegion] = React.useState("");

  // Teams form state
  const [editingTeamId, setEditingTeamId] = React.useState<string | null>(null);
  const [teamName, setTeamName] = React.useState("");
  const [teamCodeName, setTeamCodeName] = React.useState("");
  const [teamInstId, setTeamInstId] = React.useState("");
  const [teamSpeakers, setTeamSpeakers] = React.useState<
    Array<{ id: string; name: string; email: string }>
  >(() => defaultSpeakerDrafts(state?.tournament.preferences.substantiveSpeakers ?? 2));

  // Adjudicators form state
  const [editingAdjId, setEditingAdjId] = React.useState<string | null>(null);
  const [adjName, setAdjName] = React.useState("");
  const [adjInstId, setAdjInstId] = React.useState("");
  const [adjBaseScore, setAdjBaseScore] = React.useState("5");
  const [adjEmail, setAdjEmail] = React.useState("");
  const [adjTrainee, setAdjTrainee] = React.useState(false);
  const [adjIndependent, setAdjIndependent] = React.useState(false);

  // Venues form state
  const [editingVenueId, setEditingVenueId] = React.useState<string | null>(null);
  const [venueName, setVenueName] = React.useState("");
  const [venuePriority, setVenuePriority] = React.useState("10");
  const [venueCategory, setVenueCategory] = React.useState("");
  const [venueCapacity, setVenueCapacity] = React.useState("");
  const [venueAccessible, setVenueAccessible] = React.useState(false);
  const [venueOnline, setVenueOnline] = React.useState(false);
  const [venueNearTabRoom, setVenueNearTabRoom] = React.useState(false);
  const [venueAvailable, setVenueAvailable] = React.useState(true);

  // Conflicts form state
  const [conflictAdjId, setConflictAdjId] = React.useState("");
  const [conflictTeamIds, setConflictTeamIds] = React.useState<string[]>([]);
  const [conflictAdjIds, setConflictAdjIds] = React.useState<string[]>([]);
  const [conflictInstIds, setConflictInstIds] = React.useState<string[]>([]);
  const [conflictSubjectTeamId, setConflictSubjectTeamId] = React.useState("");
  const [conflictSubjectTeamInstIds, setConflictSubjectTeamInstIds] = React.useState<string[]>([]);

  React.useEffect(() => {
    if (state === null || editingTeamId !== null) {
      return;
    }
    setTeamSpeakers(
      defaultSpeakerDrafts(state.tournament.preferences.substantiveSpeakers),
    );
  }, [state?.tournament.id, state?.tournament.preferences.substantiveSpeakers, editingTeamId]);

  if (state === null) {
    return (
      <div className="simpletab-page">
        <div className="simpletab-header">
          <h1 className="simpletab-title">{t("participants.title")}</h1>
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

  const institutionMap = new Map(state.institutions.map((item) => [item.id, item]));
  const teamMap = new Map(state.teams.map((item) => [item.id, item]));
  const adjMap = new Map(state.adjudicators.map((item) => [item.id, item]));

  const conflictRows = [
    ...state.adjudicators
      .filter((adj) => adj.conflicts.length > 0)
      .map((adj) => ({
        key: `adj-${adj.id}`,
        id: adj.id,
        subject: adj.name,
        kind: "adj" as const,
        targets: adj.conflicts
          .map((c) => {
            if (c.teamId) return teamMap.get(c.teamId)?.name ?? c.teamId;
            if (c.adjudicatorId) return adjMap.get(c.adjudicatorId)?.name ?? c.adjudicatorId;
            if (c.institutionId) return institutionMap.get(c.institutionId)?.name ?? c.institutionId;
            return "";
          })
          .filter(Boolean)
          .join(", "),
      })),
    ...state.teams
      .filter((team) => (team.institutionConflictIds?.length ?? 0) > 0)
      .map((team) => ({
        key: `team-${team.id}`,
        id: team.id,
        subject: team.name,
        kind: "team" as const,
        targets: (team.institutionConflictIds ?? [])
          .map((instId) => institutionMap.get(instId)?.name ?? instId)
          .join(", "),
      })),
  ];

  const selectTab = (tab: ParticipantsTabId): void => {
    setActiveTab(tab);
    setNotice(null);
    setShowCsvFor(null);
  };

  const handleTabKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    tab: ParticipantsTabId,
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

  const resetInstForm = (): void => {
    setEditingInstId(null);
    setInstName("");
    setInstCode("");
    setInstRegion("");
  };

  const handleInstSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setNotice(null);
    const existing = editingInstId
      ? state.institutions.find((item) => item.id === editingInstId)
      : undefined;
    const institution: Institution = {
      ...(existing ?? {}),
      id: existing?.id ?? makeEntityId("inst"),
      tournamentId: state.tournament.id,
      name: instName.trim(),
      code: instCode.trim(),
      ...(instRegion.trim() ? { region: instRegion.trim() } : { region: undefined }),
    };
    const result = await onSubmitOp({
      type: existing ? "institution.update" : "institution.create",
      payload: { institution },
    });
    if (!result.ok) {
      setNotice({ kind: "error", text: formatOpError(result) });
      return;
    }
    resetInstForm();
  };

  const resetTeamForm = (): void => {
    setEditingTeamId(null);
    setTeamName("");
    setTeamCodeName("");
    setTeamInstId("");
    setTeamSpeakers(
      defaultSpeakerDrafts(state.tournament.preferences.substantiveSpeakers),
    );
  };

  const handleTeamSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setNotice(null);
    const existing = editingTeamId
      ? state.teams.find((item) => item.id === editingTeamId)
      : undefined;
    const institution = teamInstId ? institutionMap.get(teamInstId) : undefined;
    const speakers: Speaker[] = teamSpeakers
      .filter((s) => s.name.trim().length > 0)
      .map((s) => {
        const prev = existing?.speakers.find((p) => p.id === s.id);
        return {
          ...(prev ?? {}),
          id: s.id || makeEntityId("spk"),
          name: s.name.trim(),
          ...(s.email.trim() ? { email: s.email.trim() } : { email: undefined }),
        };
      });

    const team: Team = {
      ...(existing ?? {}),
      id: existing?.id ?? makeEntityId("team"),
      tournamentId: state.tournament.id,
      name: teamName.trim(),
      ...(teamCodeName.trim()
        ? { codeName: teamCodeName.trim() }
        : { codeName: undefined }),
      institutionId: institution?.id,
      institutionName: institution?.name,
      speakers,
      breakCategories: existing?.breakCategories ?? [],
      speakerCategories: existing?.speakerCategories ?? [],
      checkedIn: existing?.checkedIn ?? true,
    };

    const result = await onSubmitOp({
      type: existing ? "team.update" : "team.create",
      payload: { team },
    });
    if (!result.ok) {
      setNotice({ kind: "error", text: formatOpError(result) });
      return;
    }
    resetTeamForm();
  };

  const resetAdjForm = (): void => {
    setEditingAdjId(null);
    setAdjName("");
    setAdjInstId("");
    setAdjBaseScore("5");
    setAdjEmail("");
    setAdjTrainee(false);
    setAdjIndependent(false);
  };

  const handleAdjSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setNotice(null);
    const existing = editingAdjId
      ? state.adjudicators.find((item) => item.id === editingAdjId)
      : undefined;
    const parsedScore = Number(adjBaseScore);
    const institution =
      !adjIndependent && adjInstId ? institutionMap.get(adjInstId) : undefined;

    const baseAdj: Adjudicator = {
      ...(existing ?? {}),
      id: existing?.id ?? makeEntityId("adj"),
      tournamentId: state.tournament.id,
      name: adjName.trim(),
      baseScore: parsedScore,
      trainee: adjTrainee,
      independent: adjIndependent || institution === undefined,
      ...(adjEmail.trim() ? { email: adjEmail.trim() } : { email: undefined }),
      conflicts: existing?.conflicts ?? [],
      checkedIn: existing?.checkedIn ?? true,
    };
    const adjudicator = changeAdjudicatorInstitution(baseAdj, institution);

    const result = await onSubmitOp({
      type: existing ? "adjudicator.update" : "adjudicator.create",
      payload: { adjudicator },
    });
    if (!result.ok) {
      setNotice({ kind: "error", text: formatOpError(result) });
      return;
    }
    resetAdjForm();
  };

  const resetVenueForm = (): void => {
    setEditingVenueId(null);
    setVenueName("");
    setVenuePriority("10");
    setVenueCategory("");
    setVenueCapacity("");
    setVenueAccessible(false);
    setVenueOnline(false);
    setVenueNearTabRoom(false);
    setVenueAvailable(true);
  };

  const handleVenueSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setNotice(null);
    const existing = editingVenueId
      ? state.venues.find((item) => item.id === editingVenueId)
      : undefined;
    const priority = Number(venuePriority);
    const capacityTrimmed = venueCapacity.trim();
    const capacity = capacityTrimmed.length > 0 ? Number(capacityTrimmed) : undefined;
    const categoryTrimmed = venueCategory.trim();

    const venue: Venue = {
      ...(existing ?? {}),
      id: existing?.id ?? makeEntityId("venue"),
      tournamentId: state.tournament.id,
      name: venueName.trim(),
      priority,
      ...(categoryTrimmed
        ? { category: categoryTrimmed, categories: [categoryTrimmed] }
        : { category: undefined, categories: undefined }),
      ...(capacity !== undefined && Number.isFinite(capacity)
        ? { capacity }
        : { capacity: undefined }),
      accessible: venueAccessible,
      online: venueOnline,
      nearTabRoom: venueNearTabRoom,
      available: venueAvailable,
    };

    const result = await onSubmitOp({
      type: existing ? "venue.update" : "venue.create",
      payload: { venue },
    });
    if (!result.ok) {
      setNotice({ kind: "error", text: formatOpError(result) });
      return;
    }
    resetVenueForm();
  };

  const loadAdjConflicts = (adjId: string): void => {
    setConflictAdjId(adjId);
    const adj = adjMap.get(adjId);
    if (!adj) {
      setConflictTeamIds([]);
      setConflictAdjIds([]);
      setConflictInstIds([]);
      return;
    }
    setConflictTeamIds(teamConflictIds(adj));
    setConflictAdjIds(adjudicatorConflictIds(adj, state.adjudicators));
    setConflictInstIds(extraInstitutionConflictIds(adj));
  };

  const loadTeamConflicts = (teamId: string): void => {
    setConflictSubjectTeamId(teamId);
    const team = teamMap.get(teamId);
    setConflictSubjectTeamInstIds([...(team?.institutionConflictIds ?? [])]);
  };

  const toggleSelection = (
    list: string[],
    id: string,
    setter: (next: string[]) => void,
  ): void => {
    setter(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  };

  const handleSaveAdjConflicts = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!conflictAdjId) {
      return;
    }
    setNotice(null);
    const result = await onSubmitOp({
      type: "conflict.update_adjudicator",
      payload: {
        adjudicatorId: conflictAdjId,
        teamIds: conflictTeamIds,
        adjudicatorIds: conflictAdjIds,
        institutionIds: conflictInstIds,
      },
    });
    if (!result.ok) {
      setNotice({ kind: "error", text: formatOpError(result) });
      return;
    }
    setNotice({ kind: "success", text: t("participants.conflict.saved") });
  };

  const handleSaveTeamConflicts = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!conflictSubjectTeamId) {
      return;
    }
    setNotice(null);
    const result = await onSubmitOp({
      type: "conflict.set_team_institutions",
      payload: {
        teamId: conflictSubjectTeamId,
        institutionIds: conflictSubjectTeamInstIds,
        clearWhenEmpty: true,
      },
    });
    if (!result.ok) {
      setNotice({ kind: "error", text: formatOpError(result) });
      return;
    }
    setNotice({ kind: "success", text: t("participants.conflict.saved") });
  };

  const handleDelete = async (request: OpRequest): Promise<void> => {
    setNotice(null);
    const result = await onSubmitOp(request);
    if (!result.ok) {
      setNotice({ kind: "error", text: formatOpError(result) });
    }
  };

  const tabLabel = (tab: ParticipantsTabId): string => {
    switch (tab) {
      case "institutions":
        return t("participants.tabInstitutions", { count: state.institutions.length });
      case "teams":
        return t("participants.tabTeams", { count: state.teams.length });
      case "adjudicators":
        return t("participants.tabAdjudicators", { count: state.adjudicators.length });
      case "venues":
        return t("participants.tabVenues", { count: state.venues.length });
      case "conflicts":
        return t("participants.tabConflicts", { count: conflictRows.length });
    }
  };

  const selectedConflictAdj = conflictAdjId ? adjMap.get(conflictAdjId) : undefined;

  return (
    <div className="simpletab-page">
      <div className="simpletab-header">
        <h1 className="simpletab-title">{t("participants.title")}</h1>
        <div className="simpletab-actions">
          {(activeTab === "institutions" ||
            activeTab === "teams" ||
            activeTab === "adjudicators") && (
            <button
              type="button"
              className="theia-button secondary"
              onClick={() =>
                setShowCsvFor((prev) => (prev === activeTab ? null : activeTab))
              }
            >
              {showCsvFor === activeTab
                ? t("participants.hideImportCsv")
                : t("participants.importCsv")}
            </button>
          )}
        </div>
      </div>

      <div
        className="simpletab-tabs"
        role="tablist"
        aria-label={t("participants.title")}
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

      {notice !== null ? (
        <div
          className={`simpletab-alert ${
            notice.kind === "error"
              ? "simpletab-alert-error"
              : "simpletab-alert-success"
          }`}
          role={notice.kind === "error" ? "alert" : "status"}
        >
          {notice.text}
        </div>
      ) : null}

      {showCsvFor !== null && activeTab === showCsvFor ? (
        <CsvImportPanel
          kind={showCsvFor}
          state={state}
          onSubmitOp={onSubmitOp}
          onClose={() => setShowCsvFor(null)}
        />
      ) : null}

      {activeTab === "institutions" ? (
        <div
          id={`${baseId}-panel-institutions`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-institutions`}
        >
          <section className="simpletab-section">
            <h2 className="simpletab-subtitle">
              {editingInstId
                ? t("participants.inst.editTitle", { name: instName })
                : t("participants.inst.addTitle")}
            </h2>
            <form
              className="simpletab-form"
              onSubmit={(e) => {
                void handleInstSubmit(e);
              }}
            >
              <div className="simpletab-form-grid">
                <div className="simpletab-field">
                  <label htmlFor={`${baseId}-inst-name`}>
                    {t("participants.inst.name")}
                  </label>
                  <input
                    id={`${baseId}-inst-name`}
                    type="text"
                    required
                    value={instName}
                    onChange={(e) => setInstName(e.target.value)}
                  />
                </div>
                <div className="simpletab-field">
                  <label htmlFor={`${baseId}-inst-code`}>
                    {t("participants.inst.code")}
                  </label>
                  <input
                    id={`${baseId}-inst-code`}
                    type="text"
                    required
                    value={instCode}
                    onChange={(e) => setInstCode(e.target.value)}
                  />
                </div>
                <div className="simpletab-field">
                  <label htmlFor={`${baseId}-inst-region`}>
                    {t("participants.inst.region")}
                  </label>
                  <input
                    id={`${baseId}-inst-region`}
                    type="text"
                    value={instRegion}
                    onChange={(e) => setInstRegion(e.target.value)}
                  />
                </div>
              </div>
              <div className="simpletab-actions">
                <button type="submit" className="theia-button">
                  {editingInstId ? t("common.save") : t("common.add")}
                </button>
                {editingInstId ? (
                  <button
                    type="button"
                    className="theia-button secondary"
                    onClick={resetInstForm}
                  >
                    {t("common.cancel")}
                  </button>
                ) : null}
              </div>
            </form>
          </section>

          {state.institutions.length === 0 ? (
            <p className="simpletab-empty">{t("participants.inst.empty")}</p>
          ) : (
            <div className="simpletab-table-wrap">
              <table className="simpletab-table">
                <caption>{t("participants.inst.tableCaption")}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("participants.inst.name")}</th>
                    <th scope="col">{t("participants.inst.code")}</th>
                    <th scope="col">{t("participants.inst.region")}</th>
                    <th scope="col">{t("participants.actionsCol")}</th>
                  </tr>
                </thead>
                <tbody>
                  {state.institutions.map((inst) => (
                    <tr key={inst.id}>
                      <td>{inst.name}</td>
                      <td>{inst.code}</td>
                      <td>{inst.region ?? t("common.none")}</td>
                      <td className="simpletab-actions">
                        <button
                          type="button"
                          className="theia-button secondary"
                          aria-label={`${t("common.edit")} ${inst.name}`}
                          onClick={() => {
                            setEditingInstId(inst.id);
                            setInstName(inst.name);
                            setInstCode(inst.code);
                            setInstRegion(inst.region ?? "");
                          }}
                        >
                          {t("common.edit")}
                        </button>
                        <button
                          type="button"
                          className="theia-button secondary"
                          aria-label={`${t("common.delete")} ${inst.name}`}
                          onClick={() => {
                            void handleDelete({
                              type: "institution.delete",
                              payload: { institutionId: inst.id },
                            });
                          }}
                        >
                          {t("common.delete")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}

      {activeTab === "teams" ? (
        <div
          id={`${baseId}-panel-teams`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-teams`}
        >
          <section className="simpletab-section">
            <h2 className="simpletab-subtitle">
              {editingTeamId
                ? t("participants.team.editTitle", { name: teamName })
                : t("participants.team.addTitle")}
            </h2>
            <form
              className="simpletab-form"
              onSubmit={(e) => {
                void handleTeamSubmit(e);
              }}
            >
              <div className="simpletab-form-grid">
                <div className="simpletab-field">
                  <label htmlFor={`${baseId}-team-name`}>
                    {t("participants.team.name")}
                  </label>
                  <input
                    id={`${baseId}-team-name`}
                    type="text"
                    required
                    value={teamName}
                    onChange={(e) => setTeamName(e.target.value)}
                  />
                </div>
                <div className="simpletab-field">
                  <label htmlFor={`${baseId}-team-code`}>
                    {t("participants.team.codeName")}
                  </label>
                  <input
                    id={`${baseId}-team-code`}
                    type="text"
                    value={teamCodeName}
                    onChange={(e) => setTeamCodeName(e.target.value)}
                  />
                </div>
                <div className="simpletab-field">
                  <label htmlFor={`${baseId}-team-inst`}>
                    {t("participants.team.institution")}
                  </label>
                  <select
                    id={`${baseId}-team-inst`}
                    value={teamInstId}
                    onChange={(e) => setTeamInstId(e.target.value)}
                  >
                    <option value="">{t("participants.team.noInstitution")}</option>
                    {state.institutions.map((inst) => (
                      <option key={inst.id} value={inst.id}>
                        {inst.name} ({inst.code})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <fieldset className="simpletab-fieldset">
                <legend>{t("participants.team.speakersLegend")}</legend>
                {teamSpeakers.map((speaker, idx) => (
                  <div key={idx} className="simpletab-speaker-row">
                    <div className="simpletab-field">
                      <label htmlFor={`${baseId}-spk-name-${idx}`}>
                        {t("participants.team.speakerName", { index: idx + 1 })}
                      </label>
                      <input
                        id={`${baseId}-spk-name-${idx}`}
                        type="text"
                        value={speaker.name}
                        onChange={(e) => {
                          const value = e.target.value;
                          setTeamSpeakers((prev) =>
                            prev.map((item, i) =>
                              i === idx ? { ...item, name: value } : item,
                            ),
                          );
                        }}
                      />
                    </div>
                    <div className="simpletab-field">
                      <label htmlFor={`${baseId}-spk-email-${idx}`}>
                        {t("participants.team.speakerEmail", { index: idx + 1 })}
                      </label>
                      <input
                        id={`${baseId}-spk-email-${idx}`}
                        type="email"
                        value={speaker.email}
                        onChange={(e) => {
                          const value = e.target.value;
                          setTeamSpeakers((prev) =>
                            prev.map((item, i) =>
                              i === idx ? { ...item, email: value } : item,
                            ),
                          );
                        }}
                      />
                    </div>
                    <button
                      type="button"
                      className="theia-button secondary"
                      disabled={teamSpeakers.length <= 1}
                      onClick={() =>
                        setTeamSpeakers((prev) => prev.filter((_, i) => i !== idx))
                      }
                    >
                      {t("participants.team.removeSpeaker", { index: idx + 1 })}
                    </button>
                  </div>
                ))}
                <div>
                  <button
                    type="button"
                    className="theia-button secondary"
                    onClick={() =>
                      setTeamSpeakers((prev) => [
                        ...prev,
                        { id: "", name: "", email: "" },
                      ])
                    }
                  >
                    {t("participants.team.addSpeaker")}
                  </button>
                </div>
              </fieldset>

              <div className="simpletab-actions">
                <button type="submit" className="theia-button">
                  {editingTeamId ? t("common.save") : t("common.add")}
                </button>
                {editingTeamId ? (
                  <button
                    type="button"
                    className="theia-button secondary"
                    onClick={resetTeamForm}
                  >
                    {t("common.cancel")}
                  </button>
                ) : null}
              </div>
            </form>
          </section>

          {state.teams.length === 0 ? (
            <p className="simpletab-empty">{t("participants.team.empty")}</p>
          ) : (
            <div className="simpletab-table-wrap">
              <table className="simpletab-table">
                <caption>{t("participants.team.tableCaption")}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("participants.team.name")}</th>
                    <th scope="col">{t("participants.team.institution")}</th>
                    <th scope="col">{t("participants.team.speakersLegend")}</th>
                    <th scope="col">{t("participants.actionsCol")}</th>
                  </tr>
                </thead>
                <tbody>
                  {state.teams.map((team) => (
                    <tr key={team.id}>
                      <td>{team.name}</td>
                      <td>
                        {(team.institutionId &&
                          institutionMap.get(team.institutionId)?.name) ||
                          team.institutionName ||
                          t("common.none")}
                      </td>
                      <td>{team.speakers.map((s) => s.name).join(", ")}</td>
                      <td className="simpletab-actions">
                        <button
                          type="button"
                          className="theia-button secondary"
                          aria-label={`${t("common.edit")} ${team.name}`}
                          onClick={() => {
                            setEditingTeamId(team.id);
                            setTeamName(team.name);
                            setTeamCodeName(team.codeName ?? "");
                            setTeamInstId(team.institutionId ?? "");
                            setTeamSpeakers(
                              team.speakers.length > 0
                                ? team.speakers.map((s) => ({
                                    id: s.id,
                                    name: s.name,
                                    email: s.email ?? "",
                                  }))
                                : defaultSpeakerDrafts(
                                    state.tournament.preferences.substantiveSpeakers,
                                  ),
                            );
                          }}
                        >
                          {t("common.edit")}
                        </button>
                        <button
                          type="button"
                          className="theia-button secondary"
                          aria-label={`${t("common.delete")} ${team.name}`}
                          onClick={() => {
                            void handleDelete({
                              type: "team.delete",
                              payload: { teamId: team.id },
                            });
                          }}
                        >
                          {t("common.delete")}
                        </button>
                      </td>
                    </tr>
                  ))}
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
          <section className="simpletab-section">
            <h2 className="simpletab-subtitle">
              {editingAdjId
                ? t("participants.adj.editTitle", { name: adjName })
                : t("participants.adj.addTitle")}
            </h2>
            <form
              className="simpletab-form"
              onSubmit={(e) => {
                void handleAdjSubmit(e);
              }}
            >
              <div className="simpletab-form-grid">
                <div className="simpletab-field">
                  <label htmlFor={`${baseId}-adj-name`}>
                    {t("participants.adj.name")}
                  </label>
                  <input
                    id={`${baseId}-adj-name`}
                    type="text"
                    required
                    value={adjName}
                    onChange={(e) => setAdjName(e.target.value)}
                  />
                </div>
                <div className="simpletab-field">
                  <label htmlFor={`${baseId}-adj-score`}>
                    {t("participants.adj.baseScore")}
                  </label>
                  <input
                    id={`${baseId}-adj-score`}
                    type="number"
                    step="0.1"
                    required
                    value={adjBaseScore}
                    onChange={(e) => setAdjBaseScore(e.target.value)}
                  />
                </div>
                <div className="simpletab-field">
                  <label htmlFor={`${baseId}-adj-inst`}>
                    {t("participants.adj.institution")}
                  </label>
                  <select
                    id={`${baseId}-adj-inst`}
                    disabled={adjIndependent}
                    value={adjIndependent ? "" : adjInstId}
                    onChange={(e) => setAdjInstId(e.target.value)}
                  >
                    <option value="">{t("participants.team.noInstitution")}</option>
                    {state.institutions.map((inst) => (
                      <option key={inst.id} value={inst.id}>
                        {inst.name} ({inst.code})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="simpletab-field">
                  <label htmlFor={`${baseId}-adj-email`}>
                    {t("participants.adj.email")}
                  </label>
                  <input
                    id={`${baseId}-adj-email`}
                    type="email"
                    value={adjEmail}
                    onChange={(e) => setAdjEmail(e.target.value)}
                  />
                </div>
              </div>

              <div className="simpletab-checkbox-row">
                <div className="simpletab-checkbox-item">
                  <input
                    id={`${baseId}-adj-trainee`}
                    type="checkbox"
                    checked={adjTrainee}
                    onChange={(e) => setAdjTrainee(e.target.checked)}
                  />
                  <label htmlFor={`${baseId}-adj-trainee`}>
                    {t("participants.adj.trainee")}
                  </label>
                </div>
                <div className="simpletab-checkbox-item">
                  <input
                    id={`${baseId}-adj-independent`}
                    type="checkbox"
                    checked={adjIndependent}
                    onChange={(e) => setAdjIndependent(e.target.checked)}
                  />
                  <label htmlFor={`${baseId}-adj-independent`}>
                    {t("participants.adj.independent")}
                  </label>
                </div>
              </div>

              <div className="simpletab-actions">
                <button type="submit" className="theia-button">
                  {editingAdjId ? t("common.save") : t("common.add")}
                </button>
                {editingAdjId ? (
                  <button
                    type="button"
                    className="theia-button secondary"
                    onClick={resetAdjForm}
                  >
                    {t("common.cancel")}
                  </button>
                ) : null}
              </div>
            </form>
          </section>

          {state.adjudicators.length === 0 ? (
            <p className="simpletab-empty">{t("participants.adj.empty")}</p>
          ) : (
            <div className="simpletab-table-wrap">
              <table className="simpletab-table">
                <caption>{t("participants.adj.tableCaption")}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("participants.adj.name")}</th>
                    <th scope="col">{t("participants.adj.institution")}</th>
                    <th scope="col">{t("participants.adj.baseScore")}</th>
                    <th scope="col">{t("participants.adj.flagsCol")}</th>
                    <th scope="col">{t("participants.actionsCol")}</th>
                  </tr>
                </thead>
                <tbody>
                  {state.adjudicators.map((adj) => (
                    <tr key={adj.id}>
                      <td>{adj.name}</td>
                      <td>
                        {(adj.institutionId &&
                          institutionMap.get(adj.institutionId)?.name) ||
                          adj.institutionName ||
                          t("common.none")}
                      </td>
                      <td>{adj.baseScore}</td>
                      <td>
                        {adj.trainee ? (
                          <span className="simpletab-badge simpletab-badge-conflict">
                            {t("participants.adj.flagTrainee")}
                          </span>
                        ) : (
                          <span className="simpletab-badge simpletab-badge-add">
                            {t("participants.adj.flagAccredited")}
                          </span>
                        )}
                        {adj.independent ? (
                          <span className="simpletab-badge simpletab-badge-match">
                            {t("participants.adj.flagIndependent")}
                          </span>
                        ) : null}
                      </td>
                      <td className="simpletab-actions">
                        <button
                          type="button"
                          className="theia-button secondary"
                          aria-label={`${t("common.edit")} ${adj.name}`}
                          onClick={() => {
                            setEditingAdjId(adj.id);
                            setAdjName(adj.name);
                            setAdjInstId(adj.institutionId ?? "");
                            setAdjBaseScore(String(adj.baseScore));
                            setAdjEmail(adj.email ?? "");
                            setAdjTrainee(adj.trainee);
                            setAdjIndependent(adj.independent);
                          }}
                        >
                          {t("common.edit")}
                        </button>
                        <button
                          type="button"
                          className="theia-button secondary"
                          aria-label={`${t("common.delete")} ${adj.name}`}
                          onClick={() => {
                            void handleDelete({
                              type: "adjudicator.delete",
                              payload: { adjudicatorId: adj.id },
                            });
                          }}
                        >
                          {t("common.delete")}
                        </button>
                      </td>
                    </tr>
                  ))}
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
          <section className="simpletab-section">
            <h2 className="simpletab-subtitle">
              {editingVenueId
                ? t("participants.venue.editTitle", { name: venueName })
                : t("participants.venue.addTitle")}
            </h2>
            <form
              className="simpletab-form"
              onSubmit={(e) => {
                void handleVenueSubmit(e);
              }}
            >
              <div className="simpletab-form-grid">
                <div className="simpletab-field">
                  <label htmlFor={`${baseId}-venue-name`}>
                    {t("participants.venue.name")}
                  </label>
                  <input
                    id={`${baseId}-venue-name`}
                    type="text"
                    required
                    value={venueName}
                    onChange={(e) => setVenueName(e.target.value)}
                  />
                </div>
                <div className="simpletab-field">
                  <label htmlFor={`${baseId}-venue-priority`}>
                    {t("participants.venue.priority")}
                  </label>
                  <input
                    id={`${baseId}-venue-priority`}
                    type="number"
                    required
                    value={venuePriority}
                    onChange={(e) => setVenuePriority(e.target.value)}
                  />
                </div>
                <div className="simpletab-field">
                  <label htmlFor={`${baseId}-venue-category`}>
                    {t("participants.venue.category")}
                  </label>
                  <input
                    id={`${baseId}-venue-category`}
                    type="text"
                    value={venueCategory}
                    onChange={(e) => setVenueCategory(e.target.value)}
                  />
                </div>
                <div className="simpletab-field">
                  <label htmlFor={`${baseId}-venue-capacity`}>
                    {t("participants.venue.capacity")}
                  </label>
                  <input
                    id={`${baseId}-venue-capacity`}
                    type="number"
                    min={0}
                    value={venueCapacity}
                    onChange={(e) => setVenueCapacity(e.target.value)}
                  />
                </div>
              </div>

              <div className="simpletab-checkbox-row">
                <div className="simpletab-checkbox-item">
                  <input
                    id={`${baseId}-venue-available`}
                    type="checkbox"
                    checked={venueAvailable}
                    onChange={(e) => setVenueAvailable(e.target.checked)}
                  />
                  <label htmlFor={`${baseId}-venue-available`}>
                    {t("participants.venue.available")}
                  </label>
                </div>
                <div className="simpletab-checkbox-item">
                  <input
                    id={`${baseId}-venue-accessible`}
                    type="checkbox"
                    checked={venueAccessible}
                    onChange={(e) => setVenueAccessible(e.target.checked)}
                  />
                  <label htmlFor={`${baseId}-venue-accessible`}>
                    {t("participants.venue.accessible")}
                  </label>
                </div>
                <div className="simpletab-checkbox-item">
                  <input
                    id={`${baseId}-venue-online`}
                    type="checkbox"
                    checked={venueOnline}
                    onChange={(e) => setVenueOnline(e.target.checked)}
                  />
                  <label htmlFor={`${baseId}-venue-online`}>
                    {t("participants.venue.online")}
                  </label>
                </div>
                <div className="simpletab-checkbox-item">
                  <input
                    id={`${baseId}-venue-near`}
                    type="checkbox"
                    checked={venueNearTabRoom}
                    onChange={(e) => setVenueNearTabRoom(e.target.checked)}
                  />
                  <label htmlFor={`${baseId}-venue-near`}>
                    {t("participants.venue.nearTabRoom")}
                  </label>
                </div>
              </div>

              <div className="simpletab-actions">
                <button type="submit" className="theia-button">
                  {editingVenueId ? t("common.save") : t("common.add")}
                </button>
                {editingVenueId ? (
                  <button
                    type="button"
                    className="theia-button secondary"
                    onClick={resetVenueForm}
                  >
                    {t("common.cancel")}
                  </button>
                ) : null}
              </div>
            </form>
          </section>

          {state.venues.length === 0 ? (
            <p className="simpletab-empty">{t("participants.venue.empty")}</p>
          ) : (
            <div className="simpletab-table-wrap">
              <table className="simpletab-table">
                <caption>{t("participants.venue.tableCaption")}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("participants.venue.name")}</th>
                    <th scope="col">{t("participants.venue.priority")}</th>
                    <th scope="col">{t("participants.venue.category")}</th>
                    <th scope="col">{t("participants.adj.flagsCol")}</th>
                    <th scope="col">{t("participants.actionsCol")}</th>
                  </tr>
                </thead>
                <tbody>
                  {state.venues.map((venue) => (
                    <tr key={venue.id}>
                      <td>{venue.name}</td>
                      <td>{venue.priority}</td>
                      <td>{venue.category ?? t("common.none")}</td>
                      <td>
                        <span
                          className={`simpletab-badge ${
                            venue.available !== false
                              ? "simpletab-badge-add"
                              : "simpletab-badge-error"
                          }`}
                        >
                          {venue.available !== false
                            ? t("participants.venue.statusAvailable")
                            : t("participants.venue.statusUnavailable")}
                        </span>
                      </td>
                      <td className="simpletab-actions">
                        <button
                          type="button"
                          className="theia-button secondary"
                          aria-label={`${t("common.edit")} ${venue.name}`}
                          onClick={() => {
                            setEditingVenueId(venue.id);
                            setVenueName(venue.name);
                            setVenuePriority(String(venue.priority));
                            setVenueCategory(venue.category ?? "");
                            setVenueCapacity(
                              venue.capacity !== undefined ? String(venue.capacity) : "",
                            );
                            setVenueAccessible(venue.accessible === true);
                            setVenueOnline(venue.online === true);
                            setVenueNearTabRoom(venue.nearTabRoom === true);
                            setVenueAvailable(venue.available !== false);
                          }}
                        >
                          {t("common.edit")}
                        </button>
                        <button
                          type="button"
                          className="theia-button secondary"
                          aria-label={`${t("common.delete")} ${venue.name}`}
                          onClick={() => {
                            void handleDelete({
                              type: "venue.delete",
                              payload: { venueId: venue.id },
                            });
                          }}
                        >
                          {t("common.delete")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}

      {activeTab === "conflicts" ? (
        <div
          id={`${baseId}-panel-conflicts`}
          role="tabpanel"
          aria-labelledby={`${baseId}-tab-conflicts`}
        >
          <section className="simpletab-section">
            <h2 className="simpletab-subtitle">{t("participants.conflict.adjTitle")}</h2>
            <form
              className="simpletab-form"
              onSubmit={(e) => {
                void handleSaveAdjConflicts(e);
              }}
            >
              <div className="simpletab-field">
                <label htmlFor={`${baseId}-conflict-adj`}>
                  {t("participants.conflict.selectAdj")}
                </label>
                <select
                  id={`${baseId}-conflict-adj`}
                  value={conflictAdjId}
                  onChange={(e) => loadAdjConflicts(e.target.value)}
                >
                  <option value="">{t("participants.conflict.chooseAdj")}</option>
                  {state.adjudicators.map((adj) => (
                    <option key={adj.id} value={adj.id}>
                      {adj.name}
                    </option>
                  ))}
                </select>
              </div>

              {selectedConflictAdj !== undefined ? (
                <div className="simpletab-form-grid">
                  <fieldset className="simpletab-fieldset">
                    <legend>{t("participants.conflict.conflictedTeams")}</legend>
                    <div className="simpletab-checklist">
                      {state.teams.map((team) => (
                        <div key={team.id} className="simpletab-checkbox-item">
                          <input
                            id={`${baseId}-c-team-${team.id}`}
                            type="checkbox"
                            checked={conflictTeamIds.includes(team.id)}
                            onChange={() =>
                              toggleSelection(
                                conflictTeamIds,
                                team.id,
                                setConflictTeamIds,
                              )
                            }
                          />
                          <label htmlFor={`${baseId}-c-team-${team.id}`}>
                            {team.name}
                          </label>
                        </div>
                      ))}
                    </div>
                  </fieldset>

                  <fieldset className="simpletab-fieldset">
                    <legend>{t("participants.conflict.conflictedAdjs")}</legend>
                    <div className="simpletab-checklist">
                      {state.adjudicators
                        .filter((other) => other.id !== selectedConflictAdj.id)
                        .map((other) => (
                          <div key={other.id} className="simpletab-checkbox-item">
                            <input
                              id={`${baseId}-c-adj-${other.id}`}
                              type="checkbox"
                              checked={conflictAdjIds.includes(other.id)}
                              onChange={() =>
                                toggleSelection(
                                  conflictAdjIds,
                                  other.id,
                                  setConflictAdjIds,
                                )
                              }
                            />
                            <label htmlFor={`${baseId}-c-adj-${other.id}`}>
                              {other.name}
                            </label>
                          </div>
                        ))}
                    </div>
                  </fieldset>

                  <fieldset className="simpletab-fieldset">
                    <legend>{t("participants.conflict.conflictedInsts")}</legend>
                    <div className="simpletab-checklist">
                      {state.institutions
                        .filter((inst) => inst.id !== selectedConflictAdj.institutionId)
                        .map((inst) => (
                          <div key={inst.id} className="simpletab-checkbox-item">
                            <input
                              id={`${baseId}-c-inst-${inst.id}`}
                              type="checkbox"
                              checked={conflictInstIds.includes(inst.id)}
                              onChange={() =>
                                toggleSelection(
                                  conflictInstIds,
                                  inst.id,
                                  setConflictInstIds,
                                )
                              }
                            />
                            <label htmlFor={`${baseId}-c-inst-${inst.id}`}>
                              {inst.name}
                            </label>
                          </div>
                        ))}
                    </div>
                  </fieldset>
                </div>
              ) : null}

              <div className="simpletab-actions">
                <button
                  type="submit"
                  className="theia-button"
                  disabled={!conflictAdjId}
                >
                  {t("participants.conflict.saveAdj")}
                </button>
              </div>
            </form>
          </section>

          <section className="simpletab-section">
            <h2 className="simpletab-subtitle">{t("participants.conflict.teamTitle")}</h2>
            <form
              className="simpletab-form"
              onSubmit={(e) => {
                void handleSaveTeamConflicts(e);
              }}
            >
              <div className="simpletab-field">
                <label htmlFor={`${baseId}-conflict-team`}>
                  {t("participants.conflict.selectTeam")}
                </label>
                <select
                  id={`${baseId}-conflict-team`}
                  value={conflictSubjectTeamId}
                  onChange={(e) => loadTeamConflicts(e.target.value)}
                >
                  <option value="">{t("participants.conflict.chooseTeam")}</option>
                  {state.teams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
                </select>
              </div>

              {conflictSubjectTeamId ? (
                <fieldset className="simpletab-fieldset">
                  <legend>{t("participants.conflict.teamInsts")}</legend>
                  <div className="simpletab-checklist">
                    {state.institutions.map((inst) => (
                      <div key={inst.id} className="simpletab-checkbox-item">
                        <input
                          id={`${baseId}-tc-inst-${inst.id}`}
                          type="checkbox"
                          checked={conflictSubjectTeamInstIds.includes(inst.id)}
                          onChange={() =>
                            toggleSelection(
                              conflictSubjectTeamInstIds,
                              inst.id,
                              setConflictSubjectTeamInstIds,
                            )
                          }
                        />
                        <label htmlFor={`${baseId}-tc-inst-${inst.id}`}>
                          {inst.name}
                        </label>
                      </div>
                    ))}
                  </div>
                </fieldset>
              ) : null}

              <div className="simpletab-actions">
                <button
                  type="submit"
                  className="theia-button"
                  disabled={!conflictSubjectTeamId}
                >
                  {t("participants.conflict.saveTeam")}
                </button>
              </div>
            </form>
          </section>

          <section className="simpletab-section">
            <h2 className="simpletab-subtitle">
              {t("participants.conflict.summaryTitle")}
            </h2>
            {conflictRows.length === 0 ? (
              <p className="simpletab-empty">{t("participants.conflict.empty")}</p>
            ) : (
              <div className="simpletab-table-wrap">
                <table className="simpletab-table">
                  <caption>{t("participants.conflict.tableCaption")}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t("participants.conflict.subjectCol")}</th>
                      <th scope="col">{t("participants.conflict.typeCol")}</th>
                      <th scope="col">{t("participants.conflict.targetsCol")}</th>
                      <th scope="col">{t("participants.actionsCol")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {conflictRows.map((row) => (
                      <tr key={row.key}>
                        <td>{row.subject}</td>
                        <td>
                          {row.kind === "adj"
                            ? t("participants.conflict.kindAdj")
                            : t("participants.conflict.kindTeam")}
                        </td>
                        <td>{row.targets}</td>
                        <td>
                          <button
                            type="button"
                            className="theia-button secondary"
                            aria-label={`${t("common.edit")} ${row.subject}`}
                            onClick={() => {
                              if (row.kind === "adj") {
                                loadAdjConflicts(row.id);
                              } else {
                                loadTeamConflicts(row.id);
                              }
                            }}
                          >
                            {t("common.edit")}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
};
