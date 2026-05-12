"use client";

import { RotateCcw } from "lucide-react";
import React, { useMemo, useState } from "react";

import { useKernel } from "@/kernel/KernelContext";
import {
  airboxLocalVisualizationPatchFromTargetPatch,
  airboxVisualizationStatePatchFromTargetPatch,
  DEFAULT_AIRBOX_VISUALIZATION,
  displayLabelForVisualizationTarget,
  hasVisualizationStatePatch,
  renderModePatch,
  resolveAirboxVisualizationSettingsFromState,
  resolveEffectiveVisualizationSettings,
  resolveVisualizationSettings,
  resolveVisualizationTargetFromSelection,
  type VisualizationGeometryScope,
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
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { InspectorSection } from "../primitives/InspectorSection";
import {
  buildVisualizationPanelSections,
  VISUALIZATION_COLOR_MODE_ITEMS,
} from "./ObjectVisualizationPanelModel";

const RENDER_MODES: Array<{
  label: string;
  value: VisualizationRenderMode;
}> = [
  { label: "Shader", value: "surface" },
  { label: "Shader + wire", value: "surface+edges" },
  { label: "Wire", value: "wireframe" },
  { label: "Points", value: "points" },
];

const GEOMETRY_SCOPES: Array<{
  label: string;
  value: VisualizationGeometryScope;
}> = [
  { label: "Surface", value: "surface" },
  { label: "Full", value: "full" },
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
  const effectiveSettings = settings
    ? resolveEffectiveVisualizationSettings(settings)
    : null;
  const sections = settings && effectiveSettings
    ? buildVisualizationPanelSections({ effectiveSettings, settings })
    : [];
  const passControlsDisabled = pending || !settings?.visible;
  const revision =
    target?.kind === "airbox"
      ? visualizationState.revision ?? visualizationState.status
      : snapshot.version;

  async function patch(patchValue: VisualizationTargetPatch): Promise<void> {
    if (!target) return;
    if (target.kind === "airbox") {
      const localPatch =
        airboxLocalVisualizationPatchFromTargetPatch(patchValue);
      const statePatch = airboxVisualizationStatePatchFromTargetPatch(patchValue);
      if (Object.keys(localPatch).length > 0) {
        visualization.patchTarget(target, localPatch);
      }
      if (!hasVisualizationStatePatch(statePatch)) {
        setFeedback(null);
        return;
      }

      setPending(true);
      try {
        const next = await api.visualization.patch(statePatch);
        resources.invalidate(VISUALIZATION_STATE_RESOURCE_KEY, next.revision);
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

  function sectionDisabled(
    id: ReturnType<typeof buildVisualizationPanelSections>[number]["id"],
  ): boolean {
    return sections.find((section) => section.id === id)?.disabled ?? true;
  }

  function patchColor(
    field: "shaderMonoColor" | "vectorMonoColor" | "wireframeColor",
    value: string,
  ) {
    if (field === "shaderMonoColor") {
      void patch({ shaderMonoColor: value });
      return;
    }
    if (field === "vectorMonoColor") {
      void patch({ vectorMonoColor: value });
      return;
    }
    void patch({ wireframeColor: value });
  }

  function patchNumber(
    field:
      | "vectorAlphaPercent"
      | "vectorThickness"
      | "wireframeOpacityPercent",
    value: number,
  ) {
    if (field === "vectorAlphaPercent") {
      void patch({ vectorAlphaPercent: value });
      return;
    }
    if (field === "vectorThickness") {
      void patch({ vectorThickness: value });
      return;
    }
    void patch({ wireframeOpacityPercent: value });
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

  const opacityPercent = settings.opacityPercent;

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
            active={effectiveSettings?.shaderVisible ?? false}
            disabled={passControlsDisabled}
            label="Shader"
            onClick={() => void patch({ shaderVisible: !settings.shaderVisible })}
          />
          <ToggleButton
            active={effectiveSettings?.wireframeVisible ?? false}
            disabled={passControlsDisabled}
            label="Wireframe"
            onClick={() =>
              void patch({ wireframeVisible: !settings.wireframeVisible })
            }
          />
          <ToggleButton
            active={effectiveSettings?.boundsVisible ?? false}
            disabled={passControlsDisabled}
            label="Frame"
            onClick={() =>
              void patch({ boundsVisible: !settings.boundsVisible })
            }
          />
          <ToggleButton
            active={effectiveSettings?.pointsVisible ?? false}
            disabled={passControlsDisabled}
            label="Points"
            onClick={() => void patch({ pointsVisible: !settings.pointsVisible })}
          />
          <ToggleButton
            active={effectiveSettings?.vectorsVisible ?? false}
            disabled={passControlsDisabled}
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
              disabled={passControlsDisabled}
              variant={
                settings.visible && settings.renderMode === mode.value
                  ? "primary"
                  : "secondary"
              }
              onClick={() => void patch(renderModePatch(mode.value))}
            >
              {mode.label}
            </Button>
          ))}
        </div>
      </InspectorSection>

      <InspectorSection title="Surface Shader">
        <div className="fm-visualization-segments" role="group" aria-label="Shader coloring">
          {VISUALIZATION_COLOR_MODE_ITEMS.map((mode) => (
            <Button
              key={mode.value}
              size="sm"
              type="button"
              disabled={pending || sectionDisabled("surface-shader")}
              variant={
                settings.shaderColorMode === mode.value
                  ? "primary"
                  : "secondary"
              }
              onClick={() => void patch({ shaderColorMode: mode.value })}
            >
              {mode.label}
            </Button>
          ))}
        </div>
        <ColorField
          disabled={pending || sectionDisabled("surface-shader")}
          label="Monochrome color"
          value={settings.shaderMonoColor}
          onChange={(value) => patchColor("shaderMonoColor", value)}
        />
      </InspectorSection>

      <InspectorSection title="Wireframe">
        <ColorField
          disabled={pending || sectionDisabled("wireframe")}
          label="Wireframe color"
          value={settings.wireframeColor}
          onChange={(value) => patchColor("wireframeColor", value)}
        />
        <NumberField
          disabled={pending || sectionDisabled("wireframe")}
          label="Wireframe opacity"
          max={100}
          min={0}
          step={1}
          unit="%"
          value={settings.wireframeOpacityPercent}
          onChange={(value) => patchNumber("wireframeOpacityPercent", value)}
        />
      </InspectorSection>

      <InspectorSection title="Vectors">
        <div className="fm-visualization-segments" role="group" aria-label="Vector coloring">
          {VISUALIZATION_COLOR_MODE_ITEMS.map((mode) => (
            <Button
              key={mode.value}
              size="sm"
              type="button"
              disabled={pending || sectionDisabled("vectors")}
              variant={
                settings.vectorColorMode === mode.value
                  ? "primary"
                  : "secondary"
              }
              onClick={() => void patch({ vectorColorMode: mode.value })}
            >
              {mode.label}
            </Button>
          ))}
        </div>
        <ColorField
          disabled={pending || sectionDisabled("vectors")}
          label="Vector mono color"
          value={settings.vectorMonoColor}
          onChange={(value) => patchColor("vectorMonoColor", value)}
        />
        <NumberField
          disabled={pending || sectionDisabled("vectors")}
          label="Vector alpha"
          max={100}
          min={0}
          step={1}
          unit="%"
          value={settings.vectorAlphaPercent}
          onChange={(value) => patchNumber("vectorAlphaPercent", value)}
        />
        <NumberField
          disabled={pending || sectionDisabled("vectors")}
          label="Vector thickness"
          max={8}
          min={0.1}
          step={0.1}
          value={settings.vectorThickness}
          onChange={(value) => patchNumber("vectorThickness", value)}
        />
      </InspectorSection>

      <InspectorSection title="Geometry Scope">
        <div className="fm-visualization-segments" role="group" aria-label="Geometry scope">
          {GEOMETRY_SCOPES.map((scope) => (
            <Button
              key={scope.value}
              size="sm"
              type="button"
              disabled={passControlsDisabled}
              variant={
                settings.visible && settings.geometryScope === scope.value
                  ? "primary"
                  : "secondary"
              }
              onClick={() => void patch({ geometryScope: scope.value })}
            >
              {scope.label}
            </Button>
          ))}
        </div>
      </InspectorSection>

      <InspectorSection title="Opacity">
        <label className="fm-visualization-range">
          <span>{opacityPercent}%</span>
          <input
            aria-label="Opacity"
            max={100}
            min={0}
            step={1}
            style={{ "--pct": `${opacityPercent}%` } as React.CSSProperties}
            type="range"
            value={opacityPercent}
            onChange={(event) =>
              void patch({ opacityPercent: Number(event.target.value) })
            }
          />
        </label>
      </InspectorSection>

      <InspectorSection title="Overrides">
        <div className="fm-inspector-toolbar">
          <Button
            size="sm"
            type="button"
            disabled={pending}
            variant="ghost"
            onClick={() => void resetTarget()}
          >
            <RotateCcw size={12} aria-hidden="true" />
            Reset display
          </Button>
        </div>
        {feedback && <FeedbackBanner kind="error" message={feedback} />}
      </InspectorSection>
    </div>
  );
}

function ColorField({
  disabled,
  label,
  onChange,
  value,
}: {
  disabled: boolean;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label className="fm-visualization-color-field">
      <span>{label}</span>
      <input
        disabled={disabled}
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function NumberField({
  disabled,
  label,
  max,
  min,
  onChange,
  step,
  unit,
  value,
}: {
  disabled: boolean;
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  step: number;
  unit?: string;
  value: number;
}) {
  const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));

  return (
    <label className="fm-visualization-range">
      <span>{unit ? `${label}: ${value}${unit}` : `${label}: ${value}`}</span>
      <input
        disabled={disabled}
        max={max}
        min={min}
        step={step}
        style={{ "--pct": `${pct}%` } as React.CSSProperties}
        type="range"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
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
