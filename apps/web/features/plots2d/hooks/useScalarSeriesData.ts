/**
 * @module features/plots2d/hooks/useScalarSeriesData
 *
 * Data pipeline hook connecting the transport layer to usePlot2DStore.
 *
 * This replaces the old `useScalarChartHistory` (338 LOC) and
 * `useChartPersistence` (217 LOC) with a thin bridge (~80 LOC).
 *
 * Pipeline:
 * 1. Subscribes to `ControlRoomContext.transport.scalarRows` → store.appendScalarDelta()
 * 2. When totalRows > liveRows, fetches full history via fetchScalarWindow()
 * 3. Builds ScalarSeriesMeta from QuantityDescriptors → store.hydrateScalarMeta()
 * 4. Handles session changes via store.resetForSession()
 */

import { useEffect, useRef } from "react";
import { usePlot2DStore } from "../store/usePlot2DStore";
import { scalarTableFromRows } from "../model/scalarTable";
import { buildScalarSeriesMeta, buildSeriesMetaMap } from "../model/scalarSeriesMeta";
import type { ScalarRow, QuantityDescriptor } from "@/lib/session/types";

const MAX_SCALAR_HISTORY_ROWS = 10_000;

interface UseScalarSeriesDataParams {
  /** Live scalar rows from transport (ControlRoomContext). */
  scalarRows: ScalarRow[];
  /** Total rows known at the backend. */
  scalarRowsTotal: number;
  /** Backend quantities for dynamic metadata. */
  quantities: QuantityDescriptor[];
  /** Current session ID (triggers reset on change). */
  sessionId: string | null;
  /** Fetch history function from the API layer. */
  fetchHistory?: () => Promise<ScalarRow[]>;
  maxHistoryRows?: number;
}

/**
 * Connect live scalar data to the Plot2D store.
 *
 * This hook is used inside the ChartsTabPanel or Plot2DWorkbench
 * to bridge the existing ControlRoomContext transport with the
 * new Zustand store.
 */
export function useScalarSeriesData({
  scalarRows,
  scalarRowsTotal,
  quantities,
  sessionId,
  fetchHistory,
  maxHistoryRows = MAX_SCALAR_HISTORY_ROWS,
}: UseScalarSeriesDataParams): void {
  const prevSessionRef = useRef<string | null>(null);
  const prevRowCountRef = useRef(0);
  const fetchingRef = useRef(false);

  // ── Session change → reset ──
  useEffect(() => {
    if (sessionId !== prevSessionRef.current) {
      prevSessionRef.current = sessionId;
      prevRowCountRef.current = 0;
      fetchingRef.current = false;
      usePlot2DStore.getState().resetForSession(sessionId);
    }
  }, [sessionId]);

  // ── Hydrate metadata from quantities ──
  useEffect(() => {
    const meta = buildScalarSeriesMeta(quantities);
    usePlot2DStore.getState().hydrateScalarMeta(meta);
  }, [quantities]);

  // ── Live rows → store ──
  useEffect(() => {
    if (scalarRows.length === 0) return;
    if (scalarRows.length === prevRowCountRef.current) return;

    prevRowCountRef.current = scalarRows.length;

    // Build metadata map from current available series
    const currentMeta = usePlot2DStore.getState().scalar.availableSeries;
    const metaMap = buildSeriesMetaMap(currentMeta);

    // Convert rows to columnar table
    const table = scalarTableFromRows(
      scalarRows as unknown as Record<string, unknown>[],
      metaMap,
    );
    table.totalRows = scalarRowsTotal;

    usePlot2DStore.getState().hydrateScalarTable(table, "live-window");
  }, [scalarRows, scalarRowsTotal]);

  // ── Full history fetch when live window is incomplete ──
  useEffect(() => {
    if (!fetchHistory) return;
    if (fetchingRef.current) return;

    const currentTable = usePlot2DStore.getState().scalar.table;
    const currentCount = currentTable?.rowCount ?? 0;

    // Fetch history if we know there's more data than what the local store has.
    // This must also run from an empty store: on page load the transport may not
    // have live rows yet while the backend scalar-history endpoint already does.
    const hasBoundedHistory = currentCount >= Math.min(scalarRowsTotal, maxHistoryRows);
    if (scalarRowsTotal > maxHistoryRows && hasBoundedHistory) {
      return;
    }

    if (scalarRowsTotal > currentCount && scalarRowsTotal > 0) {
      fetchingRef.current = true;
      usePlot2DStore.getState().setScalarLoading(true);

      fetchHistory()
        .then((rows) => {
          const currentMeta = usePlot2DStore.getState().scalar.availableSeries;
          const metaMap = buildSeriesMetaMap(currentMeta);
          const table = scalarTableFromRows(
            rows as unknown as Record<string, unknown>[],
            metaMap,
          );
          table.totalRows = scalarRowsTotal;
          usePlot2DStore.getState().hydrateScalarTable(table, "full-history");
        })
        .catch((err) => {
          usePlot2DStore.getState().setScalarError(
            err instanceof Error ? err.message : "Failed to fetch scalar history",
          );
        })
        .finally(() => {
          fetchingRef.current = false;
        });
    }
  }, [fetchHistory, maxHistoryRows, scalarRowsTotal]);
}
