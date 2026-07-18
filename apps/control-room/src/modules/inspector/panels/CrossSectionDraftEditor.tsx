"use client";

import { useState } from "react";

import { useKernel } from "@/kernel/KernelContext";
import { MODEL_PLANAR_MONITORS_PATH } from "@/kernel/api/apiPaths";
import { usePlanarMonitorsResource } from "@/kernel/resources/planarMonitorResources";
import {
  discardCrossSectionDraft,
  isPlanarMonitorRevisionConflict,
  planarMonitorCreateRequestFromDraft,
  updateCrossSectionDraft,
  type CrossSectionDraft,
} from "@/kernel/workspace/crossSectionWorkspace";
import { Button } from "@/shared/ui/Button";
import { fieldMapStore } from "@/modules/field-map/public";

import { MeshResourceEmpty } from "./MeshResourceView";
import { CrossSectionSettingsEditor } from "./CrossSectionSettingsEditor";

function updateDraft(patch: Partial<CrossSectionDraft>): void {
  updateCrossSectionDraft(patch);
}

export function CrossSectionDraftEditor({
  draft,
}: {
  draft: CrossSectionDraft | null;
}) {
  const kernel = useKernel();
  const monitors = usePlanarMonitorsResource();
  const [feedback, setFeedback] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [pending, setPending] = useState(false);

  if (!draft) {
    return <MeshResourceEmpty label="No editable cross-section draft." />;
  }

  const commitDraft = async () => {
    setPending(true);
    setFeedback(null);
    setConflict(false);
    try {
      const domain = await kernel.api.data.domain.meta();
      const request = planarMonitorCreateRequestFromDraft(
        draft,
        monitors.data?.scene_revision ?? 0,
        {
          max: domain.bounds.max as [number, number, number],
          min: domain.bounds.min as [number, number, number],
        },
      );
      const created = await kernel.api.model.planarMonitors.create(request);
      const monitor = created.monitor;
      discardCrossSectionDraft();
      fieldMapStore.set({ activeMonitorId: monitor.id });
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
      <CrossSectionSettingsEditor
        value={draft}
        onChange={updateDraft}
        action={
          <div className="fm-inspector-toolbar">
            <Button
              disabled={pending}
              size="sm"
              type="button"
              variant="ghost"
              onClick={discardCrossSectionDraft}
            >
              Discard
            </Button>
            <Button
              disabled={pending || !monitors.data}
              size="sm"
              type="button"
              variant="primary"
              onClick={() => void commitDraft()}
            >
              Apply monitor
            </Button>
          </div>
        }
      />
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
