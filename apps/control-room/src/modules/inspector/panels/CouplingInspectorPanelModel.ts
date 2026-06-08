import type { CouplingListResource } from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";

interface JsonRecord {
  [key: string]: unknown;
}

export interface CouplingInspectorEndpoint {
  area: number | null;
  label: string;
  objectId: string;
  regionId: string | null;
  resolutionReason: string | null;
  resolutionStatus: string;
  resolvedFaceCount: number | null;
  selector: string | null;
  tolerance: number | null;
  kind: string;
}

export interface CouplingInspectorModel {
  blockerReason: string | null;
  couplingId: string | null;
  enabled: boolean;
  kind: string;
  mode: "found" | "missing" | "unselected";
  parameters: JsonRecord;
  realizationStatus: string;
  source: CouplingInspectorEndpoint | null;
  target: CouplingInspectorEndpoint | null;
}

function asRecord(value: unknown): JsonRecord | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function selectedCouplingId(selection: Selection): string | null {
  if (selection.ref?.type === "physics-coupling") {
    return selection.ref.couplingId;
  }
  return null;
}

function endpointLabel(endpoint: JsonRecord | null): string {
  if (!endpoint) return "unresolved";
  const objectId = asString(endpoint.object) ?? "object";
  const regionId = asString(endpoint.region_id);
  const selector = asString(endpoint.selector);
  if (selector) return `${objectId}/${selector}`;
  if (regionId) return `${objectId}/${regionId}`;
  return objectId;
}

function endpointModel(
  endpoint: unknown,
  resolution: unknown,
): CouplingInspectorEndpoint | null {
  const record = asRecord(endpoint);
  if (!record) return null;
  const resolutionRecord = asRecord(resolution);
  const objectId = asString(record.object) ?? "";
  return {
    area: asNumber(resolutionRecord?.area),
    kind: asString(record.kind) ?? "object",
    label: endpointLabel(record),
    objectId,
    regionId: asString(record.region_id),
    resolutionReason: asString(resolutionRecord?.reason),
    resolutionStatus:
      asString(resolutionRecord?.status) ?? "resolution_unavailable",
    resolvedFaceCount: asNumber(resolutionRecord?.resolved_face_count),
    selector: asString(record.selector),
    tolerance: asNumber(resolutionRecord?.tolerance),
  };
}

export function resolveCouplingInspectorModel(
  selection: Selection,
  couplings: CouplingListResource | null,
): CouplingInspectorModel {
  const couplingId = selectedCouplingId(selection);
  if (!couplingId) {
    return {
      blockerReason: null,
      couplingId: null,
      enabled: false,
      kind: "none",
      mode: "unselected",
      parameters: {},
      realizationStatus: "unselected",
      source: null,
      target: null,
    };
  }

  const coupling = (couplings?.couplings ?? []).find(
    (entry) => entry.coupling_id === couplingId,
  );
  if (!coupling) {
    return {
      blockerReason: null,
      couplingId,
      enabled: false,
      kind: "missing",
      mode: "missing",
      parameters: {},
      realizationStatus: "missing",
      source: null,
      target: null,
    };
  }

  return {
    blockerReason: asString(coupling.blocker_reason),
    couplingId,
    enabled: coupling.enabled !== false,
    kind: coupling.coupling_kind,
    mode: "found",
    parameters: asRecord(coupling.params) ?? {},
    realizationStatus: coupling.realization_status ?? "authored_pending",
    source: endpointModel(coupling.source, coupling.source_resolution),
    target: endpointModel(coupling.target, coupling.target_resolution),
  };
}
