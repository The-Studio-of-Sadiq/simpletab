import path from "node:path";
import {
  ElectronMainApplicationGlobals,
} from "@theia/core/lib/electron-main/electron-main-application";
import { inject, injectable } from "@theia/core/shared/inversify";
import {
  BrowserWindow,
  screen,
  type Display,
} from "@theia/electron/shared/electron";
import type { ProjectedState } from "../common/host-protocol";
import {
  DEFAULT_PROJECTOR_CONTROL,
  pauseCountdownState,
  resetCountdownState,
  startCountdownState,
  type ProjectorControlPatch,
  type ProjectorControlState,
  type ProjectorService,
  type ProjectorServiceClient,
  type ProjectorSyncPayload,
} from "../common/projector-protocol";

export interface DisplayBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayLike {
  id: number;
  bounds: DisplayBounds;
}

/**
 * Selects the first non-primary display when a second monitor is attached,
 * otherwise falls back to the primary display (or a sensible default).
 */
export function selectProjectorDisplayBounds(
  displays: readonly DisplayLike[],
  primaryDisplayId: number,
): DisplayBounds {
  const secondary = displays.find((d) => d.id !== primaryDisplayId);
  if (secondary !== undefined) {
    return { ...secondary.bounds };
  }
  const primary =
    displays.find((d) => d.id === primaryDisplayId) ?? displays[0];
  if (primary !== undefined) {
    return { ...primary.bounds };
  }
  return { x: 0, y: 0, width: 1280, height: 720 };
}

@injectable()
export class ElectronProjectorService {
  private projectorWindow: BrowserWindow | null = null;
  private control: ProjectorControlState = {
    ...DEFAULT_PROJECTOR_CONTROL,
    countdown: { ...DEFAULT_PROJECTOR_CONTROL.countdown },
  };
  private displayState: ProjectedState | null = null;
  private readonly clients = new Set<ProjectorServiceClient>();

  constructor(
    @inject(ElectronMainApplicationGlobals)
    private readonly globals: ElectronMainApplicationGlobals,
  ) {}

  createClientAdapter(client: ProjectorServiceClient): ProjectorService {
    this.clients.add(client);
    let activeClient: ProjectorServiceClient | undefined = client;
    return {
      setClient: (nextClient: ProjectorServiceClient | undefined) => {
        if (activeClient !== undefined) {
          this.clients.delete(activeClient);
        }
        activeClient = nextClient;
        if (nextClient !== undefined) {
          this.clients.add(nextClient);
        }
      },
      getClient: () => activeClient,
      dispose: () => {
        if (activeClient !== undefined) {
          this.clients.delete(activeClient);
          activeClient = undefined;
        }
      },
      getSyncPayload: () => this.getSyncPayload(),
      openProjector: () => this.openProjector(),
      closeProjector: () => this.closeProjector(),
      toggleFullscreen: () => this.toggleFullscreen(),
      updateControl: (patch: ProjectorControlPatch) => this.updateControl(patch),
      startCountdown: (durationSeconds?: number) =>
        this.startCountdown(durationSeconds),
      pauseCountdown: () => this.pauseCountdown(),
      resetCountdown: (durationSeconds?: number) =>
        this.resetCountdown(durationSeconds),
      pushDisplayState: (displayState: ProjectedState | null) =>
        this.pushDisplayState(displayState),
    };
  }

  async getSyncPayload(): Promise<ProjectorSyncPayload> {
    return {
      control: this.cloneControl(),
      displayState: this.displayState,
    };
  }

