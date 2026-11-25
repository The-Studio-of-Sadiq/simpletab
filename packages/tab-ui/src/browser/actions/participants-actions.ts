import {
  adjudicatorConflictIds,
  changeAdjudicatorInstitution,
  extraInstitutionConflictIds,
  teamConflictIds,
} from "@simpletab/core/lib/adjudicators/conflicts";
import type { OpRequest } from "@simpletab/core/ops";
import type { Adjudicator, Institution, Speaker, Team, Venue } from "@simpletab/core/types";
import type { ProjectedState, SubmitResult } from "@simpletab/host/lib/common/host-protocol";
import { t } from "../i18n";
import type { TournamentStoreSnapshot } from "../store/tournament-store";
import type { ActionContext, ActionResult, SimpleTabAction } from "./action";
import { defineAction } from "./action";
import {
  inputNumber,
  inputOptionalNumber,
  inputRequired,
  pickYesNo,
  toggleMany,
} from "./prompt-helpers";

/** Widget id of the Participants page (`ParticipantsWidget.ID`). */
export const PARTICIPANTS_PAGE = "simpletab-participants-widget";

let entityIdCounter = 0;
function makeEntityId(prefix: string): string {
  entityIdCounter += 1;
  return `${prefix}-${Date.now()}-${entityIdCounter}`;
}

type InvalidResult = { ok: false; code: "INVALID"; errors: string[] };

function invalid(...errors: string[]): InvalidResult {
  return { ok: false, code: "INVALID", errors };
}

function noTournament(): InvalidResult {
  return invalid(t("common.noTournamentPrompt"));
}

function isOpen(snapshot: TournamentStoreSnapshot): boolean {
  return snapshot.state !== null;
}

function requiredError(label: string, value: string): string[] {
  return value.trim().length === 0 ? [t("action.prompt.requiredField", { field: label })] : [];
}

async function pickRecord<R extends { id: string; name: string }>(
  ctx: ActionContext,
  records: readonly R[],
  placeholderKey: string,
): Promise<R | undefined> {
  const id = await ctx.prompts.pick(
    records.map((record) => ({ label: record.name, value: record.id })),
    t(placeholderKey),
  );
  return id === undefined ? undefined : records.find((record) => record.id === id);
}

function institutionChoices(state: ProjectedState): Array<{ label: string; value: string }> {
  return [
    { label: t("participants.team.noInstitution"), value: "" },
    ...state.institutions.map((inst) => ({ label: `${inst.name} (${inst.code})`, value: inst.id })),
  ];
}

/** Puts the record's current institution first, so Enter keeps it. */
async function pickInstitution(
  ctx: ActionContext,
  state: ProjectedState,
  label: string,
  current: string | undefined,
): Promise<string | undefined> {
  const choices = institutionChoices(state);
  const index = choices.findIndex((choice) => choice.value === (current ?? ""));
  const ordered = index > 0 ? [choices[index], ...choices.filter((_, i) => i !== index)] : choices;
  return ctx.prompts.pick(ordered, label);
}

// ---------------------------------------------------------------- institutions

export interface InstitutionInput {
  id?: string;
  name: string;
  code: string;
  region?: string;
}

export function institutionInputErrors(input: InstitutionInput): string[] {
  return [
    ...requiredError(t("participants.inst.name"), input.name),
    ...requiredError(t("participants.inst.code"), input.code),
  ];
}

export function buildInstitutionRequest(state: ProjectedState, input: InstitutionInput): OpRequest {
  const existing =
    input.id === undefined ? undefined : state.institutions.find((item) => item.id === input.id);
  const institution: Institution = {
    ...(existing ?? {}),
    id: existing?.id ?? makeEntityId("inst"),
    tournamentId: state.tournament.id,
    name: input.name.trim(),
    code: input.code.trim(),
    ...(input.region?.trim() ? { region: input.region.trim() } : { region: undefined }),
  };
  return {
    type: existing ? "institution.update" : "institution.create",
    payload: { institution },
  };
}

