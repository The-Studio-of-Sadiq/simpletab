import {
  validOverride,
  type GuardViolation,
  type RuleOverride,
} from "@/features/tournament/application/stateGuards";
import type { Tournament } from "@/types";
import type { OpDef, RecordKey, TournamentState } from "../types";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-clones arrays and plain objects without mutating inputs.
 */
export function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) {
        out[key] = cloneValue(entry);
      }
    }
    return out as T;
  }
  return value;
}

export function dedupeKeys(keys: readonly RecordKey[]): RecordKey[] {
  const seen = new Set<RecordKey>();
  const out: RecordKey[] = [];
  for (const key of keys) {
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

export function insertAt<T>(
  items: readonly T[],
  item: T,
  index?: number,
): T[] {
  const next = [...items];
  if (
    index !== undefined &&
    Number.isInteger(index) &&
    index >= 0 &&
    index <= next.length
  ) {
    next.splice(index, 0, item);
  } else {
    next.push(item);
  }
  return next;
}

export function violationsToErrors(
  violations: readonly GuardViolation[],
  override?: RuleOverride,
): string[] {
  if (violations.length === 0) {
    return [];
  }
  const allOverridable = violations.every((violation) => violation.overridable);
  if (allOverridable && validOverride(override)) {
    return [];
  }
  return violations.map((violation) => violation.message);
}

export function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const ISO_INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Validates an ISO 8601 instant with an explicit UTC offset (`Z` or `±HH:MM`)
 * and rejects impossible calendar dates such as `2026-02-30T12:00:00Z`.
 */
export function isValidIsoInstant(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const match = ISO_INSTANT_RE.exec(value);
  if (!match) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offset = match[8];

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return false;
  }

  if (offset !== "Z") {
    const offsetHour = Number(offset.slice(1, 3));
    const offsetMinute = Number(offset.slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) {
      return false;
    }
  }

  const checkDate = new Date(Date.UTC(year, month - 1, day));
  if (
    checkDate.getUTCFullYear() !== year ||
    checkDate.getUTCMonth() !== month - 1 ||
    checkDate.getUTCDate() !== day
  ) {
    return false;
  }

  return Number.isFinite(Date.parse(value));
}

export function isValidIanaTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim() !== value) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function createTournamentState(
  tournament: Tournament,
  partial: Partial<Omit<TournamentState, "tournament">> = {},
): TournamentState {
  return {
    tournament: cloneValue(tournament),
    institutions: partial.institutions ? cloneValue(partial.institutions) : [],
    teams: partial.teams ? cloneValue(partial.teams) : [],
    adjudicators: partial.adjudicators ? cloneValue(partial.adjudicators) : [],
    venues: partial.venues ? cloneValue(partial.venues) : [],
    rounds: partial.rounds ? cloneValue(partial.rounds) : [],
    debates: partial.debates ? cloneValue(partial.debates) : [],
    motions: partial.motions ? cloneValue(partial.motions) : [],
    ballots: partial.ballots ? cloneValue(partial.ballots) : [],
    feedback: partial.feedback ? cloneValue(partial.feedback) : [],
    breakCategories: partial.breakCategories ? cloneValue(partial.breakCategories) : [],
    links: partial.links ? cloneValue(partial.links) : [],
    registrations: partial.registrations ? cloneValue(partial.registrations) : [],
    devices: partial.devices ? cloneValue(partial.devices) : [],
    roles: partial.roles ? cloneValue(partial.roles) : [],
    proposals: partial.proposals ? cloneValue(partial.proposals) : [],
    versions: partial.versions ? { ...partial.versions } : {},
  };
}

export function eraseOpType<P>(op: OpDef<P>): OpDef<unknown> {
  return op as unknown as OpDef<unknown>;
}
