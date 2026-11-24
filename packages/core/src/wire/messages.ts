import { err, ok, type Result } from "./result";
import {
  isCrockfordUlid,
  isHex64,
  isIanaTimeZone,
  isIsoUtcMs,
  isLookupId,
  isNonEmptyString,
  isNonNegativeInt,
  isPlainObject,
  isPositiveInt,
} from "./validate";

export const SCHEMA_VERSION = 1;

/**
 * Returns true if `n` is an accepted wire schema version.
 * Accepts the current version (`SCHEMA_VERSION`) and, once `SCHEMA_VERSION > 1`,
 * the immediately preceding version (`SCHEMA_VERSION - 1`).
 */
export function acceptsSchema(n: unknown): n is number {
  if (!isPositiveInt(n)) {
    return false;
  }
  return n === SCHEMA_VERSION || (SCHEMA_VERSION > 1 && n === SCHEMA_VERSION - 1);
}

export const PERMIT_FORMS = ["ballot", "feedback", "checkin"] as const;
export type PermitForm = (typeof PERMIT_FORMS)[number];
const PERMIT_FORM_SET: ReadonlySet<string> = new Set(PERMIT_FORMS);

export type PermitEntry = {
  lookupId: string;
  verifier: string;
  roomId: string;
  forms: PermitForm[];
};

export type PermitUpload = {
  schema: number;
  roundId: string;
  version: number;
  open: boolean;
  ballotDeadline?: string;
  feedbackDeadline?: string;
  timeZone: string;
  entries: PermitEntry[];
};

export type InboxItem = {
  rowid: number;
  submissionId: string;
  type: string;
  roundId: string;
  lookupId: string;
  payload: Record<string, unknown>;
  receivedAt: string;
};

export type InboxPage = {
  schema: number;
  items: InboxItem[];
  next: number | null;
  /**
   * Highest submission rowid the service examined for this page, across all tournaments.
   * Every row of this tournament up to it is in `items` (or an earlier page), so the host may
   * start its next pull here instead of re-reading other tournaments' rows (D1 rows-read budget).
   * Absent from services older than this field.
   */
  scanned?: number;
};

export type Ack = {
  schema: number;
  through: number;
};

export type Head = {
  schema: number;
  seq: number;
  headHash: string;
};

export type Submission = {
  schema: number;
  slug: string;
  submissionId: string;
  type: string;
  roundId: string;
  lookupId: string;
  authKey: string;
  proof: string;
  payload: Record<string, unknown>;
};

export type StatusItem = {
  submissionId: string;
  server: boolean;
  tabRoom: boolean;
};

export type StatusResponse = {
  schema: number;
  items: StatusItem[];
  shareLeft?: number;
};

export type KeyRequest = {
  schema: number;
  slug: string;
  contact: string;
  note: string;
};

function checkSchemaField(raw: unknown, errors: string[]): raw is number {
  if (!isPositiveInt(raw)) {
    errors.push("schema: must be a positive integer");
    return false;
  }
  if (!acceptsSchema(raw)) {
    errors.push(
      `schema: SCHEMA_UNSUPPORTED (version ${raw} is not supported; current version is ${SCHEMA_VERSION})`,
    );
    return false;
  }
  return true;
}

function parsePermitEntry(raw: unknown, path: string, errors: string[]): PermitEntry | null {
  if (!isPlainObject(raw)) {
    errors.push(`${path}: must be a JSON object`);
    return null;
  }

  const startErrors = errors.length;

  if (!isLookupId(raw.lookupId)) {
    errors.push(`${path}.lookupId: must be a role letter (a|t|s) followed by 12 lookup characters`);
  }
  if (!isHex64(raw.verifier)) {
    errors.push(`${path}.verifier: must be 64 lowercase hex characters`);
  }
  if (!isNonEmptyString(raw.roomId)) {
    errors.push(`${path}.roomId: must be a non-empty string`);
  }

  const forms: PermitForm[] = [];
  if (!Array.isArray(raw.forms)) {
    errors.push(`${path}.forms: must be an array`);
  } else {
    for (let j = 0; j < raw.forms.length; j++) {
      const form: unknown = raw.forms[j];
      if (typeof form === "string" && PERMIT_FORM_SET.has(form)) {
        forms.push(form as PermitForm);
      } else {
        errors.push(`${path}.forms[${j}]: must be one of ballot, feedback, checkin`);
      }
    }
  }

  if (errors.length > startErrors) {
    return null;
  }

  return {
    lookupId: raw.lookupId as string,
    verifier: raw.verifier as string,
    roomId: raw.roomId as string,
    forms,
  };
}

/**
 * Parses and validates a {@link PermitUpload} wire message.
 */
