import type { RpcServer } from "@theia/core/lib/common/messaging";
import type { ProjectedState } from "./host-protocol";

export const PROJECTOR_SERVICE_PATH = "/services/simpletab-projector";

export const ProjectorService = Symbol("ProjectorService");
export const ProjectorServiceClient = Symbol("ProjectorServiceClient");

export type ProjectorMode = "auto" | "motion" | "draw" | "countdown";

export interface ProjectorCountdownState {
  durationSeconds: number;
  remainingSeconds: number;
  running: boolean;
  updatedAtMs: number;
}

export interface ProjectorControlState {
  open: boolean;
  fullscreen: boolean;
  roundId: string | null;
  mode: ProjectorMode;
  pageIntervalSeconds: number;
  roomsPerPage: number;
  countdown: ProjectorCountdownState;
}

export interface ProjectorSyncPayload {
  control: ProjectorControlState;
  displayState: ProjectedState | null;
}

export type ProjectorControlPatch = Partial<
  Pick<
    ProjectorControlState,
    "roundId" | "mode" | "pageIntervalSeconds" | "roomsPerPage"
  >
>;

export interface ProjectorServiceClient {
  onProjectorUpdate(payload: ProjectorSyncPayload): void;
}

export interface ProjectorService extends RpcServer<ProjectorServiceClient> {
  getSyncPayload(): Promise<ProjectorSyncPayload>;
  openProjector(): Promise<ProjectorControlState>;
  closeProjector(): Promise<ProjectorControlState>;
  toggleFullscreen(): Promise<ProjectorControlState>;
  updateControl(patch: ProjectorControlPatch): Promise<ProjectorControlState>;
  startCountdown(durationSeconds?: number): Promise<ProjectorControlState>;
  pauseCountdown(): Promise<ProjectorControlState>;
  resetCountdown(durationSeconds?: number): Promise<ProjectorControlState>;
  pushDisplayState(displayState: ProjectedState | null): Promise<void>;
}

export const DEFAULT_COUNTDOWN_SECONDS = 900;

export const DEFAULT_PROJECTOR_CONTROL: Readonly<ProjectorControlState> = {
  open: false,
  fullscreen: false,
  roundId: null,
  mode: "auto",
  pageIntervalSeconds: 8,
  roomsPerPage: 8,
  countdown: {
    durationSeconds: DEFAULT_COUNTDOWN_SECONDS,
    remainingSeconds: DEFAULT_COUNTDOWN_SECONDS,
    running: false,
    updatedAtMs: 0,
  },
};

function sanitizeDuration(
  candidate: number | undefined,
  fallback: number,
): number {
  if (
    candidate === undefined ||
    !Number.isFinite(candidate) ||
    candidate < 0
  ) {
    return fallback;
  }
  return Math.floor(candidate);
}

/** Computes remaining countdown seconds at `nowMs` without mutating state. */
export function computeRemainingSeconds(
  countdown: ProjectorCountdownState,
  nowMs: number,
): number {
  const base = Math.max(0, Math.floor(countdown.remainingSeconds));
  if (!countdown.running) {
    return base;
  }
  const elapsedSeconds = Math.max(
    0,
    Math.floor((nowMs - countdown.updatedAtMs) / 1000),
  );
  return Math.max(0, base - elapsedSeconds);
}

/** Formats total seconds as `MM:SS` (or `HH:MM:SS` when >= 1 hour). */
export function formatCountdown(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const seconds = clamped % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}

/** Transitions a countdown to running, preserving remaining time unless restarted or given a duration. */
export function startCountdownState(
  countdown: ProjectorCountdownState,
  nowMs: number,
  durationSeconds?: number,
): ProjectorCountdownState {
  if (durationSeconds !== undefined) {
    const nextDuration = sanitizeDuration(
      durationSeconds,
      countdown.durationSeconds,
    );
    return {
      durationSeconds: nextDuration,
      remainingSeconds: nextDuration,
      running: nextDuration > 0,
      updatedAtMs: nowMs,
    };
  }
  const currentRemaining = computeRemainingSeconds(countdown, nowMs);
  const nextRemaining =
    currentRemaining > 0 ? currentRemaining : countdown.durationSeconds;
  return {
    durationSeconds: countdown.durationSeconds,
    remainingSeconds: nextRemaining,
    running: nextRemaining > 0,
    updatedAtMs: nowMs,
  };
}

/** Pauses a running countdown and snapshots the remaining seconds at `nowMs`. */
export function pauseCountdownState(
  countdown: ProjectorCountdownState,
  nowMs: number,
): ProjectorCountdownState {
  const remainingSeconds = computeRemainingSeconds(countdown, nowMs);
  return {
    durationSeconds: countdown.durationSeconds,
    remainingSeconds,
    running: false,
    updatedAtMs: nowMs,
  };
}

/** Resets a countdown to `durationSeconds` (or its configured duration) in paused state. */
export function resetCountdownState(
  countdown: ProjectorCountdownState,
  nowMs: number,
  durationSeconds?: number,
): ProjectorCountdownState {
  const nextDuration = sanitizeDuration(
    durationSeconds,
    countdown.durationSeconds,
  );
  return {
    durationSeconds: nextDuration,
    remainingSeconds: nextDuration,
    running: false,
    updatedAtMs: nowMs,
  };
}
