export interface MeshBuildHistoryEntry {
  id: string;
  buildId: string | null;
  commandId: string | null;
  canonicalPolicySnapshot: Record<string, unknown> | null;
  requestedExecution: Record<string, unknown> | null;
  resolvedExecution: Record<string, unknown> | null;
  statePolicy: string | null;
  meshGenerationId: string | null;
  meshRevision: number | null;
  sourceSceneRevision: number | null;
  durationSeconds: number | null;
  restorable: boolean;
  restoreReason: string | null;
  avgQuality: number | null;
  boundaryFaceCount: number | null;
  deltaElementCount: number | null;
  deltaNodeCount: number | null;
  elementCount: number | null;
  gammaMin: number | null;
  generationMode: string | null;
  index: number;
  kind: string | null;
  meshName: string | null;
  meshReason: string | null;
  meshTarget: string | null;
  nodeCount: number | null;
  qualityDataAvailable: boolean;
  sicnP05: number | null;
}

export interface MeshBuildHistoryComparisonRow {
  after: number | null;
  before: number | null;
  delta: number | null;
  id:
    | "avg_quality"
    | "boundary_faces"
    | "elements"
    | "gamma_min"
    | "nodes"
    | "sicn_p05";
  label: string;
}

export interface MeshBuildHistoryComparison {
  afterIndex: number;
  beforeIndex: number;
  rows: MeshBuildHistoryComparisonRow[];
}

export interface MeshBuildHistoryComparisonSelection {
  afterId?: string;
  beforeId?: string;
  afterIndex?: number;
  beforeIndex?: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const result = asString(value);
    if (result) return result;
  }
  return null;
}

function firstRecord(...values: unknown[]): Record<string, unknown> | null {
  for (const value of values) {
    const result = asRecord(value);
    if (result) return result;
  }
  return null;
}

function stableLegacyId(
  record: Record<string, unknown>,
  index: number,
): string {
  const fingerprint = [
    record.mesh_generation_id,
    record.mesh_revision,
    record.timestamp_unix_ms,
    record.mesh_name,
    record.generation_mode,
    record.node_count,
    record.element_count,
  ]
    .map((value) => (value === undefined ? "" : String(value)))
    .join(":");
  return `legacy-mesh-build:${fingerprint || index}`;
}

function delta(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  return Number((current - previous).toPrecision(12));
}

function comparisonRow(
  id: MeshBuildHistoryComparisonRow["id"],
  label: string,
  before: number | null,
  after: number | null,
): MeshBuildHistoryComparisonRow {
  return {
    after,
    before,
    delta: delta(after, before),
    id,
    label,
  };
}