export function parsePermitUpload(input: unknown): Result<PermitUpload> {
  if (!isPlainObject(input)) {
    return err("$: must be a JSON object");
  }

  const errors: string[] = [];
  checkSchemaField(input.schema, errors);

  if (!isNonEmptyString(input.roundId)) {
    errors.push("roundId: must be a non-empty string");
  }
  if (!isPositiveInt(input.version)) {
    errors.push("version: must be a positive integer");
  }
  if (typeof input.open !== "boolean") {
    errors.push("open: must be a boolean");
  }
  if (input.ballotDeadline !== undefined && !isIsoUtcMs(input.ballotDeadline)) {
    errors.push("ballotDeadline: must be an ISO 8601 UTC timestamp with milliseconds");
  }
  if (input.feedbackDeadline !== undefined && !isIsoUtcMs(input.feedbackDeadline)) {
    errors.push("feedbackDeadline: must be an ISO 8601 UTC timestamp with milliseconds");
  }
  if (!isIanaTimeZone(input.timeZone)) {
    errors.push("timeZone: must be an IANA time zone name or \"UTC\"");
  }

  const entries: PermitEntry[] = [];
  if (!Array.isArray(input.entries)) {
    errors.push("entries: must be an array");
  } else {
    for (let i = 0; i < input.entries.length; i++) {
      const entry = parsePermitEntry(input.entries[i], `entries[${i}]`, errors);
      if (entry !== null) {
        entries.push(entry);
      }
    }
  }

  if (errors.length > 0) {
    return err(errors);
  }

  const result: PermitUpload = {
    schema: input.schema as number,
    roundId: input.roundId as string,
    version: input.version as number,
    open: input.open as boolean,
    timeZone: input.timeZone as string,
    entries,
  };
  if (input.ballotDeadline !== undefined) {
    result.ballotDeadline = input.ballotDeadline as string;
  }
  if (input.feedbackDeadline !== undefined) {
    result.feedbackDeadline = input.feedbackDeadline as string;
  }

  return ok(result);
}

function parseInboxItem(raw: unknown, path: string, errors: string[]): InboxItem | null {
  if (!isPlainObject(raw)) {
    errors.push(`${path}: must be a JSON object`);
    return null;
  }

  const startErrors = errors.length;

  if (!isPositiveInt(raw.rowid)) {
    errors.push(`${path}.rowid: must be a positive integer`);
  }
  if (!isCrockfordUlid(raw.submissionId)) {
    errors.push(`${path}.submissionId: must be a 26-character Crockford ULID`);
  }
  if (!isNonEmptyString(raw.type)) {
    errors.push(`${path}.type: must be a non-empty string`);
  }
  if (!isNonEmptyString(raw.roundId)) {
    errors.push(`${path}.roundId: must be a non-empty string`);
  }
  if (!isLookupId(raw.lookupId)) {
    errors.push(`${path}.lookupId: must be a role letter (a|t|s) followed by 12 lookup characters`);
  }
  if (!isPlainObject(raw.payload)) {
    errors.push(`${path}.payload: must be a JSON object`);
  }
  if (!isIsoUtcMs(raw.receivedAt)) {
    errors.push(`${path}.receivedAt: must be an ISO 8601 UTC timestamp with milliseconds`);
  }

  if (errors.length > startErrors) {
    return null;
  }

  return {
    rowid: raw.rowid as number,
    submissionId: raw.submissionId as string,
    type: raw.type as string,
    roundId: raw.roundId as string,
    lookupId: raw.lookupId as string,
    payload: raw.payload as Record<string, unknown>,
    receivedAt: raw.receivedAt as string,
  };
}

/**
 * Parses and validates an {@link InboxPage} wire message.
 */
export function parseInboxPage(input: unknown): Result<InboxPage> {
  if (!isPlainObject(input)) {
    return err("$: must be a JSON object");
  }

  const errors: string[] = [];
  checkSchemaField(input.schema, errors);

  const items: InboxItem[] = [];
  if (!Array.isArray(input.items)) {
    errors.push("items: must be an array");
  } else {
    for (let i = 0; i < input.items.length; i++) {
      const item = parseInboxItem(input.items[i], `items[${i}]`, errors);
      if (item !== null) {
        items.push(item);
      }
    }
  }

  if (input.next !== null && !isPositiveInt(input.next)) {
    errors.push("next: must be a positive integer or null");
  }
  if (input.scanned !== undefined && !isNonNegativeInt(input.scanned)) {
    errors.push("scanned: must be a non-negative integer");
  }

  if (errors.length > 0) {
    return err(errors);
  }

  return ok({
    schema: input.schema as number,
    items,
    next: input.next as number | null,
    ...(input.scanned !== undefined ? { scanned: input.scanned as number } : {}),
  });
}

/**
 * Parses and validates an {@link Ack} wire message.
 */
export function parseAck(input: unknown): Result<Ack> {
  if (!isPlainObject(input)) {
    return err("$: must be a JSON object");
  }

  const errors: string[] = [];
  checkSchemaField(input.schema, errors);

  if (!isPositiveInt(input.through)) {
    errors.push("through: must be a positive integer");
  }

  if (errors.length > 0) {
    return err(errors);
  }

  return ok({
    schema: input.schema as number,
    through: input.through as number,
  });
}

