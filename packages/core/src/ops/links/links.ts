import { parseLink, ROLE_TO_LETTER, type LinkRole } from "@/crypto";
import type { LinkRecord } from "@/projection";
import { cloneValue, dedupeKeys, isNonEmptyText } from "../setup/helpers";
import { recordKey, type OpDef, type TournamentState } from "../types";

export type PrivateUrlsScope = "all" | "teams" | "adjudicators" | "speakers";

export interface PrivateUrlsRegeneratePayload {
  scope: PrivateUrlsScope;
  force: boolean;
  links: LinkRecord[];
}

const VALID_SCOPES: ReadonlySet<PrivateUrlsScope> = new Set([
  "all",
  "teams",
  "adjudicators",
  "speakers",
]);

function scopeMatchesRole(scope: PrivateUrlsScope, role: LinkRole): boolean {
  if (scope === "all") return true;
  if (scope === "teams") return role === "team";
  if (scope === "adjudicators") return role === "adjudicator";
  return role === "speaker";
}

function scopeMatchesLookupId(
  scope: PrivateUrlsScope,
  lookupId: string,
): boolean {
  if (scope === "all") return true;
  const letter = lookupId[0];
  if (scope === "teams") return letter === ROLE_TO_LETTER.team;
  if (scope === "adjudicators") return letter === ROLE_TO_LETTER.adjudicator;
  return letter === ROLE_TO_LETTER.speaker;
}

function entityExistsForRole(
  state: TournamentState,
  role: LinkRole,
  entityId: string,
): boolean {
  if (role === "team") {
    return state.teams.some((team) => team.id === entityId);
  }
  if (role === "adjudicator") {
    return state.adjudicators.some((adj) => adj.id === entityId);
  }
  return state.teams.some((team) =>
    team.speakers.some((speaker) => speaker.id === entityId),
  );
}

function validateLinkRecordFormat(link: LinkRecord): {
  role?: LinkRole;
  error?: string;
} {
  if (!isNonEmptyText(link.lookupId)) {
    return { error: "Link lookupId must not be empty." };
  }
  if (!isNonEmptyText(link.entityId)) {
    return { error: "Link entityId must not be empty." };
  }
  if (!isNonEmptyText(link.secret)) {
    return { error: "Link secret must not be empty." };
  }
  const parsed = parseLink(
    `https://ballots.example/t/check#cdn.example~${link.lookupId}.${link.secret}`,
  );
  if (!parsed.ok) {
    return { error: parsed.error.message };
  }
  return { role: parsed.value.role };
}

export const privateUrlsRegenerateOp: OpDef<PrivateUrlsRegeneratePayload> = {
  type: "private_urls.regenerate",
  permission: "links.manage",
  category: "links",
  visibility: "private",
  lock: true,
  reads(state) {
    return dedupeKeys([
      ...state.teams.map((team) => recordKey("team", team.id)),
      ...state.adjudicators.map((adj) => recordKey("adjudicator", adj.id)),
      ...state.links.map((link) => recordKey("link", link.lookupId)),
    ]);
  },
  writes(state, payload) {
    return dedupeKeys([
      ...state.links.map((link) => recordKey("link", link.lookupId)),
      ...(Array.isArray(payload.links)
        ? payload.links.map((link) => recordKey("link", link.lookupId))
        : []),
    ]);
  },
  validate(state, payload) {
    if (!VALID_SCOPES.has(payload.scope)) {
      return [
        "scope must be one of \"all\", \"teams\", \"adjudicators\", or \"speakers\".",
      ];
    }
    if (typeof payload.force !== "boolean") {
      return ["force must be a boolean."];
    }
    if (!Array.isArray(payload.links)) {
      return ["links must be an array."];
    }

    const errors: string[] = [];
    const seenLookupIds = new Set<string>();
    const seenEntityKeys = new Set<string>();

    const retainedLinks = payload.force
      ? state.links.filter(
          (link) => !scopeMatchesLookupId(payload.scope, link.lookupId),
        )
      : state.links;
    const retainedLookupIds = new Set(
      retainedLinks.map((link) => link.lookupId),
    );

    for (const link of payload.links) {
      const format = validateLinkRecordFormat(link);
      if (format.error || !format.role) {
        errors.push(format.error ?? "Invalid link record.");
        continue;
      }
      if (!scopeMatchesRole(payload.scope, format.role)) {
        errors.push(
          `Link ${link.lookupId} (${format.role}) does not match scope "${payload.scope}".`,
        );
      }
      if (!entityExistsForRole(state, format.role, link.entityId)) {
        errors.push(
          `Entity ${link.entityId} (${format.role}) does not exist.`,
        );
      }
      if (seenLookupIds.has(link.lookupId)) {
        errors.push(`Duplicate lookupId in payload: ${link.lookupId}.`);
      }
      seenLookupIds.add(link.lookupId);
      const entityKey = `${format.role}:${link.entityId}`;
      if (seenEntityKeys.has(entityKey)) {
        errors.push(`Duplicate entityId in payload: ${link.entityId}.`);
      }
      seenEntityKeys.add(entityKey);

      if (retainedLookupIds.has(link.lookupId)) {
        errors.push(`LookupId ${link.lookupId} collides with an existing link.`);
      }
    }

    return errors;
  },
  apply(state, payload) {
    const incoming = cloneValue(payload.links);
    let nextLinks: LinkRecord[];

    if (payload.force) {
      const kept = state.links.filter(
        (link) => !scopeMatchesLookupId(payload.scope, link.lookupId),
      );
      nextLinks = [...cloneValue(kept), ...incoming];
    } else {
      const existingByEntity = new Set(
        state.links.map((link) => `${link.lookupId[0]}:${link.entityId}`),
      );
      const additions = incoming.filter(
        (link) => !existingByEntity.has(`${link.lookupId[0]}:${link.entityId}`),
      );
      nextLinks = [...cloneValue(state.links), ...additions];
    }

    return {
      state: {
        ...state,
        links: nextLinks,
      },
      committedPayload: cloneValue(payload),
    };
  },
  inverse() {
    return null;
  },
};
