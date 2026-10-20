import type { EngineLogResource } from "@/kernel/api/apiTypes";
import {
  normalizeMeshBuildPhases,
  type NormalizedMeshBuildPhase,
} from "@/shared/domain/mesh/meshBuildPhases";

export interface MeshJobsLogRow {
  commandId?: string | null;
  level: string;
  message: string;
  phaseId?: string | null;
  source?: string | null;
  time: string;
}

interface MeshJobsSummaryRow {
  label: string;
  value: string;
}

interface MeshJobsHistoryRow {
  id: string;
  elements: string;
  mesh: string;
  nodes: string;
  reason: string;
  target: string;
}

interface MeshJobsViewportConfirmation {
  meshRevision: number | string;
  rendererId: string;
}

export interface MeshJobsModel {
  activeTitle: string;
  historyRows: MeshJobsHistoryRow[];
  /**
   * Published `last_build_error` of the mesh resource. Unstructured text: no
   * object/region attribution is inferred from it.
   */
  lastBuildError?: string | null;
  latestRows: MeshJobsSummaryRow[];
  logRows: MeshJobsLogRow[];
  phaseRows: NormalizedMeshBuildPhase[];
  publishedRows: MeshJobsSummaryRow[];
  viewportRows: MeshJobsSummaryRow[];
}

export interface MeshJobsModelInput {
  activeBuild?: Record<string, unknown> | null;
  engineLog?: Pick<EngineLogResource, "entries" | "total"> | null;
  history?: { history?: Record<string, unknown>[] | null } | null;
  latestSuccessfulBuild?: Record<string, unknown> | null;
  loadedMeshRevision?: number | string | null;
  viewportConfirmation?: MeshJobsViewportConfirmation | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, fallback = "unknown"): string {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
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

function targetKind(build: Record<string, unknown> | null | undefined): string {
  return text(
    asRecord(build?.target)?.kind ??
      asRecord(build?.mesh_target)?.kind ??
      build?.target_kind,
    "mesh",
  );
}

const MESH_LOG_SOURCES = new Set(["gmsh", "mesh", "meshing", "mesh_build", "remesh"]);

interface MeshBuildLogIdentity {
  commandId: string | null;
  phaseIds: ReadonlySet<string>;
}

function meshBuildLogIdentity(
  activeBuild: Record<string, unknown> | null | undefined,
  phaseRows: readonly NormalizedMeshBuildPhase[],
): MeshBuildLogIdentity {
  const commandId =
    text(asRecord(activeBuild?.provenance)?.command_id, "") ||
    text(asRecord(activeBuild?.active_build)?.command_id, "") ||
    null;
  return {
    commandId,
    phaseIds: new Set(phaseRows.map((phase) => phase.id)),
  };
}

/**
 * Structured identity (command id of the mesh build, a published pipeline
 * phase id, or a mesh log source) admits an entry regardless of wording; the
 * text heuristic remains only for entries the producer did not tag.
 */
function isMeshBuildLogEntry(
  entry: { message: string; command_id?: string | null; phase_id?: string | null; source?: string | null },
  identity: MeshBuildLogIdentity,
): boolean {
  if (identity.commandId && entry.command_id === identity.commandId) return true;
  if (entry.phase_id && identity.phaseIds.has(entry.phase_id)) return true;
  const source = entry.source?.trim().toLowerCase();
  if (source && MESH_LOG_SOURCES.has(source)) return true;
  return isMeshBuildLog(entry.message);
}

function isMeshBuildLog(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("gmsh") ||
    lower.includes("mesh build") ||
    lower.includes("meshing") ||
    lower.includes("remesh")
  );
}

function formatTime(timestampUnixMs: number): string {
  return new Date(timestampUnixMs).toISOString().slice(11, 19);
}

