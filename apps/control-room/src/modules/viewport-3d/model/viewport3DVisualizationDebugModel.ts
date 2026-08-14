import type { DecodedFieldVector } from "@/kernel/api/codecs";
import { fieldVectorComponentsSemanticallyEqual } from "@/kernel/api/fieldQueryIdentity";
import {
  buildVisualizationDebugHealth,
  prioritizeAndBoundVisualizationDebugIssues,
  type VisualizationDebugHealthEvidence,
} from "@/kernel/visualization/buildVisualizationDebugHealth";
import type {
  VisualizationDebugCarrierSnapshot,
  VisualizationDebugIssue,
  VisualizationDebugMemoryRow,
  VisualizationDebugNumericStats,
  VisualizationDebugSnapshot,
} from "@/kernel/visualization/visualizationDebugTypes";

import type { ScalarRangeDiagnostics } from "../viewport3dFieldMapping";
import type {
  Viewport3DFieldVectorCacheBudgetDiagnostics,
  Viewport3DFieldVectorCacheEntryDiagnostics,
} from "../viewport3dResources";
import { buildFieldVectorDebugSamples } from "./scanFieldVectorDebugStatistics";
import { resolveTrustedViewport3DResponseDomainGenerationId } from "./viewport3DFieldDomainCompatibility";

const MAX_DEBUG_CARRIERS = 8;
const MAX_DEBUG_TEXT_LENGTH = 256;
const MAX_DEBUG_ISSUES = 20;
const MAX_DEBUG_REQUESTED_PASSES = 8;
const MAX_DEBUG_SNAPSHOT_BYTES = 64 * 1024;
const textEncoder = new TextEncoder();

export interface Viewport3DVisualizationDebugCarrierInput {
  cache: Viewport3DFieldVectorCacheEntryDiagnostics | null;
  carrierId: string;
  carrierRole: string;
  decoded: DecodedFieldVector | null;
  expectedDomainGenerationId?: string | null;
  expectedTopologyHash?: string | null;
  fieldBufferId?: string | null;
  fieldBufferRevision?: string | null;
  fieldBufferState: string;
  fieldRevision?: string | null;
  geometryMaskDescription?: string | null;
  plannerRequestId?: string | null;
  rangeDiagnostics?: ScalarRangeDiagnostics | null;
  rangeDiagnosticsComponent?: string | null;
  renderedComponent: string | null;
  requestIdentityKnown: boolean;
  requestedComponent: string;
  requestedPasses: readonly ("surface" | "vector-glyph")[];
  requestedQuantityId: string;
  requestedScopeId: string | null;
  requestedScopeKind: string;
  requestedSnapshotId?: string | null;
  resourceKey?: string | null;
  scalarBufferByteLength?: number | null;
  scalarBufferKey?: string | null;
  scanState: "cancelled" | "complete" | "scanning" | "unavailable";
  scannedStats?: VisualizationDebugNumericStats | null;
  surfaceDegradation: string | null;
  surfaceProjectionMode: string | null;
  surfaceAdoptedAtMs: number | null;
  surfaceAdoptedFieldBufferId: string | null;
  surfaceAdoptedResourceKey: string | null;
  surfaceAdoptedScalarBufferKey: string | null;
  surfaceAdoptionSequence: number | null;
  topologyByteLength?: number | null;
  vectorBuildKey?: string | null;
  vectorDegradation: string | null;
  vectorAdoptedAtMs: number | null;
  vectorAdoptedBuildKey: string | null;
  vectorAdoptedFieldBufferId: string | null;
  vectorAdoptedItemCount: number | null;
  vectorAdoptedResourceKey: string | null;
  vectorAdoptionSequence: number | null;
  vectorSegmentByteLength?: number | null;
  vectorSegmentCount?: number | null;
  webglSharedByteLength?: number | null;
}

export interface Viewport3DVisualizationDebugModelInput {
  capturedAtMs: number;
  carriers: readonly Viewport3DVisualizationDebugCarrierInput[];
  fieldCacheBudget: Viewport3DFieldVectorCacheBudgetDiagnostics;
  frame: {
    airboxVectorsVisible?: boolean;
    airboxWireframeVisible?: boolean;
    committedAtMs: number;
    commitId: string;
    contextLost: boolean | null;
    drawingBuffer: readonly [number, number] | null;
    viewportId: string;
  };
  target: { id: string; kind: "airbox" | "object" | "region"; label: string };
  visualizationRevision: string | null;
  webglSharedByteLength: number | null;
}