async function askInstitution(
  ctx: ActionContext,
  existing: Institution | undefined,
): Promise<InstitutionInput | undefined> {
  const name = await inputRequired(ctx, t("participants.inst.name"), existing?.name);
  if (name === undefined) return undefined;
  const code = await inputRequired(ctx, t("participants.inst.code"), existing?.code);
  if (code === undefined) return undefined;
  const region = await ctx.prompts.input(t("action.participants.institutionRegion"), {
    value: existing?.region,
    optional: true,
  });
  if (region === undefined) return undefined;
  return { ...(existing ? { id: existing.id } : {}), name, code, region };
}

function submitInstitution(ctx: ActionContext, args: InstitutionInput): Promise<ActionResult> {
  const state = ctx.store.getState();
  if (state === null) return Promise.resolve(noTournament());
  const errors = institutionInputErrors(args);
  if (errors.length > 0) return Promise.resolve(invalid(...errors));
  return ctx.store.submit(buildInstitutionRequest(state, args));
}

export const saveInstitutionAction = defineAction<InstitutionInput>({
  id: "simpletab.participants.add-institution",
  labelKey: "action.participants.saveInstitution",
  page: PARTICIPANTS_PAGE,
  isEnabled: isOpen,
  prompt: (ctx) => askInstitution(ctx, undefined),
  run: submitInstitution,
});

export const updateInstitutionAction = defineAction<InstitutionInput>({
  id: "simpletab.participants.edit-institution",
  labelKey: "action.participants.updateInstitution",
  page: PARTICIPANTS_PAGE,
  isEnabled: (snapshot) => (snapshot.state?.institutions.length ?? 0) > 0,
  prompt: async (ctx) => {
    const state = ctx.store.getState();
    if (state === null) return undefined;
    const existing = await pickRecord(ctx, state.institutions, "action.participants.pickInstitution");
    return existing === undefined ? undefined : askInstitution(ctx, existing);
  },
  run: submitInstitution,
});

// ---------------------------------------------------------------- deletes

type DeletableKind = "institution" | "team" | "adjudicator" | "venue";

export interface DeleteInput {
  id: string;
}

function recordsOf(state: ProjectedState, kind: DeletableKind): ReadonlyArray<{ id: string; name: string }> {
  switch (kind) {
    case "institution":
      return state.institutions;
    case "team":
      return state.teams;
    case "adjudicator":
      return state.adjudicators;
    case "venue":
      return state.venues;
  }
}

function deleteRequest(kind: DeletableKind, id: string): OpRequest {
  switch (kind) {
    case "institution":
      return { type: "institution.delete", payload: { institutionId: id } };
    case "team":
      return { type: "team.delete", payload: { teamId: id } };
    case "adjudicator":
      return { type: "adjudicator.delete", payload: { adjudicatorId: id } };
    case "venue":
      return { type: "venue.delete", payload: { venueId: id } };
  }
}

const PICK_KEY: Record<DeletableKind, string> = {
  institution: "action.participants.pickInstitution",
  team: "action.participants.pickTeam",
  adjudicator: "action.participants.pickAdjudicator",
  venue: "action.participants.pickVenue",
};

function deleteAction(kind: DeletableKind, verb: string, labelKey: string): SimpleTabAction<DeleteInput, SubmitResult> {
  return defineAction<DeleteInput, SubmitResult>({
    id: `simpletab.participants.delete-${verb}`,
    labelKey,
    page: PARTICIPANTS_PAGE,
    isEnabled: (snapshot) =>
      snapshot.state !== null && recordsOf(snapshot.state, kind).length > 0,
    prompt: async (ctx) => {
      const state = ctx.store.getState();
      if (state === null) return undefined;
      const record = await pickRecord(ctx, recordsOf(state, kind), PICK_KEY[kind]);
      if (record === undefined) return undefined;
      const confirmed = await ctx.prompts.confirm(
        t("action.participants.confirmDeleteTitle", { name: record.name }),
        t("action.participants.confirmDeleteMessage"),
      );
      return confirmed ? { id: record.id } : undefined;
    },
    // The page deletes without asking; the host refuses a delete it cannot apply.
    run: (ctx, args) => ctx.store.submit(deleteRequest(kind, args.id)),
  });
}

