import type { ProjectedState } from "@simpletab/host/lib/common/host-protocol";
import { DEFAULT_PROJECTOR_CONTROL } from "@simpletab/host/lib/common/projector-protocol";
import { describe, expect, it } from "vitest";
import {
  closeProjectorAction,
  openProjectorAction,
  pauseProjectorCountdownAction,
  resetProjectorCountdownAction,
  startProjectorCountdownAction,
  toggleProjectorFullscreenAction,
  updateProjectorControlAction,
} from "./projector-actions";
import {
  fakeProjectorService,
  fakeStore,
  scriptedPrompts,
  testContext,
  type ScriptedPrompts,
} from "./test-context";

function context(
  answers: unknown[] = [],
  withProjector = true,
): {
  ctx: ReturnType<typeof testContext>;
  fake: ReturnType<typeof fakeProjectorService>;
  calls: ReturnType<typeof fakeStore>["calls"];
} {
  const projector = fakeProjectorService();
  const displayState = { seq: 7 } as unknown as ProjectedState;
  const { store, calls } = fakeStore(null, undefined, { displayState });
  return {
    ctx: testContext(
      store,
      scriptedPrompts(answers),
      async () => undefined,
      withProjector ? { projector: projector.service } : {},
    ),
    fake: projector,
    calls,
  };
}

describe("projector actions", () => {
  it("prompts for no arguments where the button already knows what to do", async () => {
    expect(await openProjectorAction.prompt(context().ctx)).toEqual({});
    expect(await closeProjectorAction.prompt(context().ctx)).toEqual({});
    expect(await toggleProjectorFullscreenAction.prompt(context().ctx)).toEqual({});
    expect(await pauseProjectorCountdownAction.prompt(context().ctx)).toEqual({});
  });

  it("asks minutes again until valid, as the page's minutes field, when a finished timer starts", async () => {
    const finished = {
      ...DEFAULT_PROJECTOR_CONTROL,
      countdown: { ...DEFAULT_PROJECTOR_CONTROL.countdown, remainingSeconds: 0, running: false },
    };
    const projector = fakeProjectorService(finished);
    const prompts = scriptedPrompts(["not a number", "0", "2"]);
    const ctx = testContext(fakeStore(null).store, prompts, async () => undefined, {
      projector: projector.service,
    });
    expect(await startProjectorCountdownAction.prompt(ctx)).toEqual({ durationSeconds: 120 });
    expect(prompts.asked).toHaveLength(3);

    // A paused or running timer resumes without asking.
    const resume = context([]);
    expect(await startProjectorCountdownAction.prompt(resume.ctx)).toEqual({});

    // Reset: blank keeps the host's length.
    const optional = context(["   "]);
    expect(await resetProjectorCountdownAction.prompt(optional.ctx)).toEqual({});
  });
  it("cancels a duration prompt on Escape", async () => {
    const { ctx } = context([undefined]);
    expect(await resetProjectorCountdownAction.prompt(ctx)).toBeUndefined();
  });
  it("asks again for an out-of-range control number and picks rounds and modes", async () => {
    const { ctx } = context(["roomsPerPage", "0", "40", "12"]);
    expect(await updateProjectorControlAction.prompt(ctx)).toEqual({ patch: { roomsPerPage: 12 } });
    expect((ctx.prompts as ScriptedPrompts).asked).toHaveLength(4);

    const mode = context(["mode", "draw"]);
    expect(await updateProjectorControlAction.prompt(mode.ctx)).toEqual({ patch: { mode: "draw" } });

    const round = context(["roundId", "r1"]);
    expect(await updateProjectorControlAction.prompt(round.ctx)).toEqual({ patch: { roundId: "r1" } });
  });

  it("pushes the display state and opens the projector", async () => {
    const { ctx, fake, calls } = context();
    const result = await openProjectorAction.run(ctx, {});
    expect(result.ok).toBe(true);
    expect(calls.displayStateReads).toBe(1);
    expect(fake.calls.pushes).toEqual([{ seq: 7 }]);
    expect(fake.calls.opens).toBe(1);
  });

  it("runs the close, fullscreen and pause controls", async () => {
    const { ctx, fake } = context();
    expect((await closeProjectorAction.run(ctx, {})).ok).toBe(true);
    expect((await toggleProjectorFullscreenAction.run(ctx, {})).ok).toBe(true);
    expect((await pauseProjectorCountdownAction.run(ctx, {})).ok).toBe(true);
    expect(fake.calls.closes).toBe(1);
    expect(fake.calls.fullscreenToggles).toBe(1);
    expect(fake.calls.pauses).toBe(1);
  });

  it("runs control updates and countdown commands with their arguments", async () => {
    const { ctx, fake } = context();
    expect(
      (await updateProjectorControlAction.run(ctx, {
        patch: { roomsPerPage: 3 },
      })).ok,
    ).toBe(true);
    expect(
      (await startProjectorCountdownAction.run(ctx, { durationSeconds: 90 })).ok,
    ).toBe(true);
    expect((await resetProjectorCountdownAction.run(ctx, {})).ok).toBe(true);
    expect(fake.calls.updates).toEqual([{ roomsPerPage: 3 }]);
    expect(fake.calls.starts).toEqual([90]);
    expect(fake.calls.resets).toEqual([undefined]);
  });

  it("is always enabled", () => {
    const snapshot = fakeStore(null).store.getSnapshot();
    for (const action of [
      openProjectorAction,
      closeProjectorAction,
      toggleProjectorFullscreenAction,
      updateProjectorControlAction,
      startProjectorCountdownAction,
      pauseProjectorCountdownAction,
      resetProjectorCountdownAction,
    ]) {
      expect(action.isEnabled?.(snapshot)).toBe(true);
    }
  });
});
