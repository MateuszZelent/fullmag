"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";

import type {
  VisualizationDebugController,
  VisualizationDebugPublisherToken,
} from "@/kernel/visualization/VisualizationDebugController";
import type { VisualizationDebugSnapshot } from "@/kernel/visualization/visualizationDebugTypes";
import type { VisualizationTargetRef } from "@/kernel/visualization/ObjectVisualizationController";
import type { DecodedFieldVector } from "@/kernel/api/codecs";
import {
  recordVisualizationDebugPublish,
  recordVisualizationDebugScan,
} from "@/kernel/performance/visualizationDebugPerformanceProbe";

import type {
  Viewport3DRenderAdoptionReceipt,
  Viewport3DRenderAdoptionRegistry,
} from "../model/viewport3DRenderAdoptionRegistry";
import {
  buildViewport3DVisualizationDebugSnapshot,
  type Viewport3DVisualizationDebugCarrierInput,
} from "../model/viewport3DVisualizationDebugModel";
import { scanFieldVectorDebugStatistics } from "../model/scanFieldVectorDebugStatistics";
import {
  getViewport3DFieldVectorCacheBudgetDiagnostics,
  getViewport3DFieldVectorCacheEntryDiagnostics,
} from "../viewport3dResources";
import type {
  Viewport3DFieldRenderModel,
  Viewport3DTargetFieldBufferSource,
  Viewport3DTargetRenderPassModel,
} from "../viewport3dRenderModel";

export interface Viewport3DVisualizationDebugFrameCommit {
  commitId: string;
  committedAtMs?: number;
  contextLost?: boolean | null;
  drawingBuffer?: readonly [number, number] | null;
}

export interface Viewport3DVisualizationDebugCandidate {
  materialize(input: {
    frame: Viewport3DVisualizationDebugFrameCommit;
    receipts: readonly Viewport3DRenderAdoptionReceipt[];
  }): VisualizationDebugSnapshot;
}

export type Viewport3DVisualizationDebugCandidateBuilder = (input: {
  signal: AbortSignal;
  targetId: string;
}) => Promise<Viewport3DVisualizationDebugCandidate>;

export interface Viewport3DVisualizationDebugTargetSource {
  carrierIds: readonly string[];
  target: Pick<VisualizationTargetRef, "id" | "kind" | "label">;
}

export interface Viewport3DVisualizationDebugSource {
  fieldModel: Viewport3DFieldRenderModel | null;
  fullFieldBufferIdentity?: {
    bufferId: string;
    resourceKey: string | null;
  } | null;
  fullFieldVector: DecodedFieldVector | null;
  targets: readonly Viewport3DVisualizationDebugTargetSource[];
  topologyByteLength: number | null;
  visualizationRevision: string | null;
  webglSharedByteLength: number | null;
}

interface PublisherOptions {
  adoptionRegistry: Viewport3DRenderAdoptionRegistry;
  buildCandidate: Viewport3DVisualizationDebugCandidateBuilder;
  controller: VisualizationDebugController;
  viewportId: string;
}

interface PublisherUpdate {
  buildCandidate?: Viewport3DVisualizationDebugCandidateBuilder;
  carrierTargets?: ReadonlyMap<string, readonly string[]>;
  revision: string;
  targetIds: readonly string[];
}

interface ActiveTarget {
  abortController: AbortController;
  candidate: Viewport3DVisualizationDebugCandidate | null;
  releaseAdoptionDemand: () => void;
  revision: string;
  lastCommittedFrameId: string | null;
}

export interface Viewport3DVisualizationDebugPublisher {
  commitFrame(frame: Viewport3DVisualizationDebugFrameCommit): void;
  dispose(): void;
  getLifecycleStats(): {
    activeTargetCount: number;
    disposed: boolean;
    pendingCandidateCount: number;
    subscribedTargetCount: number;
  };
  update(update: PublisherUpdate): void;
}

