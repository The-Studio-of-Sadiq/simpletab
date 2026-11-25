import * as React from "@theia/core/shared/react";
import jsQR from "jsqr";
import { QrFragmentCollector } from "../lib/qr-fragments";

export interface QrScannerLabels {
  start: string;
  stop: string;
  starting: string;
  scanning: string;
  partial: (have: number, of: number) => string;
  cameraDenied: string;
  noCamera: string;
  cameraFailed: string;
  videoLabel: string;
}

export interface QrScannerProps {
  /** Called once per complete code set (single code or all fragments). */
  onCodes(codes: string[]): void;
  /** Injected for tests; default: navigator.mediaDevices.getUserMedia */
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  /** Injected for tests; default: jsQR from "jsqr" */
  decode?: (
    data: Uint8ClampedArray,
    width: number,
    height: number,
  ) => { data: string } | null;
  framesPerSecond?: number; // default 8
  labels: QrScannerLabels;
}

type ScannerPhase = "idle" | "starting" | "scanning";

interface PartialProgress {
  have: number;
  of: number;
}

const DEFAULT_FPS = 8;

const defaultGetUserMedia = (
  constraints: MediaStreamConstraints,
): Promise<MediaStream> => {
  if (
    typeof navigator === "undefined" ||
    navigator.mediaDevices === undefined ||
    typeof navigator.mediaDevices.getUserMedia !== "function"
  ) {
    const err = new Error("Camera access is not available.");
    err.name = "NotFoundError";
    return Promise.reject(err);
  }
  return navigator.mediaDevices.getUserMedia(constraints);
};

const defaultDecode = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
): { data: string } | null =>
  jsQR(data, width, height, { inversionAttempts: "attemptBoth" });

function mapCameraError(err: unknown, labels: QrScannerLabels): string {
  const name =
    err instanceof Error
      ? err.name
      : typeof err === "object" &&
          err !== null &&
          "name" in err &&
          typeof (err as { name: unknown }).name === "string"
        ? (err as { name: string }).name
        : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return labels.cameraDenied;
  }
  if (
    name === "NotFoundError" ||
    name === "OverconstrainedError" ||
    name === "DevicesNotFoundError"
  ) {
    return labels.noCamera;
  }
  return labels.cameraFailed;
}

