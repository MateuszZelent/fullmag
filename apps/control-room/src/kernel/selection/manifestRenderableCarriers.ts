import type { MeshSharedDomainManifestResource } from "@/kernel/api/apiTypes";
import {
  manifestCarrierOwnershipAliases,
  resolveManifestRenderableCarrierKind,
  type ManifestRenderableCarrierKind,
} from "@/kernel/visualization/visualizationDisplayResolution";

import { isVisualizationAirboxIdentity } from "./selectionTypes";

type MeshPart = NonNullable<
  MeshSharedDomainManifestResource["mesh_parts"]
>[number];

type ObjectSegment = NonNullable<
  MeshSharedDomainManifestResource["object_segments"]
>[number];

type ManifestCarrierSourceKind = "mesh-part" | "object-segment";

export type NormalizedManifestMeshPartCarrier = MeshPart & {
  carrierKind: "mesh-part";
  fieldCapable: true;
  ownershipAliases: readonly string[];
};

export type NormalizedManifestObjectSegmentCarrier = Omit<
  MeshPart,
  "geometry_id" | "object_id"
> &
  ObjectSegment & {
    carrierKind: "object-segment";
    fieldCapable: false;
    id: string;
    label: string;
    ownershipAliases: readonly string[];
    role: "air" | "magnetic";
  };

export type NormalizedManifestRenderableCarrier =
  | NormalizedManifestMeshPartCarrier
  | NormalizedManifestObjectSegmentCarrier;

export interface ManifestRenderableCarrierDiagnostics {
  degradedCarrierCount: number;
  kind: ManifestRenderableCarrierKind;
  rejectedCarrierCount: number;
  renderableCarrierCount: number;
}

export type NormalizedManifestRenderableCarriers =
  NormalizedManifestRenderableCarrier[] & {
    diagnostics: ManifestRenderableCarrierDiagnostics;
  };

type ManifestCarrierInput = Pick<
  MeshSharedDomainManifestResource,
  "mesh_parts" | "object_segments"
>;

export function normalizeManifestRenderableCarriers(
  manifest: ManifestCarrierInput | null | undefined,
): NormalizedManifestRenderableCarriers {
  const rawMeshParts = (manifest?.mesh_parts ?? []).map(
    (part): NormalizedManifestMeshPartCarrier => ({
      ...part,
      carrierKind: "mesh-part",
      fieldCapable: true,
      ownershipAliases: manifestCarrierOwnershipAliases(part),
    }),
  );
  const seenMeshPartIds = new Set<string>();
  const meshParts = rawMeshParts.filter((part) => {
    const id = part.id.trim();
    if (!id || seenMeshPartIds.has(id)) return false;
    seenMeshPartIds.add(id);
    return true;
  });
  const meshOwnership = new Set(
    meshParts.flatMap((part) => [...part.ownershipAliases]),
  );
  const segments = (manifest?.object_segments ?? []).flatMap((segment, index) => {
    const ownershipAliases = manifestCarrierOwnershipAliases(segment);
    return ownershipAliases.some((alias) => meshOwnership.has(alias))
      ? []
      : [normalizeObjectSegmentCarrier(segment, index, ownershipAliases)];
  });
  const carriers = [...meshParts, ...segments] as NormalizedManifestRenderableCarriers;
  carriers.diagnostics = {
    degradedCarrierCount: segments.length,
    kind: resolveManifestRenderableCarrierKind({
      meshPartCount: meshParts.length,
      objectSegmentCount: segments.length,
    }),
    rejectedCarrierCount: rawMeshParts.length - meshParts.length,
    renderableCarrierCount: carriers.filter(isRenderableCarrier).length,
  };
  return carriers;
}

function normalizeObjectSegmentCarrier(
  segment: ObjectSegment,
  index: number,
  ownershipAliases: readonly string[],
): NormalizedManifestObjectSegmentCarrier {
  const isAirbox = isVisualizationAirboxIdentity(segment);
  return {
    ...segment,
    carrierKind: "object-segment",
    fieldCapable: false,
    id: `segment:${segment.object_id}:${index}`,
    label: isAirbox ? "Airbox" : segment.object_id,
    ownershipAliases,
    role: isAirbox ? "air" : "magnetic",
  };
}

function isRenderableCarrier(
  carrier: NormalizedManifestRenderableCarrier,
): boolean {
  return Boolean(
    carrier.carrierKind === "object-segment" ||
      isVisualizationAirboxIdentity(carrier) ||
      carrier.object_id ||
      carrier.role === "magnetic" ||
      carrier.role === "magnetic_object",
  );
}

export type { ManifestCarrierSourceKind };
