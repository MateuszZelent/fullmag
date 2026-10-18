import type { JsonObject, SceneResource } from "@/kernel/api/apiTypes";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

// The server may add derived metadata, but every submitted authored value must survive.
function includesAuthored(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length
    && expected.every((value, index) => includesAuthored(actual[index], value));
  const authored = record(expected);
  if (!authored) return actual === expected;
  const committed = record(actual);
  return Boolean(committed && Object.entries(authored).every(([key, value]) => includesAuthored(committed[key], value)));
}

function unique(values: unknown, key: string, value: unknown): Record<string, unknown> | null {
  const matches = Array.isArray(values) ? values.map(record).filter(entry => entry?.[key] === value) : [];
  return matches.length === 1 ? matches[0] : null;
}

/** Check the submitted target only; unrelated resources may advance independently. */
export function antennaGeometryAcknowledgementError(
  scene: SceneResource | null | undefined,
  objectId: string,
  geometry: JsonObject,
  circuitPatch?: JsonObject,
): string | null {
  const expectedObject = unique(circuitPatch?.objects, "id", objectId);
  const expectedGeometry = expectedObject?.geometry ?? geometry;
  const committedObject = unique(scene?.objects, "id", objectId);
  if (!committedObject || !includesAuthored(committedObject, expectedObject ?? { id: objectId, geometry: expectedGeometry })) {
    return "Geometry ACK omitted or changed submitted conductor dimensions, stations, placement or bridge parameters. Refetch before saving again.";
  }
  if (!circuitPatch) return null;
  const currents = Array.isArray(circuitPatch.current_transports) ? circuitPatch.current_transports.map(record).filter(current =>
    Array.isArray(current?.domain) && current.domain.some(ref => record(ref)?.object_id === objectId)) : [];
  if (currents.length !== 1) return "Circuit ACK cannot be verified without one submitted charge transport.";
  const expectedCurrent = currents[0]!;
  const current = unique(scene?.current_transports, "name", expectedCurrent.name);
  // KnownSceneCurrentTransport omits its empty boundary list during serialization.
  const comparableCurrent = current && current.boundaries === undefined && Array.isArray(expectedCurrent.boundaries) && expectedCurrent.boundaries.length === 0
    ? { ...current, boundaries: [] } : current;
  if (!current || !includesAuthored(comparableCurrent, expectedCurrent)
    || ["external_lead_preparation", "conservative_current_source", "conservative_current_view", "closure_receipts"].some(key => current[key] != null)) {
    return "Circuit ACK omitted or changed submitted materials, source cut or charge model, or retained stale preparation. Refetch before saving again.";
  }
  const ports = Array.isArray(circuitPatch.antenna_port_modes) ? circuitPatch.antenna_port_modes.map(record).filter(port => port?.source_object_id === objectId && port.current_transport_id === expectedCurrent.name) : [];
  if (ports.length !== 1 || !includesAuthored(unique(scene?.antenna_port_modes, "id", ports[0]?.id), ports[0])) {
    return "Circuit ACK omitted or changed the submitted source-cut port normalization or observations. Refetch before saving again.";
  }
  const stages = Array.isArray(circuitPatch.antenna_field_solve_stages) ? circuitPatch.antenna_field_solve_stages.map(record).filter(stage => stage?.source_object_id === objectId && stage.current_transport_id === expectedCurrent.name) : [];
  for (const expected of stages) {
    const committed = unique(scene?.antenna_field_solve_stages, "id", expected?.id);
    if (!committed || !includesAuthored(committed, expected) || committed.conservative_current_view_ref != null) {
      return "Circuit ACK omitted the matching field stage or retained a stale current-view binding. Refetch before saving again.";
    }
  }
  return null;
}
