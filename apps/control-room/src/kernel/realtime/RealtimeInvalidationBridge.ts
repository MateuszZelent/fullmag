import type { ResourceRevision } from "../api/apiTypes";
import type { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import {
  ANALYSIS_OBJECT_TOPOLOGICAL_CHARGE_PATH,
  ANALYSIS_HYSTERESIS_ADAPTIVE_REFINEMENT_PATH,
  ANALYSIS_HYSTERESIS_BOOKMARKS_PATH,
  ANALYSIS_HYSTERESIS_BRANCHES_PATH,
  ANALYSIS_HYSTERESIS_FAMILY_PATH,
  ANALYSIS_HYSTERESIS_FAMILY_VARIANT_POINTS_PATH,
  ANALYSIS_HYSTERESIS_METRICS_PATH,
  ANALYSIS_HYSTERESIS_MINOR_LOOPS_PATH,
  ANALYSIS_HYSTERESIS_POINT_PATH,
  ANALYSIS_HYSTERESIS_POINTS_PATH,
  ANALYSIS_HYSTERESIS_REVERSAL_FIELDS_PATH,
  ANALYSIS_HYSTERESIS_SATURATION_PATH,
  ANALYSIS_HYSTERESIS_STAGE_SETTLE_TRACE_PATH,
  ANALYSIS_HYSTERESIS_SETTLE_TRACE_PATH,
  DATA_DOMAIN_META_PATH,
  DATA_DOMAIN_TOPOLOGY_PATH,
  DATA_FDM_REGION_MEMBERSHIP_BINARY_PATH,
  DATA_FDM_REGION_MEMBERSHIP_SCOPED_PATH,
  DATA_FDM_REGION_MEMBERSHIPS_PATH,
  DATA_FIELDS_PATH,
  DATA_QUANTITIES_PATH,
  DATA_PLANAR_FIELD_META_PATH,
  DATA_SCALARS_PATH,
  MESHING_BUILDS_CURRENT_PATH,
  MESHING_BUILDS_LATEST_SUCCESSFUL_PATH,
  MESHING_SEMANTICS_PATH,
  MESHING_OBJECT_QUALITY_PATH,
  MESHING_OBJECT_REPORT_PATH,
  MESHING_OBJECT_SIZE_FIELD_PATH,
  MESHING_OBJECT_TOPOLOGY_PATH,
  MESHING_PERIODIC_PAIRS_PATH,
  MESHING_SHARED_DOMAIN_MANIFEST_PATH,
  MESHING_SHARED_DOMAIN_QUALITY_PATH,
  MESHING_SHARED_DOMAIN_QUALITY_DATA_PATH,
  MESHING_SHARED_DOMAIN_REALIZED_SIZE_FIELDS_PATH,
  MESHING_SUMMARY_PATH,
  MODEL_MATERIAL_FIELDS_PATH,
  MODEL_MAGNETIZATION_ASSET_PATH,
  MODEL_MATERIAL_PATH,
  MODEL_OBJECT_GEOMETRY_PATH,
  MODEL_OBJECT_INTERACTION_PATH,
  MODEL_READINESS_PATH,
  MODEL_REALIZED_REGIONS_PATH,
  MODEL_REGION_DIAGNOSTICS_PATH,
  MODEL_REGIONS_PATH,
  MODEL_SCENE_PATH,
  MODEL_STUDY_PATH,
  SESSION_CURRENT_PATH,
  SIMULATION_COMMANDS_PATH,
  SIMULATION_OBJECT_METRICS_PATH,
  SIMULATION_SOLVER_STATUS_PATH,
  SIMULATION_STAGE_HYSTERESIS_EXECUTION_TREE_PATH,
  SIMULATION_STAGE_HYSTERESIS_ORIENTATION_PATH,
  SIMULATION_STAGE_HYSTERESIS_PLAN_PATH,
  SIMULATION_STAGE_HYSTERESIS_PROGRESS_PATH,
  SIMULATION_STAGE_HYSTERESIS_PROTOCOL_PATH,
  SIMULATION_STAGE_HYSTERESIS_SATURATION_PATH,
  SIMULATION_STAGE_HYSTERESIS_SETTLE_PIPELINE_PATH,
  SIMULATION_STAGES_EXECUTION_PATH,
  VISUALIZATION_STATE_PATH,
} from "../api/apiPaths";
import { resolveCanonicalQuantityId } from "../api/quantityIds";
import {
  type CanonicalFieldVectorQuery,
  canonicalFieldVectorQueriesEqual,
  parseCanonicalFieldVectorResourceKey,
} from "../api/fieldQueryIdentity";
import type { ResourceInvalidationController } from "../resources/ResourceInvalidationController";
import { canonicalFrequencyDomainResourceKey } from "../resources/frequencyDomainResourceKeys";
import { PHYSICS_GRAPH_RESOURCE_KEY } from "../resources/physicsGraphResources";

const SESSION_STATUS_RESOURCE_KEY = "session:status";
const PLANAR_FIELD_RESOURCE_PREFIX = DATA_PLANAR_FIELD_META_PATH.slice(
  0,
  DATA_PLANAR_FIELD_META_PATH.indexOf("{quantity_id}"),
);
const PLANAR_MONITOR_SEGMENT = "/planar-monitors/";
const FDM_REGION_MEMBERSHIP_SCOPED_PREFIX =
  DATA_FDM_REGION_MEMBERSHIP_SCOPED_PATH.slice(
    0,
    DATA_FDM_REGION_MEMBERSHIP_SCOPED_PATH.indexOf("{region_id}"),
  );

interface RealtimeResourceEvent {
  artifact_path?: string;
  content_digest?: ResourceRevision;
  resource_key?: string;
  revision?: ResourceRevision;
  seq?: ResourceRevision;
  session_id?: string;
  type: string;
}

interface RealtimeBatchChange {
  artifact_path?: string;
  broad?: boolean;
  content_digest?: ResourceRevision;
  domain_generation_id?: string | null;
  quantity_ids?: string[];
  resource?: string;
  resource_id?: string;
  resource_key?: string;
  recommended_fetch?: string;
  revision: ResourceRevision;
}

interface RealtimeBatchChangedEvent {
  payload?: {
    changes?: unknown[];
  };
  seq?: ResourceRevision;
  session_id?: string;
  type: string;
}

interface RealtimeResyncRequiredEvent {
  payload?: {
    replay_available_after_seq?: unknown;
  };
  seq?: ResourceRevision;
  session_id?: string;
  type: string;
}

interface RealtimeScalarSampleEvent {
  payload: {
    revision: ResourceRevision;
    row: Record<string, number>;
  };
  run_id?: string | null;
  session_id: string;
  type: string;
}

interface RealtimeInvalidationBridgeOptions {
  bus?: EventBus<KernelEventMap>;
  scheduleFlush?: (callback: () => void) => () => void;
  shouldSuppressInvalidation?: (
    resourceKey: string,
    revision: ResourceRevision,
  ) => boolean;
}

export interface FieldInvalidationTelemetry {
  broadInvalidations: number;
  exactInvalidations: number;
  invalidatedResourceKeys: number;
}

function boundedIncrement(value: number, amount = 1): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value + amount);
}

