import type {
  FieldMetaQuery,
  FieldMetaResource,
  VisualizationClientAckEntry,
  VisualizationClientAckResource,
} from "@/kernel/api/apiTypes";
import type { RequestDiagnosticEntry } from "@/kernel/api/RequestDiagnosticsController";
import type { SelectionRef } from "@/kernel/selection/selectionTypes";
import {
  resolveFieldMetaResourceKey,
} from "@/kernel/resources/studyRuntimeResources";
import { visualizationDebugRangesEqual } from "@/kernel/visualization/buildVisualizationDebugHealth";
import type {
  VisualizationDebugCarrierSnapshot,
  VisualizationDebugSnapshot,
} from "@/kernel/visualization/visualizationDebugTypes";

export const MAX_VISUALIZATION_DEBUG_TRANSPORT_ENTRIES = 8;

export type VisualizationDebugPanelState =
  | "unsupported-target"
  | "active-non-3d"
  | "missing-viewport"
  | "missing-snapshot"
  | "target-not-rendered"
  | "ready";

export interface VisualizationDebugTarget {
  id: string;
  kind: "airbox" | "object" | "region";
}

export interface VisualizationDebugExactFieldQuery {
  component: string;
  key: string;
  metaQuery: FieldMetaQuery;
  metaQueryKey: string;
  metaResourceKey: string;
  phaseRad: number | null;
  quantityId: string;
  scopeId: string | null;
  scopeKind: string;
  snapshotId: string | null;
  stageId: string | null;
  vectorResourceKey: string;
  view: string | null;
}

export interface VisualizationDebugBackendRenderComparison {
  compatible: boolean;
  rangesMatch: boolean | null;
}

export interface VisualizationDebugCarrierObservation {
  backendMeta: FieldMetaResource | null;
  backendRenderComparison: VisualizationDebugBackendRenderComparison | null;
  carrier: VisualizationDebugCarrierSnapshot;
  query: VisualizationDebugExactFieldQuery | null;
  snapshot: VisualizationDebugSnapshot;
}

export interface VisualizationDebugCarrierPanelModel {
  carrierId: string;
  observations: readonly VisualizationDebugCarrierObservation[];
}

export interface VisualizationDebugViewportPanelModel {
  carriers: readonly VisualizationDebugCarrierPanelModel[];
  clientAcks: readonly (VisualizationClientAckEntry & {
    scope: "viewport-wide";
  })[];
  snapshots: readonly VisualizationDebugSnapshot[];
  viewportId: string;
}

export interface VisualizationDebugPanelModel {
  fieldQueries: readonly VisualizationDebugExactFieldQuery[];
  state: VisualizationDebugPanelState;
  target: VisualizationDebugTarget | null;
  transport: readonly RequestDiagnosticEntry[];
  viewports: readonly VisualizationDebugViewportPanelModel[];
}

export interface BuildVisualizationDebugPanelModelInput {
  activeViewportMainModuleId: string;
  clientAcks: VisualizationClientAckResource | null;
  diagnostics: readonly RequestDiagnosticEntry[];
  fieldMetaByQueryKey: ReadonlyMap<string, FieldMetaResource | null>;
  selection: SelectionRef | null;
  snapshots: readonly VisualizationDebugSnapshot[];
}

export function resolveVisualizationDebugTarget(
  selection: SelectionRef | null,
): VisualizationDebugTarget | null {
  if (!selection || !("visualizationTargetId" in selection)) return null;
  if (
    selection.kind !== "airbox.visualization.debug" &&
    selection.kind !== "object.visualization.debug" &&
    selection.kind !== "object.region.visualization.debug"
  ) {
    return null;
  }
  const id = selection.visualizationTargetId;
  if (id === "airbox") return Object.freeze({ id, kind: "airbox" });
  if (id.startsWith("object:")) {
    return Object.freeze({ id, kind: "object" });
  }
  if (id.startsWith("region:")) {
    return Object.freeze({ id, kind: "region" });
  }
  return null;
}

