import type { CheckpointEntry, FrequencyDomainManifestResource, MeshPeriodicPairsResource, MeshSharedDomainManifestResource, SolverStatusResource, StageExecutionResource } from "@/kernel/api/apiTypes";
import type { K0ModalExecutionReadiness } from "./StudyStageAuthoringModel";

const PRODUCTION_CAPABILITY_STATUSES = new Set([
  "production",
  "production_qualified",
  "qualified",
]);

/**
 * Keeps K0 authoring gates tied to revisioned HTTP resources instead of an
 * optimistic local form flag. Unknown resources stay unavailable.
 */
export function deriveK0ModalExecutionReadiness({
  checkpoints,
  equilibriumArtifact,
  equilibriumSource,
  frequencyManifest,
  meshManifest,
  periodicPairs,
  solverStatus,
  stageExecution,
}: {
  checkpoints: readonly CheckpointEntry[];
  equilibriumArtifact: string;
  equilibriumSource: string;
  frequencyManifest: FrequencyDomainManifestResource | null;
  meshManifest: MeshSharedDomainManifestResource | null;
  periodicPairs: MeshPeriodicPairsResource | null;
  solverStatus: SolverStatusResource | null;
  stageExecution: StageExecutionResource | null;
}): K0ModalExecutionReadiness {
  const sharedDomainMeshReady = Boolean(
    meshManifest?.mesh_id && meshManifest.revision >= 0,
  );
  const periodicCertificateReady = Boolean(
    periodicPairs &&
      periodicPairs.pairs.length > 0 &&
      periodicPairs.pairs.every(
        (pair) =>
          pair.paired_node_count > 0 &&
          pair.unpaired_destination_node_count === 0 &&
          pair.unpaired_source_node_count === 0 &&
          ["certified", "matched", "valid"].includes(pair.status),
      ),
  );
  const acceptedRelaxationReady = Boolean(
    stageExecution?.stages.some((stage) =>
      stage.kind === "relax" &&
      stage.converged &&
      ["accepted", "completed"].includes(stage.status),
    ),
  );
  const acceptedArtifactReady = Boolean(
    equilibriumArtifact.trim() &&
      checkpoints.some(
        (checkpoint) =>
          checkpoint.artifact_ref === equilibriumArtifact.trim() &&
          checkpoint.mesh_revision === meshManifest?.revision,
      ),
  );
  const acceptedProvidedStateReady = Boolean(
    solverStatus &&
      solverStatus.converged &&
      !solverStatus.is_busy &&
      solverStatus.revision >= 0,
  );
  const acceptedEquilibriumReady =
    equilibriumSource === "relax"
      ? acceptedRelaxationReady
      : equilibriumSource === "provided"
        ? acceptedProvidedStateReady
        : equilibriumSource === "artifact"
          ? acceptedArtifactReady
          : false;
  const strictGpuReady = PRODUCTION_CAPABILITY_STATUSES.has(
    frequencyManifest?.capabilities.modal.production_gpu.status ?? "",
  );

  return {
    acceptedEquilibriumReady,
    periodicCertificateReady,
    sharedDomainMeshReady,
    strictGpuReady,
  };
}

const PARTIAL_STUDY_APPLY_MESSAGE =
  "Global Study settings were committed. The Pipeline stage save could not be confirmed. Review the current scene and Pipeline feedback before retrying Apply.";

function partialStudyApplyError(cause?: unknown): Error {
  const detail = cause instanceof Error ? " Stage save error: " + cause.message : "";
  return new Error(PARTIAL_STUDY_APPLY_MESSAGE + detail);
}

export async function applyStudyDraftsWithPartialFailure({
  globalDirty,
  stagesDirty,
  commitGlobal,
  commitStages,
}: {
  globalDirty: boolean;
  stagesDirty: boolean;
  commitGlobal: () => Promise<boolean>;
  commitStages: () => Promise<boolean>;
}): Promise<boolean> {
  let globalCommitted = false;
  if (globalDirty) {
    globalCommitted = await commitGlobal();
    if (!globalCommitted) return false;
  }

  if (stagesDirty) {
    let stagesCommitted: boolean;
    try {
      stagesCommitted = await commitStages();
    } catch (error) {
      if (globalCommitted) throw partialStudyApplyError(error);
      throw error;
    }
    if (!stagesCommitted) {
      if (globalCommitted) throw partialStudyApplyError();
      return false;
    }
  }

  return true;
}
