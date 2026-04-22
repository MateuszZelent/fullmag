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
import { getLiveApiClient } from "@/src/api/client/LiveApiClient";
import { LiveApiError } from "@/src/api/client/errors/LiveApiError";
import { decodeTopology } from "@/src/api/codecs/topologyCodec";
import { synthesizeCapabilitiesFromDiscretization } from "@/src/domain/capabilities";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { normalizeMeshWorkspace } from "@/lib/session/normalize";
import type {
  LatestFieldFrame,
  QuantityDescriptor,
  ScalarRow as StoreScalarRow,
} from "@/lib/session/types";
import type { FieldFrameEnvelope, FieldFrameStats } from "@/lib/fieldFrame/types";
import { scalarWindowToRows } from "@/src/api/client/modules/ScalarHistoryAdapter";
import {
  applyMeshSharedDomainManifest,
  buildFemMeshFromDecodedTopology,
  mergeFemMeshResource,
} from "@/src/hooks/resources/meshFemResource";

const ENABLE_DEBUG =
  typeof process !== "undefined" &&
  process.env.NODE_ENV !== "production" &&
  FRONTEND_DIAGNOSTIC_FLAGS.renderDebug.enableRenderLogging;

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

function mapResourceQuantities(
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
    return {
      id: quantity.id,
      label: field?.label ?? quantity.label,
      kind: field?.kind ?? quantity.shape,
      unit: field?.unit ?? quantity.unit,
      location: field?.location ?? quantity.location,
      available: field?.available ?? false,
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
  const resourceRevisions = useSessionRuntimeStore((s) => s.resourceRevisions);
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

  // Reset accumulators when session changes
  const prevRuntimeScopeRef = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) {
      return;
    }
    if (runtimeScopeKey !== prevRuntimeScopeRef.current) {
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

  // ── Field vector fetching ───────────────────────────────────────

  const fetchFieldVector = useCallback(
    async (envelope: FieldFrameEnvelope) => {
      if (!enabled) return;
      const rev = envelope.fieldRevision;
      const cacheKey = `${envelope.quantityId}:${rev}`;
      if (fetchedFieldRevRef.current === cacheKey) return;

      try {
        const client = getLiveApiClient();
        const result = await client.fields.getVector(envelope.quantityId);
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
          field_revision: rev,
          source_step: envelope.sourceStep,
          source_time: envelope.sourceTime,
        };

        // Merge into store — only update field-related fields
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
            { quantityId: envelope.quantityId, revision: rev, cacheKey },
          );
        }
      } catch (err) {
        if (err instanceof LiveApiError && err.isNotFound) {
          // Quantity not available yet — skip silently
          return;
        }
        console.warn("[fullmag][data-plane] field fetch failed", err);
      }
    },
    [applyNormalizedState, enabled],
  );

  // ── Scalar history fetching ─────────────────────────────────────

  const fetchScalars = useCallback(
    async (revision: number) => {
      if (!enabled) return;
      if (fetchedScalarRevRef.current === revision) return;

      try {
        const client = getLiveApiClient();
        const window = await client.scalars.getWindow({
          sinceRevision: fetchedScalarRevRef.current ?? 0,
        });

        if (window.rows.length > 0) {
          const adapted = scalarWindowToRows(window).map(adaptScalarRow);
          scalarAccumulatorRef.current = [
            ...scalarAccumulatorRef.current,
            ...adapted,
          ];
        }
        fetchedScalarRevRef.current = revision;

        // Merge into store
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
        console.warn("[fullmag][data-plane] scalar fetch failed", err);
      }
    },
    [applyNormalizedState, enabled],
  );

  // ── Domain / topology fetching ──────────────────────────────────

  const fetchDomain = useCallback(
    async (genId: string) => {
      if (!enabled) return;
      if (fetchedDomainGenRef.current === genId) return;

      try {
        const client = getLiveApiClient();
        const meta = await client.domain.getMeta();
        fetchedDomainGenRef.current = genId;

        const isFem = meta.discretization === "fem";
        const domainCapabilities = synthesizeCapabilitiesFromDiscretization(isFem);
        const current = useSessionRuntimeStore.getState();
        const femMesh = isFem
          ? mergeFemMeshResource(
              {
                ...buildFemMeshFromDecodedTopology(
                  decodeTopology(await client.domain.getTopology()),
                  null,
                ),
                generation_id: genId,
                mesh_id: `resource-topology:${genId}`,
              },
              current.femMesh,
            )
          : null;

        // Merge into store
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
          domainCapabilities,
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
        console.warn("[fullmag][data-plane] domain fetch failed", err);
      }
    },
    [applyNormalizedState, enabled],
  );

  const fetchMeshTopology = useCallback(
    async (revision: number) => {
      if (!enabled) return;
      if (fetchedMeshRevRef.current === revision) return;

      try {
        const client = getLiveApiClient();
        const [summaryResource, manifestResource, topologyBuffer] = await Promise.all([
          client.mesh.getSummary(),
          client.mesh.getSharedDomainManifest(),
          client.mesh.getSharedDomainTopology(),
        ]);

        if (topologyBuffer.byteLength === 0) {
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
            decodeTopology(topologyBuffer),
            meshSummary,
          ),
          manifestResource,
        );

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
        if (
          err instanceof LiveApiError &&
          (err.status === 404 || err.status === 204)
        ) {
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
        console.warn("[fullmag][data-plane] mesh topology fetch failed", err);
      }
    },
    [applyNormalizedState, enabled],
  );

  // ── Quantities / artifacts fetching ────────────────────────────

  const fetchQuantities = useCallback(
    async (cacheKey: string) => {
      if (!enabled) return;
      if (fetchedCatalogKeyRef.current === cacheKey) return;

      try {
        const client = getLiveApiClient();
        const [quantityCatalog, fieldCatalog] = await Promise.all([
          client.quantities.getCatalog(),
          client.fields.getCatalog(),
        ]);
        fetchedCatalogKeyRef.current = cacheKey;

        const current = useSessionRuntimeStore.getState();
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
        console.warn("[fullmag][data-plane] quantity catalog fetch failed", err);
      }
    },
    [applyNormalizedState, enabled],
  );

  const fetchArtifacts = useCallback(
    async (cacheKey: string) => {
      if (!enabled) return;
      if (fetchedArtifactsKeyRef.current === cacheKey) return;

      try {
        const artifacts = await getLiveApiClient().artifacts.list();
        fetchedArtifactsKeyRef.current = cacheKey;

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
        console.warn("[fullmag][data-plane] artifacts fetch failed", err);
      }
    },
    [applyNormalizedState, enabled],
  );

  const fetchEngineLog = useCallback(
    async (cacheKey: string) => {
      if (!enabled) return;
      if (fetchedEngineLogKeyRef.current === cacheKey) return;

      try {
        const engineLog = await getLiveApiClient().logs.getEngine();
        fetchedEngineLogKeyRef.current = cacheKey;

        const current = useSessionRuntimeStore.getState();
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
        console.warn("[fullmag][data-plane] engine log fetch failed", err);
      }
    },
    [applyNormalizedState, enabled],
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
    void fetchQuantities(cacheKey);
  }, [enabled, fetchQuantities, resourceRevisions, runtimeScopeKey]);

  useEffect(() => {
    if (!enabled || !runtimeScopeKey || !resourceRevisions) {
      return;
    }
    const cacheKey = `${runtimeScopeKey}:${resourceRevisions.artifacts_revision}`;
    void fetchArtifacts(cacheKey);
  }, [enabled, fetchArtifacts, resourceRevisions, runtimeScopeKey]);

  useEffect(() => {
    if (!enabled || !runtimeScopeKey || !resourceRevisions) {
      return;
    }
    const cacheKey = `${runtimeScopeKey}:${resourceRevisions.engine_log_revision}`;
    void fetchEngineLog(cacheKey);
  }, [enabled, fetchEngineLog, resourceRevisions, runtimeScopeKey]);
}
