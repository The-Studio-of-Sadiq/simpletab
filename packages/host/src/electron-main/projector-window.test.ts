import {
  computeRemainingSeconds,
  pauseCountdownState,
  resetCountdownState,
  startCountdownState,
  type ProjectorCountdownState,
} from "../common/projector-protocol";
import { selectProjectorDisplayBounds } from "./projector-window";

describe("projector window helpers", () => {
  it("selects the non-primary display when available and falls back to primary", () => {
    const displays = [
      { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
      { id: 2, bounds: { x: 1920, y: 0, width: 1280, height: 720 } },
    ];
    expect(selectProjectorDisplayBounds(displays, 1)).toEqual({
      x: 1920,
      y: 0,
      width: 1280,
      height: 720,
    });
    expect(selectProjectorDisplayBounds([displays[0]!], 1)).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    });
  });

  it("handles countdown start, pause, and reset deterministically", () => {
    const initial: ProjectorCountdownState = {
      durationSeconds: 900,
      remainingSeconds: 900,
      running: false,
      updatedAtMs: 0,
    };

    const started = startCountdownState(initial, 10_000);
    expect(started.running).toBe(true);
    expect(computeRemainingSeconds(started, 15_000)).toBe(895);

    const paused = pauseCountdownState(started, 25_000);
    expect(paused.running).toBe(false);
    expect(paused.remainingSeconds).toBe(885);
    expect(computeRemainingSeconds(paused, 99_000)).toBe(885);

    const resumed = startCountdownState(paused, 100_000);
    expect(resumed.running).toBe(true);
    expect(computeRemainingSeconds(resumed, 105_000)).toBe(880);

    const reset = resetCountdownState(resumed, 110_000, 600);
    expect(reset).toEqual({
      durationSeconds: 600,
      remainingSeconds: 600,
      running: false,
      updatedAtMs: 110_000,
    });
  });
});
