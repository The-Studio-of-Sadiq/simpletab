import type { OpRound } from "@simpletab/core/ops";
import type { ProjectedState } from "@simpletab/host/lib/common/host-protocol";

export const COMMON_TIME_ZONES: readonly string[] = [
  "Asia/Dhaka",
  "UTC",
  "Europe/London",
  "Europe/Berlin",
  "America/New_York",
  "America/Los_Angeles",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Australia/Melbourne",
  "Africa/Johannesburg",
];

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

export function isValidIanaTimeZone(timeZone: string): boolean {
  if (
    typeof timeZone !== "string" ||
    timeZone.trim().length === 0 ||
    timeZone.trim() !== timeZone
  ) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function defaultTournamentTimeZone(
  state: Pick<ProjectedState, "tournament">,
  round?: Pick<OpRound, "simpletab">,
): string {
  const roundTz = round?.simpletab?.timeZone;
  if (roundTz && isValidIanaTimeZone(roundTz)) {
    return roundTz;
  }
  const tourneyTz = state.tournament.simpletab?.timeZone;
  if (tourneyTz && isValidIanaTimeZone(tourneyTz)) {
    return tourneyTz;
  }
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (resolved && isValidIanaTimeZone(resolved)) {
      return resolved;
    }
  } catch {
    // Fall back to UTC if resolvedOptions throws.
  }
  return "UTC";
}

function getZoneParts(
  utcMs: number,
  timeZone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(new Date(utcMs));
  const map = new Map<string, string>();
  for (const part of parts) {
    if (part.type !== "literal") {
      map.set(part.type, part.value);
    }
  }
  const rawHour = Number(map.get("hour"));
  return {
    year: Number(map.get("year")),
    month: Number(map.get("month")),
    day: Number(map.get("day")),
    hour: rawHour === 24 ? 0 : rawHour,
    minute: Number(map.get("minute")),
    second: Number(map.get("second")),
  };
}

export function getTimeZoneOffsetMs(utcMs: number, timeZone: string): number {
  const truncatedMs = Math.floor(utcMs / 1000) * 1000;
  const parts = getZoneParts(truncatedMs, timeZone);
  const zonedAsUtcMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return zonedAsUtcMs - truncatedMs;
}

export function localDateTimeToUtcIso(
  dateStr: string,
  timeStr: string,
  timeZone: string,
): string | null {
  if (!isValidIanaTimeZone(timeZone)) {
    return null;
  }
  const dateMatch = DATE_RE.exec(dateStr.trim());
  const timeMatch = TIME_RE.exec(timeStr.trim());
  if (!dateMatch || !timeMatch) {
    return null;
  }

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const second = timeMatch[3] !== undefined ? Number(timeMatch[3]) : 0;

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return null;
  }

  const wallCheck = new Date(Date.UTC(year, month - 1, day));
  if (
    wallCheck.getUTCFullYear() !== year ||
    wallCheck.getUTCMonth() !== month - 1 ||
    wallCheck.getUTCDate() !== day
  ) {
    return null;
  }

  const wallUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset1 = getTimeZoneOffsetMs(wallUtcMs, timeZone);
  const guess1 = wallUtcMs - offset1;
  const offset2 = getTimeZoneOffsetMs(guess1, timeZone);
  const guess2 = wallUtcMs - offset2;
  return new Date(guess2).toISOString();
}

export function utcIsoToLocalParts(
  utcIso: string,
  timeZone: string,
): { date: string; time: string } | null {
  const ms = Date.parse(utcIso);
  if (!Number.isFinite(ms) || !isValidIanaTimeZone(timeZone)) {
    return null;
  }
  const parts = getZoneParts(ms, timeZone);
  const pad2 = (value: number): string => String(value).padStart(2, "0");
  return {
    date: `${String(parts.year).padStart(4, "0")}-${pad2(parts.month)}-${pad2(parts.day)}`,
    time: `${pad2(parts.hour)}:${pad2(parts.minute)}`,
  };
}

export function formatDeadlineTime(utcIso: string, timeZone: string): string {
  const local = utcIsoToLocalParts(utcIso, timeZone);
  return local ? local.time : utcIso;
}

export function formatDeadlineDateTime(
  utcIso: string,
  timeZone: string,
): string {
  const local = utcIsoToLocalParts(utcIso, timeZone);
  return local ? `${local.date} ${local.time}` : utcIso;
}

export function isDeadlinePassed(
  utcIso: string | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (typeof utcIso !== "string" || utcIso.trim().length === 0) {
    return false;
  }
  const deadlineMs = Date.parse(utcIso);
  if (!Number.isFinite(deadlineMs)) {
    return false;
  }
  return nowMs >= deadlineMs;
}
