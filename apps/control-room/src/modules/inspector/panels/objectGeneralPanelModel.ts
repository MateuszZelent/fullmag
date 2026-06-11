import type {
  ObjectMetricsResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import type { Selection } from "@/kernel/selection/selectionTypes";

export interface ObjectGeneralPanelModel {
  material: string;
  meshStatus: string;
  mode: "committed" | "draft-new" | "missing";
  name: string;
  notes: string;
  objectId: string;
  region: string;
  revision: number | null;
  shape: string;
  source: string;
}

export interface ObjectMetricsPanelModel {
  anisotropy: string;
  demag: string;
  dmi: string;
  exchange: string;
  magnetization: string;
  sample: string;
  source: string;
  status: string;
  total: string;
  zeeman: string;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sceneObjectForSelection(
  selection: Selection,
  scene: SceneResource | null,
): { object: JsonRecord | null; objectId: string | null; revision: number | null } {
  const objectId = selection.ref?.type === "scene-object"
    ? selection.ref.objectId
    : selection.objectId;
  const sceneRecord = asRecord(scene);
  const sceneObjects = sceneRecord?.objects;
  const object = Array.isArray(sceneObjects)
    ? sceneObjects
        .map(asRecord)
        .find((entry) => asString(entry?.id) === objectId) ?? null
    : null;

  return {
    object,
    objectId,
    revision: asNumber(sceneRecord?.revision),
  };
}

function meshStatus(tags: unknown): string {
  const values = Array.isArray(tags) ? tags : [];
  if (values.includes("validation:blocked")) return "validation-blocked";
  if (values.includes("mesh:building")) return "mesh-building";
  if (values.includes("mesh:failed")) return "mesh-failed";
  if (values.includes("mesh:dirty")) return "mesh-stale";
  if (values.includes("mesh:ready")) return "mesh-ready";
  return "primitive-only";
}

export function resolveObjectGeneralPanelModel(
  selection: Selection,
  scene: SceneResource | null,
): ObjectGeneralPanelModel {
  const { object, objectId, revision } = sceneObjectForSelection(selection, scene);

  if (!object || !objectId) {
    return {
      material: "unassigned",
      meshStatus: "primitive-only",
      mode: "missing",
      name: selection.label ?? "No object",
      notes: "",
      objectId: objectId ?? "none",
      region: "unassigned",
      revision,
      shape: selection.kind ?? "object",
      source: "SceneDocument",
    };
  }

  const geometry = asRecord(object?.geometry);

  return {
    material: asString(object.material_ref) ?? "unassigned",
    meshStatus: meshStatus(object.tags),
    mode: "committed",
    name: asString(object.name) ?? objectId,
    notes: asString(object.notes) ?? "",
    objectId,
    region: asString(object.region_name) ?? "unassigned",
    revision,
    shape:
      asString(geometry?.geometry_kind) ??
      asString(geometry?.kind) ??
      "object",
    source: "SceneDocument",
  };
}

function formatScientific(value: unknown, unit: string): string {
  const numberValue = asNumber(value);
  return numberValue === null ? "unavailable" : `${numberValue.toExponential(6)} ${unit}`;
}

function formatMagnetization(
  value: ObjectMetricsResource["magnetization_average"] | null | undefined,
): string {
  const mx = asNumber(value?.mx);
  const my = asNumber(value?.my);
  const mz = asNumber(value?.mz);
  return mx === null || my === null || mz === null
    ? "unavailable"
    : `(${mx.toFixed(6)}, ${my.toFixed(6)}, ${mz.toFixed(6)})`;
}

export function resolveObjectMetricsPanelModel(
  metrics: ObjectMetricsResource | null,
): ObjectMetricsPanelModel {
  if (!metrics) {
    return {
      anisotropy: "unavailable",
      demag: "unavailable",
      dmi: "unavailable",
      exchange: "unavailable",
      magnetization: "unavailable",
      sample: "no resource",
      source: "unavailable",
      status: "unavailable",
      total: "unavailable",
      zeeman: "unavailable",
    };
  }

  const sampleStep = asNumber(metrics.step);
  const sampleTime = asNumber(metrics.time_seconds);

  return {
    anisotropy: formatScientific(metrics.energies?.anisotropy, "J"),
    demag: formatScientific(metrics.energies?.demag, "J"),
    dmi: formatScientific(metrics.energies?.dmi, "J"),
    exchange: formatScientific(metrics.energies?.exchange, "J"),
    magnetization: formatMagnetization(metrics.magnetization_average),
    sample:
      sampleStep === null || sampleTime === null
        ? "unavailable"
        : `step ${sampleStep} @ ${sampleTime.toExponential(6)} s`,
    source: asString(metrics.source) ?? "unavailable",
    status: metrics.has_solver_sample ? "computed" : "initial",
    total: formatScientific(metrics.energies?.total, "J"),
    zeeman: formatScientific(metrics.energies?.zeeman, "J"),
  };
}

export function summarizeGeometryValidationMessages(
  validation: unknown,
  objectId: string,
): string[] {
  const messages: string[] = [];
  const visit = (value: unknown): void => {
    if (messages.length >= 5) return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    const record = asRecord(value);
    if (!record) return;
    if (recordTargetsObject(record, objectId)) {
      const message = validationMessageFromRecord(record);
      if (message && !messages.includes(message)) {
        messages.push(message);
      }
    }
    for (const child of Object.values(record)) {
      visit(child);
    }
  };

  visit(validation);
  return messages;
}

function validationMessageFromRecord(record: JsonRecord): string | null {
  return (
    asString(record.message) ??
    asString(record.error) ??
    asString(record.reason) ??
    asString(record.detail) ??
    asString(record.description)
  );
}

function recordTargetsObject(record: JsonRecord, objectId: string): boolean {
  const target =
    asString(record.object_id) ??
    asString(record.objectId) ??
    asString(record.target_id) ??
    asString(record.targetId);
  return !target || target === objectId || target === `object:${objectId}`;
}