export const deleteInstitutionAction = deleteAction(
  "institution",
  "institution",
  "action.participants.deleteInstitution",
);
export const deleteTeamAction = deleteAction("team", "team", "action.participants.deleteTeam");
export const deleteAdjudicatorAction = deleteAction(
  "adjudicator",
  "adjudicator",
  "action.participants.deleteAdjudicator",
);
export const deleteVenueAction = deleteAction("venue", "venue", "action.participants.deleteVenue");

// ---------------------------------------------------------------- teams

export interface SpeakerDraft {
  id?: string;
  name: string;
  email?: string;
}

export interface TeamInput {
  id?: string;
  name: string;
  codeName?: string;
  institutionId?: string;
  speakers: SpeakerDraft[];
}

export function teamInputErrors(input: TeamInput): string[] {
  const errors = requiredError(t("participants.team.name"), input.name);
  if (!input.speakers.some((speaker) => speaker.name.trim().length > 0)) {
    errors.push(t("action.prompt.requiredField", { field: t("participants.team.speakerName", { index: 1 }) }));
  }
  return errors;
}

export function buildTeamRequest(state: ProjectedState, input: TeamInput): OpRequest {
  const existing = input.id === undefined ? undefined : state.teams.find((item) => item.id === input.id);
  const institution = input.institutionId
    ? state.institutions.find((item) => item.id === input.institutionId)
    : undefined;
  const speakers: Speaker[] = input.speakers
    .filter((speaker) => speaker.name.trim().length > 0)
    .map((speaker) => {
      const previous = existing?.speakers.find((item) => item.id === speaker.id);
      return {
        ...(previous ?? {}),
        id: speaker.id || makeEntityId("spk"),
        name: speaker.name.trim(),
        ...(speaker.email?.trim() ? { email: speaker.email.trim() } : { email: undefined }),
      };
    });
  const team: Team = {
    ...(existing ?? {}),
    id: existing?.id ?? makeEntityId("team"),
    tournamentId: state.tournament.id,
    name: input.name.trim(),
    ...(input.codeName?.trim() ? { codeName: input.codeName.trim() } : { codeName: undefined }),
    institutionId: institution?.id,
    institutionName: institution?.name,
    speakers,
    breakCategories: existing?.breakCategories ?? [],
    speakerCategories: existing?.speakerCategories ?? [],
    checkedIn: existing?.checkedIn ?? true,
  };
  return { type: existing ? "team.update" : "team.create", payload: { team } };
}

/**
 * Asks each speaker's name and email, as the team form does: the format's number of speakers,
 * or more when the team already has more. A blank name leaves that speaker out, as on the page.
 */
async function askSpeakers(
  ctx: ActionContext,
  state: ProjectedState,
  existing: Team | undefined,
): Promise<SpeakerDraft[] | undefined> {
  const count = Math.max(1, state.tournament.preferences.substantiveSpeakers, existing?.speakers.length ?? 0);
  const drafts: SpeakerDraft[] = [];
  for (let index = 0; index < count; index += 1) {
    const previous = existing?.speakers[index];
    const label = t("participants.team.speakerName", { index: index + 1 });
    const name =
      index === 0
        ? await inputRequired(ctx, label, previous?.name)
        : await ctx.prompts.input(label, { value: previous?.name, optional: true });
    if (name === undefined) return undefined;
    if (name.trim().length === 0) continue;
    const email = await ctx.prompts.input(t("participants.team.speakerEmail", { index: index + 1 }), {
      value: previous?.email,
      optional: true,
    });
    if (email === undefined) return undefined;
    drafts.push({ ...(previous?.id ? { id: previous.id } : {}), name, email });
  }
  return drafts;
}

