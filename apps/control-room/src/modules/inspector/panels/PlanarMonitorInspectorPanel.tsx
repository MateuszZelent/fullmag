"use client";

import { useState } from "react";

import { MODEL_PLANAR_MONITORS_PATH } from "@/kernel/api/apiPaths";
import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import { usePlanarMonitorResource } from "@/kernel/resources/planarMonitorResources";
import {
  isPlanarMonitorRevisionConflict,
  planarMonitorDraftFromMonitor,
  planarMonitorDuplicateRequest,
  planarMonitorValidationErrors,
  type PlanarMonitor,
  type PlanarMonitorDraft,
} from "@/kernel/workspace/crossSectionWorkspace";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FieldRow } from "../primitives/FieldRow";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { VisualizationContextSwitch } from "../visualization/VisualizationContextSwitch";
import { PlanarVisualizationSection } from "../visualization/PlanarVisualizationSection";
import {
  PlanarMonitorDefinitionEditor,
  planarMonitorDefinitionAvailabilityErrors,
} from "./PlanarMonitorDefinitionEditor";
import { usePlanarMonitorDefinitionAvailability } from "./usePlanarMonitorDefinitionAvailability";

export function PlanarMonitorInspectorPanel({ selection }: InspectorPanelProps) {
  const kernel = useKernel();
  const definitionAvailability = usePlanarMonitorDefinitionAvailability();
  const monitorId = selection.ref?.type === "planar-monitor" ? selection.ref.monitorId : "";
  const resource = usePlanarMonitorResource(monitorId, { enabled: monitorId.length > 0 });
  const monitor = resource.data?.monitor;
  const sceneRevision = resource.data?.scene_revision;

  if (!monitor || sceneRevision === undefined) {
    return (
      <div className="fm-inspector-panel">
        <InspectorGroup title="Planar Monitor">
          <FieldRow label="Status" value={resource.status === "error" ? "Unavailable" : "Loading"} />
        </InspectorGroup>
      </div>
    );
  }

  return (
    <CommittedPlanarMonitorEditor
      key={`${monitor.id}:${sceneRevision}`}
      monitor={monitor}
      sceneRevision={sceneRevision}
      selection={selection}
      refetch={resource.refetch}
      definitionAvailability={definitionAvailability}
    />
  );
}

function CommittedPlanarMonitorEditor({
  monitor,
  sceneRevision,
  selection,
  refetch,
  definitionAvailability,
}: {
  monitor: PlanarMonitor;
  sceneRevision: number;
  selection: InspectorPanelProps["selection"];
  refetch: () => void;
  definitionAvailability: ReturnType<typeof usePlanarMonitorDefinitionAvailability>;
}) {
  const kernel = useKernel();
  const [draft, setDraft] = useState<PlanarMonitorDraft>(() => planarMonitorDraftFromMonitor(monitor));
  const [feedback, setFeedback] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [pending, setPending] = useState(false);
  const errors = [
    ...planarMonitorValidationErrors(draft.monitor),
    ...(draft.monitor.id === monitor.id ? [] : ["Committed monitor ID must match the resource path ID."]),
    ...planarMonitorDefinitionAvailabilityErrors(draft.monitor, definitionAvailability),
  ];
  const dirty = JSON.stringify(draft.monitor) !== JSON.stringify(monitor);
  const run = (commandId: string, input?: Record<string, unknown>) =>
    kernel.commands.execute(
      commandId,
      createCommandContext("inspector", kernel, { sourceDetail: "planar-monitor-inspector" }),
      { monitorId: monitor.id, ...input },
    );

  const apply = async () => {
    if (!dirty || errors.length > 0) return;
    setPending(true);
    setFeedback(null);
    setConflict(false);
    try {
      const response = await kernel.api.model.planarMonitors.patch(monitor.id, {
        expected_scene_revision: sceneRevision,
        monitor: structuredClone(draft.monitor),
      });
      setDraft(planarMonitorDraftFromMonitor(response.monitor, draft.ui.displayLengthUnit));
      kernel.resources.invalidate(MODEL_PLANAR_MONITORS_PATH, response.scene_revision);
      refetch();
    } catch (error) {
      const revisionConflict = isPlanarMonitorRevisionConflict(error);
      setConflict(revisionConflict);
      setFeedback(
        revisionConflict
          ? "The scene changed while this monitor was being edited. Reload the current revision before applying again."
          : error instanceof Error
            ? error.message
            : "Planar monitor update failed.",
      );
    } finally {
      setPending(false);
    }
  };

  const duplicate = async () => {
    setPending(true);
    setFeedback(null);
    try {
      const response = await kernel.api.model.planarMonitors.duplicate(
        monitor.id,
        planarMonitorDuplicateRequest(monitor, sceneRevision),
      );
      kernel.resources.invalidate(MODEL_PLANAR_MONITORS_PATH, response.scene_revision);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Planar monitor duplication failed.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="fm-inspector-panel">
      <InspectorGroup title="View">
        <VisualizationContextSwitch />
      </InspectorGroup>
      <PlanarMonitorDefinitionEditor availability={definitionAvailability} draft={draft} mode="committed" onChange={setDraft} />
      <InspectorGroup title="Provenance">
        <FieldRow label="Scene revision" value={sceneRevision} />
        <FieldRow label="Source" value="SceneDocument / ProblemIR" />
      </InspectorGroup>
      <div className="fm-inspector-toolbar">
        <Button
          disabled={pending || !dirty}
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => {
            setDraft(planarMonitorDraftFromMonitor(monitor, draft.ui.displayLengthUnit));
            setFeedback(null);
            setConflict(false);
          }}
        >
          Discard
        </Button>
        <Button
          disabled={pending || !dirty || errors.length > 0}
          size="sm"
          type="button"
          variant="primary"
          onClick={() => void apply()}
        >
          Apply
        </Button>
      </div>
      {errors.length > 0 ? (
        <div className="fm-help-text" role="alert">
          {errors.map((error) => <p key={error}>{error}</p>)}
        </div>
      ) : null}
      {feedback ? <p role="alert">{feedback}</p> : null}
      {conflict ? (
        <Button size="sm" type="button" variant="secondary" onClick={refetch}>
          Reload current monitor
        </Button>
      ) : null}
      <PlanarVisualizationSection selection={selection} />
      <InspectorGroup title="Actions">
        <div className="fm-inspector-toolbar">
          <Button size="sm" type="button" variant="secondary" onClick={() => void run("field-map.select-monitor")}>
            Open in 2D
          </Button>
          <Button size="sm" type="button" variant="ghost" onClick={() => void run("planar-monitor.show-frame-3d")}>
            Show frame in 3D
          </Button>
          <Button disabled={pending} size="sm" type="button" variant="ghost" onClick={() => void duplicate()}>
            Duplicate
          </Button>
          <Button disabled={pending} size="sm" type="button" variant="danger" onClick={() => void run("planar-monitor.delete")}>
            Delete
          </Button>
        </div>
      </InspectorGroup>
    </div>
  );
}
