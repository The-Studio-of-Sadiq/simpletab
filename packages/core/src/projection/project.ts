import { hasPermission, type Role } from "@/permissions";
import { isDrawPubliclyReleased } from "@/lib/draw/drawStatus";
import {
  infoSlidesVisible,
  motionsVisible,
} from "@/features/tournament/application/motionRelease";
import { hasInfoSlide } from "@/lib/motions/infoSlideMedia";
import {
  getPublicRelease,
  isAnyTabReleased,
  isTabRound,
  redactUnreleasedBreak,
  type PublicRelease,
} from "@/lib/publicRelease";
import type {
  Adjudicator,
  BallotSubmission,
  BreakCategory,
  Coach,
  Debate,
  DebateSide,
  DebateTeamSlot,
  FeedbackSubmission,
  Institution,
  Motion,
  Round,
  Speaker,
  Team,
  TeamScoreEntry,
  Tournament,
  Venue,
} from "@/types";

export interface LinkRecord {
  lookupId: string;
  entityId: string;
  secret: string;
}

export interface ProjectableState {
  tournament: Tournament;
  rounds: Round[];
  teams: Team[];
  adjudicators: Adjudicator[];
  institutions: Institution[];
  venues: Venue[];
  debates: Debate[];
  motions: Motion[];
  ballots: BallotSubmission[];
  feedback: FeedbackSubmission[];
  breakCategories: BreakCategory[];
  links?: LinkRecord[];
  registrations?: unknown[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) {
        out[key] = cloneValue(entry);
      }
    }
    return out as T;
  }
  return value;
}

function isDrawReleasedForRound(round: Round, tournament: Tournament): boolean {
  if (round.cancelled === true) return false;
  if (tournament.preferences?.publicDraw === false) return false;
  if (tournament.preferences?.publicDrawMode === "off") return false;
  return isDrawPubliclyReleased(round);
}

function isPanelRevealedForRound(round: Round, tournament: Tournament): boolean {
  return isDrawReleasedForRound(round, tournament) && round.adjudicatorsRevealed === true;
}

function areResultsReleasedForRound(
  round: Round,
  tournament: Tournament,
  release: PublicRelease,
): boolean {
  if (round.cancelled === true) return false;
  if (tournament.preferences?.publicResults === false) return false;
  if (round.resultsReleased === true && round.silent !== true) return true;
  if (release.allResults && round.completed === true) return true;
  return isAnyTabReleased(release) && isTabRound(round);
}

function areSpeaksReleasedForRound(
  round: Round,
  tournament: Tournament,
  release: PublicRelease,
): boolean {
  if (!areResultsReleasedForRound(round, tournament, release)) return false;
  if (round.teamSpeaksReleased === true) return true;
  if (isAnyTabReleased(release) && isTabRound(round)) return true;
  return release.allResults && round.completed === true && release.speakerTab;
}

function projectSpeaker(
  speaker: Speaker,
  canViewContact: boolean,
  canManageLinks: boolean,
): Speaker {
  const cloned = cloneValue(speaker);
  if (!canViewContact) {
    delete cloned.email;
    delete cloned.phone;
  }
  if (!canManageLinks) {
    delete cloned.privateUrlKey;
    delete cloned.privatePasscode;
  }
  return cloned;
}

function projectTeam(
  team: Team,
  options: {
    canViewContact: boolean;
    canManageLinks: boolean;
    canViewConflicts: boolean;
    canViewBreak: boolean;
    release: PublicRelease;
  },
): Team {
  let cloned = cloneValue(team);
  cloned.speakers = cloned.speakers.map((speaker) =>
    projectSpeaker(speaker, options.canViewContact, options.canManageLinks),
  );
  if (!options.canManageLinks) {
    delete cloned.privateUrlKey;
    delete cloned.privatePasscode;
    delete cloned.speakerUrlKeys;
  }
  if (!options.canViewConflicts) {
    delete cloned.institutionConflictIds;
  }
  if (!options.canViewBreak) {
    cloned = redactUnreleasedBreak(cloned, options.release);
  }
  return cloned;
}

