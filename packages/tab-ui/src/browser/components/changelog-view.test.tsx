import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  GENESIS_HASH,
  makeEntry,
  type PublicChainItem,
} from "@simpletab/core/changelog";
import { BUILT_IN_ROLES } from "@simpletab/core/permissions";
import type {
  HostStatus,
  OpUndoInfo,
  ProjectedState,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import * as React from "react";
import { ChangelogView } from "./changelog-view";

const BASE_STATE: ProjectedState = {
  seq: 3,
  roleId: "host_owner",
  permissions: BUILT_IN_ROLES.host_owner.permissions,
  versions: {},
  tournament: {
    id: "t-1",
    name: "Changelog Test",
    shortName: "CT",
    slug: "changelog-test",
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
  rounds: [],
  teams: [],
  adjudicators: [],
  institutions: [],
  venues: [],
  debates: [],
  motions: [],
  ballots: [],
  feedback: [],
  breakCategories: [],
};

const BASE_STATUS: HostStatus = {
  open: true,
  slug: "changelog-test",
  headSeq: 3,
  integrityOk: true,
  canSync: true,
  locks: [],
};

async function buildValidChain(): Promise<PublicChainItem[]> {
  const s1 = await makeEntry(
    {
      seq: 1,
      ts: "2026-10-01T10:00:00.000Z",
      actorType: "human",
      actorRef: "host-owner",
      opType: "institution.create",
      category: "participants",
      summary: "Created Oxford",
      visibility: "private",
      payload: { id: "inst-1" },
    },
    GENESIS_HASH,
  );
  const s2 = await makeEntry(
    {
      seq: 2,
      ts: "2026-10-01T10:01:00.000Z",
      actorType: "ai",
      actorRef: "assistant-cli",
      opType: "draw.generate",
      category: "draw",
      summary: "AI generated Round 1 draw",
      visibility: "public",
      payload: { roundId: "r1" },
    },
    s1.entryHash,
  );
  const s3 = await makeEntry(
    {
      seq: 3,
      ts: "2026-10-01T10:02:00.000Z",
      actorType: "human",
      actorRef: "host-owner",
      opType: "draw.lock",
      category: "draw",
      summary: "Locked Round 1 draw",
      visibility: "public",
      payload: { roundId: "r1" },
    },
    s2.entryHash,
  );

  return [
    { entry: s1.entry, entryHash: s1.entryHash },
    { entry: s2.entry, entryHash: s2.entryHash },
    { entry: s3.entry, entryHash: s3.entryHash },
  ];
}

describe("ChangelogView", () => {
  it("renders newest first with AI badge, filters by category/actor, verifies valid & tampered chains, and shows blocking seqs on Undo refusal", async () => {
    const validChain = await buildValidChain();
    let currentChain = validChain;

    const undoInfos: OpUndoInfo[] = [
      {
        seq: 1,
        writes: ["institution:inst-1"],
        hasInverse: true,
        inverseOf: null,
        undoable: true,
        blockingSeqs: [],
      },
      {
        seq: 2,
        writes: ["round:r1"],
        hasInverse: true,
        inverseOf: null,
        undoable: false,
        blockingSeqs: [3],
      },
      {
        seq: 3,
        writes: ["round:r1"],
        hasInverse: true,
        inverseOf: null,
        undoable: true,
        blockingSeqs: [],
      },
    ];

    const onGetChangelog = vi.fn(async () => currentChain);
    const onGetOpUndoInfo = vi.fn(async () => undoInfos);
    const onUndoOp = vi.fn(async (seq: number): Promise<SubmitResult> => {
      if (seq === 2) {
        return {
          ok: false,
          code: "CANNOT_UNDO",
          errors: ["Operation 2 is blocked by later operations: 3."],
          blockingSeqs: [3],
        };
      }
      return { ok: true, seq: 4, writes: [], committedPayload: {} };
    });

    render(
      <ChangelogView
        state={BASE_STATE}
        status={BASE_STATUS}
        onGetChangelog={onGetChangelog}
        onGetOpUndoInfo={onGetOpUndoInfo}
        onUndoOp={onUndoOp}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("#3")).toBeTruthy();
    });

    // Head hash displayed
    expect(screen.getByText(validChain[2].entryHash)).toBeTruthy();

    // Newest first order (#3 before #2 before #1)
    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText("#3")).toBeTruthy();
    expect(within(rows[1]).getByText("#2")).toBeTruthy();
    expect(within(rows[2]).getByText("#1")).toBeTruthy();

    // AI badge rendered for actorType "ai"
    expect(within(rows[1]).getByText("AI")).toBeTruthy();
    expect(within(rows[1]).getByText("assistant-cli")).toBeTruthy();

    // Verify valid chain -> OK
    fireEvent.click(screen.getByRole("button", { name: "Verify chain" }));
    await waitFor(() => {
      expect(screen.getByText(/Chain verified: OK/)).toBeTruthy();
    });

    // Tamper entry #2 and re-verify -> failing seq #2
    currentChain = [
      validChain[0],
      {
        ...validChain[1],
        entry: { ...validChain[1].entry, summary: "Tampered summary" },
      },
      validChain[2],
    ];
    fireEvent.click(screen.getByRole("button", { name: "Verify chain" }));
    await waitFor(() => {
      expect(
        screen.getByText(/Chain verification failed at seq #2/),
      ).toBeTruthy();
    });

    // Filter by category "participants" -> shows only #1
    fireEvent.change(screen.getByLabelText("Category"), {
      target: { value: "participants" },
    });
    expect(screen.getAllByRole("row").slice(1)).toHaveLength(1);
    expect(screen.getByText("#1")).toBeTruthy();

    // Clear category filter, filter by actor "assistant-cli" -> shows only #2
    fireEvent.change(screen.getByLabelText("Category"), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByLabelText("Actor"), {
      target: { value: "assistant-cli" },
    });
    expect(screen.getAllByRole("row").slice(1)).toHaveLength(1);
    expect(screen.getByText("#2")).toBeTruthy();

    // Click Undo on #2 -> refused with CANNOT_UNDO and blocking seqs
    fireEvent.click(screen.getByRole("button", { name: "Undo #2" }));
    await waitFor(() => {
      expect(onUndoOp).toHaveBeenCalledWith(2);
    });
    expect(screen.getByText("CANNOT_UNDO")).toBeTruthy();
    expect(
      screen.getByText("Blocked by later operation(s): #3"),
    ).toBeTruthy();
  });
});
