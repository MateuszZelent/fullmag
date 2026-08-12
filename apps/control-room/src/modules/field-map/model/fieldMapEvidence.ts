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
  monitorHash: string | null;
  monitorRevision: number | null;
  operatorKind: string | null;
  operatorRevision: number | null;
  quantityId: string;
  metaIdentity: string | null;
  scalarIdentity: string | null;
  status: PlanarEvidenceStatus;
}

export interface PlanarEvidenceExpectation {
  component: string;
  fieldRevision: number;
  monitorId: string;
  operatorKind: string;
  quantityId: string;
  metaIdentity: string;
  monitorHash: string;
  monitorRevision: number;
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
  if (evidence.monitorRevision !== expected.monitorRevision) {
    throw new Error(`Planar evidence monitor revision mismatch: ${evidence.monitorRevision}`);
  }
  if (evidence.monitorHash !== expected.monitorHash) {
    throw new Error(`Planar evidence monitor hash mismatch: ${evidence.monitorHash}`);
  }
  if (evidence.operatorRevision !== evidence.monitorRevision) {
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
      metaIdentity !== null &&
      scalarIdentity !== null &&
      renderEvidence?.raster !== null &&
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
