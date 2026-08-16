export function assertPlanarEvidenceReady(evidence, expected, meta) {
  if (evidence.status !== "ready") {
    throw new Error(`Planar evidence status ${evidence.status}, expected ready`);
  }
  for (const key of ["sourceKind", "sourceId", "operatorKind", "quantityId", "component"]) {
    if (evidence[key] !== expected[key]) {
      throw new Error(`Planar evidence ${key} mismatch: ${evidence[key]}`);
    }
  }
  if (meta.source?.kind !== expected.sourceKind) {
    throw new Error(`Planar meta source kind mismatch: ${meta.source?.kind}`);
  }
  const sourceId = meta.source.kind === "default"
    ? "default"
    : meta.source.monitor_id;
  const sourceHash = meta.source.kind === "default"
    ? meta.source.default_slice_hash
    : meta.source.monitor_hash;
  const sourceRevision = meta.source.kind === "default"
    ? meta.source.default_slice_revision
    : meta.source.monitor_revision;
  if (sourceId !== expected.sourceId) {
    throw new Error(`Planar meta source mismatch: ${sourceId}`);
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
  if (evidence.sourceRevision !== sourceRevision) {
    throw new Error(`Planar source revision mismatch: ${evidence.sourceRevision}`);
  }
  if (evidence.sourceHash !== sourceHash) {
    throw new Error(`Planar source hash mismatch: ${evidence.sourceHash}`);
  }
  if (evidence.operatorRevision !== evidence.sourceRevision) {
    throw new Error(`Planar operator revision mismatch: ${evidence.operatorRevision}`);
  }
  if (evidence.sampleToken !== undefined && evidence.sampleToken !== meta.sample_token) {
    throw new Error(`Planar sample token mismatch: ${evidence.sampleToken}`);
  }
  for (const [evidenceKey, metaKey] of [
    ["canonicalUnit", "canonical_unit"],
    ["fieldBackend", "field_backend"],
    ["fieldDevice", "field_device"],
    ["fieldPrecision", "field_precision"],
  ]) {
    if (meta[metaKey] != null && evidence[evidenceKey] !== meta[metaKey]) {
      throw new Error(`Planar ${evidenceKey} mismatch: ${evidence[evidenceKey]}`);
    }
  }
  for (const [evidenceKey, expectedKey] of [
    ["defaultPlane", "defaultPlane"],
    ["positionFraction", "positionFraction"],
    ["resolvedCoordinateM", "resolvedCoordinateM"],
  ]) {
    if (expected[expectedKey] !== undefined && evidence[evidenceKey] !== expected[expectedKey]) {
      throw new Error(`Planar ${evidenceKey} mismatch: ${evidence[evidenceKey]}`);
    }
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
