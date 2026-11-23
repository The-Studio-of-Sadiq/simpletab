import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BUILT_IN_ROLES } from "@simpletab/core/permissions";
import {
  DEFAULT_ONLINE_SETTINGS,
  type HostIntegrityCheckResult,
  type HostStatus,
  type ProjectedState,
} from "@simpletab/host/lib/common/host-protocol";
import * as React from "react";
import { formatStatusBarText, StatusView } from "./status-view";

function makeStatusState(): ProjectedState {
  return {
    seq: 12,
    roleId: "host_owner",
    permissions: BUILT_IN_ROLES.host_owner.permissions,
    versions: {},
    tournament: {
      id: "t-1",
      name: "Status Test",
      shortName: "ST",
      slug: "status-test",
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
        feedbackEnabled: false,
        feedbackMinScore: 1,
        feedbackMaxScore: 5,
      },
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    },
    rounds: [
      {
        id: "r1",
        tournamentId: "t-1",
        seq: 1,
        name: "Round 1",
        abbreviation: "R1",
        stage: "preliminary",
        drawType: "random",
        drawStatus: "released",
        feedbackWeight: 1,
        silent: false,
        motionsReleased: false,
        resultsReleased: false,
        completed: false,
        createdAt: "2026-10-01T00:00:00.000Z",
        simpletab: {
          ballotDeadline: "2026-11-24T14:00:00.000Z",
          timeZone: "UTC",
        },
      },
    ],
    teams: [],
    adjudicators: [],
    institutions: [],
    venues: [],
    debates: [
      {
        id: "d1",
        tournamentId: "t-1",
        roundId: "r1",
        roundSeq: 1,
        bracket: 0,
        roomRank: 1,
        importance: 1,
        sidesConfirmed: true,
        flags: [],
        venueName: "Room Alpha",
        teams: {} as ProjectedState["debates"][number]["teams"],
        adjudicators: { panellistIds: [], panellistNames: [], traineeIds: [], traineeNames: [] },
        resultStatus: "none",
      },
      {
        id: "d2",
        tournamentId: "t-1",
        roundId: "r1",
        roundSeq: 1,
        bracket: 0,
        roomRank: 2,
        importance: 1,
        sidesConfirmed: true,
        flags: [],
        venueName: "Room Beta",
        teams: {} as ProjectedState["debates"][number]["teams"],
        adjudicators: { panellistIds: [], panellistNames: [], traineeIds: [], traineeNames: [] },
        resultStatus: "none",
      },
      {
        id: "d3",
        tournamentId: "t-1",
        roundId: "r1",
        roundSeq: 1,
        bracket: 0,
        roomRank: 3,
        importance: 1,
        sidesConfirmed: true,
        flags: [],
        venueName: "Room Gamma",
        teams: {} as ProjectedState["debates"][number]["teams"],
        adjudicators: { panellistIds: [], panellistNames: [], traineeIds: [], traineeNames: [] },
        resultStatus: "none",
      },
    ],
    motions: [],
    ballots: [
      {
        id: "b1",
        tournamentId: "t-1",
        debateId: "d1",
        roundId: "r1",
        version: 1,
        submitterType: "tabroom",
        timestamp: "2026-11-24T04:00:00.000Z",
        confirmed: true,
        discarded: false,
        teamScores: {} as ProjectedState["ballots"][number]["teamScores"],
        speakerScores: {} as ProjectedState["ballots"][number]["speakerScores"],
      },
      {
        id: "b2",
        tournamentId: "t-1",
        debateId: "d2",
        roundId: "r1",
        version: 1,
        submitterType: "tabroom",
        timestamp: "2026-11-24T04:05:00.000Z",
        confirmed: false,
        discarded: false,
        teamScores: {} as ProjectedState["ballots"][number]["teamScores"],
        speakerScores: {} as ProjectedState["ballots"][number]["speakerScores"],
      },
    ],
    feedback: [],
    breakCategories: [],
  };
}

