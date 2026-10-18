/** Stage/run scope is a cache identity; only stage_id is sent over HTTP. */
export function fieldCatalogResourceKey(path: string, stageId?: string | null, runId?: string | null): string {
  if (stageId == null) return path;
  const scoped = `${path}?stage_id=${encodeURIComponent(stageId)}`;
  return runId == null ? scoped : `${scoped}:run=${encodeURIComponent(runId)}`;
}
