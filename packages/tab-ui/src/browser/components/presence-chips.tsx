import type { PresenceEntry } from "@simpletab/host/lib/common/collab-protocol";
import * as React from "@theia/core/shared/react";
import { t } from "../i18n";

export interface PresenceChipsProps {
  entries: readonly PresenceEntry[];
  /** Only people on this view are shown, e.g. "allocation". */
  view: string;
  /** This laptop's own entry is left out ("host" on the host, its device id on a device). */
  selfId?: string;
}

/** "Also here: Rafi (Tab director)". Text, not just coloured dots, so it reads without colour. */
export const PresenceChips: React.FC<PresenceChipsProps> = ({ entries, view, selfId }) => {
  const here = entries.filter((entry) => entry.view === view && entry.deviceId !== selfId);
  if (here.length === 0) return null;
  return (
    <p className="simpletab-presence" aria-live="polite">
      <span className="simpletab-hint">{t("presence.alsoHere")} </span>
      {here.map((entry) => (
        <span key={entry.deviceId} className="simpletab-badge">
          {entry.debateId !== undefined
            ? t("presence.holding", { name: entry.name })
            : t("presence.viewing", { name: entry.name })}
        </span>
      ))}
    </p>
  );
};
