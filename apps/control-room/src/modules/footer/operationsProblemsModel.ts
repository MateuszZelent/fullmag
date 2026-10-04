import type {
  CommandQueueStatusResource,
  GeometryDiagnosticsResource,
  MeshActiveBuildResource,
  MeshLastSuccessfulBuildResource,
  SimulationPreparationResource,
} from "@/kernel/api/apiTypes";

export interface OperationProjectionRow {
  detail: string;
  id: string;
  label: string;
  revision: string;
  source: "Command" | "Mesh" | "Preparation";
  status: string;
}

export interface ProblemProjectionRow {
  code: string;
  detail: string;
  id: string;
  message: string;
  revision: string;
  severity: "error" | "info" | "warning";
  source: "Command" | "Geometry" | "Mesh" | "Preparation";
}

export interface OperationsProjectionModel {
  gaps: readonly string[];
  rows: readonly OperationProjectionRow[];
}

export interface ProblemsProjectionModel {
  errorCount: number;
  gaps: readonly string[];
  infoCount: number;
  rows: readonly ProblemProjectionRow[];
  warningCount: number;
}

interface ProjectionResourceState {
  error?: Error | null;
  label: string;
  status: string;
}

interface OperationsProjectionInput {
  commandQueue: CommandQueueStatusResource | null;
  meshBuild: MeshActiveBuildResource | null;
  preparation: SimulationPreparationResource | null;
  resources?: readonly ProjectionResourceState[];
}

interface ProblemsProjectionInput extends OperationsProjectionInput {
  geometryDiagnostics: GeometryDiagnosticsResource | null;
  latestSuccessfulMesh: MeshLastSuccessfulBuildResource | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function display(value: unknown, fallback = "Unavailable"): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return fallback;
}

function projectionGaps(
  resources: readonly ProjectionResourceState[] | undefined,
): string[] {
  return (resources ?? []).flatMap((resource) => {
    if (resource.status === "error") {
      return [
        `${resource.label}: ${resource.error?.message ?? "resource load failed"}`,
      ];
    }
    if (resource.status === "stale") {
      return [`${resource.label}: showing stale published data`];
    }
    return [];
  });
}

function preparationDetail(
  preparation: SimulationPreparationResource,
): string {
  const activeStage = preparation.active_stage_id
    ? preparation.stages.find((stage) => stage.id === preparation.active_stage_id)
    : null;
  return activeStage
    ? activeStage.progress_label ?? activeStage.detail ?? activeStage.label
    : preparation.failure?.summary ??
        (preparation.receipt
          ? "Accepted preparation receipt published"
          : "No active stage");
}

function meshOperation(
  meshBuild: MeshActiveBuildResource | null,
): OperationProjectionRow | null {
  if (!meshBuild) return null;
  const active = asRecord(meshBuild.active_build);
  const summary = asRecord(meshBuild.last_build_summary);
  const source = active ?? summary;
  if (!source && !meshBuild.last_build_error) return null;
  const buildId = display(
    source?.build_id ?? meshBuild.provenance?.build_id,
    "current",
  );
  return {
    detail: meshBuild.last_build_error ??
      display(source?.detail ?? source?.mesh_name, "Published build state"),
    id: `mesh:${buildId}`,
    label: `Mesh build ${buildId}`,
    revision: display(meshBuild.revision),
    source: "Mesh",
    status: display(
      source?.status,
      meshBuild.last_build_error ? "failed" : active ? "running" : "completed",
    ),
  };
}

export function buildOperationsProjection(
  input: OperationsProjectionInput,
): OperationsProjectionModel {
  const rows: OperationProjectionRow[] = [];
  if (input.preparation) {
    rows.push({
      detail: preparationDetail(input.preparation),
      id: `preparation:${input.preparation.preparation_id}`,
      label: `Preparation ${input.preparation.preparation_id}`,
      revision: display(input.preparation.revision),
      source: "Preparation",
      status: input.preparation.status,
    });
  }

  const mesh = meshOperation(input.meshBuild);
  if (mesh) rows.push(mesh);

  for (const command of (input.commandQueue?.commands ?? [])
    .toSorted((left, right) => right.seq - left.seq)
    .slice(0, 100)) {
    rows.push({
      detail: command.error ?? command.reason ?? command.completion_status ?? "No detail published",
      id: `command:${command.command_id}`,
      label: command.kind,
      revision: display(command.seq),
      source: "Command",
      status: command.status,
    });
  }

  return { gaps: projectionGaps(input.resources), rows };
}