export function buildVisualizationDebugPanelModel({
  activeViewportMainModuleId,
  clientAcks,
  diagnostics,
  fieldMetaByQueryKey,
  selection,
  snapshots,
}: BuildVisualizationDebugPanelModelInput): VisualizationDebugPanelModel {
  const target = resolveVisualizationDebugTarget(selection);
  if (!target) return emptyModel("unsupported-target", null);
  if (activeViewportMainModuleId !== "viewport-3d") {
    return emptyModel("active-non-3d", target);
  }

  const exactSnapshots = snapshots.filter(
    (snapshot) => snapshot.target.id === target.id,
  );
  if (exactSnapshots.length === 0) {
    return emptyModel("missing-snapshot", target);
  }
  const viewportSnapshots = exactSnapshots.filter(
    (snapshot) => snapshot.viewport.viewportId.trim().length > 0,
  );
  if (viewportSnapshots.length === 0) {
    return emptyModel("missing-viewport", target);
  }

  const fieldQueries = new Map<string, VisualizationDebugExactFieldQuery>();
  const resourceKeys = new Set<string>();
  const viewportGroups = new Map<
    string,
    {
      carrierGroups: Map<string, VisualizationDebugCarrierObservation[]>;
      snapshots: VisualizationDebugSnapshot[];
    }
  >();
  for (const snapshot of viewportSnapshots) {
    const viewportId = snapshot.viewport.viewportId;
    let viewport = viewportGroups.get(viewportId);
    if (!viewport) {
      viewport = { carrierGroups: new Map(), snapshots: [] };
      viewportGroups.set(viewportId, viewport);
    }
    viewport.snapshots.push(snapshot);
    for (const carrier of snapshot.carriers) {
      const query = resolveVisualizationDebugCarrierQuery(carrier);
      if (query) fieldQueries.set(query.key, query);
      addCarrierResourceKeys(resourceKeys, carrier);
      const backendMeta = query
        ? (fieldMetaByQueryKey.get(query.metaQueryKey) ??
          fieldMetaByQueryKey.get(query.key) ??
          null)
        : null;
      const observation = Object.freeze({
        backendMeta,
        backendRenderComparison: compareBackendAndRender({
          backendMeta,
          carrier,
          query,
        }),
        carrier,
        query,
        snapshot,
      });
      const observations = viewport.carrierGroups.get(carrier.carrierId);
      if (observations) observations.push(observation);
      else viewport.carrierGroups.set(carrier.carrierId, [observation]);
    }
  }
  const viewports = [...viewportGroups.entries()].map(([viewportId, group]) => {
    const carriers = [...group.carrierGroups.entries()].map(
      ([carrierId, observations]) =>
        Object.freeze({
          carrierId,
          observations: Object.freeze(observations),
        }),
    );
    return Object.freeze({
      carriers: Object.freeze(carriers),
      clientAcks: Object.freeze(
        (clientAcks?.entries ?? [])
          .filter((entry) => entry.viewport_id === viewportId)
          .map((entry) => Object.freeze({ ...entry, scope: "viewport-wide" as const })),
      ),
      snapshots: Object.freeze(group.snapshots),
      viewportId,
    });
  });

  return Object.freeze({
    fieldQueries: Object.freeze([...fieldQueries.values()]),
    state: viewports.some((viewport) => viewport.carriers.length > 0)
      ? "ready"
      : "target-not-rendered",
    target,
    transport: Object.freeze(
      diagnostics
        .filter(
          (entry) =>
            entry.resourceKey !== null &&
            entry.resourceKey !== undefined &&
            resourceKeys.has(entry.resourceKey),
        )
        .slice(0, MAX_VISUALIZATION_DEBUG_TRANSPORT_ENTRIES),
    ),
    viewports: Object.freeze(viewports),
  });
}

