import {
  LETTER_TO_ROLE,
  ROLE_TO_LETTER,
  base32Decode,
  base32Encode,
  buildLinkUrl,
  newLink,
  type LinkRole,
} from "@simpletab/core/crypto";
import type { PrivateUrlsRegeneratePayload } from "@simpletab/core/ops";
import type { LinkRecord } from "@simpletab/core/projection";
import type { ProjectedState } from "@simpletab/host/lib/common/host-protocol";
import qrcode from "qrcode-generator";

export const DEFAULT_BALLOTS_ORIGIN = "https://ballots.simpletab.app";

const DNS_LABEL_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ALL_DIGITS_REGEX = /^[0-9]+$/;

export interface ParticipantTarget {
  role: LinkRole;
  entityId: string;
  displayName: string;
  detail: string;
}

export interface ResolvedParticipantLink extends ParticipantTarget {
  lookupId: string;
  url: string;
}

export interface QrSvgData {
  size: number;
  path: string;
}

export function isValidCdnHost(cdnHost: string): boolean {
  const trimmed = cdnHost.trim().toLowerCase();
  if (
    trimmed.length === 0 ||
    trimmed.length > 253 ||
    /[/:?#@\s\\]/.test(trimmed) ||
    trimmed.endsWith(".")
  ) {
    return false;
  }
  const labels = trimmed.split(".");
  if (labels.length < 2) {
    return false;
  }
  if (!labels.every((label) => DNS_LABEL_REGEX.test(label))) {
    return false;
  }
  if (ALL_DIGITS_REGEX.test(labels[labels.length - 1]!)) {
    return false;
  }
  try {
    const parsed = new URL(`https://${trimmed}`);
    return parsed.hostname === trimmed && parsed.pathname === "/";
  } catch {
    return false;
  }
}

export function resolveBallotsOrigin(ballotsOrigin?: string): string {
  const trimmed = ballotsOrigin?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_BALLOTS_ORIGIN;
}

export function collectParticipantTargets(
  state: ProjectedState,
): ParticipantTarget[] {
  const targets: ParticipantTarget[] = [];

  for (const adj of state.adjudicators) {
    targets.push({
      role: "adjudicator",
      entityId: adj.id,
      displayName: adj.name,
      detail: adj.institutionName ?? "",
    });
  }

  for (const team of state.teams) {
    targets.push({
      role: "team",
      entityId: team.id,
      displayName: team.name,
      detail: team.institutionName ?? "",
    });
    for (const speaker of team.speakers) {
      targets.push({
        role: "speaker",
        entityId: speaker.id,
        displayName: speaker.name,
        detail: team.name,
      });
    }
  }

  return targets;
}

export function buildPrivateUrlsRegeneratePayload(
  state: ProjectedState,
  cdnHost: string,
  ballotsOrigin: string,
  force: boolean,
): PrivateUrlsRegeneratePayload {
  const targets = collectParticipantTargets(state);
  const existing = state.links ?? [];
  const existingKeys = new Set(
    existing.map((link) => `${link.lookupId[0] ?? ""}:${link.entityId}`),
  );
  const seenLookupIds = new Set(force ? [] : existing.map((l) => l.lookupId));

  const links: LinkRecord[] = [];
  for (const target of targets) {
    const key = `${ROLE_TO_LETTER[target.role]}:${target.entityId}`;
    if (!force && existingKeys.has(key)) {
      continue;
    }
    let generated = newLink(
      target.role,
      cdnHost,
      ballotsOrigin,
      state.tournament.slug,
    );
    while (seenLookupIds.has(generated.lookupId)) {
      generated = newLink(
        target.role,
        cdnHost,
        ballotsOrigin,
        state.tournament.slug,
      );
    }
    seenLookupIds.add(generated.lookupId);
    links.push({
      lookupId: generated.lookupId,
      entityId: target.entityId,
      secret: base32Encode(generated.secret),
    });
  }

  return {
    scope: "all",
    force,
    links,
  };
}

export function resolveParticipantLinks(
  state: ProjectedState,
  cdnHost: string,
  ballotsOrigin: string,
): ResolvedParticipantLink[] {
  if (!isValidCdnHost(cdnHost)) {
    return [];
  }
  const existing = state.links ?? [];
  if (existing.length === 0) {
    return [];
  }

  const targetByKey = new Map<string, ParticipantTarget>();
  for (const target of collectParticipantTargets(state)) {
    targetByKey.set(`${target.role}:${target.entityId}`, target);
  }

  const resolved: ResolvedParticipantLink[] = [];
  for (const link of existing) {
    const letter = link.lookupId[0];
    if (letter !== "a" && letter !== "t" && letter !== "s") {
      continue;
    }
    const role = LETTER_TO_ROLE[letter];
    const target = targetByKey.get(`${role}:${link.entityId}`);
    if (!target) {
      continue;
    }
    const secretBytes = base32Decode(link.secret);
    if (secretBytes === null) {
      continue;
    }
    const url = buildLinkUrl({
      ballotsOrigin,
      slug: state.tournament.slug,
      cdnHost: cdnHost.trim(),
      lookupId: link.lookupId,
      secret: secretBytes,
    });
    resolved.push({
      ...target,
      lookupId: link.lookupId,
      url,
    });
  }

  return resolved;
}

export function renderQrSvgData(data: string): QrSvgData {
  const qr = qrcode(0, "M");
  qr.addData(data, "Byte");
  qr.make();

  const modules = qr.getModuleCount();
  const margin = 2;
  const size = modules + margin * 2;
  const parts: string[] = [];

  for (let row = 0; row < modules; row += 1) {
    for (let col = 0; col < modules; col += 1) {
      if (qr.isDark(row, col)) {
        parts.push(`M${col + margin},${row + margin}h1v1h-1z`);
      }
    }
  }

  return {
    size,
    path: parts.join(""),
  };
}