function projectAdjudicator(
  adjudicator: Adjudicator,
  options: {
    canViewFeedback: boolean;
    canEditAdjScores: boolean;
    canViewContact: boolean;
    canManageLinks: boolean;
    canViewConflicts: boolean;
    isDisplayOnly: boolean;
    release: PublicRelease;
  },
): Adjudicator {
  const cloned = cloneValue(adjudicator);
  if (!options.canViewContact) {
    delete cloned.email;
    delete cloned.phone;
  }
  if (!options.canManageLinks) {
    delete cloned.privateUrlKey;
    delete cloned.privatePasscode;
  }
  if (!options.canViewConflicts) {
    cloned.conflicts = [];
  }
  if (!options.canViewFeedback) {
    // `baseScore` is required on `Adjudicator`; zero it rather than leaking the real score.
    cloned.baseScore = 0;
    delete cloned.testScore;
    delete cloned.scoreHistory;
    if (!options.canEditAdjScores && !options.release.breakingAdjudicators) {
      delete cloned.breaking;
    }
    if (options.isDisplayOnly && !options.release.adjudicatorCore) {
      delete cloned.adjCore;
    }
  }
  return cloned;
}

function projectInstitution(
  institution: Institution,
  canViewContact: boolean,
  canEditParticipants: boolean,
): Institution {
  const cloned = cloneValue(institution);
  if (!canEditParticipants && !canViewContact) {
    delete cloned.coaches;
  } else if (!canViewContact && Array.isArray(cloned.coaches)) {
    cloned.coaches = cloned.coaches.map((coach): Coach => {
      const next = { ...coach };
      delete next.email;
      return next;
    });
  }
  return cloned;
}

function projectRound(
  round: Round,
  tournament: Tournament,
  canDisplayDraw: boolean,
): Round {
  const cloned = cloneValue(round);
  if (!canDisplayDraw) {
    delete cloned.preformedPanels;
    delete cloned.drawSeed;
    if (
      !isDrawReleasedForRound(round, tournament) &&
      tournament.preferences?.publicSideAllocations !== true
    ) {
      delete cloned.preallocatedSides;
    }
  }
  return cloned;
}

function projectMotions(
  motions: Motion[],
  roundById: ReadonlyMap<string, Round>,
  tournament: Tournament,
  canDisplayMotions: boolean,
): { motions: Motion[]; releasedMotionIds: Set<string> } {
  const publicMotionsEnabled = tournament.preferences?.publicMotions !== false;
  const releasedMotionIds = new Set<string>();

  for (const motion of motions) {
    const roundReleased = (motion.rounds || []).some((roundId) => {
      const round = roundById.get(roundId);
      return Boolean(round && !round.cancelled && motionsVisible(round));
    });
    if (publicMotionsEnabled && (motion.released === true || roundReleased)) {
      releasedMotionIds.add(motion.id);
    }
  }

  if (canDisplayMotions) {
    return {
      motions: motions.map((motion) => cloneValue(motion)),
      releasedMotionIds,
    };
  }

  const projected: Motion[] = [];
  for (const motion of motions) {
    if (releasedMotionIds.has(motion.id)) {
      projected.push(cloneValue(motion));
      continue;
    }
    if (!publicMotionsEnabled || !hasInfoSlide(motion)) {
      continue;
    }
    const infoSlideRoundIds = (motion.rounds || []).filter((roundId) => {
      const round = roundById.get(roundId);
      return Boolean(round && !round.cancelled && infoSlidesVisible(round));
    });
    if (infoSlideRoundIds.length === 0) {
      continue;
    }
    const infoSlideSet = new Set(infoSlideRoundIds);
    const cloned = cloneValue(motion);
    cloned.text = "";
    delete cloned.reference;
    cloned.released = false;
    cloned.rounds = infoSlideRoundIds;
    if (cloned.roundSeq) {
      cloned.roundSeq = Object.fromEntries(
        Object.entries(cloned.roundSeq).filter(([roundId]) => infoSlideSet.has(roundId)),
      );
      if (Object.keys(cloned.roundSeq).length === 0) {
        delete cloned.roundSeq;
      }
    }
    projected.push(cloned);
  }

  return { motions: projected, releasedMotionIds };
}

function isEntityMotionReleased(
  motionId: string | undefined,
  round: Round | undefined,
  tournament: Tournament,
  releasedMotionIds: ReadonlySet<string>,
): boolean {
  if (tournament.preferences?.publicMotions === false) return false;
  if (motionId && releasedMotionIds.has(motionId)) return true;
  if (round && !round.cancelled && motionsVisible(round)) return true;
  return false;
}

