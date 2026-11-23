import { describe, expect, it } from "vitest";
import { createSeededRng } from "@/lib/draw/rng";
import { BUILT_IN_ROLES, customRole } from "@/permissions";
import { project, projectOp, type ProjectableState } from "@/projection";
import {
  FIXED_TIME,
  makeAdjudicators,
  makeRound,
  makeTeams,
  makeTournament,
  makeVenues,
  simulateBallot,
} from "@/test/tournamentFixtures";
import type { Debate, DebateSide, DebateTeamSlot, Motion } from "@/types";

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function buildFixtureState(): ProjectableState {
  const rng = createSeededRng(42);
  const tournament = makeTournament("bp", {
    releasedBreakCategoryIds: ["cat-open"],
  });
  tournament.ownerEmail = "owner@example.test";

  const roundReleased = makeRound(tournament.id, 1, {
    drawStatus: "confirmed",
    adjudicatorsRevealed: true,
    motionsReleased: true,
    motionsStatus: "motions_released",
    resultsReleased: true,
    teamSpeaksReleased: true,
    completed: true,
  });
  const roundUnreleased = makeRound(tournament.id, 2, {
    drawStatus: "locked",
    adjudicatorsRevealed: false,
    motionsReleased: false,
    motionsStatus: "not_released",
    resultsReleased: false,
    completed: false,
    drawSeed: 999,
    preformedPanels: [
      {
        id: "pp-1",
        chairId: "adj-1",
        panellistIds: ["adj-2"],
        traineeIds: [],
        importance: 10,
      },
    ],
  });

  const teams = makeTeams(8, {
    tournamentId: tournament.id,
    institutionCount: 2,
    speakersPerTeam: 2,
  }).map((team, index) => ({
    ...team,
    privateUrlKey: `team-key-${index + 1}`,
    privatePasscode: `team-pin-${index + 1}`,
    speakerUrlKeys: team.speakers.map((_, sIdx) => `spk-key-${index + 1}-${sIdx + 1}`),
    institutionConflictIds: index === 0 ? ["inst-2"] : [],
    breakStatus: index === 0 ? ("breaking" as const) : index === 1 ? ("breaking" as const) : undefined,
    breakCategoryIds: index === 0 ? ["cat-open"] : index === 1 ? ["cat-esl"] : undefined,
    speakers: team.speakers.map((speaker, sIdx) => ({
      ...speaker,
      email: `speaker-${index + 1}-${sIdx + 1}@example.test`,
      phone: `+1555000${index}${sIdx}`,
      privateUrlKey: `spk-key-${index + 1}-${sIdx + 1}`,
      privatePasscode: `spk-pin-${index + 1}-${sIdx + 1}`,
    })),
  }));

  const adjudicators = makeAdjudicators(4, {
    tournamentId: tournament.id,
    institutionCount: 2,
    rng,
  }).map((adj, index) => ({
    ...adj,
    email: `adj-${index + 1}@example.test`,
    phone: `+1555111${index}`,
    testScore: 7,
    scoreHistory: [
      {
        field: "baseScore" as const,
        previous: 4,
        value: adj.baseScore,
        timestamp: FIXED_TIME,
      },
    ],
    breaking: index === 0,
    adjCore: index === 0,
    conflicts: [{ teamId: teams[0].id, type: "personal" as const }],
    privateUrlKey: `adj-key-${index + 1}`,
    privatePasscode: `adj-pin-${index + 1}`,
  }));

  const venues = makeVenues(2, tournament.id);

  const motionReleased: Motion = {
    id: "motion-1",
    tournamentId: tournament.id,
    text: "THW abolish private tab rooms",
    reference: "R1 Motion",
    infoSlide: "Public info slide",
    rounds: [roundReleased.id],
    released: true,
  };
  const motionUnreleased: Motion = {
    id: "motion-2",
    tournamentId: tournament.id,
    text: "THW keep secret motions secret",
    reference: "R2 Secret",
    infoSlide: "Secret info slide",
    rounds: [roundUnreleased.id],
    released: false,
  };

  const makeDebate = (roundId: string, roundSeq: number, motion: Motion, confirmed: boolean): Debate => ({
    id: `debate-r${roundSeq}`,
    tournamentId: tournament.id,
    roundId,
    roundSeq,
    venueId: venues[0].id,
    venueName: venues[0].name,
    bracket: 0,
    roomRank: 1,
    importance: 10,
    resultStatus: confirmed ? "confirmed" : "none",
    sidesConfirmed: true,
    flags: [],
    motionId: motion.id,
    motionText: motion.text,
    teams: {
      OG: { teamId: teams[0].id, teamName: teams[0].name, side: "OG", ...(confirmed ? { points: 3, speakerScoreTotal: 155 } : {}) },
      OO: { teamId: teams[1].id, teamName: teams[1].name, side: "OO", ...(confirmed ? { points: 2, speakerScoreTotal: 150 } : {}) },
      CG: { teamId: teams[2].id, teamName: teams[2].name, side: "CG", ...(confirmed ? { points: 1, speakerScoreTotal: 145 } : {}) },
      CO: { teamId: teams[3].id, teamName: teams[3].name, side: "CO", ...(confirmed ? { points: 0, speakerScoreTotal: 140 } : {}) },
    } as Record<DebateSide, DebateTeamSlot>,
    adjudicators: {
      chairId: adjudicators[0].id,
      chairName: adjudicators[0].name,
      panellistIds: [adjudicators[1].id],
      panellistNames: [adjudicators[1].name],
      traineeIds: [],
      traineeNames: [],
    },
  });

  const debateReleased = makeDebate(roundReleased.id, 1, motionReleased, true);
  const debateUnreleased = makeDebate(roundUnreleased.id, 2, motionUnreleased, false);

  const ballotReleased = {
    ...simulateBallot(debateReleased, teams, tournament, rng, { confirmed: true }),
    motionId: motionReleased.id,
    motionText: motionReleased.text,
  };
  const ballotUnreleased = {
    ...simulateBallot(debateUnreleased, teams, tournament, rng, { confirmed: false }),
    motionId: motionUnreleased.id,
    motionText: motionUnreleased.text,
  };

  return {
    tournament,
    rounds: [roundReleased, roundUnreleased],
    teams,
    adjudicators,
    institutions: [
      {
        id: "inst-1",
        tournamentId: tournament.id,
        name: "Institution 1",
        code: "I1",
        coaches: [{ id: "c-1", name: "Coach One", email: "coach@example.test" }],
      },
    ],
    venues,
    debates: [debateReleased, debateUnreleased],
    motions: [motionReleased, motionUnreleased],
    ballots: [ballotReleased, ballotUnreleased],
    feedback: [
      {
        id: "fb-1",
        tournamentId: tournament.id,
        roundId: roundReleased.id,
        debateId: debateReleased.id,
        targetType: "adjudicator",
        targetAdjudicatorId: adjudicators[0].id,
        sourceType: "team",
        sourceId: teams[0].id,
        sourceName: teams[0].name,
        score: 5,
        comments: "Very thorough",
        confirmed: true,
        timestamp: FIXED_TIME,
      },
    ],
    breakCategories: [
      {
        id: "cat-open",
        tournamentId: tournament.id,
        name: "Open",
        slug: "open",
        seq: 1,
        breakSize: 4,
        reserveSize: 2,
        isGeneral: true,
        priority: 1,
        teamOverrides: { [teams[0].id]: "include" },
        generatedBreak: {
          breakingTeamIds: [teams[0].id],
          reserveTeamIds: [],
          generatedAt: FIXED_TIME,
        },
      },
      {
        id: "cat-esl",
        tournamentId: tournament.id,
        name: "ESL",
        slug: "esl",
        seq: 2,
        breakSize: 4,
        reserveSize: 0,
        isGeneral: false,
        priority: 2,
        teamOverrides: { [teams[1].id]: "include" },
        generatedBreak: {
          breakingTeamIds: [teams[1].id],
          reserveTeamIds: [],
          generatedAt: FIXED_TIME,
        },
      },
    ],
    links: [{ lookupId: "a123456789012", entityId: adjudicators[0].id, secret: "SUPERSECRET" }],
    registrations: [{ id: "reg-1", teamName: "New Team" }],
  };
}