function stopStreamTracks(stream: MediaStream | null): void {
  if (stream === null) return;
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

/**
 * Webcam QR ballot scanner (design section 4 & Appendix E).
 * Decodes frames locally in memory using jsQR and forwards complete
 * single or reassembled fragment code sets via `onCodes`.
 */
export const QrScanner: React.FC<QrScannerProps> = ({
  onCodes,
  getUserMedia,
  decode,
  framesPerSecond = DEFAULT_FPS,
  labels,
}) => {
  const [phase, setPhase] = React.useState<ScannerPhase>("idle");
  const [partial, setPartial] = React.useState<PartialProgress | null>(null);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const streamRef = React.useRef<MediaStream | null>(null);
  const timerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const collectorRef = React.useRef<QrFragmentCollector>(
    new QrFragmentCollector(),
  );
  const sessionRef = React.useRef(0);

  const onCodesRef = React.useRef(onCodes);
  onCodesRef.current = onCodes;
  const getUserMediaRef = React.useRef(getUserMedia);
  getUserMediaRef.current = getUserMedia;
  const decodeRef = React.useRef(decode);
  decodeRef.current = decode;
  const labelsRef = React.useRef(labels);
  labelsRef.current = labels;

  const cleanupMedia = React.useCallback((updateState: boolean): void => {
    sessionRef.current += 1;

    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    stopStreamTracks(streamRef.current);
    streamRef.current = null;

    const video = videoRef.current;
    if (video !== null) {
      try {
        video.srcObject = null;
      } catch {
        // Ignore strict DOM setter failures in non-browser environments.
      }
    }

    if (canvasRef.current !== null) {
      canvasRef.current.width = 0;
      canvasRef.current.height = 0;
      canvasRef.current = null;
    }

    collectorRef.current.reset();

    if (updateState) {
      setPartial(null);
      setPhase("idle");
    }
  }, []);

  React.useEffect(() => () => cleanupMedia(false), [cleanupMedia]);

  const scanFrame = React.useCallback((): void => {
    const video = videoRef.current;
    if (video === null || video.readyState < 2) {
      return;
    }

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (width <= 0 || height <= 0) {
      return;
    }

    let canvas = canvasRef.current;
    if (canvas === null) {
      canvas = document.createElement("canvas");
      canvasRef.current = canvas;
    }
    if (canvas.width !== width) {
      canvas.width = width;
    }
    if (canvas.height !== height) {
      canvas.height = height;
    }

    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx === null) {
      return;
    }

    ctx.drawImage(video, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    const decoder = decodeRef.current ?? defaultDecode;
    const decoded = decoder(imageData.data, width, height);

    if (decoded === null || decoded.data.length === 0) {
      return;
    }

    const collected = collectorRef.current.add(decoded.data);
    if (collected.kind === "complete") {
      setPartial(null);
      onCodesRef.current(collected.codes);
    } else if (collected.kind === "partial") {
      setPartial((prev) =>
        prev !== null &&
        prev.have === collected.have &&
        prev.of === collected.of
          ? prev
          : { have: collected.have, of: collected.of },
      );
    }
  }, []);

  const handleStart = React.useCallback(async (): Promise<void> => {
    cleanupMedia(false);
    setErrorMessage(null);
    setPartial(null);
    setPhase("starting");

    const mySession = sessionRef.current;
    const requestMedia = getUserMediaRef.current ?? defaultGetUserMedia;

    try {
      const stream = await requestMedia({
        video: { facingMode: "environment" },
        audio: false,
      });

      if (sessionRef.current !== mySession) {
        stopStreamTracks(stream);
        return;
      }

      streamRef.current = stream;

      const video = videoRef.current;
      if (video !== null) {
        try {
          video.srcObject = stream;
        } catch {
          // Allow synthetic stream objects in environments where srcObject enforces MediaStream.
        }
        if (typeof video.play === "function") {
          const playResult: unknown = video.play();
          if (
            typeof playResult === "object" &&
            playResult !== null &&
            "catch" in playResult &&
            typeof (playResult as Promise<unknown>).catch === "function"
          ) {
            void (playResult as Promise<unknown>).catch(() => undefined);
          }
        }
      }

      const fps =
        Number.isFinite(framesPerSecond) && framesPerSecond > 0
          ? framesPerSecond
          : DEFAULT_FPS;
      const intervalMs = Math.max(1, Math.round(1000 / fps));

      setPhase("scanning");
      timerRef.current = setInterval(scanFrame, intervalMs);
    } catch (err) {
      if (sessionRef.current !== mySession) {
        return;
      }
      setPhase("idle");
      setPartial(null);
      setErrorMessage(mapCameraError(err, labelsRef.current));
    }
  }, [cleanupMedia, framesPerSecond, scanFrame]);

  const handleStop = React.useCallback((): void => {
    cleanupMedia(true);
  }, [cleanupMedia]);

  const statusText =
    phase === "starting"
      ? labels.starting
      : phase === "scanning"
        ? partial !== null
          ? labels.partial(partial.have, partial.of)
          : labels.scanning
        : "";

  return (
    <div className="simpletab-qr-scanner">
      <div className="simpletab-actions">
        <button
          type="button"
          className="theia-button"
          onClick={() => {
            if (phase === "idle") {
              void handleStart();
            } else {
              handleStop();
            }
          }}
        >
          {phase === "idle" ? labels.start : labels.stop}
        </button>
      </div>

      <p className="simpletab-hint" role="status" aria-live="polite">
        {statusText}
      </p>

      {errorMessage !== null ? (
        <p className="simpletab-alert simpletab-alert-error" role="alert">
          {errorMessage}
        </p>
      ) : null}

      <video
        ref={videoRef}
        muted
        playsInline
        aria-label={labels.videoLabel}
        hidden={phase !== "scanning"}
        style={{
          display: phase === "scanning" ? "block" : "none",
          maxWidth: "100%",
        }}
      />
    </div>
  );
};