function projectDebates(
  debates: Debate[],
  options: {
    tournament: Tournament;
    roundById: ReadonlyMap<string, Round>;
    releasedMotionIds: ReadonlySet<string>;
    release: PublicRelease;
    canDisplayDraw: boolean;
    canDisplayMotions: boolean;
    canViewResults: boolean;
  },
): Debate[] {
  const projected: Debate[] = [];
  for (const debate of debates) {
    const round = options.roundById.get(debate.roundId);
    if (!options.canDisplayDraw) {
      if (!round || !isDrawReleasedForRound(round, options.tournament)) {
        continue;
      }
    }

    const cloned = cloneValue(debate);

    if (
      !options.canDisplayDraw &&
      (!round || !isPanelRevealedForRound(round, options.tournament))
    ) {
      cloned.adjudicators = {
        panellistIds: [],
        panellistNames: [],
        traineeIds: [],
        traineeNames: [],
      };
    }

    if (
      !options.canDisplayMotions &&
      !isEntityMotionReleased(
        debate.motionId,
        round,
        options.tournament,
        options.releasedMotionIds,
      )
    ) {
      delete cloned.motionId;
      delete cloned.motionText;
    }

    const resultsReleased = Boolean(
      round && areResultsReleasedForRound(round, options.tournament, options.release),
    );
    const speaksReleased = Boolean(
      round && areSpeaksReleasedForRound(round, options.tournament, options.release),
    );

    if (!options.canViewResults && !resultsReleased) {
      cloned.resultStatus = "none";
      delete cloned.byeResult;
      const nextTeams = {} as Record<DebateSide, DebateTeamSlot>;
      for (const [side, slot] of Object.entries(cloned.teams)) {
        if (!slot) continue;
        const nextSlot = { ...slot };
        delete nextSlot.points;
        delete nextSlot.speakerScoreTotal;
        nextTeams[side as DebateSide] = nextSlot;
      }
      cloned.teams = nextTeams;
    } else if (!options.canViewResults && !speaksReleased) {
      const nextTeams = {} as Record<DebateSide, DebateTeamSlot>;
      for (const [side, slot] of Object.entries(cloned.teams)) {
        if (!slot) continue;
        const nextSlot = { ...slot };
        delete nextSlot.speakerScoreTotal;
        nextTeams[side as DebateSide] = nextSlot;
      }
      cloned.teams = nextTeams;
    }

    projected.push(cloned);
  }
  return projected;
}

function projectBallots(
  ballots: BallotSubmission[],
  options: {
    tournament: Tournament;
    roundById: ReadonlyMap<string, Round>;
    releasedMotionIds: ReadonlySet<string>;
    release: PublicRelease;
    canDisplayMotions: boolean;
    canViewResults: boolean;
  },
): BallotSubmission[] {
  const projected: BallotSubmission[] = [];
  for (const ballot of ballots) {
    const round = options.roundById.get(ballot.roundId);
    const resultsReleased = Boolean(
      round && areResultsReleasedForRound(round, options.tournament, options.release),
    );
    if (!options.canViewResults) {
      if (!resultsReleased || ballot.confirmed !== true || ballot.discarded === true) {
        continue;
      }
    }

    const cloned = cloneValue(ballot);

    if (
      !options.canDisplayMotions &&
      !isEntityMotionReleased(
        ballot.motionId,
        round,
        options.tournament,
        options.releasedMotionIds,
      )
    ) {
      delete cloned.motionId;
      delete cloned.motionText;
      delete cloned.vetoes;
      delete cloned.motionPreferences;
    }

    const speaksReleased = Boolean(
      round && areSpeaksReleasedForRound(round, options.tournament, options.release),
    );
    if (!options.canViewResults && !speaksReleased) {
      cloned.speakerScores = {} as BallotSubmission["speakerScores"];
      delete cloned.sheets;
      const nextTeamScores = {} as Record<DebateSide, TeamScoreEntry>;
      for (const [side, entry] of Object.entries(cloned.teamScores)) {
        if (!entry) continue;
        const nextEntry: TeamScoreEntry = {
          ...entry,
          totalSpeakerScore: 0,
        };
        delete nextEntry.margin;
        nextTeamScores[side as DebateSide] = nextEntry;
      }
      cloned.teamScores = nextTeamScores;
    }

    projected.push(cloned);
  }
  return projected;
}

