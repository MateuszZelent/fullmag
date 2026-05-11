"use client";

import { RotateCcw } from "lucide-react";

import {
  displayLabelForVisualizationTarget,
  renderModePatch,
  resolveVisualizationTargetFromSelection,
  type VisualizationRenderMode,
  type VisualizationTargetPatch,
} from "@/kernel/visualization/ObjectVisualizationController";
import { useObjectVisualizationRegistry } from "@/kernel/visualization/useObjectVisualization";
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
  const { snapshot, visualization } = useObjectVisualizationRegistry();
  const settings = target ? visualization.getSettings(target) : null;
  const revision = snapshot.version;

  function patch(patchValue: VisualizationTargetPatch): void {
    if (!target) return;
    visualization.patchTarget(target, patchValue);
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
            label="Visible"
            onClick={() => patch({ visible: !settings.visible })}
          />
          <ToggleButton
            active={settings.shaderVisible}
            label="Shader"
            onClick={() => patch({ shaderVisible: !settings.shaderVisible })}
          />
          <ToggleButton
            active={settings.wireframeVisible}
            label="Wireframe"
            onClick={() => patch({ wireframeVisible: !settings.wireframeVisible })}
          />
          <ToggleButton
            active={settings.pointsVisible}
            label="Points"
            onClick={() => patch({ pointsVisible: !settings.pointsVisible })}
          />
          <ToggleButton
            active={settings.vectorsVisible}
            label="Vectors"
            onClick={() => patch({ vectorsVisible: !settings.vectorsVisible })}
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
              variant={settings.renderMode === mode.value ? "primary" : "secondary"}
              onClick={() => patch(renderModePatch(mode.value))}
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
            onChange={(event) => patch({ opacityPercent: Number(event.target.value) })}
          />
        </label>
      </InspectorSection>

      <InspectorSection title="Overrides">
        <Button
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => visualization.clearTarget(target)}
        >
          <RotateCcw size={14} />
          Reset target display
        </Button>
      </InspectorSection>
    </div>
  );
}

function ToggleButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      className="fm-visualization-toggle"
      data-active={active}
      size="sm"
      type="button"
      variant={active ? "primary" : "secondary"}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}
