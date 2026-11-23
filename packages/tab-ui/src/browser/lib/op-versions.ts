import type { OpRequest, RecordKey } from "@simpletab/core/ops";

export function withFreshVersions(
  request: OpRequest,
  versions: Record<RecordKey, number>,
): OpRequest {
  if (request.expectedVersions === undefined) {
    return request;
  }
  const next: Record<RecordKey, number> = {};
  for (const key of Object.keys(request.expectedVersions) as RecordKey[]) {
    next[key] = versions[key] ?? 0;
  }
  return {
    ...request,
    expectedVersions: next,
  };
}