async function askTeam(
  ctx: ActionContext,
  state: ProjectedState,
  existing: Team | undefined,
): Promise<TeamInput | undefined> {
  const name = await inputRequired(ctx, t("participants.team.name"), existing?.name);
  if (name === undefined) return undefined;
  const codeName = await ctx.prompts.input(t("participants.team.codeName"), {
    value: existing?.codeName,
    optional: true,
  });
  if (codeName === undefined) return undefined;
  const institutionId = await pickInstitution(ctx, state, t("participants.team.institution"), existing?.institutionId);
  if (institutionId === undefined) return undefined;
  const speakers = await askSpeakers(ctx, state, existing);
  if (speakers === undefined) return undefined;
  return {
    ...(existing ? { id: existing.id } : {}),
    name,
    codeName,
    ...(institutionId ? { institutionId } : {}),
    speakers,
  };
}

function submitTeam(ctx: ActionContext, args: TeamInput): Promise<ActionResult> {
  const state = ctx.store.getState();
  if (state === null) return Promise.resolve(noTournament());
  const errors = teamInputErrors(args);
  if (errors.length > 0) return Promise.resolve(invalid(...errors));
  return ctx.store.submit(buildTeamRequest(state, args));
}

export const saveTeamAction = defineAction<TeamInput>({
  id: "simpletab.participants.add-team",
  labelKey: "action.participants.saveTeam",
  page: PARTICIPANTS_PAGE,
  isEnabled: isOpen,
  prompt: async (ctx) => {
    const state = ctx.store.getState();
    return state === null ? undefined : askTeam(ctx, state, undefined);
  },
  run: submitTeam,
});

export const updateTeamAction = defineAction<TeamInput>({
  id: "simpletab.participants.edit-team",
  labelKey: "action.participants.updateTeam",
  page: PARTICIPANTS_PAGE,
  isEnabled: (snapshot) => (snapshot.state?.teams.length ?? 0) > 0,
  prompt: async (ctx) => {
    const state = ctx.store.getState();
    if (state === null) return undefined;
    const existing = await pickRecord(ctx, state.teams, "action.participants.pickTeam");
    return existing === undefined ? undefined : askTeam(ctx, state, existing);
  },
  run: submitTeam,
});

// ---------------------------------------------------------------- adjudicators

export interface AdjudicatorInput {
  id?: string;
  name: string;
  baseScore: number;
  institutionId?: string;
  email?: string;
  trainee: boolean;
  independent: boolean;
}

export function adjudicatorInputErrors(input: AdjudicatorInput): string[] {
  const errors = requiredError(t("participants.adj.name"), input.name);
  if (!Number.isFinite(input.baseScore)) {
    errors.push(`${t("participants.adj.baseScore")}: ${t("action.prompt.notANumber")}`);
  }
  return errors;
}

export function buildAdjudicatorRequest(state: ProjectedState, input: AdjudicatorInput): OpRequest {
  const existing =
    input.id === undefined ? undefined : state.adjudicators.find((item) => item.id === input.id);
  const institution =
    !input.independent && input.institutionId
      ? state.institutions.find((item) => item.id === input.institutionId)
      : undefined;
  const baseAdj: Adjudicator = {
    ...(existing ?? {}),
    id: existing?.id ?? makeEntityId("adj"),
    tournamentId: state.tournament.id,
    name: input.name.trim(),
    baseScore: input.baseScore,
    trainee: input.trainee,
    independent: input.independent || institution === undefined,
    ...(input.email?.trim() ? { email: input.email.trim() } : { email: undefined }),
    conflicts: existing?.conflicts ?? [],
    checkedIn: existing?.checkedIn ?? true,
  };
  const adjudicator = changeAdjudicatorInstitution(baseAdj, institution);
  return {
    type: existing ? "adjudicator.update" : "adjudicator.create",
    payload: { adjudicator },
  };
}