describe("StatusView & formatStatusBarText", () => {
  it("formats status bar text for closed, integrity ok, integrity failed, and online paused", () => {
    expect(formatStatusBarText({ open: false, locks: [] })).toBe(
      "SimpleTab: no tournament · Offline",
    );

    expect(
      formatStatusBarText({
        open: true,
        slug: "wudc",
        headSeq: 42,
        integrityOk: true,
        canSync: true,
        locks: [],
        onlineSettings: { ...DEFAULT_ONLINE_SETTINGS },
      }),
    ).toBe("SimpleTab: wudc · seq 42 · Integrity OK · Online: Off");

    expect(
      formatStatusBarText({
        open: true,
        slug: "wudc",
        headSeq: 42,
        integrityOk: false,
        canSync: false,
        locks: [],
        onlineSettings: { ...DEFAULT_ONLINE_SETTINGS, ballotPortal: true },
      }),
    ).toBe("SimpleTab: wudc · seq 42 · Integrity failed · Online: Paused");
  });

  it("renders integrity labels, full-check button, online add-ons, and ballots-in counts per room", async () => {
    const baseStatus: HostStatus = {
      open: true,
      slug: "status-test",
      headSeq: 12,
      integrityOk: true,
      canSync: true,
      locks: [],
      fastCheck: { ok: true },
      hostNumber: 2,
      queuedOps: 0,
      onlineSettings: { ...DEFAULT_ONLINE_SETTINGS, ballotPortal: true },
    };

    const runFullCheck = vi.fn(
      async (): Promise<HostIntegrityCheckResult> => ({
        ok: true,
        checkedAt: "2026-11-24T05:00:00.000Z",
      }),
    );

    const { rerender } = render(
      <StatusView
        status={baseStatus}
        state={makeStatusState()}
        loading={false}
        error={null}
        onRefresh={vi.fn(async () => baseStatus)}
        onRunFullCheck={runFullCheck}
        onCreateDemo={vi.fn()}
      />,
    );

    expect(screen.getByText("Tournament open")).toBeTruthy();
    expect(screen.getByText("Verified (OK)")).toBeTruthy();
    expect(screen.getByText("Not run yet")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("None (live collaboration arrives in M5)")).toBeTruthy();
    expect(screen.getAllByText("Not checked — offline")).toHaveLength(2);
    expect(screen.getAllByText("Never")).toHaveLength(3);
    expect(screen.getByText("Paused: Online service arrives in M3")).toBeTruthy();
    expect(screen.getAllByText("Off").length).toBeGreaterThanOrEqual(3);

    expect(
      screen.getByText("Round 1: Confirmed 1 / 3 · Entered 2 / 3"),
    ).toBeTruthy();
    expect(screen.getByText("Room Alpha")).toBeTruthy();
    expect(screen.getByText("Confirmed")).toBeTruthy();
    expect(screen.getByText("Room Beta")).toBeTruthy();
    expect(screen.getByText("Entered (unconfirmed)")).toBeTruthy();
    expect(screen.getByText("Room Gamma")).toBeTruthy();
    expect(screen.getByText("Missing")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Run full check" }));
    await waitFor(() => {
      expect(runFullCheck).toHaveBeenCalledTimes(1);
    });

    // Integrity failed state renders explicit failure label
    rerender(
      <StatusView
        status={{
          ...baseStatus,
          integrityOk: false,
          canSync: false,
          fastCheck: {
            ok: false,
            stage: "changelog",
            seq: 4,
            reason: "Hash mismatch at seq 4",
          },
          fullCheck: {
            ok: false,
            stage: "replay",
            seq: 4,
            reason: "Replay diverged",
            checkedAt: "2026-11-24T05:01:00.000Z",
          },
        }}
        state={makeStatusState()}
        loading={false}
        error={null}
        onRefresh={vi.fn(async () => baseStatus)}
        onRunFullCheck={runFullCheck}
        onCreateDemo={vi.fn()}
      />,
    );

    expect(screen.getByText("Failed: Hash mismatch at seq 4")).toBeTruthy();
    expect(
      screen.getByText("Failed at 2026-11-24T05:01:00.000Z: Replay diverged"),
    ).toBeTruthy();
    expect(screen.getByText("Sync blocked")).toBeTruthy();
    expect(screen.getByText("Paused: Integrity check failed")).toBeTruthy();
  });
});
