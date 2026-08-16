export type PlanarEvidenceStatus = "error" | "loading" | "ready";

export interface PlanarRasterEvidence {
  checksum: string;
  max: number;
  min: number;
  sampleCount: number;
}

export interface PlanarOverlayCounts {
  boundsSegments?: number;
  contours: number;
  meshSegments: number;
  pointMarkers?: number;
}

export interface PlanarRenderEvidence {
  glyphCount: number;
  overlayCounts: PlanarOverlayCounts;
  raster: PlanarRasterEvidence | null;
  sampleIdentity: string;
}

export interface PlanarEvidenceInput extends Omit<PlanarRenderEvidence, "sampleIdentity"> {
  component: string;
  canonicalUnit: string | null;
  carrierRevision: number | string | null;
  defaultPlane: string | null;
  domainGenerationId: string | null;
  fieldBackend: string | null;
  fieldDevice: string | null;
  fieldRevision: number | string | null;
  fieldSource: string | null;
  fieldPrecision: string | null;
  meshRevision: number | string | null;
  operatorThicknessM: number | null;
  positionFraction: number | null;
  resolvedCoordinateM: number | null;
  sampleToken: string | null;
  samplingExecution: string | null;
  sourceKind: "default" | "monitor";
  sourceId: string;
  sourceHash: string | null;
  sourceRevision: number | string | null;
  operatorKind: string | null;
  operatorRevision: number | string | null;
  quantityId: string;
  metaIdentity: string | null;
  scalarIdentity: string | null;
  status: PlanarEvidenceStatus;
}

export interface PlanarEvidenceExpectation {
  component: string;
  fieldRevision: number | string;
  sourceKind: "default" | "monitor";
  sourceId: string;
  operatorKind: string;
  quantityId: string;
  metaIdentity: string;
  sourceHash: string;
  sourceRevision: number | string;
  scalarIdentity: string;
}

export interface PlanarEvidence extends Omit<Readonly<PlanarEvidenceInput>, "overlayCounts" | "raster"> {
  overlayCounts: Readonly<PlanarOverlayCounts>;
  raster: Readonly<PlanarRasterEvidence> | null;
}

export function createPlanarEvidence(input: PlanarEvidenceInput): PlanarEvidence {
  return Object.freeze({
    ...input,
    overlayCounts: Object.freeze({ ...input.overlayCounts }),
    raster: input.raster ? Object.freeze({ ...input.raster }) : null,
  });
}

export function assertPlanarEvidenceReady(
  evidence: PlanarEvidence,
  expected: PlanarEvidenceExpectation,
): PlanarEvidence {
  if (evidence.status !== "ready") {
    throw new Error(`Planar evidence status ${evidence.status}, expected ready`);
  }
  if (evidence.sourceKind !== expected.sourceKind) {
    throw new Error(`Planar evidence source kind mismatch: ${evidence.sourceKind}`);
  }
  if (evidence.sourceId !== expected.sourceId) {
    throw new Error(`Planar evidence source mismatch: ${evidence.sourceId}`);
  }
  if (evidence.operatorKind !== expected.operatorKind) {
    throw new Error(`Planar evidence operator mismatch: ${evidence.operatorKind}`);
  }
  if (evidence.quantityId !== expected.quantityId) {
    throw new Error(`Planar evidence quantity mismatch: ${evidence.quantityId}`);
  }
  if (evidence.component !== expected.component) {
    throw new Error(`Planar evidence component mismatch: ${evidence.component}`);
  }
  if (evidence.metaIdentity !== expected.metaIdentity) {
    throw new Error(
      `Planar evidence meta identity mismatch: ${evidence.metaIdentity}`,
    );
  }
  if (evidence.scalarIdentity !== expected.scalarIdentity) {
    throw new Error(
      `Planar evidence scalar identity mismatch: ${evidence.scalarIdentity}`,
    );
  }
  if (evidence.fieldRevision !== expected.fieldRevision) {
    throw new Error(
      `Planar evidence field revision mismatch: ${evidence.fieldRevision}`,
    );
  }
  if (evidence.sourceRevision !== expected.sourceRevision) {
    throw new Error(`Planar evidence source revision mismatch: ${evidence.sourceRevision}`);
  }
  if (evidence.sourceHash !== expected.sourceHash) {
    throw new Error(`Planar evidence source hash mismatch: ${evidence.sourceHash}`);
  }
  if (evidence.operatorRevision !== evidence.sourceRevision) {
    throw new Error(`Planar evidence operator revision mismatch: ${evidence.operatorRevision}`);
  }
  if (!evidence.raster || evidence.raster.sampleCount <= 0) {
    throw new Error("Planar evidence raster is missing");
  }
  return evidence;
}

export function resolvePlanarEvidenceStatus({
  metaIdentity,
  metaStatus,
  renderEvidence,
  scalarIdentity,
  scalarStatus,
}: {
  metaIdentity: string | null | undefined;
  metaStatus: "error" | "idle" | "loading" | "ready" | "stale";
  renderEvidence: PlanarRenderEvidence | null;
  scalarIdentity: string | null | undefined;
  scalarStatus: "error" | "idle" | "loading" | "ready" | "stale";
}): PlanarEvidenceStatus {
  if (metaStatus === "error" || scalarStatus === "error") return "error";
  return metaStatus === "ready" &&
      scalarStatus === "ready" &&
      typeof metaIdentity === "string" &&
      metaIdentity.length > 0 &&
      typeof scalarIdentity === "string" &&
      scalarIdentity.length > 0 &&
      renderEvidence?.raster != null &&
      renderEvidence?.sampleIdentity === scalarIdentity &&
      scalarIdentity === metaIdentity
    ? "ready"
    : "loading";
}

export function planarRasterChecksum(pixels: Uint8ClampedArray): string {
  let hash = 0x811c9dc5;
  for (const value of pixels) {
    hash ^= value;
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
