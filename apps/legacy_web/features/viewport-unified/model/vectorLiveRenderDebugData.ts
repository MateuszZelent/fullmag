export type VectorFieldSourceKind = "authored" | "preview" | "live" | "none";

export interface VectorLiveRenderDebugData {
  source: VectorFieldSourceKind;
  fieldDataRevision: string | null;
  fieldDataTimestamp: number | null;
  liveFieldSourceStep: number | null;
  previewSourceStep: number | null;
  effectiveStep: number | null;
}

export function buildVectorLiveRenderDebugData(args: {
  source: VectorFieldSourceKind;
  fieldDataRevision: string | null;
  fieldDataTimestamp: number | null;
  liveFieldSourceStep: number | null;
  previewSourceStep: number | null;
  effectiveStep: number | null;
}): VectorLiveRenderDebugData {
  return {
    source: args.source,
    fieldDataRevision: args.fieldDataRevision,
    fieldDataTimestamp: args.fieldDataTimestamp,
    liveFieldSourceStep: args.liveFieldSourceStep,
    previewSourceStep: args.previewSourceStep,
    effectiveStep: args.effectiveStep,
  };
}
