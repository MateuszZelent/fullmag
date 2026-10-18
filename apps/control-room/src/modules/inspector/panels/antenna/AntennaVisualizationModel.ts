import type { AntennaExternalLeadInspectionResource, AntennaFieldSolutionResource } from "@/kernel/api/apiTypes";
import { closedLoopManifest, isClosedLoopDisplay, type AntennaInspectionDisplay } from "@/kernel/resources/antennaClosedLoopInspectionModel";
import type { SessionResourceIdentity } from "@/kernel/resources/sessionResourceIdentity";
import { antennaInspectionIntentMatchesOwner, type AntennaFieldIntent, type AntennaFieldQuantity } from "@/kernel/visualization/antennaFieldIntent";

import { ANTENNA_BASIS_QUANTITIES } from "./AntennaFieldBasisPreviewModel";
import { ANTENNA_RAW_QUANTITIES, ANTENNA_CLOSED_LOOP_QUANTITIES, antennaInspectionHasCurrent, antennaVisualizationQuantity } from "./AntennaVisualizationQuantity";

export function resolveAntennaVisualizationSelection({ objectId, stageId, owner, basisAvailable, rawAvailable, rawOwnerMatches,
  raw, field, display, requested, quantity, preferredPort, displaySource }: {
  objectId: string | null;
  stageId: string | null;
  owner: SessionResourceIdentity | null;
  basisAvailable: boolean | null;
  rawAvailable: boolean;
  rawOwnerMatches: boolean;
  raw: AntennaExternalLeadInspectionResource | null;
  field: AntennaFieldSolutionResource | null;
  display: AntennaInspectionDisplay | null;
  requested: AntennaFieldIntent | null;
  quantity: AntennaFieldQuantity;
  preferredPort: string;
  displaySource: string;
}) {
  const closed = raw ? closedLoopManifest(raw) : null;
  const rawManifest = closed ?? raw?.manifest;
  const inspectionMode = displaySource === "inspection" || (!basisAvailable && rawAvailable);
  const available = inspectionMode ? rawAvailable : basisAvailable;
  const ports = inspectionMode ? raw ? [raw.port_mode_id] : [] : basisAvailable ? field?.bases.map((basis) => basis.port_mode_id) ?? [] : [];
  const matchingIntent = requested?.sourceObjectId === objectId && requested.stageId === stageId
    && requested.sessionId === owner?.sessionId && requested.sessionEpoch === owner?.sessionEpoch
    && requested.requestScopeEpoch === owner?.requestScopeEpoch && requested.kind === (inspectionMode ? "inspection" : "basis")
    && requested.contentDigest === (inspectionMode ? rawManifest?.content_digest : field?.content_digest)
    && requested.solutionId === (inspectionMode ? raw?.output_id : field?.solution_id)
    && (!inspectionMode || (rawOwnerMatches && raw && antennaInspectionIntentMatchesOwner(requested, raw))) ? requested : null;
  const port = ports.includes(preferredPort) ? preferredPort : matchingIntent && ports.includes(matchingIntent.portModeId) ? matchingIntent.portModeId : ports.length === 1 ? ports[0] : "";
  const currentAvailable = rawAvailable && antennaInspectionHasCurrent(display);
  const effectiveQuantity = antennaVisualizationQuantity(matchingIntent?.quantity ?? quantity, inspectionMode, currentAvailable, Boolean(closed));
  const current = effectiveQuantity === "current_density" || effectiveQuantity === "current_density_per_ampere";
  const perAmpereInspection = inspectionMode && Boolean(closed) && effectiveQuantity.endsWith("per_ampere");
  const legacyDisplay = display && !isClosedLoopDisplay(display) ? display : null;
  const magnetic = effectiveQuantity === "magnetic_field_per_ampere" || effectiveQuantity === "magnetic_field";
  const surfaceAvailable = inspectionMode && rawAvailable && ((magnetic && Boolean(closed?.sample_cell_count)) || (effectiveQuantity === "device_potential" || effectiveQuantity === "electric_potential_per_ampere" || current) && (closed?.cell_count ?? legacyDisplay?.device_cell_count ?? 0) > 0 && (closed?.vertex_count ?? legacyDisplay?.device_node_count ?? 0) > 0);
  const active = matchingIntent?.quantity === effectiveQuantity && matchingIntent.portModeId === port ? matchingIntent : null;
  return { inspectionMode, available, ports, port, currentAvailable, effectiveQuantity, current, perAmpereInspection, magnetic, surfaceAvailable, active };
}

export function antennaVisualizationPresentation({ objectId, effectiveQuantity, inspectionMode, surfaceAvailable, current, raw, field }: {
  objectId: string | null;
  effectiveQuantity: AntennaFieldQuantity;
  inspectionMode: boolean;
  surfaceAvailable: boolean;
  current: boolean;
  raw: AntennaExternalLeadInspectionResource | null;
  field: AntennaFieldSolutionResource | null;
}) {
  const closed = raw ? closedLoopManifest(raw) : null;
  const quantitySpec = inspectionMode && closed ? ANTENNA_CLOSED_LOOP_QUANTITIES[effectiveQuantity] : effectiveQuantity === "device_potential" || effectiveQuantity === "magnetic_field" || effectiveQuantity === "current_density" ? ANTENNA_RAW_QUANTITIES[effectiveQuantity] : ANTENNA_BASIS_QUANTITIES[effectiveQuantity];
  const magnetic = effectiveQuantity === "magnetic_field_per_ampere" || effectiveQuantity === "magnetic_field";
  const carrier = magnetic ? inspectionMode ? closed?.sample_carrier ?? raw?.manifest?.sampling_carrier : field?.sample_carrier : null;
  const carrierLabel = magnetic
    ? carrier ? `${carrier.carrier_kind} · ${carrier.location} · ${carrier.domain.kind}` : "Published field sampling domain (not available)"
    : current ? `Device Tet4 cell centers / cell-local vertex traces · ${objectId ?? "not selected"}` : `Conductor nodes · ${objectId ?? "not selected"}`;
  const renderReason = surfaceAvailable
    ? magnetic ? "H uses its independently retained sampling Tet4 mesh and actual nodal Cartesian vectors. The surface interpolates the vector before evaluating its magnitude or component. No conductor or primitive topology is adopted." : current ? "J uses the actual retained device Tet4 mesh and accepted cell-local vertex traces. The surface interpolates the Cartesian vector before evaluating magnitude or a component; traces are never averaged into nodal J. Points and full-XYZ vector glyphs use cell centers. Full reads are limited to 100000 cells / 400000 local vertices / 64 MiB; invalid or oversized data are rejected, not decimated."
      : "V uses the actual retained device Tet4 mesh: outward exterior faces, vertex colors and boundary wireframe. No primitive geometry is recolored. Full reads are limited to 100000 nodes / 100000 cells / 64 MiB; invalid topology or oversized datasets are rejected, not decimated."
    : "No compatible surface topology is published for this carrier. Points and vectors use the actual complete sample positions; the conductor primitive is never recolored. Full reads are limited to 100000 samples / 64 MiB; oversized or incompatible datasets are rejected, not decimated.";
  const rangeHint = current ? "Magnitude: zero to the global sampled maximum over all cell centers and cell-local vertex traces. Components: full sampled extrema over the same data. One shared range for all display passes." : "Full finite nodal/sample dataset range. Surface vertex colors share the same range as the device points; no guessed carrier.";
  return { quantitySpec, carrierLabel, renderReason, rangeHint };
}