function isRealtimeResourceEvent(event: unknown): event is RealtimeResourceEvent {
  if (!event || typeof event !== "object") {
    return false;
  }

  const record = event as Record<string, unknown>;
  return typeof record.type === "string";
}

function isRealtimeBatchChangedEvent(
  event: unknown,
): event is RealtimeBatchChangedEvent {
  if (!event || typeof event !== "object") {
    return false;
  }

  const record = event as Record<string, unknown>;
  return record.type === "resource.batch_changed";
}

function isRealtimeResyncRequiredEvent(
  event: unknown,
): event is RealtimeResyncRequiredEvent {
  if (!event || typeof event !== "object") {
    return false;
  }

  const record = event as Record<string, unknown>;
  return record.type === "resync.required";
}

function isRealtimeScalarSampleEvent(
  event: unknown,
): event is RealtimeScalarSampleEvent {
  if (!event || typeof event !== "object") {
    return false;
  }

  const record = event as Record<string, unknown>;
  const payload =
    record.payload && typeof record.payload === "object"
      ? (record.payload as Record<string, unknown>)
      : null;
  const row =
    payload?.row && typeof payload.row === "object"
      ? (payload.row as Record<string, unknown>)
      : null;
  const revision = payload?.revision;
  return (
    record.type === "scalar.sample" &&
    typeof record.session_id === "string" &&
    (typeof revision === "number" || typeof revision === "string") &&
    row !== null &&
    typeof row.step === "number" &&
    typeof row.time === "number"
  );
}

function scalarSampleRow(row: Record<string, unknown>): Record<string, number> {
  const numericRow: Record<string, number> = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      numericRow[key] = value;
    }
  }
  return numericRow;
}

function realtimeBatchChange(change: unknown): RealtimeBatchChange | null {
  if (!change || typeof change !== "object") {
    return null;
  }

  const record = change as Record<string, unknown>;
  const contentDigest = realtimeRevision(record.content_digest);
  const revision = contentDigest ?? record.revision;
  if (typeof revision !== "number" && typeof revision !== "string") {
    return null;
  }

  const resourceKey = canonicalFrequencyDomainResourceKey(
    typeof record.resource_key === "string"
      ? record.resource_key
      : typeof record.artifact_path === "string"
        ? record.artifact_path
        : undefined,
  );
  const recommendedFetch = canonicalFrequencyDomainResourceKey(
    typeof record.recommended_fetch === "string"
      ? record.recommended_fetch
      : undefined,
  );

  return {
    artifact_path:
      typeof record.artifact_path === "string"
        ? record.artifact_path
        : undefined,
    broad: record.broad === true,
    content_digest: contentDigest ?? undefined,
    domain_generation_id: realtimeDomainGenerationId(record.domain_generation_id),
    quantity_ids: Array.isArray(record.quantity_ids)
      ? record.quantity_ids.filter((value): value is string => typeof value === "string")
      : undefined,
    resource: typeof record.resource === "string" ? record.resource : undefined,
    resource_id:
      typeof record.resource_id === "string" ? record.resource_id : undefined,
    resource_key:
      resourceKey ??
      (typeof record.resource_key === "string"
        ? record.resource_key
        : undefined),
    recommended_fetch:
      recommendedFetch ??
      (typeof record.recommended_fetch === "string"
        ? record.recommended_fetch
        : undefined),
    revision,
  };
}

