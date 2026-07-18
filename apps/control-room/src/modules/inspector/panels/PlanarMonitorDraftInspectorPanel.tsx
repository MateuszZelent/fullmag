"use client";

import { useState } from "react";

import type { CrossSectionPlane } from "@/kernel/api/apiTypes";
import { MODEL_PLANAR_MONITORS_PATH } from "@/kernel/api/apiPaths";
import { useKernel } from "@/kernel/KernelContext";
import { usePlanarMonitorsResource } from "@/kernel/resources/planarMonitorResources";
import {
  discardPlanarMonitorDraft,
  isPlanarMonitorRevisionConflict,
  planarMonitorCreateRequestFromDraft,
  updatePlanarMonitorDraft,
} from "@/kernel/workspace/crossSectionWorkspace";
import { useCrossSectionWorkspaceSelector } from "@/kernel/workspace/useCrossSectionWorkspace";
import { fieldMapStore } from "@/modules/field-map/public";
import { Button } from "@/shared/ui/Button";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/Tabs";

import { FormField } from "../primitives/FormField";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { MeshResourceEmpty } from "./MeshResourceView";

export function PlanarMonitorDraftInspectorPanel() {
  const kernel = useKernel();
  const monitors = usePlanarMonitorsResource();
  const draft = useCrossSectionWorkspaceSelector(
    (state) => state.planarMonitorDraft,
  );
  const [feedback, setFeedback] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [pending, setPending] = useState(false);

  if (!draft) {
    return <MeshResourceEmpty label="No editable planar monitor draft." />;
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
      discardPlanarMonitorDraft();
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
      <InspectorGroup title="Monitor Frame">
        <FormField
          label="Name"
          mono={false}
          type="text"
          value={draft.name}
          onChange={(event) =>
            updatePlanarMonitorDraft({ name: event.target.value })
          }
        />
        <FormField
          label="Frame"
          type="select"
          value={draft.frameExtent}
          onChange={(event) =>
            updatePlanarMonitorDraft({
              frameExtent: event.target
                .value as typeof draft.frameExtent,
            })
          }
        >
          <option value="universe">Universe</option>
          <option value="magnetic_domain">Magnetic domain</option>
          <option disabled value="object_bounds">
            Object bounds
          </option>
          <option disabled value="custom">
            Custom
          </option>
        </FormField>
        <div className="fm-inspector-form-field fm-inspector-form-field--inline">
          <span className="fm-inspector-form-field__label">Plane</span>
          <Tabs
            className="fm-inspector-axis-tabs"
            value={draft.plane}
            onValueChange={(plane) =>
              updatePlanarMonitorDraft({
                plane: plane as CrossSectionPlane,
              })
            }
          >
            <TabsList aria-label="Monitor plane axis">
              {(["xy", "xz", "yz"] as const).map((plane) => (
                <TabsTrigger
                  key={plane}
                  className="fm-inspector-axis-tab"
                  value={plane}
                >
                  {plane.toUpperCase()}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
        <FormField
          label="Position"
          max={100}
          min={0}
          step={0.5}
          type="number"
          unit="%"
          value={draft.positionPercent}
          onChange={(event) =>
            updatePlanarMonitorDraft({
              positionPercent: Number(event.target.value),
            })
          }
        />
        <FormField
          label="Rotation"
          max={180}
          min={-180}
          step={1}
          type="number"
          unit="deg"
          value={draft.rotationDegrees}
          onChange={(event) =>
            updatePlanarMonitorDraft({
              rotationDegrees: Number(event.target.value),
            })
          }
        />
      </InspectorGroup>
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
          disabled={pending || !monitors.data}
          size="sm"
          type="button"
          variant="primary"
          onClick={() => void commitDraft()}
        >
          Apply monitor
        </Button>
      </div>
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
