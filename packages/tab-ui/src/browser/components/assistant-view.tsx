import type { ProjectedState } from "@simpletab/host/lib/common/host-protocol";
import * as React from "@theia/core/shared/react";
import type { ActionRunner } from "../actions/action";
import { openCheckinPageAction, openResultsPageAction } from "../actions/navigation-actions";
import { importQrBallotAction } from "../actions/results-actions";
import { t } from "../i18n";
import { qrFailureMessage } from "../lib/qr-messages";
import { QrScanner } from "./qr-scanner";

export interface AssistantViewProps {
  state: ProjectedState | null;
  canScan: boolean;
  /** Runs the same commands the palette offers; the page never calls the host itself. */
  run: ActionRunner;
  /** Lets tests replace the webcam scanner. */
  renderScanner?: (onCodes: (codes: string[]) => void) => React.ReactNode;
}

interface ScanEntry {
  id: number;
  at: string;
  ok: boolean;
  text: string;
}

const MAX_ENTRIES = 20;

function roomName(state: ProjectedState | null, debateId: string): string {
  const debate = state?.debates.find((item) => item.id === debateId) as { venueName?: string } | undefined;
  return debate?.venueName ?? debateId;
}

/**
 * Assistant mode (design section 4): the screen for a tab assistant at the ballot desk. Paper or
 * phone QR ballots are scanned with the webcam and sent to the host, which checks each one with its
 * link secrets and records it as an unconfirmed ballot for the tab room to confirm.
 */
export const AssistantView: React.FC<AssistantViewProps> = ({
  state,
  canScan,
  run,
  renderScanner,
}) => {
  const [entries, setEntries] = React.useState<ScanEntry[]>([]);
  const nextId = React.useRef(1);
  const stateRef = React.useRef(state);
  stateRef.current = state;

  const handleCodes = React.useCallback(
    (codes: string[]): void => {
      void run(importQrBallotAction, { codes })
        .then((result) => {
          const text = result.ok
            ? t("assistant.scanAccepted", { room: roomName(stateRef.current, result.debateId) })
            : qrFailureMessage(result);
          return { ok: result.ok, text };
        })
        .catch((error: unknown) => ({ ok: false, text: error instanceof Error ? error.message : String(error) }))
        .then(({ ok, text }) => {
          setEntries((current) =>
            [{ id: nextId.current++, at: new Date().toLocaleTimeString(), ok, text }, ...current].slice(0, MAX_ENTRIES),
          );
        });
    },
    [run],
  );

  if (state === null) {
    return <p className="simpletab-hint">{t("assistant.noTournament")}</p>;
  }

  return (
    <div className="simpletab-page">
      <h2 className="simpletab-title">{t("assistant.title")}</h2>
      <p className="simpletab-hint">{t("assistant.hint")}</p>

      <div className="simpletab-actions">
        <button
          type="button"
          className="theia-button secondary"
          data-action={openResultsPageAction.id}
          onClick={() => {
            void run(openResultsPageAction, {});
          }}
        >
          {t("assistant.openResults")}
        </button>
        <button
          type="button"
          className="theia-button secondary"
          data-action={openCheckinPageAction.id}
          onClick={() => {
            void run(openCheckinPageAction, {});
          }}
        >
          {t("assistant.openCheckin")}
        </button>
      </div>

      <section className="simpletab-section" aria-labelledby="simpletab-assistant-scan">
        <h3 id="simpletab-assistant-scan" className="simpletab-subtitle">
          {t("assistant.scanTitle")}
        </h3>
        {canScan ? (
          renderScanner !== undefined ? (
            renderScanner(handleCodes)
          ) : (
            <QrScanner
              onCodes={handleCodes}
              labels={{
                start: t("assistant.start"),
                stop: t("assistant.stop"),
                starting: t("assistant.starting"),
                scanning: t("assistant.scanning"),
                partial: (have, of) => t("assistant.partial", { have, of }),
                cameraDenied: t("assistant.cameraDenied"),
                noCamera: t("assistant.noCamera"),
                cameraFailed: t("assistant.cameraFailed"),
                videoLabel: t("assistant.videoLabel"),
              }}
            />
          )
        ) : (
          <p className="simpletab-hint">{t("assistant.noPermission")}</p>
        )}
      </section>

      <section className="simpletab-section" aria-labelledby="simpletab-assistant-recent">
        <h3 id="simpletab-assistant-recent" className="simpletab-subtitle">
          {t("assistant.recentTitle")}
        </h3>
        {entries.length === 0 ? (
          <p className="simpletab-hint">{t("assistant.noScans")}</p>
        ) : (
          <ul aria-live="polite">
            {entries.map((entry) => (
              <li key={entry.id}>
                <strong>{entry.ok ? t("assistant.accepted") : t("assistant.refused")}</strong> {entry.at}: {entry.text}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};
