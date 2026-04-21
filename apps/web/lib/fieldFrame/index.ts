/**
 * @module lib/fieldFrame
 *
 * Field frame envelope types and guards for the FEM data-plane.
 */

export type {
  FieldFrameEnvelope,
  FieldFrameStats,
  FemTopologySignature,
  FemFieldFrameRef,
} from "./types";

export {
  shouldAcceptFrame,
  computeFrameStaleness,
  logFrameDecision,
  type FrameStalenessInfo,
} from "./frameGuard";

export { buildFieldFrameEnvelopeFromRuntimeState, type EnvelopeAdapterInput } from "./envelopeAdapter";

export { useFrameStaleness } from "./useFrameStaleness";