interface BuildOwnershipState {
  readonly buffers: Set<ArrayBufferLike>;
  readonly cacheKeys: Set<string>;
  readonly referencedKeys: Set<string>;
  ownedByteLength: number;
  referencedAttributionKnown: boolean;
  referencedByteLength: number;
  remainingSamples: number;
}

export function buildViewport3DVisualizationDebugSnapshot(
  input: Viewport3DVisualizationDebugModelInput,
): VisualizationDebugSnapshot {
  const state: BuildOwnershipState = {
    buffers: new Set(),
    cacheKeys: new Set(),
    referencedKeys: new Set(),
    ownedByteLength: 0,
    referencedAttributionKnown: true,
    referencedByteLength: 0,
    remainingSamples: 12,
  };
  const carriers: VisualizationDebugCarrierSnapshot[] = [];
  const issues: VisualizationDebugIssue[] = [];
  let disposition: VisualizationDebugSnapshot["disposition"] = "ready";

  const carrierInputs = Array.isArray(input.carriers) ? input.carriers : [];
  for (const carrier of carrierInputs.slice(0, MAX_DEBUG_CARRIERS)) {
    const built = buildCarrier(carrier, input, state);
    carriers.push(built.snapshot);
    issues.push(...built.issues);
    disposition = combineDisposition(disposition, built.disposition);
  }
  if (input.carriers.length === 0) {
    const health = buildVisualizationDebugHealth({
      ...completeHealthEvidence(),
      evidenceComplete: false,
      targetActive: false,
    });
    issues.push(...health.issues);
    disposition = health.disposition;
  }

  const webglSharedByteLength = safeNullableByteLength(input.webglSharedByteLength);
  const sharedMemory = Object.freeze<VisualizationDebugMemoryRow[]>([
    memoryRow("field-cache-budget", "Field vector cache accounting", safeNullableByteLength(input.fieldCacheBudget.byteLength), "estimated", "cache"),
    memoryRow(
      "webgl",
      "WebGL resources without certain target attribution",
      webglSharedByteLength,
      "shared",
      "webgl-shared",
    ),
  ]);
  const snapshot: VisualizationDebugSnapshot = Object.freeze({
    capturedAtMs: safeNumber(input.capturedAtMs),
    carriers: Object.freeze(carriers),
    disposition,
    issues: prioritizeAndBoundVisualizationDebugIssues(issues, MAX_DEBUG_ISSUES),
    memoryTotals: Object.freeze({
      owned: state.ownedByteLength,
      referenced: state.referencedAttributionKnown
        ? state.referencedByteLength
        : null,
      shared: webglSharedByteLength,
    }),
    ownedByteLength: state.ownedByteLength,
    sharedMemory,
    target: Object.freeze({
      carrierIds: Object.freeze(carriers.map((carrier) => carrier.carrierId)),
      id: boundText(input.target.id),
      kind: safeTargetKind(input.target.kind),
      label: boundText(input.target.label),
    }),
    viewport: Object.freeze({
      ...(typeof input.frame.airboxVectorsVisible === "boolean"
        ? { airboxVectorsVisible: input.frame.airboxVectorsVisible }
        : {}),
      ...(typeof input.frame.airboxWireframeVisible === "boolean"
        ? { airboxWireframeVisible: input.frame.airboxWireframeVisible }
        : {}),
      contextLost: typeof input.frame.contextLost === "boolean" ? input.frame.contextLost : null,
      drawingBuffer: safeDrawingBuffer(input.frame.drawingBuffer),
      frameCommittedAtMs: safeNumber(input.frame.committedAtMs),
      frameCommitId: boundText(input.frame.commitId),
      viewportId: boundText(input.frame.viewportId),
    }),
    version: 1,
  });
  return enforceViewport3DVisualizationDebugSnapshotLimit(snapshot);
}

export function enforceViewport3DVisualizationDebugSnapshotLimit(
  snapshot: VisualizationDebugSnapshot,
): VisualizationDebugSnapshot {
  const byteLength = serializedByteLength(snapshot);
  return byteLength <= MAX_DEBUG_SNAPSHOT_BYTES
    ? snapshot
    : buildSizeLimitSnapshot(snapshot, byteLength);
}

