import { Activity, Database, Gauge, History } from "lucide-react";

import { useFieldMetaResource } from "@/kernel/resources/studyRuntimeResources";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FieldRow } from "../primitives/FieldRow";
import { InspectorOverviewFrame } from "../primitives/InspectorOverviewFrame";

function quantityId(selection: InspectorPanelProps["selection"]): string {
  const prefix = "results:field:";
  return selection.nodeId?.startsWith(prefix)
    ? selection.nodeId.slice(prefix.length)
    : "m";
}

function finite(value: number | null | undefined, unit = ""): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${value.toPrecision(6)}${unit ? ` ${unit}` : ""}`
    : "not available";
}

export function FieldQuantityInspectorPanel({ selection }: InspectorPanelProps) {
  const requestedQuantityId = quantityId(selection);
  const resource = useFieldMetaResource({ quantityId: requestedQuantityId });
  const meta = resource.data;
  const state = meta?.state ?? resource.status;

  return (
    <div className="fm-inspector-panel">
      <InspectorOverviewFrame
        className="fm-field-quantity-inspector"
        metrics={[
          { label: "Components", value: meta ? String(meta.components) : "—" },
          { label: "Location", value: meta?.location ?? "—" },
          { label: "State", value: state, tone: state === "complete" || state === "ready" ? "success" : "neutral" },
          { label: "Stale steps", value: meta ? String(meta.stale_by_steps) : "—", tone: meta?.stale_by_steps ? "stale" : "neutral" },
        ]}
        primary={
          <>
            <FieldRow label="Quantity" value={meta?.label ?? selection.label ?? requestedQuantityId} />
            <FieldRow label="Quantity ID" value={meta?.quantity_id ?? requestedQuantityId} />
            <FieldRow label="Unit" value={meta?.unit ?? "not available"} />
            <FieldRow label="Field kind" value={meta?.kind ?? "not available"} />
          </>
        }
        primaryIcon={<Activity size={18} strokeWidth={1.5} />}
        primaryTitle="Field quantity"
        sections={[
          {
            id: "statistics",
            title: "Statistics",
            icon: <Gauge size={16} strokeWidth={1.5} />,
            content: (
              <>
                <FieldRow label="Minimum" value={finite(meta?.stats?.min, meta?.unit)} />
                <FieldRow label="Mean" value={finite(meta?.stats?.mean, meta?.unit)} />
                <FieldRow label="Maximum" value={finite(meta?.stats?.max, meta?.unit)} />
              </>
            ),
          },
          {
            id: "materialization",
            title: "Materialization",
            icon: <Database size={16} strokeWidth={1.5} />,
            content: (
              <>
                <FieldRow label="Resource state" value={resource.status} />
                <FieldRow label="Materialization state" value={state} />
                <FieldRow label="Error" value={meta?.materialization_error ?? "none"} />
                <FieldRow label="Wall time" value={finite(meta?.materialization_wall_time_ns, "ns")} />
              </>
            ),
          },
          {
            id: "provenance",
            title: "Provenance",
            icon: <History size={16} strokeWidth={1.5} />,
            content: (
              <>
                <FieldRow label="Field revision" value={meta ? String(meta.field_revision) : "not available"} />
                <FieldRow label="Source revision" value={meta ? String(meta.source_revision) : "not available"} />
                <FieldRow label="Source step" value={meta ? String(meta.source_step) : "not available"} />
                <FieldRow label="Domain generation" value={meta?.domain_generation_id ?? "not available"} />
              </>
            ),
          },
        ]}
      />
    </div>
  );
}