function realtimeRevision(value: unknown): ResourceRevision | null {
  return typeof value === "number" || typeof value === "string" ? value : null;
}

function realtimeDomainGenerationId(value: unknown): string | null {
  if (typeof value === "string") return value;
  return typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : null;
}

function fieldSamplesInvalidationRevision(change: RealtimeBatchChange): ResourceRevision {
  return change.domain_generation_id === null || change.domain_generation_id === undefined
    ? change.revision
    : `generation:${change.domain_generation_id}:revision:${change.revision}`;
}

function exactFieldQueriesFromResourceKey(
  resourceKey: string,
): CanonicalFieldVectorQuery[] {
  return resourceKey
    .split("|")
    .flatMap((segment) => {
      const fieldPathIndex = segment.indexOf(`${DATA_FIELDS_PATH}/`);
      if (fieldPathIndex < 0) return [];
      const query = parseCanonicalFieldVectorResourceKey(
        segment.slice(fieldPathIndex),
      );
      return query ? [query] : [];
    });
}

function resourceFamilyPrefix(pathWithObjectId: string): string {
  const idx = pathWithObjectId.indexOf("{object_id}");
  if (idx === -1 && process.env.NODE_ENV !== "production") {
    throw new Error(
      `resourceFamilyPrefix: missing {object_id} in "${pathWithObjectId}"`,
    );
  }
  return pathWithObjectId.slice(0, idx);
}

const stageScopedRegexCache = new Map<string, RegExp>();

function stageScopedRegex(pathTemplate: string): RegExp {
  let cached = stageScopedRegexCache.get(pathTemplate);
  if (!cached) {
    cached = new RegExp(
      `^${escapeResourcePathTemplate(pathTemplate)}(?:[:?]|$)`,
    );
    stageScopedRegexCache.set(pathTemplate, cached);
  }
  return cached;
}

function matchesStageScopedResource(resourceKey: string, pathWithStageId: string): boolean {
  return stageScopedRegex(pathWithStageId).test(resourceKey);
}

function concreteStageIdFromResourceKey(
  resourceKey: string,
  pathWithStageId: string,
): string | null {
  const [prefix, suffix] = pathWithStageId.split("{stage_id}");
  if (prefix === undefined || suffix === undefined) return null;
  if (!resourceKey.startsWith(prefix)) return null;
  const rest = resourceKey.slice(prefix.length);
  const suffixIndex = rest.indexOf(suffix);
  if (suffixIndex < 0) return null;
  return rest.slice(0, suffixIndex);
}

function matchesConcreteStageScopedResource(
  resourceKey: string,
  pathWithStageId: string,
  stageId: string,
): boolean {
  const stagePathTemplate = pathWithStageId.replace("{stage_id}", stageId);
  return stageScopedRegex(stagePathTemplate).test(resourceKey);
}

function escapeResourcePathTemplate(pathTemplate: string): string {
  return pathTemplate
    .split(/(\{[^}]+\})/g)
    .map((part) =>
      part.startsWith("{") && part.endsWith("}")
        ? "[^/:?]+"
        : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
}

const SESSION_STATUS_RECOMMENDED_FETCHES = new Set<string>([
  MODEL_SCENE_PATH,
  SIMULATION_SOLVER_STATUS_PATH,
  SIMULATION_STAGES_EXECUTION_PATH,
]);

const MODEL_READINESS_DEPENDENCY_PATHS = [
  MODEL_STUDY_PATH,
  MODEL_MATERIAL_PATH,
  MODEL_MAGNETIZATION_ASSET_PATH,
  MODEL_OBJECT_GEOMETRY_PATH,
  MODEL_OBJECT_INTERACTION_PATH,
  MESHING_BUILDS_CURRENT_PATH,
] as const;

function isModelReadinessDependency(resourceKey: string): boolean {
  return MODEL_READINESS_DEPENDENCY_PATHS.some((pathTemplate) =>
    stageScopedRegex(pathTemplate).test(resourceKey),
  );
}

function shouldInvalidateSessionStatus(recommendedFetch?: string): boolean {
  return (
    recommendedFetch !== undefined &&
    SESSION_STATUS_RECOMMENDED_FETCHES.has(recommendedFetch)
  );
}

function latestRevision(
  current: ResourceRevision | null,
  next: ResourceRevision,
): ResourceRevision {
  if (typeof current === "number" && typeof next === "number") {
    return Math.max(current, next);
  }
  return next;
}

function dependentResourceRevision(
  sourceResourceKey: string,
  revision: ResourceRevision,
): ResourceRevision {
  return typeof revision === "number"
    ? `dependent:${sourceResourceKey}:${revision}`
    : revision;
}

function defaultScheduleFlush(callback: () => void): () => void {
  if (
    typeof window !== "undefined" &&
    typeof window.requestAnimationFrame === "function"
  ) {
    const frameId = window.requestAnimationFrame(callback);
    return () => window.cancelAnimationFrame(frameId);
  }

  callback();
  return () => {};
}

