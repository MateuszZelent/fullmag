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
  // Read revision signals from the store (set by useNewApiBridge)
  const fieldFrameEnvelope = useSessionRuntimeStore(
    (s) => s.fieldFrameEnvelope,
  );
  const scalarRevision = useSessionRuntimeStore(
    (s) => s.liveState?.step ?? s.stateVersion,
  );
  const sessionId = useSessionRuntimeStore((s) => s.session?.session_id);
  const runId = useSessionRuntimeStore((s) => s.run?.run_id);
  const isFemBackend = useSessionRuntimeStore((s) => s.isFemBackend);
  const displaySelection = useSessionRuntimeStore((s) => s.displaySelection);
  const resourceRevisions = useSessionRuntimeStore((s) => s.resourceRevisions);
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

  // Reset accumulators when session changes
  const prevRuntimeScopeRef = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) {
      return;
    }
    if (runtimeScopeKey !== prevRuntimeScopeRef.current) {
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
      prevRuntimeScopeRef.current = runtimeScopeKey;
      scalarAccumulatorRef.current = [];
      fetchedFieldRevRef.current = null;
      fetchedScalarRevRef.current = null;
      fetchedDomainGenRef.current = null;
      fetchedMeshRevRef.current = null;
      fetchedCatalogKeyRef.current = null;
      fetchedArtifactsKeyRef.current = null;
      fetchedEngineLogKeyRef.current = null;
    }
  }, [enabled, runtimeScopeKey]);

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
      if (fieldRequestRef.current?.key === requestKey) return;
      fieldRequestRef.current?.controller.abort();
      const controller = new AbortController();
      const requestSequence = ++requestSequenceRef.current;
      fieldRequestRef.current = { key: requestKey, controller, sequence: requestSequence };
      const isCurrentRequest = () =>
        fieldRequestRef.current?.sequence === requestSequence &&
        prevRuntimeScopeRef.current === requestScopeKey &&
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
            if (response.buffer == null) {
              throw new Error(`field vector response for ${envelope.quantityId} had no buffer`);
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
        if (err instanceof LiveApiError && err.isNotFound) {
          // Quantity not available yet — skip silently
          return;
        }
        console.warn("[fullmag][data-plane] field fetch failed", err);
      } finally {
        if (fieldRequestRef.current?.sequence === requestSequence) {
          fieldRequestRef.current = null;
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
        prevRuntimeScopeRef.current === requestScopeKey &&
        !controller.signal.aborted;

      try {
        const client = getLiveSessionClient();
        const window = await client.scalars.getWindow({
          sinceRevision: fetchedScalarRevRef.current ?? 0,
        }, { signal: controller.signal });
        if (!isCurrentRequest()) return;

        if (window.rows.length > 0) {
          const adapted = scalarWindowToRows(window).map(adaptScalarRow);
          scalarAccumulatorRef.current = [
            ...scalarAccumulatorRef.current,
            ...adapted,
          ];
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
      if (domainRequestRef.current?.key === requestKey) return;
      domainRequestRef.current?.controller.abort();
      const controller = new AbortController();
      const requestSequence = ++requestSequenceRef.current;
      domainRequestRef.current = { key: requestKey, controller, sequence: requestSequence };
      const isCurrentRequest = () =>
        domainRequestRef.current?.sequence === requestSequence &&
        prevRuntimeScopeRef.current === requestScopeKey &&
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
      if (meshRequestRef.current?.key === requestKey) return;
      meshRequestRef.current?.controller.abort();
      const controller = new AbortController();
      const requestSequence = ++requestSequenceRef.current;
      meshRequestRef.current = { key: requestKey, controller, sequence: requestSequence };
      const isCurrentRequest = () =>
        meshRequestRef.current?.sequence === requestSequence &&
        prevRuntimeScopeRef.current === requestScopeKey &&
        !controller.signal.aborted;

      try {
        const client = getLiveSessionClient();
        const topologyCacheKey = `data-plane:mesh-shared-domain-topology:${requestScopeKey}`;
        const [summaryResource, manifestResource, topologyBuffer] = await Promise.all([
          getCachedJsonResource({
            client,
            cacheKey: `data-plane:mesh-summary:${requestScopeKey}:${revision}`,
            revision,
            fetcher: () => client.mesh.getSummary({ signal: controller.signal }),
            responseFetcher: (opts) => client.mesh.getSummaryResponse(opts),
            requestOptions: { signal: controller.signal },
          }),
          getCachedJsonResource({
            client,
            cacheKey: `data-plane:mesh-manifest:${requestScopeKey}:${revision}`,
            revision,
            fetcher: () => client.mesh.getSharedDomainManifest({ signal: controller.signal }),
            responseFetcher: (opts) =>
              client.mesh.getSharedDomainManifestResponse(opts),
            requestOptions: { signal: controller.signal },
          }),
          (async () => {
            const cached = client.getCache().get<ArrayBuffer>(topologyCacheKey);
            if (cached && cached.revision === revision) {
              return cached.data;
            }
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

        const meshSummary =
          normalizeMeshWorkspace({
            mesh_summary: summaryResource.mesh_summary ?? null,
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
          femMesh: mergeFemMeshResource(resourceFemMesh, current.femMesh),
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
          err instanceof LiveApiError &&
          (err.status === 404 || err.status === 204)
        ) {
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
    [applyNormalizedState, enabled, runtimeScopeKey],
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
        prevRuntimeScopeRef.current === requestScopeKey &&
        !controller.signal.aborted;

      try {
        const client = getLiveSessionClient();
        const [quantityCatalog, fieldCatalog] = await Promise.all([
          getCachedJsonResource({
            client,
            cacheKey: `data-plane:quantities-catalog:${cacheKey}`,
            revision,
            fetcher: () => client.quantities.getCatalog({ signal: controller.signal }),
            requestOptions: { signal: controller.signal },
          }),
          getCachedJsonResource({
            client,
            cacheKey: `data-plane:fields-catalog:${cacheKey}`,
            revision,
            fetcher: () => client.fields.getCatalog({ signal: controller.signal }),
            requestOptions: { signal: controller.signal },
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
        prevRuntimeScopeRef.current === requestScopeKey &&
        !controller.signal.aborted;

      try {
        const client = getLiveSessionClient();
        const artifacts = await getCachedJsonResource({
          client,
          cacheKey: `data-plane:artifacts:${cacheKey}`,
          revision,
          fetcher: () => client.artifacts.list({ signal: controller.signal }),
          responseFetcher: (opts) => client.artifacts.listResponse(opts),
          requestOptions: { signal: controller.signal },
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
        prevRuntimeScopeRef.current === requestScopeKey &&
        !controller.signal.aborted;

      try {
        const client = getLiveSessionClient();
        const engineLog = await getCachedJsonResource({
          client,
          cacheKey: `data-plane:engine-log:${cacheKey}`,
          revision,
          fetcher: () => client.logs.getEngine({ signal: controller.signal }),
          responseFetcher: (opts) => client.logs.getEngineResponse(opts),
          requestOptions: { signal: controller.signal },
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
    if (!enabled || !runtimeScopeKey) {
      return;
    }
    if (fieldFrameEnvelope && fieldFrameEnvelope.fieldRevision > 0) {
      fetchFieldVector(fieldFrameEnvelope);
    }
  }, [enabled, fetchFieldVector, fieldFrameEnvelope, runtimeScopeKey]);

  // Watch scalar revision changes
  useEffect(() => {
    if (!enabled || !runtimeScopeKey) {
      return;
    }
    if (scalarRevision != null && scalarRevision > 0) {
      fetchScalars(scalarRevision);
    }
  }, [enabled, fetchScalars, runtimeScopeKey, scalarRevision]);

  // Watch domain generation changes
  useEffect(() => {
    if (!enabled || !runtimeScopeKey) {
      return;
    }
    if (fieldFrameEnvelope?.meshGenerationId) {
      fetchDomain(fieldFrameEnvelope.meshGenerationId);
    }
  }, [enabled, fetchDomain, fieldFrameEnvelope?.meshGenerationId, runtimeScopeKey]);

  useEffect(() => {
    if (!enabled || !runtimeScopeKey || !resourceRevisions || !isFemBackend) {
      return;
    }
    if (resourceRevisions.mesh_revision > 0) {
      void fetchMeshTopology(resourceRevisions.mesh_revision);
    }
  }, [enabled, fetchMeshTopology, isFemBackend, resourceRevisions, runtimeScopeKey]);

  useEffect(() => {
    if (!enabled || !runtimeScopeKey || !resourceRevisions) {
      return;
    }
    const cacheKey = `${runtimeScopeKey}:${resourceRevisions.fields_revision}`;
    void fetchQuantities(cacheKey, resourceRevisions.fields_revision);
  }, [enabled, fetchQuantities, resourceRevisions, runtimeScopeKey]);

  useEffect(() => {
    if (!enabled || !runtimeScopeKey || !resourceRevisions) {
      return;
    }
    const cacheKey = `${runtimeScopeKey}:${resourceRevisions.artifacts_revision}`;
    void fetchArtifacts(cacheKey, resourceRevisions.artifacts_revision);
  }, [enabled, fetchArtifacts, resourceRevisions, runtimeScopeKey]);

  useEffect(() => {
    if (!enabled || !runtimeScopeKey || !resourceRevisions) {
      return;
    }
    const cacheKey = `${runtimeScopeKey}:${resourceRevisions.engine_log_revision}`;
    void fetchEngineLog(cacheKey, resourceRevisions.engine_log_revision);
  }, [enabled, fetchEngineLog, resourceRevisions, runtimeScopeKey]);
}
