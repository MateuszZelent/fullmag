export type PlanarEvidenceStatus = "error" | "loading" | "ready";

export interface PlanarRasterEvidence {
  checksum: string;
  max: number;
  min: number;
  sampleCount: number;
}

export interface PlanarOverlayCounts {
  contours: number;
  meshSegments: number;
}

export interface PlanarRenderEvidence {
  glyphCount: number;
  overlayCounts: PlanarOverlayCounts;
  raster: PlanarRasterEvidence | null;
  sampleIdentity: string;
}

export interface PlanarEvidenceInput extends Omit<PlanarRenderEvidence, "sampleIdentity"> {
  component: string;
  fieldRevision: number | null;
  monitorId: string;
  operatorKind: string | null;
  quantityId: string;
  sampleIdentity: string | null;
  status: PlanarEvidenceStatus;
}

export interface PlanarEvidenceExpectation {
  component: string;
  fieldRevision: number;
  monitorId: string;
  operatorKind: string;
  quantityId: string;
  sampleIdentity: string;
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
  if (evidence.monitorId !== expected.monitorId) {
    throw new Error(`Planar evidence monitor mismatch: ${evidence.monitorId}`);
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
  if (evidence.sampleIdentity !== expected.sampleIdentity) {
    throw new Error(
      `Planar evidence sample identity mismatch: ${evidence.sampleIdentity}`,
    );
  }
  if (evidence.fieldRevision !== expected.fieldRevision) {
    throw new Error(
      `Planar evidence field revision mismatch: ${evidence.fieldRevision}`,
    );
  }
  if (!evidence.raster || evidence.raster.sampleCount <= 0) {
    throw new Error("Planar evidence raster is missing");
  }
  return evidence;
}

export function planarRasterChecksum(pixels: Uint8ClampedArray): string {
  let hash = 0x811c9dc5;
  for (const value of pixels) {
    hash ^= value;
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