function buildCarrier(
  carrier: Viewport3DVisualizationDebugCarrierInput,
  input: Viewport3DVisualizationDebugModelInput,
  state: BuildOwnershipState,
): { disposition: VisualizationDebugSnapshot["disposition"]; issues: readonly VisualizationDebugIssue[]; snapshot: VisualizationDebugCarrierSnapshot } {
  const decoded = carrier.decoded;
  const requestedPasses = boundedRequestedPasses(carrier.requestedPasses);
  const sampleResult = decoded
    ? buildFieldVectorDebugSamples({ nComp: decoded.nComp, nodeIndices: decoded.nodeIndices, pointCount: decoded.pointCount, values: decoded.values })
    : { issues: Object.freeze([]), samples: Object.freeze([]) };
  const samples = Object.freeze(sampleResult.samples.slice(0, state.remainingSamples));
  state.remainingSamples -= samples.length;
  const statistics = buildStatistics(carrier);
  const health = buildVisualizationDebugHealth(buildHealthEvidence(carrier, input, statistics));
  const responseMetadataIssues = buildResponseMetadataIdentityIssues(carrier);
  const memory = buildMemory(carrier, state);
  const cache = carrier.cache;
  const domainGenerationId = decoded
    ? resolveTrustedViewport3DResponseDomainGenerationId(
        decoded,
        cache?.responseMetadata,
      )
    : null;

  return {
    disposition: health.disposition,
    issues: Object.freeze([
      ...health.issues,
      ...responseMetadataIssues,
      ...sampleResult.issues,
    ]),
    snapshot: Object.freeze({
      cache: Object.freeze({
        byteLength: safeNullableByteLength(cache?.byteLength),
        dataIdentityMatches:
          typeof cache?.dataIdentityMatches === "boolean"
            ? cache.dataIdentityMatches
            : null,
        entryState: safeCacheEntryState(cache?.entryState),
        etag: boundNullableText(cache?.etag),
        fieldCacheByteLength: safeByteLength(input.fieldCacheBudget.byteLength),
        fieldCacheEntryCount: safeCount(input.fieldCacheBudget.entryCount),
        fieldCacheMaxBytes: safeByteLength(input.fieldCacheBudget.maxBytes),
        retainCount: safeCount(cache?.retainCount ?? 0),
      }),
      carrierId: boundText(carrier.carrierId),
      carrierRole: boundText(carrier.carrierRole),
      geometryMaskDescription: boundNullableText(carrier.geometryMaskDescription),
      memory,
      payload: decoded ? Object.freeze({
        component: null,
        dtype: "float64",
        formatVersion: decoded.formatVersion === 2 || decoded.formatVersion === 3 ? decoded.formatVersion : null,
        grid: Object.freeze(decoded.grid.map(safeCount)) as unknown as readonly [number, number, number],
        indexing: boundText(decoded.indexing ?? "legacy_count_only"),
        nComp: safeCount(decoded.nComp),
        nodeIndexCount: decoded.nodeIndices ? safeCount(decoded.nodeIndices.length) : null,
        pointCount: safeCount(decoded.pointCount),
        quantityId: boundText(decoded.quantityId),
        scopeId: boundNullableText(decoded.scopeId),
        scopeKind: boundNullableText(decoded.scopeKind),
        valueCount: safeCount(decoded.valueCount),
      }) : null,
      render: Object.freeze({
        adoption: Object.freeze({
          frameCommitId: input.frame.commitId ? boundText(input.frame.commitId) : null,
          surface: Object.freeze({
            adoptedAtMs: safeNullableByteLength(carrier.surfaceAdoptedAtMs),
            adoptedFieldBufferId: boundNullableText(carrier.surfaceAdoptedFieldBufferId),
            adoptedResourceKey: boundNullableText(carrier.surfaceAdoptedResourceKey),
            adoptedScalarBufferKey: boundNullableText(carrier.surfaceAdoptedScalarBufferKey),
            adoptionSequence:
              carrier.surfaceAdoptionSequence == null
                ? null
                : safeCount(carrier.surfaceAdoptionSequence),
          }),
          vector: Object.freeze({
            adoptedAtMs: safeNullableByteLength(carrier.vectorAdoptedAtMs),
            adoptedFieldBufferId: boundNullableText(carrier.vectorAdoptedFieldBufferId),
            adoptedResourceKey: boundNullableText(carrier.vectorAdoptedResourceKey),
            adoptedVectorBuildKey: boundNullableText(carrier.vectorAdoptedBuildKey),
            adoptedVectorItemCount:
              carrier.vectorAdoptedItemCount == null
                ? null
                : safeCount(carrier.vectorAdoptedItemCount),
            adoptionSequence:
              carrier.vectorAdoptionSequence == null
                ? null
                : safeCount(carrier.vectorAdoptionSequence),
          }),
        }),
        fieldBufferState: boundText(carrier.fieldBufferState),
        requestedFieldBufferId: boundNullableText(carrier.fieldBufferId),
        requestedPasses,
        surface: Object.freeze({ bufferKey: boundNullableText(carrier.scalarBufferKey), colorMode: requestedPasses.includes("surface") ? boundNullableText(carrier.renderedComponent) : null, degradation: boundNullableText(carrier.surfaceDegradation), projectionMode: boundNullableText(carrier.surfaceProjectionMode), scalarByteLength: safeNullableByteLength(carrier.scalarBufferByteLength) }),
        vectors: Object.freeze({ buildKey: boundNullableText(carrier.vectorBuildKey), degradation: boundNullableText(carrier.vectorDegradation), segmentByteLength: safeNullableByteLength(carrier.vectorSegmentByteLength), segmentCount: carrier.vectorSegmentCount == null ? null : safeCount(carrier.vectorSegmentCount) }),
      }),
      request: Object.freeze({ plannerRequestId: boundNullableText(carrier.plannerRequestId), resourceKey: boundNullableText(carrier.resourceKey) }),
      revisions: Object.freeze({
        domainGenerationId: boundNullableText(domainGenerationId),
        fieldBufferRevision: boundNullableText(carrier.fieldBufferRevision),
        fieldRevision: boundNullableText(carrier.fieldRevision),
        meshTopologyHash: boundNullableText(
          cache?.responseMetadata?.meshTopologyHash ?? decoded?.meshTopologyHash,
        ),
        topologyRevision: boundNullableText(decoded?.meshTopologyRevision),
        visualizationRevision: boundNullableText(input.visualizationRevision),
      }),
      samples,
      scanState: carrier.scanState,
      statistics,
    }),
  };
}

