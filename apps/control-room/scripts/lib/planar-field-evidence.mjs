export function assertPlanarEvidenceReady(evidence, expected, meta) {
  if (evidence.status !== "ready") {
    throw new Error(`Planar evidence status ${evidence.status}, expected ready`);
  }
  for (const key of ["monitorId", "operatorKind", "quantityId", "component"]) {
    if (evidence[key] !== expected[key]) {
      throw new Error(`Planar evidence ${key} mismatch: ${evidence[key]}`);
    }
  }
  if (evidence.metaIdentity !== meta.etag) {
    throw new Error(`Planar meta identity mismatch: ${evidence.metaIdentity}`);
  }
  if (evidence.scalarIdentity !== meta.etag) {
    throw new Error(`Planar scalar identity mismatch: ${evidence.scalarIdentity}`);
  }
  if (evidence.fieldRevision !== meta.field_revision) {
    throw new Error(`Planar field revision mismatch: ${evidence.fieldRevision}`);
  }
  if (evidence.monitorRevision !== meta.monitor_revision) {
    throw new Error(`Planar monitor revision mismatch: ${evidence.monitorRevision}`);
  }
  if (evidence.monitorHash !== meta.monitor_hash) {
    throw new Error(`Planar monitor hash mismatch: ${evidence.monitorHash}`);
  }
  if (evidence.operatorRevision !== evidence.monitorRevision) {
    throw new Error(`Planar operator revision mismatch: ${evidence.operatorRevision}`);
  }
  if (!evidence.raster?.checksum || evidence.raster.sampleCount <= 0) {
    throw new Error("Planar evidence raster is missing");
  }
  if (!Number.isFinite(evidence.raster.min) || !Number.isFinite(evidence.raster.max)) {
    throw new Error("Planar evidence has invalid raster range");
  }
  if (evidence.raster.min > evidence.raster.max) {
    throw new Error("Planar evidence has an inverted raster range");
  }
  if (!Number.isInteger(evidence.glyphCount) || evidence.glyphCount < 0) {
    throw new Error("Planar evidence has an invalid glyph count");
  }
  for (const [name, count] of Object.entries(evidence.overlayCounts ?? {})) {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`Planar evidence has invalid ${name}`);
    }
  }
  return evidence;
}
