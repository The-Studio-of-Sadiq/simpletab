import { canonicalize } from "@/changelog/jcs";
import type { Debate } from "@/types";

interface DebateProjection {
  roundId: string;
  roomRank: number;
  byeTeamId: string | null;
  teams: { position: string; teamId: string }[];
  venueId: string | null;
  panelIds: string[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeDebates(debates: readonly Debate[]): DebateProjection[] {
  return debates
    .map((debate, index) => ({ debate, index }))
    .sort((left, right) => left.debate.roomRank - right.debate.roomRank || left.index - right.index)
    .map(({ debate }) => ({
      roundId: debate.roundId,
      roomRank: debate.roomRank,
      byeTeamId: debate.byeTeamId ?? null,
      teams: Object.values(debate.teams)
        .map((team) => ({ position: team.side, teamId: team.teamId }))
        .sort((left, right) => compareText(left.position, right.position)),
      venueId: debate.venueId ?? null,
      panelIds: [
        ...(debate.adjudicators.chairId ? [debate.adjudicators.chairId] : []),
        ...debate.adjudicators.panellistIds,
      ],
    }));
}

export async function drawHash(debates: readonly Debate[]): Promise<string> {
  const canonicalJson = canonicalize(normalizeDebates(debates));
  const bytes = new TextEncoder().encode(canonicalJson);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte: number) => byte.toString(16).padStart(2, "0")).join("");
}
