import { createTournamentState, type OpRound, type TournamentState } from "@simpletab/core/ops";
import type { BallotSubmission, Debate, FeedbackSubmission } from "@simpletab/core/types";

/** Shared fixture for the public site and archive build tests. */

export const ROUND_ID = "r-1";
export const DEBATE_ID = "d-1";

export interface StateOptions {
  releaseDraw?: boolean;
  releaseResults?: boolean;
  feedback?: FeedbackSubmission[];
}

export function makeState(options: StateOptions = {}): TournamentState {
  const releaseDraw = options.releaseDraw ?? true;
  const releaseResults = options.releaseResults ?? false;
  const tournamentId = "t-publish";
  return createTournamentState(
    {
      id: tournamentId,
      name: "Publish Test Open",
      shortName: "PTO",
      slug: "publish-test",
      format: "bp",
      active: true,
      ownerId: "host-owner",
      admins: { "host-owner": true },
      preferences: {
        teamsInDebate: 4,
        substantiveSpeakers: 2,
        replyScoresEnabled: false,
        minSpeakerScore: 50,
        maxSpeakerScore: 100,
        stepSpeakerScore: 1,
        minReplyScore: 25,
        maxReplyScore: 50,
        drawRule: "power_paired",
        sideAllocationRule: "balanced",
        ballotDoubleEntry: false,
        publicDraw: true,
        publicResults: true,
        publicStandings: true,
        publicMotions: true,
        feedbackEnabled: true,
        feedbackPath: "everyone",
        feedbackMinScore: 1,
        feedbackMaxScore: 5,
      },
      createdAt: "2026-11-24T00:00:00.000Z",
      updatedAt: "2026-11-24T00:00:00.000Z",
    },
    {
      rounds: [
        {
          id: ROUND_ID,
          tournamentId,
          seq: 1,
          name: "Round 1",
          abbreviation: "R1",
          stage: "preliminary",
          drawType: "random",
          drawStatus: releaseDraw ? "released" : "draft",
          adjudicatorsRevealed: true,
          feedbackWeight: 1,
          silent: false,
          motionsReleased: false,
          resultsReleased: releaseResults,
          completed: releaseResults,
          createdAt: "2026-11-24T00:00:00.000Z",
        } as OpRound,
      ],
      teams: [
        {
          id: "team-og",
          tournamentId,
          name: "Unreleased University",
          shortName: "UU",
          privatePasscode: "PRIVATE_PASSCODE_VALUE",
          breakCategories: [],
          speakerCategories: [],
          speakers: [
            { id: "spk-1", name: "Alice", privatePasscode: "SPEAKER_PASSCODE_VALUE" },
            { id: "spk-2", name: "Bob" },
          ],
        },
        {
          id: "team-oo",
          tournamentId,
          name: "Cambridge A",
          shortName: "CAM A",
          breakCategories: [],
          speakerCategories: [],
          speakers: [
            { id: "spk-3", name: "Cara" },
            { id: "spk-4", name: "Dan" },
          ],
        },
      ],
      adjudicators: [
        {
          id: "adj-chair",
          tournamentId,
          name: "Chair Judge",
          baseScore: 9,
          trainee: false,
          independent: false,
          conflicts: [],
        },
      ],
      debates: [
        {
          id: DEBATE_ID,
          tournamentId,
          roundId: ROUND_ID,
          roundSeq: 1,
          bracket: 0,
          roomRank: 1,
          importance: 1,
          sidesConfirmed: true,
          flags: [],
          venueName: "Room 101",
          teams: {
            OG: { side: "OG", teamId: "team-og", teamName: "Unreleased University" },
            OO: { side: "OO", teamId: "team-oo", teamName: "Cambridge A" },
          } as Debate["teams"],
          adjudicators: {
            chairId: "adj-chair",
            chairName: "Chair Judge",
            panellistIds: [],
            panellistNames: [],
            traineeIds: [],
            traineeNames: [],
          },
          resultStatus: "none",
        } as Debate,
      ],
      ballots: [
        {
          id: "b-1",
          tournamentId,
          roundId: ROUND_ID,
          debateId: DEBATE_ID,
          version: 1,
          confirmed: true,
          discarded: false,
          timestamp: "2026-11-24T10:00:00.000Z",
          speakerScores: {
            OG: [
              { speakerId: "spk-1", speakerName: "Alice", position: 1, score: 78 },
              { speakerId: "spk-2", speakerName: "Bob", position: 2, score: 77 },
            ],
          },
          teamScores: {
            OG: { side: "OG", teamId: "team-og", points: 3, win: true, rank: 1 },
          },
        } as unknown as BallotSubmission,
      ],
      feedback: options.feedback ?? [],
    },
  );
}

