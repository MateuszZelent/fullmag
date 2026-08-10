import type {
  RegionDiagnosticsResource,
  RegionListResource,
  SceneResource,
} from "@/kernel/api/apiTypes";
import type { components } from "@/kernel/api/generated/openapi-v2-types";
import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  ownerBoundsForObject,
  type ObjectRegionDiagnosticItem,
  type RegionOwnerBounds,
} from "./ObjectRegionsPanelModel";
import type { MeshInspectorLane } from "./fdmMeshInspectorModel";
import { resolveRegionDiagnosticsForLane } from "./region/regionDiagnosticPresentation";

interface JsonRecord {
  [key: string]: unknown;
}

export type RegionShapeKind = "box" | "cylinder" | "sphere";

export interface RegionsListItem {
  colorIndex: number;
  conflictCount: number;
  diagnosticCount: number;
  enabled: boolean;
  errorCount: number;
  name: string;
  objectId: string;
  priority: number;
  realizationPolicy: string;
  realizationStatus: string;
  regionId: string;
  shapeKind: string;
  warningCount: number;
}

export interface RegionsListPanelModel {
  conflictCount: number;
  diagnosticCount: number;
  errorCount: number;
  items: RegionsListItem[];
  mode: "committed" | "missing";
  objectId: string;
  ownerBounds: RegionOwnerBounds | null;
  objectLabel: string;
  revision: number | null;
  warningCount: number;
}

export interface NewRegionDraft {
  name: string;
  priority: number;
  shapeKind: RegionShapeKind;
}


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

function selectedObjectId(selection: Selection): string | null {
  return selection.ref?.type === "scene-object"
    ? selection.ref.objectId
    : selection.objectId;
}

function sceneObjectForSelection(
  selection: Selection,
  scene: SceneResource | null,
): { object: JsonRecord | null; objectId: string | null; revision: number | null } {
  const objectId = selectedObjectId(selection);
  const sceneRecord = asRecord(scene);
  const object = Array.isArray(sceneRecord?.objects)
    ? sceneRecord.objects
        .map(asRecord)
        .find((entry) => asString(entry?.id) === objectId) ?? null
    : null;

  return {
    object,
    objectId,
    revision: asNumber(sceneRecord?.revision),
  };
}

function regionOwnerMatches(
  region: RegionListResource["regions"][number],
  objectId: string,
): boolean {
  return (
    region.owner_object_id === objectId ||
    region.source_object_ids.includes(objectId)
  );
}

function shapeKindForRegion(region: RegionListResource["regions"][number]): string {
  const shape = asRecord(region.shape);
  return asString(shape?.kind) ?? "region";
}

function isConflictDiagnostic(
  diagnostic: Pick<ObjectRegionDiagnosticItem, "code" | "message">,
): boolean {
  return (
    diagnostic.code.toLowerCase().includes("conflict") ||
    diagnostic.message.toLowerCase().includes("conflict")
  );
}

function diagnosticsForRegion(
  objectId: string,
  regionId: string,
  regionDiagnostics: RegionDiagnosticsResource | null,
  meshLane: MeshInspectorLane,
): ObjectRegionDiagnosticItem[] {
  const diagnostics =
    regionDiagnostics?.diagnostics.flatMap((diagnostic) =>
      diagnostic.owner_object_id === objectId && diagnostic.region_id === regionId
        ? [
            {
              capabilityGate: diagnostic.capability_gate ?? null,
              code: diagnostic.code,
              diagnosticId: diagnostic.diagnostic_id,
              message: diagnostic.message,
              realizationStatus: diagnostic.realization_status ?? null,
              severity: diagnostic.severity,
            },
          ]
        : [],
    ) ?? [];
  return resolveRegionDiagnosticsForLane(diagnostics, meshLane);
}

export function resolveRegionsListPanelModel(
  selection: Selection,
  scene: SceneResource | null,
  regions: RegionListResource | null,
  regionDiagnostics: RegionDiagnosticsResource | null = null,
  meshLane: MeshInspectorLane = "unknown",
): RegionsListPanelModel {
  const { object, objectId, revision } = sceneObjectForSelection(selection, scene);
  if (!object || !objectId) {
    return {
      conflictCount: 0,
      diagnosticCount: 0,
      errorCount: 0,
      items: [],
      mode: "missing",
      objectId: objectId ?? "none",
      ownerBounds: null,
      objectLabel: objectId ?? "none",
      revision,
      warningCount: 0,
    };
  }

  const items = (regions?.regions ?? [])
    .filter(
      (region) =>
        region.source === "authored_object_region" &&
        regionOwnerMatches(region, objectId),
    )
    .sort((left, right) => {
      const priorityDelta = (right.priority ?? 0) - (left.priority ?? 0);
      if (priorityDelta !== 0) return priorityDelta;
      return left.name.localeCompare(right.name);
    })
    .map((region, index) => {
      const diagnostics = diagnosticsForRegion(
        objectId,
        region.region_id,
        regionDiagnostics,
        meshLane,
      );
      return {
        colorIndex: index % 8,
        conflictCount: diagnostics.filter(isConflictDiagnostic).length,
        diagnosticCount: diagnostics.length,
        enabled: region.enabled,
        errorCount: diagnostics.filter(
          (diagnostic) => diagnostic.severity === "error",
        ).length,
        name: region.name,
        objectId,
        priority: region.priority ?? 0,
        realizationPolicy: region.realization_policy ?? "inherit",
        realizationStatus: region.realization_status ?? "authored_pending",
        regionId: region.region_id,
        shapeKind: shapeKindForRegion(region),
        warningCount: diagnostics.filter(
          (diagnostic) => diagnostic.severity === "warning",
        ).length,
      };
    });

  return {
    conflictCount: items.reduce((total, item) => total + item.conflictCount, 0),
    diagnosticCount: items.reduce((total, item) => total + item.diagnosticCount, 0),
    errorCount: items.reduce((total, item) => total + item.errorCount, 0),
    items,
    mode: "committed",
    objectId,
    ownerBounds: ownerBoundsForObject(object),
    objectLabel: asString(object.name) ?? objectId,
    revision,
    warningCount: items.reduce((total, item) => total + item.warningCount, 0),
  };
}

