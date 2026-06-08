export const CANONICAL_MESH_BUILD_PHASES = [
  { id: "queued", label: "Queued" },
  { id: "scene_snapshot", label: "Scene Snapshot" },
  { id: "geometry_realization", label: "Geometry Realization" },
  { id: "policy_resolution", label: "Policy Resolution" },
  { id: "size_field_planning", label: "Size Field Planning" },
  { id: "gmsh_meshing", label: "Gmsh Meshing" },
  { id: "mesh_extraction", label: "Mesh Extraction" },
  { id: "quality_analysis", label: "Quality Analysis" },
  { id: "resource_publish", label: "Resource Publish" },
  { id: "viewport_delivery", label: "Viewport Delivery" },
] as const;

export type CanonicalMeshBuildPhaseId =
  (typeof CANONICAL_MESH_BUILD_PHASES)[number]["id"];

export type MeshBuildTerminalStatus =
  | "cancelled"
  | "completed"
  | "failed"
  | "unknown";

export interface NormalizedMeshBuildPhase {
  detail: string;
  durationMs: number | null;
  id: string;
  label: string;
  progressLabel: string | null;
  progressPercent: number | null;
  status: string;
}

const ACTIVE_STATUSES = new Set([
  "active",
  "building",
  "generating",
  "pending",
  "queued",
  "running",
  "started",
]);

const COMPLETED_STATUSES = new Set([
  "complete",
  "completed",
  "done",
  "ready",
  "success",
  "successful",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function titleFromId(id: string): string {
  const parts = id.split(/[-_]/);
  const result: string[] = [];
  for (const part of parts) {
    if (part) {
      result.push(part.slice(0, 1).toUpperCase() + part.slice(1));
    }
  }
  return result.join(" ");
}

function percent(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function duration(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value));
}

function phaseFromRecord(
  value: unknown,
  fallbackId: string,
): NormalizedMeshBuildPhase | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = text(record.id) ?? text(record.phase) ?? fallbackId;
  const status = text(record.status) ?? "unknown";

  return {
    detail: text(record.detail) ?? text(record.message) ?? "",
    durationMs: duration(record.duration_ms) ?? duration(record.durationMs),
    id,
    label: text(record.label) ?? text(record.name) ?? titleFromId(id),
    progressLabel:
      text(record.progress_label) ?? text(record.progressLabel) ?? null,
    progressPercent:
      percent(record.progress_percent) ??
      percent(record.progressPercent) ??
      percent(record.percent),
    status,
  };
}

export function normalizeMeshBuildPhases(
  value: unknown,
): NormalizedMeshBuildPhase[] {
  const backendPhases = Array.isArray(value)
    ? value
        .map((entry, index) => phaseFromRecord(entry, `phase-${index + 1}`))
        .filter((phase): phase is NormalizedMeshBuildPhase => phase !== null)
    : [];
  const byId = new Map(backendPhases.map((phase) => [phase.id, phase]));
  const phases: NormalizedMeshBuildPhase[] = [];

  for (const canonical of CANONICAL_MESH_BUILD_PHASES) {
    phases.push(
      byId.get(canonical.id) ?? {
        detail: "",
        durationMs: null,
        id: canonical.id,
        label: canonical.label,
        progressLabel: null,
        progressPercent: null,
        status: "pending",
      },
    );
  }

  for (const phase of backendPhases) {
    if (!CANONICAL_MESH_BUILD_PHASES.some((item) => item.id === phase.id)) {
      phases.push(phase);
    }
  }

  return phases;
}

export function meshBuildPhaseStatusIsActive(
  phase: NormalizedMeshBuildPhase,
  index: number,
  phases: readonly NormalizedMeshBuildPhase[],
): boolean {
  const status = phase.status.toLowerCase();
  if (!ACTIVE_STATUSES.has(status)) return false;
  if (status !== "pending") return true;
  return phases.slice(0, index).some((prior) =>
    COMPLETED_STATUSES.has(prior.status.toLowerCase()),
  );
}

export function resolveMeshBuildTerminalStatus(
  phases: readonly NormalizedMeshBuildPhase[],
): MeshBuildTerminalStatus {
  if (
    phases.some((phase) => {
      const status = phase.status.toLowerCase();
      return status.includes("fail") || status.includes("error");
    })
  ) {
    return "failed";
  }
  if (phases.some((phase) => phase.status.toLowerCase() === "cancelled")) {
    return "cancelled";
  }

  const canonical = phases.filter((phase) =>
    CANONICAL_MESH_BUILD_PHASES.some((item) => item.id === phase.id),
  );
  if (
    canonical.length === CANONICAL_MESH_BUILD_PHASES.length &&
    canonical.every((phase) =>
      COMPLETED_STATUSES.has(phase.status.toLowerCase()),
    )
  ) {
    return "completed";
  }
  return "unknown";
}
