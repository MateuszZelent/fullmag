"use client";

/**
 * Data-plane bridge: fetches heavy resources on-demand when revisions change.
 *
 * Instead of bundling everything in one initial payload, this hook
 * watches revision counters from the Zustand store (populated by the
 * status bridge) and lazily fetches:
 *
 *  - field vectors  (when field_revision bumps)
 *  - scalar windows (when scalar_revision bumps)
 *  - domain/topology (when domain_generation_id bumps)
 *  - shared FEM mesh topology (when mesh_revision bumps)
 *  - engine logs    (when engine_log_revision bumps)
 *
 * The fetched data is written back to the store through
 * applyNormalizedState, merging with the existing state.
 */

import { useEffect, useRef, useCallback } from "react";
import {
  incrementFrontendAuditCounter,
  incrementFrontendAuditResourceFetch,
  setFrontendAuditCounter,
} from "@/lib/debug/frontendAudit";
import { useSessionRuntimeStore } from "../store/useSessionRuntimeStore";
import { getLiveSessionClient } from "@/src/api/client/LiveSessionClient";
import { LiveApiError } from "@/src/api/client/errors/LiveApiError";
import { decodeFieldVectorOffThread, decodeTopologyOffThread } from "@/src/api/codecs/decodeOffThread";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { normalizeMeshWorkspace } from "@/lib/session/normalize";
import type {
  LatestFieldFrame,
  QuantityDescriptor,
  ScalarRow as StoreScalarRow,
} from "@/lib/session/types";
import type { FieldFrameEnvelope, FieldFrameStats } from "@/lib/fieldFrame/types";
import type { DecodedFieldVector } from "@/src/api/codecs/types";
import type { FieldComponent } from "@/src/api/types";
import { scalarWindowToRows } from "@/src/api/client/modules/ScalarHistoryAdapter";
import {
  applyMeshSharedDomainManifest,
  buildFemMeshFromDecodedTopology,
  mergeFemMeshResource,
} from "@/src/hooks/resources/meshFemResource";
import { getCachedJsonResource } from "./dataPlaneCache";

const ENABLE_DEBUG =
  typeof process !== "undefined" &&
  process.env.NODE_ENV !== "production" &&
  FRONTEND_DIAGNOSTIC_FLAGS.renderDebug.enableRenderLogging &&
  FRONTEND_DIAGNOSTIC_FLAGS.interactions.trace;

type DataPlaneRequest = {
  key: string;
  controller: AbortController;
  sequence: number;
};

const MAX_SCALAR_ROWS = 10_000;
const MAX_SCALAR_ROWS_PER_FETCH = 2_000;
const SCALAR_ROW_BYTES_APPROX = 15 * 8;

export interface DataPlaneCacheScope {
  runtimeScopeKey: string | null;
  domainGenerationRevision: number;
}

export type DataPlaneCacheResetReason = "scope-change" | "domain-change" | null;

export function resolveDataPlaneCacheResetReason(
  previous: DataPlaneCacheScope | null,
  current: DataPlaneCacheScope,
): DataPlaneCacheResetReason {
  if (!previous || previous.runtimeScopeKey !== current.runtimeScopeKey) {
    return "scope-change";
  }
  if (previous.domainGenerationRevision !== current.domainGenerationRevision) {
    return "domain-change";
  }
  return null;
}

export function isNegativeDataPlaneResponse(value: unknown): boolean {
  if (value instanceof LiveApiError) {
    return (
      value.status === 404 ||
      value.status === 204 ||
      value.message.toLowerCase().includes("not available yet")
    );
  }
  if (value instanceof ArrayBuffer) {
    return value.byteLength === 0;
  }
  if (ArrayBuffer.isView(value)) {
    return value.byteLength === 0;
  }
  return false;
}

function adaptScalarRow(
  row: Record<string, number | string | null>,
): StoreScalarRow {
  return {
    step: Number(row.step ?? 0),
    time: Number(row.t ?? 0),
    solver_dt: Number(row.solver_dt ?? 0),
    mx: Number(row.mx ?? 0),
    my: Number(row.my ?? 0),
    mz: Number(row.mz ?? 0),
    e_ex: Number(row.e_ex ?? 0),
    e_demag: Number(row.e_demag ?? 0),
    e_ext: Number(row.e_ext ?? 0),
    e_ani: Number(row.e_ani ?? 0),
    e_dmi: Number(row.e_dmi ?? 0),
    e_total: Number(row.e_total ?? 0),
    max_dm_dt: Number(row.max_dm_dt ?? 0),
    max_h_eff: Number(row.max_h_eff ?? 0),
    max_h_demag: Number(row.max_h_demag ?? 0),
  };
}

export function appendScalarRowsBounded(
  current: StoreScalarRow[],
  next: StoreScalarRow[],
  limit = MAX_SCALAR_ROWS,
): StoreScalarRow[] {
  if (next.length === 0) {
    return current;
  }
  if (limit <= 0) {
    return [];
  }
  const lastStep = current.length > 0 ? current[current.length - 1]?.step : null;
  const rowsToAppend =
    typeof lastStep === "number"
      ? next.filter((row) => row.step > lastStep)
      : next;
  if (rowsToAppend.length === 0) {
    return current;
  }
  const total = current.length + rowsToAppend.length;
  if (total <= limit) {
    const rows = current.slice();
    rows.push(...rowsToAppend);
    return rows;
  }
  if (rowsToAppend.length >= limit) {
    return rowsToAppend.slice(rowsToAppend.length - limit);
  }
  const keepFromCurrent = limit - rowsToAppend.length;
  const rows = current.slice(Math.max(0, current.length - keepFromCurrent));
  rows.push(...rowsToAppend);
  return rows;
}

export function mapResourceQuantities(
  quantityCatalog: {
    quantities: Array<{
      id: string;
      label: string;
      unit: string;
      location: string;
      domain: string;
      n_comp: number;
      normalization_hint: string;
      interactive_preview: boolean;
      supports_preview_2d: boolean;
      supports_preview_3d: boolean;
      supports_history: boolean;
      supports_export: boolean;
      quick_access_label?: string | null;
      scalar_metric_key?: string | null;
      shape: string;
    }>;
  },
  fieldCatalog: {
    quantities: Array<{
      quantity_id: string;
      label: string;
      kind: string;
      components: number;
      location: string;
      unit: string;
      available: boolean;
    }>;
  },
): QuantityDescriptor[] {
  const fieldById = new Map(
    fieldCatalog.quantities.map((quantity) => [quantity.quantity_id, quantity] as const),
  );

  return quantityCatalog.quantities.map((quantity) => {
    const field = fieldById.get(quantity.id);
    const selectable = Boolean(
      quantity.interactive_preview &&
        (quantity.supports_preview_2d || quantity.supports_preview_3d),
    );
    const dataAvailable = field?.available ?? false;
    return {
      id: quantity.id,
      label: field?.label ?? quantity.label,
      kind: field?.kind ?? quantity.shape,
      unit: field?.unit ?? quantity.unit,
      location: field?.location ?? quantity.location,
      available: selectable,
      data_available: dataAvailable,
      interactive_preview: quantity.interactive_preview,
      quick_access_label: quantity.quick_access_label ?? null,
      scalar_metric_key: quantity.scalar_metric_key ?? null,
      n_comp: field?.components ?? quantity.n_comp,
      domain: quantity.domain === "full_domain" ? "full_domain" : "magnetic_only",
      normalization_hint:
        quantity.normalization_hint === "unit_vector" ||
        quantity.normalization_hint === "max_abs"
          ? quantity.normalization_hint
          : "none",
      supports_preview_2d: quantity.supports_preview_2d,
      supports_preview_3d: quantity.supports_preview_3d,
      supports_history: quantity.supports_history,
      supports_export: quantity.supports_export,
    };
  });
}

