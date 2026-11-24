import os from "node:os";
import path from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { planImport, buildImportCommit } from "@simpletab/core/lib/csv/importPlan";
import { verifyChain } from "@simpletab/core/changelog";
import { createSeededRng } from "@simpletab/core/lib/draw/rng";
import { makeAdjudicators, makeVenues, simulateBallot } from "@simpletab/core/test/tournamentFixtures";
import { calculateStandings } from "@simpletab/core/lib/standings/calculator";
import { calculateBreaks } from "@simpletab/core/lib/breakqual/calculator";
import { HostServiceImpl } from "../host-service";
import { HostEngine } from "../engine/engine";
import { exportHandover } from "../handover/export";
import { importHandover } from "../handover/import";

export interface ScriptedDemoResult {
  /** Preliminary rounds played. */
  rounds: number;
  eliminationRoundsPlayed: number;
  head: string;
  stateHash: string;
  importedStateHash: string;
  dbPath: string;
}

export interface ScriptedDemoOptions {
  teamCount: number;
  format: "bp" | "two-team";
  presetId: "bp" | "australs" | "uadc" | "wsdc";
  slug: string;
  name: string;
  seed: number;
  directory: string;
  clock: Date;
}

function requireOk(result: { ok: boolean; errors?: string[] }, operation: string): void {
  if (!result.ok) throw new Error(`${operation} failed: ${result.errors?.join("; ") ?? "unknown error"}`);
}

function generateTeamCsv(teamCount: number, format: "bp" | "two-team"): string {
  const speakers = format === "bp" ? 2 : 3;
  const columns = ["name", "institution", ...Array.from({ length: speakers }, (_, index) => `speaker${index + 1}`)];
  const rows = Array.from({ length: teamCount }, (_, index) => [
    `Team ${index + 1}`,
    `Institution ${index % 6 + 1}`,
    ...Array.from({ length: speakers }, (_, speaker) => `Speaker ${index + 1}.${speaker + 1}`),
  ]);
  return [columns.join(","), ...rows.map((row) => row.join(","))].join("\n");
}

