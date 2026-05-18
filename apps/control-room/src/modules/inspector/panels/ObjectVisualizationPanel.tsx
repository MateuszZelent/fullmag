"use client";

import { RotateCcw } from "lucide-react";
import React, { useState } from "react";

import type { LiveStatusResource } from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import {
  airboxLocalVisualizationPatchFromTargetPatch,
  airboxVisualizationStatePatchFromTargetPatch,
  DEFAULT_AIRBOX_VISUALIZATION,
  displayLabelForVisualizationTarget,
  hasVisualizationStatePatch,
  mergeVisualizationStateTargetOverride,
  renderModePatch,
  resolveTargetVisualization,
  resolveVisualizationTargetFromSelection,
  type VisualizationGeometryScope,
  type VisualizationRenderMode,
  type SurfaceColorSource,
  type VisualizationTargetPatch,
  type VisualizationTargetSettings,
} from "@/kernel/visualization/ObjectVisualizationController";
import { useSessionStatus } from "@/kernel/resources/useSessionStatus";
import { useObjectVisualizationRegistry } from "@/kernel/visualization/useObjectVisualization";
import {
  useVisualizationStateResource,
} from "@/kernel/visualization/useVisualizationStateResource";
import { Button } from "@/shared/ui/Button";
import {
  useMeshSharedDomainManifestResource,
  useSceneResource,
} from "@/kernel/resources/geometryLifecycleResources";
import { resolveVisualizationTopologyFreshness } from "@/kernel/visualization/visualizationDisplayResolution";

import type { InspectorPanelProps } from "../inspectorTypes";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { FieldRow } from "../primitives/FieldRow";
import { FormField } from "../primitives/FormField";
import { InspectorSection } from "../primitives/InspectorSection";
import {
  buildVisualizationPanelSections,
  colorPickerInputValue,
  resolveVisualizationRenderResolution,
  SURFACE_COLOR_SOURCE_ITEMS,
  surfaceDisplayPassPatch,
  surfaceSolidColorPatch,
  VISUALIZATION_COLOR_MODE_ITEMS,
} from "./ObjectVisualizationPanelModel";

