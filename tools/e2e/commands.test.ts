import "reflect-metadata";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProjectedState } from "@simpletab/host/lib/common/host-protocol";
import { afterAll, describe, expect, it } from "vitest";
import { HostServiceImpl } from "../../packages/host/src/node/host-service";
import type {
  ActionContext,
  ActionPrompts,
  AnyAction,
} from "../../packages/tab-ui/src/browser/actions/action";
import { ALL_ACTIONS } from "../../packages/tab-ui/src/browser/actions/all-actions";
import { executeAction } from "../../packages/tab-ui/src/browser/actions/execute-action";
import { TournamentStore } from "../../packages/tab-ui/src/browser/store/tournament-store";

/**
 * M8 checkpoint (`npm run e2e:commands`, with the tab-ui inventory test): SimpleTab's commands run
 * from the command palette against a REAL host. Each command goes through `executeAction` with no
 * arguments, exactly as the palette runs it: the action asks its questions (answered here by a
 * scripted palette), then runs against the app's own `TournamentStore` over a `HostServiceImpl` on
 * a SQLite file. After each command the host's committed state is checked. Passes when:
 * - every action is a uniquely named command with an English label;
 * - a tournament can be set up and a round run from the palette alone: institutions,
 *   adjudicators, venues, conflicts, a motion, the draw, the allocation and a ballot;
 * - bad input is asked again rather than cancelling, a refusal is reported as a message, and
 *   Escape cancels without changing anything;
 * - a change can be undone from the palette, and navigation commands open their pages.
 */

/** One scripted palette answer: text for an input, a label or value for a pick, true/false for a confirmation. */
type Answer = string | number | boolean | undefined | { keep: true };
const KEEP: Answer = { keep: true };

interface AskedPrompt {
  kind: "pick" | "input" | "confirm" | "file";
  label: string;
  items?: string[];
}

class ScriptedPalette implements ActionPrompts {
  readonly asked: AskedPrompt[] = [];
  private queue: Answer[] = [];

  answer(...answers: Answer[]): this {
    this.queue = [...answers];
    this.asked.length = 0;
    return this;
  }

  get unused(): number {
    return this.queue.length;
  }

  private next(prompt: AskedPrompt): Answer {
    this.asked.push(prompt);
    if (this.queue.length === 0) {
      throw new Error(`The script has no answer for: ${JSON.stringify(prompt)}`);
    }
    return this.queue.shift();
  }

  async pick<T>(
    items: ReadonlyArray<{ label: string; description?: string; value: T }>,
    placeholder: string,
  ): Promise<T | undefined> {
    const answer = this.next({ kind: "pick", label: placeholder, items: items.map((item) => item.label) });
    if (answer === undefined) return undefined;
    if (typeof answer === "object") return items[0]?.value;
    const match =
      items.find((item) => item.value === answer) ??
      items.find((item) => item.label === String(answer)) ??
      items.find((item) => item.label.includes(String(answer)));
    if (match === undefined) {
      throw new Error(`No choice "${String(answer)}" for "${placeholder}": ${items.map((item) => item.label).join(" | ")}`);
    }
    return match.value;
  }

  async input(prompt: string, options?: { value?: string }): Promise<string | undefined> {
    const answer = this.next({ kind: "input", label: prompt });
    if (answer === undefined) return undefined;
    if (typeof answer === "object") return options?.value ?? "";
    return String(answer);
  }

  async confirm(title: string): Promise<boolean> {
    return this.next({ kind: "confirm", label: title }) === true;
  }

  async pickFile(title: string): Promise<string | undefined> {
    const answer = this.next({ kind: "file", label: title });
    return typeof answer === "string" ? answer : undefined;
  }

  async openTextFile(title: string): Promise<string | undefined> {
    return this.pickFile(title);
  }
}

function action(id: string): AnyAction {
  const found = ALL_ACTIONS.find((item) => item.id === id);
  if (found === undefined) throw new Error(`No command ${id}`);
  return found;
}

