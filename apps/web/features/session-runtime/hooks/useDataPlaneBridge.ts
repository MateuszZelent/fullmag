"use client";

/**
 * Data-plane bridge: fetches heavy resources on-demand when revisions change.
 *
 * Instead of bundling everything in a bootstrap payload, this hook
 * watches revision counters from the Zustand store (populated by the
 * status bridge) and lazily fetches:
 *
 *  - field vectors  (when field_revision bumps)
 *  - scalar windows (when scalar_revision bumps)
 *  - domain/topology (when domain_generation_id bumps)
 *
 * The fetched data is written back to the store through
 * applyNormalizedState, merging with the existing state.
 */

import { useEffect, useRef, useCallback } from "react";
import { useSessionRuntimeStore } from "../store/useSessionRuntimeStore";
import { getLiveApiClient } from "@/src/api/client/LiveApiClient";
import { LiveApiError } from "@/src/api/client/errors/LiveApiError";
import type { ScalarRow as StoreScalarRow } from "@/lib/session/types";
import type { FieldFrameEnvelope, FieldFrameStats } from "@/lib/fieldFrame/types";
import { scalarWindowToRows } from "@/src/api/client/modules/ScalarHistoryAdapter";

const ENABLE_DEBUG =
  typeof process !== "undefined" && process.env.NODE_ENV !== "production";

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

// ── Hook ─────────────────────────────────────────────────────────────

/**
 * Mount alongside useNewApiBridge. Watches store revision counters
 * and fetches heavy payloads lazily from the new resource-first API.
 */
export function useDataPlaneBridge(): void {
  // Read revision signals from the store (set by useNewApiBridge)
  const fieldFrameEnvelope = useSessionRuntimeStore(
    (s) => s.fieldFrameEnvelope,
  );
  const stateVersion = useSessionRuntimeStore((s) => s.stateVersion);
  const scalarRevision = useSessionRuntimeStore(
    (s) => s.liveState?.step ?? s.stateVersion,
  );
  const sessionId = useSessionRuntimeStore((s) => s.session?.session_id);

  const applyNormalizedState = useSessionRuntimeStore(
    (s) => s.applyNormalizedState,
  );

  // Track fetched revisions to avoid duplicate requests
  const fetchedFieldRevRef = useRef<number | null>(null);
  const fetchedScalarRevRef = useRef<number | null>(null);
  const fetchedDomainGenRef = useRef<string | null>(null);
  const scalarAccumulatorRef = useRef<StoreScalarRow[]>([]);

  // Reset accumulators when session changes
  const prevSessionRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (sessionId !== prevSessionRef.current) {
      prevSessionRef.current = sessionId;
      scalarAccumulatorRef.current = [];
      fetchedFieldRevRef.current = null;
      fetchedScalarRevRef.current = null;
      fetchedDomainGenRef.current = null;
    }
  }, [sessionId]);

  // ── Field vector fetching ───────────────────────────────────────

  const fetchFieldVector = useCallback(
    async (envelope: FieldFrameEnvelope) => {
      const rev = envelope.fieldRevision;
      if (fetchedFieldRevRef.current === rev) return;

      try {
        const client = getLiveApiClient();
        const result = await client.fields.getVector(envelope.quantityId);
        fetchedFieldRevRef.current = rev;

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
          fieldFrameEnvelope: updatedEnvelope,
        });

        if (ENABLE_DEBUG) {
          console.info(
            "[fullmag-debug][data-plane] field vector fetched",
            { quantityId: envelope.quantityId, revision: rev },
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
    [applyNormalizedState],
  );

  // ── Scalar history fetching ─────────────────────────────────────

  const fetchScalars = useCallback(
    async (revision: number) => {
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
    [applyNormalizedState],
  );

  // ── Domain / topology fetching ──────────────────────────────────

  const fetchDomain = useCallback(
    async (genId: string) => {
      if (fetchedDomainGenRef.current === genId) return;

      try {
        const client = getLiveApiClient();
        const meta = await client.domain.getMeta();
        fetchedDomainGenRef.current = genId;

        const isFem = meta.discretization === "fem";

        // Merge into store
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
          isFemBackend: isFem,
          fieldFrameEnvelope: current.fieldFrameEnvelope,
        });

        if (ENABLE_DEBUG) {
          console.info(
            "[fullmag-debug][data-plane] domain meta fetched",
            { genId, discretization: meta.discretization },
          );
        }
      } catch (err) {
        console.warn("[fullmag][data-plane] domain fetch failed", err);
      }
    },
    [applyNormalizedState],
  );

  // ── Watchers ────────────────────────────────────────────────────

  // Watch field revision changes
  useEffect(() => {
    if (fieldFrameEnvelope && fieldFrameEnvelope.fieldRevision > 0) {
      fetchFieldVector(fieldFrameEnvelope);
    }
  }, [fieldFrameEnvelope, fetchFieldVector]);

  // Watch scalar revision changes
  useEffect(() => {
    if (scalarRevision != null && scalarRevision > 0) {
      fetchScalars(scalarRevision);
    }
  }, [scalarRevision, fetchScalars]);

  // Watch domain generation changes
  useEffect(() => {
    if (fieldFrameEnvelope?.meshGenerationId) {
      fetchDomain(fieldFrameEnvelope.meshGenerationId);
    }
  }, [fieldFrameEnvelope?.meshGenerationId, fetchDomain]);
}