export class RealtimeInvalidationBridge {
  private currentRunId: string | null = null;
  private currentSessionId: string | null = null;
  private flushCancel: (() => void) | null = null;
  private pendingExactFetches = new Set<string>();
  private pendingFetches = new Map<string, ResourceRevision>();
  private pendingMatchers: Array<{
    fieldInvalidation?: "broad" | "exact";
    predicate: (resourceKey: string) => boolean;
    revision: ResourceRevision;
  }> = [];
  private pendingPrefixes = new Map<
    string,
    { fieldInvalidation?: "broad" | "exact"; revision: ResourceRevision }
  >();
  private pendingStatusRevision: ResourceRevision | null = null;
  private fieldInvalidationTelemetry: FieldInvalidationTelemetry = {
    broadInvalidations: 0,
    exactInvalidations: 0,
    invalidatedResourceKeys: 0,
  };

  constructor(
    private readonly resources: ResourceInvalidationController,
    private readonly options: RealtimeInvalidationBridgeOptions = {},
  ) {}

  getFieldInvalidationTelemetry(): FieldInvalidationTelemetry {
    return { ...this.fieldInvalidationTelemetry };
  }

  handleEvent(event: unknown): boolean {
    const sessionHandled = this.handleSessionEnvelope(event);

    if (isRealtimeResyncRequiredEvent(event)) {
      const replayAfter = event.payload?.replay_available_after_seq;
      if (!sessionHandled) {
        this.resources.invalidate(
          SESSION_STATUS_RESOURCE_KEY,
          typeof replayAfter === "number" ? replayAfter : Date.now(),
        );
      }
      return true;
    }

    if (isRealtimeScalarSampleEvent(event)) {
      const row = scalarSampleRow(event.payload.row);
      this.options.bus?.emit("telemetry:scalar-sample", {
        revision: event.payload.revision,
        row,
        runId: event.run_id ?? null,
        sessionId: event.session_id,
        step: row.step,
        time: row.time,
      });
      return true;
    }

    if (isRealtimeBatchChangedEvent(event)) {
      const changes = event.payload?.changes ?? [];
      let handled = false;
      let statusRevision: ResourceRevision | null = null;

      for (const rawChange of changes) {
        const change = realtimeBatchChange(rawChange);
        if (!change) {
          continue;
        }
        const recommendedFetch = change.recommended_fetch ?? change.resource_key;
        const fieldSampleChange =
          change.resource === "fields" && change.resource_id === "samples";
        const planarFieldChange = change.resource === "planar_fields";
        const scalarChange = change.resource === "scalars";

        if (scalarChange) {
          this.queuePrefixInvalidation(DATA_SCALARS_PATH, change.revision);
          this.queuePrefixInvalidation(
            resourceFamilyPrefix(SIMULATION_OBJECT_METRICS_PATH),
            dependentResourceRevision(
              recommendedFetch ?? "scalars",
              change.revision,
            ),
          );
        }

        if (recommendedFetch && shouldInvalidateSessionStatus(recommendedFetch)) {
          statusRevision = latestRevision(
            statusRevision,
            dependentResourceRevision(recommendedFetch, change.revision),
          );
        }
        if (planarFieldChange) {
          const revision = fieldSamplesInvalidationRevision(change);
          this.queueMatchingInvalidation((resourceKey) => {
            if (
              !resourceKey.includes(PLANAR_FIELD_RESOURCE_PREFIX) ||
              !resourceKey.includes(PLANAR_MONITOR_SEGMENT)
            ) {
              return false;
            }
            return (
              !change.quantity_ids?.length ||
              change.quantity_ids.some((quantityId) =>
                resourceKey.includes(
                  `${PLANAR_FIELD_RESOURCE_PREFIX}${quantityId}${PLANAR_MONITOR_SEGMENT}`,
                ),
              )
            );
          }, revision);
        } else if (fieldSampleChange) {
          const fieldSampleRevision = fieldSamplesInvalidationRevision(change);
          const exactFieldResource = change.recommended_fetch
            ? parseCanonicalFieldVectorResourceKey(change.recommended_fetch)
            : null;
          if (exactFieldResource) {
            this.recordFieldInvalidation("exact");
            this.queueExactFieldSampleInvalidation(
              exactFieldResource,
              fieldSampleRevision,
            );
            if (exactFieldResource.quantityId === "m") {
              this.queueMagnetizationFieldDependents(fieldSampleRevision);
            }
          } else if (change.broad || !change.quantity_ids?.length) {
            this.recordFieldInvalidation("broad");
            this.queuePrefixInvalidation(
              DATA_FIELDS_PATH,
              fieldSampleRevision,
              "broad",
            );
            if (
              !change.quantity_ids?.length ||
              change.quantity_ids.some(
                (quantityId) => resolveCanonicalQuantityId(quantityId) === "m",
              )
            ) {
              this.queueMagnetizationFieldDependents(fieldSampleRevision);
            }
          } else {
            this.recordFieldInvalidation("broad");
            for (const quantityId of change.quantity_ids) {
              this.queueFieldSampleQuantityInvalidation(
                quantityId,
                fieldSampleRevision,
              );
            }
          }
        } else if (recommendedFetch) {
          if (
            recommendedFetch === DATA_FIELDS_PATH &&
            change.resource === "fields" &&
            change.resource_id === "catalog"
          ) {
            this.queueExactResourceInvalidation(DATA_FIELDS_PATH, change.revision);
            this.queueExactResourceInvalidation(
              DATA_QUANTITIES_PATH,
              change.revision,
            );
          } else if (
            change.resource === "diagnostics" &&
            (change.resource_id === "cpu" || change.resource_id === "gpu")
          ) {
            this.queueExactResourceInvalidation(
              recommendedFetch,
              change.revision,
            );
          } else {
            this.queueResourceInvalidation(recommendedFetch, change.revision);
          }
        }
        handled = true;
      }

      if (statusRevision !== null) {
        this.pendingStatusRevision = latestRevision(
          this.pendingStatusRevision,
          statusRevision,
        );
      }

      if (handled) {
        this.scheduleFlush();
      }
      return handled || sessionHandled;
    }

    if (!isRealtimeResourceEvent(event)) {
      return sessionHandled;
    }

    if (event.type !== "resource.updated") {
      return sessionHandled;
    }

    const resourceKey =
      canonicalFrequencyDomainResourceKey(
        event.resource_key ?? event.artifact_path,
      ) ??
      event.resource_key;
    const revision = event.content_digest ?? event.revision;
    if (!resourceKey || revision === undefined) {
      return sessionHandled;
    }

    this.invalidateResource(resourceKey, revision);
    return true;
  }