export function resolveVisualizationDebugCarrierQuery(
  carrier: VisualizationDebugCarrierSnapshot,
): VisualizationDebugExactFieldQuery | null {
  const payload = carrier.payload;
  const resourceKey = carrier.request.resourceKey;
  if (!payload || !resourceKey) return null;

  let url: URL;
  try {
    url = new URL(resourceKey, "http://fullmag.invalid");
  } catch {
    return null;
  }
  const match = /\/data\/fields\/([^/]+)\/samples\/vector$/.exec(url.pathname);
  if (!match) return null;

  let quantityId: string;
  try {
    quantityId = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  const component = url.searchParams.get("component") ?? "full";
  const scopeKind = url.searchParams.get("scope_kind") ?? "full";
  const scopeId = url.searchParams.get("scope_id");
  if (
    quantityId !== payload.quantityId ||
    component !== payload.component ||
    scopeKind !== payload.scopeKind ||
    scopeId !== payload.scopeId
  ) {
    return null;
  }

  const snapshotId = url.searchParams.get("snapshot_id");
  const stageId = url.searchParams.get("stage_id");
  const view = url.searchParams.get("view");
  const phaseText = url.searchParams.get("phase_rad");
  const parsedPhase = phaseText === null ? null : Number(phaseText);
  const phaseRad = parsedPhase !== null && Number.isFinite(parsedPhase)
    ? parsedPhase
    : null;
  const metaQuery: FieldMetaQuery = Object.freeze({
    component,
    scope_id: scopeId,
    scope_kind: scopeKind,
    snapshot_id: snapshotId,
    stage_id: stageId,
  });
  const metaQueryKey = canonicalVisualizationDebugFieldMetaQueryKey({
    component,
    quantityId,
    scopeId,
    scopeKind,
    snapshotId,
    stageId,
  });
  const key = canonicalVisualizationDebugExactQueryKey({
    component,
    phaseRad,
    quantityId,
    scopeId,
    scopeKind,
    snapshotId,
    stageId,
    view,
  });

  return Object.freeze({
    component,
    key,
    metaQuery,
    metaQueryKey,
    metaResourceKey: resolveFieldMetaResourceKey(quantityId, metaQuery),
    phaseRad,
    quantityId,
    scopeId,
    scopeKind,
    snapshotId,
    stageId,
    vectorResourceKey: resourceKey,
    view,
  });
}

export function canonicalVisualizationDebugFieldMetaQueryKey(input: {
  component: string;
  quantityId: string;
  scopeId: string | null;
  scopeKind: string;
  snapshotId: string | null;
  stageId: string | null;
}): string {
  return JSON.stringify([
    input.quantityId,
    input.component,
    input.scopeKind,
    input.scopeId,
    input.snapshotId,
    input.stageId,
  ]);
}

export function canonicalVisualizationDebugExactQueryKey(input: {
  component: string;
  phaseRad: number | null;
  quantityId: string;
  scopeId: string | null;
  scopeKind: string;
  snapshotId: string | null;
  stageId: string | null;
  view: string | null;
}): string {
  return JSON.stringify([
    input.quantityId,
    input.component,
    input.scopeKind,
    input.scopeId,
    input.snapshotId,
    input.stageId,
    input.view,
    input.phaseRad,
  ]);
}

export function compareBackendAndRender({
  backendMeta,
  carrier,
  query,
}: {
  backendMeta: FieldMetaResource | null;
  carrier: VisualizationDebugCarrierSnapshot;
  query: VisualizationDebugExactFieldQuery | null;
}): VisualizationDebugBackendRenderComparison | null {
  if (!backendMeta || !query || !carrier.payload) return null;
  const compatible =
    backendMeta.quantity_id === query.quantityId &&
    backendMeta.domain_generation_id === carrier.revisions.domainGenerationId &&
    String(backendMeta.field_revision) === carrier.revisions.fieldRevision &&
    carrier.payload.component === query.component &&
    carrier.payload.scopeKind === query.scopeKind &&
    carrier.payload.scopeId === query.scopeId;
  if (!compatible) return Object.freeze({ compatible: false, rangesMatch: null });

  const rendered = carrier.statistics.find(
    (entry) =>
      entry.source === "render-derived" || entry.source === "decoded-payload",
  );
  const stats = backendMeta.stats;
  const rangesMatch =
    rendered?.min == null || rendered.max == null || !stats
      ? null
      : visualizationDebugRangesEqual(stats.min, rendered.min) &&
        visualizationDebugRangesEqual(stats.max, rendered.max);
  return Object.freeze({ compatible: true, rangesMatch });
}

function emptyModel(
  state: VisualizationDebugPanelState,
  target: VisualizationDebugTarget | null,
): VisualizationDebugPanelModel {
  return Object.freeze({
    fieldQueries: Object.freeze([]),
    state,
    target,
    transport: Object.freeze([]),
    viewports: Object.freeze([]),
  });
}

function addCarrierResourceKeys(
  resourceKeys: Set<string>,
  carrier: VisualizationDebugCarrierSnapshot,
): void {
  if (carrier.request.resourceKey) resourceKeys.add(carrier.request.resourceKey);
  if (carrier.render.adoption.adoptedResourceKey) {
    resourceKeys.add(carrier.render.adoption.adoptedResourceKey);
  }
}