/**
 * Parses and validates a {@link Head} wire message.
 */
export function parseHead(input: unknown): Result<Head> {
  if (!isPlainObject(input)) {
    return err("$: must be a JSON object");
  }

  const errors: string[] = [];
  checkSchemaField(input.schema, errors);

  if (!isPositiveInt(input.seq)) {
    errors.push("seq: must be a positive integer");
  }
  if (!isHex64(input.headHash)) {
    errors.push("headHash: must be 64 lowercase hex characters");
  }

  if (errors.length > 0) {
    return err(errors);
  }

  return ok({
    schema: input.schema as number,
    seq: input.seq as number,
    headHash: input.headHash as string,
  });
}

/**
 * Parses and validates a {@link Submission} wire message.
 */
export function parseSubmission(input: unknown): Result<Submission> {
  if (!isPlainObject(input)) {
    return err("$: must be a JSON object");
  }

  const errors: string[] = [];
  checkSchemaField(input.schema, errors);

  if (!isNonEmptyString(input.slug)) {
    errors.push("slug: must be a non-empty string");
  }
  if (!isCrockfordUlid(input.submissionId)) {
    errors.push("submissionId: must be a 26-character Crockford ULID");
  }
  if (!isNonEmptyString(input.type)) {
    errors.push("type: must be a non-empty string");
  }
  if (!isNonEmptyString(input.roundId)) {
    errors.push("roundId: must be a non-empty string");
  }
  if (!isLookupId(input.lookupId)) {
    errors.push("lookupId: must be a role letter (a|t|s) followed by 12 lookup characters");
  }
  if (!isNonEmptyString(input.authKey)) {
    errors.push("authKey: must be a non-empty string");
  }
  if (!isNonEmptyString(input.proof)) {
    errors.push("proof: must be a non-empty string");
  }
  if (!isPlainObject(input.payload)) {
    errors.push("payload: must be a JSON object");
  }

  if (errors.length > 0) {
    return err(errors);
  }

  return ok({
    schema: input.schema as number,
    slug: input.slug as string,
    submissionId: input.submissionId as string,
    type: input.type as string,
    roundId: input.roundId as string,
    lookupId: input.lookupId as string,
    authKey: input.authKey as string,
    proof: input.proof as string,
    payload: input.payload as Record<string, unknown>,
  });
}

function parseStatusItem(raw: unknown, path: string, errors: string[]): StatusItem | null {
  if (!isPlainObject(raw)) {
    errors.push(`${path}: must be a JSON object`);
    return null;
  }

  const startErrors = errors.length;

  if (!isCrockfordUlid(raw.submissionId)) {
    errors.push(`${path}.submissionId: must be a 26-character Crockford ULID`);
  }
  if (typeof raw.server !== "boolean") {
    errors.push(`${path}.server: must be a boolean`);
  }
  if (typeof raw.tabRoom !== "boolean") {
    errors.push(`${path}.tabRoom: must be a boolean`);
  }

  if (errors.length > startErrors) {
    return null;
  }

  return {
    submissionId: raw.submissionId as string,
    server: raw.server as boolean,
    tabRoom: raw.tabRoom as boolean,
  };
}

/**
 * Parses and validates a {@link StatusResponse} wire message.
 */
export function parseStatusResponse(input: unknown): Result<StatusResponse> {
  if (!isPlainObject(input)) {
    return err("$: must be a JSON object");
  }

  const errors: string[] = [];
  checkSchemaField(input.schema, errors);

  const items: StatusItem[] = [];
  if (!Array.isArray(input.items)) {
    errors.push("items: must be an array");
  } else {
    for (let i = 0; i < input.items.length; i++) {
      const item = parseStatusItem(input.items[i], `items[${i}]`, errors);
      if (item !== null) {
        items.push(item);
      }
    }
  }

  if (input.shareLeft !== undefined && !isNonNegativeInt(input.shareLeft)) {
    errors.push("shareLeft: must be a non-negative integer");
  }

  if (errors.length > 0) {
    return err(errors);
  }

  const result: StatusResponse = {
    schema: input.schema as number,
    items,
  };
  if (input.shareLeft !== undefined) {
    result.shareLeft = input.shareLeft as number;
  }

  return ok(result);
}

/**
 * Parses and validates a {@link KeyRequest} wire message.
 */
export function parseKeyRequest(input: unknown): Result<KeyRequest> {
  if (!isPlainObject(input)) {
    return err("$: must be a JSON object");
  }

  const errors: string[] = [];
  checkSchemaField(input.schema, errors);

  if (!isNonEmptyString(input.slug)) {
    errors.push("slug: must be a non-empty string");
  }
  if (!isNonEmptyString(input.contact)) {
    errors.push("contact: must be a non-empty string");
  }
  if (typeof input.note !== "string") {
    errors.push("note: must be a string");
  }

  if (errors.length > 0) {
    return err(errors);
  }

  return ok({
    schema: input.schema as number,
    slug: input.slug as string,
    contact: input.contact as string,
    note: input.note as string,
  });
}