/**
 * Pure role projection of tournament state according to section 6 and Appendix C.
 * Never mutates the input state; always returns fresh objects and arrays.
 */
export function project(state: ProjectableState, role: Role): ProjectableState {
  const canViewFeedback = hasPermission(role, "feedback.view");
  const canEditAdjScores = hasPermission(role, "adjudicators.scores_edit");
  const canViewContact = hasPermission(role, "participants.contact");
  const canManageLinks = hasPermission(role, "links.manage");
  const canManageRegistration = hasPermission(role, "registration.manage");
  const canDisplayDraw = hasPermission(role, "draw.display");
  const canDisplayMotions = hasPermission(role, "motions.display");
  const canViewResults =
    hasPermission(role, "results.enter") || hasPermission(role, "standings.view");
  const canViewConflicts = hasPermission(role, "conflicts.view");
  const canViewBreak =
    hasPermission(role, "standings.view") || hasPermission(role, "break.manage");
  const canEditParticipants = hasPermission(role, "participants.edit");
  const isDisplayOnly = role.permissions.length === 0;

  const tournament = cloneValue(state.tournament);
  if (!canViewContact) {
    delete tournament.ownerEmail;
  }
  if (isDisplayOnly) {
    tournament.ownerId = "";
    tournament.admins = {};
  }

  const release = getPublicRelease(state.tournament.preferences);
  const roundById = new Map(state.rounds.map((round) => [round.id, round]));

  const rounds = state.rounds.map((round) =>
    projectRound(round, state.tournament, canDisplayDraw),
  );
  const teams = state.teams.map((team) =>
    projectTeam(team, {
      canViewContact,
      canManageLinks,
      canViewConflicts,
      canViewBreak,
      release,
    }),
  );
  const adjudicators = state.adjudicators.map((adjudicator) =>
    projectAdjudicator(adjudicator, {
      canViewFeedback,
      canEditAdjScores,
      canViewContact,
      canManageLinks,
      canViewConflicts,
      isDisplayOnly,
      release,
    }),
  );
  const institutions = state.institutions.map((institution) =>
    projectInstitution(institution, canViewContact, canEditParticipants),
  );
  const venues = state.venues.map((venue) => cloneValue(venue));

  const { motions, releasedMotionIds } = projectMotions(
    state.motions,
    roundById,
    state.tournament,
    canDisplayMotions,
  );
  const debates = projectDebates(state.debates, {
    tournament: state.tournament,
    roundById,
    releasedMotionIds,
    release,
    canDisplayDraw,
    canDisplayMotions,
    canViewResults,
  });
  const ballots = projectBallots(state.ballots, {
    tournament: state.tournament,
    roundById,
    releasedMotionIds,
    release,
    canDisplayMotions,
    canViewResults,
  });
  const feedback = canViewFeedback
    ? state.feedback.map((entry) => cloneValue(entry))
    : [];
  const breakCategories = state.breakCategories.map((category) => {
    const cloned = cloneValue(category);
    if (!canViewBreak) {
      delete cloned.teamOverrides;
      if (!release.breakCategoryIds.has(category.id)) {
        delete cloned.generatedBreak;
      }
    }
    return cloned;
  });

  return {
    tournament,
    rounds,
    teams,
    adjudicators,
    institutions,
    venues,
    debates,
    motions,
    ballots,
    feedback,
    breakCategories,
    ...(state.links !== undefined
      ? {
          links: canManageLinks
            ? state.links.map((link) => cloneValue(link))
            : [],
        }
      : {}),
    ...(state.registrations !== undefined
      ? {
          registrations: canManageRegistration
            ? state.registrations.map((registration) => cloneValue(registration))
            : [],
        }
      : {}),
  };
}

function stripSpeakerFields(
  record: Record<string, unknown>,
  canViewContact: boolean,
  canManageLinks: boolean,
): Record<string, unknown> {
  const next = { ...record };
  if (!canViewContact) {
    delete next.email;
    delete next.phone;
  }
  if (!canManageLinks) {
    delete next.privateUrlKey;
    delete next.privatePasscode;
  }
  return next;
}

