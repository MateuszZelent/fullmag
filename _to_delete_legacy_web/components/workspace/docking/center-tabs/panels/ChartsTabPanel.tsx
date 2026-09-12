"use client";

import dynamic from "next/dynamic";
import { useCallback, useMemo } from "react";

import { useCommand, useTransport } from "@/components/runs/control-room/context-hooks";
import {
  selectResourceRevisions,
  useSessionRuntimeStore,
} from "@/features/session-runtime/store/useSessionRuntimeStore";
import { useScalarSeriesData } from "@/features/plots2d/hooks/useScalarSeriesData";
import { getLiveSessionClient } from "@/src/api/client/LiveSessionClient";
import { scalarWindowToRows } from "@/src/api/client/modules/ScalarHistoryAdapter";
import type { ScalarRow } from "@/lib/session/types";

const MAX_SCALAR_HISTORY_ROWS = 10_000;

const Plot2DWorkbench = dynamic(
  () => import("@/features/plots2d/components/Plot2DWorkbench"),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground/50">
        Loading 2D Plots…
      </div>
    ),
  },
);

function ConnectedPlot2DWorkbench() {
  const transport = useTransport();
  const command = useCommand();
  const resourceRevisions = useSessionRuntimeStore(selectResourceRevisions);

  const sessionId = useMemo(() => {
    const sessionKey = command.session?.session_id ?? "current";
    const runKey = command.run?.run_id ?? "local-live";
    return `${sessionKey}:${runKey}`;
  }, [command.run?.run_id, command.session?.session_id]);

  const scalarRowsTotal = Math.max(
    transport.scalarRowsTotal,
    transport.scalarRows.length,
    resourceRevisions?.scalars_revision ?? 0,
  );

  const fetchHistory = useCallback(async (): Promise<ScalarRow[]> => {
    const window = await getLiveSessionClient().scalars.getWindow({
      limit: MAX_SCALAR_HISTORY_ROWS,
      maxPoints: MAX_SCALAR_HISTORY_ROWS,
      decimate: "stride",
    });
    return scalarWindowToRows(window) as unknown as ScalarRow[];
  }, []);

  useScalarSeriesData({
    scalarRows: transport.scalarRows,
    scalarRowsTotal,
    quantities: command.quantities,
    sessionId,
    fetchHistory,
    maxHistoryRows: MAX_SCALAR_HISTORY_ROWS,
  });

  return <Plot2DWorkbench />;
}

export function ChartsTabPanel({ disabled }: { disabled: boolean }) {
  if (disabled) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground/50">
        2D Plots disabled via feature flags
      </div>
    );
  }
  return <ConnectedPlot2DWorkbench />;
}