export async function runScriptedDemo(options: ScriptedDemoOptions): Promise<ScriptedDemoResult> {
  mkdirSync(options.directory, { recursive: true });
  const service = new HostServiceImpl();
  service.setClock(() => new Date(options.clock));
  const created = await service.createTournament({
    name: options.name,
    slug: options.slug,
    format: options.format,
    presetId: options.presetId,
    prelimRounds: 3,
    directory: options.directory,
  });
  const tournamentId = created.state.tournament.id;

  const csv = generateTeamCsv(options.teamCount, options.format);
  const teamPlan = planImport("teams", csv, {
    institutions: [],
    teams: [],
    adjudicators: [],
    substantiveSpeakers: options.format === "bp" ? 2 : 3,
  });
  let importedId = 0;
  const teamCommit = buildImportCommit(teamPlan, { validRowsOnly: false }, {
    institutions: [],
    teams: [],
    adjudicators: [],
    substantiveSpeakers: options.format === "bp" ? 2 : 3,
    tournamentId,
    createId(prefix) {
      importedId += 1;
      return `${prefix}-${options.slug}-${importedId}`;
    },
  });
  if (teamCommit.commit === undefined) throw new Error(`Team CSV import failed: ${teamCommit.errors.join("; ")}`);

  for (const institution of teamCommit.commit.institutionsCreated) {
    requireOk(await service.submit({ type: "institution.create", payload: { institution } }), "institution.create");
  }
  for (const team of teamCommit.commit.teamsCreated) {
    requireOk(await service.submit({ type: "team.create", payload: { team } }), "team.create");
  }

  const rng = createSeededRng(options.seed);
  // Enough judges for a three-person voting panel in every room, plus spares (some are trainees).
  const rooms = Math.ceil(options.teamCount / (options.format === "bp" ? 4 : 2));
  const adjudicators = makeAdjudicators(rooms * 4, { tournamentId, institutionCount: rooms * 4, rng, traineeEvery: 8 });
  const venues = makeVenues(rooms, tournamentId);
  for (const adjudicator of adjudicators) {
    requireOk(await service.submit({ type: "adjudicator.create", payload: { adjudicator } }), "adjudicator.create");
  }
  for (const venue of venues) {
    requireOk(await service.submit({ type: "venue.create", payload: { venue } }), "venue.create");
  }

  const initialState = await service.getState();
  if (initialState === null) throw new Error("Demo state was unavailable.");
  for (const team of initialState.teams) {
    requireOk(await service.submit({ type: "checkin.set_participant", payload: { entityType: "team", entityId: team.id, roundId: initialState.rounds[0]!.id, available: true } }), "checkin team");
  }
  for (const adjudicator of initialState.adjudicators) {
    requireOk(await service.submit({ type: "checkin.set_participant", payload: { entityType: "adjudicator", entityId: adjudicator.id, roundId: initialState.rounds[0]!.id, available: true } }), "checkin adjudicator");
  }

  for (let roundIndex = 0; roundIndex < 3; roundIndex += 1) {
    const roundId = (await service.getState())!.rounds[roundIndex]!.id;
    requireOk(await service.submit({ type: "draw.generate", payload: { roundId, seed: options.seed + roundIndex } }), "draw.generate");
    requireOk(await service.submit({ type: "allocation.auto", payload: { roundId, panelSize: 3 } }), "allocation.auto");
    requireOk(await service.submit({
      type: "motion.create",
      payload: {
        motion: {
          id: `motion-${roundIndex + 1}`,
          tournamentId,
          text: `This House would demo round ${roundIndex + 1}`,
          rounds: [roundId],
          released: true,
          createdAt: options.clock.toISOString(),
        },
      },
    }), "motion.create");
    requireOk(await service.submit({ type: "draw.release", payload: { roundId } }), "draw.release");

    const state = (await service.getState())!;
    for (const debate of state.debates.filter((item) => item.roundId === roundId)) {
      if (debate.byeTeamId) continue;
      const tournament = state.tournament;
      const ballot = simulateBallot(debate, state.teams, tournament, rng, {
        id: `ballot-${options.slug}-${debate.id}`,
        confirmed: false,
        timestamp: options.clock.toISOString(),
      });
      requireOk(await service.submit({ type: "ballot.enter", payload: { ballot } }), "ballot.enter");
      requireOk(await service.submit({ type: "ballot.confirm", payload: { ballotId: ballot.id } }), "ballot.confirm");
    }
    requireOk(await service.submit({ type: "round.set_completion", payload: { roundId, completed: true } }), "round.complete");
  }

  const standingsState = (await service.getState())!;
  calculateStandings(standingsState.tournament, standingsState.rounds, standingsState.teams, standingsState.debates, standingsState.ballots);
  // createTournament already made the general (Open) break category, sized to match the elimination
  // rounds it created for this preset, so the demo uses it as it is.
  const generalCategory = standingsState.breakCategories.find((category) => category.isGeneral);
  if (generalCategory === undefined) throw new Error("The tournament has no general break category.");
  await resolveCutoffTies(service, generalCategory.id);
  requireOk(await service.submit({ type: "break.compute", payload: { categoryId: generalCategory.id } }), "break.compute");

  // Elimination rounds are played one at a time: draw, allocate, release, ballots, confirm, and
  // only then advance the winners into the next round (core refuses to advance an unplayed round).
  let currentState = (await service.getState())!;
  const eliminationRoundIds = currentState.rounds
    .filter((round) => round.stage === "elimination")
    .sort((left, right) => left.seq - right.seq)
    .map((round) => round.id);
  if (eliminationRoundIds.length === 0) throw new Error("Break did not create elimination rounds.");
  let eliminationRoundsPlayed = 0;
  for (const [index, roundId] of eliminationRoundIds.entries()) {
    requireOk(await service.submit({ type: "draw.generate", payload: { roundId, seed: options.seed + 100 + index } }), "elimination draw");
    requireOk(await service.submit({ type: "allocation.auto", payload: { roundId, panelSize: 3 } }), "elimination allocation");
    requireOk(await service.submit({ type: "draw.release", payload: { roundId } }), "elimination release");
    currentState = (await service.getState())!;
    for (const debate of currentState.debates.filter((item) => item.roundId === roundId)) {
      if (debate.byeTeamId) continue;
      const ballot = simulateBallot(debate, currentState.teams, currentState.tournament, rng, {
        id: `ballot-${options.slug}-elim-${index + 1}-${debate.id}`,
        confirmed: false,
        timestamp: options.clock.toISOString(),
      });
      requireOk(await service.submit({ type: "ballot.enter", payload: { ballot } }), "enter elimination ballot");
      requireOk(await service.submit({ type: "ballot.confirm", payload: { ballotId: ballot.id } }), "confirm elimination ballot");
    }
    eliminationRoundsPlayed += 1;
    if (index < eliminationRoundIds.length - 1) {
      requireOk(await service.submit({ type: "elimination.advance", payload: { roundId } }), "elimination.advance");
    }
  }

  const fullCheck = await service.runFullCheck();
  if (!fullCheck.ok) throw new Error(`Full check failed: ${fullCheck.reason}`);
  const chain = await service.getChangelog();
  const chainCheck = await verifyChain(chain, { expectedHead: chain.at(-1)?.entryHash });
  if (!chainCheck.ok) throw new Error(`Changelog verification failed at seq ${chainCheck.seq}`);

  const sourceEngine = HostEngine.open(created.dbPath);
  const handoverPath = path.join(options.directory, `${options.slug}.simpletab`);
  exportHandover(sourceEngine, handoverPath, { createdAt: options.clock.toISOString() });
  await sourceEngine.close();

  const importedPath = path.join(options.directory, `${options.slug}-imported.simpletab.db`);
  rmSync(importedPath, { force: true });
  const imported = await importHandover(handoverPath, importedPath);
  const importedEngine = HostEngine.open(imported.targetPath);
  const importedStateHash = importedEngine.getStateHash();
  await importedEngine.close();
  const sourceReopened = HostEngine.open(created.dbPath);
  const stateHash = sourceReopened.getStateHash();
  await sourceReopened.close();
  await service.onStop();

  return {
    rounds: 3,
    eliminationRoundsPlayed,
    head: chain.at(-1)?.entryHash ?? "",
    stateHash,
    importedStateHash,
    dbPath: created.dbPath,
  };
}

/**
 * Resolves ties at the break cutoff the way a Tab director would by hand. Core refuses to compute a
 * break while a cutoff tie is open (it never picks between tied teams itself), so the demo puts the
 * first teams in standings order through ("include") and marks the rest "lost_coin_toss".
 */
async function resolveCutoffTies(service: HostServiceImpl, categoryId: string): Promise<void> {
  const state = (await service.getState())!;
  const standings = calculateStandings(state.tournament, state.rounds, state.teams, state.debates, state.ballots).teams;
  const results = calculateBreaks(
    state.breakCategories,
    state.teams,
    standings,
    state.tournament.format,
    state.tournament.preferences.teamStandingsPrecedence,
  );
  const result = results.find((item) => item.category.id === categoryId);
  for (const tie of result?.cutoffTies ?? []) {
    for (const [index, entry] of tie.teams.entries()) {
      const override = index < tie.places ? "include" : "lost_coin_toss";
      requireOk(
        await service.submit({ type: "break.team_override", payload: { categoryId, teamId: entry.team.id, override } }),
        "break.team_override",
      );
    }
  }
}