describe("M8 commands against a real host", () => {
  const directories: string[] = [];
  const hosts: HostServiceImpl[] = [];
  afterAll(async () => {
    for (const host of hosts) await host.dispose();
    for (const dir of directories) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        // Windows can keep SQLite files locked briefly; the OS cleans temp folders.
      }
    }
  });

  it("names every action as a unique command", () => {
    const ids = ALL_ACTIONS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(100);
  });

  it("sets up and runs a round from the palette alone", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "simpletab-commands-"));
    directories.push(dir);
    const host = new HostServiceImpl();
    hosts.push(host);
    const store = new TournamentStore(host, undefined, { openTournamentFolder: async () => undefined });
    const palette = new ScriptedPalette();
    const opened: string[] = [];
    const ctx: ActionContext = {
      store,
      prompts: palette,
      openPage: async (widgetId) => {
        opened.push(widgetId);
      },
      services: {},
    };
    const errors: string[] = [];
    const infos: string[] = [];
    const notify = {
      error: (message: string) => errors.push(message),
      info: (message: string) => infos.push(message),
    };
    const timings: number[] = [];

    /** Runs one command from the palette; checks every answer was used and returns the fresh state. */
    const palettes = async (id: string, ...answers: Answer[]): Promise<ProjectedState> => {
      const command = action(id);
      expect(command.isEnabled?.(store.getSnapshot()) ?? true, `${id} is offered`).toBe(true);
      palette.answer(...answers);
      errors.length = 0;
      const started = performance.now();
      const result = await executeAction(command, ctx, undefined, notify);
      timings.push(performance.now() - started);
      expect(errors, `${id}: ${JSON.stringify(palette.asked)}`).toEqual([]);
      expect(result?.ok, `${id} result`).toBe(true);
      expect(palette.unused, `${id}: unused answers`).toBe(0);
      await store.refresh();
      const state = store.getState();
      expect(state).not.toBeNull();
      return state!;
    };

    // The demo tournament, created from the palette (blank folder prompt answered with ours).
    let state = await palettes("simpletab.status.create-demo", dir);
    expect(state.teams).toHaveLength(4);
    const round = state.rounds[0]!;

    state = await palettes("simpletab.participants.add-institution", "Dhaka University", "DU", "");
    const du = state.institutions.find((inst) => inst.code === "DU")!;
    expect(du.name).toBe("Dhaka University");

    // Adjudicator: name, rating, independent?, institution, email, trainee?
    state = await palettes("simpletab.participants.add-adjudicator", "Rahim Chair", "8", "No", "Dhaka University", "", "No");
    state = await palettes("simpletab.participants.add-adjudicator", "Karim Wing", "6.5", "Yes", "", "No");
    expect(state.adjudicators.map((adj) => adj.name).sort()).toEqual(["Karim Wing", "Rahim Chair"]);
    expect(state.adjudicators.find((adj) => adj.name === "Rahim Chair")!.institutionId).toBe(du.id);

    // A bad priority is asked again, not a cancel.
    state = await palettes(
      "simpletab.participants.add-venue",
      "Room 101", "high", "5", "", "40", "Yes", "No", "No", "Yes",
    );
    expect(palette.asked.filter((prompt) => prompt.kind === "input").length).toBe(5);
    const venue = state.venues.find((item) => item.name === "Room 101")!;
    expect(venue.priority).toBe(5);
    expect(venue.capacity).toBe(40);

    // Conflicts start from the current ones; add the institution to the first team.
    const team = state.teams[0]!;
    state = await palettes("simpletab.participants.set-team-conflicts", team.name, "Dhaka University", "");
    expect(state.teams.find((item) => item.id === team.id)!.institutionConflictIds).toEqual([du.id]);

    state = await palettes("simpletab.participants.edit-team", team.name, "Renamed Team", KEEP, KEEP, ...speakerAnswers(team));
    expect(state.teams.find((item) => item.id === team.id)!.name).toBe("Renamed Team");

    // A motion: a blank text is asked again. Then undo it from the changelog and add it back.
    state = await palettes("simpletab.motions.create-motion", "Round 1", "  ", "This House would abolish homework", "", "");
    expect(state.motions.map((motion) => motion.text)).toEqual(["This House would abolish homework"]);
    state = await palettes("simpletab.changelog.undo-op", KEEP, true);
    expect(state.motions).toEqual([]);
    state = await palettes("simpletab.motions.create-motion", "Round 1", "This House would abolish homework", "", "");
    const motion = state.motions[0]!;

    // The draw: generate, restore (undo this session's generation), generate again.
    state = await palettes("simpletab.draw.generate-draw", "Round 1", "4242");
    expect(state.debates.filter((debate) => debate.roundId === round.id)).toHaveLength(1);
    state = await palettes("simpletab.draw.restore-draw", "Round 1", true);
    expect(state.debates.filter((debate) => debate.roundId === round.id)).toHaveLength(0);
    state = await palettes("simpletab.draw.generate-draw", "Round 1", "4242");
    const debate = state.debates.find((item) => item.roundId === round.id)!;
    expect(debate).toBeDefined();

    // The allocation: a bad panel size is asked again.
    state = await palettes("simpletab.allocation.auto-allocate", "Round 1", "0", "2");
    const allocated = state.debates.find((item) => item.id === debate.id)!;
    expect(allocated.adjudicators.chairId).toBeTruthy();

    // A ballot, built rank by rank and score by score in the palette, confirmed on entry.
    const sides = Object.keys(debate.teams);
    const ballotAnswers: Answer[] = ["Round 1", KEEP, motion.text, "Yes"];
    sides.forEach((_, index) => {
      ballotAnswers.push(index + 1, String(80 - index * 3), String(79 - index * 3));
    });
    state = await palettes("simpletab.results.enter-ballot", ...ballotAnswers);
    const ballot = state.ballots.find((item) => item.debateId === debate.id && !item.discarded)!;
    expect(ballot.confirmed).toBe(true);
    expect(ballot.motionId).toBe(motion.id);

    // Escape part-way through changes nothing.
    palette.answer("Room 101", undefined);
    const before = store.getState()!.seq;
    expect(await executeAction(action("simpletab.participants.edit-venue"), ctx, undefined, notify)).toBeUndefined();
    await store.refresh();
    expect(store.getState()!.seq).toBe(before);

    // A refusal from the host is shown as a message, not swallowed.
    // (Settings with a minimum speaker score above the maximum: name, min, max, step, prelims, break.)
    palette.answer(KEEP, "90", "60", KEEP, KEEP, KEEP);
    errors.length = 0;
    const refused = await executeAction(action("simpletab.setup.save-settings"), ctx, undefined, notify);
    expect(refused?.ok).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.length).toBeGreaterThan(0);

    // The full integrity check, and navigation.
    await palettes("simpletab.status.run-full-check");
    await palettes("simpletab.results.open");
    expect(opened).toEqual(["simpletab-results-widget"]);

    timings.sort((a, b) => a - b);
    const p95 = timings[Math.min(timings.length - 1, Math.floor(timings.length * 0.95))]!;
    console.log(JSON.stringify({ commands: timings.length, p50: Math.round(timings[Math.floor(timings.length / 2)]!), p95: Math.round(p95) }));
    expect(p95).toBeLessThan(5_000);
  });
});

/** Keeps each speaker's name and email as they are. */
function speakerAnswers(team: ProjectedState["teams"][number]): Answer[] {
  return team.speakers.flatMap(() => [KEEP, KEEP]);
}