/** The adjudicator form's fields in its order: name, rating, independent or institution, email, trainee. */
async function askAdjudicator(
  ctx: ActionContext,
  state: ProjectedState,
  existing: Adjudicator | undefined,
): Promise<AdjudicatorInput | undefined> {
  const name = await inputRequired(ctx, t("participants.adj.name"), existing?.name);
  if (name === undefined) return undefined;
  const baseScore = await inputNumber(ctx, t("participants.adj.baseScore"), existing?.baseScore ?? 5);
  if (baseScore === undefined) return undefined;
  const independent = await pickYesNo(ctx, t("participants.adj.independent"), existing?.independent ?? false);
  if (independent === undefined) return undefined;
  let institutionId: string | undefined;
  if (!independent) {
    institutionId = await pickInstitution(ctx, state, t("participants.adj.institution"), existing?.institutionId);
    if (institutionId === undefined) return undefined;
  }
  const email = await ctx.prompts.input(t("participants.adj.email"), {
    value: existing?.email,
    optional: true,
  });
  if (email === undefined) return undefined;
  const trainee = await pickYesNo(ctx, t("participants.adj.trainee"), existing?.trainee ?? false);
  if (trainee === undefined) return undefined;
  return {
    ...(existing ? { id: existing.id } : {}),
    name,
    baseScore,
    ...(institutionId ? { institutionId } : {}),
    email,
    trainee,
    independent,
  };
}

function submitAdjudicator(ctx: ActionContext, args: AdjudicatorInput): Promise<ActionResult> {
  const state = ctx.store.getState();
  if (state === null) return Promise.resolve(noTournament());
  const errors = adjudicatorInputErrors(args);
  if (errors.length > 0) return Promise.resolve(invalid(...errors));
  return ctx.store.submit(buildAdjudicatorRequest(state, args));
}

export const saveAdjudicatorAction = defineAction<AdjudicatorInput>({
  id: "simpletab.participants.add-adjudicator",
  labelKey: "action.participants.saveAdjudicator",
  page: PARTICIPANTS_PAGE,
  isEnabled: isOpen,
  prompt: async (ctx) => {
    const state = ctx.store.getState();
    return state === null ? undefined : askAdjudicator(ctx, state, undefined);
  },
  run: submitAdjudicator,
});

export const updateAdjudicatorAction = defineAction<AdjudicatorInput>({
  id: "simpletab.participants.edit-adjudicator",
  labelKey: "action.participants.updateAdjudicator",
  page: PARTICIPANTS_PAGE,
  isEnabled: (snapshot) => (snapshot.state?.adjudicators.length ?? 0) > 0,
  prompt: async (ctx) => {
    const state = ctx.store.getState();
    if (state === null) return undefined;
    const existing = await pickRecord(ctx, state.adjudicators, "action.participants.pickAdjudicator");
    return existing === undefined ? undefined : askAdjudicator(ctx, state, existing);
  },
  run: submitAdjudicator,
});

// ---------------------------------------------------------------- venues

export interface VenueInput {
  id?: string;
  name: string;
  priority: number;
  category?: string;
  capacity?: number;
  accessible: boolean;
  online: boolean;
  nearTabRoom: boolean;
  available: boolean;
}

export function venueInputErrors(input: VenueInput): string[] {
  const errors = requiredError(t("participants.venue.name"), input.name);
  if (!Number.isFinite(input.priority)) {
    errors.push(`${t("participants.venue.priority")}: ${t("action.prompt.notANumber")}`);
  }
  return errors;
}