function buildHealthEvidence(
  carrier: Viewport3DVisualizationDebugCarrierInput,
  input: Viewport3DVisualizationDebugModelInput,
  statistics: readonly VisualizationDebugNumericStats[],
): VisualizationDebugHealthEvidence {
  const decoded = carrier.decoded;
  const stats = statistics.find((item) => item.source === "decoded-payload" || item.source === "render-derived");
  const explicitIndexing = decoded?.indexing === "explicit_node_indices" || decoded?.indexing === "sampled_node_indices";
  const domainGenerationMatches = compareWhenKnown(
    decoded?.domainGenerationId,
    carrier.expectedDomainGenerationId,
  );
  const fieldRevisionCurrent = !fieldRequired(carrier)
    ? true
    : carrier.cache?.dataIdentityMatches === false ||
        (carrier.fieldBufferRevision != null &&
          carrier.cache?.etag != null &&
          carrier.fieldBufferRevision !== carrier.cache.etag)
      ? false
      : carrier.cache?.dataIdentityMatches === true &&
          carrier.fieldBufferRevision != null &&
          carrier.cache.etag != null &&
          carrier.fieldRevision != null
        ? true
        : null;
  const responseMetadataMatches = compareResponseMetadata(carrier);
  const topologyHashMatches = compareWhenKnown(
    decoded?.meshTopologyHash,
    carrier.expectedTopologyHash,
  );
  const surfaceAdoptionRequired = hasRequestedPass(carrier, "surface");
  const vectorAdoptionRequired = hasRequestedPass(carrier, "vector-glyph");
  const surfaceAdoptionComplete =
    !surfaceAdoptionRequired ||
    (carrier.surfaceAdoptedFieldBufferId != null &&
      carrier.fieldBufferId != null &&
      carrier.surfaceAdoptedScalarBufferKey != null &&
      carrier.scalarBufferKey != null);
  const vectorAdoptionComplete =
    !vectorAdoptionRequired ||
    (carrier.vectorAdoptedFieldBufferId != null &&
      carrier.fieldBufferId != null &&
      carrier.vectorAdoptedBuildKey != null &&
      carrier.vectorBuildKey != null);
  const surfaceAdoptionMismatch =
    surfaceAdoptionRequired &&
    (knownIdentityMismatch(
      carrier.surfaceAdoptedFieldBufferId,
      carrier.fieldBufferId,
    ) ||
      knownIdentityMismatch(
        carrier.surfaceAdoptedScalarBufferKey,
        carrier.scalarBufferKey,
      ) ||
      knownIdentityMismatch(
        carrier.surfaceAdoptedResourceKey,
        carrier.resourceKey,
      ));
  const vectorAdoptionMismatch =
    vectorAdoptionRequired &&
    (knownIdentityMismatch(
      carrier.vectorAdoptedFieldBufferId,
      carrier.fieldBufferId,
    ) ||
      knownIdentityMismatch(
        carrier.vectorAdoptedBuildKey,
        carrier.vectorBuildKey,
      ) ||
      knownIdentityMismatch(
        carrier.vectorAdoptedResourceKey,
        carrier.resourceKey,
      ));
  const surfaceAdoptionMatches = !surfaceAdoptionRequired
    ? true
    : surfaceAdoptionMismatch
      ? false
      : !surfaceAdoptionComplete
        ? null
        : true;
  const vectorAdoptionMatches = !vectorAdoptionRequired
    ? true
    : vectorAdoptionMismatch
      ? false
      : !vectorAdoptionComplete
        ? null
        : true;
  const adoptionEvidenceComplete =
    surfaceAdoptionComplete &&
    vectorAdoptionComplete;
  const adoptedSourceMatches =
    surfaceAdoptionMatches === false || vectorAdoptionMatches === false
      ? false
      : surfaceAdoptionMatches === null || vectorAdoptionMatches === null
        ? null
        : true;
  return {
    ...completeHealthEvidence(),
    adoptedSourceMatches,
    backendRenderRangeMatches: null,
    domainGenerationMatches,
    evidenceComplete: Boolean(
      decoded &&
      input.frame.commitId &&
      decoded.formatVersion === 3 &&
      carrier.requestIdentityKnown &&
      decoded.indexing &&
      decoded.scopeKind &&
      decoded.domainGenerationId != null &&
      decoded.meshTopologyHash != null &&
      decoded.meshTopologyRevision != null &&
      (decoded.scopeKind === "full" || decoded.scopeId != null) &&
      domainGenerationMatches !== null &&
      fieldRevisionCurrent !== null &&
      responseMetadataMatches !== null &&
      topologyHashMatches !== null &&
      carrier.scanState !== "scanning" &&
      carrier.scanState !== "cancelled" &&
      adoptionEvidenceComplete,
    ),
    fieldBufferPresent: !fieldRequired(carrier) || carrier.fieldBufferId != null,
    fieldRequestOk: true,
    fieldRevisionCurrent,
    frameCommitted: Boolean(input.frame.commitId),
    nodeIndexCountMatches: !decoded || !explicitIndexing ? true : decoded.nodeIndices?.length === decoded.pointCount,
    quantityMatches: !decoded || !carrier.requestIdentityKnown
      ? null
      : canonical(decoded.quantityId) === canonical(carrier.requestedQuantityId),
    rangeNotOutlierDominated: matchingRangeDiagnostics(carrier)?.outlierDominated === undefined
      ? null
      : !matchingRangeDiagnostics(carrier)!.outlierDominated,
    responseMetadataMatches,
    scopeIdMatches:
      !decoded || !carrier.requestIdentityKnown
        ? null
        : decoded.scopeKind == null && decoded.scopeId == null
          ? null
          : (decoded.scopeId ?? null) === carrier.requestedScopeId,
    scopeKindMatches: !decoded || !carrier.requestIdentityKnown
      ? null
      : compareWhenKnown(decoded.scopeKind, carrier.requestedScopeKind),
    surfacePassPresent: !hasRequestedPass(carrier, "surface") || carrier.scalarBufferByteLength != null,
    targetActive: true,
    topologyHashMatches,
    transportCacheBytesMatch: null,
    valueCountMatches: !decoded || decoded.pointCount * decoded.nComp === decoded.valueCount,
    valueStatisticsSource: stats?.source ?? null,
    valuesAllZero: stats ? stats.finiteCount > 0 && stats.zeroCount === stats.finiteCount : null,
    valuesFinite: stats ? stats.nonFiniteCount === 0 : null,
    vectorPassPresent: !hasRequestedPass(carrier, "vector-glyph") || carrier.vectorSegmentByteLength != null,
  };
}