export function defaultNewRegionDraft(): NewRegionDraft {
  return {
    name: "",
    priority: 0,
    shapeKind: "box",
  };
}

export function validateNewRegionDraft(draft: NewRegionDraft): string[] {
  const errors: string[] = [];
  if (draft.name.trim().length === 0) {
    errors.push("Region name is required.");
  }
  if (!Number.isFinite(draft.priority) || !Number.isInteger(draft.priority)) {
    errors.push("Region priority must be an integer.");
  }
  if (!["box", "cylinder", "sphere"].includes(draft.shapeKind)) {
    errors.push("Region shape must be box, cylinder, or sphere.");
  }
  return errors;
}

export function buildNewRegionPayload(
  draft: NewRegionDraft,
  ownerBounds: RegionOwnerBounds | null = null,
): components["schemas"]["SceneObjectRegion"] {
  const name = draft.name.trim();
  const priority = Number.isFinite(draft.priority) ? draft.priority : 0;
  const center = ownerBounds?.center ?? [0, 0, 0];
  const ownerSize = ownerBounds?.size ?? [100e-9, 100e-9, 100e-9];
  const boxSize = ownerSize.map((entry) => entry * 0.5) as [
    number,
    number,
    number,
  ];
  let shape: components["schemas"]["SceneRegionShape"];
  if (draft.shapeKind === "cylinder") {
    shape = {
      axis: [0, 0, 1],
      center,
      height: boxSize[2],
      kind: "cylinder",
      radius: Math.min(boxSize[0], boxSize[1]) / 2,
    };
  } else if (draft.shapeKind === "sphere") {
    shape = {
      center,
      kind: "sphere",
      radius: Math.min(...boxSize) / 2,
    };
  } else {
    shape = {
      center,
      kind: "box",
      size: boxSize,
    };
  }

  return {
    region_id: "",
    enabled: true,
    frame: "object",
    name,
    priority,
    realization_policy: "inherit",
    shape,
  };
}

export function findRegionIdByName(
  scene: SceneResource | null,
  objectId: string,
  regionName: string,
): string | null {
  const sceneRecord = asRecord(scene);
  const object = Array.isArray(sceneRecord?.objects)
    ? sceneRecord.objects
        .map(asRecord)
        .find((entry) => asString(entry?.id) === objectId) ?? null
    : null;
  if (!object || !Array.isArray(object.regions)) return null;

  const targetName = regionName.trim();
  const matches = object.regions.flatMap((region) => {
    const record = asRecord(region);
    return asString(record?.name) === targetName ? [record] : [];
  });
  if (matches.length !== 1) return null;

  return asString(matches[0]?.region_id) ?? asString(matches[0]?.id);
}

export function findLastRegionSelection(
  scene: SceneResource | null,
  objectId: string,
  excludedRegionId: string,
): { name: string; regionId: string } | null {
  const sceneRecord = asRecord(scene);
  const object = Array.isArray(sceneRecord?.objects)
    ? sceneRecord.objects
        .map(asRecord)
        .find((entry) => asString(entry?.id) === objectId) ?? null
    : null;
  if (!object || !Array.isArray(object.regions)) return null;

  const candidates = object.regions.flatMap((region) => {
      const record = asRecord(region);
      if (!record) return [];
      const regionId = asString(record.region_id) ?? asString(record.id);
      return regionId && regionId !== excludedRegionId ? [record] : [];
    });
  const last = candidates.at(-1);
  if (!last) return null;
  const regionId = asString(last.region_id) ?? asString(last.id);
  const name = asString(last.name);
  return regionId && name ? { name, regionId } : null;
}

export function regionNodeId(objectId: string, regionId: string): string {
  return `model:object:${objectId}:regions:${regionId}`;
}

export function regionsNodeId(objectId: string): string {
  return `model:object:${objectId}:regions`;
}