export interface FieldVectorFetchDecision {
  shouldFetch: boolean;
  component: FieldComponent;
}

export function decideFieldVectorFetch(args: {
  viewMode: string | null;
  component: FieldFrameEnvelope["component"];
  isFemBackend?: boolean;
}): FieldVectorFetchDecision {
  if (args.viewMode === "2d") {
    return {
      shouldFetch: false,
      component: "full",
    };
  }
  if (args.isFemBackend && args.viewMode === "3d") {
    return {
      shouldFetch: true,
      component: "full",
    };
  }
  const selected =
    args.component === "x" ||
    args.component === "y" ||
    args.component === "z" ||
    args.component === "magnitude"
      ? args.component
      : "full";
  return {
    shouldFetch: true,
    component: selected,
  };
}

// ── Hook ─────────────────────────────────────────────────────────────

/**
 * Mount alongside useNewApiBridge. Watches store revision counters
 * and fetches heavy payloads lazily from the new resource-first API.
 */

export function useDataPlaneBridge(
  options?: { enabled?: boolean },
): void {
  const enabled = options?.enabled ?? true;
  const leakIsolationFlags = FRONTEND_DIAGNOSTIC_FLAGS.leakIsolation;
  // Read revision signals from the store (set by useNewApiBridge)
  const fieldFrameEnvelope = useSessionRuntimeStore(
    (s) => s.fieldFrameEnvelope,
  );
  const scalarRevision = useSessionRuntimeStore(
    (s) => s.resourceRevisions?.scalars_revision ?? 0,
  );
  const meshRevision = useSessionRuntimeStore(
    (s) => s.resourceRevisions?.mesh_revision ?? 0,
  );
  const domainGenerationRevision = useSessionRuntimeStore(
    (s) => s.resourceRevisions?.domain_generation_id ?? 0,
  );
  const fieldsRevision = useSessionRuntimeStore(
    (s) => s.resourceRevisions?.fields_revision ?? 0,
  );
  const artifactsRevision = useSessionRuntimeStore(
    (s) => s.resourceRevisions?.artifacts_revision ?? 0,
  );
  const engineLogRevision = useSessionRuntimeStore(
    (s) => s.resourceRevisions?.engine_log_revision ?? 0,
  );
  const sessionId = useSessionRuntimeStore((s) => s.session?.session_id);
  const runId = useSessionRuntimeStore((s) => s.run?.run_id);
  const isFemBackend = useSessionRuntimeStore((s) => s.isFemBackend);
  const displaySelection = useSessionRuntimeStore((s) => s.displaySelection);
  const currentViewMode = displaySelection?.selection.view_mode ?? null;
  const runtimeScopeKey =
    sessionId && runId
      ? `${sessionId}:${runId}`
      : sessionId
        ? `${sessionId}:no-run`
        : null;

  const applyNormalizedState = useSessionRuntimeStore(
    (s) => s.applyNormalizedState,
  );

  // Track fetched revisions to avoid duplicate requests
  const fetchedFieldRevRef = useRef<string | null>(null);
  const fetchedScalarRevRef = useRef<number | null>(null);
  const fetchedDomainGenRef = useRef<string | null>(null);
  const fetchedMeshRevRef = useRef<number | null>(null);
  const fetchedCatalogKeyRef = useRef<string | null>(null);
  const fetchedArtifactsKeyRef = useRef<string | null>(null);
  const fetchedEngineLogKeyRef = useRef<string | null>(null);
  const scalarAccumulatorRef = useRef<StoreScalarRow[]>([]);
  const requestSequenceRef = useRef(0);
  const fieldRequestRef = useRef<DataPlaneRequest | null>(null);
  const scalarRequestRef = useRef<DataPlaneRequest | null>(null);
  const domainRequestRef = useRef<DataPlaneRequest | null>(null);
  const meshRequestRef = useRef<DataPlaneRequest | null>(null);
  const catalogRequestRef = useRef<DataPlaneRequest | null>(null);
  const artifactsRequestRef = useRef<DataPlaneRequest | null>(null);
  const engineLogRequestRef = useRef<DataPlaneRequest | null>(null);
  const negativeResourceCacheRef = useRef<Set<string>>(new Set());

  // Reset accumulators when session changes
  const prevCacheScopeRef = useRef<DataPlaneCacheScope | null>(null);
  useEffect(() => {
    const clearClientCache = () => {
      getLiveSessionClient().getCache().clear();
    };
    const abortDataPlaneRequests = () => {
      for (const requestRef of [
        fieldRequestRef,
        scalarRequestRef,
        domainRequestRef,
        meshRequestRef,
        catalogRequestRef,
        artifactsRequestRef,
        engineLogRequestRef,
      ]) {
        requestRef.current?.controller.abort();
        requestRef.current = null;
      }
    };
    const resetFetchedResourceRefs = () => {
      fetchedFieldRevRef.current = null;
      fetchedScalarRevRef.current = null;
      fetchedDomainGenRef.current = null;
      fetchedMeshRevRef.current = null;
      fetchedCatalogKeyRef.current = null;
      fetchedArtifactsKeyRef.current = null;
      fetchedEngineLogKeyRef.current = null;
    };
    if (!enabled) {
      abortDataPlaneRequests();
      prevCacheScopeRef.current = null;
      scalarAccumulatorRef.current = [];
      negativeResourceCacheRef.current.clear();
      resetFetchedResourceRefs();
      clearClientCache();
      return;
    }
    const currentCacheScope = { runtimeScopeKey, domainGenerationRevision };
    const cacheResetReason = resolveDataPlaneCacheResetReason(
      prevCacheScopeRef.current,
      currentCacheScope,
    );
    if (cacheResetReason === "scope-change") {
      abortDataPlaneRequests();
      prevCacheScopeRef.current = currentCacheScope;
      scalarAccumulatorRef.current = [];
      negativeResourceCacheRef.current.clear();
      resetFetchedResourceRefs();
      clearClientCache();
      return;
    }
    if (cacheResetReason === "domain-change") {
      abortDataPlaneRequests();
      prevCacheScopeRef.current = currentCacheScope;
      negativeResourceCacheRef.current.clear();
      resetFetchedResourceRefs();
      clearClientCache();
    }
  }, [domainGenerationRevision, enabled, runtimeScopeKey]);

  useEffect(() => {
    return () => {
      for (const requestRef of [
        fieldRequestRef,
        scalarRequestRef,
        domainRequestRef,
        meshRequestRef,
        catalogRequestRef,
        artifactsRequestRef,
        engineLogRequestRef,
      ]) {
        requestRef.current?.controller.abort();
        requestRef.current = null;
      }
    };
  }, []);

  // ── Field vector fetching ───────────────────────────────────────

  const fetchFieldVector = useCallback(
    async (envelope: FieldFrameEnvelope) => {
      if (!enabled) return;
      const fetchDecision = decideFieldVectorFetch({
        viewMode: currentViewMode,
        component: envelope.component,
        isFemBackend,
      });
      if (!fetchDecision.shouldFetch) {
        return;
      }
      const rev = envelope.fieldRevision;
      const requestedComponent = fetchDecision.component;
      // Use the raw opaque string for the dedup cache key so that UUID-like
      // generation IDs are not collapsed to 0 by parseInt.
      const meshGenerationIdStr = envelope.meshGenerationId ?? "";
      const meshGenerationIdNum = Number.parseInt(envelope.meshGenerationId ?? "0", 10);
      const meshGenerationId = Number.isFinite(meshGenerationIdNum) ? meshGenerationIdNum : 0;
      const cacheKey = `${envelope.quantityId}:${requestedComponent}:${rev}:${meshGenerationIdStr}`;
      if (fetchedFieldRevRef.current === cacheKey) return;
      const requestScopeKey = runtimeScopeKey;
      if (!requestScopeKey) return;
      const requestKey = `${requestScopeKey}:${cacheKey}`;
      const negativeCacheKey = `field:${requestKey}`;
      if (negativeResourceCacheRef.current.has(negativeCacheKey)) return;
      if (fieldRequestRef.current?.key === requestKey) return;
      fieldRequestRef.current?.controller.abort();
      const controller = new AbortController();
      const requestSequence = ++requestSequenceRef.current;
      fieldRequestRef.current = { key: requestKey, controller, sequence: requestSequence };
      setFrontendAuditCounter("fieldVectorInflight", 1);
      const isCurrentRequest = () =>
        fieldRequestRef.current?.sequence === requestSequence &&
        prevCacheScopeRef.current?.runtimeScopeKey === requestScopeKey &&
        !controller.signal.aborted;

      try {
        const client = getLiveSessionClient();
        const resourceKey = `data-plane:field:${requestScopeKey}:${envelope.quantityId}:${requestedComponent}`;
        const cached = client.getCache().get<DecodedFieldVector>(resourceKey);
        let result: DecodedFieldVector;
        if (
          cached &&
          cached.revision === rev &&
          cached.generationId === meshGenerationId
        ) {
          result = cached.data;
        } else {
          incrementFrontendAuditCounter("fieldVectorRequests", 1);
          incrementFrontendAuditResourceFetch("field-vector", 1);
          const response = await client.fields.getVectorResponse(
            envelope.quantityId,
            {
              component: requestedComponent,
              etag: cached?.eTag ?? undefined,
            },
            { signal: controller.signal },
          );
          if (!isCurrentRequest()) return;
          if (response.status === 304 && cached) {
            result = cached.data;
          } else {
            if (
              response.buffer == null ||
              isNegativeDataPlaneResponse(response.buffer)
            ) {
              negativeResourceCacheRef.current.add(negativeCacheKey);
              fetchedFieldRevRef.current = cacheKey;
              return;
            }
            result = await decodeFieldVectorOffThread(response.buffer, {
              transferInput: true,
            });
            if (!isCurrentRequest()) return;
            client.getCache().set(
              resourceKey,
              result,
              rev,
              meshGenerationId,
              response.headers.get("etag"),
            );
          }
        }
        if (!isCurrentRequest()) return;
        fetchedFieldRevRef.current = cacheKey;

        // Build updated envelope with stats from the fetched field
        let stats: FieldFrameStats | null = envelope.stats;
        if (result.values.length > 0) {
          let min = Infinity;
          let max = -Infinity;
          for (let i = 0; i < result.values.length; i++) {
            const v = result.values[i];
            if (v < min) min = v;
            if (v > max) max = v;
          }
          stats = { min, max, compMin: null, compMax: null };
        }

        const updatedEnvelope: FieldFrameEnvelope = {
          ...envelope,
          stats,
          nComp: result.nComp as FieldFrameEnvelope["nComp"],
        };
        const nextFieldFrame: LatestFieldFrame = {
          quantity_id: envelope.quantityId,
          unit: "",
          n_comp: result.nComp,
          grid: result.grid,
          values: result.values,
          active_mask: null,
          location: envelope.location,
          domain: envelope.domain,
          topology_signature:
            envelope.meshGenerationId && envelope.meshGenerationId.length > 0
              ? `gen:${envelope.meshGenerationId}`
              : envelope.topologyHash && envelope.topologyHash.length > 0
                ? `hash:${envelope.topologyHash}`
                : null,
          field_revision: rev,
          source_step: envelope.sourceStep,
          source_time: envelope.sourceTime,
        };

        // Merge into store — only update field-related fields
        if (!isCurrentRequest()) return;
        const current = useSessionRuntimeStore.getState();
        applyNormalizedState({
          stateVersion: current.stateVersion,
          session: current.session,
          run: current.run,
          metadata: null,
          liveState: current.liveState,
          scalarRows: current.scalarRows,
          engineLog: current.engineLog,
          quantities: current.quantities,
          artifacts: current.artifacts,
          femMesh: current.femMesh,
          preview: current.preview,
          scriptBuilder: current.scriptBuilder,
          runtimeStatus: current.runtimeStatus,
          commandStatus: current.commandStatus,
          meshWorkspace: current.meshWorkspace,
          stepUpdateV2: current.stepUpdateV2,
          workspaceStatus: current.workspaceStatus,
          isFemBackend: current.isFemBackend,
          domainCapabilities: current.domainCapabilities,
          resourceRevisions: current.resourceRevisions,
          displaySelection: current.displaySelection,
          previewConfig: current.previewConfig,
          latestFieldFrames: {
            ...current.latestFieldFrames,
            [envelope.quantityId]: nextFieldFrame,
          },
          latestFieldGrid: result.grid,
          fieldFrameEnvelope: updatedEnvelope,
        });

        if (ENABLE_DEBUG) {
          console.info(
            "[fullmag-debug][data-plane] field vector fetched",
            {
              quantityId: envelope.quantityId,
              revision: rev,
              requestedComponent,
              meshGenerationId,
              cacheKey,
            },
          );
        }
      } catch (err) {
        if (controller.signal.aborted) {
          return;
        }
        if (isNegativeDataPlaneResponse(err)) {
          if (!isCurrentRequest()) return;
          // Quantity not available yet — skip silently
          negativeResourceCacheRef.current.add(negativeCacheKey);
          fetchedFieldRevRef.current = cacheKey;
          return;
        }
        console.warn("[fullmag][data-plane] field fetch failed", err);
      } finally {
        if (fieldRequestRef.current?.sequence === requestSequence) {
          fieldRequestRef.current = null;
          setFrontendAuditCounter("fieldVectorInflight", 0);
        }
      }
    },
    [applyNormalizedState, currentViewMode, enabled, isFemBackend, runtimeScopeKey],
  );

  // ── Scalar history fetching ─────────────────────────────────────

  const fetchScalars = useCallback(
    async (revision: number) => {
      if (!enabled) return;
      if (fetchedScalarRevRef.current === revision) return;
      const requestScopeKey = runtimeScopeKey;
      if (!requestScopeKey) return;
      const requestKey = `${requestScopeKey}:${revision}`;
      if (scalarRequestRef.current?.key === requestKey) return;
      scalarRequestRef.current?.controller.abort();
      const controller = new AbortController();
      const requestSequence = ++requestSequenceRef.current;
      scalarRequestRef.current = { key: requestKey, controller, sequence: requestSequence };
      const isCurrentRequest = () =>
        scalarRequestRef.current?.sequence === requestSequence &&
        prevCacheScopeRef.current?.runtimeScopeKey === requestScopeKey &&
        !controller.signal.aborted;

      try {
        const client = getLiveSessionClient();
        incrementFrontendAuditResourceFetch("scalars", 1);
        const window = await client.scalars.getWindow({
          sinceRevision: fetchedScalarRevRef.current ?? 0,
          limit: MAX_SCALAR_ROWS_PER_FETCH,
          maxPoints: MAX_SCALAR_ROWS_PER_FETCH,
        }, { signal: controller.signal });
        if (!isCurrentRequest()) return;

        if (window.rows.length > 0) {
          const adapted = scalarWindowToRows(window).map(adaptScalarRow);
          scalarAccumulatorRef.current = appendScalarRowsBounded(
            scalarAccumulatorRef.current,
            adapted,
          );
          setFrontendAuditCounter("scalarRows", scalarAccumulatorRef.current.length);
          setFrontendAuditCounter(
            "scalarAccumulatorBytesApprox",
            scalarAccumulatorRef.current.length * SCALAR_ROW_BYTES_APPROX,
          );
        }
        fetchedScalarRevRef.current = revision;

        // Merge into store
        if (!isCurrentRequest()) return;
        const current = useSessionRuntimeStore.getState();
        applyNormalizedState({
          stateVersion: current.stateVersion,
          session: current.session,
          run: current.run,
          metadata: null,
          liveState: current.liveState,
          scalarRows: scalarAccumulatorRef.current,
          engineLog: current.engineLog,
          quantities: current.quantities,
          artifacts: current.artifacts,
          femMesh: current.femMesh,
          preview: current.preview,
          scriptBuilder: current.scriptBuilder,
          runtimeStatus: current.runtimeStatus,
          commandStatus: current.commandStatus,
          meshWorkspace: current.meshWorkspace,
          stepUpdateV2: current.stepUpdateV2,
          workspaceStatus: current.workspaceStatus,
          isFemBackend: current.isFemBackend,
          domainCapabilities: current.domainCapabilities,
          resourceRevisions: current.resourceRevisions,
          displaySelection: current.displaySelection,
          previewConfig: current.previewConfig,
          latestFieldFrames: current.latestFieldFrames,
          latestFieldGrid: current.latestFieldGrid,
          fieldFrameEnvelope: current.fieldFrameEnvelope,
        });

        if (ENABLE_DEBUG) {
          console.info(
            "[fullmag-debug][data-plane] scalars fetched",
            { revision, rows: window.rows.length },
          );
        }
      } catch (err) {
        if (controller.signal.aborted) {
          return;
        }
        console.warn("[fullmag][data-plane] scalar fetch failed", err);
      } finally {
        if (scalarRequestRef.current?.sequence === requestSequence) {
          scalarRequestRef.current = null;
        }
      }
    },
    [applyNormalizedState, enabled, runtimeScopeKey],
  );

  // ── Domain / topology fetching ──────────────────────────────────

  const fetchDomain = useCallback(
    async (genId: string) => {
      if (!enabled) return;
      if (fetchedDomainGenRef.current === genId) return;
      const requestScopeKey = runtimeScopeKey;
      if (!requestScopeKey) return;
      const requestKey = `${requestScopeKey}:${genId}`;
      const negativeCacheKey = `domain:${requestKey}`;
      if (negativeResourceCacheRef.current.has(negativeCacheKey)) return;
      if (domainRequestRef.current?.key === requestKey) return;
      domainRequestRef.current?.controller.abort();
      const controller = new AbortController();
      const requestSequence = ++requestSequenceRef.current;
      domainRequestRef.current = { key: requestKey, controller, sequence: requestSequence };
      const isCurrentRequest = () =>
        domainRequestRef.current?.sequence === requestSequence &&
        prevCacheScopeRef.current?.runtimeScopeKey === requestScopeKey &&
        !controller.signal.aborted;

      try {
        const client = getLiveSessionClient();
        const numericGenerationId = Number.parseInt(genId, 10);
        const meta = await getCachedJsonResource({
          client,
          cacheKey: `data-plane:domain-meta:${requestScopeKey}:${genId}`,
          revision: Number.isFinite(numericGenerationId) ? numericGenerationId : 0,
          generationId: Number.isFinite(numericGenerationId) ? numericGenerationId : 0,
          fetcher: () => client.domain.getMeta({ signal: controller.signal }),
          requestOptions: { signal: controller.signal },
          auditResource: "domain-meta",
        });
        if (!isCurrentRequest()) return;

        const isFem = meta.discretization === "fem";
        const current = useSessionRuntimeStore.getState();
        const topologyCacheKey = `data-plane:domain-topology:${requestScopeKey}:${meta.generation_id}`;
        const femMesh = isFem
          ? mergeFemMeshResource(
              {
                ...buildFemMeshFromDecodedTopology(
                  await decodeTopologyOffThread(
                    await (async () => {
                      const cached = client.getCache().get<ArrayBuffer>(
                        topologyCacheKey,
                      );
                      if (cached && cached.revision === meta.generation_id) {
                        return cached.data;
                      }
                      incrementFrontendAuditResourceFetch("domain-topology", 1);
                      const response = await client.domain.getTopologyResponse({
                        signal: controller.signal,
                        cache: "default",
                        headers:
                          cached?.eTag != null
                            ? {
                                "If-None-Match": cached.eTag,
                              }
                            : undefined,
                      });
                      if (!isCurrentRequest()) {
                        throw new Error("stale domain topology request");
                      }
                      if (response.status === 304 && cached) {
                        return cached.data;
                      }
                      if (isNegativeDataPlaneResponse(response.buffer)) {
                        throw response.buffer;
                      }
                      client.getCache().set(
                        topologyCacheKey,
                        response.buffer,
                        meta.generation_id,
                        meta.generation_id,
                        response.headers.get("etag"),
                      );
                      return response.buffer;
                    })(),
                  ),
                  null,
                  { legacyArrays: "lazy" },
                ),
                generation_id: genId,
                mesh_id: `resource-topology:${genId}`,
              },
              current.femMesh,
            )
          : null;
        if (!isCurrentRequest()) return;
        fetchedDomainGenRef.current = genId;

        // Merge into store
        if (!isCurrentRequest()) return;
        applyNormalizedState({
          stateVersion: current.stateVersion,
          session: current.session,
          run: current.run,
          metadata: null,
          liveState: current.liveState,
          scalarRows: current.scalarRows,
          engineLog: current.engineLog,
          quantities: current.quantities,
          artifacts: current.artifacts,
          femMesh,
          preview: current.preview,
          scriptBuilder: current.scriptBuilder,
          runtimeStatus: current.runtimeStatus,
          commandStatus: current.commandStatus,
          meshWorkspace: current.meshWorkspace,
          stepUpdateV2: current.stepUpdateV2,
          workspaceStatus: current.workspaceStatus,
          isFemBackend: isFem,
          domainCapabilities: current.domainCapabilities,
          resourceRevisions: current.resourceRevisions,
          displaySelection: current.displaySelection,
          previewConfig: current.previewConfig,
          latestFieldFrames: current.latestFieldFrames,
          latestFieldGrid: current.latestFieldGrid,
          fieldFrameEnvelope: current.fieldFrameEnvelope,
        });

        if (ENABLE_DEBUG) {
          console.info(
            "[fullmag-debug][data-plane] domain meta fetched",
            {
              genId,
              discretization: meta.discretization,
              femMeshNodes: femMesh?.node_count ?? 0,
            },
          );
        }
      } catch (err) {
        if (controller.signal.aborted) {
          return;
        }
        if (isNegativeDataPlaneResponse(err)) {
          if (!isCurrentRequest()) return;
          negativeResourceCacheRef.current.add(negativeCacheKey);
          fetchedDomainGenRef.current = genId;
          return;
        }
        console.warn("[fullmag][data-plane] domain fetch failed", err);
      } finally {
        if (domainRequestRef.current?.sequence === requestSequence) {
          domainRequestRef.current = null;
        }
      }
    },
    [applyNormalizedState, enabled, runtimeScopeKey],
  );

  const fetchMeshTopology = useCallback(
    async (revision: number) => {
      if (!enabled) return;
      if (fetchedMeshRevRef.current === revision) return;
      const requestScopeKey = runtimeScopeKey;
      if (!requestScopeKey) return;
      const requestKey = `${requestScopeKey}:${revision}`;
      const negativeCacheKey = `mesh:${requestKey}`;
      if (negativeResourceCacheRef.current.has(negativeCacheKey)) return;
      if (meshRequestRef.current?.key === requestKey) return;
      meshRequestRef.current?.controller.abort();
      const controller = new AbortController();
      const requestSequence = ++requestSequenceRef.current;
      meshRequestRef.current = { key: requestKey, controller, sequence: requestSequence };
      const isCurrentRequest = () =>
        meshRequestRef.current?.sequence === requestSequence &&
        prevCacheScopeRef.current?.runtimeScopeKey === requestScopeKey &&
        !controller.signal.aborted;

      try {
        const client = getLiveSessionClient();
        const topologyCacheKey = `data-plane:mesh-shared-domain-topology:${requestScopeKey}`;
        if (!leakIsolationFlags.enableSharedDomainMeshTopologyFetch) {
          fetchedMeshRevRef.current = revision;
          return;
        }
        const [summaryResource, manifestResource, topologyBuffer] = await Promise.all([
          leakIsolationFlags.enableSharedDomainMeshSummaryHydration
            ? getCachedJsonResource({
                client,
                cacheKey: `data-plane:mesh-summary:${requestScopeKey}`,
                revision,
                fetcher: () => client.mesh.getSummary({ signal: controller.signal }),
                responseFetcher: (opts) => client.mesh.getSummaryResponse(opts),
                requestOptions: { signal: controller.signal },
                auditResource: "mesh-summary",
              })
            : Promise.resolve(null),
          leakIsolationFlags.enableSharedDomainMeshManifestHydration
            ? getCachedJsonResource({
                client,
                cacheKey: `data-plane:mesh-manifest:${requestScopeKey}`,
                revision,
                fetcher: () => client.mesh.getSharedDomainManifest({ signal: controller.signal }),
                responseFetcher: (opts) =>
                  client.mesh.getSharedDomainManifestResponse(opts),
                requestOptions: { signal: controller.signal },
                auditResource: "mesh-manifest",
              })
            : Promise.resolve(null),
          (async () => {
            const cached = client.getCache().get<ArrayBuffer>(topologyCacheKey);
            if (cached && cached.revision === revision) {
              return cached.data;
            }
            incrementFrontendAuditResourceFetch("mesh-topology", 1);
            const response = await client.mesh.getSharedDomainTopologyResponse({
              signal: controller.signal,
              cache: "default",
              headers:
                cached?.eTag != null
                  ? {
                      "If-None-Match": cached.eTag,
                    }
                  : undefined,
            });
            if (!isCurrentRequest()) {
              throw new Error("stale mesh topology request");
            }
            if (response.status === 304 && cached) {
              return cached.data;
            }
            if (isNegativeDataPlaneResponse(response.buffer)) {
              throw response.buffer;
            }
            client.getCache().set(
              topologyCacheKey,
              response.buffer,
              revision,
              0,
              response.headers.get("etag"),
            );
            return response.buffer;
          })(),
        ]);
        if (!isCurrentRequest()) return;

        if (topologyBuffer.byteLength === 0) {
          if (!isCurrentRequest()) return;
          negativeResourceCacheRef.current.add(negativeCacheKey);
          fetchedMeshRevRef.current = revision;
          const current = useSessionRuntimeStore.getState();
          applyNormalizedState({
            stateVersion: current.stateVersion,
            session: current.session,
            run: current.run,
            metadata: null,
            liveState: current.liveState,
            scalarRows: current.scalarRows,
            engineLog: current.engineLog,
            quantities: current.quantities,
            artifacts: current.artifacts,
            femMesh: null,
            preview: current.preview,
            scriptBuilder: current.scriptBuilder,
            runtimeStatus: current.runtimeStatus,
            commandStatus: current.commandStatus,
            meshWorkspace: current.meshWorkspace,
            stepUpdateV2: current.stepUpdateV2,
            workspaceStatus: current.workspaceStatus,
            isFemBackend: current.isFemBackend,
            domainCapabilities: current.domainCapabilities,
            resourceRevisions: current.resourceRevisions,
            displaySelection: current.displaySelection,
            previewConfig: current.previewConfig,
            latestFieldFrames: current.latestFieldFrames,
            latestFieldGrid: current.latestFieldGrid,
            fieldFrameEnvelope: current.fieldFrameEnvelope,
          });
          return;
        }

        if (!leakIsolationFlags.enableSharedDomainMeshTopologyDecode) {
          fetchedMeshRevRef.current = revision;
          return;
        }

        const meshSummary =
          normalizeMeshWorkspace({
            mesh_summary: summaryResource?.mesh_summary ?? null,
          })?.mesh_summary ?? null;
        const resourceFemMesh = applyMeshSharedDomainManifest(
          buildFemMeshFromDecodedTopology(
            await decodeTopologyOffThread(topologyBuffer),
            meshSummary,
            { legacyArrays: "lazy" },
          ),
          manifestResource,
        );
        if (!isCurrentRequest()) return;

        const current = useSessionRuntimeStore.getState();
        fetchedMeshRevRef.current = revision;
        if (!leakIsolationFlags.enableSharedDomainMeshStoreMerge) {
          return;
        }
        if (!leakIsolationFlags.enableSharedDomainMeshStoreRead) {
          return;
        }
        const nextFemMesh = leakIsolationFlags.enableSharedDomainMeshStoreFemMeshWrite
          ? (
              leakIsolationFlags.enableSharedDomainMeshMergeWithExistingStoreMesh
                ? mergeFemMeshResource(resourceFemMesh, current.femMesh)
                : resourceFemMesh
            )
          : current.femMesh;
        if (!leakIsolationFlags.enableSharedDomainMeshStoreApply) {
          return;
        }
        applyNormalizedState({
          stateVersion: current.stateVersion,
          session: current.session,
          run: current.run,
          metadata: null,
          liveState: current.liveState,
          scalarRows: current.scalarRows,
          engineLog: current.engineLog,
          quantities: current.quantities,
          artifacts: current.artifacts,
          femMesh: nextFemMesh,
          preview: current.preview,
          scriptBuilder: current.scriptBuilder,
          runtimeStatus: current.runtimeStatus,
          commandStatus: current.commandStatus,
          meshWorkspace: current.meshWorkspace,
          stepUpdateV2: current.stepUpdateV2,
          workspaceStatus: current.workspaceStatus,
          isFemBackend: current.isFemBackend,
          domainCapabilities: current.domainCapabilities,
          resourceRevisions: current.resourceRevisions,
          displaySelection: current.displaySelection,
          previewConfig: current.previewConfig,
          latestFieldFrames: current.latestFieldFrames,
          latestFieldGrid: current.latestFieldGrid,
          fieldFrameEnvelope: current.fieldFrameEnvelope,
        });

        if (ENABLE_DEBUG) {
          console.info("[fullmag-debug][data-plane] mesh topology fetched", {
            revision,
            generationId: resourceFemMesh.generation_id,
            nodeCount: resourceFemMesh.node_count,
            elementCount: resourceFemMesh.element_count,
          });
        }
      } catch (err) {
        if (controller.signal.aborted) {
          return;
        }
        if (
          isNegativeDataPlaneResponse(err)
        ) {
          if (!isCurrentRequest()) return;
          negativeResourceCacheRef.current.add(negativeCacheKey);
          fetchedMeshRevRef.current = revision;
          const current = useSessionRuntimeStore.getState();
          if (!isCurrentRequest()) return;
          applyNormalizedState({
            stateVersion: current.stateVersion,
            session: current.session,
            run: current.run,
            metadata: null,
            liveState: current.liveState,
            scalarRows: current.scalarRows,
            engineLog: current.engineLog,
            quantities: current.quantities,
            artifacts: current.artifacts,
            femMesh: null,
            preview: current.preview,
            scriptBuilder: current.scriptBuilder,
            runtimeStatus: current.runtimeStatus,
            commandStatus: current.commandStatus,
            meshWorkspace: current.meshWorkspace,
            stepUpdateV2: current.stepUpdateV2,
            workspaceStatus: current.workspaceStatus,
            isFemBackend: current.isFemBackend,
            domainCapabilities: current.domainCapabilities,
            resourceRevisions: current.resourceRevisions,
            displaySelection: current.displaySelection,
            previewConfig: current.previewConfig,
            latestFieldFrames: current.latestFieldFrames,
            latestFieldGrid: current.latestFieldGrid,
            fieldFrameEnvelope: current.fieldFrameEnvelope,
          });
          return;
        }
        console.warn("[fullmag][data-plane] mesh topology fetch failed", err);
      } finally {
        if (meshRequestRef.current?.sequence === requestSequence) {
          meshRequestRef.current = null;
        }
      }
    },
    [
      applyNormalizedState,
      enabled,
      leakIsolationFlags.enableSharedDomainMeshManifestHydration,
      leakIsolationFlags.enableSharedDomainMeshMergeWithExistingStoreMesh,
      leakIsolationFlags.enableSharedDomainMeshStoreApply,
      leakIsolationFlags.enableSharedDomainMeshStoreFemMeshWrite,
      leakIsolationFlags.enableSharedDomainMeshStoreMerge,
      leakIsolationFlags.enableSharedDomainMeshStoreRead,
      leakIsolationFlags.enableSharedDomainMeshSummaryHydration,
      leakIsolationFlags.enableSharedDomainMeshTopologyDecode,
      leakIsolationFlags.enableSharedDomainMeshTopologyFetch,
      runtimeScopeKey,
    ],
  );

  // ── Quantities / artifacts fetching ────────────────────────────

  const fetchQuantities = useCallback(
    async (cacheKey: string, revision: number) => {
      if (!enabled) return;
      if (fetchedCatalogKeyRef.current === cacheKey) return;
      const requestScopeKey = runtimeScopeKey;
      if (!requestScopeKey) return;
      const requestKey = `${requestScopeKey}:${cacheKey}`;
      if (catalogRequestRef.current?.key === requestKey) return;
      catalogRequestRef.current?.controller.abort();
      const controller = new AbortController();
      const requestSequence = ++requestSequenceRef.current;
      catalogRequestRef.current = { key: requestKey, controller, sequence: requestSequence };
      const isCurrentRequest = () =>
        catalogRequestRef.current?.sequence === requestSequence &&
        prevCacheScopeRef.current?.runtimeScopeKey === requestScopeKey &&
        !controller.signal.aborted;

      try {
        const client = getLiveSessionClient();
        const [quantityCatalog, fieldCatalog] = await Promise.all([
          getCachedJsonResource({
            client,
            cacheKey: `data-plane:quantities-catalog:${requestScopeKey}`,
            revision,
            fetcher: () => client.quantities.getCatalog({ signal: controller.signal }),
            requestOptions: { signal: controller.signal },
            auditResource: "quantity-catalog",
          }),
          getCachedJsonResource({
            client,
            cacheKey: `data-plane:fields-catalog:${requestScopeKey}`,
            revision,
            fetcher: () => client.fields.getCatalog({ signal: controller.signal }),
            requestOptions: { signal: controller.signal },
            auditResource: "field-catalog",
          }),
        ]);
        if (!isCurrentRequest()) return;
        fetchedCatalogKeyRef.current = cacheKey;

        const current = useSessionRuntimeStore.getState();
        if (!isCurrentRequest()) return;
        applyNormalizedState({
          stateVersion: current.stateVersion,
          session: current.session,
          run: current.run,
          metadata: null,
          liveState: current.liveState,
          scalarRows: current.scalarRows,
          engineLog: current.engineLog,
          quantities: mapResourceQuantities(quantityCatalog, fieldCatalog),
          artifacts: current.artifacts,
          femMesh: current.femMesh,
          preview: current.preview,
          scriptBuilder: current.scriptBuilder,
          runtimeStatus: current.runtimeStatus,
          commandStatus: current.commandStatus,
          meshWorkspace: current.meshWorkspace,
          stepUpdateV2: current.stepUpdateV2,
          workspaceStatus: current.workspaceStatus,
          isFemBackend: current.isFemBackend,
          domainCapabilities: current.domainCapabilities,
          resourceRevisions: current.resourceRevisions,
          displaySelection: current.displaySelection,
          previewConfig: current.previewConfig,
          latestFieldFrames: current.latestFieldFrames,
          latestFieldGrid: current.latestFieldGrid,
          fieldFrameEnvelope: current.fieldFrameEnvelope,
        });

        if (ENABLE_DEBUG) {
          console.info("[fullmag-debug][data-plane] quantity catalogs fetched", {
            cacheKey,
            quantities: quantityCatalog.quantities.length,
            fields: fieldCatalog.quantities.length,
          });
        }
      } catch (err) {
        if (controller.signal.aborted) {
          return;
        }
        console.warn("[fullmag][data-plane] quantity catalog fetch failed", err);
      } finally {
        if (catalogRequestRef.current?.sequence === requestSequence) {
          catalogRequestRef.current = null;
        }
      }
    },
    [applyNormalizedState, enabled, runtimeScopeKey],
  );

  const fetchArtifacts = useCallback(
    async (cacheKey: string, revision: number) => {
      if (!enabled) return;
      if (fetchedArtifactsKeyRef.current === cacheKey) return;
      const requestScopeKey = runtimeScopeKey;
      if (!requestScopeKey) return;
      const requestKey = `${requestScopeKey}:${cacheKey}`;
      if (artifactsRequestRef.current?.key === requestKey) return;
      artifactsRequestRef.current?.controller.abort();
      const controller = new AbortController();
      const requestSequence = ++requestSequenceRef.current;
      artifactsRequestRef.current = { key: requestKey, controller, sequence: requestSequence };
      const isCurrentRequest = () =>
        artifactsRequestRef.current?.sequence === requestSequence &&
        prevCacheScopeRef.current?.runtimeScopeKey === requestScopeKey &&
        !controller.signal.aborted;

      try {
        const client = getLiveSessionClient();
        const artifacts = await getCachedJsonResource({
          client,
          cacheKey: `data-plane:artifacts:${requestScopeKey}`,
          revision,
          fetcher: () => client.artifacts.list({ signal: controller.signal }),
          responseFetcher: (opts) => client.artifacts.listResponse(opts),
          requestOptions: { signal: controller.signal },
          auditResource: "artifacts",
        });
        if (!isCurrentRequest()) return;
        fetchedArtifactsKeyRef.current = cacheKey;

        const current = useSessionRuntimeStore.getState();
        if (!isCurrentRequest()) return;
        applyNormalizedState({
          stateVersion: current.stateVersion,
          session: current.session,
          run: current.run,
          metadata: null,
          liveState: current.liveState,
          scalarRows: current.scalarRows,
          engineLog: current.engineLog,
          quantities: current.quantities,
          artifacts,
          femMesh: current.femMesh,
          preview: current.preview,
          scriptBuilder: current.scriptBuilder,
          runtimeStatus: current.runtimeStatus,
          commandStatus: current.commandStatus,
          meshWorkspace: current.meshWorkspace,
          stepUpdateV2: current.stepUpdateV2,
          workspaceStatus: current.workspaceStatus,
          isFemBackend: current.isFemBackend,
          domainCapabilities: current.domainCapabilities,
          resourceRevisions: current.resourceRevisions,
          displaySelection: current.displaySelection,
          previewConfig: current.previewConfig,
          latestFieldFrames: current.latestFieldFrames,
          latestFieldGrid: current.latestFieldGrid,
          fieldFrameEnvelope: current.fieldFrameEnvelope,
        });

        if (ENABLE_DEBUG) {
          console.info("[fullmag-debug][data-plane] artifacts fetched", {
            cacheKey,
            artifacts: artifacts.length,
          });
        }
      } catch (err) {
        if (controller.signal.aborted) {
          return;
        }
        console.warn("[fullmag][data-plane] artifacts fetch failed", err);
      } finally {
        if (artifactsRequestRef.current?.sequence === requestSequence) {
          artifactsRequestRef.current = null;
        }
      }
    },
    [applyNormalizedState, enabled, runtimeScopeKey],
  );

  const fetchEngineLog = useCallback(
    async (cacheKey: string, revision: number) => {
      if (!enabled) return;
      if (fetchedEngineLogKeyRef.current === cacheKey) return;
      const requestScopeKey = runtimeScopeKey;
      if (!requestScopeKey) return;
      const requestKey = `${requestScopeKey}:${cacheKey}`;
      if (engineLogRequestRef.current?.key === requestKey) return;
      engineLogRequestRef.current?.controller.abort();
      const controller = new AbortController();
      const requestSequence = ++requestSequenceRef.current;
      engineLogRequestRef.current = { key: requestKey, controller, sequence: requestSequence };
      const isCurrentRequest = () =>
        engineLogRequestRef.current?.sequence === requestSequence &&
        prevCacheScopeRef.current?.runtimeScopeKey === requestScopeKey &&
        !controller.signal.aborted;

      try {
        const client = getLiveSessionClient();
        const engineLog = await getCachedJsonResource({
          client,
          cacheKey: `data-plane:engine-log:${requestScopeKey}`,
          revision,
          fetcher: () => client.logs.getEngine({ signal: controller.signal }),
          responseFetcher: (opts) => client.logs.getEngineResponse(opts),
          requestOptions: { signal: controller.signal },
          auditResource: "engine-log",
        });
        if (!isCurrentRequest()) return;
        fetchedEngineLogKeyRef.current = cacheKey;

        const current = useSessionRuntimeStore.getState();
        if (!isCurrentRequest()) return;
        applyNormalizedState({
          stateVersion: current.stateVersion,
          session: current.session,
          run: current.run,
          metadata: null,
          liveState: current.liveState,
          scalarRows: current.scalarRows,
          engineLog: engineLog.entries,
          quantities: current.quantities,
          artifacts: current.artifacts,
          femMesh: current.femMesh,
          preview: current.preview,
          scriptBuilder: current.scriptBuilder,
          runtimeStatus: current.runtimeStatus,
          commandStatus: current.commandStatus,
          meshWorkspace: current.meshWorkspace,
          stepUpdateV2: current.stepUpdateV2,
          workspaceStatus: current.workspaceStatus,
          isFemBackend: current.isFemBackend,
          domainCapabilities: current.domainCapabilities,
          resourceRevisions: current.resourceRevisions,
          displaySelection: current.displaySelection,
          previewConfig: current.previewConfig,
          latestFieldFrames: current.latestFieldFrames,
          latestFieldGrid: current.latestFieldGrid,
          fieldFrameEnvelope: current.fieldFrameEnvelope,
        });

        if (ENABLE_DEBUG) {
          console.info("[fullmag-debug][data-plane] engine log fetched", {
            cacheKey,
            total: engineLog.total,
            revision: engineLog.revision,
          });
        }
      } catch (err) {
        if (controller.signal.aborted) {
          return;
        }
        console.warn("[fullmag][data-plane] engine log fetch failed", err);
      } finally {
        if (engineLogRequestRef.current?.sequence === requestSequence) {
          engineLogRequestRef.current = null;
        }
      }
    },
    [applyNormalizedState, enabled, runtimeScopeKey],
  );

  // ── Watchers ────────────────────────────────────────────────────

  // Watch field revision changes
  useEffect(() => {
    if (
      !enabled ||
      !leakIsolationFlags.enableBinaryFieldHydration ||
      !runtimeScopeKey
    ) {
      return;
    }
    if (fieldFrameEnvelope && fieldFrameEnvelope.fieldRevision > 0) {
      fetchFieldVector(fieldFrameEnvelope);
    }
  }, [
    enabled,
    fetchFieldVector,
    fieldFrameEnvelope,
    leakIsolationFlags.enableBinaryFieldHydration,
    runtimeScopeKey,
  ]);

  // Watch scalar revision changes
  useEffect(() => {
    if (!enabled || !leakIsolationFlags.enableScalarHydration || !runtimeScopeKey) {
      return;
    }
    if (scalarRevision != null && scalarRevision > 0) {
      fetchScalars(scalarRevision);
    }
  }, [
    enabled,
    fetchScalars,
    leakIsolationFlags.enableScalarHydration,
    runtimeScopeKey,
    scalarRevision,
  ]);

  // Watch domain generation changes
  useEffect(() => {
    if (
      !enabled ||
      !leakIsolationFlags.enableMeshTopologyHydration ||
      !leakIsolationFlags.enableDomainTopologyHydration ||
      !runtimeScopeKey
    ) {
      return;
    }
    if (isFemBackend && meshRevision > 0) {
      return;
    }
    if (fieldFrameEnvelope?.meshGenerationId) {
      fetchDomain(fieldFrameEnvelope.meshGenerationId);
    }
  }, [
    enabled,
    fetchDomain,
    fieldFrameEnvelope?.meshGenerationId,
    isFemBackend,
    leakIsolationFlags.enableDomainTopologyHydration,
    leakIsolationFlags.enableMeshTopologyHydration,
    meshRevision,
    runtimeScopeKey,
  ]);

  useEffect(() => {
    if (
      !enabled ||
      !leakIsolationFlags.enableMeshTopologyHydration ||
      !leakIsolationFlags.enableSharedDomainMeshTopologyHydration ||
      (
        !leakIsolationFlags.enableSharedDomainMeshTopologyFetch &&
        !leakIsolationFlags.enableSharedDomainMeshTopologyDecode &&
        !leakIsolationFlags.enableSharedDomainMeshStoreMerge &&
        !leakIsolationFlags.enableSharedDomainMeshStoreApply
      ) ||
      !runtimeScopeKey ||
      !isFemBackend
    ) {
      return;
    }
    if (meshRevision > 0) {
      void fetchMeshTopology(meshRevision);
    }
  }, [
    enabled,
    fetchMeshTopology,
    isFemBackend,
    leakIsolationFlags.enableMeshTopologyHydration,
    leakIsolationFlags.enableSharedDomainMeshStoreApply,
    leakIsolationFlags.enableSharedDomainMeshStoreMerge,
    leakIsolationFlags.enableSharedDomainMeshTopologyHydration,
    leakIsolationFlags.enableSharedDomainMeshTopologyDecode,
    leakIsolationFlags.enableSharedDomainMeshTopologyFetch,
    meshRevision,
    runtimeScopeKey,
  ]);

  useEffect(() => {
    if (!enabled || !runtimeScopeKey) {
      return;
    }
    const cacheKey = `${runtimeScopeKey}:${fieldsRevision}`;
    void fetchQuantities(cacheKey, fieldsRevision);
  }, [enabled, fetchQuantities, fieldsRevision, runtimeScopeKey]);

  useEffect(() => {
    if (!enabled || !runtimeScopeKey) {
      return;
    }
    const cacheKey = `${runtimeScopeKey}:${artifactsRevision}`;
    void fetchArtifacts(cacheKey, artifactsRevision);
  }, [artifactsRevision, enabled, fetchArtifacts, runtimeScopeKey]);

  useEffect(() => {
    if (!enabled || !runtimeScopeKey) {
      return;
    }
    const cacheKey = `${runtimeScopeKey}:${engineLogRevision}`;
    void fetchEngineLog(cacheKey, engineLogRevision);
  }, [enabled, engineLogRevision, fetchEngineLog, runtimeScopeKey]);
}