export function buildVenueRequest(state: ProjectedState, input: VenueInput): OpRequest {
  const existing = input.id === undefined ? undefined : state.venues.find((item) => item.id === input.id);
  const categoryTrimmed = input.category?.trim() ?? "";
  const venue: Venue = {
    ...(existing ?? {}),
    id: existing?.id ?? makeEntityId("venue"),
    tournamentId: state.tournament.id,
    name: input.name.trim(),
    priority: input.priority,
    ...(categoryTrimmed
      ? { category: categoryTrimmed, categories: [categoryTrimmed] }
      : { category: undefined, categories: undefined }),
    ...(input.capacity !== undefined && Number.isFinite(input.capacity)
      ? { capacity: input.capacity }
      : { capacity: undefined }),
    accessible: input.accessible,
    online: input.online,
    nearTabRoom: input.nearTabRoom,
    available: input.available,
  };
  return { type: existing ? "venue.update" : "venue.create", payload: { venue } };
}

async function askVenue(ctx: ActionContext, existing: Venue | undefined): Promise<VenueInput | undefined> {
  const name = await inputRequired(ctx, t("participants.venue.name"), existing?.name);
  if (name === undefined) return undefined;
  const priority = await inputNumber(ctx, t("participants.venue.priority"), existing?.priority ?? 10);
  if (priority === undefined) return undefined;
  const category = await ctx.prompts.input(t("participants.venue.category"), {
    value: existing?.category,
    optional: true,
  });
  if (category === undefined) return undefined;
  const capacity = await inputOptionalNumber(ctx, t("participants.venue.capacity"), existing?.capacity, {
    min: 0,
  });
  if (capacity === undefined) return undefined;
  const flags: Array<["accessible" | "online" | "nearTabRoom" | "available", boolean]> = [
    ["accessible", existing?.accessible ?? false],
    ["online", existing?.online ?? false],
    ["nearTabRoom", existing?.nearTabRoom ?? false],
    ["available", existing?.available ?? true],
  ];
  const answers: Record<string, boolean> = {};
  for (const [flag, current] of flags) {
    const answer = await pickYesNo(ctx, t(`participants.venue.${flag}`), current);
    if (answer === undefined) return undefined;
    answers[flag] = answer;
  }
  return {
    ...(existing ? { id: existing.id } : {}),
    name,
    priority,
    category,
    ...(capacity !== null ? { capacity } : {}),
    accessible: answers.accessible,
    online: answers.online,
    nearTabRoom: answers.nearTabRoom,
    available: answers.available,
  };
}

function submitVenue(ctx: ActionContext, args: VenueInput): Promise<ActionResult> {
  const state = ctx.store.getState();
  if (state === null) return Promise.resolve(noTournament());
  const errors = venueInputErrors(args);
  if (errors.length > 0) return Promise.resolve(invalid(...errors));
  return ctx.store.submit(buildVenueRequest(state, args));
}

export const saveVenueAction = defineAction<VenueInput>({
  id: "simpletab.participants.add-venue",
  labelKey: "action.participants.saveVenue",
  page: PARTICIPANTS_PAGE,
  isEnabled: isOpen,
  prompt: (ctx) => askVenue(ctx, undefined),
  run: submitVenue,
});

export const updateVenueAction = defineAction<VenueInput>({
  id: "simpletab.participants.edit-venue",
  labelKey: "action.participants.updateVenue",
  page: PARTICIPANTS_PAGE,
  isEnabled: (snapshot) => (snapshot.state?.venues.length ?? 0) > 0,
  prompt: async (ctx) => {
    const state = ctx.store.getState();
    if (state === null) return undefined;
    const existing = await pickRecord(ctx, state.venues, "action.participants.pickVenue");
    return existing === undefined ? undefined : askVenue(ctx, existing);
  },
  run: submitVenue,
});

// ---------------------------------------------------------------- conflicts

export interface AdjudicatorConflictInput {
  adjudicatorId: string;
  teamIds: string[];
  adjudicatorIds: string[];
  institutionIds: string[];
}

