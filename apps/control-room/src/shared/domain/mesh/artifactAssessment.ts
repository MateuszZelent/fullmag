export type ArtifactPresence = "not-built" | "present";

export type ResourceLoadState = "idle" | "loading" | "ready" | "error" | "stale";

export type ArtifactAssessmentState =
  | "current"
  | "stale"
  | "incompatible"
  | "inconsistent"
  | "unknown"
  | "loading"
  | "failed";

export interface ArtifactAssessmentInput {
  activeBuild?: Record<string, unknown> | null;
  latestBuild?: Record<string, unknown> | null;
  manifest?: Record<string, unknown> | null;
  resourceLoadState?: ResourceLoadState;
  sceneRevision?: number | string | null;
  statusMeshRevision?: number | string | null;
}

export interface ArtifactAssessment {
  evidence: "legacy-revision" | "digest";
  presence: ArtifactPresence;
  reason: string;
  runAllowed: boolean;
  state: ArtifactAssessmentState | null;
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

function parseRevision(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function meshRevisionIsMissing(value: number | null): boolean {
  return value === null || value <= 0;
}

function sourceSceneRevision(
  value: Record<string, unknown> | null | undefined,
): number | null {
  return parseRevision(value?.source_scene_revision);
}

/**
 * Pure domain resolver for mesh artifact freshness and presence.
 * Satisfies the single-resolver contract of Fullmag audit v2 (PR08/PR10/D06).
 */
export function resolveArtifactAssessment(
  input: ArtifactAssessmentInput,
): ArtifactAssessment {
  const meshRevision = parseRevision(input.statusMeshRevision);
  const manifestSourceRev = sourceSceneRevision(input.manifest);
  const validatedSceneRev = parseRevision(input.manifest?.validated_for_scene_revision);
  const manifestSceneRev = validatedSceneRev ?? manifestSourceRev;
  const sceneRev = parseRevision(input.sceneRevision);
  const activeStatus = status(input.activeBuild);
  const isBuilding = ACTIVE_STATUSES.has(activeStatus);

  // 1. Loading state (prioritize over not-built while build is active or resources are loading)
  if (isBuilding || input.resourceLoadState === "loading") {
    return {
      evidence: "legacy-revision",
      presence: input.manifest ? "present" : "not-built",
      reason: isBuilding
        ? `active build status is ${activeStatus}`
        : "loading required mesh resources",
      runAllowed: false,
      state: "loading",
    };
  }

  // 2. Resource load error: network failure or server error is not a legal not-built artifact
  if (input.resourceLoadState === "error") {
    return {
      evidence: "legacy-revision",
      presence: input.manifest ? "present" : "not-built",
      reason: "failed to load required mesh resources",
      runAllowed: false,
      state: "unknown",
    };
  }

  // 3. Failed build check: latest build failed for current scene revision
  const latestStatus = status(input.latestBuild);
  const latestSourceRev = sourceSceneRevision(input.latestBuild);
  if (
    latestStatus.includes("fail") &&
    latestSourceRev !== null &&
    sceneRev !== null &&
    latestSourceRev === sceneRev &&
    manifestSceneRev !== sceneRev
  ) {
    return {
      evidence: "legacy-revision",
      presence: input.manifest ? "present" : "not-built",
      reason: "latest build failed for the current scene revision",
      runAllowed: false,
      state: "failed",
    };
  }

  // 4. Legal not-built presence check (quiescent state without mesh revision or manifest)
  if ((meshRevisionIsMissing(meshRevision) && manifestSceneRev === null) || !input.manifest) {
    return {
      evidence: "legacy-revision",
      presence: "not-built",
      reason: "no mesh artifact has been built yet",
      runAllowed: false,
      state: null,
    };
  }

  // 5. Inconsistent: build or validation revision is ahead of the scene (F19).
  if (
    sceneRev !== null &&
    ((manifestSourceRev !== null && manifestSourceRev > sceneRev) ||
      (validatedSceneRev !== null && validatedSceneRev > sceneRev))
  ) {
    return {
      evidence: "legacy-revision",
      presence: "present",
      reason: manifestSourceRev !== null && manifestSourceRev > sceneRev
        ? "mesh manifest source scene revision is ahead of current scene"
        : "mesh manifest validation is ahead of current scene",
      runAllowed: false,
      state: "inconsistent",
    };
  }

  // 6. Unknown provenance / scene revision is incomplete
  if (manifestSceneRev === null || sceneRev === null) {
    return {
      evidence: "legacy-revision",
      presence: "present",
      reason: "mesh provenance or scene revision is incomplete",
      runAllowed: false,
      state: "unknown",
    };
  }

  // 7. Current: prefer the server's explicit validation of retained mesh inputs.
  if (manifestSceneRev === sceneRev) {
    return {
      evidence: "legacy-revision",
      presence: "present",
      reason: validatedSceneRev !== null
        ? "mesh manifest is validated for the current scene"
        : "mesh manifest source scene revision matches the current scene",
      runAllowed: true,
      state: "current",
    };
  }

  // 8. Stale: the current scene has no matching validation or build revision.
  if (manifestSceneRev < sceneRev) {
    return {
      evidence: "legacy-revision",
      presence: "present",
      reason: validatedSceneRev !== null
        ? "mesh manifest validation is older than the current scene"
        : "mesh manifest source scene revision is older than the current scene",
      runAllowed: false,
      state: "stale",
    };
  }

  return {
    evidence: "legacy-revision",
    presence: "present",
    reason: "mesh provenance is incomplete",
    runAllowed: false,
    state: "unknown",
  };
}