describe("project()", () => {
  it("never mutates a deep-frozen input state across any built-in role", () => {
    const state = deepFreeze(buildFixtureState());

    for (const role of Object.values(BUILT_IN_ROLES)) {
      const projected = project(state, role);
      expect(projected).not.toBe(state);
      expect(projected.teams).not.toBe(state.teams);
      expect(projected.adjudicators).not.toBe(state.adjudicators);
    }
  });

  it("allows host_owner and tab_director to see all fields including secrets and contacts", () => {
    const state = buildFixtureState();
    for (const role of [BUILT_IN_ROLES.host_owner, BUILT_IN_ROLES.tab_director]) {
      const projected = project(state, role);
      expect(projected.feedback).toHaveLength(1);
      expect(projected.links).toEqual(state.links);
      expect(projected.registrations).toEqual(state.registrations);
      expect(projected.debates).toHaveLength(2);
      expect(projected.motions).toHaveLength(2);
      expect(projected.ballots).toHaveLength(2);
      expect(projected.teams[0].privateUrlKey).toBe("team-key-1");
      expect(projected.teams[0].speakers[0].email).toBe("speaker-1-1@example.test");
      expect(projected.adjudicators[0].privateUrlKey).toBe("adj-key-1");
      expect(projected.adjudicators[0].testScore).toBe(7);
      expect(projected.tournament.ownerEmail).toBe("owner@example.test");
    }
  });

  it("strips feedback and adjudicator scores from equity, tab_assistant, ai, and display", () => {
    const state = buildFixtureState();
    for (const role of [
      BUILT_IN_ROLES.equity,
      BUILT_IN_ROLES.tab_assistant,
      BUILT_IN_ROLES.ai,
      BUILT_IN_ROLES.display,
    ]) {
      const projected = project(state, role);
      expect(projected.feedback).toEqual([]);
      for (const adj of projected.adjudicators) {
        expect(adj.baseScore).toBe(0);
        expect(adj.testScore).toBeUndefined();
        expect(adj.scoreHistory).toBeUndefined();
      }
    }
  });

  it("allows adjudication_core to see feedback and scores, but strips contacts, secrets, and registrations", () => {
    const state = buildFixtureState();
    const projected = project(state, BUILT_IN_ROLES.adjudication_core);

    expect(projected.feedback).toHaveLength(1);
    expect(projected.adjudicators[0].baseScore).toBe(state.adjudicators[0].baseScore);
    expect(projected.adjudicators[0].testScore).toBe(7);
    expect(projected.debates).toHaveLength(2);
    expect(projected.motions).toHaveLength(2);
    expect(projected.ballots).toHaveLength(2);

    expect(projected.links).toEqual([]);
    expect(projected.registrations).toEqual([]);
    expect(projected.tournament.ownerEmail).toBeUndefined();
    expect(projected.teams[0].privateUrlKey).toBeUndefined();
    expect(projected.teams[0].privatePasscode).toBeUndefined();
    expect(projected.teams[0].speakerUrlKeys).toBeUndefined();
    expect(projected.teams[0].speakers[0].email).toBeUndefined();
    expect(projected.teams[0].speakers[0].phone).toBeUndefined();
    expect(projected.teams[0].speakers[0].privateUrlKey).toBeUndefined();
    expect(projected.adjudicators[0].email).toBeUndefined();
    expect(projected.adjudicators[0].phone).toBeUndefined();
    expect(projected.adjudicators[0].privateUrlKey).toBeUndefined();
  });

  it("gives display only released data (no unreleased draws, motions, ballots, conflicts, breaks, contacts, or secrets)", () => {
    const state = buildFixtureState();
    const projected = project(state, BUILT_IN_ROLES.display);

    expect(projected.tournament.ownerId).toBe("");
    expect(projected.tournament.admins).toEqual({});
    expect(projected.tournament.ownerEmail).toBeUndefined();
    expect(projected.debates.map((d) => d.roundId)).toEqual(["round-t-bp-1"]);
    expect(projected.motions.map((m) => m.id)).toEqual(["motion-1"]);
    expect(projected.ballots.map((b) => b.roundId)).toEqual(["round-t-bp-1"]);
    expect(projected.feedback).toEqual([]);
    expect(projected.links).toEqual([]);
    expect(projected.registrations).toEqual([]);
    expect(projected.rounds[1].preformedPanels).toBeUndefined();
    expect(projected.rounds[1].drawSeed).toBeUndefined();
    expect(projected.adjudicators[0].conflicts).toEqual([]);
    expect(projected.teams[0].institutionConflictIds).toBeUndefined();
    expect(projected.teams[0].breakCategoryIds).toEqual(["cat-open"]);
    expect(projected.teams[1].breakStatus).toBeUndefined();
    expect(projected.teams[1].breakCategoryIds).toBeUndefined();
    expect(projected.breakCategories[0].generatedBreak).toBeDefined();
    expect(projected.breakCategories[1].generatedBreak).toBeUndefined();
    expect(projected.institutions[0].coaches).toBeUndefined();
  });

  it("allows equity to see conflicts but not feedback, unreleased draws, unreleased motions, secrets, or contacts", () => {
    const state = buildFixtureState();
    const projected = project(state, BUILT_IN_ROLES.equity);

    expect(projected.adjudicators[0].conflicts).toHaveLength(1);
    expect(projected.teams[0].institutionConflictIds).toEqual(["inst-2"]);
    expect(projected.feedback).toEqual([]);
    expect(projected.debates.map((d) => d.roundId)).toEqual(["round-t-bp-1"]);
    expect(projected.motions.map((m) => m.id)).toEqual(["motion-1"]);
    expect(projected.ballots.map((b) => b.roundId)).toEqual(["round-t-bp-1"]);
    expect(projected.links).toEqual([]);
    expect(projected.registrations).toEqual([]);
  });

  it("allows tab_assistant to see unreleased draws, motions, and ballots, but not feedback, conflicts, contacts, or secrets", () => {
    const state = buildFixtureState();
    const projected = project(state, BUILT_IN_ROLES.tab_assistant);

    expect(projected.debates).toHaveLength(2);
    expect(projected.motions).toHaveLength(2);
    expect(projected.ballots).toHaveLength(2);
    expect(projected.feedback).toEqual([]);
    expect(projected.adjudicators[0].conflicts).toEqual([]);
    expect(projected.links).toEqual([]);
    expect(projected.teams[0].speakers[0].email).toBeUndefined();
    expect(projected.teams[0].privateUrlKey).toBeUndefined();
  });

  it("allows ai to see conflicts, unreleased draws, motions, and ballots, without feedback, contacts, or secrets", () => {
    const state = buildFixtureState();
    const projected = project(state, BUILT_IN_ROLES.ai);

    expect(projected.adjudicators[0].conflicts).toHaveLength(1);
    expect(projected.debates).toHaveLength(2);
    expect(projected.motions).toHaveLength(2);
    expect(projected.ballots).toHaveLength(2);
    expect(projected.feedback).toEqual([]);
    expect(projected.links).toEqual([]);
    expect(projected.registrations).toEqual([]);
  });

  it("exposes links only to roles with links.manage", () => {
    const state = buildFixtureState();
    const linkManager = customRole("link_mgr", "Link Manager", ["links.manage"]);

    for (const [id, role] of Object.entries(BUILT_IN_ROLES)) {
      const projected = project(state, role);
      const shouldSeeLinks = id === "host_owner" || id === "tab_director";
      expect(projected.links).toEqual(shouldSeeLinks ? state.links : []);
      expect(projected.teams[0].privateUrlKey).toBe(
        shouldSeeLinks ? "team-key-1" : undefined,
      );
      expect(projected.adjudicators[0].privatePasscode).toBe(
        shouldSeeLinks ? "adj-pin-1" : undefined,
      );
    }

    const customProjected = project(state, linkManager);
    expect(customProjected.links).toEqual(state.links);
    expect(customProjected.teams[0].privateUrlKey).toBe("team-key-1");
    expect(customProjected.teams[0].speakers[0].email).toBeUndefined();
  });

  it("hides debate panels when round.adjudicatorsRevealed is false without draw.display", () => {
    const state = buildFixtureState();
    state.rounds[0] = { ...state.rounds[0], adjudicatorsRevealed: false };
    const projected = project(state, BUILT_IN_ROLES.display);
    expect(projected.debates).toHaveLength(1);
    expect(projected.debates[0].adjudicators).toEqual({
      panellistIds: [],
      panellistNames: [],
      traineeIds: [],
      traineeNames: [],
    });
  });

  it("redacts motion text when round is in info_slides_released without motions.display", () => {
    const state = buildFixtureState();
    state.rounds[1] = {
      ...state.rounds[1],
      motionsStatus: "info_slides_released",
    };
    const projected = project(state, BUILT_IN_ROLES.display);
    const r2Motion = projected.motions.find((m) => m.id === "motion-2");
    expect(r2Motion).toBeDefined();
    expect(r2Motion?.text).toBe("");
    expect(r2Motion?.infoSlide).toBe("Secret info slide");
    expect(r2Motion?.reference).toBeUndefined();
  });
});