function completeHealthEvidence(): VisualizationDebugHealthEvidence {
  return {
    adoptedSourceMatches: true, backendRenderRangeMatches: null, domainGenerationMatches: true,
    evidenceComplete: true, fieldBufferPresent: true, fieldRequestOk: true, fieldRevisionCurrent: true,
    frameCommitted: true, nodeIndexCountMatches: true, quantityMatches: true, rangeNotOutlierDominated: null,
    responseMetadataMatches: true, scopeIdMatches: true, scopeKindMatches: true, surfacePassPresent: true,
    targetActive: true, topologyHashMatches: true, transportCacheBytesMatch: null, valueCountMatches: true,
    valueStatisticsSource: null,
    valuesAllZero: null, valuesFinite: null, vectorPassPresent: true,
  };
}

function buildStatistics(carrier: Viewport3DVisualizationDebugCarrierInput): readonly VisualizationDebugNumericStats[] {
  const stats: VisualizationDebugNumericStats[] = [];
  const rangeDiagnostics = matchingRangeDiagnostics(carrier);
  if (rangeDiagnostics) stats.push(Object.freeze({
    finiteCount: safeCount(rangeDiagnostics.finiteCount), max: safeNullableNumber(rangeDiagnostics.max), mean: safeNullableNumber(rangeDiagnostics.mean),
    min: safeNullableNumber(rangeDiagnostics.min), nonFiniteCount: safeCount(rangeDiagnostics.nonFiniteCount),
    p01: safeNullableNumber(rangeDiagnostics.p01), p99: safeNullableNumber(rangeDiagnostics.p99), source: "render-derived", zeroCount: safeCount(rangeDiagnostics.zeroCount),
  }));
  else if (carrier.scannedStats) {
    const scannedStats = sanitizeStats(carrier.scannedStats);
    stats.push(
      carrier.decoded
        ? scannedStats
        : Object.freeze({ ...scannedStats, source: "render-derived" }),
    );
  }
  return Object.freeze(stats);
}

