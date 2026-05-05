type FemFieldDataLike = {
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  z: ArrayLike<number>;
};

export interface FemLiveRenderDebugData {
  backendLabel: string;
  viewMode: string;
  fieldLabel: string;
  viewportLabel: string;
  transportLabel: string;
  solverStep: number | string | null;
  bufferSourceStep: number | string | null;
  liveFieldSourceStep: number | string | null;
  previewSourceStep: number | string | null;
  fieldData: FemFieldDataLike | null | undefined;
  fieldRevision: number | string | null | undefined;
  fieldDataTimestamp: number | null | undefined;
  viewportUpdateClass?: string | null;
}

export function buildFemLiveRenderDebugData(args: {
  femDiscretization: boolean;
  viewMode: string;
  fieldLabel: string;
  selectedVectorSourceKind: string;
  effectiveStep: number | string | null;
  liveFieldSourceStep: number | string | null;
  previewSourceStep: number | string | null;
  fieldData: FemFieldDataLike | null | undefined;
  meshFieldRevision: number | string | null | undefined;
  dataFieldRevision: number | string | null | undefined;
  fieldDataTimestamp: number | null | undefined;
  viewportUpdateClass: string | null;
}): FemLiveRenderDebugData | null {
  if (!args.femDiscretization) {
    return null;
  }
  const fieldRevision =
    args.meshFieldRevision != null
      ? String(args.meshFieldRevision)
      : args.dataFieldRevision != null
        ? String(args.dataFieldRevision)
        : null;
  return {
    backendLabel: "fem",
    viewMode: args.viewMode,
    fieldLabel: args.fieldLabel,
    viewportLabel: "FEM meshData",
    transportLabel: args.selectedVectorSourceKind,
    solverStep: args.effectiveStep,
    bufferSourceStep:
      args.selectedVectorSourceKind === "live"
        ? args.liveFieldSourceStep
        : args.selectedVectorSourceKind === "preview"
          ? args.previewSourceStep
          : null,
    liveFieldSourceStep: args.liveFieldSourceStep,
    previewSourceStep: args.previewSourceStep,
    fieldData: args.fieldData,
    fieldRevision,
    fieldDataTimestamp: args.fieldDataTimestamp ?? null,
    viewportUpdateClass: args.viewportUpdateClass,
  };
}
