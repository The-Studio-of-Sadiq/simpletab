import type { CuratedExtension } from "./curated-list";

/** Why extensions do or do not load on this laptop at this start. */
export type LoadingReason = "staff-device" | "developer-mode" | "may-host";

export interface LoadingDecision {
  reason: LoadingReason;
  /** The extensions to load: verified, listed and turned on; empty when `reason` is "may-host". */
  load: CuratedExtension[];
}

/**
 * Design section 11, item 6: an extension runs with full access to the laptop, so on a laptop
 * that hosts or may host a tournament it could change the tournament files directly, skipping
 * roles, proposals and the changelog. Extensions therefore load only on a laptop paired as a staff
 * device, or when developer mode is on. Built-in plugins (vscode.git) are not decided here.
 */
export function decideLoading(input: {
  pairedAsStaffDevice: boolean;
  developerMode: boolean;
  verified: readonly CuratedExtension[];
  off: readonly string[];
}): LoadingDecision {
  const reason: LoadingReason = input.pairedAsStaffDevice
    ? "staff-device"
    : input.developerMode
      ? "developer-mode"
      : "may-host";
  if (reason === "may-host") return { reason, load: [] };
  const off = new Set(input.off.map((id) => id.toLowerCase()));
  return { reason, load: input.verified.filter((entry) => !off.has(entry.id.toLowerCase())) };
}