  async openProjector(): Promise<ProjectorControlState> {
    if (this.projectorWindow !== null && !this.projectorWindow.isDestroyed()) {
      if (this.projectorWindow.isMinimized()) {
        this.projectorWindow.restore();
      }
      this.projectorWindow.show();
      this.projectorWindow.focus();
      this.control = {
        ...this.control,
        open: true,
        fullscreen: this.projectorWindow.isFullScreen(),
      };
      this.broadcast();
      return this.cloneControl();
    }

    const displays: Display[] = screen.getAllDisplays();
    const primary = screen.getPrimaryDisplay();
    const bounds = selectProjectorDisplayBounds(displays, primary.id);
    const preloadPath = path.resolve(
      this.globals.THEIA_APP_PROJECT_PATH,
      "lib",
      "frontend",
      "preload.js",
    );
    const htmlPath = path.resolve(
      this.globals.THEIA_APP_PROJECT_PATH,
      "lib",
      "frontend",
      "projector.html",
    );

    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      title: "SimpleTab Projector",
      backgroundColor: "#0e1116",
      fullscreenable: true,
      autoHideMenuBar: true,
      show: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
        preload: preloadPath,
      },
    });

    this.projectorWindow = win;
    this.control = {
      ...this.control,
      open: true,
      fullscreen: win.isFullScreen(),
    };

    win.on("enter-full-screen", () => {
      this.control = { ...this.control, fullscreen: true };
      this.broadcast();
    });
    win.on("leave-full-screen", () => {
      this.control = { ...this.control, fullscreen: false };
      this.broadcast();
    });
    win.on("closed", () => {
      if (this.projectorWindow === win) {
        this.projectorWindow = null;
      }
      this.control = { ...this.control, open: false, fullscreen: false };
      this.broadcast();
    });

    await win.loadFile(htmlPath);
    this.broadcast();
    return this.cloneControl();
  }

  async closeProjector(): Promise<ProjectorControlState> {
    if (this.projectorWindow !== null && !this.projectorWindow.isDestroyed()) {
      this.projectorWindow.close();
    }
    this.projectorWindow = null;
    this.control = { ...this.control, open: false, fullscreen: false };
    this.broadcast();
    return this.cloneControl();
  }

  async toggleFullscreen(): Promise<ProjectorControlState> {
    if (this.projectorWindow !== null && !this.projectorWindow.isDestroyed()) {
      const next = !this.projectorWindow.isFullScreen();
      this.projectorWindow.setFullScreen(next);
      this.control = { ...this.control, fullscreen: next };
      this.broadcast();
    }
    return this.cloneControl();
  }

  async updateControl(
    patch: ProjectorControlPatch,
  ): Promise<ProjectorControlState> {
    const nextInterval =
      patch.pageIntervalSeconds !== undefined &&
      Number.isFinite(patch.pageIntervalSeconds) &&
      patch.pageIntervalSeconds >= 2
        ? Math.floor(patch.pageIntervalSeconds)
        : this.control.pageIntervalSeconds;
    const nextRoomsPerPage =
      patch.roomsPerPage !== undefined &&
      Number.isFinite(patch.roomsPerPage) &&
      patch.roomsPerPage >= 1
        ? Math.floor(patch.roomsPerPage)
        : this.control.roomsPerPage;
    this.control = {
      ...this.control,
      ...(patch.roundId !== undefined ? { roundId: patch.roundId } : {}),
      ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
      pageIntervalSeconds: nextInterval,
      roomsPerPage: nextRoomsPerPage,
    };
    this.broadcast();
    return this.cloneControl();
  }

  async startCountdown(
    durationSeconds?: number,
  ): Promise<ProjectorControlState> {
    this.control = {
      ...this.control,
      countdown: startCountdownState(
        this.control.countdown,
        Date.now(),
        durationSeconds,
      ),
    };
    this.broadcast();
    return this.cloneControl();
  }

  async pauseCountdown(): Promise<ProjectorControlState> {
    this.control = {
      ...this.control,
      countdown: pauseCountdownState(this.control.countdown, Date.now()),
    };
    this.broadcast();
    return this.cloneControl();
  }

  async resetCountdown(
    durationSeconds?: number,
  ): Promise<ProjectorControlState> {
    this.control = {
      ...this.control,
      countdown: resetCountdownState(
        this.control.countdown,
        Date.now(),
        durationSeconds,
      ),
    };
    this.broadcast();
    return this.cloneControl();
  }

  async pushDisplayState(displayState: ProjectedState | null): Promise<void> {
    this.displayState = displayState;
    this.broadcast();
  }

  disposeWindow(): void {
    if (this.projectorWindow !== null && !this.projectorWindow.isDestroyed()) {
      this.projectorWindow.destroy();
    }
    this.projectorWindow = null;
    this.clients.clear();
  }

  private cloneControl(): ProjectorControlState {
    return {
      ...this.control,
      countdown: { ...this.control.countdown },
    };
  }

  private broadcast(): void {
    const payload: ProjectorSyncPayload = {
      control: this.cloneControl(),
      displayState: this.displayState,
    };
    for (const client of [...this.clients]) {
      try {
        client.onProjectorUpdate(payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }
}
