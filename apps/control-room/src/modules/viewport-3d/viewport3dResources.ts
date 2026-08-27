"use client";

import { useCallback, useMemo } from "react";

import {
  DATA_FIELDS_PATH,
  DATA_DOMAIN_META_PATH,
  DATA_DOMAIN_TOPOLOGY_PATH,
  DATA_FIELD_META_PATH,
  MESHING_SHARED_DOMAIN_MANIFEST_PATH,
  MESHING_SHARED_DOMAIN_QUALITY_DATA_PATH,
  MODEL_SCENE_PATH,
  MODEL_UNIVERSE_PATH,
} from "@/kernel/api/apiPaths";
import { resolveCanonicalQuantityId } from "@/kernel/api/quantityIds";
import {
  canonicalFieldVectorQuery,
  serializeCanonicalFieldVectorResourceKey,
} from "@/kernel/api/fieldQueryIdentity";
import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";
import type {
  BinaryResourceResult,
  FieldCatalogResource,
  FieldVectorResponseMetadata,
  FieldVectorQuery,
  ResourceRevision,
} from "@/kernel/api/apiTypes";
import { fieldCatalogQuantitySupportsAirbox } from "@/kernel/api/quantityIds";
import type {
  DecodedFieldVector,
  DecodedMeshQualityData,
  DecodedTopology,
} from "@/kernel/api/codecs";
import { useKernel } from "@/kernel/KernelContext";
import { memoryBudgetRegistry } from "@/kernel/performance/MemoryBudgetRegistry";
import { recordVisualizationDebugPerformanceMetric } from "@/kernel/performance/visualizationDebugPerformanceProbe";
import { fieldVectorMinRefetchIntervalMs } from "@/kernel/realtime/communicationPolicy";
import {
  ResourceCache,
  type ResourceCacheEntryDiagnostics,
} from "@/kernel/resources/ResourceCache";
import {
  createResourcePartialLoadError,
  type ResourcePartialLoadError,
  type ResourceRetryPolicy,
} from "@/kernel/resources/ResourceRuntimeStore";
import type { ResourceInvalidationController } from "@/kernel/resources/ResourceInvalidationController";
import { useResource } from "@/kernel/resources/useResource";
import { sessionScopedResourceKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";

import {
  buildViewport3DFieldResourceRequestId,
  type Viewport3DFieldResourceRequest,
} from "./model/viewport3DFieldDataPlan";

const topologyCache = new ResourceCache<DecodedTopology>({
  maxBytes: 96 * 1024 * 1024,
});
const fieldVectorCache = new ResourceCache<
  DecodedFieldVector,
  FieldVectorResponseMetadata
>({
  maxBytes: 128 * 1024 * 1024,
});

function recordFieldVectorCacheAdoption(): void {
  recordVisualizationDebugPerformanceMetric("fieldSwaps");
}

const lastGoodFieldVectorRequestKeys = new Map<string, string>();
const MAX_LAST_GOOD_FIELD_VECTOR_REQUEST_KEYS = 1_024;
let activeViewportSessionIdentityKey: string | null = null;
let viewport3DSessionIdentityGeneration = 0;

function clearViewport3DSessionCaches(): void {
  topologyCache.clear();
  fieldVectorCache.clear();
  qualityDataCache.clear();
  lastGoodFieldVectorRequestKeys.clear();
}

function abortViewport3DInflightBinaryResources(): void {
  for (const inflightByKey of binaryResourceInflight.values()) {
    for (const inflight of inflightByKey.values()) {
      inflight.controller.abort();
      releaseInflightBinaryResourceListeners(inflight);
    }
  }
  binaryResourceInflight.clear();
}

export function synchronizeViewport3DSessionIdentity(
  identity: ReturnType<typeof useSessionResourceIdentity>,
): boolean {
  const identityKey = identity
    ? `${identity.sessionId}\u0000${identity.sessionEpoch}`
    : null;
  if (activeViewportSessionIdentityKey === identityKey) return false;
  viewport3DSessionIdentityGeneration += 1;
  abortViewport3DInflightBinaryResources();
  clearViewport3DSessionCaches();
  activeViewportSessionIdentityKey = identityKey;
  return true;
}

function useViewport3DSessionIdentity() {
  const identity = useSessionResourceIdentity();
  synchronizeViewport3DSessionIdentity(identity);
  return identity;
}

export interface Viewport3DFieldVectorEnvelope {
  data: DecodedFieldVector;
  etag: string | null;
  responseMetadata: FieldVectorResponseMetadata | null;
  resourceKey: string;
}

type CachedFieldVectorEnvelope = Viewport3DFieldVectorEnvelope;

type Viewport3DFieldVectorCollectionStatus =
  | "error"
  | "idle"
  | "loading"
  | "ready"
  | "stale";

export type Viewport3DAirboxFieldVectorPartStatus =
  | "error"
  | "loading"
  | "pending"
  | "ready"
  | "stale"
  | "unavailable";

export interface Viewport3DAirboxFieldVectorPartFailure {
  readonly reasonCode: string;
  readonly status: number | null;
}

export interface Viewport3DAirboxFieldVectorPartState {
  readonly data: DecodedFieldVector | null;
  readonly lastValidData: DecodedFieldVector | null;
  readonly reasonCode: string | null;
  readonly revision: ResourceRevision | null;
  readonly status: Viewport3DAirboxFieldVectorPartStatus;
}

interface Viewport3DAirboxFieldVectorPartialLoadError extends Error {
  partFailures: ReadonlyMap<
    string,
    Viewport3DAirboxFieldVectorPartFailure
  >;
}

export interface Viewport3DFieldVectorRequestFailure {
  readonly cause: unknown;
  readonly key: string;
  readonly quantityId: string;
  readonly query: FieldVectorQuery;
  readonly requestId: string;
}

export interface Viewport3DFieldVectorPartialLoadError<TData = unknown>
  extends ResourcePartialLoadError<TData> {
  requestFailures: readonly Viewport3DFieldVectorRequestFailure[];
}

export function createViewport3DFieldVectorPartialLoadError<TData>({
  cause,
  message,
  partialData,
  requestFailures,
}: {
  cause?: unknown;
  message: string;
  partialData: TData;
  requestFailures: readonly Viewport3DFieldVectorRequestFailure[];
}): Viewport3DFieldVectorPartialLoadError<TData> {
  const error = createResourcePartialLoadError(
    message,
    partialData,
    cause,
  ) as Viewport3DFieldVectorPartialLoadError<TData>;
  error.requestFailures = requestFailures;
  return error;
}

export function resolveCachedFieldVectorEnvelope(
  cache: ResourceCache<DecodedFieldVector, FieldVectorResponseMetadata>,
  resourceKey: string,
  data: DecodedFieldVector,
): Viewport3DFieldVectorEnvelope | null {
  const entry = cache.peek(resourceKey);
  if (!entry || entry.data !== data) return null;
  return {
    data: entry.data,
    etag: entry.etag ?? null,
    responseMetadata: entry.metadata ?? null,
    resourceKey,
  };
}

function rememberLastGoodFieldVectorRequestKey(
  collectionId: string,
  requestId: string,
  resourceKey: string,
): void {
  const stableRequestId = `${collectionId}:${requestId}`;
  if (!lastGoodFieldVectorRequestKeys.has(stableRequestId)) {
    while (
      lastGoodFieldVectorRequestKeys.size >=
      MAX_LAST_GOOD_FIELD_VECTOR_REQUEST_KEYS
    ) {
      const oldest = lastGoodFieldVectorRequestKeys.keys().next().value;
      if (oldest === undefined) break;
      lastGoodFieldVectorRequestKeys.delete(oldest);
    }
  }
  lastGoodFieldVectorRequestKeys.delete(stableRequestId);
  lastGoodFieldVectorRequestKeys.set(stableRequestId, resourceKey);
}

function resolveLastGoodFieldVectorEnvelope(
  collectionId: string,
  requestId: string,
  resourceKey: string,
): Viewport3DFieldVectorEnvelope | null {
  const rememberedResourceKey =
    lastGoodFieldVectorRequestKeys.get(`${collectionId}:${requestId}`);
  const resolvedResourceKey = fieldVectorCache.peek(resourceKey)
    ? resourceKey
    : rememberedResourceKey;
  if (!resolvedResourceKey) return null;
  const cached = fieldVectorCache.peek(resolvedResourceKey);
  return cached
    ? resolveCachedFieldVectorEnvelope(
        fieldVectorCache,
        resolvedResourceKey,
        cached.data,
      )
    : null;
}

function resolveLastGoodFieldVectorCollectionFromCache(
  collectionId: string,
  requests: ReadonlyMap<
    string,
    Pick<Viewport3DFieldResourceRequest, "quantityId" | "query"> & {
      key: string;
    }
  >,
): Map<string, Viewport3DFieldVectorEnvelope> {
  const previous = new Map<string, Viewport3DFieldVectorEnvelope>();
  for (const [requestId, request] of requests) {
    const envelope = resolveLastGoodFieldVectorEnvelope(
      collectionId,
      requestId,
      request.key,
    );
    if (envelope) previous.set(requestId, envelope);
  }
  return previous;
}

export function viewport3DFieldVectorMatchesRequestIdentity(
  envelope: Viewport3DFieldVectorEnvelope,
  request: Pick<Viewport3DFieldResourceRequest, "quantityId" | "query">,
): boolean {
  const field = envelope.data;
  if (
    resolveCanonicalQuantityId(field.quantityId) !==
    resolveCanonicalQuantityId(request.quantityId)
  ) {
    return false;
  }

  const requestedScopeKind = request.query.scope_kind ?? "full";
  const requestedScopeId = request.query.scope_id ?? null;
  const responseScopeKind = field.scopeKind ?? envelope.responseMetadata?.scopeKind ?? null;
  const responseScopeId = field.scopeId ?? envelope.responseMetadata?.scopeId ?? null;
  const responseGenerationId =
    field.domainGenerationId ?? envelope.responseMetadata?.domainGenerationId ?? null;
  const responseCarrierRevision =
    field.meshTopologyHash ?? envelope.responseMetadata?.meshTopologyHash ?? null;
  const expectedGenerationId = request.query.expected_generation_id?.trim() || null;
  const expectedCarrierRevision =
    request.query.expected_carrier_revision?.trim() || null;
  if (
    !matchesViewport3DFieldIdentityPrecondition(
      expectedGenerationId,
      responseGenerationId,
    ) ||
    !matchesViewport3DFieldIdentityPrecondition(
      expectedCarrierRevision,
      responseCarrierRevision,
    )
  ) {
    return false;
  }
  if (
    envelope.responseMetadata?.identityIssues.some(
      (issue) =>
        issue.field === "domainGenerationId" ||
        issue.field === "meshTopologyHash",
    )
  ) {
    return false;
  }
  if (
    responseScopeKind !== null &&
    responseScopeKind !== requestedScopeKind
  ) {
    return false;
  }
  if (requestedScopeKind !== "full" && responseScopeKind === null) {
    return false;
  }
  if (requestedScopeId !== null && responseScopeId !== requestedScopeId) {
    return false;
  }
  if (requestedScopeKind !== "full" && responseScopeId === null) {
    return false;
  }

  const metadataQuantityId = envelope.responseMetadata?.quantityId;
  if (
    metadataQuantityId === null ||
    metadataQuantityId === undefined ||
    resolveCanonicalQuantityId(metadataQuantityId) ===
      resolveCanonicalQuantityId(request.quantityId)
  ) {
    const requestedComponent = request.query.component ?? "full";
    const responseComponent =
      envelope.data.nComp === 1 && requestedComponent === "full"
        ? null
        : envelope.responseMetadata?.component ?? null;
    return responseComponent === null || responseComponent === requestedComponent;
  }
  return false;
}

function matchesViewport3DFieldIdentityPrecondition(
  expected: string | null,
  actual: string | null | undefined,
): boolean {
  if (expected === null) return true;
  if (actual == null || actual.trim().length === 0) return false;
  return canonicalViewport3DFieldIdentityToken(expected) ===
    canonicalViewport3DFieldIdentityToken(actual);
}

function canonicalViewport3DFieldIdentityToken(value: string): string {
  const trimmed = value.trim();
  return trimmed.replace(/^sha256:/i, "").toLowerCase();
}

export function resolveViewport3DFieldVectorCollectionLastGood({
  current,
  previous,
  requests,
  status,
}: {
  current: ReadonlyMap<string, Viewport3DFieldVectorEnvelope> | null | undefined;
  previous: ReadonlyMap<string, Viewport3DFieldVectorEnvelope>;
  requests: ReadonlyMap<
    string,
    Pick<Viewport3DFieldResourceRequest, "quantityId" | "query">
  >;
  status: Viewport3DFieldVectorCollectionStatus;
}): Map<string, Viewport3DFieldVectorEnvelope> {
  const retained = new Map<string, Viewport3DFieldVectorEnvelope>();
  for (const [requestId, request] of requests) {
    const currentEnvelope = current?.get(requestId);
    const previousEnvelope = previous.get(requestId);
    if (
      status === "ready" &&
      currentEnvelope &&
      viewport3DFieldVectorMatchesRequestIdentity(currentEnvelope, request)
    ) {
      retained.set(requestId, currentEnvelope);
      continue;
    }
    if (status === "ready") continue;
    if (status !== "error" && status !== "loading" && status !== "stale") {
      continue;
    }
    if (
      previousEnvelope &&
      viewport3DFieldVectorMatchesRequestIdentity(previousEnvelope, request)
    ) {
      retained.set(requestId, previousEnvelope);
    }
  }
  return retained;
}

/**
 * Preserve per-carrier truth when one FEM Airbox part fails. The renderer may
 * consume the compatible last-good payload, but the state remains `stale` or
 * `unavailable`; a partial collection must never be presented as `ready`.
 */
export function resolveViewport3DAirboxFieldVectorPartStates({
  current,
  displayed,
  failures,
  previous,
  requests,
  status,
}: {
  current: ReadonlyMap<string, Viewport3DFieldVectorEnvelope> | null | undefined;
  displayed: ReadonlyMap<string, Viewport3DFieldVectorEnvelope>;
  failures?: ReadonlyMap<string, Viewport3DAirboxFieldVectorPartFailure>;
  previous: ReadonlyMap<string, Viewport3DFieldVectorEnvelope>;
  requests: ReadonlyMap<string, unknown>;
  status: Viewport3DFieldVectorCollectionStatus;
}): Map<string, Viewport3DAirboxFieldVectorPartState> {
  const states = new Map<string, Viewport3DAirboxFieldVectorPartState>();
  for (const partId of requests.keys()) {
    const currentEnvelope = current?.get(partId) ?? null;
    const displayedEnvelope = displayed.get(partId) ?? null;
    const previousEnvelope = previous.get(partId) ?? null;
    const failure = failures?.get(partId);
    const hasLastValid = Boolean(previousEnvelope || displayedEnvelope);
    let partStatus: Viewport3DAirboxFieldVectorPartStatus;
    let reasonCode = failure?.reasonCode ?? null;

    if (failure) {
      if (hasLastValid) {
        partStatus = "stale";
      } else if (failure.status === 202) {
        partStatus = "pending";
      } else if (failure.status === 404) {
        partStatus = "unavailable";
      } else {
        partStatus = "error";
      }
    } else if (currentEnvelope) {
      partStatus = "ready";
    } else if (displayedEnvelope) {
      partStatus = "stale";
      reasonCode = "field_refresh_in_progress";
    } else if (status === "loading" || status === "stale") {
      partStatus = "loading";
      reasonCode = "field_materialization_pending";
    } else if (status === "error") {
      partStatus = "error";
      reasonCode = "field_vector_request_failed";
    } else {
      partStatus = "unavailable";
      reasonCode = "target_carrier_missing";
    }

    states.set(partId, {
      data: failure ? null : currentEnvelope?.data ?? null,
      lastValidData:
        previousEnvelope?.data ?? displayedEnvelope?.data ?? null,
      reasonCode,
      revision:
        (failure ? displayedEnvelope?.etag : currentEnvelope?.etag) ??
        previousEnvelope?.etag ??
        null,
      status: partStatus,
    });
  }
  return states;
}

export const resolveViewport3DFieldVectorRequestStates =
  resolveViewport3DAirboxFieldVectorPartStates;

const qualityDataCache = new ResourceCache<DecodedMeshQualityData>({
  maxBytes: 48 * 1024 * 1024,
});
const binaryResourceInflight = new Map<
  object,
  Map<string, InflightBinaryResource<unknown>>
>();

interface InflightBinaryResource<TData> {
  readonly abortListeners: Map<AbortSignal, () => void>;
  readonly consumerSignals: Set<AbortSignal>;
  readonly controller: AbortController;
  readonly promise: Promise<TData | null>;
}

memoryBudgetRegistry.register("viewport3d.topologyCache", () => {
  const stats = topologyCache.stats();
  return {
    byteLength: stats.byteLength,
    category: "viewport-cache",
    entryCount: stats.entryCount,
    id: "viewport3d.topologyCache",
    label: "Viewport topology cache",
    maxBytes: topologyCache.maxBytes(),
  };
});

memoryBudgetRegistry.register("viewport3d.fieldVectorCache", () => {
  const stats = fieldVectorCache.stats();
  return {
    byteLength: stats.byteLength,
    category: "viewport-cache",
    entryCount: stats.entryCount,
    id: "viewport3d.fieldVectorCache",
    label: "Field vector cache",
    maxBytes: fieldVectorCache.maxBytes(),
  };
});

memoryBudgetRegistry.register("viewport3d.qualityDataCache", () => {
  const stats = qualityDataCache.stats();
  return {
    byteLength: stats.byteLength,
    category: "viewport-cache",
    entryCount: stats.entryCount,
    id: "viewport3d.qualityDataCache",
    label: "Mesh quality cache",
    maxBytes: qualityDataCache.maxBytes(),
  };
});

const VIEWPORT_3D_DOMAIN_META_RESOURCE_KEY = DATA_DOMAIN_META_PATH;
const VIEWPORT_3D_DOMAIN_TOPOLOGY_RESOURCE_KEY = DATA_DOMAIN_TOPOLOGY_PATH;
const VIEWPORT_3D_SHARED_DOMAIN_MANIFEST_RESOURCE_KEY =
  MESHING_SHARED_DOMAIN_MANIFEST_PATH;
const VIEWPORT_3D_SHARED_DOMAIN_QUALITY_DATA_RESOURCE_KEY =
  MESHING_SHARED_DOMAIN_QUALITY_DATA_PATH;
const VIEWPORT_3D_SCENE_RESOURCE_KEY = MODEL_SCENE_PATH;
const VIEWPORT_3D_UNIVERSE_RESOURCE_KEY = MODEL_UNIVERSE_PATH;
const FULL_FIELD_VECTOR_QUERY: FieldVectorQuery = {
  component: "full",
  scope_kind: "full",
};
const FIELD_VECTOR_RETRY_POLICY: ResourceRetryPolicy = {
  deadlineMs: 5_000,
  maxAttempts: 5,
  retryAfterMs: 250,
  retryableReasonCodes: [
    "field_materialization_pending",
    "field_pending",
    "field_unmaterialized",
    "materialization_pending",
    "not_ready",
    "pending",
    "temporary_not_found",
    "transient_not_found",
  ],
};

export interface Viewport3DQuantityFieldVectorRequest {
  consumers?: readonly string[];
  key: string;
  quantityId: string;
  query: FieldVectorQuery;
  requestId?: string;
}

export interface Viewport3DPartFieldVectorRequest {
  consumers?: readonly string[];
  key: string;
  quantityId: string;
  query: FieldVectorQuery;
  requestId?: string;
}

export interface Viewport3DAirboxFieldVectorRequest {
  consumers?: readonly string[];
  key: string;
  quantityId: string;
  query: FieldVectorQuery;
  requestId?: string;
}

const VIEWPORT_3D_FIELD_REQUEST_CONCURRENCY = 4;

export async function loadViewport3DFieldRequestsBounded<
  TRequest extends { readonly consumers?: readonly string[] },
  TResult,
>(
  requests: readonly TRequest[],
  load: (request: TRequest) => Promise<TResult>,
  options: {
    concurrency?: number;
    selectedTargetId?: string | null;
    signal?: AbortSignal;
  } = {},
): Promise<TResult[]> {
  const concurrency = Math.max(
    1,
    Math.min(
      requests.length || 1,
      Math.floor(options.concurrency ?? VIEWPORT_3D_FIELD_REQUEST_CONCURRENCY),
    ),
  );
  const queue = requests
    .map((request, index) => ({
      index,
      priority: fieldRequestPriority(request, options.selectedTargetId),
      request,
    }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index);
  const results = new Array<TResult>(queue.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < queue.length) {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new DOMException("aborted", "AbortError");
      }
      const resultIndex = cursor;
      const item = queue[cursor++];
      if (!item) return;
      results[resultIndex] = await load(item.request);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

function fieldRequestPriority(request: {
  readonly consumers?: readonly string[];
}, selectedTargetId?: string | null): number {
  const consumers = request.consumers ?? [];
  if (
    selectedTargetId &&
    consumers.some((consumer) => consumer.includes(selectedTargetId))
  ) return 0;
  if (consumers.some((consumer) => consumer.includes("vector-glyph"))) return 1;
  if (consumers.some((consumer) => consumer.includes(":surface"))) return 2;
  return 3;
}

function scopeViewport3DFieldVectorRequests<
  TRequest extends { readonly key: string },
>(
  requests: ReadonlyMap<string, TRequest>,
  sessionIdentity: ReturnType<typeof useViewport3DSessionIdentity>,
): Map<string, TRequest & { readonly unscopedKey: string }> {
  if (!sessionIdentity) return new Map();
  return new Map(
    Array.from(requests, ([requestId, request]) => [
      requestId,
      {
        ...request,
        key: sessionScopedResourceKey(sessionIdentity, request.key),
        unscopedKey: request.key,
      },
    ]),
  );
}

type Viewport3DAirboxFieldVectorSourceRequest =
  | Viewport3DAirboxFieldVectorRequest
  | Viewport3DFieldResourceRequest;

export function viewport3DFieldMetaResourceMatchesQuantity(
  resourceKey: string,
  quantityId: string,
): boolean {
  const fieldMetaPath = DATA_FIELD_META_PATH.replace(
    "{quantity_id}",
    encodeURIComponent(resolveCanonicalQuantityId(quantityId)),
  );
  return (
    resourceKey === fieldMetaPath ||
    resourceKey.startsWith(`${fieldMetaPath}?`) ||
    resourceKey.includes(`#viewport-3d:part-scalar-ranges:${fieldMetaPath}?`) ||
    resourceKey.includes(`|${fieldMetaPath}?`)
  );
}

export function invalidateViewport3DFieldMetaResources(
  resources: ResourceInvalidationController,
  quantityId: string,
  revision: ResourceRevision | null,
): void {
  if (revision === null) return;
  resources.invalidateMatching(
    (resourceKey) =>
      viewport3DFieldMetaResourceMatchesQuantity(resourceKey, quantityId),
    revision,
  );
}

function resolveDomainMetaRevision(meta: { generation_id: string }) {
  return meta.generation_id;
}

function resolveSharedDomainManifestRevision(
  manifest: { revision?: number | string | null } | null,
) {
  return manifest?.revision ?? null;
}

function resolveUniverseRevision(universe: { scene_revision: number }) {
  return universe.scene_revision;
}

export function getViewport3DCacheStats() {
  const topologyStats = topologyCache.stats();
  const fieldVectorStats = fieldVectorCache.stats();
  const qualityDataStats = qualityDataCache.stats();

  return {
    byteLength:
      topologyStats.byteLength +
      fieldVectorStats.byteLength +
      qualityDataStats.byteLength,
    entryCount:
      topologyStats.entryCount +
      fieldVectorStats.entryCount +
      qualityDataStats.entryCount,
  };
}

export interface Viewport3DFieldVectorCacheEntryDiagnostics
  extends ResourceCacheEntryDiagnostics {
  dataIdentityMatches: boolean | null;
  responseMetadata: FieldVectorResponseMetadata | null;
}

export interface Viewport3DFieldVectorCacheBudgetDiagnostics {
  byteLength: number;
  entryCount: number;
  maxBytes: number;
}

export function getViewport3DFieldVectorCacheEntryDiagnostics(
  resourceKey: string,
  expectedData?: DecodedFieldVector,
): Viewport3DFieldVectorCacheEntryDiagnostics {
  return inspectViewport3DFieldVectorCacheEntryDiagnostics(
    fieldVectorCache,
    resourceKey,
    binaryResourceInflight,
    expectedData,
  );
}

export function inspectViewport3DFieldVectorCacheEntryDiagnostics<TInflight>(
  cache: ResourceCache<DecodedFieldVector, FieldVectorResponseMetadata>,
  resourceKey: string,
  inflightRegistry:
    | ReadonlyMap<object, ReadonlyMap<string, TInflight>>
    | WeakMap<object, ReadonlyMap<string, TInflight>>,
  expectedData?: DecodedFieldVector,
): Viewport3DFieldVectorCacheEntryDiagnostics {
  const diagnostics = cache.inspect(resourceKey);
  const entry = cache.peek(resourceKey);
  const binaryInflight =
    inflightRegistry.get(cache)?.has(resourceKey) ?? false;
  const entryState =
    binaryInflight ? "inflight" : diagnostics.entryState;
  const dataIdentityMatches =
    expectedData === undefined || !entry ? null : entry.data === expectedData;
  const metadata = dataIdentityMatches === false ? undefined : entry?.metadata;
  return {
    ...diagnostics,
    dataIdentityMatches,
    entryState,
    responseMetadata: metadata
      ? boundFieldVectorResponseMetadata(metadata)
      : null,
  };
}

export function getViewport3DFieldVectorCacheBudgetDiagnostics(): Viewport3DFieldVectorCacheBudgetDiagnostics {
  const stats = fieldVectorCache.stats();
  return {
    byteLength: stats.byteLength,
    entryCount: stats.entryCount,
    maxBytes: fieldVectorCache.maxBytes(),
  };
}

const MAX_FIELD_VECTOR_DIAGNOSTIC_STRING_LENGTH = 4_096;
const MAX_FIELD_VECTOR_IDENTITY_ISSUES = 20;

function boundFieldVectorDiagnosticString(value: string | null): string | null {
  return value?.slice(0, MAX_FIELD_VECTOR_DIAGNOSTIC_STRING_LENGTH) ?? null;
}

function boundFieldVectorResponseMetadata(
  metadata: FieldVectorResponseMetadata,
): FieldVectorResponseMetadata {
  return {
    component: boundFieldVectorDiagnosticString(metadata.component),
    domainGenerationId: boundFieldVectorDiagnosticString(
      metadata.domainGenerationId,
    ),
    encoding: boundFieldVectorDiagnosticString(metadata.encoding),
    fieldIndexing: boundFieldVectorDiagnosticString(metadata.fieldIndexing),
    fieldRevision: boundFieldVectorDiagnosticString(metadata.fieldRevision),
    identityIssues: metadata.identityIssues
      .slice(0, MAX_FIELD_VECTOR_IDENTITY_ISSUES)
      .map((issue) => ({
        field: boundFieldVectorDiagnosticString(issue.field) ?? "",
        headerValue:
          typeof issue.headerValue === "string"
            ? boundFieldVectorDiagnosticString(issue.headerValue)
            : issue.headerValue,
        payloadValue:
          typeof issue.payloadValue === "string"
            ? boundFieldVectorDiagnosticString(issue.payloadValue)
            : issue.payloadValue,
      })),
    meshTopologyHash: boundFieldVectorDiagnosticString(
      metadata.meshTopologyHash,
    ),
    nComp: metadata.nComp,
    nodeIndexCount: metadata.nodeIndexCount,
    pointCount: metadata.pointCount,
    quantityId: boundFieldVectorDiagnosticString(metadata.quantityId),
    scopeId: boundFieldVectorDiagnosticString(metadata.scopeId),
    scopeKind: boundFieldVectorDiagnosticString(metadata.scopeKind),
    snapshotId: boundFieldVectorDiagnosticString(metadata.snapshotId),
    valueCount: metadata.valueCount,
  };
}

export async function loadCachedBinaryResource<TData, TMetadata = undefined>(
  cache: ResourceCache<TData, TMetadata>,
  key: string,
  request: (
    etag?: string | null,
    signal?: AbortSignal,
  ) => Promise<BinaryResourceResult<TData, TMetadata>>,
  options: {
    onFreshAdoption?: () => void;
    preferCached?: boolean;
    retainCachedOnNotApplicable?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<TData | null> {
  const requestSessionIdentityGeneration = viewport3DSessionIdentityGeneration;
  const cached = cache.get(key);
  if (cached && options.preferCached) {
    recordVisualizationDebugPerformanceMetric("cacheHits");
    return cached.data;
  }
  if (!cached) {
    recordVisualizationDebugPerformanceMetric("cacheMisses");
  }
  const inflight = getInflightBinaryResource(cache, key);
  if (inflight) {
    retainInflightBinaryResource(inflight, options.signal);
    return inflight.promise;
  }

  const controller = new AbortController();
  const pending = (async () => {
    const result = await request(cached?.etag, controller.signal);
    if (
      requestSessionIdentityGeneration !== viewport3DSessionIdentityGeneration
    ) {
      throw createViewport3DSessionIdentityAbortError(key);
    }
    if (result.status === "pending") {
      const pendingResult = result;
      throw Object.assign(
        new Error(
          pendingResult.reason_code ??
            `Binary resource ${key} is pending materialization`,
        ),
        {
          code: pendingResult.reason_code ?? "pending",
          command_id: pendingResult.command_id ?? null,
          reason_code: pendingResult.reason_code ?? "pending",
          retry_after_ms: pendingResult.retry_after_ms ?? null,
          status: 202,
        },
      );
    }

    if (result.status === "not-modified") {
      if (!cached) {
        throw new Error(`Binary resource ${key} returned 304 without cache entry`);
      }
      if (!cache.peek(key)) {
        cache.set(key, cached);
      } else {
        cache.get(key);
      }
      recordVisualizationDebugPerformanceMetric("cacheHits");
      return cached.data;
    }

    if (result.status === "not-applicable") {
      if (cached && options.retainCachedOnNotApplicable) {
        if (!cache.peek(key)) {
          cache.set(key, cached);
        } else {
          cache.get(key);
        }
        recordVisualizationDebugPerformanceMetric("cacheHits");
        return cached.data;
      }
      cache.delete(key);
      return null;
    }

    cache.set(key, {
      byteLength: result.byteLength,
      data: result.data,
      etag: result.etag,
      metadata: result.responseMetadata,
    });
    options.onFreshAdoption?.();
    return result.data;
  })();

  const inflightResource: InflightBinaryResource<TData> = {
    abortListeners: new Map<AbortSignal, () => void>(),
    consumerSignals: new Set<AbortSignal>(),
    controller,
    promise: pending,
  };
  retainInflightBinaryResource(inflightResource, options.signal);
  setInflightBinaryResource(cache, key, inflightResource);
  try {
    return await pending;
  } finally {
    clearInflightBinaryResource(cache, key, inflightResource);
  }
}

function createViewport3DSessionIdentityAbortError(key: string): Error {
  return Object.assign(
    new Error(`Binary resource ${key} completed after a session identity change`),
    {
      code: "session-identity-changed",
      name: "AbortError",
      reason_code: "session-identity-changed",
      status: 409,
    },
  );
}

function getInflightBinaryResource<TData, TMetadata>(
  cache: ResourceCache<TData, TMetadata>,
  key: string,
): InflightBinaryResource<TData> | null {
  const inflight = binaryResourceInflight
    .get(cache as ResourceCache<unknown, unknown>)
    ?.get(key);
  return (inflight as InflightBinaryResource<TData> | undefined) ?? null;
}

function setInflightBinaryResource<TData, TMetadata>(
  cache: ResourceCache<TData, TMetadata>,
  key: string,
  inflight: InflightBinaryResource<TData>,
): void {
  const typedCache = cache as ResourceCache<unknown, unknown>;
  let cacheInflight = binaryResourceInflight.get(typedCache);
  if (!cacheInflight) {
    cacheInflight = new Map<string, InflightBinaryResource<unknown>>();
    binaryResourceInflight.set(typedCache, cacheInflight);
  }
  cacheInflight.set(key, inflight as InflightBinaryResource<unknown>);
}

function clearInflightBinaryResource<TData, TMetadata>(
  cache: ResourceCache<TData, TMetadata>,
  key: string,
  inflight: InflightBinaryResource<TData>,
): void {
  const typedCache = cache as ResourceCache<unknown, unknown>;
  const cacheInflight = binaryResourceInflight.get(typedCache);
  if (!cacheInflight || cacheInflight.get(key) !== inflight) return;
  releaseInflightBinaryResourceListeners(inflight);
  cacheInflight.delete(key);
  if (cacheInflight.size === 0) {
    binaryResourceInflight.delete(typedCache);
  }
}

function retainInflightBinaryResource<TData>(
  inflight: InflightBinaryResource<TData>,
  signal: AbortSignal | undefined,
): void {
  if (!signal || inflight.abortListeners.has(signal)) return;
  if (signal.aborted) {
    if (inflight.consumerSignals.size === 0) {
      inflight.controller.abort();
    }
    return;
  }

  const release = () => {
    inflight.consumerSignals.delete(signal);
    inflight.abortListeners.delete(signal);
    if (inflight.consumerSignals.size === 0) {
      inflight.controller.abort();
    }
  };
  inflight.consumerSignals.add(signal);
  inflight.abortListeners.set(signal, release);
  signal.addEventListener("abort", release, { once: true });
}

function releaseInflightBinaryResourceListeners<TData>(
  inflight: InflightBinaryResource<TData>,
): void {
  for (const [signal, release] of inflight.abortListeners) {
    signal.removeEventListener("abort", release);
  }
  inflight.abortListeners.clear();
  inflight.consumerSignals.clear();
}

export function cachedBinaryResourceMatchesRevision<TData, TMetadata>(
  cache: ResourceCache<TData, TMetadata>,
  key: string,
  revision: ResourceRevision | null,
): boolean {
  const cached = cache.peek(key);
  if (!cached) return false;
  return revision === null || cached.etag === revision;
}

export function resolveViewport3DFieldVectorResourceKey(
  quantityId: string,
  query: FieldVectorQuery = {},
): string {
  return serializeCanonicalFieldVectorResourceKey(
    canonicalFieldVectorQuery(quantityId, query),
  );
}

export function resolveViewport3DFieldVectorRequestResourceKey(
  request: Viewport3DFieldResourceRequest,
): string {
  return resolveViewport3DFieldVectorResourceKey(request.quantityId, request.query);
}

export function resolveViewport3DAirboxFieldVectorQuery(
  fieldQuery: FieldVectorQuery = FULL_FIELD_VECTOR_QUERY,
): FieldVectorQuery {
  return {
    ...fieldQuery,
    component: fieldQuery.component ?? "full",
    scope_kind: "airbox",
  };
}

function airboxFieldVectorFailure(
  error: unknown,
): Viewport3DAirboxFieldVectorPartFailure {
  if (error instanceof ControlRoomApiError) {
    return {
      reasonCode:
        error.code ??
        (error.status === 404
          ? "target_carrier_missing"
          : error.status === 202
            ? "field_materialization_pending"
            : "field_vector_request_failed"),
      status: error.status,
    };
  }
  if (error && typeof error === "object") {
    const candidate = error as Record<string, unknown>;
    const reasonCode =
      (typeof candidate.reasonCode === "string" && candidate.reasonCode) ||
      (typeof candidate.reason_code === "string" && candidate.reason_code) ||
      (typeof candidate.code === "string" && candidate.code) ||
      "field_vector_request_failed";
    return {
      reasonCode,
      status: typeof candidate.status === "number" ? candidate.status : null,
    };
  }
  return { reasonCode: "field_vector_request_failed", status: null };
}

function airboxPartFailuresFromError(
  error: Error | null,
): ReadonlyMap<string, Viewport3DAirboxFieldVectorPartFailure> {
  if (!error || !("partFailures" in error)) return new Map();
  const partFailures = (error as Partial<Viewport3DAirboxFieldVectorPartialLoadError>)
    .partFailures;
  return partFailures instanceof Map ? partFailures : new Map();
}

function fieldRequestFailuresFromError(
  error: Error | null,
): ReadonlyMap<string, Viewport3DAirboxFieldVectorPartFailure> {
  if (!error || !("requestFailures" in error)) return new Map();
  const requestFailures = (
    error as Partial<Viewport3DFieldVectorPartialLoadError>
  ).requestFailures;
  if (!Array.isArray(requestFailures)) return new Map();
  return new Map(
    requestFailures.map((failure) => [
      failure.requestId,
      airboxFieldVectorFailure(failure.cause),
    ]),
  );
}

export function resolveViewport3DAirboxFieldVectorResourceKeys(
  quantityId: string,
  airboxParts: readonly { id: string }[],
  fieldQuery: FieldVectorQuery = FULL_FIELD_VECTOR_QUERY,
  fieldCatalog?: FieldCatalogResource | null,
): Map<string, string> {
  return new Map(
    Array.from(
      resolveViewport3DAirboxFieldVectorResourceRequests(
        quantityId,
        airboxParts,
        fieldQuery,
        fieldCatalog,
      ),
      ([partId, request]) => [partId, request.key],
    ),
  );
}

export function resolveViewport3DAirboxFieldVectorResourceRequests(
  quantityId: string,
  airboxParts: readonly { id: string }[],
  fieldQuery: FieldVectorQuery = FULL_FIELD_VECTOR_QUERY,
  fieldCatalog?: FieldCatalogResource | null,
): Map<string, Viewport3DAirboxFieldVectorRequest> {
  if (!fieldCatalogQuantitySupportsAirbox(fieldCatalog, quantityId)) {
    return new Map();
  }
  const canonicalQuantityId = resolveCanonicalQuantityId(quantityId);
  return new Map(
    airboxParts.map((part) => {
      const query = resolveViewport3DAirboxFieldVectorQuery({
        ...fieldQuery,
        scope_id: part.id,
      });
      return [
        part.id,
        {
          key: resolveViewport3DFieldVectorResourceKey(
            canonicalQuantityId,
            query,
          ),
          quantityId: canonicalQuantityId,
          query,
        },
      ];
    }),
  );
}

export function resolveViewport3DQuantityFieldVectorResourceKeys(
  quantityIds: readonly string[],
): Map<string, string> {
  const canonicalQuantityIds = new Set<string>();
  for (const quantityId of quantityIds) {
    const trimmed = quantityId.trim();
    if (trimmed.length > 0) {
      canonicalQuantityIds.add(resolveCanonicalQuantityId(trimmed));
    }
  }
  return new Map(
    Array.from(canonicalQuantityIds)
      .toSorted()
      .map((quantityId) => [
        quantityId,
        resolveViewport3DFieldVectorResourceKey(quantityId, {
          component: "full",
          scope_kind: "full",
        }),
      ]),
  );
}

export function resolveViewport3DQuantityFieldVectorResourceRequests(
  quantityQueries: ReadonlyMap<
    string,
    FieldVectorQuery | Viewport3DFieldResourceRequest
  >,
): Map<string, Viewport3DQuantityFieldVectorRequest> {
  const canonicalQueries = new Map<string, {
    consumers?: readonly string[];
    query: FieldVectorQuery;
    quantityId: string;
    requestId?: string;
  }>();
  for (const [sourceKey, queryOrRequest] of quantityQueries) {
    const quantityId = resolveCanonicalQuantityId(
      "quantityId" in queryOrRequest ? queryOrRequest.quantityId : sourceKey,
    );
    if (!quantityId) continue;
    const requestMetadata = viewport3DFieldResourceRequestMetadata(queryOrRequest);
    const query = viewport3DFieldResourceRequestQuery(queryOrRequest);
    const requestId =
      requestMetadata?.requestId ??
      buildViewport3DFieldResourceRequestId(quantityId, query);
    canonicalQueries.set(requestId, {
      ...(requestMetadata?.consumers
        ? { consumers: requestMetadata.consumers }
        : {}),
      query,
      quantityId,
      requestId,
    });
  }
  return new Map(
    Array.from(canonicalQueries)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([requestId, request]) => [
        requestId,
        {
          ...(request.consumers ? { consumers: request.consumers } : {}),
          key: resolveViewport3DFieldVectorResourceKey(
            request.quantityId,
            request.query,
          ),
          quantityId: request.quantityId,
          query: request.query,
          ...(request.requestId ? { requestId: request.requestId } : {}),
        },
      ]),
  );
}

function viewport3DFieldResourceRequestQuery(
  queryOrRequest: FieldVectorQuery | Viewport3DFieldResourceRequest,
): FieldVectorQuery {
  return "requestId" in queryOrRequest ? queryOrRequest.query : queryOrRequest;
}

function viewport3DFieldResourceRequestMetadata(
  queryOrRequest:
    | FieldVectorQuery
    | Viewport3DFieldResourceRequest
    | { quantityId: string; query: FieldVectorQuery },
): Pick<Viewport3DFieldResourceRequest, "consumers" | "requestId"> | null {
  return "requestId" in queryOrRequest && "consumers" in queryOrRequest
    ? {
        consumers: queryOrRequest.consumers,
        requestId: queryOrRequest.requestId,
      }
    : null;
}

export function resolveViewport3DPartFieldVectorResourceRequests(
  partQueries: ReadonlyMap<
    string,
    { quantityId: string; query: FieldVectorQuery } | Viewport3DFieldResourceRequest
  >,
): Map<string, Viewport3DPartFieldVectorRequest> {
  return new Map(
    Array.from(partQueries)
      .filter(([, request]) => request.quantityId.trim().length > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([partId, request]) => {
        const quantityId = resolveCanonicalQuantityId(
          request.quantityId.trim(),
        );
        const requestMetadata = viewport3DFieldResourceRequestMetadata(request);
        const scopeId = request.query.scope_id ?? partId;
        const query: FieldVectorQuery = {
          ...request.query,
          component: request.query.component ?? "full",
          scope_id: scopeId,
          scope_kind: request.query.scope_id
            ? request.query.scope_kind ?? "part"
            : "part",
        };
        return [
          partId,
          {
            ...(requestMetadata?.consumers
              ? { consumers: requestMetadata.consumers }
              : {}),
            key: resolveViewport3DFieldVectorResourceKey(
              quantityId,
              query,
            ),
            quantityId,
            query,
            ...(requestMetadata?.requestId
              ? { requestId: requestMetadata.requestId }
              : {}),
          },
        ];
      }),
  );
}

export function resolveViewport3DFieldVectorCollectionResourceKey(
  kind: "airbox" | "part" | "quantity",
  resourceKeys: Iterable<string>,
): string {
  const suffix = Array.from(resourceKeys).toSorted().join("|");
  return suffix
    ? `${DATA_FIELDS_PATH}#viewport-3d:${kind}-field-vectors:${suffix}`
    : `${DATA_FIELDS_PATH}#viewport-3d:${kind}-field-vectors:none`;
}

export function useViewport3DDomainMeta() {
  const { api } = useKernel();
  const sessionIdentity = useViewport3DSessionIdentity();
  const resourceKey = sessionIdentity
    ? sessionScopedResourceKey(sessionIdentity, VIEWPORT_3D_DOMAIN_META_RESOURCE_KEY)
    : VIEWPORT_3D_DOMAIN_META_RESOURCE_KEY;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => api.data.domain.meta({ signal }),
    [api],
  );

  return useResource({
    enabled: sessionIdentity !== null,
    load,
    resolveRevision: resolveDomainMetaRevision,
    resourceKey,
  });
}

export function useViewport3DDomainTopology() {
  const { api } = useKernel();
  const sessionIdentity = useViewport3DSessionIdentity();
  const resourceKey = sessionIdentity
    ? sessionScopedResourceKey(
        sessionIdentity,
        VIEWPORT_3D_DOMAIN_TOPOLOGY_RESOURCE_KEY,
      )
    : VIEWPORT_3D_DOMAIN_TOPOLOGY_RESOURCE_KEY;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      loadCachedBinaryResource(
        topologyCache,
        resourceKey,
        (etag, requestSignal) =>
          api.data.domain.topologyChunked({ etag, signal: requestSignal }),
        { signal },
      ),
    [api, resourceKey],
  );

  return useResource({
    enabled: sessionIdentity !== null,
    load,
    resolveRevision: () => topologyCache.peek(resourceKey)?.etag ?? null,
    resourceKey,
  });
}

export function useViewport3DAnalysisFieldVector(
  quantityId: string,
  fieldQuery: FieldVectorQuery = {},
  enabled = true,
  options: { pauseLoad?: boolean } = {},
) {
  const component = fieldQuery.component ?? "full";
  const maxSamples = fieldQuery.max_samples ?? null;
  const phaseRad = fieldQuery.phase_rad ?? null;
  const scopeId = fieldQuery.scope_id ?? null;
  const scopeKind = fieldQuery.scope_kind ?? null;
  const snapshotId = fieldQuery.snapshot_id ?? null;
  const stageId = fieldQuery.stage_id ?? null;
  const view = fieldQuery.view ?? null;
  const query = useMemo<FieldVectorQuery>(
    () => ({
      component,
      max_samples: maxSamples,
      phase_rad: phaseRad,
      scope_id: scopeId,
      scope_kind: scopeKind,
      snapshot_id: snapshotId,
      stage_id: stageId,
      view,
    }),
    [component, maxSamples, phaseRad, scopeId, scopeKind, snapshotId, stageId, view],
  );
  const request = useMemo<Viewport3DFieldResourceRequest>(
    () => ({
      consumers: ["analysis-complex-field"],
      quantityId,
      query,
      requestId: buildViewport3DFieldResourceRequestId(quantityId, query),
    }),
    [quantityId, query],
  );
  return useViewport3DFieldVectorRequest(request, enabled, options);
}

export function useViewport3DFieldVectorRequest(
  request: Viewport3DFieldResourceRequest,
  enabled = true,
  options: { pauseLoad?: boolean } = {},
) {
  const { api, resources } = useKernel();
  const sessionIdentity = useViewport3DSessionIdentity();
  const quantityId = request.quantityId;
  const query = request.query;
  const unscopedRequestKey = useMemo(
    () => resolveViewport3DFieldVectorRequestResourceKey(request),
    [request],
  );
  const requestKey = sessionIdentity
    ? sessionScopedResourceKey(sessionIdentity, unscopedRequestKey)
    : unscopedRequestKey;
  const load = useCallback(
    async ({ signal }: { signal: AbortSignal }) => {
      const data = await loadCachedBinaryResource(
        fieldVectorCache,
        requestKey,
        (etag, requestSignal) =>
          api.data.fields.vector(quantityId, query, {
            etag,
            signal: requestSignal,
          }),
        {
          onFreshAdoption: recordFieldVectorCacheAdoption,
          preferCached: cachedBinaryResourceMatchesRevision(
            fieldVectorCache,
            requestKey,
            resources.getRevision(unscopedRequestKey),
          ),
          retainCachedOnNotApplicable: true,
          signal,
        },
      );
      if (data !== null) {
        invalidateViewport3DFieldMetaResources(
          resources,
          quantityId,
          fieldVectorCache.peek(requestKey)?.etag ?? null,
        );
      }
      return data === null
        ? null
        : resolveCachedFieldVectorEnvelope(fieldVectorCache, requestKey, data);
    },
    [api, quantityId, query, requestKey, resources, unscopedRequestKey],
  );
  const resolveRevision = useCallback(
    () => fieldVectorCache.peek(requestKey)?.etag ?? null,
    [requestKey],
  );

  const resource = useResource({
    abortStaleInflight: true,
    enabled: enabled && sessionIdentity !== null,
    load,
    minRefetchIntervalMs: fieldVectorMinRefetchIntervalMs(),
    pauseLoad: options.pauseLoad,
    retryPolicy: FIELD_VECTOR_RETRY_POLICY,
    resolveRevision,
    resourceKey: requestKey,
  });
  return {
    ...resource,
    data: resource.data?.data ?? null,
    payloadRevision: resource.data?.etag ?? resolveRevision(),
    responseMetadata: resource.data?.responseMetadata ?? null,
  };
}

export function useViewport3DAirboxFieldVectors(
  quantityId: string,
  airboxParts: readonly { id: string }[],
  enabled = true,
  fieldSource:
    | FieldVectorQuery
    | ReadonlyMap<string, Viewport3DAirboxFieldVectorSourceRequest> =
    FULL_FIELD_VECTOR_QUERY,
  options: { pauseLoad?: boolean; selectedTargetId?: string | null } = {},
  fieldCatalog?: FieldCatalogResource | null,
) {
  const { api, resources } = useKernel();
  const sessionIdentity = useViewport3DSessionIdentity();
  const unscopedRequests = useMemo(
    () => {
      if (isViewport3DAirboxFieldVectorRequestMap(fieldSource)) {
        return new Map(
          Array.from(fieldSource, ([partId, request]) => [
            partId,
            normalizeViewport3DAirboxFieldVectorRequest(request),
          ]),
        );
      }
      return resolveViewport3DAirboxFieldVectorResourceRequests(
        quantityId,
        airboxParts,
        fieldSource,
        fieldCatalog,
      );
    },
    [airboxParts, fieldCatalog, fieldSource, quantityId],
  );
  const requests = useMemo(
    () => scopeViewport3DFieldVectorRequests(unscopedRequests, sessionIdentity),
    [sessionIdentity, unscopedRequests],
  );
  const resourceKey = useMemo(() => {
    return resolveViewport3DFieldVectorCollectionResourceKey(
      "airbox",
      Array.from(requests.values(), (request) => request.key),
    );
  }, [requests]);
  const load = useCallback(
    async ({ signal }: { signal: AbortSignal }) => {
      const uniqueRequests = Array.from(
        new Map(
          Array.from(requests.values(), (request) => [request.key, request]),
        ).values(),
      );
      const dataByKey = new Map<string, CachedFieldVectorEnvelope | null>();
      const failureByKey = new Map<
        string,
        Viewport3DAirboxFieldVectorPartFailure
      >();
      const requestFailures: Viewport3DFieldVectorRequestFailure[] = [];
      let firstError: unknown = null;
      await loadViewport3DFieldRequestsBounded(
        uniqueRequests,
        async (request) => {
        try {
          const data = await loadCachedBinaryResource(
            fieldVectorCache,
            request.key,
            (etag, requestSignal) =>
              api.data.fields.vector(request.quantityId, request.query, {
                etag,
                signal: requestSignal,
              }),
            {
              onFreshAdoption: recordFieldVectorCacheAdoption,
              preferCached: cachedBinaryResourceMatchesRevision(
                fieldVectorCache,
                request.key,
                resources.getRevision(request.unscopedKey),
              ),
              retainCachedOnNotApplicable: true,
              signal,
            },
          );
          if (data !== null) {
            invalidateViewport3DFieldMetaResources(
              resources,
              request.quantityId,
              fieldVectorCache.peek(request.key)?.etag ?? null,
            );
          }
          dataByKey.set(
            request.key,
            data === null
              ? null
              : resolveCachedFieldVectorEnvelope(
                  fieldVectorCache,
                  request.key,
                  data,
                ),
          );
        } catch (error) {
          if (signal.aborted) throw error;
          firstError ??= error;
          requestFailures.push({
            cause: error,
            key: request.key,
            quantityId: request.quantityId,
            query: request.query,
            requestId: request.requestId ?? request.key,
          });
          failureByKey.set(request.key, airboxFieldVectorFailure(error));
          const cached = fieldVectorCache.peek(request.key);
          dataByKey.set(
            request.key,
            cached
              ? resolveCachedFieldVectorEnvelope(
                  fieldVectorCache,
                  request.key,
                  cached.data,
                )
              : null,
          );
        }
          return request.key;
        },
        { selectedTargetId: options.selectedTargetId, signal },
      );
      const entries = Array.from(requests, ([partId, request]) => [
        partId,
        dataByKey.get(request.key) ?? null,
      ] as const);
      const partFailures = new Map<
        string,
        Viewport3DAirboxFieldVectorPartFailure
      >();
      for (const [partId, request] of requests) {
        const failure = failureByKey.get(request.key);
        if (failure) partFailures.set(partId, failure);
      }
      for (const [partId, request] of requests) {
        const envelope = dataByKey.get(request.key);
        if (envelope) {
          rememberLastGoodFieldVectorRequestKey(
            "airbox",
            partId,
            envelope.resourceKey,
          );
        }
      }

      const partial = new Map(
        entries.filter(
          (entry): entry is readonly [string, CachedFieldVectorEnvelope] =>
            entry[1] !== null,
        ),
      );
      if (firstError) {
        const partialError = createViewport3DFieldVectorPartialLoadError({
          cause: firstError,
          message: "One or more Airbox field vectors are not ready",
          partialData: partial,
          requestFailures,
        });
        (partialError as unknown as Viewport3DAirboxFieldVectorPartialLoadError).partFailures =
          partFailures;
        throw partialError;
      }
      return partial;
    },
    [api, options.selectedTargetId, requests, resources],
  );
  const resolveRevision = useCallback(() => {
    const revisions = Array.from(requests.values()).map(
      (request) => fieldVectorCache.peek(request.key)?.etag ?? "missing",
    );
    return revisions.length > 0 ? revisions.join("|") : null;
  }, [requests]);

  const resource = useResource({
    abortStaleInflight: true,
    enabled: enabled && requests.size > 0,
    load,
    minRefetchIntervalMs: fieldVectorMinRefetchIntervalMs(),
    pauseLoad: options.pauseLoad,
    retryPolicy: FIELD_VECTOR_RETRY_POLICY,
    resolveRevision,
    resourceKey,
  });
  const previousFieldVectorEnvelopes = useMemo(
    () => resolveLastGoodFieldVectorCollectionFromCache("airbox", requests),
    [requests],
  );
  const fieldVectorEnvelopes = useMemo(
    () =>
      resolveViewport3DFieldVectorCollectionLastGood({
        current: resource.data,
        previous: previousFieldVectorEnvelopes,
        requests,
        status: resource.status,
      }),
    [previousFieldVectorEnvelopes, requests, resource.data, resource.status],
  );
  const partStates = useMemo(
    () =>
      resolveViewport3DAirboxFieldVectorPartStates({
        current: resource.data,
        displayed: fieldVectorEnvelopes,
        failures: airboxPartFailuresFromError(resource.error),
        previous: previousFieldVectorEnvelopes,
        requests,
        status: resource.status,
      }),
    [
      fieldVectorEnvelopes,
      previousFieldVectorEnvelopes,
      requests,
      resource.data,
      resource.error,
      resource.status,
    ],
  );
  const data = useMemo(
    () =>
      new Map(
        Array.from(fieldVectorEnvelopes, ([partId, envelope]) => [
          partId,
          envelope.data,
        ]),
      ),
    [fieldVectorEnvelopes],
  );
  const payloadRevision = useMemo(
    () =>
      fieldVectorEnvelopes.size > 0
        ? Array.from(
            fieldVectorEnvelopes.values(),
            (envelope) => envelope.etag ?? "missing",
          ).join("|")
        : null,
    [fieldVectorEnvelopes],
  );
  return {
    ...resource,
    data,
    partStates,
    payloadRevision,
  };
}

function isViewport3DAirboxFieldVectorRequestMap(
  value:
    | FieldVectorQuery
    | ReadonlyMap<string, Viewport3DAirboxFieldVectorSourceRequest>,
): value is ReadonlyMap<string, Viewport3DAirboxFieldVectorSourceRequest> {
  return typeof (value as { entries?: unknown }).entries === "function";
}

function normalizeViewport3DAirboxFieldVectorRequest(
  request: Viewport3DAirboxFieldVectorSourceRequest,
): Viewport3DAirboxFieldVectorRequest {
  if ("key" in request) return request;
  return {
    consumers: request.consumers,
    key: resolveViewport3DFieldVectorRequestResourceKey(request),
    quantityId: request.quantityId,
    query: request.query,
    requestId: request.requestId,
  };
}

export function useViewport3DQuantityFieldVectors(
  quantitySource:
    | readonly string[]
    | ReadonlyMap<string, FieldVectorQuery | Viewport3DFieldResourceRequest>,
  enabled = true,
  options: { pauseLoad?: boolean; selectedTargetId?: string | null } = {},
) {
  const { api, resources } = useKernel();
  const sessionIdentity = useViewport3DSessionIdentity();
  const unscopedRequestKeys = useMemo(() => {
    if (Array.isArray(quantitySource)) {
      const quantityIds = quantitySource as readonly string[];
      return new Map(
        Array.from(resolveViewport3DQuantityFieldVectorResourceKeys(quantityIds))
          .map(([quantityId, key]) => [
            quantityId,
            {
              key,
              quantityId,
              query: FULL_FIELD_VECTOR_QUERY,
            },
          ]),
      );
    }

    return resolveViewport3DQuantityFieldVectorResourceRequests(
      quantitySource as ReadonlyMap<
        string,
        FieldVectorQuery | Viewport3DFieldResourceRequest
      >,
    );
  }, [quantitySource]);
  const requestKeys = useMemo(
    () => scopeViewport3DFieldVectorRequests(unscopedRequestKeys, sessionIdentity),
    [sessionIdentity, unscopedRequestKeys],
  );
  const resourceKey = useMemo(() => {
    return resolveViewport3DFieldVectorCollectionResourceKey(
      "quantity",
      Array.from(requestKeys.values(), (request) => request.key),
    );
  }, [requestKeys]);
  const load = useCallback(
    async ({ signal }: { signal: AbortSignal }) => {
      const entries: Array<readonly [string, CachedFieldVectorEnvelope | null]> = [];
      const requestFailures: Viewport3DFieldVectorRequestFailure[] = [];
      let firstError: unknown = null;
      await loadViewport3DFieldRequestsBounded(
        Array.from(requestKeys, ([requestId, request]) => ({
          consumers: viewport3DFieldResourceRequestMetadata(request)?.consumers,
          request,
          requestId,
        })),
        async ({ requestId, request }) => {
        try {
          const data = await loadCachedBinaryResource(
            fieldVectorCache,
            request.key,
            (etag, requestSignal) =>
              api.data.fields.vector(
                request.quantityId,
                request.query,
                { etag, signal: requestSignal },
              ),
            {
              onFreshAdoption: recordFieldVectorCacheAdoption,
              preferCached: cachedBinaryResourceMatchesRevision(
                fieldVectorCache,
                request.key,
                resources.getRevision(request.unscopedKey),
              ),
              retainCachedOnNotApplicable: true,
              signal,
            },
          );
          if (data !== null) {
            invalidateViewport3DFieldMetaResources(
              resources,
              request.quantityId,
              fieldVectorCache.peek(request.key)?.etag ?? null,
            );
          }
          entries.push([
            requestId,
            data === null
              ? null
              : resolveCachedFieldVectorEnvelope(
                  fieldVectorCache,
                  request.key,
                  data,
                ),
          ]);
          const envelope = entries.at(-1)?.[1];
          if (envelope) {
            rememberLastGoodFieldVectorRequestKey(
              "quantity",
              requestId,
              envelope.resourceKey,
            );
          }
        } catch (error) {
          if (signal.aborted) throw error;
          firstError ??= error;
          requestFailures.push({
            cause: error,
            key: request.key,
            quantityId: request.quantityId,
            query: request.query,
            requestId,
          });
          const cached = fieldVectorCache.peek(request.key);
          entries.push([
            requestId,
            cached
              ? {
                  data: cached.data,
                  etag: cached.etag ?? null,
                  responseMetadata: cached.metadata ?? null,
                  resourceKey: request.key,
                }
              : null,
          ]);
        }
          return requestId;
        },
        { selectedTargetId: options.selectedTargetId, signal },
      );

      const partial = new Map(
        entries.filter(
          (entry): entry is readonly [string, CachedFieldVectorEnvelope] =>
            entry[1] !== null,
        ),
      );
      if (firstError) {
        throw createViewport3DFieldVectorPartialLoadError({
          cause: firstError,
          message: "One or more quantity field vectors are not ready",
          partialData: partial,
          requestFailures,
        });
      }
      return partial;
    },
    [api, options.selectedTargetId, requestKeys, resources],
  );
  const resolveRevision = useCallback(() => {
    const revisions = Array.from(requestKeys.values()).map(
      (request) => fieldVectorCache.peek(request.key)?.etag ?? "missing",
    );
    return revisions.length > 0 ? revisions.join("|") : null;
  }, [requestKeys]);

  const resource = useResource({
    abortStaleInflight: true,
    enabled: enabled && sessionIdentity !== null && requestKeys.size > 0,
    load,
    minRefetchIntervalMs: fieldVectorMinRefetchIntervalMs(),
    pauseLoad: options.pauseLoad,
    retryPolicy: FIELD_VECTOR_RETRY_POLICY,
    resolveRevision,
    resourceKey,
  });
  const previousFieldVectorEnvelopes = useMemo(
    () =>
      resolveLastGoodFieldVectorCollectionFromCache("quantity", requestKeys),
    [requestKeys],
  );
  const fieldVectorEnvelopes = useMemo(
    () =>
      resolveViewport3DFieldVectorCollectionLastGood({
        current: resource.data,
        previous: previousFieldVectorEnvelopes,
        requests: requestKeys,
        status: resource.status,
      }),
    [previousFieldVectorEnvelopes, requestKeys, resource.data, resource.status],
  );
  const data = useMemo(
    () =>
      fieldVectorEnvelopes
        ? new Map(
            Array.from(fieldVectorEnvelopes, ([requestId, envelope]) => [
              requestId,
              envelope.data,
            ]),
          )
        : null,
    [fieldVectorEnvelopes],
  );
  const requestStates = useMemo(
    () =>
      resolveViewport3DFieldVectorRequestStates({
        current: resource.data,
        displayed: fieldVectorEnvelopes,
        failures: fieldRequestFailuresFromError(resource.error),
        previous: previousFieldVectorEnvelopes,
        requests: requestKeys,
        status: resource.status,
      }),
    [
      fieldVectorEnvelopes,
      previousFieldVectorEnvelopes,
      requestKeys,
      resource.data,
      resource.error,
      resource.status,
    ],
  );
  const responseMetadataByRequestId = useMemo(
    () =>
      new Map(
        Array.from(fieldVectorEnvelopes ?? [], ([requestId, envelope]) => [
          requestId,
          envelope.responseMetadata,
        ]),
      ),
    [fieldVectorEnvelopes],
  );
  const payloadRevisionByRequestId = useMemo(
    () =>
      new Map(
        Array.from(fieldVectorEnvelopes ?? [], ([requestId, envelope]) => [
          requestId,
          envelope.etag ?? null,
        ]),
      ),
    [fieldVectorEnvelopes],
  );
  const payloadRevision = useMemo(
    () =>
      fieldVectorEnvelopes && fieldVectorEnvelopes.size > 0
        ? Array.from(
            fieldVectorEnvelopes.values(),
            (envelope) => envelope.etag ?? "missing",
          ).join("|")
        : null,
    [fieldVectorEnvelopes],
  );
  return {
    ...resource,
    data,
    payloadRevision,
    payloadRevisionByRequestId,
    requestStates,
    responseMetadataByRequestId,
  };
}

export function useViewport3DPartFieldVectors(
  partQueries: ReadonlyMap<
    string,
    { quantityId: string; query: FieldVectorQuery }
  >,
  enabled = true,
  options: { pauseLoad?: boolean; selectedTargetId?: string | null } = {},
) {
  const { api, resources } = useKernel();
  const sessionIdentity = useViewport3DSessionIdentity();
  const unscopedRequestKeys = useMemo(
    () => resolveViewport3DPartFieldVectorResourceRequests(partQueries),
    [partQueries],
  );
  const requestKeys = useMemo(
    () => scopeViewport3DFieldVectorRequests(unscopedRequestKeys, sessionIdentity),
    [sessionIdentity, unscopedRequestKeys],
  );
  const resourceKey = useMemo(() => {
    return resolveViewport3DFieldVectorCollectionResourceKey(
      "part",
      Array.from(requestKeys.values(), (request) => request.key),
    );
  }, [requestKeys]);
  const load = useCallback(
    async ({ signal }: { signal: AbortSignal }) => {
      const entries: Array<readonly [string, CachedFieldVectorEnvelope | null]> = [];
      const requestFailures: Viewport3DFieldVectorRequestFailure[] = [];
      let firstError: unknown = null;
      await loadViewport3DFieldRequestsBounded(
        Array.from(requestKeys, ([partId, request]) => ({
          consumers: request.consumers,
          partId,
          request,
        })),
        async ({ partId, request }) => {
        try {
          const data = await loadCachedBinaryResource(
            fieldVectorCache,
            request.key,
            (etag, requestSignal) =>
              api.data.fields.vector(
                request.quantityId,
                request.query,
                { etag, signal: requestSignal },
              ),
            {
              onFreshAdoption: recordFieldVectorCacheAdoption,
              preferCached: cachedBinaryResourceMatchesRevision(
                fieldVectorCache,
                request.key,
                resources.getRevision(request.unscopedKey),
              ),
              retainCachedOnNotApplicable: true,
              signal,
            },
          );
          if (data !== null) {
            invalidateViewport3DFieldMetaResources(
              resources,
              request.quantityId,
              fieldVectorCache.peek(request.key)?.etag ?? null,
            );
          }
          entries.push([
            partId,
            data === null
              ? null
              : resolveCachedFieldVectorEnvelope(
                  fieldVectorCache,
                  request.key,
                  data,
                ),
          ]);
          const envelope = entries.at(-1)?.[1];
          if (envelope) {
            rememberLastGoodFieldVectorRequestKey(
              "part",
              partId,
              envelope.resourceKey,
            );
          }
        } catch (error) {
          if (signal.aborted) throw error;
          firstError ??= error;
          requestFailures.push({
            cause: error,
            key: request.key,
            quantityId: request.quantityId,
            query: request.query,
            requestId: request.requestId ?? partId,
          });
          const cached = fieldVectorCache.peek(request.key);
          entries.push([
            partId,
            cached
              ? resolveCachedFieldVectorEnvelope(
                  fieldVectorCache,
                  request.key,
                  cached.data,
                )
              : null,
          ]);
        }
          return partId;
        },
        { selectedTargetId: options.selectedTargetId, signal },
      );

      const partial = new Map(
        entries.filter(
          (entry): entry is readonly [string, CachedFieldVectorEnvelope] =>
            entry[1] !== null,
        ),
      );
      if (firstError) {
        throw createViewport3DFieldVectorPartialLoadError({
          cause: firstError,
          message: "One or more mesh-part field vectors are not ready",
          partialData: partial,
          requestFailures,
        });
      }
      return partial;
    },
    [api, options.selectedTargetId, requestKeys, resources],
  );
  const resolveRevision = useCallback(() => {
    const revisions = Array.from(requestKeys.values()).map(
      (request) => fieldVectorCache.peek(request.key)?.etag ?? "missing",
    );
    return revisions.length > 0 ? revisions.join("|") : null;
  }, [requestKeys]);

  const resource = useResource({
    abortStaleInflight: true,
    enabled: enabled && sessionIdentity !== null && requestKeys.size > 0,
    load,
    minRefetchIntervalMs: fieldVectorMinRefetchIntervalMs(),
    pauseLoad: options.pauseLoad,
    retryPolicy: FIELD_VECTOR_RETRY_POLICY,
    resolveRevision,
    resourceKey,
  });
  const previousFieldVectorEnvelopes = useMemo(
    () => resolveLastGoodFieldVectorCollectionFromCache("part", requestKeys),
    [requestKeys],
  );
  const fieldVectorEnvelopes = useMemo(
    () =>
      resolveViewport3DFieldVectorCollectionLastGood({
        current: resource.data,
        previous: previousFieldVectorEnvelopes,
        requests: requestKeys,
        status: resource.status,
      }),
    [previousFieldVectorEnvelopes, requestKeys, resource.data, resource.status],
  );
  const data = useMemo(
    () =>
      new Map(
        Array.from(fieldVectorEnvelopes, ([partId, envelope]) => [
          partId,
          envelope.data,
        ]),
      ),
    [fieldVectorEnvelopes],
  );
  const partStates = useMemo(
    () =>
      resolveViewport3DFieldVectorRequestStates({
        current: resource.data,
        displayed: fieldVectorEnvelopes,
        failures: fieldRequestFailuresFromError(resource.error),
        previous: previousFieldVectorEnvelopes,
        requests: requestKeys,
        status: resource.status,
      }),
    [
      fieldVectorEnvelopes,
      previousFieldVectorEnvelopes,
      requestKeys,
      resource.data,
      resource.error,
      resource.status,
    ],
  );
  const payloadRevision = useMemo(
    () =>
      fieldVectorEnvelopes.size > 0
        ? Array.from(
            fieldVectorEnvelopes.values(),
            (envelope) => envelope.etag ?? "missing",
          ).join("|")
        : null,
    [fieldVectorEnvelopes],
  );
  return {
    ...resource,
    data,
    partStates,
    payloadRevision,
  };
}

export function useViewport3DMeshQualityData(enabled = true) {
  const { api } = useKernel();
  const sessionIdentity = useViewport3DSessionIdentity();
  const resourceKey = sessionIdentity
    ? sessionScopedResourceKey(
        sessionIdentity,
        VIEWPORT_3D_SHARED_DOMAIN_QUALITY_DATA_RESOURCE_KEY,
      )
    : VIEWPORT_3D_SHARED_DOMAIN_QUALITY_DATA_RESOURCE_KEY;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      loadCachedBinaryResource(
        qualityDataCache,
        resourceKey,
        (etag, requestSignal) =>
          api.meshing.sharedDomain.qualityData({
            etag,
            signal: requestSignal,
          }),
        { signal },
      ),
    [api, resourceKey],
  );

  return useResource({
    enabled: enabled && sessionIdentity !== null,
    load,
    resolveRevision: () => qualityDataCache.peek(resourceKey)?.etag ?? null,
    resourceKey,
  });
}

export function useViewport3DSharedDomainManifest() {
  const { api } = useKernel();
  const sessionIdentity = useViewport3DSessionIdentity();
  const resourceKey = sessionIdentity
    ? sessionScopedResourceKey(
        sessionIdentity,
        VIEWPORT_3D_SHARED_DOMAIN_MANIFEST_RESOURCE_KEY,
      )
    : VIEWPORT_3D_SHARED_DOMAIN_MANIFEST_RESOURCE_KEY;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.meshing.sharedDomainManifest({ signal }),
    [api],
  );

  return useResource({
    enabled: sessionIdentity !== null,
    load,
    resolveRevision: resolveSharedDomainManifestRevision,
    resourceKey,
  });
}

export function useViewport3DScene() {
  const { api } = useKernel();
  const sessionIdentity = useViewport3DSessionIdentity();
  const resourceKey = sessionIdentity
    ? sessionScopedResourceKey(sessionIdentity, VIEWPORT_3D_SCENE_RESOURCE_KEY)
    : VIEWPORT_3D_SCENE_RESOURCE_KEY;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => api.model.scene({ signal }),
    [api],
  );

  return useResource({
    enabled: sessionIdentity !== null,
    load,
    resourceKey,
  });
}

export function useViewport3DUniverse() {
  const { api } = useKernel();
  const sessionIdentity = useViewport3DSessionIdentity();
  const resourceKey = sessionIdentity
    ? sessionScopedResourceKey(sessionIdentity, VIEWPORT_3D_UNIVERSE_RESOURCE_KEY)
    : VIEWPORT_3D_UNIVERSE_RESOURCE_KEY;
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) => api.model.universe({ signal }),
    [api],
  );

  return useResource({
    enabled: sessionIdentity !== null,
    load,
    resolveRevision: resolveUniverseRevision,
    resourceKey,
  });
}
