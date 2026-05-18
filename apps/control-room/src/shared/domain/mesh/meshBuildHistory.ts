export interface MeshBuildHistoryEntry {
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
  afterIndex: number;
  beforeIndex: number;
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
  for (const rawEntry of value) {
    const record = asRecord(rawEntry);
    if (!record) continue;
    const quality = asRecord(record.quality);
    const previous = entries.at(-1) ?? null;
    const nodeCount = asNumber(record.node_count);
    const elementCount = asNumber(record.element_count);

    entries.push({
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
      meshTarget: asString(record.mesh_target),
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
    afterIndex: entries[entries.length - 1].index,
    beforeIndex: entries[entries.length - 2].index,
  };
}

export function meshBuildHistoryComparisonForSelection(
  entries: MeshBuildHistoryEntry[],
  selection: MeshBuildHistoryComparisonSelection,
): MeshBuildHistoryComparison | null {
  const before = entries.find((entry) => entry.index === selection.beforeIndex);
  const after = entries.find((entry) => entry.index === selection.afterIndex);
  return before && after ? compareMeshBuildHistoryEntries(before, after) : null;
}
