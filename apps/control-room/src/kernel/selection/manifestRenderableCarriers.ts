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
type ObjectSegmentInput = Omit<
  ObjectSegment,
  "diagnostic_only" | "segment_fingerprint" | "segment_id"
> &
  Partial<
    Pick<
      ObjectSegment,
      "diagnostic_only" | "segment_fingerprint" | "segment_id"
    >
  >;

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
    diagnosticOnly: true;
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

type ManifestCarrierInput = {
  mesh_parts?: MeshSharedDomainManifestResource["mesh_parts"];
  object_segments?: readonly ObjectSegmentInput[];
};

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
  const segments = (manifest?.object_segments ?? []).flatMap((segment) => {
    const ownershipAliases = manifestCarrierOwnershipAliases(segment);
    return ownershipAliases.some((alias) => meshOwnership.has(alias))
      ? []
      : [normalizeObjectSegmentCarrier(segment, ownershipAliases)];
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
  segment: ObjectSegmentInput,
  ownershipAliases: readonly string[],
): NormalizedManifestObjectSegmentCarrier {
  const isAirbox = isVisualizationAirboxIdentity(segment);
  const fingerprint =
    segment.segment_fingerprint ?? stableObjectSegmentFingerprint(segment);
  const segmentId =
    segment.segment_id ??
    `segment:${encodeURIComponent(segment.object_id)}:${fingerprint}`;
  return {
    ...segment,
    carrierKind: "object-segment",
    diagnosticOnly: true,
    fieldCapable: false,
    diagnostic_only: true,
    id: segmentId,
    label: isAirbox ? "Airbox" : segment.object_id,
    ownershipAliases,
    role: isAirbox ? "air" : "magnetic",
    segment_fingerprint: fingerprint,
    segment_id: segmentId,
  };
}

function stableObjectSegmentFingerprint(segment: ObjectSegmentInput): string {
  const identity = [
    segment.object_id,
    segment.geometry_id ?? "",
    segment.node_start,
    segment.node_count,
    segment.element_start,
    segment.element_count,
    segment.boundary_face_start,
    segment.boundary_face_count,
  ].join("\u0000");
  let hash = 0x811c9dc5;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
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