function stripTeamFields(
  record: Record<string, unknown>,
  role: Role,
): Record<string, unknown> {
  const canViewContact = hasPermission(role, "participants.contact");
  const canManageLinks = hasPermission(role, "links.manage");
  const canViewConflicts = hasPermission(role, "conflicts.view");
  const canViewBreak =
    hasPermission(role, "standings.view") || hasPermission(role, "break.manage");

  const next = { ...record };
  if (!canManageLinks) {
    delete next.privateUrlKey;
    delete next.privatePasscode;
    delete next.speakerUrlKeys;
  }
  if (!canViewConflicts) {
    delete next.institutionConflictIds;
  }
  if (!canViewBreak) {
    delete next.breakStatus;
    delete next.breakCategoryIds;
    delete next.eliminatedInRoundId;
  }
  if (Array.isArray(next.speakers)) {
    next.speakers = next.speakers.map((speaker) =>
      isPlainObject(speaker)
        ? stripSpeakerFields(speaker, canViewContact, canManageLinks)
        : speaker,
    );
  }
  if (isPlainObject(next.team)) {
    next.team = stripTeamFields(next.team, role);
  }
  if (Array.isArray(next.teams)) {
    next.teams = next.teams.map((item) =>
      isPlainObject(item) ? stripTeamFields(item, role) : item,
    );
  }
  return next;
}

function stripAdjudicatorFields(
  record: Record<string, unknown>,
  role: Role,
): Record<string, unknown> {
  const canViewFeedback = hasPermission(role, "feedback.view");
  const canViewContact = hasPermission(role, "participants.contact");
  const canManageLinks = hasPermission(role, "links.manage");
  const canViewConflicts = hasPermission(role, "conflicts.view");

  const next = { ...record };
  if (!canViewContact) {
    delete next.email;
    delete next.phone;
  }
  if (!canManageLinks) {
    delete next.privateUrlKey;
    delete next.privatePasscode;
  }
  if (!canViewConflicts && "conflicts" in next) {
    next.conflicts = [];
  }
  if (!canViewFeedback) {
    if ("baseScore" in next) {
      next.baseScore = 0;
    }
    delete next.testScore;
    delete next.scoreHistory;
    delete next.breaking;
  }
  if (isPlainObject(next.adjudicator)) {
    next.adjudicator = stripAdjudicatorFields(next.adjudicator, role);
  }
  if (Array.isArray(next.adjudicators)) {
    next.adjudicators = next.adjudicators.map((item) =>
      isPlainObject(item) ? stripAdjudicatorFields(item, role) : item,
    );
  }
  return next;
}

function stripInstitutionFields(
  record: Record<string, unknown>,
  role: Role,
): Record<string, unknown> {
  const canViewContact = hasPermission(role, "participants.contact");
  const canEditParticipants = hasPermission(role, "participants.edit");
  const next = { ...record };

  if (!canEditParticipants && !canViewContact) {
    delete next.coaches;
  } else if (!canViewContact && Array.isArray(next.coaches)) {
    next.coaches = next.coaches.map((coach) => {
      if (!isPlainObject(coach)) return coach;
      const cleaned = { ...coach };
      delete cleaned.email;
      return cleaned;
    });
  }
  if (isPlainObject(next.institution)) {
    next.institution = stripInstitutionFields(next.institution, role);
  }
  return next;
}

function stripBallotFields(
  record: Record<string, unknown>,
  role: Role,
): Record<string, unknown> {
  const canDisplayMotions = hasPermission(role, "motions.display");
  const next = { ...record };
  if (!canDisplayMotions) {
    delete next.motionId;
    delete next.motionText;
    delete next.vetoes;
    delete next.motionPreferences;
  }
  if (isPlainObject(next.ballot)) {
    next.ballot = stripBallotFields(next.ballot, role);
  }
  return next;
}

function stripRoundFields(
  record: Record<string, unknown>,
  role: Role,
): Record<string, unknown> {
  const next = { ...record };
  if (!hasPermission(role, "draw.display")) {
    delete next.preformedPanels;
    delete next.drawSeed;
    delete next.preallocatedSides;
  }
  if (isPlainObject(next.round)) {
    next.round = stripRoundFields(next.round, role);
  }
  return next;
}

function isOpObject(value: unknown): value is { type: string; payload: unknown } {
  return (
    isPlainObject(value) &&
    typeof value.type === "string" &&
    "payload" in value
  );
}

/**
 * Projects a single operation for a role. Returns `null` when the role may not see the
 * operation at all, or a new copy with restricted payload fields stripped.
 */