function matchingRangeDiagnostics(
  carrier: Viewport3DVisualizationDebugCarrierInput,
): ScalarRangeDiagnostics | null {
  if (!carrier.rangeDiagnostics) return null;
  return carrier.rangeDiagnosticsComponent != null &&
    carrier.renderedComponent != null &&
    fieldVectorComponentsSemanticallyEqual(
      carrier.rangeDiagnosticsComponent,
      carrier.renderedComponent,
    )
    ? carrier.rangeDiagnostics
    : null;
}

function buildMemory(carrier: Viewport3DVisualizationDebugCarrierInput, state: BuildOwnershipState): readonly VisualizationDebugMemoryRow[] {
  const decoded = carrier.decoded;
  const rows: VisualizationDebugMemoryRow[] = [];
  rows.push(memoryRow("wire", "Wire transfer size", null, "estimated", "transport"));
  rows.push(memoryRow("cache", "Cache accounting", safeNullableByteLength(carrier.cache?.byteLength), "estimated", "cache"));
  addBufferRow(rows, state, "values", "Decoded values", decoded?.values ?? null, "decoded-payload");
  addBufferRow(rows, state, "node-indices", "Decoded node indices", ArrayBuffer.isView(decoded?.nodeIndices) ? decoded.nodeIndices : null, "decoded-payload", decoded?.nodeIndices && !ArrayBuffer.isView(decoded.nodeIndices) ? decoded.nodeIndices.length * 8 : null);
  addOwnedRow(rows, state, "scalar-buffer", "Scalar color buffer", carrier.scalarBufferByteLength ?? null, "render-derived", carrier.scalarBufferKey ? `scalar:${carrier.scalarBufferKey}` : null);
  addOwnedRow(rows, state, "vector-segments", "Vector segments", carrier.vectorSegmentByteLength ?? null, "render-derived", carrier.vectorBuildKey ? `vector:${carrier.vectorBuildKey}` : null);
  const topologyByteLength = safeNullableByteLength(carrier.topologyByteLength);
  rows.push(memoryRow("topology", "Referenced topology", topologyByteLength, "referenced", "render-derived"));
  const topologyIdentity = carrier.expectedTopologyHash ? `topology:${carrier.expectedTopologyHash}` : null;
  if (topologyByteLength == null || !topologyIdentity) {
    state.referencedAttributionKnown = false;
  } else if (!state.referencedKeys.has(topologyIdentity)) {
    state.referencedKeys.add(topologyIdentity);
    state.referencedByteLength = safeAddByteLength(state.referencedByteLength, topologyByteLength);
  }
  return Object.freeze(rows);
}

