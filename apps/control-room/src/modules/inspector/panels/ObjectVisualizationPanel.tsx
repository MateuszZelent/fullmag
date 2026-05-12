"use client";

import { RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";

import { useKernel } from "@/kernel/KernelContext";
import {
  airboxVisualizationStatePatchFromTargetPatch,
  DEFAULT_AIRBOX_VISUALIZATION,
  displayLabelForVisualizationTarget,
  renderModePatch,
  resolveAirboxVisualizationSettingsFromState,
  resolveVisualizationSettings,
  resolveVisualizationTargetFromSelection,
  type VisualizationRenderMode,
  type VisualizationTargetPatch,
} from "@/kernel/visualization/ObjectVisualizationController";
import { useObjectVisualizationRegistry } from "@/kernel/visualization/useObjectVisualization";
import {
  VISUALIZATION_STATE_RESOURCE_KEY,
  useVisualizationStateResource,
} from "@/kernel/visualization/useVisualizationStateResource";
import { Button } from "@/shared/ui/Button";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FieldRow } from "../primitives/FieldRow";
import { InspectorSection } from "../primitives/InspectorSection";

const RENDER_MODES: Array<{
  label: string;
  value: VisualizationRenderMode;
}> = [
  { label: "Shader", value: "surface" },
  { label: "Shader + wire", value: "surface+edges" },
  { label: "Wire", value: "wireframe" },
  { label: "Points", value: "points" },
];

export function ObjectVisualizationPanel({ selection }: InspectorPanelProps) {
  const target = resolveVisualizationTargetFromSelection(selection);
  const { api, resources } = useKernel();
  const { snapshot, visualization } = useObjectVisualizationRegistry();
  const visualizationState = useVisualizationStateResource();
  const [feedback, setFeedback] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const airboxBaseSettings = useMemo(
    () => resolveAirboxVisualizationSettingsFromState(visualizationState.data),
    [visualizationState.data],
  );
  const settings = target
    ? target.kind === "airbox"
      ? resolveVisualizationSettings(snapshot, target, airboxBaseSettings)
      : visualization.getSettings(target)
    : null;
  const revision =
    target?.kind === "airbox"
      ? visualizationState.revision ?? visualizationState.status
      : snapshot.version;

  async function patch(patchValue: VisualizationTargetPatch): Promise<void> {
    if (!target) return;
    if (target.kind === "airbox") {
      setPending(true);
      try {
        const next = await api.visualization.patch(
          airboxVisualizationStatePatchFromTargetPatch(patchValue),
        );
        resources.invalidate(VISUALIZATION_STATE_RESOURCE_KEY, next.revision);
        visualization.patchTarget(target, patchValue);
        setFeedback(null);
      } catch (error) {
        setFeedback(error instanceof Error ? error.message : String(error));
      } finally {
        setPending(false);
      }
      return;
    }

    visualization.patchTarget(target, patchValue);
  }

  async function resetTarget(): Promise<void> {
    if (!target) return;
    if (target.kind === "airbox") {
      setPending(true);
      try {
        const next = await api.visualization.patch(
          airboxVisualizationStatePatchFromTargetPatch(
            DEFAULT_AIRBOX_VISUALIZATION,
          ),
        );
        resources.invalidate(VISUALIZATION_STATE_RESOURCE_KEY, next.revision);
        visualization.clearTarget(target);
        setFeedback(null);
      } catch (error) {
        setFeedback(error instanceof Error ? error.message : String(error));
      } finally {
        setPending(false);
      }
      return;
    }

    visualization.clearTarget(target);
  }

  if (!target || !settings) {
    return (
      <div className="fm-inspector-panel">
        <InspectorSection title="Visualization">
          <FieldRow label="Target" value="No visualization target" />
        </InspectorSection>
      </div>
    );
  }

  const opacityLabel = `${settings.opacityPercent}%`;

  return (
    <div className="fm-inspector-panel" data-visualization-revision={revision}>
      <InspectorSection title="Visualization Target">
        <FieldRow label="Name" value={displayLabelForVisualizationTarget(target)} />
        <FieldRow label="Target ID" value={target.kind === "airbox" ? "airbox" : target.id} />
        <FieldRow label="Kind" value={target.kind} />
      </InspectorSection>

      <InspectorSection title="Display Passes">
        <div className="fm-visualization-toggle-grid">
          <ToggleButton
            active={settings.visible}
            disabled={pending}
            label="Visible"
            onClick={() => void patch({ visible: !settings.visible })}
          />
          <ToggleButton
            active={settings.shaderVisible}
            disabled={pending}
            label="Shader"
            onClick={() => void patch({ shaderVisible: !settings.shaderVisible })}
          />
          <ToggleButton
            active={settings.wireframeVisible}
            disabled={pending}
            label="Wireframe"
            onClick={() =>
              void patch({ wireframeVisible: !settings.wireframeVisible })
            }
          />
          <ToggleButton
            active={settings.pointsVisible}
            disabled={pending}
            label="Points"
            onClick={() => void patch({ pointsVisible: !settings.pointsVisible })}
          />
          <ToggleButton
            active={settings.vectorsVisible}
            disabled={pending}
            label="Vectors"
            onClick={() => void patch({ vectorsVisible: !settings.vectorsVisible })}
          />
        </div>
      </InspectorSection>

      <InspectorSection title="Render Mode">
        <div className="fm-visualization-segments" role="group" aria-label="Render mode">
          {RENDER_MODES.map((mode) => (
            <Button
              key={mode.value}
              size="sm"
              type="button"
              disabled={pending}
              variant={settings.renderMode === mode.value ? "primary" : "secondary"}
              onClick={() => void patch(renderModePatch(mode.value))}
            >
              {mode.label}
            </Button>
          ))}
        </div>
      </InspectorSection>

      <InspectorSection title="Opacity">
        <label className="fm-visualization-range">
          <span>{opacityLabel}</span>
          <input
            aria-label="Opacity"
            max={100}
            min={0}
            step={1}
            type="range"
            value={settings.opacityPercent}
            onChange={(event) =>
              void patch({ opacityPercent: Number(event.target.value) })
            }
          />
        </label>
      </InspectorSection>

      <InspectorSection title="Overrides">
        <Button
          size="sm"
          type="button"
          disabled={pending}
          variant="ghost"
          onClick={() => void resetTarget()}
        >
          <RotateCcw size={14} />
          Reset target display
        </Button>
      </InspectorSection>

      {feedback ? (
        <InspectorSection title="Diagnostics">
          <p className="fm-inspector-validation-message" data-kind="error">
            {feedback}
          </p>
        </InspectorSection>
      ) : null}
    </div>
  );
}

function ToggleButton({
  active,
  disabled = false,
  label,
  onClick,
}: {
  active: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      className="fm-visualization-toggle"
      data-active={active}
      disabled={disabled}
      size="sm"
      type="button"
      variant={active ? "primary" : "secondary"}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}