describe("projectOp()", () => {
  it("returns null for feedback ops without feedback.view", () => {
    const op = {
      type: "feedback.enter",
      payload: { roundId: "r1", score: 5, comments: "Private note" },
    };
    expect(projectOp(op, BUILT_IN_ROLES.equity)).toBeNull();
    expect(projectOp(op, BUILT_IN_ROLES.tab_assistant)).toBeNull();
    expect(projectOp(op, BUILT_IN_ROLES.ai)).toBeNull();
    expect(projectOp(op, BUILT_IN_ROLES.display)).toBeNull();
    expect(projectOp(op, BUILT_IN_ROLES.adjudication_core)).toEqual(op);
  });

  it("returns null for adjudicator.update_scores, conflict.*, private_urls.*, and registration.* without permission", () => {
    expect(
      projectOp(
        { type: "adjudicator.update_scores", payload: { id: "a1", baseScore: 7 } },
        BUILT_IN_ROLES.tab_assistant,
      ),
    ).toBeNull();
    expect(
      projectOp(
        { type: "conflict.update_adjudicator", payload: { id: "a1" } },
        BUILT_IN_ROLES.tab_assistant,
      ),
    ).toBeNull();
    expect(
      projectOp(
        { type: "conflict.update_adjudicator", payload: { id: "a1" } },
        BUILT_IN_ROLES.equity,
      ),
    ).not.toBeNull();
    expect(
      projectOp(
        { type: "private_urls.regenerate", payload: { scope: "all" } },
        BUILT_IN_ROLES.adjudication_core,
      ),
    ).toBeNull();
    expect(
      projectOp(
        { type: "registration.accept", payload: { submissionId: "reg-1" } },
        BUILT_IN_ROLES.tab_assistant,
      ),
    ).toBeNull();
  });

  it("returns null for unreleased draw, motion, and ballot ops without their permissions", () => {
    expect(
      projectOp(
        { type: "draw.generate", payload: { roundId: "r2" } },
        BUILT_IN_ROLES.equity,
      ),
    ).toBeNull();
    expect(
      projectOp(
        { type: "motion.create", payload: { text: "Secret motion" } },
        BUILT_IN_ROLES.equity,
      ),
    ).toBeNull();
    expect(
      projectOp(
        { type: "ballot.enter", payload: { roundId: "r2" } },
        BUILT_IN_ROLES.equity,
      ),
    ).toBeNull();
    expect(
      projectOp(
        { type: "ballot.enter", payload: { roundId: "r2", motionId: "m2", motionText: "Secret" } },
        BUILT_IN_ROLES.tab_assistant,
      ),
    ).not.toBeNull();
  });

  it("strips contacts, link secrets, and conflicts from team ops without mutating input", () => {
    const op = deepFreeze({
      type: "team.update",
      payload: {
        id: "team-1",
        name: "Team 01",
        privateUrlKey: "team-secret",
        privatePasscode: "1234",
        speakerUrlKeys: ["spk-secret"],
        institutionConflictIds: ["inst-2"],
        breakStatus: "breaking",
        speakers: [
          {
            id: "s1",
            name: "Alice",
            email: "alice@example.test",
            phone: "+12345",
            privateUrlKey: "spk-secret",
            privatePasscode: "9999",
          },
        ],
      },
    });

    const projected = projectOp(op, BUILT_IN_ROLES.tab_assistant);
    expect(projected).not.toBeNull();
    expect(projected).not.toBe(op);
    expect(projected?.payload).toEqual({
      id: "team-1",
      name: "Team 01",
      speakers: [{ id: "s1", name: "Alice" }],
    });

    const hostProjected = projectOp(op, BUILT_IN_ROLES.host_owner);
    expect(hostProjected).toEqual(op);
    expect(hostProjected).not.toBe(op);
  });

  it("strips motionText from ballot ops when role lacks motions.display", () => {
    const ballotViewer = customRole("ballot_only", "Ballot Only", ["results.enter"]);
    const op = deepFreeze({
      type: "ballot.enter",
      payload: {
        id: "b1",
        roundId: "r1",
        motionId: "m1",
        motionText: "Unreleased motion text",
      },
    });
    const projected = projectOp(op, ballotViewer);
    expect(projected?.payload).toEqual({ id: "b1", roundId: "r1" });
  });

  it("strips adjudicator secrets, contacts, conflicts, and scores from adjudicator.update", () => {
    const op = deepFreeze({
      type: "adjudicator.update",
      payload: {
        id: "adj-1",
        name: "Adj 1",
        email: "adj1@example.test",
        phone: "+1555",
        baseScore: 7,
        testScore: 8,
        scoreHistory: [{ field: "baseScore", value: 7, timestamp: FIXED_TIME }],
        breaking: true,
        conflicts: [{ teamId: "team-1", type: "personal" }],
        privateUrlKey: "adj-secret",
        privatePasscode: "4321",
      },
    });
    const projected = projectOp(op, BUILT_IN_ROLES.tab_assistant);
    expect(projected?.payload).toEqual({
      id: "adj-1",
      name: "Adj 1",
      baseScore: 0,
      conflicts: [],
    });
  });

  it("recursively filters proposal ops based on the inner op", () => {
    const feedbackProposal = {
      type: "proposal.accept",
      payload: {
        proposalId: "p-1",
        op: { type: "feedback.review", payload: { feedbackId: "fb-1", confirmed: true } },
      },
    };
    expect(projectOp(feedbackProposal, BUILT_IN_ROLES.ai)).toBeNull();
    expect(projectOp(feedbackProposal, BUILT_IN_ROLES.adjudication_core)).toEqual(feedbackProposal);
  });

  it("exposes registrations only to roles with registration.manage", () => {
    const state = buildFixtureState();
    const regRole = customRole("reg_mgr", "Registration Manager", ["registration.manage"]);
    expect(project(state, BUILT_IN_ROLES.adjudication_core).registrations).toEqual([]);
    expect(project(state, regRole).registrations).toEqual(state.registrations);
  });
});
