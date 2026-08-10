import type {
  FieldMetaQuery,
  FieldMetaResource,
  VisualizationClientAckEntry,
  VisualizationClientAckResource,
} from "@/kernel/api/apiTypes";
import type { RequestDiagnosticEntry } from "@/kernel/api/RequestDiagnosticsController";
import {
  fieldVectorComponentEvidenceIdentity,
  fieldVectorComponentsSemanticallyEqual,
  parseCanonicalFieldVectorResourceKey,
  serializeCanonicalFieldVectorResourceKey,
} from "@/kernel/api/fieldQueryIdentity";
import type { SelectionRef } from "@/kernel/selection/selectionTypes";
import {
  resolveFieldMetaResourceKey,
} from "@/kernel/resources/studyRuntimeResources";
import {
  prioritizeAndBoundVisualizationDebugIssues,
  visualizationDebugRangesEqual,
} from "@/kernel/visualization/buildVisualizationDebugHealth";
import type {
  VisualizationDebugDisposition,
  VisualizationDebugCarrierSnapshot,
  VisualizationDebugIssue,
  VisualizationDebugSnapshot,
} from "@/kernel/visualization/visualizationDebugTypes";

export const MAX_VISUALIZATION_DEBUG_TRANSPORT_ENTRIES = 8;
export const MAX_VISUALIZATION_DEBUG_COMPOSITE_ISSUES = 20;

export type VisualizationDebugPanelState =
  | "unsupported-target"
  | "active-non-3d"
  | "missing-viewport"
  | "missing-snapshot"
  | "target-not-rendered"
  | "ready";

export type VisualizationDebugLane = "fdm" | "fem" | "unresolved";

export function resolveVisualizationDebugLane(
  discretization: string | null | undefined,
): VisualizationDebugLane {
  const normalized = discretization?.trim().toLowerCase();
  if (normalized === "fdm") return "fdm";
  if (normalized === "fem") return "fem";
  return "unresolved";
}

export type VisualizationDebugSelectionKind =
  | "airbox.visualization.debug"
  | "object.visualization.debug"
  | "object.region.visualization.debug";

export interface VisualizationDebugTarget {
  id: string;
  kind: "airbox" | "object" | "region";
  selectionKind: VisualizationDebugSelectionKind;
}