  private handleSessionEnvelope(event: unknown): boolean {
    if (!event || typeof event !== "object") return false;

    const record = event as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    const sessionId =
      typeof record.session_id === "string" && record.session_id.length > 0
        ? record.session_id
        : null;
    if (!sessionId) return false;

    const tracksRunIdentity =
      type === "hello" ||
      type === "resource.batch_changed" ||
      type === "resync.required";
    const runId =
      tracksRunIdentity &&
      typeof record.run_id === "string" &&
      record.run_id.length > 0
        ? record.run_id
        : null;
    const sessionChanged =
      this.currentSessionId !== null && this.currentSessionId !== sessionId;
    const runChanged =
      tracksRunIdentity &&
      this.currentSessionId !== null &&
      !sessionChanged &&
      this.currentRunId !== runId;
    const shouldResync =
      type === "hello" ||
      type === "resync.required" ||
      sessionChanged ||
      runChanged;
    this.currentSessionId = sessionId;
    if (tracksRunIdentity || sessionChanged) {
      this.currentRunId = runId;
    }
    if (!shouldResync) return false;

    const seq = record.seq;
    const revision =
      typeof seq === "number" || typeof seq === "string"
        ? `session:${sessionId}:${seq}`
        : `session:${sessionId}:${Date.now()}`;
    this.invalidateSessionScope(revision);
    return true;
  }

  private invalidateSessionScope(revision: ResourceRevision): void {
    this.resources.invalidate(SESSION_STATUS_RESOURCE_KEY, revision);
    this.resources.invalidatePrefix(SESSION_CURRENT_PATH, revision);
  }

  private queueResourceInvalidation(
    resourceKey: string,
    revision: ResourceRevision,
  ): void {
    this.pendingFetches.set(
      resourceKey,
      latestRevision(this.pendingFetches.get(resourceKey) ?? null, revision),
    );
  }

  private queueExactResourceInvalidation(
    resourceKey: string,
    revision: ResourceRevision,
  ): void {
    this.pendingExactFetches.add(resourceKey);
    this.queueResourceInvalidation(resourceKey, revision);
  }

  private recordFieldInvalidation(kind: "broad" | "exact"): void {
    this.fieldInvalidationTelemetry = {
      broadInvalidations:
        kind === "broad"
          ? boundedIncrement(this.fieldInvalidationTelemetry.broadInvalidations)
          : this.fieldInvalidationTelemetry.broadInvalidations,
      exactInvalidations:
        kind === "exact"
          ? boundedIncrement(this.fieldInvalidationTelemetry.exactInvalidations)
          : this.fieldInvalidationTelemetry.exactInvalidations,
      invalidatedResourceKeys: this.fieldInvalidationTelemetry.invalidatedResourceKeys,
    };
  }

  private queuePrefixInvalidation(
    resourceKey: string,
    revision: ResourceRevision,
    fieldInvalidation?: "broad" | "exact",
  ): void {
    const pending = this.pendingPrefixes.get(resourceKey);
    this.pendingPrefixes.set(resourceKey, {
      fieldInvalidation: pending?.fieldInvalidation ?? fieldInvalidation,
      revision: latestRevision(pending?.revision ?? null, revision),
    });
  }

  private queueFieldSampleQuantityInvalidation(
    quantityId: string,
    revision: ResourceRevision,
  ): void {
    const canonicalQuantityId = resolveCanonicalQuantityId(quantityId);
    const quantityPrefix = `${DATA_FIELDS_PATH}/${encodeURIComponent(canonicalQuantityId)}/`;
    this.queueMatchingInvalidation(
      (resourceKey) => resourceKey.includes(quantityPrefix),
      revision,
      "broad",
    );
    if (canonicalQuantityId === "m") {
      this.queueMagnetizationFieldDependents(revision);
    }
  }