function compareResponseMetadata(
  carrier: Viewport3DVisualizationDebugCarrierInput,
): boolean | null {
  const metadata = carrier.cache?.responseMetadata;
  const decoded = carrier.decoded;
  if (!metadata || !decoded) return null;
  const expectedEncoding = `FMVP;version=${decoded.formatVersion}`;
  const hasContradictoryIdentityIssue = metadata.identityIssues.some(
    (issue) =>
      !(
        decoded.formatVersion === 2 &&
        issue.field === "domainGenerationId" &&
        issue.payloadValue == null &&
        typeof issue.headerValue === "string" &&
        issue.headerValue.trim().length > 0
      ),
  );
  if (
    hasContradictoryIdentityIssue ||
    (metadata.component !== null &&
      !fieldVectorComponentsSemanticallyEqual(
        metadata.component,
        carrier.requestedComponent,
      )) ||
    (metadata.encoding !== null && metadata.encoding !== expectedEncoding) ||
    (carrier.requestedSnapshotId != null &&
      metadata.snapshotId !== null &&
      metadata.snapshotId !== carrier.requestedSnapshotId)
  ) {
    return false;
  }
  const complete =
    metadata.component !== null &&
    metadata.domainGenerationId !== null &&
    metadata.encoding !== null &&
    metadata.fieldIndexing !== null &&
    metadata.fieldRevision !== null &&
    metadata.meshTopologyHash !== null &&
    metadata.nComp !== null &&
    (decoded.indexing !== "explicit_node_indices" &&
      decoded.indexing !== "sampled_node_indices" ||
      metadata.nodeIndexCount !== null) &&
    metadata.pointCount !== null &&
    metadata.quantityId !== null &&
    metadata.valueCount !== null &&
    (carrier.requestedScopeKind === "full" ||
      (metadata.scopeKind !== null && metadata.scopeId !== null)) &&
    (carrier.requestedSnapshotId == null || metadata.snapshotId !== null);
  return complete ? true : null;
}

function buildResponseMetadataIdentityIssues(
  carrier: Viewport3DVisualizationDebugCarrierInput,
): readonly VisualizationDebugIssue[] {
  const issues: VisualizationDebugIssue[] = [];
  for (const identityIssue of carrier.cache?.responseMetadata?.identityIssues ?? []) {
    const code =
      identityIssue.field === "valueCount"
        ? "value-count-mismatch"
        : identityIssue.field === "nodeIndexCount"
          ? "node-index-count-mismatch"
          : null;
    if (!code) continue;
    issues.push(
      Object.freeze({
        code,
        evidence: Object.freeze([
          `header=${String(identityIssue.headerValue)}`,
          `payload=${String(identityIssue.payloadValue)}`,
        ]),
        message:
          identityIssue.field === "valueCount"
            ? "Response header value count differs from the decoded payload."
            : "Response header node-index count differs from the decoded payload.",
        severity: "error" as const,
        source: "transport" as const,
      }),
    );
  }
  return Object.freeze(issues);
}

function addBufferRow(rows: VisualizationDebugMemoryRow[], state: BuildOwnershipState, id: string, label: string, view: ArrayBufferView | null, source: VisualizationDebugMemoryRow["source"], fallback: number | null = null): void {
  const byteLength = safeNullableByteLength(view?.byteLength ?? fallback);
  const buffer = view?.buffer;
  const duplicate = buffer ? state.buffers.has(buffer) : false;
  if (buffer) state.buffers.add(buffer);
  rows.push(memoryRow(id, label, byteLength, duplicate ? "referenced" : "owned", source));
  if (!duplicate && buffer) state.ownedByteLength = safeAddByteLength(state.ownedByteLength, buffer.byteLength);
  else if (!duplicate && byteLength != null) state.ownedByteLength = safeAddByteLength(state.ownedByteLength, byteLength);
}

function addOwnedRow(rows: VisualizationDebugMemoryRow[], state: BuildOwnershipState, id: string, label: string, byteLength: number | null, source: VisualizationDebugMemoryRow["source"], identity: string | null): void {
  if (!identity) {
    rows.push(memoryRow(id, label, byteLength, "estimated", source));
    return;
  }
  const duplicate = identity ? state.cacheKeys.has(identity) : false;
  if (identity) state.cacheKeys.add(identity);
  rows.push(memoryRow(id, label, byteLength, duplicate ? "referenced" : "owned", source));
  if (!duplicate && byteLength != null) state.ownedByteLength = safeAddByteLength(state.ownedByteLength, byteLength);
}

function memoryRow(id: string, label: string, byteLength: number | null, ownership: VisualizationDebugMemoryRow["ownership"], source: VisualizationDebugMemoryRow["source"]): VisualizationDebugMemoryRow {
  return Object.freeze({ byteLength, id, label, ownership, source });
}

function compareWhenKnown(left: string | null | undefined, right: string | null | undefined): boolean | null {
  return left == null || right == null ? null : left === right;
}

function knownIdentityMismatch(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  return left != null && right != null && left !== right;
}

function canonical(value: string): string { return value.trim().toLowerCase().replaceAll("-", "_"); }

function boundText(value: string): string {
  if (typeof value !== "string") return "";
  if (textEncoder.encode(value).byteLength <= MAX_DEBUG_TEXT_LENGTH) return value;
  let result = "";
  let byteLength = 0;
  for (const character of value) {
    const bytes = textEncoder.encode(character).byteLength;
    if (byteLength + bytes > MAX_DEBUG_TEXT_LENGTH) break;
    result += character;
    byteLength += bytes;
  }
  return result;
}

