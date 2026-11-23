import { act, fireEvent, render, screen } from "@testing-library/react";
import { BUILT_IN_ROLES } from "@simpletab/core/permissions";
import { project } from "@simpletab/core/projection";
import type { TournamentState } from "@simpletab/core/ops";
import type { ProjectedState } from "@simpletab/host/lib/common/host-protocol";
import {
  DEFAULT_PROJECTOR_CONTROL,
  type ProjectorControlState,
} from "@simpletab/host/lib/common/projector-protocol";
import * as React from "react";
import { ProjectorControlView } from "./projector-control-view";
import { ProjectorView } from "./projector-view";

function makeTournamentFixture(options: {
  drawStatus: "draft" | "released";
  motionsStatus: "not_released" | "info_slides_released" | "motions_released";
  adjudicatorsRevealed: boolean;
}): ProjectedState {
  const raw: TournamentState = {
    tournament: {
      id: "t-proj",
      name: "Projector Open",
      shortName: "PO",
      slug: "projector-open",
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
    institutions: [],
    teams: [
      { id: "team-1", tournamentId: "t-proj", name: "Oxford A", speakers: [], breakCategories: [], speakerCategories: [] },
      { id: "team-2", tournamentId: "t-proj", name: "Cambridge A", speakers: [], breakCategories: [], speakerCategories: [] },
      { id: "team-3", tournamentId: "t-proj", name: "LSE A", speakers: [], breakCategories: [], speakerCategories: [] },
      { id: "team-4", tournamentId: "t-proj", name: "UCL A", speakers: [], breakCategories: [], speakerCategories: [] },
      { id: "team-5", tournamentId: "t-proj", name: "Durham A", speakers: [], breakCategories: [], speakerCategories: [] },
      { id: "team-6", tournamentId: "t-proj", name: "Bristol A", speakers: [], breakCategories: [], speakerCategories: [] },
      { id: "team-7", tournamentId: "t-proj", name: "Warwick A", speakers: [], breakCategories: [], speakerCategories: [] },
      { id: "team-8", tournamentId: "t-proj", name: "KCL A", speakers: [], breakCategories: [], speakerCategories: [] },
    ],
    adjudicators: [
      {
        id: "adj-1",
        tournamentId: "t-proj",
        name: "Chair Judge",
        email: "chair@secret.invalid",
        baseScore: 9,
        trainee: false,
        independent: true,
        conflicts: [],
      },
      {
        id: "adj-2",
        tournamentId: "t-proj",
        name: "Wing Judge",
        baseScore: 7,
        trainee: false,
        independent: true,
        conflicts: [],
      },
    ],
    venues: [],
    rounds: [
      {
        id: "r1",
        tournamentId: "t-proj",
        seq: 1,
        name: "Round 1",
        abbreviation: "R1",
        stage: "preliminary",
        drawType: "random",
        drawStatus: options.drawStatus,
        adjudicatorsRevealed: options.adjudicatorsRevealed,
        feedbackWeight: 1,
        silent: false,
        motionsStatus: options.motionsStatus,
        motionsReleased: options.motionsStatus === "motions_released",
        resultsReleased: false,
        completed: false,
        createdAt: "2026-10-01T00:00:00.000Z",
      },
    ],
    debates: [
      {
        id: "d1",
        tournamentId: "t-proj",
        roundId: "r1",
        roundSeq: 1,
        bracket: 0,
        roomRank: 1,
        importance: 1,
        sidesConfirmed: true,
        flags: [],
        venueName: "Hall 101",
        teams: {
          OG: { teamId: "team-1", teamName: "Oxford A" },
          OO: { teamId: "team-2", teamName: "Cambridge A" },
          CG: { teamId: "team-3", teamName: "LSE A" },
          CO: { teamId: "team-4", teamName: "UCL A" },
        } as ProjectedState["debates"][number]["teams"],
        adjudicators: {
          chairId: "adj-1",
          chairName: "Chair Judge",
          panellistIds: ["adj-2"],
          panellistNames: ["Wing Judge"],
          traineeIds: [],
          traineeNames: [],
        },
        resultStatus: "none",
      },
      {
        id: "d2",
        tournamentId: "t-proj",
        roundId: "r1",
        roundSeq: 1,
        bracket: 0,
        roomRank: 2,
        importance: 1,
        sidesConfirmed: true,
        flags: [],
        venueName: "Hall 202",
        teams: {
          OG: { teamId: "team-5", teamName: "Durham A" },
          OO: { teamId: "team-6", teamName: "Bristol A" },
          CG: { teamId: "team-7", teamName: "Warwick A" },
          CO: { teamId: "team-8", teamName: "KCL A" },
        } as ProjectedState["debates"][number]["teams"],
        adjudicators: {
          chairId: "adj-1",
          chairName: "Chair Judge",
          panellistIds: [],
          panellistNames: [],
          traineeIds: [],
          traineeNames: [],
        },
        resultStatus: "none",
      },
    ],
    motions: [
      {
        id: "m1",
        tournamentId: "t-proj",
        text: "THW abolish homework",
        infoSlide: "Countries have debated homework limits.",
        rounds: ["r1"],
        released: options.motionsStatus === "motions_released",
      },
    ],
    ballots: [],
    feedback: [],
    breakCategories: [],
    links: [],
    registrations: [],
    devices: [],
    roles: [],
    proposals: [],
    versions: {},
  };

  const projected = project(raw, BUILT_IN_ROLES.display);
  return {
    ...projected,
    tournament: projected.tournament as ProjectedState["tournament"],
    rounds: projected.rounds as ProjectedState["rounds"],
    ballots: projected.ballots as ProjectedState["ballots"],
    seq: 1,
    roleId: "display",
    permissions: [],
    versions: {},
  };
}

describe("ProjectorView & ProjectorControlView", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("hides unreleased motion, info slide, and draw completely", () => {
    const state = makeTournamentFixture({
      drawStatus: "draft",
      motionsStatus: "not_released",
      adjudicatorsRevealed: false,
    });
    const { container } = render(
      <ProjectorView displayState={state} control={DEFAULT_PROJECTOR_CONTROL} nowMs={0} />,
    );

    expect(screen.getByText("Motion not yet released.")).toBeTruthy();
    expect(screen.getByText("Draw not yet released.")).toBeTruthy();
    expect(container.textContent).not.toContain("THW abolish homework");
    expect(container.textContent).not.toContain("Countries have debated homework limits.");
    expect(container.textContent).not.toContain("Hall 101");
    expect(container.textContent).not.toContain("Oxford A");
    expect(container.textContent).not.toContain("Chair Judge");
  });

  it("shows info slide without motion text when only info slides are released, and shows info slide first when motion is released", () => {
    const infoOnly = makeTournamentFixture({
      drawStatus: "draft",
      motionsStatus: "info_slides_released",
      adjudicatorsRevealed: false,
    });
    const { container, rerender } = render(
      <ProjectorView displayState={infoOnly} control={DEFAULT_PROJECTOR_CONTROL} nowMs={0} />,
    );

    expect(screen.getByText("Countries have debated homework limits.")).toBeTruthy();
    expect(screen.getByText(/Motion text not yet released/)).toBeTruthy();
    expect(container.textContent).not.toContain("THW abolish homework");

    const fullMotion = makeTournamentFixture({
      drawStatus: "released",
      motionsStatus: "motions_released",
      adjudicatorsRevealed: true,
    });
    rerender(
      <ProjectorView displayState={fullMotion} control={DEFAULT_PROJECTOR_CONTROL} nowMs={0} />,
    );

    const text = container.textContent ?? "";
    const infoIndex = text.indexOf("Countries have debated homework limits.");
    const motionIndex = text.indexOf("THW abolish homework");
    expect(infoIndex).toBeGreaterThan(-1);
    expect(motionIndex).toBeGreaterThan(infoIndex);
    expect(screen.getByText(/Chair Judge \(Chair\), Wing Judge/)).toBeTruthy();
  });

  it("auto-paginates released draw rooms every N seconds and hides unrevealed panels", () => {
    vi.useFakeTimers();
    const state = makeTournamentFixture({
      drawStatus: "released",
      motionsStatus: "not_released",
      adjudicatorsRevealed: false,
    });
    const control: ProjectorControlState = {
      ...DEFAULT_PROJECTOR_CONTROL,
      open: true,
      pageIntervalSeconds: 5,
      roomsPerPage: 1,
    };

    const { container } = render(
      <ProjectorView displayState={state} control={control} nowMs={0} />,
    );

    expect(screen.getByText("Page 1 of 2")).toBeTruthy();
    expect(screen.getByText("Hall 101")).toBeTruthy();
    expect(screen.queryByText("Hall 202")).toBeNull();
    expect(container.textContent).not.toContain("Chair Judge");

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(screen.getByText("Page 2 of 2")).toBeTruthy();
    expect(screen.getByText("Hall 202")).toBeTruthy();
    expect(screen.queryByText("Hall 101")).toBeNull();
  });

  it("renders countdown and dispatches start/pause/reset controls", () => {
    const runningControl: ProjectorControlState = {
      ...DEFAULT_PROJECTOR_CONTROL,
      open: true,
      countdown: {
        durationSeconds: 900,
        remainingSeconds: 900,
        running: true,
        updatedAtMs: 1_000,
      },
    };

    const { rerender } = render(
      <ProjectorView
        displayState={makeTournamentFixture({
          drawStatus: "draft",
          motionsStatus: "not_released",
          adjudicatorsRevealed: false,
        })}
        control={runningControl}
        nowMs={66_000}
      />,
    );
    expect(screen.getByText("13:55")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();

    const onStart = vi.fn(async () => runningControl);
    const onPause = vi.fn(async () => DEFAULT_PROJECTOR_CONTROL);
    const onReset = vi.fn(async () => DEFAULT_PROJECTOR_CONTROL);

    rerender(
      <ProjectorControlView
        state={null}
        available={true}
        control={runningControl}
        nowMs={66_000}
        onOpenProjector={vi.fn(async () => runningControl)}
        onCloseProjector={vi.fn(async () => DEFAULT_PROJECTOR_CONTROL)}
        onToggleFullscreen={vi.fn(async () => runningControl)}
        onUpdateControl={vi.fn(async () => runningControl)}
        onStartCountdown={onStart}
        onPauseCountdown={onPause}
        onResetCountdown={onReset}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));

    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(onReset).toHaveBeenCalledWith(900);
  });
});
