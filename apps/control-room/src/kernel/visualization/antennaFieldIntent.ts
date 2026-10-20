import type { AntennaColorRange } from "./antennaColorRange";
import type { AntennaExternalLeadInspectionResource } from "@/kernel/api/apiTypes";
import { closedLoopManifest } from "@/kernel/resources/antennaClosedLoopInspectionModel";

export type AntennaFieldQuantity = "electric_potential_per_ampere" | "current_density_per_ampere" | "magnetic_field_per_ampere" | "device_potential" | "current_density" | "magnetic_field";

export function antennaFieldDisplayLabel(intent: Pick<AntennaFieldIntent, "quantity">): string {
  switch (intent.quantity) {
    case "device_potential": return "V [V]";
    case "current_density": return "J [A/m^2]";
    case "magnetic_field": return "H [A/m]";
    case "electric_potential_per_ampere": return "V/I [V/A]";
    case "current_density_per_ampere": return "J/I [A/m^2/A]";
    case "magnetic_field_per_ampere": return "H/I [A/m/A]";
  }
}

/** Client display intent only; never an authored physics module or a field buffer. */
export interface AntennaFieldIntent {
  kind: "basis" | "inspection";
  sessionId: string;
  sessionEpoch: string;
  requestScopeEpoch: string;
  sourceObjectId: string;
  stageId: string;
  /** Inspection execution identity; stageId remains the authored solve definition. */
  runtimeStageId?: string;
  runId?: string;
  solutionId: string;
  contentDigest: string;
  portModeId: string;
  recordContentDigest?: string;
  stageRevision?: number;
  quantity: AntennaFieldQuantity;
  surface?: boolean;
  wireframe?: boolean;
  points: boolean;
  vectors: boolean;
  /** Explicit inspection overlay; ignores surface depth without changing vector data. */
  vectorsOnTop?: boolean;
  vectorThickness?: 1 | 2 | 4;
  glyphLengthScale?: 1 | 2 | 4;
  component: "magnitude" | "x" | "y" | "z";
  palette: "viridis" | "coolwarm";
  colorRange?: AntennaColorRange;
}

export function antennaInspectionIntentMatchesOwner(intent: AntennaFieldIntent, inspection: AntennaExternalLeadInspectionResource): boolean {
  if (intent.kind !== "inspection" || !intent.runtimeStageId?.trim() || !intent.runId?.trim()) return false;
  try {
    const closed = closedLoopManifest(inspection);
    const manifest = closed ?? inspection.manifest;
    const supportedFamily = Boolean(closed) ||
      inspection.qualification === "NOT VERIFIED" && inspection.field_scope === "external_electrode_truncation";
    const output = inspection.outputs.length === 1 ? inspection.outputs[0].inspection_ref : null;
    return Boolean(supportedFamily && manifest && output && inspection.status === "inspection_only" &&
      inspection.session_id === intent.sessionId && inspection.session_epoch === intent.sessionEpoch &&
      inspection.request_scope_epoch === intent.requestScopeEpoch && inspection.run_id === intent.runId &&
      inspection.stage_id === intent.stageId && inspection.runtime_stage_id === intent.runtimeStageId &&
      inspection.stage_revision === intent.stageRevision && inspection.record_content_digest === intent.recordContentDigest &&
      inspection.output_id === intent.solutionId && inspection.port_mode_id === intent.portModeId &&
      manifest.source_object_id === intent.sourceObjectId && manifest.content_digest === intent.contentDigest &&
      output.stage_id === intent.stageId && output.output_id === intent.solutionId && output.content_digest === intent.contentDigest);
  } catch {
    return false;
  }
}

export interface AntennaFieldDisplayStatus {
  intentKey: string;
  status: "loading" | "ready" | "unavailable";
  reason: string;
  sampleCount?: number;
  minimum?: number;
  maximum?: number;
}
