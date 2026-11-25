import type { JoinProgress } from "@simpletab/host/lib/common/host-protocol";
import * as React from "@theia/core/shared/react";
import type { ActionRunner } from "../actions/action";
import { joinHostAction } from "../actions/device-mode-actions";
import { t } from "../i18n";

export interface JoinHostPanelProps {
  /** Runs the same command the palette offers; the page never calls the host itself. */
  run: ActionRunner;
  loadProgress: () => Promise<JoinProgress>;
  pollMs?: number;
}

/**
 * "Join a host as a device" (design section 4.1), shown when no tournament is open. The person types
 * the address and code from the host's Devices page; while the host decides, this laptop shows the
 * six words it computed, to compare with the host's screen.
 */
export const JoinHostPanel: React.FC<JoinHostPanelProps> = ({ run, loadProgress, pollMs = 1000 }) => {
  const baseId = React.useId();
  const [address, setAddress] = React.useState("");
  const [code, setCode] = React.useState("");
  const [deviceName, setDeviceName] = React.useState("");
  const [progress, setProgress] = React.useState<JoinProgress>({ state: "idle" });
  const [error, setError] = React.useState<string | null>(null);

  const active = progress.state === "connecting" || progress.state === "waiting";

  React.useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    const timer = setInterval(() => {
      void loadProgress()
        .then((next) => {
          if (!cancelled) setProgress(next);
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        });
    }, pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active, loadProgress, pollMs]);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    try {
      const result = await run(joinHostAction, { address, code, deviceName });
      if (!result.ok) {
        throw new Error(result.errors.join(" "));
      }
      setProgress(result.progress);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="simpletab-section" aria-labelledby={`${baseId}-title`}>
      <h3 id={`${baseId}-title`} className="simpletab-subtitle">
        {t("deviceMode.joinTitle")}
      </h3>
      <p className="simpletab-hint">{t("deviceMode.joinHint")}</p>
      <form
        className="simpletab-field"
        onSubmit={(e) => {
          void submit(e);
        }}
      >
        <label htmlFor={`${baseId}-address`}>{t("deviceMode.addressLabel")}</label>
        <input
          id={`${baseId}-address`}
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="192.168.1.20:47820"
          value={address}
          disabled={active}
          onChange={(e) => setAddress(e.target.value)}
        />
        <label htmlFor={`${baseId}-code`}>{t("deviceMode.codeLabel")}</label>
        <input
          id={`${baseId}-code`}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="1234 5678"
          value={code}
          disabled={active}
          onChange={(e) => setCode(e.target.value)}
        />
        <label htmlFor={`${baseId}-name`}>{t("deviceMode.nameLabel")}</label>
        <input
          id={`${baseId}-name`}
          type="text"
          maxLength={60}
          placeholder={t("deviceMode.namePlaceholder")}
          value={deviceName}
          disabled={active}
          onChange={(e) => setDeviceName(e.target.value)}
        />
        <div className="simpletab-actions">
          <button
            type="submit"
            className="theia-button"
            data-action={joinHostAction.id}
            disabled={active}
          >
            {active ? t("deviceMode.joining") : t("deviceMode.join")}
          </button>
        </div>
      </form>

      {error !== null ? (
        <p className="simpletab-alert simpletab-alert-error" role="alert">
          {error}
        </p>
      ) : null}
      {progress.state === "failed" && progress.error !== undefined ? (
        <p className="simpletab-alert simpletab-alert-error" role="alert">
          {progress.error}
        </p>
      ) : null}
      <p role="status" aria-live="polite">
        {progress.state === "connecting" ? t("deviceMode.stateConnecting") : null}
        {progress.state === "waiting" ? t("deviceMode.stateWaiting") : null}
        {progress.state === "joined" ? t("deviceMode.stateJoined") : null}
      </p>
      {progress.words !== undefined && progress.state === "waiting" ? (
        <div className="simpletab-card" aria-label={t("deviceMode.wordsLabel")}>
          <ol className="simpletab-pairing-words">
            {progress.words.map((word, index) => (
              <li key={`${index}-${word}`}>{word}</li>
            ))}
          </ol>
          <p className="simpletab-hint">{t("deviceMode.wordsHint")}</p>
        </div>
      ) : null}
    </section>
  );
};