function lastGoodMeshDetail(
  latestSuccessfulMesh: MeshLastSuccessfulBuildResource | null,
): string {
  const lastSuccess = asRecord(latestSuccessfulMesh?.last_success);
  if (!lastSuccess) return "Last-good mesh identity unavailable";
  const buildId = display(
    lastSuccess.build_id ?? lastSuccess.mesh_name,
    "unknown build",
  );
  const sceneRevision = display(
    lastSuccess.source_scene_revision ?? latestSuccessfulMesh?.source_scene_revision,
    "unknown",
  );
  return `Last good: ${buildId}; scene revision ${sceneRevision}`;
}

export function buildProblemsProjection(
  input: ProblemsProjectionInput,
): ProblemsProjectionModel {
  const rows: ProblemProjectionRow[] = [];

  for (const diagnostic of input.geometryDiagnostics?.diagnostics ?? []) {
    rows.push({
      code: diagnostic.code,
      detail: [diagnostic.object_id, diagnostic.geometry_path]
        .filter((value): value is string => Boolean(value))
        .join(" · ") || "Scene-wide geometry diagnostic",
      id: `geometry:${diagnostic.id}`,
      message: diagnostic.message,
      revision: display(input.geometryDiagnostics?.scene_revision),
      severity: diagnostic.severity,
      source: "Geometry",
    });
  }

  if (input.preparation?.failure) {
    const failure = input.preparation.failure;
    rows.push({
      code: failure.error_code,
      detail: [
        `Stage ${failure.stage_id}`,
        failure.detail,
        failure.diagnostics_correlation_id
          ? `Correlation ${failure.diagnostics_correlation_id}`
          : null,
      ].filter((value): value is string => Boolean(value)).join(" · "),
      id: `preparation:${input.preparation.preparation_id}:${failure.error_code}`,
      message: failure.summary,
      revision: display(input.preparation.revision),
      severity: "error",
      source: "Preparation",
    });
  }

  const meshError = input.meshBuild?.last_build_error ??
    input.latestSuccessfulMesh?.last_build_error;
  if (meshError) {
    rows.push({
      code: "MESH_BUILD_FAILED",
      detail: lastGoodMeshDetail(input.latestSuccessfulMesh),
      id: `mesh:${input.meshBuild?.revision ?? input.latestSuccessfulMesh?.revision ?? "unknown"}`,
      message: meshError,
      revision: display(
        input.meshBuild?.revision ?? input.latestSuccessfulMesh?.revision,
      ),
      severity: "error",
      source: "Mesh",
    });
  }

  for (const command of input.commandQueue?.commands ?? []) {
    const normalized = command.status.trim().toLowerCase();
    if (!command.error && !["failed", "rejected"].includes(normalized)) continue;
    rows.push({
      code: `COMMAND_${normalized.toUpperCase()}`,
      detail: `${command.kind} · command ${command.command_id}`,
      id: `command:${command.command_id}`,
      message: command.error ?? command.reason ?? "Command failed without a published reason",
      revision: display(command.seq),
      severity: "error",
      source: "Command",
    });
  }

  const severityOrder = { error: 0, warning: 1, info: 2 } as const;
  rows.sort((left, right) =>
    severityOrder[left.severity] - severityOrder[right.severity] ||
    left.source.localeCompare(right.source) ||
    left.id.localeCompare(right.id),
  );

  return {
    errorCount: rows.filter((row) => row.severity === "error").length,
    gaps: projectionGaps(input.resources),
    infoCount: rows.filter((row) => row.severity === "info").length,
    rows,
    warningCount: rows.filter((row) => row.severity === "warning").length,
  };
}
