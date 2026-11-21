/** Canonical invalidation identity shared by unscoped and run-scoped catalogs. */
export function fieldCatalogRevisionKey(path: string, stageId?: string | null): string {
  return stageId == null ? path : `${path}?stage_id=${encodeURIComponent(stageId)}`;
}

/** Run scope changes cache identity only; only stage_id is sent over HTTP. */
export function fieldCatalogResourceKey(path: string, stageId?: string | null, runId?: string | null): string {
  const scoped = fieldCatalogRevisionKey(path, stageId);
  return runId == null ? scoped : `${scoped}:run=${encodeURIComponent(runId)}`;
}
