import type {
  OpBallotSubmission,
  OpRound,
  OpTournament,
  ProposalRecord,
  RecordKey,
  TournamentState,
} from "@simpletab/core/ops";
import { BUILT_IN_ROLES, hasPermission, type Role } from "@simpletab/core/permissions";
import { project, projectOp } from "@simpletab/core/projection";
import type { ProjectedState } from "../../common/host-protocol";

/**
 * The state a role sees (design section 6): `project(state, role)` plus the extras the tab screens
 * need. The host's own screens and every staff device use this one function, so a device sees
 * exactly what the same role would see on the host.
 *
 * For any role other than the host owner, record versions are kept only for records the role can
 * see: a version key names its record, so passing every key would reveal the ids of hidden records
 * (for example feedback) even though their contents are stripped.
 */
export function buildProjectedStateFor(raw: TournamentState, role: Role, seq: number): ProjectedState {
  const projected = project(raw, role);
  const canEnterLate = hasPermission(role, "results.enter_late");
  const canViewIntake =
    hasPermission(role, "results.enter") ||
    hasPermission(role, "ballots.intake") ||
    hasPermission(role, "standings.view");
  const state: ProjectedState = {
    ...projected,
    tournament: projected.tournament as OpTournament,
    rounds: projected.rounds as OpRound[],
    ballots: projected.ballots as OpBallotSubmission[],
    seq,
    roleId: role.id,
    permissions: [...role.permissions],
    ...(canEnterLate ? { lateSubmissions: structuredClone(raw.lateSubmissions ?? []) } : {}),
    ...(canViewIntake ? { ballotIntake: structuredClone(raw.ballotIntake ?? []) } : {}),
    versions: { ...raw.versions },
    proposals: visibleProposals(raw.proposals, role),
  };
  if (role.id !== BUILT_IN_ROLES.host_owner.id) {
    state.versions = visibleVersions(state, raw.versions);
  }
  return state;
}

/**
 * Proposals as a role may see them (design section 6): staff roles see each proposal with the
 * proposed change projected for that role, the same rule the changelog uses. A proposal whose
 * change the role cannot see at all is left out; the Display role sees none.
 */
function visibleProposals(proposals: readonly ProposalRecord[], role: Role): ProposalRecord[] {
  if (role.permissions.length === 0 && role.proposalsOnly !== true) return [];
  const out: ProposalRecord[] = [];
  for (const proposal of proposals) {
    const op = projectOp(proposal.op, role);
    if (op === null) continue;
    out.push({ ...structuredClone(proposal), op });
  }
  return out;
}

function visibleVersions(
  state: ProjectedState,
  versions: Readonly<Record<RecordKey, number>>,
): Record<RecordKey, number> {
  const visibleIds = new Set<string>();
  for (const value of Object.values(state)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (item !== null && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") {
        visibleIds.add((item as { id: string }).id);
      }
    }
  }
  const out: Record<RecordKey, number> = {};
  for (const [key, version] of Object.entries(versions) as Array<[RecordKey, number]>) {
    const separator = key.indexOf(":");
    const kind = key.slice(0, separator);
    const id = key.slice(separator + 1);
    if (kind === "tournament" || visibleIds.has(id)) out[key] = version;
  }
  return out;
}
