"use client";

import { useState } from "react";

import { MODEL_PLANAR_MONITORS_PATH } from "@/kernel/api/apiPaths";
import { useKernel } from "@/kernel/KernelContext";
import { usePlanarMonitorsResource } from "@/kernel/resources/planarMonitorResources";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
import {
  discardPlanarMonitorDraft,
  isPlanarMonitorRevisionConflict,
  planarMonitorCreateRequestFromDraft,
  planarMonitorIdentityForCreate,
  planarMonitorValidationErrors,
  updatePlanarMonitorDraft,
} from "@/kernel/workspace/crossSectionWorkspace";
import { useCrossSectionWorkspaceSelector } from "@/kernel/workspace/useCrossSectionWorkspace";
import { Button } from "@/shared/ui/Button";

import { MeshResourceEmpty } from "./MeshResourceView";
import {
  PlanarMonitorDefinitionEditor,
  planarMonitorDefinitionAvailabilityErrors,
} from "./PlanarMonitorDefinitionEditor";
import { usePlanarMonitorDefinitionAvailability } from "./usePlanarMonitorDefinitionAvailability";

export function PlanarMonitorDraftInspectorPanel() {
  const kernel = useKernel();
  const definitionAvailability = usePlanarMonitorDefinitionAvailability();
  const monitors = usePlanarMonitorsResource();
  const visualizationState = useVisualizationStateResource();
  const draft = useCrossSectionWorkspaceSelector(
    (state) => state.planarMonitorDraft,
  );
  const [feedback, setFeedback] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [pending, setPending] = useState(false);

  if (!draft) {
    return <MeshResourceEmpty label="No editable planar monitor draft." />;
  }
  const validationErrors = [
    ...planarMonitorValidationErrors(draft.monitor),
    ...planarMonitorDefinitionAvailabilityErrors(draft.monitor, definitionAvailability),
  ];

  const commitDraft = async () => {
    if (!visualizationState.data?.planar) {
      setFeedback("Planar visualization state is unavailable.");
      return;
    }
    setPending(true);
    setFeedback(null);
    setConflict(false);
    try {
      const existing = monitors.data?.monitors ?? [];
      const hasIdentityCollision = existing.some(
        (monitor) => monitor.id === draft.monitor.id || monitor.name === draft.monitor.name,
      );
      const identity = hasIdentityCollision
        ? planarMonitorIdentityForCreate(draft.monitor.name, existing)
        : { id: draft.monitor.id, name: draft.monitor.name };
      const request = planarMonitorCreateRequestFromDraft(
        { ...draft, monitor: { ...draft.monitor, ...identity } },
        monitors.data?.scene_revision ?? 0,
      );
      const created = await kernel.api.model.planarMonitors.create(request);
      const monitor = created.monitor;
      discardPlanarMonitorDraft();
      kernel.visualizationSync.queuePatch({
        planar: { source: { kind: "monitor", monitor_id: monitor.id } },
      });
      kernel.resources.invalidate(
        MODEL_PLANAR_MONITORS_PATH,
        created.scene_revision,
      );
      const nodeId = `model:definitions:planar-monitors:${monitor.id}`;
      kernel.selection.set(
        {
          kind: "model.planar.monitor",
          label: monitor.name,
          nodeId,
          objectId: null,
          ref: {
            kind: "model.planar.monitor",
            monitorId: monitor.id,
            nodeId,
            type: "planar-monitor",
            visualizationTargetId: `planar-monitor:${monitor.id}`,
          },
        },
        "inspector",
      );
      kernel.layout.setActiveViewportMainModule("field-map");
      kernel.layout.setFocusedSlot("viewport-main");
      kernel.layout.setPanelVisible("right", true);
    } catch (error) {
      const revisionConflict = isPlanarMonitorRevisionConflict(error);
      setConflict(revisionConflict);
      setFeedback(
        revisionConflict
          ? "The scene changed while this monitor draft was open. Reload the current revision before applying again."
          : error instanceof Error
            ? error.message
            : "Planar monitor commit failed. Reload the scene and retry.",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="fm-cross-section-inspector">
      <PlanarMonitorDefinitionEditor
        availability={definitionAvailability}
        draft={draft}
        mode="create"
        onChange={(next) => updatePlanarMonitorDraft(next)}
      />
      <div className="fm-inspector-toolbar">
        <Button
          disabled={pending}
          size="sm"
          type="button"
          variant="ghost"
          onClick={discardPlanarMonitorDraft}
        >
          Discard
        </Button>
        <Button
          disabled={pending || !monitors.data || !visualizationState.data?.planar || validationErrors.length > 0}
          size="sm"
          type="button"
          variant="primary"
          onClick={() => void commitDraft()}
        >
          Apply monitor
        </Button>
      </div>
      {validationErrors.length > 0 ? (
        <div className="fm-help-text" role="alert">
          {validationErrors.map((error) => <p key={error}>{error}</p>)}
        </div>
      ) : null}
      {feedback ? <p role="alert">{feedback}</p> : null}
      {conflict ? (
        <Button
          size="sm"
          type="button"
          variant="secondary"
          onClick={monitors.refetch}
        >
          Reload current monitors
        </Button>
      ) : null}
    </div>
  );
}