  private queueMagnetizationFieldDependents(revision: ResourceRevision): void {
    this.queuePrefixInvalidation(
      resourceFamilyPrefix(ANALYSIS_OBJECT_TOPOLOGICAL_CHARGE_PATH),
      revision,
    );
  }

  private queueExactFieldSampleInvalidation(
    fieldQuery: CanonicalFieldVectorQuery,
    revision: ResourceRevision,
  ): void {
    this.queueMatchingInvalidation((subscribedKey) => {
      return exactFieldQueriesFromResourceKey(subscribedKey).some((candidate) =>
        canonicalFieldVectorQueriesEqual(candidate, fieldQuery),
      );
    }, revision, "exact");
  }

  private queueMatchingInvalidation(
    predicate: (resourceKey: string) => boolean,
    revision: ResourceRevision,
    fieldInvalidation?: "broad" | "exact",
  ): void {
    this.pendingMatchers.push({ fieldInvalidation, predicate, revision });
  }

  private scheduleFlush(): void {
    if (this.flushCancel) return;
    const scheduleFlush = this.options.scheduleFlush ?? defaultScheduleFlush;
    let didFlush = false;
    const cancel = scheduleFlush(() => {
      didFlush = true;
      this.flushCancel = null;
      this.flushPendingInvalidations();
    });
    this.flushCancel = didFlush ? null : cancel;
  }

  private flushPendingInvalidations(): void {
    const pendingExactFetches = this.pendingExactFetches;
    const pendingFetches = this.pendingFetches;
    const pendingPrefixes = this.pendingPrefixes;
    const pendingMatchers = this.pendingMatchers;
    let statusRevision = this.pendingStatusRevision;
    this.pendingExactFetches = new Set<string>();
    this.pendingFetches = new Map<string, ResourceRevision>();
    this.pendingPrefixes = new Map();
    this.pendingMatchers = [];
    this.pendingStatusRevision = null;

    for (const [resourceKey, revision] of pendingFetches) {
      this.invalidateResource(resourceKey, revision);
      if (!pendingExactFetches.has(resourceKey)) {
        this.resources.invalidatePrefix(resourceKey, revision);
      }
      this.invalidateSceneDocumentDependents(resourceKey, revision);
      this.invalidateMeshBuildCompletionDependents(resourceKey, revision);
      this.invalidateModelReadinessDependent(resourceKey, revision);
      this.invalidateFdmMembershipDependents(resourceKey, revision);
      this.invalidateHysteresisAnalysisDependents(resourceKey, revision);
      const dependentStatusRevision =
        this.invalidateRuntimeLifecycleDependents(resourceKey, revision);
      if (dependentStatusRevision !== null && statusRevision === null) {
        statusRevision = latestRevision(statusRevision, dependentStatusRevision);
      }
    }
    for (const [resourceKey, pending] of pendingPrefixes) {
      const invalidated = this.resources.invalidatePrefix(
        resourceKey,
        pending.revision,
      );
      if (pending.fieldInvalidation) {
        this.fieldInvalidationTelemetry = {
          ...this.fieldInvalidationTelemetry,
          invalidatedResourceKeys: boundedIncrement(
            this.fieldInvalidationTelemetry.invalidatedResourceKeys,
            invalidated,
          ),
        };
      }
    }
    for (const matcher of pendingMatchers) {
      const invalidated = this.resources.invalidateMatching(
        matcher.predicate,
        matcher.revision,
      );
      if (matcher.fieldInvalidation) {
        this.fieldInvalidationTelemetry = {
          ...this.fieldInvalidationTelemetry,
          invalidatedResourceKeys: boundedIncrement(
            this.fieldInvalidationTelemetry.invalidatedResourceKeys,
            invalidated,
          ),
        };
      }
    }

    if (statusRevision !== null) {
      this.resources.invalidate(SESSION_STATUS_RESOURCE_KEY, statusRevision);
    }
  }

  private invalidateResource(
    resourceKey: string,
    revision: ResourceRevision,
  ): void {
    if (this.options.shouldSuppressInvalidation?.(resourceKey, revision)) {
      return;
    }
    this.resources.invalidate(resourceKey, revision);
  }