export function buildAdjudicatorConflictRequest(input: AdjudicatorConflictInput): OpRequest {
  return {
    type: "conflict.update_adjudicator",
    payload: {
      adjudicatorId: input.adjudicatorId,
      teamIds: input.teamIds,
      adjudicatorIds: input.adjudicatorIds,
      institutionIds: input.institutionIds,
    },
  };
}

/** Starts from the adjudicator's current conflicts, as the page's form does when you pick one. */
async function askAdjudicatorConflicts(ctx: ActionContext): Promise<AdjudicatorConflictInput | undefined> {
  const state = ctx.store.getState();
  if (state === null) return undefined;
  const adj = await pickRecord(ctx, state.adjudicators, "participants.conflict.selectAdj");
  if (adj === undefined) return undefined;
  const teamIds = await toggleMany(ctx, state.teams, t("participants.conflict.conflictedTeams"), teamConflictIds(adj));
  if (teamIds === undefined) return undefined;
  const adjudicatorIds = await toggleMany(
    ctx,
    state.adjudicators.filter((other) => other.id !== adj.id),
    t("participants.conflict.conflictedAdjs"),
    adjudicatorConflictIds(adj, state.adjudicators),
  );
  if (adjudicatorIds === undefined) return undefined;
  const institutionIds = await toggleMany(
    ctx,
    state.institutions,
    t("participants.conflict.conflictedInsts"),
    extraInstitutionConflictIds(adj),
  );
  if (institutionIds === undefined) return undefined;
  return { adjudicatorId: adj.id, teamIds, adjudicatorIds, institutionIds };
}

export const saveAdjudicatorConflictsAction = defineAction<AdjudicatorConflictInput, SubmitResult>({
  id: "simpletab.participants.set-adjudicator-conflicts",
  labelKey: "action.participants.saveAdjudicatorConflicts",
  page: PARTICIPANTS_PAGE,
  isEnabled: (snapshot) => (snapshot.state?.adjudicators.length ?? 0) > 0,
  prompt: askAdjudicatorConflicts,
  run: (ctx, args) => ctx.store.submit(buildAdjudicatorConflictRequest(args)),
});

export interface TeamConflictInput {
  teamId: string;
  institutionIds: string[];
}

export function buildTeamConflictRequest(input: TeamConflictInput): OpRequest {
  return {
    type: "conflict.set_team_institutions",
    payload: {
      teamId: input.teamId,
      institutionIds: input.institutionIds,
      clearWhenEmpty: true,
    },
  };
}

export const saveTeamConflictsAction = defineAction<TeamConflictInput, SubmitResult>({
  id: "simpletab.participants.set-team-conflicts",
  labelKey: "action.participants.saveTeamConflicts",
  page: PARTICIPANTS_PAGE,
  isEnabled: (snapshot) => (snapshot.state?.teams.length ?? 0) > 0,
  prompt: async (ctx) => {
    const state = ctx.store.getState();
    if (state === null) return undefined;
    const team = await pickRecord(ctx, state.teams, "participants.conflict.selectTeam");
    if (team === undefined) return undefined;
    const institutionIds = await toggleMany(
      ctx,
      state.institutions,
      t("participants.conflict.conflictedInsts"),
      team.institutionConflictIds ?? [],
    );
    return institutionIds === undefined ? undefined : { teamId: team.id, institutionIds };
  },
  run: (ctx, args) => ctx.store.submit(buildTeamConflictRequest(args)),
});

export const PARTICIPANT_ACTIONS = [
  saveInstitutionAction,
  updateInstitutionAction,
  deleteInstitutionAction,
  saveTeamAction,
  updateTeamAction,
  deleteTeamAction,
  saveAdjudicatorAction,
  updateAdjudicatorAction,
  deleteAdjudicatorAction,
  saveVenueAction,
  updateVenueAction,
  deleteVenueAction,
  saveAdjudicatorConflictsAction,
  saveTeamConflictsAction,
] as const;
