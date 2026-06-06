import type { CouplingListResource } from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";

interface JsonRecord {
  [key: string]: unknown;
}

export interface CouplingInspectorEndpoint {
  label: string;
  objectId: string;
  regionId: string | null;
  selector: string | null;
  kind: string;
}

export interface CouplingInspectorModel {
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

function endpointModel(endpoint: unknown): CouplingInspectorEndpoint | null {
  const record = asRecord(endpoint);
  if (!record) return null;
  const objectId = asString(record.object) ?? "";
  return {
    kind: asString(record.kind) ?? "object",
    label: endpointLabel(record),
    objectId,
    regionId: asString(record.region_id),
    selector: asString(record.selector),
  };
}

export function resolveCouplingInspectorModel(
  selection: Selection,
  couplings: CouplingListResource | null,
): CouplingInspectorModel {
  const couplingId = selectedCouplingId(selection);
  if (!couplingId) {
    return {
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
    couplingId,
    enabled: coupling.enabled !== false,
    kind: coupling.coupling_kind,
    mode: "found",
    parameters: asRecord(coupling.params) ?? {},
    realizationStatus: coupling.realization_status ?? "authored_pending",
    source: endpointModel(coupling.source),
    target: endpointModel(coupling.target),
  };
}