  private invalidateMeshBuildCompletionDependents(
    recommendedFetch: string,
    revision: ResourceRevision,
  ): void {
    if (recommendedFetch !== MESHING_BUILDS_LATEST_SUCCESSFUL_PATH) return;

    this.resources.invalidate(MODEL_SCENE_PATH, revision);
    this.resources.invalidate(MODEL_READINESS_PATH, revision);
    this.resources.invalidate(MESHING_BUILDS_CURRENT_PATH, revision);
    this.resources.invalidate(MESHING_SUMMARY_PATH, revision);
    this.resources.invalidate(MESHING_SEMANTICS_PATH, revision);
    this.resources.invalidate(MESHING_SHARED_DOMAIN_MANIFEST_PATH, revision);
    this.resources.invalidate(MESHING_PERIODIC_PAIRS_PATH, revision);
    this.resources.invalidate(VISUALIZATION_STATE_PATH, revision);
    this.resources.invalidate(DATA_DOMAIN_META_PATH, revision);
    this.resources.invalidate(DATA_DOMAIN_TOPOLOGY_PATH, revision);
    this.resources.invalidate(DATA_FDM_REGION_MEMBERSHIPS_PATH, revision);
    this.resources.invalidate(
      DATA_FDM_REGION_MEMBERSHIP_BINARY_PATH,
      revision,
    );
    this.resources.invalidatePrefix(
      FDM_REGION_MEMBERSHIP_SCOPED_PREFIX,
      revision,
    );
    this.resources.invalidate(MESHING_SHARED_DOMAIN_QUALITY_PATH, revision);
    this.resources.invalidate(MESHING_SHARED_DOMAIN_QUALITY_DATA_PATH, revision);
    this.resources.invalidate(
      MESHING_SHARED_DOMAIN_REALIZED_SIZE_FIELDS_PATH,
      revision,
    );
    this.resources.invalidatePrefix(
      resourceFamilyPrefix(MESHING_OBJECT_TOPOLOGY_PATH),
      revision,
    );
    this.resources.invalidatePrefix(
      resourceFamilyPrefix(MESHING_OBJECT_REPORT_PATH),
      revision,
    );
    this.resources.invalidatePrefix(
      resourceFamilyPrefix(MESHING_OBJECT_QUALITY_PATH),
      revision,
    );
    this.resources.invalidatePrefix(
      resourceFamilyPrefix(MESHING_OBJECT_SIZE_FIELD_PATH),
      revision,
    );
    this.resources.invalidatePrefix(
      resourceFamilyPrefix(ANALYSIS_OBJECT_TOPOLOGICAL_CHARGE_PATH),
      revision,
    );
  }

  private invalidateFdmMembershipDependents(
    recommendedFetch: string,
    revision: ResourceRevision,
  ): void {
    if (recommendedFetch !== DATA_FDM_REGION_MEMBERSHIPS_PATH) return;

    this.resources.invalidate(
      DATA_FDM_REGION_MEMBERSHIP_BINARY_PATH,
      revision,
    );
    this.resources.invalidatePrefix(
      FDM_REGION_MEMBERSHIP_SCOPED_PREFIX,
      revision,
    );
  }

  private invalidateSceneDocumentDependents(
    recommendedFetch: string,
    revision: ResourceRevision,
  ): void {
    if (recommendedFetch !== MODEL_SCENE_PATH) return;
    const dependentRevision = dependentResourceRevision(MODEL_SCENE_PATH, revision);
    this.resources.invalidate(PHYSICS_GRAPH_RESOURCE_KEY, dependentRevision);
    this.resources.invalidate(MODEL_REGIONS_PATH, dependentRevision);
    this.resources.invalidate(MODEL_REALIZED_REGIONS_PATH, dependentRevision);
    this.resources.invalidate(MODEL_REGION_DIAGNOSTICS_PATH, dependentRevision);
    this.resources.invalidate(MODEL_MATERIAL_FIELDS_PATH, dependentRevision);
    this.resources.invalidate(MODEL_READINESS_PATH, dependentRevision);
    this.resources.invalidateMatching(
      (resourceKey) =>
        matchesStageScopedResource(
          resourceKey,
          SIMULATION_STAGE_HYSTERESIS_PLAN_PATH,
        ) ||
        matchesStageScopedResource(
          resourceKey,
          SIMULATION_STAGE_HYSTERESIS_PROTOCOL_PATH,
        ) ||
        matchesStageScopedResource(
          resourceKey,
          SIMULATION_STAGE_HYSTERESIS_SATURATION_PATH,
        ) ||
        matchesStageScopedResource(
          resourceKey,
          SIMULATION_STAGE_HYSTERESIS_ORIENTATION_PATH,
        ) ||
        matchesStageScopedResource(
          resourceKey,
          SIMULATION_STAGE_HYSTERESIS_SETTLE_PIPELINE_PATH,
        ) ||
        matchesStageScopedResource(
          resourceKey,
          SIMULATION_STAGE_HYSTERESIS_EXECUTION_TREE_PATH,
        ),
      dependentRevision,
    );
  }

  private invalidateModelReadinessDependent(
    recommendedFetch: string,
    revision: ResourceRevision,
  ): void {
    if (!isModelReadinessDependency(recommendedFetch)) return;
    this.resources.invalidate(
      MODEL_READINESS_PATH,
      dependentResourceRevision(recommendedFetch, revision),
    );
  }

