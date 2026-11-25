import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { OpRequest } from "@simpletab/core/ops";
import type {
  ProjectedState,
  SubmitResult,
} from "@simpletab/host/lib/common/host-protocol";
import * as React from "react";
import { runnerFor } from "../actions/test-context";
import { CsvImportPanel } from "./csv-import-panel";

function makeState(overrides: Partial<ProjectedState> = {}): ProjectedState {
  return {
    seq: 1,
    roleId: "host_owner",
    versions: {},
    tournament: {
      id: "t-test",
      name: "Test BP",
      shortName: "Test BP",
      slug: "test-bp",
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
    ...overrides,
  };
}

describe("CsvImportPanel", () => {
  it("previews valid teams CSV with quoted commas and submits ops in order", async () => {
    const submitted: OpRequest[] = [];
    const onSubmitOp = vi.fn(async (req: OpRequest): Promise<SubmitResult> => {
      submitted.push(req);
      return {
        ok: true,
        seq: submitted.length,
        writes: [],
        committedPayload: req.payload,
      };
    });

    render(
      <CsvImportPanel
        kind="teams"
        state={makeState()}
        run={runnerFor({ state: makeState(), submit: onSubmitOp })}
      />,
    );

    const csv = [
      "name,institution,speaker1,speaker2",
      '"Oxford, Union A","Oxford, College",Alice Smith,"Bob, Jones"',
    ].join("\n");

    const textarea = screen.getByLabelText("Or paste CSV text");
    fireEvent.change(textarea, { target: { value: csv } });

    expect(screen.getByText("Oxford, Union A")).toBeTruthy();
    expect(screen.getByText("Add")).toBeTruthy();
    expect(
      screen.getByText(/New institutions to create: Oxford, College/),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: /Apply import/i }),
    );

    await waitFor(() => {
      expect(submitted).toHaveLength(2);
    });

    expect(submitted[0].type).toBe("institution.create");
    expect(submitted[1].type).toBe("team.create");
    const teamPayload = submitted[1].payload as {
      team: { name: string; institutionName?: string; speakers: Array<{ name: string }> };
    };
    expect(teamPayload.team.name).toBe("Oxford, Union A");
    expect(teamPayload.team.institutionName).toBe("Oxford, College");
    expect(teamPayload.team.speakers.map((s) => s.name)).toEqual([
      "Alice Smith",
      "Bob, Jones",
    ]);
    expect(
      screen.getByText("Import finished: 2 succeeded, 0 failed, 0 skipped."),
    ).toBeTruthy();
  });

  it("shows file error alert when required header is missing and blocks apply", () => {
    const onSubmitOp = vi.fn<
      (req: OpRequest) => Promise<SubmitResult>
    >();

    render(
      <CsvImportPanel
        kind="teams"
        state={makeState()}
        run={runnerFor({ state: makeState(), submit: onSubmitOp })}
      />,
    );

    const textarea = screen.getByLabelText("Or paste CSV text");
    fireEvent.change(textarea, {
      target: { value: "institution,speaker1\nOxford,Alice" },
    });

    expect(screen.getByRole("alert").textContent).toContain(
      'The "name" column is missing',
    );
    expect(screen.queryByRole("button", { name: /Apply import/i })).toBeNull();
    expect(onSubmitOp).not.toHaveBeenCalled();
  });

  it("shows existing match and duplicate conflict in preview and reports op failures", async () => {
    const existingState = makeState({
      teams: [
        {
          id: "team-existing",
          tournamentId: "t-test",
          name: "Oxford A",
          speakers: [
            { id: "spk-1", name: "Alice" },
            { id: "spk-2", name: "Bob" },
          ],
          breakCategories: [],
          speakerCategories: [],
          checkedIn: true,
        },
      ],
    });

    const onSubmitOp = vi.fn(async (req: OpRequest): Promise<SubmitResult> => {
      if (req.type === "team.create") {
        return {
          ok: false,
          code: "INVALID",
          errors: ["Team rejected by host."],
        };
      }
      return {
        ok: true,
        seq: 2,
        writes: [],
        committedPayload: req.payload,
      };
    });

    render(
      <CsvImportPanel
        kind="teams"
        state={existingState}
        run={runnerFor({ state: existingState, submit: onSubmitOp })}
      />,
    );

    const csv = [
      "name,speaker1,speaker2",
      "Oxford A,Alice,Bob",
      "Cambridge A,Cara,Dan",
      "Cambridge A,Eve,Frank",
    ].join("\n");

    const textarea = screen.getByLabelText("Or paste CSV text");
    fireEvent.change(textarea, { target: { value: csv } });

    expect(screen.getByText("Match")).toBeTruthy();
    expect(screen.getByText("Conflict")).toBeTruthy();
    expect(screen.getByText("Add")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Apply import/i }));

    await waitFor(() => {
      expect(
        screen.getByText("Import finished: 0 succeeded, 1 failed, 2 skipped."),
      ).toBeTruthy();
    });
    expect(
      screen.getByText(/Cambridge A \(team\.create\) failed \[INVALID\]: Team rejected by host\./),
    ).toBeTruthy();
  });
});
