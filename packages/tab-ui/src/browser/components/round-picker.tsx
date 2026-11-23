import { explicitCurrentRound } from "@simpletab/core/lib/publicFeatures";
import type { Round } from "@simpletab/core/types";
import type { ProjectedState } from "@simpletab/host/lib/common/host-protocol";
import * as React from "@theia/core/shared/react";
import { t } from "../i18n";

export function getDefaultRoundId(state: ProjectedState): string {
  if (state.rounds.length === 0) {
    return "";
  }
  const explicit = explicitCurrentRound(
    state.rounds,
    state.tournament.preferences.currentRoundId,
  );
  if (explicit !== undefined) {
    return explicit.id;
  }

  const ordered = [...state.rounds].sort(
    (left, right) => left.seq - right.seq || left.id.localeCompare(right.id),
  );
  const firstOpen = ordered.find(
    (round) => round.cancelled !== true && round.completed !== true,
  );
  if (firstOpen !== undefined) {
    return firstOpen.id;
  }

  const latestActive = [...ordered]
    .reverse()
    .find((round) => round.cancelled !== true);
  if (latestActive !== undefined) {
    return latestActive.id;
  }

  return ordered[0].id;
}

export interface RoundPickerProps {
  rounds: readonly Round[];
  selectedRoundId: string;
  onSelectRound: (roundId: string) => void;
  id?: string;
  label?: string;
}

export const RoundPicker: React.FC<RoundPickerProps> = ({
  rounds,
  selectedRoundId,
  onSelectRound,
  id,
  label,
}) => {
  const generatedId = React.useId();
  const selectId = id ?? `${generatedId}-round-picker`;
  const sortedRounds = React.useMemo(
    () =>
      [...rounds].sort(
        (left, right) => left.seq - right.seq || left.id.localeCompare(right.id),
      ),
    [rounds],
  );

  return (
    <div className="simpletab-round-picker">
      <label htmlFor={selectId}>{label ?? t("roundPicker.label")}</label>
      <select
        id={selectId}
        value={selectedRoundId}
        disabled={sortedRounds.length === 0}
        onChange={(e) => onSelectRound(e.target.value)}
      >
        {sortedRounds.length === 0 ? (
          <option value="">{t("roundPicker.empty")}</option>
        ) : (
          sortedRounds.map((round) => {
            const tags: string[] = [];
            if (round.cancelled) {
              tags.push(t("roundPicker.cancelledTag"));
            } else if (round.completed) {
              tags.push(t("roundPicker.completedTag"));
            }
            const suffix = tags.length > 0 ? ` ${tags.join(" ")}` : "";
            return (
              <option key={round.id} value={round.id}>
                {`${round.name}${suffix}`}
              </option>
            );
          })
        )}
      </select>
    </div>
  );
};
