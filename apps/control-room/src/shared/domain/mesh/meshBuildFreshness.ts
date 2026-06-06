export type MeshFreshnessState =
  | "building"
  | "current"
  | "failed"
  | "not-built"
  | "stale"
  | "unknown";

export interface MeshBuildFreshnessInput {
  activeBuild?: Record<string, unknown> | null;
  latestBuild?: Record<string, unknown> | null;
  manifest?: Record<string, unknown> | null;
  sceneRevision?: number | string | null;
  statusMeshRevision?: number | string | null;
}

export interface MeshBuildFreshness {
  reason: string;
  state: MeshFreshnessState;
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

function status(value: Record<string, unknown> | null | undefined): string {
  return typeof value?.status === "string" ? value.status.toLowerCase() : "";
}

function revision(value: unknown): number | string | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return null;
}

function revisionEquals(left: number | string | null, right: number | string | null): boolean {
  if (left === null || right === null) return false;
  return String(left) === String(right);
}

function meshRevisionIsMissing(value: number | string | null): boolean {
  if (value === null) return true;
  if (typeof value === "number") return value <= 0;
  return value === "0";
}

function sourceSceneRevision(
  value: Record<string, unknown> | null | undefined,
): number | string | null {
  return revision(value?.source_scene_revision);
}

export function resolveMeshBuildFreshness(
  input: MeshBuildFreshnessInput,
): MeshBuildFreshness {
  const activeStatus = status(input.activeBuild);
  if (ACTIVE_STATUSES.has(activeStatus)) {
    return { reason: `active build status is ${activeStatus}`, state: "building" };
  }

  const sceneRevision = revision(input.sceneRevision);
  const manifestSourceSceneRevision = sourceSceneRevision(input.manifest);
  const meshRevision = revision(input.statusMeshRevision);
  const manifestCurrent = revisionEquals(manifestSourceSceneRevision, sceneRevision);
  const latestStatus = status(input.latestBuild);
  const latestSourceSceneRevision = sourceSceneRevision(input.latestBuild);
  if (
    latestStatus.includes("fail") &&
    revisionEquals(latestSourceSceneRevision, sceneRevision) &&
    !manifestCurrent
  ) {
    return {
      reason: "latest build failed for the current scene revision",
      state: "failed",
    };
  }

  if (meshRevisionIsMissing(meshRevision) || !input.manifest) {
    return { reason: "no mesh revision or manifest is available", state: "not-built" };
  }

  if (manifestCurrent) {
    return {
      reason: "mesh manifest source scene revision matches the current scene",
      state: "current",
    };
  }

  if (manifestSourceSceneRevision !== null && sceneRevision !== null) {
    return {
      reason: "mesh manifest source scene revision is older than the current scene",
      state: "stale",
    };
  }

  return {
    reason: "mesh provenance is incomplete",
    state: "unknown",
  };
}