function publishedRows(
  activeBuild: Record<string, unknown> | null | undefined,
): MeshJobsSummaryRow[] {
  const published = asRecord(activeBuild?.published_resources);
  return [
    { label: "Mesh revision", value: text(published?.mesh_revision) },
    { label: "Build revision", value: text(published?.mesh_build_revision) },
    { label: "Manifest", value: text(published?.manifest) },
    { label: "Quality", value: text(published?.quality) },
    {
      label: "Realized size fields",
      value: text(published?.realized_size_fields),
    },
  ];
}

function historyRows(
  history: MeshJobsModelInput["history"],
): MeshJobsHistoryRow[] {
  const list = history?.history ?? [];
  return list
    .slice()
    .reverse()
    .map((entry, reverseIdx) => {
      const originalIndex = list.length - 1 - reverseIdx;
      const id = text(
        entry.mesh_revision ??
          entry.revision ??
          entry.timestamp_unix_ms ??
          `mesh-history-${originalIndex}`,
      );
      return {
        id,
        elements: text(entry.element_count),
        mesh: text(entry.mesh_name),
        nodes: text(entry.node_count),
        reason: text(entry.mesh_reason),
        target: text(entry.mesh_target),
      };
    });
}

function viewportRows(
  publishedMeshRevision: unknown,
  loadedMeshRevision: number | string | null | undefined,
  confirmation: MeshJobsViewportConfirmation | null | undefined,
): MeshJobsSummaryRow[] {
  const published = text(publishedMeshRevision, "waiting");
  const loaded = loadedMeshRevision === null || loadedMeshRevision === undefined
    ? "waiting"
    : text(loadedMeshRevision);
  if (!confirmation) {
    return [
      { label: "Published", value: published },
      { label: "Loaded", value: loaded },
      { label: "Rendered", value: "not visible" },
    ];
  }

  return [
    { label: "Published", value: published },
    { label: "Loaded", value: loaded },
    {
      label: "Rendered",
      value: `${text(confirmation.meshRevision)} via ${confirmation.rendererId}`,
    },
  ];
}

export function buildMeshJobsModel(input: MeshJobsModelInput): MeshJobsModel {
  // The mesh resource has no top-level `status`; the running build reports it
  // inside `active_build`.
  const activeStatus = text(
    input.activeBuild?.status ?? asRecord(input.activeBuild?.active_build)?.status,
    "idle",
  );
  const activeTarget = targetKind(input.activeBuild);
  const published = asRecord(input.activeBuild?.published_resources);
  const activeTitle =
    activeStatus === "idle"
      ? "No active mesh build"
      : `${activeStatus.slice(0, 1).toUpperCase()}${activeStatus.slice(1)} ${activeTarget} mesh build`;
  const phaseRows = normalizeMeshBuildPhases(
    input.activeBuild?.mesh_pipeline_status,
  );
  const logIdentity = meshBuildLogIdentity(input.activeBuild, phaseRows);
  const lastBuildError = text(input.activeBuild?.last_build_error, "") || null;
  const logRows =
    input.engineLog?.entries
      .filter((entry) => isMeshBuildLogEntry(entry, logIdentity))
      .slice(-50)
      .reverse()
      .map((entry) => {
        const metadata = asRecord(entry);
        return {
          commandId: text(metadata?.command_id, "") || null,
          level: entry.level,
          message: entry.message,
          phaseId: text(metadata?.phase_id, "") || null,
          source: text(metadata?.source, "") || null,
          time: formatTime(entry.timestamp_unix_ms),
        };
      }) ?? [];

  return {
    activeTitle,
    historyRows: historyRows(input.history),
    lastBuildError,
    latestRows: [
      {
        label: "Scene revision",
        value: text(input.latestSuccessfulBuild?.source_scene_revision),
      },
      {
        label: "Elements",
        value: text(
          nested(input.latestSuccessfulBuild, ["build_report", "element_count"]) ??
            input.latestSuccessfulBuild?.element_count,
        ),
      },
    ],
    logRows,
    phaseRows,
    publishedRows: publishedRows(input.activeBuild),
    viewportRows: viewportRows(
      published?.mesh_revision,
      input.loadedMeshRevision,
      input.viewportConfirmation,
    ),
  };
}
