import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { OpRequest } from "@simpletab/core/ops";
import type {
  HostStatus,
  ProjectedState,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import * as React from "react";
import { MotionsView } from "./motions-view";

function makeMotionsState(
  overrides: Partial<ProjectedState> = {},
): ProjectedState {
  return {
    seq: 5,
    roleId: "host_owner",
    versions: {
      "round:r1": 2,
      "motion:m1": 3,
    },
    tournament: {
      id: "t-1",
      name: "Motions Test",
      shortName: "MT",
      slug: "motions-test",
      format: "bp",
      active: true,
      ownerId: "host-owner",
      admins: { "host-owner": true },
      simpletab: {
        timeZone: "Asia/Dhaka",
      },
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
        motionsStatus: "not_released",
        resultsReleased: false,
        completed: false,
        createdAt: "2026-10-01T00:00:00.000Z",
        simpletab: {
          ballotDeadline: "2026-10-01T08:00:00.000Z",
          timeZone: "Asia/Dhaka",
        },
      },
    ],
    teams: [],
    adjudicators: [],
    institutions: [],
    venues: [],
    debates: [],
    motions: [
      {
        id: "m1",
        tournamentId: "t-1",
        text: "THBT debates should start on time.",
        infoSlide: "Punctuality is valued.",
        reference: "R1-M1",
        rounds: ["r1"],
        seq: 1,
        roundSeq: { r1: 1 },
        released: false,
      },
    ],
    ballots: [],
    feedback: [],
    breakCategories: [],
    ...overrides,
  };
}

const EMPTY_STATUS: HostStatus = {
  open: true,
  slug: "motions-test",
  headSeq: 5,
  integrityOk: true,
  canSync: true,
  locks: [],
};

describe("MotionsView", () => {
  it("displays deadline in tournament time zone and submits motion.set_round_status", async () => {
    const submitted: OpRequest[] = [];
    const onSubmitOp = vi.fn(async (req: OpRequest): Promise<SubmitResult> => {
      submitted.push(req);
      return {
        ok: true,
        seq: 6,
        writes: [],
        committedPayload: req.payload,
      };
    });

    render(
      <MotionsView
        state={makeMotionsState()}
        status={EMPTY_STATUS}
        onSubmitOp={onSubmitOp}
        nowIso="2026-10-01T07:30:00.000Z"
      />,
    );

    expect(screen.getByText("Ballots close at 14:00 (Asia/Dhaka)")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Release info slides" }));
    await waitFor(() => {
      expect(submitted).toHaveLength(1);
    });
    expect(submitted[0]).toEqual({
      type: "motion.set_round_status",
      expectedVersions: { "round:r1": 2 },
      payload: {
        roundId: "r1",
        status: "info_slides_released",
        now: "2026-10-01T07:30:00.000Z",
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Release motions" }));
    await waitFor(() => {
      expect(submitted).toHaveLength(2);
    });
    expect(submitted[1]).toEqual({
      type: "motion.set_round_status",
      expectedVersions: { "round:r1": 2 },
      payload: {
        roundId: "r1",
        status: "motions_released",
        now: "2026-10-01T07:30:00.000Z",
      },
    });
  });

  it("converts local deadline in Asia/Dhaka and Europe/London (DST) to UTC instants", async () => {
    const submitted: OpRequest[] = [];
    const onSubmitOp = vi.fn(async (req: OpRequest): Promise<SubmitResult> => {
      submitted.push(req);
      return {
        ok: true,
        seq: 7,
        writes: [],
        committedPayload: req.payload,
      };
    });

    render(
      <MotionsView
        state={makeMotionsState()}
        status={EMPTY_STATUS}
        onSubmitOp={onSubmitOp}
        nowIso="2026-10-01T06:00:00.000Z"
      />,
    );

    // Asia/Dhaka (UTC+6): 15:30 -> 09:30Z
    fireEvent.change(screen.getByLabelText("Date"), {
      target: { value: "2026-10-01" },
    });
    fireEvent.change(screen.getByLabelText("Time"), {
      target: { value: "15:30" },
    });
    fireEvent.change(screen.getByLabelText("Time zone (IANA)"), {
      target: { value: "Asia/Dhaka" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save deadline" }));

    await waitFor(() => {
      expect(submitted).toHaveLength(1);
    });
    expect(submitted[0]).toEqual({
      type: "round.set_ballot_deadline",
      expectedVersions: { "round:r1": 2 },
      payload: {
        roundId: "r1",
        ballotDeadline: "2026-10-01T09:30:00.000Z",
        timeZone: "Asia/Dhaka",
      },
    });

    // Europe/London summer BST (UTC+1): 14:00 -> 13:00Z
    fireEvent.change(screen.getByLabelText("Date"), {
      target: { value: "2026-07-15" },
    });
    fireEvent.change(screen.getByLabelText("Time"), {
      target: { value: "14:00" },
    });
    fireEvent.change(screen.getByLabelText("Time zone (IANA)"), {
      target: { value: "Europe/London" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save deadline" }));

    await waitFor(() => {
      expect(submitted).toHaveLength(2);
    });
    expect(submitted[1]?.payload).toEqual({
      roundId: "r1",
      ballotDeadline: "2026-07-15T13:00:00.000Z",
      timeZone: "Europe/London",
    });

    // Europe/London winter GMT (UTC+0): 14:00 -> 14:00Z
    fireEvent.change(screen.getByLabelText("Date"), {
      target: { value: "2026-01-15" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save deadline" }));

    await waitFor(() => {
      expect(submitted).toHaveLength(3);
    });
    expect(submitted[2]?.payload).toEqual({
      roundId: "r1",
      ballotDeadline: "2026-01-15T14:00:00.000Z",
      timeZone: "Europe/London",
    });
  });

  it("supports creating, editing, and deleting motions", async () => {
    const submitted: OpRequest[] = [];
    const onSubmitOp = vi.fn(async (req: OpRequest): Promise<SubmitResult> => {
      submitted.push(req);
      return {
        ok: true,
        seq: 8,
        writes: [],
        committedPayload: req.payload,
      };
    });

    render(
      <MotionsView
        state={makeMotionsState()}
        status={EMPTY_STATUS}
        onSubmitOp={onSubmitOp}
      />,
    );

    // Edit existing motion
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Motion text"), {
      target: { value: "THW edit motions cleanly." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save motion" }));

    await waitFor(() => {
      expect(submitted.some((op) => op.type === "motion.update")).toBe(true);
    });
    const updateOp = submitted.find((op) => op.type === "motion.update")!;
    expect(updateOp.expectedVersions).toEqual({ "motion:m1": 3 });
    expect((updateOp.payload as { motion: { text: string } }).motion.text).toBe(
      "THW edit motions cleanly.",
    );

    // Create new motion
    fireEvent.change(screen.getByLabelText("Motion text"), {
      target: { value: "THBT new motions work." },
    });
    fireEvent.change(screen.getByLabelText("Info slide (optional)"), {
      target: { value: "Context slide" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add motion" }));

    await waitFor(() => {
      expect(submitted.some((op) => op.type === "motion.create")).toBe(true);
    });

    // Delete motion
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(submitted.some((op) => op.type === "motion.delete")).toBe(true);
    });
    const deleteOp = submitted.find((op) => op.type === "motion.delete")!;
    expect(deleteOp.expectedVersions).toEqual({ "motion:m1": 3 });
    expect(deleteOp.payload).toEqual({ motionId: "m1" });
  });
});
