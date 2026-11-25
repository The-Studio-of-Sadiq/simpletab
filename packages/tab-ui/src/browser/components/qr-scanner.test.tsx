import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QrScanner, type QrScannerLabels } from "./qr-scanner";

const LABELS: QrScannerLabels = {
  start: "Start camera",
  stop: "Stop camera",
  starting: "Starting camera…",
  scanning: "Scanning for QR ballot…",
  partial: (have, of) => `Scanned part ${have} of ${of}`,
  cameraDenied: "Camera permission denied.",
  noCamera: "No camera found.",
  cameraFailed: "Could not start camera.",
  videoLabel: "Camera preview for QR scanning",
};

interface MockTrack {
  stop: ReturnType<typeof vi.fn<() => void>>;
}

function createFakeStream(): {
  stream: MediaStream;
  tracks: MockTrack[];
} {
  const tracks: MockTrack[] = [{ stop: vi.fn<() => void>() }];
  const stream = {
    getTracks: () => tracks,
  } as unknown as MediaStream;
  return { stream, tracks };
}

function configureVideoFrame(
  video: HTMLVideoElement,
  width = 640,
  height = 480,
  readyState = 2,
): void {
  Object.defineProperty(video, "videoWidth", {
    configurable: true,
    value: width,
  });
  Object.defineProperty(video, "videoHeight", {
    configurable: true,
    value: height,
  });
  Object.defineProperty(video, "readyState", {
    configurable: true,
    value: readyState,
  });
  Object.defineProperty(video, "play", {
    configurable: true,
    value: vi.fn(async () => undefined),
  });
}

