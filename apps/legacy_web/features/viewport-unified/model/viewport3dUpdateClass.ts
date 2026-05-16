export type Viewport3DUpdateClass =
  | "initial"
  | "topology_revision_changed"
  | "field_revision_changed"
  | "presentation_changed"
  | "no_change";

export interface Viewport3DUpdateSignature {
  topologyRevision: string | null;
  fieldRevision: string | null;
  presentationKey: string;
}

export function buildViewport3DUpdateSignature(args: {
  topologyRevision: string | null;
  meshFieldRevision: string | number | null | undefined;
  dataFieldRevision: string | number | null | undefined;
  effectiveViewMode: string;
  selectedQuantity: string | null | undefined;
  effectiveVectorComponent: string | null | undefined;
  meshRenderMode: string | null | undefined;
  meshTrimKey?: string | null | undefined;
  meshClipEnabled: boolean;
  meshClipAxis: string | null | undefined;
  meshClipPos: string | number | null | undefined;
  femVectorDomainFilter: string | null | undefined;
  femFerromagnetVisibilityMode: string | null | undefined;
}): Viewport3DUpdateSignature {
  return {
    topologyRevision: args.topologyRevision,
    fieldRevision:
      args.meshFieldRevision != null
        ? String(args.meshFieldRevision)
        : args.dataFieldRevision != null
          ? String(args.dataFieldRevision)
          : null,
    presentationKey: [
      args.effectiveViewMode,
      args.selectedQuantity,
      args.effectiveVectorComponent,
      args.meshRenderMode,
      args.meshTrimKey ?? "trim-off",
      args.meshClipEnabled ? args.meshClipAxis : "clip-off",
      args.meshClipEnabled ? args.meshClipPos : "clip-off",
      args.femVectorDomainFilter,
      args.femFerromagnetVisibilityMode,
    ].join("|"),
  };
}

export function resolveViewport3DUpdateClass(
  previous: Viewport3DUpdateSignature | null | undefined,
  current: Viewport3DUpdateSignature,
): Viewport3DUpdateClass {
  if (!previous) {
    return "initial";
  }
  if (previous.topologyRevision !== current.topologyRevision) {
    return "topology_revision_changed";
  }
  if (previous.fieldRevision !== current.fieldRevision) {
    return "field_revision_changed";
  }
  if (previous.presentationKey !== current.presentationKey) {
    return "presentation_changed";
  }
  return "no_change";
}