export function createViewport3DVisualizationDebugPublisher({
  adoptionRegistry,
  buildCandidate: initialBuildCandidate,
  controller,
  viewportId,
}: PublisherOptions): Viewport3DVisualizationDebugPublisher {
  let buildCandidate = initialBuildCandidate;
  let disposed = false;
  let lastFrame: Viewport3DVisualizationDebugFrameCommit | null = null;
  let revision = "";
  let publisherToken: VisualizationDebugPublisherToken =
    controller.registerPublisher(viewportId);
  const active = new Map<string, ActiveTarget>();
  const demandUnsubscribers = new Map<string, () => void>();
  const targetIds = new Set<string>();

  const stopTarget = (targetId: string) => {
    const current = active.get(targetId);
    if (!current) return;
    active.delete(targetId);
    current.abortController.abort();
    current.releaseAdoptionDemand();
    adoptionRegistry.clearTarget(targetId);
  };

  const startTarget = (targetId: string) => {
    if (disposed || !targetIds.has(targetId)) return;
    if (!controller.getDemandSnapshot(targetId).expanded) {
      stopTarget(targetId);
      return;
    }
    const current = active.get(targetId);
    if (current?.revision === revision) return;
    stopTarget(targetId);
    const abortController = new AbortController();
    const state: ActiveTarget = {
      abortController,
      candidate: null,
      releaseAdoptionDemand: adoptionRegistry.retainDemand(targetId),
      revision,
      lastCommittedFrameId: null,
    };
    active.set(targetId, state);
    recordVisualizationDebugScan();
    void buildCandidate({ signal: abortController.signal, targetId })
      .then((candidate) => {
        if (
          disposed ||
          abortController.signal.aborted ||
          active.get(targetId) !== state ||
          state.revision !== revision
        ) {
          return;
        }
        state.candidate = candidate;
        state.lastCommittedFrameId = null;
        if (lastFrame) commitTarget(targetId, state, lastFrame);
      })
      .catch((error: unknown) => {
        if (abortController.signal.aborted || isAbortError(error)) return;
        state.candidate = null;
      });
  };

  const rotatePublisher = () => {
    controller.clearPublisher(publisherToken);
    publisherToken = controller.registerPublisher(viewportId);
  };
  const commitTarget = (
    targetId: string,
    state: ActiveTarget,
    frame: Viewport3DVisualizationDebugFrameCommit,
  ) => {
    if (!state.candidate || state.revision !== revision) return;
    if (!controller.getDemandSnapshot(targetId).expanded) return;
    if (state.lastCommittedFrameId === frame.commitId) return;
    recordVisualizationDebugPublish();
    controller.commit(
      publisherToken,
      targetId,
      state.candidate.materialize({
        frame,
        receipts: adoptionRegistry.snapshot(targetId),
      }),
    );
    state.lastCommittedFrameId = frame.commitId;
  };
  const unsubscribeAdoption = adoptionRegistry.subscribe(() => {
    if (disposed || !lastFrame) return;
    for (const [targetId, state] of active) {
      state.lastCommittedFrameId = null;
      commitTarget(targetId, state, lastFrame);
    }
  });

  return {
    commitFrame(frame) {
      if (disposed) return;
      lastFrame = frame;
      for (const [targetId, state] of active) {
        commitTarget(targetId, state, frame);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeAdoption();
      for (const unsubscribe of demandUnsubscribers.values()) unsubscribe();
      demandUnsubscribers.clear();
      for (const targetId of [...active.keys()]) stopTarget(targetId);
      targetIds.clear();
      controller.clearPublisher(publisherToken);
    },
    getLifecycleStats() {
      let pendingCandidateCount = 0;
      for (const state of active.values()) {
        if (state.candidate === null && !state.abortController.signal.aborted) {
          pendingCandidateCount += 1;
        }
      }
      return {
        activeTargetCount: active.size,
        disposed,
        pendingCandidateCount,
        subscribedTargetCount: demandUnsubscribers.size,
      };
    },
    update(update) {
      if (disposed) return;
      buildCandidate = update.buildCandidate ?? buildCandidate;
      if (update.carrierTargets) {
        adoptionRegistry.setCarrierTargets(update.carrierTargets);
      }
      const nextTargetIds = new Set(update.targetIds);
      let removedTarget = false;
      for (const targetId of [...targetIds]) {
        if (nextTargetIds.has(targetId)) continue;
        removedTarget = true;
        targetIds.delete(targetId);
        stopTarget(targetId);
        demandUnsubscribers.get(targetId)?.();
        demandUnsubscribers.delete(targetId);
      }
      if (removedTarget) rotatePublisher();
      const revisionChanged = revision !== update.revision;
      if (revisionChanged) {
        lastFrame = null;
        rotatePublisher();
      }
      revision = update.revision;
      for (const targetId of nextTargetIds) {
        if (!targetIds.has(targetId)) {
          targetIds.add(targetId);
          demandUnsubscribers.set(
            targetId,
            controller.subscribeDemand(targetId, () => startTarget(targetId)),
          );
        }
        if (revisionChanged) stopTarget(targetId);
        startTarget(targetId);
      }
    },
  };
}

export function useViewport3DVisualizationDebugPublisher({
  adoptionRegistry,
  buildCandidate,
  carrierTargets,
  controller,
  revision,
  targetIds,
  viewportId,
}: PublisherOptions & {
  carrierTargets: ReadonlyMap<string, readonly string[]>;
  revision: string;
  targetIds: readonly string[];
}): {
  onFrameCommitted: (frame: Viewport3DVisualizationDebugFrameCommit) => void;
} {
  const publisherRef = useRef<Viewport3DVisualizationDebugPublisher | null>(null);
  if (publisherRef.current === null) {
    publisherRef.current = createViewport3DVisualizationDebugPublisher({
      adoptionRegistry,
      buildCandidate,
      controller,
      viewportId,
    });
  }
  const targetKey = targetIds.join("\u0000");
  useEffect(() => {
    publisherRef.current?.update({
      buildCandidate,
      carrierTargets,
      revision,
      targetIds,
    });
  }, [buildCandidate, carrierTargets, revision, targetIds, targetKey]);
  useEffect(
    () => () => {
      publisherRef.current?.dispose();
      publisherRef.current = null;
    },
    [],
  );
  const onFrameCommitted = useCallback(
    (frame: Viewport3DVisualizationDebugFrameCommit) => {
      publisherRef.current?.commitFrame(frame);
    },
    [],
  );
  return useMemo(() => ({ onFrameCommitted }), [onFrameCommitted]);
}

export function groupViewport3DVisualizationDebugCarriers({
  carrierIds,
  derivedGlobalTargetIds = [],
  targetByCarrierId,
}: {
  carrierIds: readonly string[];
  derivedGlobalTargetIds?: readonly string[];
  targetByCarrierId: ReadonlyMap<string, string>;
}): ReadonlyMap<string, readonly string[]> {
  const grouped = new Map<string, string[]>();
  for (const carrierId of carrierIds) {
    const targetId = targetByCarrierId.get(carrierId);
    if (targetId) appendUnique(grouped, targetId, carrierId);
  }
  if (carrierIds.includes("fdm-domain")) {
    for (const targetId of derivedGlobalTargetIds) {
      appendUnique(grouped, targetId, "fdm-domain");
    }
  }
  return grouped;
}

export function createViewport3DVisualizationDebugCandidateBuilder({
  source,
  viewportId,
}: {
  source: Viewport3DVisualizationDebugSource;
  viewportId: string;
}): Viewport3DVisualizationDebugCandidateBuilder {
  const targets = new Map(source.targets.map((entry) => [entry.target.id, entry]));
  return async ({ signal, targetId }) => {
    const targetSource = targets.get(targetId);
    const carrierSources = targetSource
      ? resolveCarrierSources(source, targetSource)
      : [];
    const scannedStats = new Map<string, Awaited<ReturnType<typeof scanFieldVectorDebugStatistics>>>();
    for (const carrier of carrierSources) {
    const fieldBuffer = carrier.pass.fieldBuffer ?? carrier.fullFieldBuffer;
      if (!fieldBuffer || scannedStats.has(fieldBuffer.bufferId)) continue;
      scannedStats.set(
        fieldBuffer.bufferId,
        await scanFieldVectorDebugStatistics(fieldBuffer.values, { signal }),
      );
    }
    if (signal.aborted) throw new DOMException("The debug scan was aborted.", "AbortError");

    return {
      materialize: ({ frame, receipts }) => {
        const carrierInputs = carrierSources.map(({ carrierId, fullFieldBuffer, pass }) => {
          const fieldBuffer = pass.fieldBuffer ?? fullFieldBuffer;
          const surfaceReceipt = receipts.find(
            (receipt) => receipt.carrierId === carrierId && receipt.kind === "surface",
          );
          const vectorReceipt = receipts.find(
            (receipt) => receipt.carrierId === carrierId && receipt.kind === "vector",
          );
          return buildCarrierInput({
            carrierId,
            fieldBuffer,
            pass,
            scannedStats: fieldBuffer ? scannedStats.get(fieldBuffer.bufferId) ?? null : null,
            source,
            surfaceReceipt,
            vectorReceipt,
          });
        });
        const committedAtMs = frame.committedAtMs ?? 0;
        return buildViewport3DVisualizationDebugSnapshot({
          capturedAtMs: committedAtMs,
          carriers: carrierInputs,
          fieldCacheBudget: getViewport3DFieldVectorCacheBudgetDiagnostics(),
          frame: {
            committedAtMs,
            commitId: frame.commitId,
            contextLost: frame.contextLost ?? null,
            drawingBuffer: frame.drawingBuffer ?? null,
            viewportId,
          },
          target: {
            id: targetSource?.target.id ?? targetId,
            kind: debugTargetKind(targetSource?.target.kind),
            label: targetSource?.target.label ?? targetId,
          },
          visualizationRevision: source.visualizationRevision,
          webglSharedByteLength: source.webglSharedByteLength,
        });
      },
    };
  };
}

function appendUnique(
  grouped: Map<string, string[]>,
  targetId: string,
  carrierId: string,
): void {
  const carriers = grouped.get(targetId) ?? [];
  if (!carriers.includes(carrierId)) carriers.push(carrierId);
  grouped.set(targetId, carriers);
}

function resolveCarrierSources(
  source: Viewport3DVisualizationDebugSource,
  target: Viewport3DVisualizationDebugTargetSource,
): Array<{
  carrierId: string;
  fullFieldBuffer: Viewport3DTargetFieldBufferSource | null;
  pass: Viewport3DTargetRenderPassModel;
}> {
  const result: Array<{
    carrierId: string;
    fullFieldBuffer: Viewport3DTargetFieldBufferSource | null;
    pass: Viewport3DTargetRenderPassModel;
  }> = [];
  for (const carrierId of target.carrierIds) {
    const pass = source.fieldModel?.targetPasses.get(carrierId);
    if (pass) result.push({ carrierId, fullFieldBuffer: null, pass });
  }
  if (result.length === 0 && source.fullFieldVector) {
    const fullPass = source.fieldModel?.targetPasses.get("full");
    if (fullPass) {
      result.push({
        carrierId: "fdm-domain",
        fullFieldBuffer: targetFieldBufferSourceFromDecoded(
          source.fullFieldVector,
          source.fullFieldBufferIdentity ?? null,
        ),
        pass: fullPass,
      });
    }
  }
  return result;
}

function targetFieldBufferSourceFromDecoded(
  fieldVector: DecodedFieldVector,
  identity: { bufferId: string; resourceKey: string | null } | null,
): Viewport3DTargetFieldBufferSource {
  return {
    bufferId:
      identity?.bufferId ??
      `decoded:${fieldVector.quantityId}:${fieldVector.pointCount}:${fieldVector.values.byteLength}`,
    capability: fieldVector.nComp > 1 ? "full-vector-complete" : "scalar-complete",
    component: fieldVector.nComp > 1 ? "full" : "magnitude",
    componentCount: fieldVector.nComp,
    consumers: Object.freeze([]),
    decodedFieldVector: fieldVector,
    domainGenerationId: null,
    fieldRevision: null,
    indexing: fieldVector.indexing,
    meshTopologyHash: null,
    nodeIndexCount: fieldVector.nodeIndices?.length ?? null,
    nodeIndices: fieldVector.nodeIndices,
    pointCount: fieldVector.pointCount,
    quantityId: fieldVector.quantityId,
    requestId: null,
    resourceKey: identity?.resourceKey ?? null,
    sampled: Boolean(fieldVector.nodeIndices),
    scopeId: null,
    scopeKind: "full",
    topologyRevision: null,
    values: fieldVector.values,
    vectorComponentCount: fieldVector.nComp,
  };
}

function buildCarrierInput({
  carrierId,
  fieldBuffer,
  pass,
  scannedStats,
  source,
  surfaceReceipt,
  vectorReceipt,
}: {
  carrierId: string;
  fieldBuffer: Viewport3DTargetFieldBufferSource | null;
  pass: Viewport3DTargetRenderPassModel;
  scannedStats: Awaited<ReturnType<typeof scanFieldVectorDebugStatistics>> | null;
  source: Viewport3DVisualizationDebugSource;
  surfaceReceipt: Viewport3DRenderAdoptionReceipt | undefined;
  vectorReceipt: Viewport3DRenderAdoptionReceipt | undefined;
}): Viewport3DVisualizationDebugCarrierInput {
  const resourceKey = fieldBuffer?.resourceKey ?? null;
  const scalarColors = pass.surface.scalarColors;
  return {
    adoptedFieldBufferId:
      surfaceReceipt?.fieldBufferId ?? vectorReceipt?.fieldBufferId ?? null,
    adoptedResourceKey:
      surfaceReceipt?.resourceKey ?? vectorReceipt?.resourceKey ?? null,
    adoptedScalarBufferKey: surfaceReceipt?.scalarBufferKey ?? null,
    adoptedVectorBuildKey: vectorReceipt?.vectorBuildKey ?? null,
    adoptedVectorItemCount: vectorReceipt?.itemCount ?? null,
    cache: resourceKey
      ? getViewport3DFieldVectorCacheEntryDiagnostics(resourceKey)
      : null,
    carrierId,
    carrierRole: carrierId === "fdm-domain" ? "fdm-domain" : carrierId,
    decoded: fieldBuffer ? decodedFieldBuffer(fieldBuffer) : null,
    expectedDomainGenerationId: fieldBuffer?.domainGenerationId ?? null,
    expectedFieldRevision: fieldBuffer?.fieldRevision ?? null,
    expectedTopologyHash: fieldBuffer?.meshTopologyHash ?? null,
    fieldBufferId: fieldBuffer?.bufferId ?? null,
    fieldBufferState: pass.fieldBufferState,
    fieldRevision: fieldBuffer?.fieldRevision ?? null,
    geometryMaskDescription:
      carrierId === "fdm-domain" ? "logical target geometry mask" : null,
    plannerRequestId: fieldBuffer?.requestId ?? null,
    rangeDiagnostics: scalarColors?.rangeDiagnostics ?? null,
    rangeDiagnosticsComponent: scalarColors?.colorMode ?? null,
    requestedComponent: fieldBuffer?.component ?? scalarColors?.colorMode ?? "full",
    requestedPasses: [
      ...(pass.surface.scalarColorMode ? (["surface"] as const) : []),
      ...(pass.vectors.segments ? (["vector-glyph"] as const) : []),
    ],
    requestedQuantityId: fieldBuffer?.quantityId ?? scalarColors?.quantityId ?? "unknown",
    requestedScopeId: fieldBuffer?.scopeId ?? null,
    requestedScopeKind: fieldBuffer?.scopeKind ?? "full",
    resourceKey,
    scalarBufferByteLength: scalarColors?.colors.byteLength ?? null,
    scalarBufferKey: scalarColors?.buildKey ?? null,
    scannedStats,
    topologyByteLength: source.topologyByteLength,
    vectorBuildKey: pass.vectors.buildReference?.buildKey ?? null,
    vectorSegmentByteLength: pass.vectors.segments?.byteLength ?? null,
    vectorSegmentCount: pass.vectors.segments
      ? Math.floor(pass.vectors.segments.length / 7)
      : null,
    webglSharedByteLength: source.webglSharedByteLength,
    wireByteLength: fieldBuffer?.values.byteLength ?? null,
  };
}

function decodedFieldBuffer(
  fieldBuffer: Viewport3DTargetFieldBufferSource,
) {
  return fieldBuffer.decodedFieldVector;
}

function debugTargetKind(
  kind: VisualizationTargetRef["kind"] | undefined,
): "airbox" | "object" | "region" {
  if (kind === "airbox" || kind === "region") return kind;
  return "object";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
