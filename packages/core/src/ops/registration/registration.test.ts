import { describe, expect, it } from "vitest";
import { FIXED_TIME, makeTournament } from "@/test/tournamentFixtures";
import { applyOp, createTournamentState, defaultRegistry } from "../index";
import {
  deepFreeze,
  expectWrittenVersionBumps,
  SERVICE_ACTOR,
  TAB_ASSISTANT_ACTOR,
  TAB_DIRECTOR_ACTOR,
} from "../test-helpers";

describe("ops registration", () => {
  it("receives valid registration submissions and rejects spam or non-service actors", () => {
    const registry = defaultRegistry();
    const state = createTournamentState(makeTournament("bp"));
    const receivedMs = Date.parse(FIXED_TIME);
    const entry = {
      kind: "team",
      institution: "Oxford",
      contactName: "Alice",
      contactEmail: "alice@example.com",
      answers: {},
      team: {
        name: "Oxford A",
        speakers: [{ name: "Speaker 1" }, { name: "Speaker 2" }],
      },
    };

    const forbidden = applyOp(
      deepFreeze(state),
      {
        type: "registration.receive",
        payload: {
          submissionId: "reg-1",
          entry,
          receivedAt: FIXED_TIME,
          startedAt: receivedMs - 10_000,
        },
      },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) expect(forbidden.code).toBe("FORBIDDEN");

    const spamRes = applyOp(
      deepFreeze(state),
      {
        type: "registration.receive",
        payload: {
          submissionId: "reg-spam",
          entry,
          receivedAt: FIXED_TIME,
          honeypot: "bot-filled",
          startedAt: receivedMs - 10_000,
        },
      },
      SERVICE_ACTOR,
      registry,
    );
    expect(spamRes.ok).toBe(false);
    if (!spamRes.ok) expect(spamRes.code).toBe("INVALID");

    const received = applyOp(
      deepFreeze(state),
      {
        type: "registration.receive",
        payload: {
          submissionId: "reg-1",
          entry,
          receivedAt: FIXED_TIME,
          startedAt: receivedMs - 10_000,
        },
      },
      SERVICE_ACTOR,
      registry,
    );
    expect(received.ok).toBe(true);
    if (!received.ok) return;
    expect(received.state.registrations).toHaveLength(1);
    expect(received.state.registrations[0]?.status).toBe("pending");
    expect(received.inverse).toBeNull();
    expectWrittenVersionBumps(state, received);
  });

  it("accepts team and adjudicator registrations and supports inverse deletion", () => {
    const registry = defaultRegistry();
    const state0 = createTournamentState(makeTournament("bp"));
    const startedAt = Date.parse(FIXED_TIME) - 10_000;

    const r1 = applyOp(
      deepFreeze(state0),
      {
        type: "registration.receive",
        payload: {
          submissionId: "reg-team-1",
          entry: {
            kind: "team",
            institution: "Cambridge",
            contactName: "Bob",
            contactEmail: "bob@example.com",
            answers: {},
            team: {
              name: "Cambridge A",
              speakers: [{ name: "S1" }, { name: "S2" }],
            },
          },
          receivedAt: FIXED_TIME,
          startedAt,
        },
      },
      SERVICE_ACTOR,
      registry,
    );
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.inverse).toBeNull();
    expectWrittenVersionBumps(state0, r1);

    const r2 = applyOp(
      deepFreeze(r1.state),
      {
        type: "registration.receive",
        payload: {
          submissionId: "reg-adj-1",
          entry: {
            kind: "adjudicator",
            institution: "Cambridge",
            contactName: "Carol",
            contactEmail: "carol@example.com",
            answers: {},
            adjudicator: {
              name: "Carol Judge",
              email: "carol@example.com",
              institutionConflicts: [],
              teamConflicts: [],
            },
          },
          receivedAt: FIXED_TIME,
          startedAt,
        },
      },
      SERVICE_ACTOR,
      registry,
    );
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.inverse).toBeNull();
    expectWrittenVersionBumps(r1.state, r2);

    const forbiddenAccept = applyOp(
      deepFreeze(r2.state),
      {
        type: "registration.accept",
        payload: { submissionId: "reg-team-1", entityId: "team-reg-1" },
      },
      TAB_ASSISTANT_ACTOR,
      registry,
    );
    expect(forbiddenAccept.ok).toBe(false);
    if (!forbiddenAccept.ok) expect(forbiddenAccept.code).toBe("FORBIDDEN");

    const acceptedTeam = applyOp(
      deepFreeze(r2.state),
      {
        type: "registration.accept",
        payload: {
          submissionId: "reg-team-1",
          entityId: "team-reg-1",
          createdInstitutionId: "inst-cam",
        },
      },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(acceptedTeam.ok).toBe(true);
    if (!acceptedTeam.ok) return;
    expect(acceptedTeam.state.institutions).toHaveLength(1);
    expect(acceptedTeam.state.teams).toHaveLength(1);
    expect(acceptedTeam.state.teams[0]?.id).toBe("team-reg-1");
    expect(acceptedTeam.state.registrations[0]?.status).toBe("approved");
    expect(acceptedTeam.inverse?.type).toBe("team.delete");
    expectWrittenVersionBumps(r2.state, acceptedTeam);

    // Re-accepting already approved submission is rejected
    const duplicateAccept = applyOp(
      deepFreeze(acceptedTeam.state),
      {
        type: "registration.accept",
        payload: { submissionId: "reg-team-1", entityId: "team-reg-dup" },
      },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(duplicateAccept.ok).toBe(false);
    if (!duplicateAccept.ok) expect(duplicateAccept.code).toBe("INVALID");

    // Inverse deletes created team
    const undoneTeam = applyOp(
      deepFreeze(acceptedTeam.state),
      acceptedTeam.inverse!,
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(undoneTeam.ok).toBe(true);
    if (!undoneTeam.ok) return;
    expect(undoneTeam.state.teams).toHaveLength(0);
    expectWrittenVersionBumps(acceptedTeam.state, undoneTeam);

    // Accept adjudicator
    const acceptedAdj = applyOp(
      deepFreeze(undoneTeam.state),
      {
        type: "registration.accept",
        payload: { submissionId: "reg-adj-1", entityId: "adj-reg-1" },
      },
      TAB_DIRECTOR_ACTOR,
      registry,
    );
    expect(acceptedAdj.ok).toBe(true);
    if (!acceptedAdj.ok) return;
    expect(acceptedAdj.state.adjudicators).toHaveLength(1);
    expect(acceptedAdj.state.adjudicators[0]?.id).toBe("adj-reg-1");
    expect(acceptedAdj.inverse?.type).toBe("adjudicator.delete");
    expectWrittenVersionBumps(undoneTeam.state, acceptedAdj);
  });
});
