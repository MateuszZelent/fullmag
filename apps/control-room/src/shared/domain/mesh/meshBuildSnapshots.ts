export type MeshBuildSnapshotGroup =
  | "identity"
  | "provenance"
  | "publish"
  | "quality"
  | "topology";

export interface MeshBuildSnapshotRow {
  currentValue: string;
  group: MeshBuildSnapshotGroup;
  id: string;
  label: string;
  nextValue: string;
}

export interface MeshBuildSnapshotInput {
  current?: MeshBuildSnapshotResources | null;
  next?: MeshBuildSnapshotResources | null;
}

export interface MeshBuildSnapshotResources {
  build?: Record<string, unknown> | null;
  manifest?: Record<string, unknown> | null;
  quality?: Record<string, unknown> | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nested(
  value: Record<string, unknown> | null | undefined,
  path: readonly string[],
): unknown {
  let current: unknown = value;
  for (const key of path) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[key];
  }
  return current;
}

function display(value: unknown): string {
  if (value === null || value === undefined) return "unknown";
  if (typeof value === "string" && value.trim().length === 0) return "unknown";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function row(
  input: MeshBuildSnapshotInput,
  group: MeshBuildSnapshotGroup,
  id: string,
  label: string,
  selector: (resources: MeshBuildSnapshotResources | null | undefined) => unknown,
): MeshBuildSnapshotRow {
  return {
    currentValue: display(selector(input.current)),
    group,
    id,
    label,
    nextValue: display(selector(input.next)),
  };
}

export function buildMeshSnapshotRows(
  input: MeshBuildSnapshotInput,
): MeshBuildSnapshotRow[] {
  return [
    row(input, "identity", "mesh_name", "Mesh", (resources) =>
      resources?.manifest?.mesh_name),
    row(
      input,
      "provenance",
      "source_scene_revision",
      "Scene revision",
      (resources) =>
        resources?.manifest?.source_scene_revision ??
        resources?.build?.source_scene_revision,
    ),
    row(input, "topology", "node_count", "Nodes", (resources) =>
      resources?.manifest?.node_count),
    row(input, "topology", "element_count", "Elements", (resources) =>
      resources?.manifest?.element_count),
    row(input, "quality", "sicn_p5", "SICN p05", (resources) =>
      nested(resources?.quality, ["quality", "sicn_p5"])),
    row(input, "quality", "gamma_min", "Gamma min", (resources) =>
      nested(resources?.quality, ["quality", "gamma_min"])),
    row(
      input,
      "publish",
      "mesh_revision",
      "Published mesh revision",
      (resources) =>
        nested(resources?.build, ["published_resources", "mesh_revision"]),
    ),
  ];
}
