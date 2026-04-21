/**
 * @module lib/fieldFrame/envelopeAdapter
 *
 * Builds a FieldFrameEnvelope from existing session runtime state.
 * This is the bridge between the legacy live-state model and the
 * new canonical envelope contract (FEM-DP-001, PR-4).
 *
 * Once the backend publishes envelopes natively, this adapter
 * becomes a passthrough and can eventually be removed.
 */

import type { FieldFrameEnvelope, FieldFrameStats } from "./types";
import type { FemLiveMesh, StepUpdateV2, SpatialPreviewState } from "@/lib/session/types";
import type { LiveState, PreviewState } from "@/lib/useSessionStream";
import type { CapabilityMap } from "@/src/api/types";
import { resolveFemDiscretization } from "@/src/domain/capabilities";

export interface EnvelopeAdapterInput {
  sessionId: string | null;
  runId: string | null;
  liveState: LiveState | null;
  femMesh: FemLiveMesh | null;
  preview: PreviewState | null;
  stepUpdateV2: StepUpdateV2 | null;
  domainCapabilities?: CapabilityMap | null;
  legacyFemBackend: boolean;
  /** Currently selected quantity. */
  quantityId: string;
}

/**
 * Synthesize a FieldFrameEnvelope from legacy session state.
 *
 * Returns null when insufficient data is available to construct
 * a meaningful envelope (no session, no live state, etc.).
 */
export function buildEnvelopeFromLegacyState(
  input: EnvelopeAdapterInput,
): FieldFrameEnvelope | null {
  const {
    sessionId,
    runId,
    liveState,
    femMesh,
    preview,
    stepUpdateV2,
    domainCapabilities,
    legacyFemBackend,
    quantityId,
  } =
    input;

  if (!sessionId || !runId) return null;
  if (!liveState && !stepUpdateV2) return null;

  const step = stepUpdateV2?.diagnostics?.step ?? liveState?.step ?? 0;
  const time = stepUpdateV2?.diagnostics?.time ?? liveState?.time ?? 0;

  // Mesh generation id (FEM only)
  const meshGenerationId = femMesh?.generation_id ?? femMesh?.mesh_id ?? null;

  // Field revision: use source_step from spatial preview if available,
  // otherwise fall back to the solver step as a monotonic proxy.
  const spatialPreview: SpatialPreviewState | null =
    preview?.kind === "spatial" ? preview : null;
  const configRevision = spatialPreview?.config_revision ?? 0;
  const sourceStep = spatialPreview?.source_step ?? step;

  // Stats from preview if available
  let stats: FieldFrameStats | null = null;
  if (spatialPreview) {
    const minVal = spatialPreview.min;
    const maxVal = spatialPreview.max;
    if (Number.isFinite(minVal) && Number.isFinite(maxVal)) {
      stats = { min: minVal, max: maxVal, compMin: null, compMax: null };
    }
  }

  // Determine domain
  const quantityDomain = spatialPreview?.quantity_domain ?? null;
  const domain: FieldFrameEnvelope["domain"] =
    quantityDomain === "full_domain"
      ? "full_domain"
      : quantityDomain === "surface_only"
        ? "surface_only"
        : "magnetic_only";
  const femDiscretization = resolveFemDiscretization(domainCapabilities, legacyFemBackend);

  return {
    sessionId,
    runId,
    backendEpoch: 0, // Legacy path has no epoch concept — always 0
    meshGenerationId,
    topologyHash: null,
    fieldRevision: sourceStep > 0 ? sourceStep : (configRevision || 1),
    sourceStep,
    sourceTime: time,
    quantityId,
    component: "3D",
    nComp: 3,
    domain,
    location: femDiscretization ? "node" : "grid_cell",
    dtype: "f64",
    payloadKind: "inline-json",
    payloadId: null,
    activeMaskId: null,
    stats,
  };
}
