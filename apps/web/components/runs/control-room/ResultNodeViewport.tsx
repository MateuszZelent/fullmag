"use client";

import { useMemo } from "react";

import ScalarPlot from "@/components/plots/ScalarPlot";
import ScalarTable from "@/components/panels/ScalarTable";
import EmptyState from "@/components/ui/EmptyState";
import { useWorkspaceGraphStore } from "@/features/workspace-graph";
import { findResultNode } from "@/features/analyze/model/resultsWorkspace";
import { useCommand, useTransport } from "./ControlRoomContext";

type ResultNodeViewportMode = "chart" | "table" | "report";

interface ResultNodeViewportProps {
  mode: ResultNodeViewportMode;
}

export default function ResultNodeViewport({ mode }: ResultNodeViewportProps) {
  const cmd = useCommand();
  const tp = useTransport();
  const graphResultsWorkspace = useWorkspaceGraphStore((state) => state.snapshot.resultsWorkspace);
  const graphSelection = useWorkspaceGraphStore((state) => state.snapshot.selection);

  const activeNode = useMemo(() => {
    const id = graphSelection.activeResultNodeId;
    return id ? findResultNode(graphResultsWorkspace, id) ?? null : null;
  }, [graphResultsWorkspace, graphSelection.activeResultNodeId]);

  const visiblePlotQuantities = useMemo(() => {
    if (activeNode?.nodeKind !== "plot_group") {
      return [];
    }
    return activeNode.plots.filter((plot) => plot.visible).map((plot) => plot.quantityId);
  }, [activeNode]);

  if (!activeNode) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          title="No result selected"
          description="Choose a result node from the Results tree to open a hosted viewer."
          tone="info"
          compact
        />
      </div>
    );
  }

  if (mode === "chart") {
    const yColumns =
      activeNode.nodeKind === "plot_group"
        ? (visiblePlotQuantities.length > 0 ? visiblePlotQuantities : activeNode.plots.map((plot) => plot.quantityId))
        : activeNode.nodeKind === "derived_value"
          ? [activeNode.quantityId]
          : [];

    if (yColumns.length === 0 || tp.scalarRows.length < 2) {
      return (
        <div className="flex h-full items-center justify-center">
          <EmptyState
            title="Chart unavailable"
            description="This result node does not expose plottable scalar series yet."
            tone="info"
            compact
          />
        </div>
      );
    }

    return (
      <div className="h-full min-h-0 min-w-0 bg-background">
        <ScalarPlot rows={tp.scalarRows} quantities={cmd.quantities} xColumn="time" yColumns={yColumns} />
      </div>
    );
  }

  if (mode === "table") {
    if (tp.scalarRows.length === 0) {
      return (
        <div className="flex h-full items-center justify-center">
          <EmptyState
            title="No tabular data"
            description="Run a study or stream solver telemetry to populate this table."
            tone="info"
            compact
          />
        </div>
      );
    }

    return (
      <div className="h-full min-h-0 min-w-0 bg-background">
        <ScalarTable rows={tp.scalarRows} quantities={cmd.quantities} />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-auto bg-background px-5 py-4">
      <div className="mb-4 flex items-center gap-2">
        <span className="rounded-sm border border-border/30 bg-muted/40 px-2 py-1 text-[0.62rem] font-bold uppercase tracking-widest text-muted-foreground">
          {activeNode.nodeKind.replaceAll("_", " ")}
        </span>
        <h3 className="text-base font-semibold text-foreground">{activeNode.label}</h3>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <SummaryCard label="Node Id" value={activeNode.id} />
        <SummaryCard label="Created" value={new Date(activeNode.createdAt).toLocaleString()} />
        <SummaryCard label="Pinned" value={activeNode.pinned ? "yes" : "no"} />
        <SummaryCard
          label="Dataset"
          value={
            activeNode.nodeKind === "dataset"
              ? activeNode.id
              : activeNode.nodeKind === "derived_value"
                ? (activeNode.sourceDatasetId ?? "none")
                : activeNode.nodeKind === "plot_group" || activeNode.nodeKind === "table"
                  ? activeNode.sourceDatasetId
                  : "n/a"
          }
        />
      </div>
      <div className="mt-5 rounded-xl border border-border/30 bg-card/40 p-4">
        {activeNode.nodeKind === "report" ? (
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Sections
            </div>
            {activeNode.sections.length > 0 ? activeNode.sections.map((section) => (
              <div key={section.id} className="rounded-lg border border-border/20 bg-background/60 px-3 py-2">
                <div className="text-sm font-medium text-foreground">{section.label}</div>
                <div className="text-xs text-muted-foreground">
                  {section.sourceNodeKind} · {section.sourceNodeId}
                </div>
              </div>
            )) : (
              <p className="text-sm text-muted-foreground">No report sections configured yet.</p>
            )}
          </div>
        ) : activeNode.nodeKind === "export" ? (
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Export Contract
            </div>
            <p className="text-sm text-foreground">
              Format: <span className="font-medium">{activeNode.format.toUpperCase()}</span>
            </p>
            <p className="text-sm text-muted-foreground">
              Quantities: {activeNode.quantityIds.length > 0 ? activeNode.quantityIds.join(", ") : "none selected"}
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            This hosted viewer keeps result lineage visible inside the viewport workspace and is ready for richer
            per-node inspectors and exporters in the next pass.
          </p>
        )}
      </div>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border/25 bg-card/30 p-3">
      <div className="text-[0.62rem] font-semibold uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-medium text-foreground">{value}</div>
    </div>
  );
}
