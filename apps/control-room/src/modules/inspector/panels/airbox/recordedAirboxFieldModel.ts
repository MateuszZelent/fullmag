import type { AntennaExternalLeadInspectionResource } from "@/kernel/api/apiTypes";
import { closedLoopManifest } from "@/kernel/resources/antennaClosedLoopInspectionModel";
import type { ArtifactFieldSelection } from "@/kernel/visualization/artifactFieldSelection";
import { antennaInspectionIntentMatchesOwner, type AntennaFieldIntent } from "@/kernel/visualization/antennaFieldIntent";

export function recordedAirboxFieldIntent(
  source: ArtifactFieldSelection | null,
  record: AntennaExternalLeadInspectionResource | null | undefined,
): AntennaFieldIntent | null {
  if (!source || !record) return null;
  try {
    const manifest = closedLoopManifest(record);
    const sampling = manifest?.sample_carrier;
    if (!manifest || sampling?.domain.kind !== "global" || sampling.carrier_kind !== "fem_domain_mesh_asset" || sampling.location !== "node") {
      return null;
    }
    const intent: AntennaFieldIntent = {
      ...source.identity,
      kind: "inspection",
      sourceObjectId: source.sourceObjectId,
      stageId: source.authoredStageId,
      runtimeStageId: source.runtimeStageId,
      runId: source.runId,
      solutionId: record.output_id,
      contentDigest: manifest.content_digest,
      portModeId: record.port_mode_id,
      recordContentDigest: record.record_content_digest,
      stageRevision: record.stage_revision,
      quantity: "magnetic_field",
      component: "magnitude",
      palette: "viridis",
      points: false,
      surface: false,
      wireframe: true,
      vectors: true,
      vectorsOnTop: true,
    };
    return antennaInspectionIntentMatchesOwner(intent, record) ? intent : null;
  } catch {
    return null;
  }
}
