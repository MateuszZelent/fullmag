"use client";

import { useState } from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import { usePlanarMonitorResource } from "@/kernel/resources/planarMonitorResources";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { VisualizationContextSwitch } from "../visualization/VisualizationContextSwitch";
import { PlanarVisualizationSection } from "../visualization/PlanarVisualizationSection";

export function PlanarMonitorInspectorPanel({
  selection,
}: InspectorPanelProps) {
  const kernel = useKernel();
  const monitorId =
    selection.ref?.type === "planar-monitor"
      ? selection.ref.monitorId
      : "";
  const resource = usePlanarMonitorResource(monitorId, {
    enabled: monitorId.length > 0,
  });
  const monitor = resource.data?.monitor;
  const [nameOverride, setNameOverride] = useState<string | null>(null);
  const [renamePending, setRenamePending] = useState(false);
  const frame = monitor?.frame;
  const nameDraft = nameOverride ?? monitor?.name ?? "";
  const run = (commandId: string, input?: Record<string, unknown>) =>
    kernel.commands.execute(
      commandId,
      createCommandContext("inspector", kernel, {
        sourceDetail: "planar-monitor-inspector",
      }),
      { monitorId, ...input },
    );
  const rename = async () => {
    if (!nameDraft.trim() || nameDraft.trim() === monitor?.name) return;
    setRenamePending(true);
    try {
      await run("planar-monitor.rename", { newName: nameDraft.trim() });
      await resource.refetch();
      setNameOverride(null);
    } finally {
      setRenamePending(false);
    }
  };

  return (
    <div className="fm-inspector-panel">
      <InspectorGroup title="View">
        <VisualizationContextSwitch />
      </InspectorGroup>
      <InspectorGroup title="Identity">
        <FormField
          disabled={!monitor || renamePending}
          label="Name"
          type="text"
          value={nameDraft || monitor?.name || selection.label || ""}
          onChange={(event) => setNameOverride(event.currentTarget.value)}
        />
        <Button
          disabled={
            !monitor ||
            renamePending ||
            !nameDraft.trim() ||
            nameDraft.trim() === monitor.name
          }
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => void rename()}
        >
          Apply name
        </Button>
        <FieldRow label="ID" value={monitorId || "Unknown monitor"} />
        <FieldRow
          label="Scene revision"
          value={resource.data?.scene_revision ?? "—"}
        />
        <FieldRow label="Source" value="SceneDocument / ProblemIR" />
      </InspectorGroup>
      <InspectorGroup title="Frame">
        <FieldRow label="Preset" value={frame?.preset ?? "arbitrary"} />
        <FieldRow label="Origin (m)" value={vectorLabel(frame?.origin_m)} />
        <FieldRow label="Normal" value={vectorLabel(frame?.normal)} />
        <FieldRow label="u axis" value={vectorLabel(frame?.u_axis)} />
        <FieldRow label="Extent" value={frame?.extent.kind ?? "—"} />
      </InspectorGroup>
      <InspectorGroup title="Operator">
        <FieldRow label="Kind" value={monitor?.operator.kind ?? "—"} />
        <FieldRow label="Target" value={monitor?.target.kind ?? "—"} />
      </InspectorGroup>
      <PlanarVisualizationSection selection={selection} />
      <InspectorGroup title="Actions">
        <div className="fm-inspector-toolbar">
          <Button
            disabled={!monitor}
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => void run("field-map.select-monitor")}
          >
            Open in 2D
          </Button>
          <Button
            disabled={!monitor}
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => void run("planar-monitor.show-frame-3d")}
          >
            Show frame in 3D
          </Button>
          <Button
            disabled={!monitor}
            size="sm"
            type="button"
            variant="ghost"
            onClick={() => void run("planar-monitor.duplicate")}
          >
            Duplicate
          </Button>
          <Button
            disabled={!monitor}
            size="sm"
            type="button"
            variant="danger"
            onClick={() => void run("planar-monitor.delete")}
          >
            Delete
          </Button>
        </div>
      </InspectorGroup>
    </div>
  );
}

function vectorLabel(value: number[] | undefined): string {
  return value?.map((entry) => entry.toExponential(3)).join(", ") ?? "—";
}