export interface VisualizationDebugExactFieldQuery {
  component: string;
  geometryScope: string | null;
  key: string;
  maxSamples: number | null;
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

type VisualizationDebugSurfaceComponentComparison =
  | "comparable"
  | "derived"
  | "incompatible"
  | "missing";

export interface VisualizationDebugCarrierObservation {
  backendMeta: FieldMetaResource | null;
  backendRenderComparison: VisualizationDebugBackendRenderComparison | null;
  carrier: VisualizationDebugCarrierSnapshot;
  query: VisualizationDebugExactFieldQuery | null;
  snapshot: VisualizationDebugSnapshot;
  wireByteLength: number | null;
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
  disposition: VisualizationDebugDisposition;
  fieldQueries: readonly VisualizationDebugExactFieldQuery[];
  issues: readonly VisualizationDebugIssue[];
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
  if (selection.kind === "airbox.visualization.debug" && id === "airbox") {
    return Object.freeze({ id, kind: "airbox", selectionKind: selection.kind });
  }
  if (
    selection.kind === "object.visualization.debug" &&
    id.startsWith("object:")
  ) {
    return Object.freeze({ id, kind: "object", selectionKind: selection.kind });
  }
  if (
    selection.kind === "object.region.visualization.debug" &&
    id.startsWith("region:")
  ) {
    return Object.freeze({ id, kind: "region", selectionKind: selection.kind });
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
      const backendMeta = query && visualizationDebugQuerySupportsFieldMeta(query)
        ? (fieldMetaByQueryKey.get(query.metaQueryKey) ?? null)
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
        wireByteLength: null,
      });
      const observations = viewport.carrierGroups.get(carrier.carrierId);
      if (observations) observations.push(observation);
      else viewport.carrierGroups.set(carrier.carrierId, [observation]);
    }
  }
  const exactDiagnostics = diagnostics
    .filter(
      (entry) =>
        entry.resourceKey !== null &&
        entry.resourceKey !== undefined &&
        resourceKeys.has(entry.resourceKey),
    )
    .map((entry, index) => ({ entry, index }))
    .sort(
      (left, right) =>
        right.entry.timestampMs - left.entry.timestampMs ||
        left.index - right.index,
    )
    .map(({ entry }) => entry);
  const terminalByResource = latestTerminalTransportByResource(exactDiagnostics);
  const viewports = [...viewportGroups.entries()].map(([viewportId, group]) => {
    const carriers = [...group.carrierGroups.entries()].map(
      ([carrierId, observations]) =>
        Object.freeze({
          carrierId,
          observations: Object.freeze(
            observations.map((observation) => {
              const resourceKey = observation.query?.vectorResourceKey ?? null;
              const terminal = resourceKey
                ? terminalByResource.get(resourceKey) ?? null
                : null;
              return Object.freeze({
                ...observation,
                wireByteLength: exactDecodedWireByteLength(terminal),
              });
            }),
          ),
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

  const state = viewports.some((viewport) => viewport.carriers.length > 0)
    ? "ready"
    : "target-not-rendered";
  const composite = buildCompositeHealth({
    state,
    terminalByResource,
    viewports,
  });
  return Object.freeze({
    disposition: composite.disposition,
    fieldQueries: Object.freeze([...fieldQueries.values()]),
    issues: composite.issues,
    state,
    target,
    transport: Object.freeze(
      exactDiagnostics.slice(0, MAX_VISUALIZATION_DEBUG_TRANSPORT_ENTRIES),
    ),
    viewports: Object.freeze(viewports),
  });
}

export function resolveVisualizationDebugCarrierQuery(
  carrier: VisualizationDebugCarrierSnapshot,
): VisualizationDebugExactFieldQuery | null {
  const resourceKey = carrier.request.resourceKey;
  if (!resourceKey) return null;
  const parsed = parseCanonicalFieldVectorResourceKey(resourceKey);
  if (!parsed) return null;
  const component = parsed.component;
  const geometryScope = parsed.geometryScope ?? null;
  const maxSamples = parsed.maxSamples ?? null;
  const phaseRad = parsed.phaseRad ?? null;
  const quantityId = parsed.quantityId;
  const scopeId = parsed.scopeId ?? null;
  const scopeKind = parsed.scopeKind;
  const snapshotId = parsed.snapshotId ?? null;
  const stageId = parsed.stageId ?? null;
  const view = parsed.view ?? null;
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
  const key = serializeCanonicalFieldVectorResourceKey(parsed);

  return Object.freeze({
    component,
    geometryScope,
    key,
    maxSamples,
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

export function compareBackendAndRender({
  backendMeta,
  carrier,
  query,
}: {
  backendMeta: FieldMetaResource | null;
  carrier: VisualizationDebugCarrierSnapshot;
  query: VisualizationDebugExactFieldQuery | null;
}): VisualizationDebugBackendRenderComparison | null {
  if (!backendMeta || !query) return null;
  if (!visualizationDebugQuerySupportsFieldMeta(query)) {
    return null;
  }
  const payload = carrier.payload;
  const requestedFieldBufferId = carrier.render.requestedFieldBufferId;
  const adoptedFieldBufferId = carrier.render.adoption.adoptedFieldBufferId;
  const renderedScalarBufferKey = carrier.render.surface.bufferKey;
  const adoptedScalarBufferKey = carrier.render.adoption.adoptedScalarBufferKey;
  const renderedVectorBuildKey = carrier.render.vectors.buildKey;
  const adoptedVectorBuildKey = carrier.render.adoption.adoptedVectorBuildKey;
  const adoptedResourceKey = carrier.render.adoption.adoptedResourceKey;
  const surfaceRequested = carrier.render.requestedPasses.includes("surface");
  const vectorRequested = carrier.render.requestedPasses.includes("vector-glyph");
  const surfaceComponentComparison = compareSurfaceComponentEvidence(
    carrier,
    query,
  );
  const fieldRevisionComparison = comparePhysicalFieldRevision(
    carrier.revisions.fieldRevision,
    backendMeta.field_revision,
  );
  if (
    backendMeta.quantity_id !== query.quantityId ||
    (carrier.revisions.domainGenerationId !== null &&
      backendMeta.domain_generation_id !==
        carrier.revisions.domainGenerationId) ||
    fieldRevisionComparison === "render-stale" ||
    (payload !== null && payload.quantityId !== query.quantityId) ||
    (payload !== null &&
      payload.scopeKind !== null &&
      payload.scopeKind !== query.scopeKind) ||
    (payload !== null &&
      (payload.scopeKind !== null || payload.scopeId !== null) &&
      payload.scopeId !== query.scopeId) ||
    surfaceComponentComparison === "incompatible" ||
    (requestedFieldBufferId !== null &&
      adoptedFieldBufferId !== null &&
      requestedFieldBufferId !== adoptedFieldBufferId) ||
    (surfaceRequested &&
      renderedScalarBufferKey !== null &&
      adoptedScalarBufferKey !== null &&
      renderedScalarBufferKey !== adoptedScalarBufferKey) ||
    (vectorRequested &&
      renderedVectorBuildKey !== null &&
      adoptedVectorBuildKey !== null &&
      renderedVectorBuildKey !== adoptedVectorBuildKey) ||
    (adoptedResourceKey !== null &&
      adoptedResourceKey !== query.vectorResourceKey)
  ) {
    return Object.freeze({ compatible: false, rangesMatch: null });
  }
  if (surfaceComponentComparison === "derived") {
    return null;
  }
  if (
    payload === null ||
    payload.scopeKind === null ||
    carrier.revisions.domainGenerationId === null ||
    fieldRevisionComparison !== "current" ||
    (!surfaceRequested && !vectorRequested) ||
    requestedFieldBufferId === null ||
    adoptedFieldBufferId === null ||
    adoptedResourceKey === null ||
    (surfaceRequested &&
      (surfaceComponentComparison === "missing" ||
        renderedScalarBufferKey === null ||
        adoptedScalarBufferKey === null)) ||
    (vectorRequested &&
      (renderedVectorBuildKey === null || adoptedVectorBuildKey === null))
  ) {
    return null;
  }

  const rendered = carrier.statistics.find(
    (entry) => entry.source === "render-derived",
  );
  const stats = backendMeta.stats;
  const rangesMatch =
    !surfaceRequested || rendered?.min == null || rendered.max == null || !stats
      ? null
      : visualizationDebugRangesEqual(stats.min, rendered.min) &&
        visualizationDebugRangesEqual(stats.max, rendered.max);
  return Object.freeze({ compatible: true, rangesMatch });
}

export function visualizationDebugQuerySupportsFieldMeta(
  query: VisualizationDebugExactFieldQuery,
): boolean {
  return (
    query.view === null &&
    query.phaseRad === null &&
    query.maxSamples === null &&
    (query.geometryScope === null || query.geometryScope === "full")
  );
}

function emptyModel(
  state: VisualizationDebugPanelState,
  target: VisualizationDebugTarget | null,
): VisualizationDebugPanelModel {
  const issues =
    state === "missing-snapshot"
      ? Object.freeze([
          issue(
            "frame-not-committed",
            "warning",
            "render-derived",
            "The active target has no committed viewport snapshot.",
            ["state=missing-snapshot"],
          ),
        ])
      : Object.freeze([]);
  return Object.freeze({
    disposition: "unknown",
    fieldQueries: Object.freeze([]),
    issues,
    state,
    target,
    transport: Object.freeze([]),
    viewports: Object.freeze([]),
  });
}

function latestTerminalTransportByResource(
  diagnostics: readonly RequestDiagnosticEntry[],
): ReadonlyMap<string, RequestDiagnosticEntry> {
  const latest = new Map<string, RequestDiagnosticEntry>();
  for (const entry of diagnostics) {
    const resourceKey = entry.resourceKey ?? null;
    if (!resourceKey || latest.has(resourceKey) || !isTerminalTransport(entry)) {
      continue;
    }
    latest.set(resourceKey, entry);
  }
  return latest;
}

function isTerminalTransport(entry: RequestDiagnosticEntry): boolean {
  if (entry.direction !== "rx") return false;
  if (entry.outcome === "error" || entry.outcome === "network-error") {
    return true;
  }
  if (entry.outcome !== "ok") return false;
  return (
    entry.status === 204 ||
    entry.status === 304 ||
    entry.detail?.startsWith("decoded binary payload") === true
  );
}

function exactDecodedWireByteLength(
  entry: RequestDiagnosticEntry | null,
): number | null {
  return entry?.outcome === "ok" &&
    entry.status !== 204 &&
    entry.status !== 304 &&
    entry.detail === "decoded binary payload"
    ? entry.byteLength
    : null;
}

function buildCompositeHealth({
  state,
  terminalByResource,
  viewports,
}: {
  state: VisualizationDebugPanelState;
  terminalByResource: ReadonlyMap<string, RequestDiagnosticEntry>;
  viewports: readonly VisualizationDebugViewportPanelModel[];
}): {
  disposition: VisualizationDebugDisposition;
  issues: readonly VisualizationDebugIssue[];
} {
  const snapshotIssues = viewports.flatMap((viewport) =>
    viewport.snapshots.flatMap((snapshot) => snapshot.issues),
  );
  const derivedIssues: VisualizationDebugIssue[] = [];
  let panelEvidenceComplete = true;

  if (state === "target-not-rendered") {
    panelEvidenceComplete = false;
    if (!snapshotIssues.some((entry) => entry.code === "target-not-active")) {
      derivedIssues.push(
        issue(
          "target-not-active",
          "warning",
          "ui-derived",
          "Target is not active in the current render model.",
          ["state=target-not-rendered"],
        ),
      );
    }
  }

  for (const [resourceKey, terminal] of terminalByResource) {
    if (terminal.outcome !== "error" && terminal.outcome !== "network-error") {
      continue;
    }
    derivedIssues.push(
      issue(
        "field-request-error",
        "error",
        "transport",
        "The newest completed exact field request failed.",
        [resourceKey, `outcome=${terminal.outcome}`, `request=${terminal.requestId}`],
      ),
    );
  }

  for (const viewport of viewports) {
    for (const carrierGroup of viewport.carriers) {
      for (const observation of carrierGroup.observations) {
        const { backendMeta, backendRenderComparison, carrier, query } = observation;
        if (!backendMeta || !query) {
          panelEvidenceComplete = false;
          if (query && !visualizationDebugQuerySupportsFieldMeta(query)) {
            derivedIssues.push(
              issue(
                "backend-meta-incomparable",
                "info",
                "ui-derived",
                "Exact query shape cannot be compared with base-field backend metadata.",
                [
                  `carrier=${carrier.carrierId}`,
                  `query=${query.key}`,
                  `geometry_scope=${query.geometryScope ?? "full"}`,
                  `max_samples=${query.maxSamples ?? "all"}`,
                  `view=${query.view ?? "none"}`,
                  `phase_rad=${query.phaseRad ?? "none"}`,
                ],
              ),
            );
          } else if (query && !backendMeta) {
            derivedIssues.push(
              issue(
                "backend-meta-incomparable",
                "info",
                "ui-derived",
                "Exact backend metadata is unavailable, so rendered field evidence cannot be compared.",
                [
                  `carrier=${carrier.carrierId}`,
                  `query=${query.key}`,
                  "backend_meta=unavailable",
                ],
              ),
            );
          }
        } else {
          const revision = comparePhysicalFieldRevision(
            carrier.revisions.fieldRevision,
            backendMeta.field_revision,
          );
          if (revision === "render-stale") {
            derivedIssues.push(
              issue(
                "field-revision-stale",
                "warning",
                "render-derived",
                "The rendered physical field revision is older than exact backend metadata.",
                [
                  `render=${carrier.revisions.fieldRevision ?? "unknown"}`,
                  `backend=${String(backendMeta.field_revision)}`,
                ],
              ),
            );
          } else if (revision !== "current") {
            panelEvidenceComplete = false;
          }
        }
        if (backendRenderComparison === null) {
          panelEvidenceComplete = false;
          if (
            backendMeta &&
            query &&
            compareSurfaceComponentEvidence(carrier, query) === "derived"
          ) {
            derivedIssues.push(
              issue(
                "backend-meta-incomparable",
                "info",
                "ui-derived",
                "The rendered surface is a derived projection of the exact full-vector field, so base-field statistics are not directly comparable.",
                [
                  `carrier=${carrier.carrierId}`,
                  `query=${query.key}`,
                  `query_component=${query.component}`,
                  `rendered_component=${carrier.render.surface.colorMode ?? "unknown"}`,
                ],
              ),
            );
          }
        } else if (backendRenderComparison.compatible === false) {
          derivedIssues.push(
            issue(
              "backend-render-incompatible",
              "warning",
              "ui-derived",
              "Exact backend metadata and rendered adoption evidence identify incompatible fields.",
              [
                `carrier=${carrier.carrierId}`,
                `query=${query?.key ?? "unavailable"}`,
              ],
            ),
          );
        }
        if (backendRenderComparison?.rangesMatch === false) {
          derivedIssues.push(
            issue(
              "backend-render-range-mismatch",
              "warning",
              "render-derived",
              "Comparable backend and rendered ranges differ beyond tolerance.",
              [carrier.carrierId],
            ),
          );
        }
        if (
          observation.wireByteLength !== null &&
          carrier.cache.byteLength !== null &&
          observation.wireByteLength !== carrier.cache.byteLength
        ) {
          derivedIssues.push(
            issue(
              "transport-cache-byte-mismatch",
              "info",
              "cache",
              "Exact decoded transport and cache byte counts differ.",
              [
                `wire=${observation.wireByteLength}`,
                `cache=${carrier.cache.byteLength}`,
              ],
            ),
          );
        }
      }
    }
  }

  const allUnbounded = [...snapshotIssues, ...derivedIssues];
  const issues = deduplicateAndBoundIssues(allUnbounded);
  const hasError = allUnbounded.some((entry) => entry.severity === "error");
  const hasDegradingWarning = allUnbounded.some(
    (entry) =>
      entry.severity === "warning" &&
      entry.code !== "target-not-active" &&
      entry.code !== "frame-not-committed",
  );
  const snapshotDisposition = aggregateSnapshotDisposition(
    viewports.flatMap((viewport) => viewport.snapshots),
  );
  const disposition: VisualizationDebugDisposition = hasError
    ? "blocked"
    : hasDegradingWarning || snapshotDisposition === "degraded"
      ? "degraded"
      : !panelEvidenceComplete || snapshotDisposition === "unknown"
        ? "unknown"
        : "ready";
  return Object.freeze({ disposition, issues });
}

function compareSurfaceComponentEvidence(
  carrier: VisualizationDebugCarrierSnapshot,
  query: VisualizationDebugExactFieldQuery,
): VisualizationDebugSurfaceComponentComparison {
  if (!carrier.render.requestedPasses.includes("surface")) {
    return "comparable";
  }
  const renderedComponent = carrier.render.surface.colorMode;
  if (renderedComponent === null) return "missing";
  if (
    fieldVectorComponentsSemanticallyEqual(renderedComponent, query.component)
  ) {
    return "comparable";
  }
  return fieldVectorComponentEvidenceIdentity(query.component) === "full"
    ? "derived"
    : "incompatible";
}

function comparePhysicalFieldRevision(
  rendered: string | null,
  backend: number,
): "current" | "render-newer" | "render-stale" | "unknown" {
  if (!rendered || !/^\d+$/.test(rendered) || !Number.isSafeInteger(backend)) {
    return "unknown";
  }
  const renderedRevision = BigInt(rendered);
  const backendRevision = BigInt(backend);
  if (renderedRevision === backendRevision) return "current";
  return renderedRevision < backendRevision ? "render-stale" : "render-newer";
}

function aggregateSnapshotDisposition(
  snapshots: readonly VisualizationDebugSnapshot[],
): VisualizationDebugDisposition {
  for (const disposition of ["blocked", "degraded", "unknown", "ready"] as const) {
    if (snapshots.some((snapshot) => snapshot.disposition === disposition)) {
      return disposition;
    }
  }
  return "unknown";
}

function deduplicateAndBoundIssues(
  input: readonly VisualizationDebugIssue[],
): readonly VisualizationDebugIssue[] {
  return prioritizeAndBoundVisualizationDebugIssues(
    input,
    MAX_VISUALIZATION_DEBUG_COMPOSITE_ISSUES,
  );
}

function issue(
  code: string,
  severity: VisualizationDebugIssue["severity"],
  source: VisualizationDebugIssue["source"],
  message: string,
  evidence: readonly string[],
): VisualizationDebugIssue {
  return Object.freeze({
    code,
    evidence: Object.freeze([...evidence]),
    message,
    severity,
    source,
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