const RENDER_MODES: Array<{
  label: string;
  value: VisualizationRenderMode;
}> = [
  { label: "Shaded", value: "surface" },
  { label: "Shaded + wireframe", value: "surface+edges" },
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

function surfaceFieldStatus(
  source: SurfaceColorSource,
  status: LiveStatusResource | null,
  fetchStatus: string,
): string {
  if (source === "solid") return "not required";
  const revision = Math.max(
    typeof status?.resources.field_revision === "number"
      ? status.resources.field_revision
      : 0,
    typeof status?.resources.fields_revision === "number"
      ? status.resources.fields_revision
      : 0,
  );
  if (revision > 0) {
    return `available r${revision}`;
  }
  return fetchStatus === "ready" ? "none" : fetchStatus;
}

type PatchVisualizationTarget = (patchValue: VisualizationTargetPatch) => Promise<void>;
type SectionDisabled = (
  id: ReturnType<typeof buildVisualizationPanelSections>[number]["id"],
) => boolean;

function remoteVisualizationTargetPatch(
  patch: VisualizationTargetPatch,
): VisualizationTargetPatch {
  const remotePatch = { ...patch };
  delete remotePatch.vectorCenteringEnabled;
  delete remotePatch.vectorSurfaceOffsetEnabled;
  return remotePatch;
}

function VisualizationDisplayPassesSection({
  displaySettings,
  passControlsDisabled,
  patch,
  pending,
  renderWarning,
  settings,
}: {
  displaySettings: VisualizationTargetSettings;
  passControlsDisabled: boolean;
  patch: PatchVisualizationTarget;
  pending: boolean;
  renderWarning: string | null;
  settings: VisualizationTargetSettings;
}) {
  return (
    <InspectorSection title="Display Passes">
      {renderWarning ? (
        <FeedbackBanner kind="warning" message={renderWarning} />
      ) : null}
      <div className="fm-visualization-toggle-grid">
        <ToggleButton active={displaySettings.visible} disabled={pending} label="Visible" onClick={() => void patch({ visible: !settings.visible })} />
        <ToggleButton active={displaySettings.shaderVisible} disabled={passControlsDisabled} label="Surface" onClick={() => void patch(surfaceDisplayPassPatch(settings))} />
        <ToggleButton active={displaySettings.wireframeVisible} disabled={passControlsDisabled} label="Wireframe" onClick={() => void patch({ wireframeVisible: !settings.wireframeVisible })} />
        <ToggleButton active={displaySettings.boundsVisible} disabled={passControlsDisabled} label="Frame" onClick={() => void patch({ boundsVisible: !settings.boundsVisible })} />
        <ToggleButton active={displaySettings.pointsVisible} disabled={passControlsDisabled} label="Points" onClick={() => void patch({ pointsVisible: !settings.pointsVisible })} />
        <ToggleButton active={displaySettings.vectorsVisible} disabled={passControlsDisabled} label="Vectors" onClick={() => void patch({ vectorsVisible: !settings.vectorsVisible })} />
      </div>
    </InspectorSection>
  );
}

function VisualizationRenderModeSection({
  displaySettings,
  passControlsDisabled,
  patch,
}: {
  displaySettings: VisualizationTargetSettings;
  passControlsDisabled: boolean;
  patch: PatchVisualizationTarget;
}) {
  return (
    <InspectorSection title="Render Mode">
      <div className="fm-visualization-segments" role="group" aria-label="Render mode">
        {RENDER_MODES.map((mode) => (
          <Button
            key={mode.value}
            size="sm"
            type="button"
            disabled={passControlsDisabled}
            variant={displaySettings.visible && displaySettings.renderMode === mode.value ? "primary" : "secondary"}
            onClick={() => void patch(renderModePatch(mode.value))}
          >
            {mode.label}
          </Button>
        ))}
      </div>
    </InspectorSection>
  );
}

function VisualizationSurfaceColoringSection({
  patch,
  patchColor,
  pending,
  sectionDisabled,
  sessionStatus,
  settings,
}: {
  patch: PatchVisualizationTarget;
  patchColor: (
    field: "shaderMonoColor" | "vectorMonoColor" | "wireframeColor",
    value: string,
  ) => void;
  pending: boolean;
  sectionDisabled: SectionDisabled;
  sessionStatus: ReturnType<typeof useSessionStatus>;
  settings: VisualizationTargetSettings;
}) {
  return (
    <InspectorSection title="Surface Coloring" collapsible>
      <FormField
        disabled={pending || sectionDisabled("surface-coloring")}
        label="Color source"
        type="select"
        value={settings.surfaceColorSource}
        onChange={(event) =>
          void patch({ surfaceColorSource: event.target.value as SurfaceColorSource })
        }
      >
        {SURFACE_COLOR_SOURCE_ITEMS.map((source) => (
          <option key={source.value} value={source.value}>
            {source.label}
          </option>
        ))}
      </FormField>
      <ColorField
        disabled={pending || sectionDisabled("surface-coloring")}
        label="Solid color"
        value={settings.shaderMonoColor}
        onChange={(value) => patchColor("shaderMonoColor", value)}
      />
      <FieldRow
        label="Field status"
        value={surfaceFieldStatus(
          settings.surfaceColorSource,
          sessionStatus.data,
          sessionStatus.status,
        )}
      />
    </InspectorSection>
  );
}

function VisualizationWireframeSection({
  patchColor,
  patchNumber,
  pending,
  sectionDisabled,
  settings,
}: {
  patchColor: (field: "wireframeColor", value: string) => void;
  patchNumber: (field: "wireframeOpacityPercent", value: number) => void;
  pending: boolean;
  sectionDisabled: SectionDisabled;
  settings: VisualizationTargetSettings;
}) {
  return (
    <InspectorSection title="Wireframe">
      <ColorField disabled={pending || sectionDisabled("wireframe")} label="Wireframe color" value={settings.wireframeColor} onChange={(value) => patchColor("wireframeColor", value)} />
      <NumberField disabled={pending || sectionDisabled("wireframe")} label="Wireframe opacity" max={100} min={0} step={1} unit="%" value={settings.wireframeOpacityPercent} onChange={(value) => patchNumber("wireframeOpacityPercent", value)} />
    </InspectorSection>
  );
}

function VisualizationVectorsSection({
  meshParts,
  onTogglePartVectors,
  patch,
  patchColor,
  patchNumber,
  pending,
  sectionDisabled,
  settings,
}: {
  meshParts?: ReadonlyArray<{ id: string; label: string; vectorsVisible: boolean }>;
  onTogglePartVectors?: (partId: string, visible: boolean) => void;
  patch: PatchVisualizationTarget;
  patchColor: (field: "vectorMonoColor", value: string) => void;
  patchNumber: (
    field: "vectorAlphaPercent" | "vectorBudget" | "vectorLengthScale" | "vectorThickness",
    value: number,
  ) => void;
  pending: boolean;
  sectionDisabled: SectionDisabled;
  settings: VisualizationTargetSettings;
}) {
  return (
    <InspectorSection title="Vectors">
      <div className="fm-visualization-segments" role="group" aria-label="Vector coloring">
        {VISUALIZATION_COLOR_MODE_ITEMS.map((mode) => (
          <Button
            key={mode.value}
            size="sm"
            type="button"
            disabled={pending || sectionDisabled("vectors")}
            variant={settings.vectorColorMode === mode.value ? "primary" : "secondary"}
            onClick={() => void patch({ vectorColorMode: mode.value })}
          >
            {mode.label}
          </Button>
        ))}
      </div>
      <ColorField disabled={pending || sectionDisabled("vectors")} label="Vector mono color" value={settings.vectorMonoColor} onChange={(value) => patchColor("vectorMonoColor", value)} />
      <NumberField disabled={pending || sectionDisabled("vectors")} label="Vector alpha" max={100} min={0} step={1} unit="%" value={settings.vectorAlphaPercent} onChange={(value) => patchNumber("vectorAlphaPercent", value)} />
      <NumberField disabled={pending || sectionDisabled("vectors")} label="Vector thickness" max={8} min={0.1} step={0.1} value={settings.vectorThickness} onChange={(value) => patchNumber("vectorThickness", value)} />
      <NumberField disabled={pending || sectionDisabled("vectors")} label="Arrow length" max={5} min={0.1} step={0.1} unit="×" value={settings.vectorLengthScale} onChange={(value) => patchNumber("vectorLengthScale", value)} />
      <NumberField disabled={pending || sectionDisabled("vectors")} label="Arrow budget" max={4096} min={8} step={8} value={settings.vectorBudget} onChange={(value) => patchNumber("vectorBudget", value)} />
      <div className="fm-visualization-toggle-grid">
        <ToggleButton
          active={settings.vectorCenteringEnabled}
          disabled={pending || sectionDisabled("vectors")}
          label="Centered arrows"
          onClick={() =>
            void patch({
              vectorCenteringEnabled: !settings.vectorCenteringEnabled,
            })
          }
        />
        <ToggleButton
          active={settings.vectorSurfaceOffsetEnabled}
          disabled={pending || sectionDisabled("vectors")}
          label="Surface lift"
          onClick={() =>
            void patch({
              vectorSurfaceOffsetEnabled:
                !settings.vectorSurfaceOffsetEnabled,
            })
          }
        />
      </div>
      <div className="fm-visualization-segments" role="group" aria-label="Arrow extent">
        {GEOMETRY_SCOPES.map((scope) => (
          <Button
            key={scope.value}
            size="sm"
            type="button"
            disabled={pending || sectionDisabled("vectors")}
            variant={settings.geometryScope === scope.value ? "primary" : "secondary"}
            onClick={() => void patch({ geometryScope: scope.value })}
          >
            {scope.label}
          </Button>
        ))}
      </div>
      {meshParts && meshParts.length > 1 && onTogglePartVectors && (
        <div className="fm-visualization-part-toggles" role="group" aria-label="Per-part vector visibility">
          <span className="fm-visualization-part-toggles__label">Surfaces</span>
          {meshParts.map((part) => (
            <label key={part.id} className="fm-visualization-part-toggle">
              <input
                type="checkbox"
                checked={part.vectorsVisible}
                disabled={pending || sectionDisabled("vectors")}
                onChange={(e) => onTogglePartVectors(part.id, e.target.checked)}
              />
              <span>{part.label}</span>
            </label>
          ))}
        </div>
      )}
    </InspectorSection>
  );
}

function VisualizationGeometryScopeSection({
  passControlsDisabled,
  patch,
  settings,
}: {
  passControlsDisabled: boolean;
  patch: PatchVisualizationTarget;
  settings: VisualizationTargetSettings;
}) {
  return (
    <InspectorSection title="Geometry Scope">
      <div className="fm-visualization-segments" role="group" aria-label="Geometry scope">
        {GEOMETRY_SCOPES.map((scope) => (
          <Button
            key={scope.value}
            size="sm"
            type="button"
            disabled={passControlsDisabled}
            variant={settings.visible && settings.geometryScope === scope.value ? "primary" : "secondary"}
            onClick={() => void patch({ geometryScope: scope.value })}
          >
            {scope.label}
          </Button>
        ))}
      </div>
    </InspectorSection>
  );
}

function VisualizationOpacitySection({
  patch,
  settings,
}: {
  patch: PatchVisualizationTarget;
  settings: VisualizationTargetSettings;
}) {
  const opacityPercent = settings.opacityPercent;
  return (
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
  );
}

function VisualizationOverridesSection({
  feedback,
  onReset,
  pending,
}: {
  feedback: string | null;
  onReset: () => void;
  pending: boolean;
}) {
  return (
    <InspectorSection title="Overrides">
      <div className="fm-inspector-toolbar">
        <Button size="sm" type="button" disabled={pending} variant="ghost" onClick={onReset}>
          <RotateCcw size={12} aria-hidden="true" />
          Reset display
        </Button>
      </div>
      {feedback && <FeedbackBanner kind="error" message={feedback} />}
    </InspectorSection>
  );
}

export function ObjectVisualizationPanel({ selection }: InspectorPanelProps) {
  const target = resolveVisualizationTargetFromSelection(selection);
  const { visualizationSync } = useKernel();
  const { snapshot, visualization } = useObjectVisualizationRegistry();
  const visualizationState = useVisualizationStateResource();
  const sessionStatus = useSessionStatus();
  const scene = useSceneResource({ enabled: Boolean(target) });
  const manifest = useMeshSharedDomainManifestResource({
    enabled: Boolean(target),
  });
  const [feedback, setFeedback] = useState<string | null>(null);
  const pending = false;
  const targetVisualization = target
    ? resolveTargetVisualization({
        snapshot,
        target,
        visualizationState: visualizationState.data,
      })
    : null;
  const settings = targetVisualization?.settings ?? null;
  const effectiveSettings = targetVisualization?.effectiveSettings ?? null;
  const topologyFreshness =
    scene.data && manifest.data
      ? resolveVisualizationTopologyFreshness(scene.data, manifest.data)
      : null;
  const renderResolution = settings && effectiveSettings
    ? resolveVisualizationRenderResolution({
        effectiveSettings,
        settings,
        topologyFreshness,
      })
    : null;
  const sections = settings && effectiveSettings
    ? buildVisualizationPanelSections({
        effectiveSettings: renderResolution?.finalSettings ?? effectiveSettings,
        settings,
      })
    : [];
  const passControlsDisabled = pending || !settings?.visible;
  const revision = targetVisualization?.revision ?? snapshot.version;

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

      visualizationSync.queuePatch(statePatch);
      setFeedback(null);
      return;
    }

    if (!visualizationState.data) {
      visualization.patchTarget(target, patchValue);
      return;
    }

    const remotePatch = remoteVisualizationTargetPatch(patchValue);
    if (Object.keys(remotePatch).length > 0) {
      visualizationSync.queuePatch({
        overrides: mergeVisualizationStateTargetOverride(
          visualizationState.data.overrides ?? [],
          target,
          remotePatch,
        ),
      });
    }
    // Keep the patch locally for immediate inspector/ribbon feedback until the
    // revision-driven resource refetch lands.
    visualization.patchTarget(target, patchValue);
    setFeedback(null);
  }

  async function resetTarget(): Promise<void> {
    if (!target) return;
    if (target.kind === "airbox") {
      visualizationSync.queuePatch(
        airboxVisualizationStatePatchFromTargetPatch(
          DEFAULT_AIRBOX_VISUALIZATION,
        ),
      );
      visualization.clearTarget(target);
      setFeedback(null);
      return;
    }

    if (!visualizationState.data) {
      visualization.clearTarget(target);
      return;
    }

    visualizationSync.queuePatch({
      overrides: (visualizationState.data.overrides ?? []).filter(
        (entry) =>
          !(entry.scope === target.kind && entry.scope_id === target.id),
      ),
    });
    visualization.clearTarget(target);
    setFeedback(null);
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
      void patch(surfaceSolidColorPatch(value));
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
      | "vectorBudget"
      | "vectorLengthScale"
      | "vectorThickness"
      | "wireframeOpacityPercent",
    value: number,
  ) {
    if (field === "vectorAlphaPercent") {
      void patch({ vectorAlphaPercent: value });
      return;
    }
    if (field === "vectorBudget") {
      void patch({ vectorBudget: value });
      return;
    }
    if (field === "vectorLengthScale") {
      void patch({ vectorLengthScale: value });
      return;
    }
    if (field === "vectorThickness") {
      void patch({ vectorThickness: value });
      return;
    }
    void patch({ wireframeOpacityPercent: value });
  }

  // Build per-part arrow visibility list from manifest.
  const vectorMeshParts = (() => {
    const parts = manifest.data?.mesh_parts;
    if (!parts || parts.length === 0) return undefined;
    // Filter to magnetic parts only (exclude airbox).
    const magneticParts = parts.filter((p) => p.role !== "airbox");
    if (magneticParts.length <= 1) return undefined;
    return magneticParts.map((p) => {
      const partTarget = p.object_id
        ? { id: p.object_id, kind: "object" as const }
        : { id: p.id, kind: "part" as const };
      const partSettings = resolveTargetVisualization({
        snapshot,
        target: partTarget,
        visualizationState: visualizationState.data,
      }).settings;
      return {
        id: p.id,
        label: p.label,
        objectId: p.object_id ?? null,
        vectorsVisible: partSettings.vectorsVisible,
      };
    });
  })();

  if (!target || !settings) {
    return (
      <div className="fm-inspector-panel">
        <InspectorSection title="Visualization">
          <FieldRow label="Target" value="No visualization target" />
        </InspectorSection>
      </div>
    );
  }

  const displaySettings = renderResolution?.finalSettings ?? effectiveSettings ?? settings;
  const renderWarning = renderResolution?.degradedReasons[0]?.message ?? null;

  function onTogglePartVectors(partId: string, visible: boolean) {
    const part = manifest.data?.mesh_parts?.find((p) => p.id === partId);
    if (!part || !visualizationState.data) return;
    const partTarget = part.object_id
      ? { id: part.object_id, kind: "object" as const, label: part.label }
      : { id: part.id, kind: "part" as const, label: part.label };
    visualizationSync.queuePatch({
      overrides: mergeVisualizationStateTargetOverride(
        visualizationState.data.overrides ?? [],
        partTarget,
        { vectorsVisible: visible },
      ),
    });
  }

  return (
    <div className="fm-inspector-panel" data-visualization-revision={revision}>
      <InspectorSection title="Visualization Target">
        <FieldRow label="Name" value={displayLabelForVisualizationTarget(target)} />
        <FieldRow label="Target ID" value={target.kind === "airbox" ? "airbox" : target.id} />
        <FieldRow label="Kind" value={target.kind} />
        <FieldRow
          label="Render state"
          value={
            renderResolution?.degradedReasons[0]?.message ??
            (settings.renderMode === "surface+edges"
              ? "Shaded + wireframe"
              : settings.renderMode)
          }
        />
      </InspectorSection>
      <VisualizationDisplayPassesSection
        displaySettings={displaySettings}
        passControlsDisabled={passControlsDisabled}
        patch={patch}
        pending={pending}
        renderWarning={renderWarning}
        settings={settings}
      />
      <VisualizationRenderModeSection
        displaySettings={displaySettings}
        passControlsDisabled={passControlsDisabled}
        patch={patch}
      />
      <VisualizationSurfaceColoringSection
        patch={patch}
        patchColor={patchColor}
        pending={pending}
        sectionDisabled={sectionDisabled}
        sessionStatus={sessionStatus}
        settings={settings}
      />
      <VisualizationWireframeSection
        patchColor={patchColor}
        patchNumber={patchNumber}
        pending={pending}
        sectionDisabled={sectionDisabled}
        settings={settings}
      />
      <VisualizationVectorsSection
        meshParts={vectorMeshParts}
        onTogglePartVectors={onTogglePartVectors}
        patch={patch}
        patchColor={patchColor}
        patchNumber={patchNumber}
        pending={pending}
        sectionDisabled={sectionDisabled}
        settings={settings}
      />
      <VisualizationGeometryScopeSection
        passControlsDisabled={passControlsDisabled}
        patch={patch}
        settings={settings}
      />
      <VisualizationOpacitySection patch={patch} settings={settings} />
      <VisualizationOverridesSection
        feedback={feedback}
        onReset={() => void resetTarget()}
        pending={pending}
      />
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
  const pickerValue = colorPickerInputValue(value);

  return (
    <label className="fm-visualization-color-field">
      <span>{label}</span>
      <div className="fm-visualization-color-field__control">
        <input
          aria-label={`${label} picker`}
          className="fm-visualization-color-field__picker"
          disabled={disabled}
          type="color"
          value={pickerValue}
          onChange={(event) => onChange(event.target.value)}
        />
        <input
          className="fm-visualization-color-field__value"
          disabled={disabled}
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
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