describe("QrScanner", () => {
  let getContextSpy: ReturnType<typeof vi.spyOn>;
  let drawImageMock: ReturnType<typeof vi.fn>;
  let getImageDataMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    drawImageMock = vi.fn();
    getImageDataMock = vi.fn((_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(w * h * 4),
      width: w,
      height: h,
      colorSpace: "srgb" as PredefinedColorSpace,
    }));
    getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockImplementation(
        () =>
          ({
            drawImage: drawImageMock,
            getImageData: getImageDataMock,
          }) as unknown as CanvasRenderingContext2D,
      );
  });

  afterEach(() => {
    cleanup();
    getContextSpy.mockRestore();
    vi.useRealTimers();
  });

  it("calls onCodes once for a single ST1 code even across many consecutive frames", async () => {
    const { stream, tracks } = createFakeStream();
    const getUserMedia = vi.fn(async () => stream);
    const decode = vi.fn(() => ({ data: "ST1.body123.mac456" }));
    const onCodes = vi.fn();

    render(
      <QrScanner
        onCodes={onCodes}
        getUserMedia={getUserMedia}
        decode={decode}
        framesPerSecond={8}
        labels={LABELS}
      />,
    );

    const video = screen.getByLabelText(LABELS.videoLabel) as HTMLVideoElement;
    configureVideoFrame(video);
    expect(video.muted).toBe(true);
    expect(video.playsInline).toBe(true);
    expect(video.hidden).toBe(true);

    const startBtn = screen.getByRole("button", { name: LABELS.start });
    await act(async () => {
      fireEvent.click(startBtn);
      await Promise.resolve();
    });

    expect(getUserMedia).toHaveBeenCalledWith({
      video: { facingMode: "environment" },
      audio: false,
    });
    expect(screen.getByRole("status").textContent).toBe(LABELS.scanning);
    expect(video.hidden).toBe(false);

    // Advance across 10 frames (10 * 125ms = 1250ms).
    for (let i = 0; i < 10; i++) {
      act(() => {
        vi.advanceTimersByTime(125);
      });
    }

    expect(decode).toHaveBeenCalledTimes(10);
    expect(drawImageMock).toHaveBeenCalledTimes(10);
    expect(getImageDataMock).toHaveBeenCalledTimes(10);
    expect(onCodes).toHaveBeenCalledTimes(1);
    expect(onCodes).toHaveBeenCalledWith(["ST1.body123.mac456"]);
    expect(screen.getByRole("status").textContent).toBe(LABELS.scanning);
    expect(tracks[0]!.stop).not.toHaveBeenCalled();
  });

  it("collects 3 fragments in any order, announces partial status, and calls onCodes once with ordered codes", async () => {
    const { stream } = createFakeStream();
    const getUserMedia = vi.fn(async () => stream);
    const f1 = "ST1F.sid99.1.3.2000.hashTag1234567890123456.part1";
    const f2 = "ST1F.sid99.2.3.2000.hashTag1234567890123456.part2";
    const f3 = "ST1F.sid99.3.3.2000.hashTag1234567890123456.part3";

    const frameResults: Array<{ data: string } | null> = [
      null,
      { data: f3 },
      { data: f3 },
      { data: f1 },
      { data: f1 },
      { data: f2 },
      { data: f2 },
    ];
    let frameIdx = 0;
    const decode = vi.fn(() => frameResults[frameIdx++] ?? null);
    const onCodes = vi.fn();

    render(
      <QrScanner
        onCodes={onCodes}
        getUserMedia={getUserMedia}
        decode={decode}
        framesPerSecond={10}
        labels={LABELS}
      />,
    );

    const video = screen.getByLabelText(LABELS.videoLabel) as HTMLVideoElement;
    configureVideoFrame(video);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: LABELS.start }));
      await Promise.resolve();
    });

    // Frame 1: null
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByRole("status").textContent).toBe(LABELS.scanning);

    // Frame 2 & 3: f3 (1/3)
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByRole("status").textContent).toBe("Scanned part 1 of 3");
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByRole("status").textContent).toBe("Scanned part 1 of 3");

    // Frame 4 & 5: f1 (2/3)
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByRole("status").textContent).toBe("Scanned part 2 of 3");
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.getByRole("status").textContent).toBe("Scanned part 2 of 3");
    expect(onCodes).not.toHaveBeenCalled();

    // Frame 6: f2 -> completes [f1, f2, f3]
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(onCodes).toHaveBeenCalledTimes(1);
    expect(onCodes).toHaveBeenCalledWith([f1, f2, f3]);
    expect(screen.getByRole("status").textContent).toBe(LABELS.scanning);

    // Frame 7: trailing duplicate f2 does not re-trigger onCodes or partial status
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(onCodes).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toBe(LABELS.scanning);
  });

  it("shows cameraDenied, noCamera, and cameraFailed alerts for camera errors", async () => {
    const makeError = (name: string): Error => {
      const err = new Error(name);
      err.name = name;
      return err;
    };

    const getUserMedia = vi
      .fn<() => Promise<MediaStream>>()
      .mockRejectedValueOnce(makeError("NotAllowedError"))
      .mockRejectedValueOnce(makeError("NotFoundError"))
      .mockRejectedValueOnce(makeError("OverconstrainedError"))
      .mockRejectedValueOnce(makeError("AbortError"));

    render(
      <QrScanner
        onCodes={vi.fn()}
        getUserMedia={getUserMedia}
        decode={vi.fn(() => null)}
        labels={LABELS}
      />,
    );

    const clickStart = async (): Promise<void> => {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: LABELS.start }));
        await Promise.resolve();
      });
    };

    await clickStart();
    expect(screen.getByRole("alert").textContent).toBe(LABELS.cameraDenied);

    await clickStart();
    expect(screen.getByRole("alert").textContent).toBe(LABELS.noCamera);

    await clickStart();
    expect(screen.getByRole("alert").textContent).toBe(LABELS.noCamera);

    await clickStart();
    expect(screen.getByRole("alert").textContent).toBe(LABELS.cameraFailed);
  });

  it("stops tracks and polling timer when Stop is clicked", async () => {
    const { stream, tracks } = createFakeStream();
    const getUserMedia = vi.fn(async () => stream);
    const decode = vi.fn(() => null);

    render(
      <QrScanner
        onCodes={vi.fn()}
        getUserMedia={getUserMedia}
        decode={decode}
        framesPerSecond={8}
        labels={LABELS}
      />,
    );

    const video = screen.getByLabelText(LABELS.videoLabel) as HTMLVideoElement;
    configureVideoFrame(video);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: LABELS.start }));
      await Promise.resolve();
    });

    act(() => {
      vi.advanceTimersByTime(125);
    });
    expect(decode).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: LABELS.stop }));
    expect(tracks[0]!.stop).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: LABELS.start })).toBeTruthy();
    expect(video.hidden).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it("stops tracks and polling timer on unmount and cancels pending getUserMedia", async () => {
    const { stream, tracks } = createFakeStream();
    const getUserMedia = vi.fn(async () => stream);
    const decode = vi.fn(() => null);

    const firstRender = render(
      <QrScanner
        onCodes={vi.fn()}
        getUserMedia={getUserMedia}
        decode={decode}
        framesPerSecond={8}
        labels={LABELS}
      />,
    );

    const video = screen.getByLabelText(LABELS.videoLabel) as HTMLVideoElement;
    configureVideoFrame(video);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: LABELS.start }));
      await Promise.resolve();
    });

    firstRender.unmount();
    expect(tracks[0]!.stop).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(decode).not.toHaveBeenCalled();

    // Also verify pending getUserMedia that resolves after unmount stops its stream.
    let resolveLate!: (s: MediaStream) => void;
    const lateStream = createFakeStream();
    const lateGetUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolveLate = resolve;
        }),
    );

    const secondRender = render(
      <QrScanner
        onCodes={vi.fn()}
        getUserMedia={lateGetUserMedia}
        decode={decode}
        labels={LABELS}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: LABELS.start }));
    expect(screen.getByRole("status").textContent).toBe(LABELS.starting);

    secondRender.unmount();
    await act(async () => {
      resolveLate(lateStream.stream);
      await Promise.resolve();
    });
    expect(lateStream.tracks[0]!.stop).toHaveBeenCalledTimes(1);
  });
});