  private invalidateRuntimeLifecycleDependents(
    recommendedFetch: string,
    revision: ResourceRevision,
  ): ResourceRevision | null {
    const dependentRevision = dependentResourceRevision(
      recommendedFetch,
      revision,
    );
    if (recommendedFetch === SIMULATION_COMMANDS_PATH) {
      this.resources.invalidate(SIMULATION_SOLVER_STATUS_PATH, dependentRevision);
      this.resources.invalidate(SIMULATION_STAGES_EXECUTION_PATH, dependentRevision);
      return dependentRevision;
    }

    if (recommendedFetch === SIMULATION_STAGES_EXECUTION_PATH) {
      this.resources.invalidate(SIMULATION_SOLVER_STATUS_PATH, dependentRevision);
      this.resources.invalidate(SIMULATION_COMMANDS_PATH, dependentRevision);
      this.resources.invalidateMatching(
        (resourceKey) =>
          matchesStageScopedResource(
            resourceKey,
            SIMULATION_STAGE_HYSTERESIS_PROGRESS_PATH,
          ) ||
          matchesStageScopedResource(
            resourceKey,
            SIMULATION_STAGE_HYSTERESIS_EXECUTION_TREE_PATH,
          ) ||
          matchesStageScopedResource(
            resourceKey,
            ANALYSIS_HYSTERESIS_POINTS_PATH,
          ) ||
          matchesStageScopedResource(
            resourceKey,
            ANALYSIS_HYSTERESIS_POINT_PATH,
          ) ||
          matchesStageScopedResource(
            resourceKey,
            ANALYSIS_HYSTERESIS_STAGE_SETTLE_TRACE_PATH,
          ) ||
          matchesStageScopedResource(
            resourceKey,
            ANALYSIS_HYSTERESIS_SETTLE_TRACE_PATH,
          ) ||
          matchesStageScopedResource(
            resourceKey,
            ANALYSIS_HYSTERESIS_METRICS_PATH,
          ) ||
          matchesStageScopedResource(
            resourceKey,
            ANALYSIS_HYSTERESIS_SATURATION_PATH,
          ) ||
          matchesStageScopedResource(
            resourceKey,
            ANALYSIS_HYSTERESIS_ADAPTIVE_REFINEMENT_PATH,
          ) ||
          matchesStageScopedResource(
            resourceKey,
            ANALYSIS_HYSTERESIS_BOOKMARKS_PATH,
          ) ||
          matchesStageScopedResource(
            resourceKey,
            ANALYSIS_HYSTERESIS_FAMILY_PATH,
          ) ||
          matchesStageScopedResource(
            resourceKey,
            ANALYSIS_HYSTERESIS_FAMILY_VARIANT_POINTS_PATH,
          ) ||
          matchesStageScopedResource(
            resourceKey,
            ANALYSIS_HYSTERESIS_BRANCHES_PATH,
          ) ||
          matchesStageScopedResource(
            resourceKey,
            ANALYSIS_HYSTERESIS_MINOR_LOOPS_PATH,
          ) ||
          matchesStageScopedResource(
            resourceKey,
            ANALYSIS_HYSTERESIS_REVERSAL_FIELDS_PATH,
          ),
        dependentRevision,
      );
      return null;
    }

    if (recommendedFetch === SIMULATION_SOLVER_STATUS_PATH) {
      this.resources.invalidate(SIMULATION_COMMANDS_PATH, dependentRevision);
      return null;
    }

    return null;
  }

  private invalidateHysteresisAnalysisDependents(
    recommendedFetch: string,
    revision: ResourceRevision,
  ): void {
    const stageId = concreteStageIdFromResourceKey(
      recommendedFetch,
      ANALYSIS_HYSTERESIS_POINTS_PATH,
    );
    if (!stageId) return;
    const dependentRevision = dependentResourceRevision(
      recommendedFetch,
      revision,
    );
    this.resources.invalidateMatching(
      (resourceKey) =>
        matchesConcreteStageScopedResource(
          resourceKey,
          ANALYSIS_HYSTERESIS_METRICS_PATH,
          stageId,
        ) ||
        matchesConcreteStageScopedResource(
          resourceKey,
          ANALYSIS_HYSTERESIS_SATURATION_PATH,
          stageId,
        ) ||
        matchesConcreteStageScopedResource(
          resourceKey,
          ANALYSIS_HYSTERESIS_ADAPTIVE_REFINEMENT_PATH,
          stageId,
        ) ||
        matchesConcreteStageScopedResource(
          resourceKey,
          ANALYSIS_HYSTERESIS_BOOKMARKS_PATH,
          stageId,
        ) ||
        matchesConcreteStageScopedResource(
          resourceKey,
          ANALYSIS_HYSTERESIS_FAMILY_PATH,
          stageId,
        ) ||
        matchesConcreteStageScopedResource(
          resourceKey,
          ANALYSIS_HYSTERESIS_FAMILY_VARIANT_POINTS_PATH,
          stageId,
        ) ||
        matchesConcreteStageScopedResource(
          resourceKey,
          ANALYSIS_HYSTERESIS_BRANCHES_PATH,
          stageId,
        ) ||
        matchesConcreteStageScopedResource(
          resourceKey,
          ANALYSIS_HYSTERESIS_MINOR_LOOPS_PATH,
          stageId,
        ) ||
        matchesConcreteStageScopedResource(
          resourceKey,
          ANALYSIS_HYSTERESIS_REVERSAL_FIELDS_PATH,
          stageId,
        ) ||
        matchesConcreteStageScopedResource(
          resourceKey,
          ANALYSIS_HYSTERESIS_POINT_PATH,
          stageId,
        ) ||
        matchesConcreteStageScopedResource(
          resourceKey,
          ANALYSIS_HYSTERESIS_STAGE_SETTLE_TRACE_PATH,
          stageId,
        ) ||
        matchesConcreteStageScopedResource(
          resourceKey,
          ANALYSIS_HYSTERESIS_SETTLE_TRACE_PATH,
          stageId,
        ),
      dependentRevision,
    );
  }
}
