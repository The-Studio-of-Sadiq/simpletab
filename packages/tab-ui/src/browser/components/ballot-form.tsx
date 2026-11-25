import {
  blankEntry,
  roundMotions,
  sheetsFromPortalBallots,
  type BallotCheckState,
} from "@simpletab/core/features/tournament/application/ballotEntry";
import {
  cleanScore,
  criteriaForSpeech,
  motionsEnabled,
  replyScoreStep,
  scoreCriteriaFor,
  speakerRanksFor,
  weightedCriteriaScore,
  winnerDeclarationFor,
} from "@simpletab/core/lib/ballots/ballotRules";
import { votingAdjudicatorIds } from "@simpletab/core/lib/ballots/individualBallots";
import {
  applyScoreCriteria,
  buildBallotResult,
  debateBallotRules,
  isReplyEntry,
  markGhostSpeeches,
  replySpeechesEnabled,
  rulesSides,
  selfSplitAllowed,
  sheetOutcome,
  substantiveSpeakerCount,
  teamSpeakerTotal,
  usesSpeakerScores,
  usesVotingBallots,
  type BallotDifference,
  type BallotEntry,
  type BallotResult,
  type SideRecord,
} from "@simpletab/core/lib/ballots/result";
import { isTwoTeamFormat } from "@simpletab/core/lib/debateSides";
import { sidesChosenOnBallot } from "@simpletab/core/lib/draw/manualSides";
import { assignTwoTeamRank } from "@simpletab/core/lib/scoring/validator";
import { sideLabel } from "@simpletab/core/lib/sideNames";
import type { OpRound } from "@simpletab/core/ops";
import type {
  AdjudicatorSheet,
  Debate,
  DebateSide,
  Speaker,
  SpeakerScoreEntry,
} from "@simpletab/core/types";
import type {
  ProjectedState,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import * as React from "@theia/core/shared/react";
import type { ActionRunner } from "../actions/action";
import {
  ballotValidationErrors,
  buildBallotSubmission,
  enterBallotAction,
} from "../actions/results-actions";
import { t } from "../i18n";
import { InlineOpError, type InlineOpErrorData } from "./inline-op-error";

export interface BallotSubmitOutcome {
  entry: BallotEntry;
  result: BallotResult;
  confirmNow: boolean;
  submit: SubmitResult;
  blindDiffs: readonly BallotDifference[];
  checkStateKind: BallotCheckState["kind"];
  confirmed: boolean;
}

export interface BallotFormProps {
  state: ProjectedState;
  round: OpRound;
  debate: Debate;
  initialEntry?: BallotEntry;
  checkState: BallotCheckState;
  actorId?: string;
  nowIso?: string;
  run: ActionRunner;
  onComplete?: (outcome: BallotSubmitOutcome) => void;
}

function buildRosters(
  state: ProjectedState,
  debate: Debate,
): SideRecord<Speaker[]> {
  const teamById = new Map(state.teams.map((team) => [team.id, team]));
  const rosters: SideRecord<Speaker[]> = {};
  for (const [side, slot] of Object.entries(debate.teams)) {
    if (!slot?.teamId) {
      continue;
    }
    rosters[side as DebateSide] = teamById.get(slot.teamId)?.speakers ?? [];
  }
  return rosters;
}

function teamIdsOf(
  debate: Debate,
  sides: readonly DebateSide[],
): SideRecord<string> {
  const result: SideRecord<string> = {};
  for (const side of sides) {
    result[side] = debate.teams[side]?.teamId ?? "";
  }
  return result;
}

export const BallotForm: React.FC<BallotFormProps> = ({
  state,
  round,
  debate,
  initialEntry,
  checkState,
  actorId,
  nowIso,
  run,
  onComplete,
}) => {
  const baseId = React.useId();
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<InlineOpErrorData | null>(null);
  const rules = React.useMemo(
    () => debateBallotRules(state.tournament, round, debate, state.rounds),
    [state.tournament, round, debate, state.rounds],
  );
  const sides = React.useMemo(() => rulesSides(rules), [rules]);
  const rosters = React.useMemo(() => buildRosters(state, debate), [state, debate]);
  const teamIds = React.useMemo(() => teamIdsOf(debate, sides), [debate, sides]);

  const [entry, setEntry] = React.useState<BallotEntry>(() =>
    initialEntry ?? blankEntry(debate, rosters, state.adjudicators, rules),
  );

  React.useEffect(() => {
    setEntry(
      initialEntry ?? blankEntry(debate, rosters, state.adjudicators, rules),
    );
  }, [debate.id, initialEntry, checkState.kind]);

  const prefs = state.tournament.preferences;
  const substantiveCount = substantiveSpeakerCount(rules);
  const hasReply = replySpeechesEnabled(rules);
  const voting = usesVotingBallots(rules);
  const scored = usesSpeakerScores(rules);
  const criteria = scoreCriteriaFor(prefs);
  const speechRanksMode = speakerRanksFor(prefs);
  const winnerMode = winnerDeclarationFor(prefs);
  const twoTeam = isTwoTeamFormat(rules.format);
  const motionsOn = motionsEnabled(prefs);
  const availableMotions = React.useMemo(
    () => roundMotions(state.motions, round.id),
    [state.motions, round.id],
  );
  const votingAdjIds = React.useMemo(() => votingAdjudicatorIds(debate), [debate]);
  const selfSplitOk = selfSplitAllowed(rules, votingAdjIds.length);

  const portalSheetsResult = React.useMemo(() => {
    if (!voting || !entry.sheets) {
      return { sheets: entry.sheets ?? [], filled: 0 };
    }
    return sheetsFromPortalBallots(entry.sheets, state.ballots, debate.id);
  }, [voting, entry.sheets, state.ballots, debate.id]);

  const validationErrors = React.useMemo(
    () => ballotValidationErrors(state, round, debate, entry),
    [state, round, debate, entry],
  );

  const updateSideSpeeches = (
    side: DebateSide,
    updater: (list: SpeakerScoreEntry[]) => SpeakerScoreEntry[],
  ): void => {
    setEntry((prev) => {
      const currentList = prev.speakerScores[side] ?? [];
      const updated = markGhostSpeeches(
        applyScoreCriteria(updater(currentList), rules),
        rules,
      );
      return {
        ...prev,
        speakerScores: {
          ...prev.speakerScores,
          [side]: updated,
        },
      };
    });
  };

  const updateSheetSpeeches = (
    sheetIdx: number,
    side: DebateSide,
    updater: (list: SpeakerScoreEntry[]) => SpeakerScoreEntry[],
  ): void => {
    setEntry((prev) => {
      const sheets = [...(prev.sheets ?? [])];
      const target = sheets[sheetIdx];
      if (!target) {
        return prev;
      }
      const currentList = target.speakerScores[side] ?? [];
      const updated = markGhostSpeeches(
        applyScoreCriteria(updater(currentList), rules),
        rules,
      );
      sheets[sheetIdx] = {
        ...target,
        speakerScores: {
          ...target.speakerScores,
          [side]: updated,
        },
      };
      return { ...prev, sheets };
    });
  };

  const renderSpeechRows = (
    side: DebateSide,
    speeches: SpeakerScoreEntry[],
    onUpdate: (updater: (list: SpeakerScoreEntry[]) => SpeakerScoreEntry[]) => void,
    scopeKey: string,
  ): React.ReactNode => {
    const roster = rosters[side] ?? [];
    const speakerCounts = new Map<string, number>();
    for (const item of speeches) {
      if (!isReplyEntry(item, rules) && item.speakerId) {
        speakerCounts.set(item.speakerId, (speakerCounts.get(item.speakerId) ?? 0) + 1);
      }
    }

    return (
      <div className="simpletab-ballot-speeches">
        {speeches.map((speech, idx) => {
          const isReply = isReplyEntry(speech, rules);
          const applicableCriteria = criteriaForSpeech(criteria, isReply);
          const min = isReply ? prefs.minReplyScore : prefs.minSpeakerScore;
          const max = isReply ? prefs.maxReplyScore : prefs.maxSpeakerScore;
          const step = isReply
            ? replyScoreStep(prefs)
            : (prefs.stepSpeakerScore ?? 1);
          const label = isReply
            ? t("results.replySpeechLabel")
            : t("results.speakerPositionLabel", { position: speech.position });
          const isDuplicateSpeaker =
            !isReply &&
            speech.speakerId.length > 0 &&
            (speakerCounts.get(speech.speakerId) ?? 0) > 1;
          const speakerSelectId = `${baseId}-${scopeKey}-${side}-spk-${speech.position}`;
          const scoreInputId = `${baseId}-${scopeKey}-${side}-scr-${speech.position}`;
          const rankInputId = `${baseId}-${scopeKey}-${side}-rnk-${speech.position}`;

          return (
            <div key={`${side}-${speech.position}-${idx}`} className="simpletab-ballot-speech-row">
              <div className="simpletab-field">
                <label htmlFor={speakerSelectId}>
                  {`${sideLabel(side, prefs, twoTeam ? "full" : "abbr")} ${label}`}
                </label>
                <select
                  id={speakerSelectId}
                  value={speech.speakerId}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    const found = roster.find((s) => s.id === nextId);
                    onUpdate((list) =>
                      list.map((item, itemIdx) =>
                        itemIdx === idx
                          ? {
                              ...item,
                              speakerId: nextId,
                              speakerName: found?.name ?? "",
                            }
                          : item,
                      ),
                    );
                  }}
                >
                  <option value="">{t("results.selectSpeakerOption")}</option>
                  {roster.map((spk) => (
                    <option key={spk.id} value={spk.id}>
                      {spk.name}
                    </option>
                  ))}
                </select>
              </div>

              {applicableCriteria.length > 0 ? (
                <div className="simpletab-ballot-criteria">
                  {applicableCriteria.map((criterion) => {
                    const critId = `${baseId}-${scopeKey}-${side}-c-${speech.position}-${criterion.id}`;
                    const critVal = speech.criteria?.[criterion.id];
                    return (
                      <div key={criterion.id} className="simpletab-field">
                        <label htmlFor={critId}>
                          {`${criterion.name} (${criterion.minScore}-${criterion.maxScore})`}
                        </label>
                        <input
                          id={critId}
                          type="number"
                          min={criterion.minScore}
                          max={criterion.maxScore}
                          step={criterion.step}
                          value={
                            typeof critVal === "number" && Number.isFinite(critVal)
                              ? String(critVal)
                              : ""
                          }
                          onChange={(e) => {
                            const raw = e.target.value;
                            const num = raw === "" ? Number.NaN : Number(raw);
                            onUpdate((list) =>
                              list.map((item, itemIdx) => {
                                if (itemIdx !== idx) {
                                  return item;
                                }
                                const nextCriteria = { ...(item.criteria ?? {}) };
                                if (Number.isFinite(num)) {
                                  nextCriteria[criterion.id] = num;
                                } else {
                                  delete nextCriteria[criterion.id];
                                }
                                return {
                                  ...item,
                                  criteria: nextCriteria,
                                  score: weightedCriteriaScore(
                                    applicableCriteria,
                                    nextCriteria,
                                  ),
                                };
                              }),
                            );
                          }}
                        />
                      </div>
                    );
                  })}
                  <div className="simpletab-hint">
                    {t("results.speechWeightedTotal", {
                      score: Number.isFinite(speech.score)
                        ? cleanScore(speech.score)
                        : "—",
                    })}
                  </div>
                </div>
              ) : (
                <div className="simpletab-field">
                  <label htmlFor={scoreInputId}>
                    {`${sideLabel(side, prefs, twoTeam ? "full" : "abbr")} ${label} ${t("results.scoreLabel")}`}
                  </label>
                  <input
                    id={scoreInputId}
                    type="number"
                    min={min}
                    max={max}
                    step={step}
                    value={Number.isFinite(speech.score) ? String(speech.score) : ""}
                    onChange={(e) => {
                      const raw = e.target.value;
                      const num = raw === "" ? Number.NaN : Number(raw);
                      onUpdate((list) =>
                        list.map((item, itemIdx) =>
                          itemIdx === idx ? { ...item, score: num } : item,
                        ),
                      );
                    }}
                  />
                </div>
              )}

              {!isReply && speechRanksMode !== "none" ? (
                <div className="simpletab-field">
                  <label htmlFor={rankInputId}>
                    {t("results.speechRankLabel")}
                  </label>
                  <input
                    id={rankInputId}
                    type="number"
                    min={1}
                    max={sides.length * substantiveCount}
                    step={1}
                    value={
                      typeof speech.rank === "number" &&
                      Number.isFinite(speech.rank)
                        ? String(speech.rank)
                        : ""
                    }
                    onChange={(e) => {
                      const raw = e.target.value;
                      const num = raw === "" ? undefined : Number(raw);
                      onUpdate((list) =>
                        list.map((item, itemIdx) =>
                          itemIdx === idx
                            ? {
                                ...item,
                                ...(num !== undefined && Number.isFinite(num)
                                  ? { rank: num }
                                  : { rank: undefined }),
                              }
                            : item,
                        ),
                      );
                    }}
                  />
                </div>
              ) : null}

              {isDuplicateSpeaker ? (
                <label className="simpletab-checkbox-item">
                  <input
                    type="checkbox"
                    checked={speech.ghost === true}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      onUpdate((list) =>
                        list.map((item, itemIdx) => {
                          if (itemIdx !== idx) {
                            if (
                              checked &&
                              item.speakerId === speech.speakerId &&
                              !isReplyEntry(item, rules)
                            ) {
                              return { ...item, ghost: false };
                            }
                            return item;
                          }
                          return { ...item, ghost: checked };
                        }),
                      );
                    }}
                  />
                  <span>{t("results.ghostSpeechLabel")}</span>
                </label>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  };

  const handleSubmit = async (
    event: React.FormEvent,
    confirmNow: boolean,
  ): Promise<void> => {
    event.preventDefault();
    setSubmitError(null);
    if (validationErrors.length > 0 || submitting) {
      return;
    }
    const result = buildBallotResult(
      entry,
      teamIds,
      debate.adjudicators.chairId,
      rules,
    );
    const { ballot, blindDiffs } = buildBallotSubmission(
      state,
      round,
      debate,
      entry,
      result,
      { now: nowIso ?? new Date().toISOString(), actorId, confirmNow },
    );
    setSubmitting(true);
    try {
      const submit = await run(enterBallotAction, {
        roundId: round.id,
        debateId: debate.id,
        entry,
        result,
        now: ballot.timestamp,
        actorId,
        confirmNow,
      });
      if (!submit.ok) {
        setSubmitError({
          code: submit.code,
          errors: submit.errors,
          current: submit.current,
        });
        return;
      }
      onComplete?.({
        entry,
        result,
        confirmNow,
        submit,
        blindDiffs,
        checkStateKind: checkState.kind,
        confirmed: ballot.confirmed,
      });
    } finally {
      setSubmitting(false);
    }
  };

  const canConfirmOnSubmit = checkState.kind === "single";
  const twoTeamDeclaredWinner =
    sides.find((side) => entry.ranks?.[side] === 1) ?? "";
  const isForfeit = Boolean(entry.forfeitSide);

  return (
    <form
      className="simpletab-form simpletab-ballot-form"
      onSubmit={(e) => void handleSubmit(e, false)}
    >
      {prefs.ballotIntroExplanation ? (
        <div className="simpletab-hint">{prefs.ballotIntroExplanation}</div>
      ) : null}

      {motionsOn && availableMotions.length > 0 ? (
        <div className="simpletab-form-grid">
          <div className="simpletab-field">
            <label htmlFor={`${baseId}-motion`}>
              {t("results.motionDebatedLabel")}
            </label>
            <select
              id={`${baseId}-motion`}
              value={entry.motionId ?? ""}
              onChange={(e) =>
                setEntry((prev) => ({ ...prev, motionId: e.target.value }))
              }
            >
              <option value="">{t("results.selectMotionOption")}</option>
              {availableMotions.map((motion) => (
                <option key={motion.id} value={motion.id}>
                  {motion.reference
                    ? `${motion.reference}: ${motion.text}`
                    : motion.text}
                </option>
              ))}
            </select>
          </div>

          {prefs.enableMotionVetoes === true ? (
            <div className="simpletab-field">
              <span className="simpletab-hint">{t("results.vetoesLabel")}</span>
              <div className="simpletab-form-grid">
                {sides.map((side) => (
                  <div key={side} className="simpletab-field">
                    <label htmlFor={`${baseId}-veto-${side}`}>
                      {t("results.sideVetoLabel", {
                        side: sideLabel(side, prefs, twoTeam ? "full" : "abbr"),
                      })}
                    </label>
                    <select
                      id={`${baseId}-veto-${side}`}
                      value={entry.vetoes?.[side] ?? ""}
                      onChange={(e) =>
                        setEntry((prev) => ({
                          ...prev,
                          vetoes: {
                            ...(prev.vetoes ?? {}),
                            [side]: e.target.value,
                          },
                        }))
                      }
                    >
                      <option value="">{t("common.none")}</option>
                      {availableMotions.map((motion) => (
                        <option key={motion.id} value={motion.id}>
                          {motion.reference || motion.text}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {twoTeam && prefs.enableForfeits === true ? (
        <div className="simpletab-field">
          <label htmlFor={`${baseId}-forfeit`}>
            {t("results.forfeitLabel")}
          </label>
          <select
            id={`${baseId}-forfeit`}
            value={entry.forfeitSide ?? ""}
            onChange={(e) => {
              const val = e.target.value as DebateSide | "";
              setEntry((prev) => {
                const next = { ...prev };
                if (val) {
                  next.forfeitSide = val;
                } else {
                  delete next.forfeitSide;
                }
                return next;
              });
            }}
          >
            <option value="">{t("results.noForfeitOption")}</option>
            {sides.map((side) => (
              <option key={side} value={side}>
                {t("results.sideForfeitedOption", {
                  side: sideLabel(side, prefs, "full"),
                  team: debate.teams[side]?.teamName ?? side,
                })}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {!isForfeit && voting ? (
        <div className="simpletab-ballot-sheets">
          <div className="simpletab-toolbar">
            <h3 className="simpletab-subtitle">
              {t("results.votingSheetsTitle", {
                count: (entry.sheets ?? []).length,
              })}
            </h3>
            {portalSheetsResult.filled > 0 ? (
              <button
                type="button"
                className="theia-button secondary"
                data-view-only
                onClick={() => {
                  setEntry((prev) => ({
                    ...prev,
                    sheets: portalSheetsResult.sheets,
                  }));
                }}
              >
                {t("results.loadPortalSheets", {
                  count: portalSheetsResult.filled,
                })}
              </button>
            ) : null}
          </div>

          {selfSplitOk ? (
            <label className="simpletab-checkbox-item">
              <input
                type="checkbox"
                checked={entry.selfSplit === true}
                onChange={(e) =>
                  setEntry((prev) => ({
                    ...prev,
                    selfSplit: e.target.checked,
                  }))
                }
              />
              <span>{t("results.selfSplitLabel")}</span>
            </label>
          ) : null}

          {(entry.sheets ?? []).map((sheet: AdjudicatorSheet, sheetIdx: number) => {
            const outcome = sheetOutcome(sheet, rules);
            const declares = winnerMode !== "none" || !scored;
            return (
              <fieldset key={sheet.adjudicatorId || sheetIdx} className="simpletab-fieldset">
                <legend>
                  {sheet.adjudicatorName ||
                    t("results.sheetFallbackTitle", { index: sheetIdx + 1 })}
                </legend>
                {declares ? (
                  <div className="simpletab-field">
                    <label htmlFor={`${baseId}-sheet-winner-${sheetIdx}`}>
                      {t("results.declaredWinnerLabel")}
                    </label>
                    <select
                      id={`${baseId}-sheet-winner-${sheetIdx}`}
                      value={sheet.declaredWinner ?? ""}
                      onChange={(e) => {
                        const val = e.target.value as DebateSide | "";
                        setEntry((prev) => {
                          const sheets = [...(prev.sheets ?? [])];
                          const current = sheets[sheetIdx];
                          if (!current) {
                            return prev;
                          }
                          sheets[sheetIdx] = {
                            ...current,
                            ...(val ? { declaredWinner: val } : { declaredWinner: undefined }),
                          };
                          return { ...prev, sheets };
                        });
                      }}
                    >
                      <option value="">{t("results.chooseWinnerOption")}</option>
                      {sides.map((side) => (
                        <option key={side} value={side}>
                          {`${sideLabel(side, prefs, "full")} — ${debate.teams[side]?.teamName ?? ""}`}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div className="simpletab-hint">
                    {outcome.winner
                      ? t("results.sheetVoteDerived", {
                          side: sideLabel(outcome.winner, prefs, "full"),
                        })
                      : t("results.sheetVoteTied")}
                  </div>
                )}

                {scored ? (
                  <div className="simpletab-ballot-sides-grid">
                    {sides.map((side) => {
                      const list = sheet.speakerScores[side] ?? [];
                      const total = teamSpeakerTotal(list, rules);
                      return (
                        <div key={side} className="simpletab-ballot-team-card">
                          <div className="simpletab-toolbar">
                            <strong>
                              {`${sideLabel(side, prefs, "full")}: ${debate.teams[side]?.teamName ?? ""}`}
                            </strong>
                            <span className="simpletab-badge">
                              {t("results.teamTotalLabel", {
                                total: Number.isFinite(total) ? cleanScore(total) : 0,
                              })}
                            </span>
                          </div>
                          {renderSpeechRows(
                            side,
                            list,
                            (updater) => updateSheetSpeeches(sheetIdx, side, updater),
                            `sheet-${sheetIdx}`,
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </fieldset>
            );
          })}
        </div>
      ) : null}

      {!isForfeit && !voting ? (
        <>
          {twoTeam && (winnerMode !== "none" || !scored) ? (
            <div className="simpletab-field">
              <label htmlFor={`${baseId}-two-team-winner`}>
                {t("results.declaredWinnerLabel")}
              </label>
              <select
                id={`${baseId}-two-team-winner`}
                value={twoTeamDeclaredWinner}
                onChange={(e) => {
                  const chosen = e.target.value as DebateSide | "";
                  if (!chosen) {
                    return;
                  }
                  setEntry((prev) => ({
                    ...prev,
                    ranks: assignTwoTeamRank(
                      (prev.ranks ?? {}) as Record<string, number>,
                      chosen,
                      1,
                      sides,
                    ),
                  }));
                }}
              >
                <option value="">{t("results.chooseWinnerOption")}</option>
                {sides.map((side) => (
                  <option key={side} value={side}>
                    {`${sideLabel(side, prefs, "full")} — ${debate.teams[side]?.teamName ?? ""}`}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="simpletab-ballot-sides-grid">
            {sides.map((side) => {
              const slot = debate.teams[side];
              const list = entry.speakerScores[side] ?? [];
              const total = scored ? teamSpeakerTotal(list, rules) : 0;
              const rankSelectId = `${baseId}-rank-${side}`;
              const labelSide = sideLabel(side, prefs, twoTeam ? "full" : "abbr");

              return (
                <div key={side} className="simpletab-ballot-team-card">
                  <div className="simpletab-toolbar">
                    <div>
                      <strong>
                        {`${labelSide}: ${slot?.teamName ?? t("results.unknownTeam")}`}
                      </strong>
                    </div>
                    <div className="simpletab-actions">
                      {scored ? (
                        <span className="simpletab-badge">
                          {t("results.teamTotalLabel", {
                            total: Number.isFinite(total) ? cleanScore(total) : 0,
                          })}
                        </span>
                      ) : null}
                      {!twoTeam ? (
                        <div className="simpletab-round-picker">
                          <label htmlFor={rankSelectId}>
                            {t("results.teamRankLabel", { side: labelSide })}
                          </label>
                          <select
                            id={rankSelectId}
                            value={String(entry.ranks?.[side] ?? "")}
                            onChange={(e) => {
                              const nextRank = Number(e.target.value);
                              setEntry((prev) => ({
                                ...prev,
                                ranks: {
                                  ...(prev.ranks ?? {}),
                                  [side]: nextRank,
                                },
                              }));
                            }}
                          >
                            {sides.map((_, rankIdx) => (
                              <option key={rankIdx + 1} value={String(rankIdx + 1)}>
                                {t("results.rankOption", { rank: rankIdx + 1 })}
                              </option>
                            ))}
                          </select>
                        </div>
                      ) : null}
                    </div>
                  </div>

                  {scored
                    ? renderSpeechRows(
                        side,
                        list,
                        (updater) => updateSideSpeeches(side, updater),
                        "consensus",
                      )
                    : null}
                </div>
              );
            })}
          </div>
        </>
      ) : null}

      {twoTeam && sidesChosenOnBallot(debate) ? (
        <div className="simpletab-hint">{t("results.manualSidesHint")}</div>
      ) : null}

      {validationErrors.length > 0 ? (
        <div className="simpletab-alert simpletab-alert-error" role="alert">
          <strong>{t("results.validationErrorsHeading")}</strong>
          <ul className="simpletab-issue-list">
            {validationErrors.map((err, idx) => (
              <li key={idx}>{err}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {submitError !== null ? (
        <InlineOpError error={submitError} onDismiss={() => setSubmitError(null)} />
      ) : null}

      <div className="simpletab-actions">
        <button
          type="submit"
          className="theia-button"
          data-action={enterBallotAction.id}
          disabled={validationErrors.length > 0 || submitting}
        >
          {submitting
            ? t("results.submittingButton")
            : checkState.kind === "blind-check"
              ? t("results.submitBlindCheckButton")
              : t("results.saveDraftButton")}
        </button>

        {canConfirmOnSubmit ? (
          <button
            type="button"
            className="theia-button secondary"
            data-action={enterBallotAction.id}
            disabled={validationErrors.length > 0 || submitting}
            onClick={(e) => {
              void handleSubmit(e, true);
            }}
          >
            {t("results.saveAndConfirmButton")}
          </button>
        ) : null}
      </div>

      {hasReply && scored ? (
        <div className="simpletab-hint">
          {t("results.replyBoundsHint", {
            min: prefs.minReplyScore,
            max: prefs.maxReplyScore,
            step: replyScoreStep(prefs),
          })}
        </div>
      ) : null}
    </form>
  );
};