export function projectOp<T extends { type: string; payload: unknown }>(
  op: T,
  role: Role,
): T | null {
  const cloned = cloneValue(op);
  const { type } = cloned;
  const hasAnyStaffPermission = role.permissions.length > 0;

  if (type.startsWith("feedback.")) {
    return hasPermission(role, "feedback.view") ? cloned : null;
  }
  if (type === "adjudicator.update_scores") {
    return hasPermission(role, "feedback.view") ? cloned : null;
  }
  if (type.startsWith("conflict.")) {
    return hasPermission(role, "conflicts.view") ? cloned : null;
  }
  if (type.startsWith("private_urls.") || type.startsWith("links.")) {
    return hasPermission(role, "links.manage") ? cloned : null;
  }
  if (type.startsWith("registration.")) {
    return hasPermission(role, "registration.manage") ? cloned : null;
  }
  if (type.startsWith("device.")) {
    return hasPermission(role, "devices.manage") ? cloned : null;
  }
  if (type.startsWith("roles.")) {
    return hasPermission(role, "roles.manage") ? cloned : null;
  }
  if (type.startsWith("host.")) {
    return hasPermission(role, "host.promote") ||
      hasPermission(role, "host.promote_others")
      ? cloned
      : null;
  }
  if (type === "draw.release" || type === "draw.unrelease") {
    return cloned;
  }
  if (type === "draw.release_teams") {
    return hasPermission(role, "draw.display") || hasPermission(role, "draw.release")
      ? cloned
      : null;
  }
  if (type.startsWith("draw.") || type.startsWith("allocation.")) {
    return hasPermission(role, "draw.display") ? cloned : null;
  }
  if (type === "motion.set_round_status") {
    return cloned;
  }
  if (type.startsWith("motion.")) {
    return hasPermission(role, "motions.display") ? cloned : null;
  }
  if (type === "ballot.intake_record") {
    return hasPermission(role, "ballots.intake") ||
      hasPermission(role, "results.enter") ||
      hasPermission(role, "standings.view")
      ? cloned
      : null;
  }
  if (type.startsWith("ballot.")) {
    if (
      !hasPermission(role, "results.enter") &&
      !hasPermission(role, "standings.view")
    ) {
      return null;
    }
    if (isPlainObject(cloned.payload)) {
      cloned.payload = stripBallotFields(cloned.payload, role);
    }
    return cloned;
  }
  if (type.startsWith("break.") || type.startsWith("elimination.")) {
    return hasPermission(role, "standings.view") ||
      hasPermission(role, "break.manage")
      ? cloned
      : null;
  }
  if (type.startsWith("release.")) {
    return cloned;
  }
  if (
    type.startsWith("team.") ||
    type.startsWith("swing.") ||
    type.startsWith("speaker.")
  ) {
    if (!hasAnyStaffPermission) return null;
    if (isPlainObject(cloned.payload)) {
      cloned.payload = stripTeamFields(cloned.payload, role);
    }
    return cloned;
  }
  if (type.startsWith("adjudicator.")) {
    if (!hasAnyStaffPermission) return null;
    if (isPlainObject(cloned.payload)) {
      cloned.payload = stripAdjudicatorFields(cloned.payload, role);
    }
    return cloned;
  }
  if (type.startsWith("institution.")) {
    if (!hasAnyStaffPermission) return null;
    if (isPlainObject(cloned.payload)) {
      cloned.payload = stripInstitutionFields(cloned.payload, role);
    }
    return cloned;
  }
  if (type.startsWith("round.")) {
    if (!hasAnyStaffPermission) return null;
    if (isPlainObject(cloned.payload)) {
      cloned.payload = stripRoundFields(cloned.payload, role);
    }
    return cloned;
  }
  if (
    type.startsWith("venue.") ||
    type.startsWith("checkin.") ||
    type.startsWith("settings.")
  ) {
    return hasAnyStaffPermission ? cloned : null;
  }
  if (type.startsWith("proposal.")) {
    if (!hasAnyStaffPermission) return null;
    if (isPlainObject(cloned.payload) && isOpObject(cloned.payload.op)) {
      const projectedInner = projectOp(cloned.payload.op, role);
      if (!projectedInner) return null;
      cloned.payload = { ...cloned.payload, op: projectedInner };
    }
    return cloned;
  }

  return hasPermission(role, "changelog.view_private") ? cloned : null;
}