function boundNullableText(value: string | null | undefined): string | null {
  return value == null ? null : boundText(value);
}

function combineDisposition(left: VisualizationDebugSnapshot["disposition"], right: VisualizationDebugSnapshot["disposition"]): VisualizationDebugSnapshot["disposition"] {
  const priority = { ready: 0, unknown: 1, degraded: 2, blocked: 3 } as const;
  return priority[right] > priority[left] ? right : left;
}

function fieldRequired(carrier: Viewport3DVisualizationDebugCarrierInput): boolean {
  return boundedRequestedPasses(carrier.requestedPasses).length > 0 ||
    Boolean(
      carrier.surfaceAdoptedFieldBufferId ||
      carrier.surfaceAdoptedScalarBufferKey ||
      carrier.vectorAdoptedFieldBufferId ||
      carrier.vectorAdoptedBuildKey
    ) ||
    carrier.fieldBufferState === "derived-global" || carrier.fieldBufferState === "target-buffer";
}

function hasRequestedPass(
  carrier: Viewport3DVisualizationDebugCarrierInput,
  pass: string,
): boolean {
  return boundedRequestedPasses(carrier.requestedPasses).includes(pass);
}

function safeNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function safeNullableNumber(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeByteLength(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeNullableByteLength(value: number | null | undefined): number | null {
  return value == null ? null : safeByteLength(value);
}

function safeAddByteLength(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + safeByteLength(right));
}

function boundedRequestedPasses(value: readonly string[]): readonly string[] {
  return Object.freeze(
    (Array.isArray(value) ? value : [])
      .slice(0, MAX_DEBUG_REQUESTED_PASSES)
      .map((pass) => boundText(pass)),
  );
}

function safeDrawingBuffer(value: readonly [number, number] | null): readonly [number, number] | null {
  return value ? Object.freeze([safeCount(value[0]), safeCount(value[1])]) : null;
}

function sanitizeStats(stats: VisualizationDebugNumericStats): VisualizationDebugNumericStats {
  return Object.freeze({
    finiteCount: safeCount(stats.finiteCount),
    max: safeNullableNumber(stats.max),
    mean: safeNullableNumber(stats.mean),
    min: safeNullableNumber(stats.min),
    nonFiniteCount: safeCount(stats.nonFiniteCount),
    p01: safeNullableNumber(stats.p01),
    p99: safeNullableNumber(stats.p99),
    source: safeEvidenceSource(stats.source),
    zeroCount: safeCount(stats.zeroCount),
  });
}

function safeTargetKind(value: unknown): "airbox" | "object" | "region" {
  return value === "object" || value === "region" ? value : "airbox";
}

function safeCacheEntryState(value: unknown): "missing" | "inflight" | "ready" {
  return value === "inflight" || value === "ready" ? value : "missing";
}

function safeEvidenceSource(
  value: unknown,
): VisualizationDebugNumericStats["source"] {
  return value === "backend-meta" ||
    value === "cache" ||
    value === "render-derived" ||
    value === "transport" ||
    value === "ui-derived" ||
    value === "webgl-shared"
    ? value
    : "decoded-payload";
}

function serializedByteLength(value: unknown): number {
  return textEncoder.encode(JSON.stringify(value)).byteLength;
}

function buildSizeLimitSnapshot(snapshot: VisualizationDebugSnapshot, byteLength: number): VisualizationDebugSnapshot {
  return Object.freeze({
    capturedAtMs: snapshot.capturedAtMs,
    carriers: Object.freeze([]),
    disposition: "blocked",
    issues: Object.freeze([Object.freeze({
      code: "snapshot-size-limit",
      evidence: Object.freeze([`serialized-byte-length=${byteLength}`, `limit-byte-length=${MAX_DEBUG_SNAPSHOT_BYTES}`]),
      message: "Visualization debug evidence exceeded the 64 KiB UTF-8 snapshot limit and was not retained.",
      severity: "error",
      source: "ui-derived",
    })]),
    memoryTotals: Object.freeze({ owned: 0, referenced: null, shared: null }),
    ownedByteLength: 0,
    sharedMemory: Object.freeze([]),
    target: Object.freeze({ carrierIds: Object.freeze([]), id: boundText(snapshot.target.id), kind: snapshot.target.kind, label: boundText(snapshot.target.label) }),
    viewport: Object.freeze({ ...snapshot.viewport, drawingBuffer: snapshot.viewport.drawingBuffer ? Object.freeze([...snapshot.viewport.drawingBuffer]) as readonly [number, number] : null }),
    version: 1,
  });
}