export function normalizeMeshBuildHistory(
  value: unknown,
): MeshBuildHistoryEntry[] {
  if (!Array.isArray(value)) return [];

  const entries: MeshBuildHistoryEntry[] = [];
  const seenIds = new Map<string, number>();
  for (const rawEntry of value) {
    const record = asRecord(rawEntry);
    if (!record) continue;
    const quality = asRecord(record.quality);
    const provenance = asRecord(record.mesh_provenance) ?? asRecord(record.provenance);
    const buildId = firstString(
      record.build_id,
      record.buildId,
      provenance?.build_id,
      provenance?.buildId,
    );
    const commandId = firstString(
      record.command_id,
      record.commandId,
      provenance?.command_id,
      provenance?.commandId,
    );
    const meshGenerationId = firstString(
      record.mesh_generation_id,
      record.generation_id,
      provenance?.mesh_generation_id,
      provenance?.generation_id,
    );
    const targetRecord = asRecord(record.mesh_target);
    const meshTarget = firstString(record.mesh_target) ?? (
      targetRecord
        ? [asString(targetRecord.kind), asString(targetRecord.object_id)]
            .filter((value): value is string => value !== null)
            .join(":") || null
        : null
    );
    const baseId = firstString(record.history_id, record.historyId, buildId, commandId, meshGenerationId)
      ?? stableLegacyId(record, entries.length);
    const occurrence = seenIds.get(baseId) ?? 0;
    seenIds.set(baseId, occurrence + 1);
    const id = occurrence === 0 ? baseId : `${baseId}:${occurrence + 1}`;
    const canonicalPolicySnapshot = firstRecord(
      record.canonical_policy_snapshot,
      record.canonicalPolicySnapshot,
      provenance?.canonical_policy_snapshot,
      provenance?.canonicalPolicySnapshot,
    );
    const requestedExecution = firstRecord(
      record.requested_execution,
      record.requestedExecution,
      provenance?.requested_execution,
      provenance?.requestedExecution,
    );
    const resolvedExecution = firstRecord(
      record.resolved_execution,
      record.resolvedExecution,
      provenance?.resolved_execution,
      provenance?.resolvedExecution,
    );
    const statePolicy = firstString(record.state_policy, record.statePolicy, provenance?.state_policy);
    const sourceSceneRevision = asNumber(
      record.source_scene_revision ?? provenance?.source_scene_revision,
    );
    const meshRevision = asNumber(record.mesh_revision ?? provenance?.mesh_revision);
    const durationSeconds =
      asNumber(record.mesh_time_seconds ?? record.duration_seconds ?? record.build_duration_seconds) ??
      (() => {
        const durationMs = asNumber(record.duration_ms);
        return durationMs === null ? null : durationMs / 1_000;
      })();
    const restorable = canonicalPolicySnapshot !== null;
    const previous = entries.at(-1) ?? null;
    const nodeCount = asNumber(record.node_count);
    const elementCount = asNumber(record.element_count);

    entries.push({
      id,
      buildId,
      commandId,
      canonicalPolicySnapshot,
      requestedExecution,
      resolvedExecution,
      statePolicy,
      meshGenerationId,
      meshRevision,
      sourceSceneRevision,
      durationSeconds,
      restorable,
      restoreReason: restorable ? null : "snapshot-unavailable",
      avgQuality: asNumber(quality?.avg_quality),
      boundaryFaceCount: asNumber(record.boundary_face_count),
      deltaElementCount: delta(elementCount, previous?.elementCount ?? null),
      deltaNodeCount: delta(nodeCount, previous?.nodeCount ?? null),
      elementCount,
      gammaMin: asNumber(quality?.gamma_min),
      generationMode: asString(record.generation_mode),
      index: entries.length,
      kind: asString(record.kind),
      meshName: asString(record.mesh_name),
      meshReason: asString(record.mesh_reason),
      meshTarget,
      nodeCount,
      qualityDataAvailable: asRecord(record.quality_data_artifact) !== null,
      sicnP05: asNumber(quality?.sicn_p5),
    });
  }

  return entries;
}

function compareMeshBuildHistoryEntries(
  before: MeshBuildHistoryEntry,
  after: MeshBuildHistoryEntry,
): MeshBuildHistoryComparison {
  return {
    afterIndex: after.index,
    beforeIndex: before.index,
    rows: [
      comparisonRow("nodes", "Nodes", before.nodeCount, after.nodeCount),
      comparisonRow(
        "elements",
        "Elements",
        before.elementCount,
        after.elementCount,
      ),
      comparisonRow(
        "boundary_faces",
        "Boundary faces",
        before.boundaryFaceCount,
        after.boundaryFaceCount,
      ),
      comparisonRow("sicn_p05", "SICN p05", before.sicnP05, after.sicnP05),
      comparisonRow("gamma_min", "Gamma min", before.gammaMin, after.gammaMin),
      comparisonRow(
        "avg_quality",
        "Average quality",
        before.avgQuality,
        after.avgQuality,
      ),
    ],
  };
}

export function latestMeshBuildComparison(
  entries: MeshBuildHistoryEntry[],
): MeshBuildHistoryComparison | null {
  const selection = latestMeshBuildComparisonSelection(entries);
  return selection
    ? meshBuildHistoryComparisonForSelection(entries, selection)
    : null;
}

export function latestMeshBuildComparisonSelection(
  entries: MeshBuildHistoryEntry[],
): MeshBuildHistoryComparisonSelection | null {
  if (entries.length < 2) return null;
  return {
    afterId: entries[entries.length - 1].id,
    beforeId: entries[entries.length - 2].id,
    afterIndex: entries[entries.length - 1].index,
    beforeIndex: entries[entries.length - 2].index,
  };
}

export function meshBuildHistoryComparisonForSelection(
  entries: MeshBuildHistoryEntry[],
  selection: MeshBuildHistoryComparisonSelection,
): MeshBuildHistoryComparison | null {
  const before = selection.beforeId
    ? entries.find((entry) => entry.id === selection.beforeId)
    : selection.beforeIndex === undefined
      ? undefined
      : entries.find((entry) => entry.index === selection.beforeIndex);
  const after = selection.afterId
    ? entries.find((entry) => entry.id === selection.afterId)
    : selection.afterIndex === undefined
      ? undefined
      : entries.find((entry) => entry.index === selection.afterIndex);
  return before && after ? compareMeshBuildHistoryEntries(before, after) : null;
}
