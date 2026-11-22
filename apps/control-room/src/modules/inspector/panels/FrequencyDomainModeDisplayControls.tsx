"use client";

import type { RefObject } from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import { useAnalysisFieldOverlay, type AnalysisFieldOverlaySource } from "@/kernel/visualization/AnalysisFieldOverlayController";
import type { SurfaceColorSource, VisualizationGeometryScope } from "@/kernel/visualization/ObjectVisualizationController";
import { useObjectVisualizationSelector } from "@/kernel/visualization/useObjectVisualization";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";

import {
  colorPickerInputValue,
  normalizeScalarColorPalette,
  scalarColorPaletteGradientCss,
  SCALAR_COLOR_PALETTE_ITEMS,
  SURFACE_COLOR_SOURCE_ITEMS,
  surfaceSolidColorPatch,
} from "./ObjectVisualizationPanelModel";
import { FieldRow } from "../primitives/FieldRow";
import type { ModeFieldComponentOption } from "./frequency-domain/FrequencyDomainHelpers";
import { type FrequencyDomainModeDisplaySettings, normalizeAnalysisFieldView, type FrequencyDomainModeAppearanceCommandInput, analysisFieldViewLabel, MODE_FIELD_COMPONENT_ITEMS, type ModeFieldComponent } from "./FrequencyDomainModeDisplayControls.model";

const MODE_GEOMETRY_SCOPE_ITEMS: Array<{
  label: string;
  value: VisualizationGeometryScope;
}> = [
  { label: "Surface", value: "surface" },
  { label: "Full", value: "full" },
];
const MODE_VECTOR_BUDGET_DEFAULT = 1200;

interface UseFrequencyDomainModeDisplaySettingsOptions {
  activation?: {
    commandId: string;
    componentBasis?: string | null;
    componentCount?: number | null;
    defaultPhaseRad?: number | null;
    fieldId: string | null | undefined;
    label: string;
    source: AnalysisFieldOverlaySource;
    valueKind?: string | null;
  };
  onCommandMessage?: (message: string) => void;
  sourceDetail: string;
}

export function useFrequencyDomainModeDisplaySettings({
  activation,
  onCommandMessage,
  sourceDetail,
}: UseFrequencyDomainModeDisplaySettingsOptions): FrequencyDomainModeDisplaySettings {
  const kernel = useKernel();
  const activeAnalysisFieldOverlay = useAnalysisFieldOverlay(
    kernel.analysisFieldOverlay,
  );
  const visualizationState = useVisualizationStateResource();
  const colorSource = useObjectVisualizationSelector((snapshot) =>
    normalizeModeColorSource(
      activeAnalysisFieldOverlay?.appearance?.surfaceColorSource ??
        snapshot.defaults.part?.surfaceColorSource ??
        null,
    ),
  );
  const solidColor = useObjectVisualizationSelector(
    (snapshot) =>
      activeAnalysisFieldOverlay?.appearance?.shaderMonoColor ??
      snapshot.defaults.part?.shaderMonoColor ??
      "var(--fm-surface-magnetic)",
  );
  const shaderVisible = useObjectVisualizationSelector(
    (snapshot) =>
      activeAnalysisFieldOverlay?.appearance?.shaderVisible ??
      snapshot.defaults.part?.shaderVisible ??
      true,
  );
  const vectorsVisible = useObjectVisualizationSelector(
    (snapshot) =>
      activeAnalysisFieldOverlay?.appearance?.vectorsVisible ??
      snapshot.defaults.part?.vectorsVisible ??
      false,
  );
  const vectorBudget = useObjectVisualizationSelector(
    (snapshot) =>
      activeAnalysisFieldOverlay?.appearance?.vectorBudget ??
      snapshot.defaults.part?.vectorBudget ??
      MODE_VECTOR_BUDGET_DEFAULT,
  );
  const geometryScope = useObjectVisualizationSelector(
    (snapshot) =>
      activeAnalysisFieldOverlay?.appearance?.geometryScope ??
      snapshot.defaults.part?.geometryScope ??
      "surface",
  );
  const colormap = normalizeScalarColorPalette(
    activeAnalysisFieldOverlay?.appearance?.scalarColorPalette ??
      visualizationState.data?.quantity?.colormap ??
      visualizationState.data?.colormap ??
      null,
  );
  const view = normalizeAnalysisFieldView(
    activeAnalysisFieldOverlay?.query?.view ?? null,
  );
  const colorRangeMode = activeAnalysisFieldOverlay?.appearance?.colorRangeMode ?? "auto";
  const colorRangeMin = activeAnalysisFieldOverlay?.appearance?.colorRangeMin ?? -1;
  const colorRangeMax = activeAnalysisFieldOverlay?.appearance?.colorRangeMax ?? 1;
  const displayGain = activeAnalysisFieldOverlay?.appearance?.displayGain ?? 1;
  const vectorScale = activeAnalysisFieldOverlay?.appearance?.vectorScale ?? 1;

  const updateActiveModeAppearance = (
    patch: Partial<FrequencyDomainModeAppearanceCommandInput>,
  ): void => {
    if (!activeAnalysisFieldOverlay) return;
    void kernel.commands
      .execute(
        "analysis.frequency-domain.set-3d-appearance",
        createCommandContext("inspector", kernel, { sourceDetail }),
        patch,
      )
      .then((result) => {
        onCommandMessage?.(result.message ?? result.status);
      });
  };

  const appearanceCommandInput = () => ({
    colorRangeMax,
    colorRangeMin,
    colorRangeMode,
    colorSource,
    colormap,
    geometryScope,
    displayGain,
    shaderVisible,
    solidColor,
    vectorBudget,
    vectorScale,
    vectorsVisible,
  });

  return {
    activeAnalysisFieldOverlay,
    appearanceCommandInput,
    colorSource,
    colorRangeMax,
    colorRangeMin,
    colorRangeMode,
    colormap,
    component: normalizeModeFieldComponent(colorSource),
    geometryScope,
    displayGain,
    shaderVisible,
    solidColor,
    vectorBudget,
    vectorScale,
    vectorsVisible,
    view,
    setColorSource: (value: string) => {
      const surfaceColorSource = normalizeModeColorSource(value);
      if (activeAnalysisFieldOverlay) {
        updateActiveModeAppearance({ colorSource: surfaceColorSource });
      } else {
        kernel.visualization.patchDefaults("part", {
          surfaceColorSource,
        });
      }
      onCommandMessage?.(
        `Mode color source set to ${modeColorSourceLabel(surfaceColorSource)}.`,
      );
    },
    setColorRangeMode: (value: string) => {
      const next = value === "manual" || value === "symmetric" ? value : "auto";
      updateActiveModeAppearance({ colorRangeMode: next });
    },
    setColorRangeMin: (value: string) => {
      updateActiveModeAppearance({ colorRangeMin: finiteNumber(value) ?? colorRangeMin });
    },
    setColorRangeMax: (value: string) => {
      updateActiveModeAppearance({ colorRangeMax: finiteNumber(value) ?? colorRangeMax });
    },
    setDisplayGain: (value: string) => {
      updateActiveModeAppearance({ displayGain: Math.max(0, finiteNumber(value) ?? displayGain) });
    },
    setColormap: (value: string) => {
      const nextColormap = normalizeScalarColorPalette(value);
      if (activeAnalysisFieldOverlay) {
        updateActiveModeAppearance({ colormap: nextColormap });
      } else {
        kernel.visualizationSync.queuePatch({
          quantity: {
            colormap: nextColormap,
          },
        });
      }
      onCommandMessage?.(
        `Mode colormap set to ${modeColormapLabel(nextColormap)}.`,
      );
    },
    setComponent: (value: string) => {
      const nextComponent = normalizeModeFieldComponent(value);
      if (activeAnalysisFieldOverlay) {
        updateActiveModeAppearance({ colorSource: nextComponent });
      } else {
        kernel.visualization.patchDefaults("part", {
          surfaceColorSource: nextComponent,
        });
      }
      onCommandMessage?.(
        `Mode field component set to ${modeFieldComponentLabel(nextComponent)}.`,
      );
    },
    setGeometryScope: (value: string) => {
      const nextGeometryScope: VisualizationGeometryScope =
        value === "full" ? "full" : "surface";
      if (activeAnalysisFieldOverlay) {
        updateActiveModeAppearance({ geometryScope: nextGeometryScope });
      } else {
        kernel.visualization.patchDefaults("part", {
          geometryScope: nextGeometryScope,
        });
      }
      onCommandMessage?.(`Mode vector scope set to ${nextGeometryScope}.`);
    },
    setShaderVisible: (value: boolean) => {
      if (activeAnalysisFieldOverlay) {
        updateActiveModeAppearance({ shaderVisible: value });
      } else {
        kernel.visualization.patchDefaults("part", { shaderVisible: value });
      }
      onCommandMessage?.(`Mode surface ${value ? "enabled" : "disabled"}.`);
    },
    setSolidColor: (value: string) => {
      if (activeAnalysisFieldOverlay) {
        updateActiveModeAppearance({ solidColor: value });
      } else {
        kernel.visualization.patchDefaults("part", surfaceSolidColorPatch(value));
      }
      onCommandMessage?.("Mode solid surface color updated.");
    },
    setVectorBudget: (value: string) => {
      const nextVectorBudget = Math.max(0, Math.floor(finiteNumber(value) ?? 0));
      if (activeAnalysisFieldOverlay) {
        updateActiveModeAppearance({ vectorBudget: nextVectorBudget });
      } else {
        kernel.visualization.patchDefaults("part", {
          vectorBudget: nextVectorBudget,
        });
      }
      onCommandMessage?.(`Mode vector budget set to ${nextVectorBudget}.`);
    },
    setVectorScale: (value: string) => {
      updateActiveModeAppearance({ vectorScale: Math.max(0, finiteNumber(value) ?? vectorScale) });
    },
    setVectorsVisible: (value: boolean) => {
      if (activeAnalysisFieldOverlay) {
        updateActiveModeAppearance({ vectorsVisible: value });
      } else {
        kernel.visualization.patchDefaults("part", { vectorsVisible: value });
      }
      onCommandMessage?.(`Mode vectors ${value ? "enabled" : "disabled"}.`);
    },
    setView: (value: string) => {
      const nextView = normalizeAnalysisFieldView(value);
      if (
        activeAnalysisFieldOverlay &&
        (!activation?.fieldId ||
          (activeAnalysisFieldOverlay.fieldId === activation.fieldId &&
            activeAnalysisFieldOverlay.source === activation.source))
      ) {
        kernel.analysisFieldOverlay.update({
          query: {
            ...activeAnalysisFieldOverlay.query,
            view: nextView,
          },
        });
      } else if (activation?.fieldId) {
        void kernel.commands
          .execute(
            activation.commandId,
            createCommandContext("inspector", kernel, { sourceDetail }),
            {
              ...appearanceCommandInput(),
              componentBasis: activation.componentBasis ?? null,
              componentCount: activation.componentCount ?? null,
              fieldId: activation.fieldId,
              label: activation.label,
              phaseRad: activation.defaultPhaseRad ?? 0,
              source: activation.source,
              valueKind: activation.valueKind ?? null,
              view: nextView,
            },
          )
          .then((result) => {
            onCommandMessage?.(result.message ?? result.status);
          });
      }
      onCommandMessage?.(`Mode field view set to ${analysisFieldViewLabel(nextView)}.`);
    },
  };
}

interface FrequencyDomainModeDisplayControlsProps {
  componentOptions?: readonly ModeFieldComponentOption[];
  disabled: boolean;
  labelPrefix: string;
  settings: FrequencyDomainModeDisplaySettings;
  viewDefaultValue: string;
  viewOptions: readonly string[];
  viewRef?: RefObject<HTMLButtonElement | HTMLSelectElement | null>;
  viewTitle?: string;
}

export function FrequencyDomainModeDisplayControls({
  componentOptions = MODE_FIELD_COMPONENT_ITEMS,
  disabled,
  labelPrefix,
  settings,
  viewDefaultValue,
  viewOptions,
  viewRef,
  viewTitle,
}: FrequencyDomainModeDisplayControlsProps) {
  const pickerValue = colorPickerInputValue(settings.solidColor);
  const selectedView = viewOptions.includes(settings.view)
    ? settings.view
    : normalizeAnalysisFieldView(viewDefaultValue);
  const selectedComponent = componentOptions.some(
    (item) => item.value === settings.component,
  )
    ? settings.component
    : componentOptions[0]?.value ?? settings.component;
  const selectedViewLabel = analysisFieldViewLabel(selectedView);
  const selectedComponentLabel =
    componentOptions.find((item) => item.value === selectedComponent)?.label ??
    selectedComponent;
  const selectedColorSourceLabel = modeColorSourceLabel(settings.colorSource);
  const selectedColormapLabel = modeColormapLabel(settings.colormap);
  const selectedColorRangeLabel =
    settings.colorRangeMode === "manual"
      ? "Manual"
      : settings.colorRangeMode === "symmetric"
        ? "Symmetric"
        : "Auto";
  const selectedGeometryScopeLabel =
    MODE_GEOMETRY_SCOPE_ITEMS.find((item) => item.value === settings.geometryScope)
      ?.label ?? settings.geometryScope;
  return (
    <>
      <FieldRow
        label="Mode field view"
        value={
          <Select
            disabled={disabled}
            value={selectedView}
            onValueChange={(nextValue) => settings.setView(nextValue)}
          >
            <SelectTrigger
              aria-label={`${labelPrefix} 3D view`}
              ref={viewRef as RefObject<HTMLButtonElement | null> | undefined}
              title={viewTitle}
            >
              <SelectValue placeholder={selectedViewLabel}>
                {selectedViewLabel}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {viewOptions.map((view) => (
                <SelectItem key={view} value={view}>
                  {analysisFieldViewLabel(view)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <FieldRow
        label="Mode component"
        value={
          <Select
            disabled={disabled}
            value={selectedComponent}
            onValueChange={(nextValue) => settings.setComponent(nextValue)}
          >
            <SelectTrigger aria-label={`${labelPrefix} field component`}>
              <SelectValue placeholder={selectedComponentLabel}>
                {selectedComponentLabel}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {componentOptions.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <FieldRow
        label="Display passes"
        value={
          <div className="fm-visualization-toggle-grid">
            <Button
              className="fm-visualization-toggle"
              disabled={disabled}
              size="sm"
              type="button"
              variant={settings.shaderVisible ? "primary" : "secondary"}
              onClick={() => settings.setShaderVisible(!settings.shaderVisible)}
            >
              Surface
            </Button>
            <Button
              className="fm-visualization-toggle"
              disabled={disabled}
              size="sm"
              type="button"
              variant={settings.vectorsVisible ? "primary" : "secondary"}
              onClick={() => settings.setVectorsVisible(!settings.vectorsVisible)}
            >
              Vectors
            </Button>
          </div>
        }
      />
      <FieldRow
        label="Mode color source"
        value={
          <Select
            disabled={disabled}
            value={settings.colorSource}
            onValueChange={(nextValue) => settings.setColorSource(nextValue)}
          >
            <SelectTrigger aria-label={`${labelPrefix} color source`}>
              <SelectValue placeholder={selectedColorSourceLabel}>
                {selectedColorSourceLabel}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {SURFACE_COLOR_SOURCE_ITEMS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <FieldRow
        label="Mode solid color"
        value={
          <div className="fm-visualization-color-field__control">
            <input
              aria-label={`${labelPrefix} solid color picker`}
              className="fm-visualization-color-field__picker"
              disabled={disabled}
              type="color"
              value={pickerValue}
              onChange={(event) => settings.setSolidColor(event.target.value)}
            />
            <Input
              aria-label={`${labelPrefix} solid color`}
              className="fm-visualization-color-field__value"
              disabled={disabled}
              type="text"
              value={settings.solidColor}
              onChange={(event) => settings.setSolidColor(event.target.value)}
            />
          </div>
        }
      />
      <FieldRow
        label="Mode colormap"
        value={
          <div className="fm-inspector-colorbar-control">
            <Select
              disabled={disabled}
              value={settings.colormap}
              onValueChange={(nextValue) => settings.setColormap(nextValue)}
            >
              <SelectTrigger aria-label={`${labelPrefix} colormap`}>
                <SelectValue placeholder={selectedColormapLabel}>
                  {selectedColormapLabel}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {SCALAR_COLOR_PALETTE_ITEMS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span
              aria-hidden="true"
              className="fm-inspector-colorbar__ramp"
              style={{
                background: scalarColorPaletteGradientCss(settings.colormap),
              }}
            />
          </div>
        }
      />
      <FieldRow
        label="Color range"
        value={
          <Select
            disabled={disabled}
            value={settings.colorRangeMode}
            onValueChange={(nextValue) => settings.setColorRangeMode(nextValue)}
          >
            <SelectTrigger aria-label={`${labelPrefix} color range mode`}>
              <SelectValue placeholder={selectedColorRangeLabel}>
                {selectedColorRangeLabel}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto</SelectItem>
              <SelectItem value="symmetric">Symmetric</SelectItem>
              <SelectItem value="manual">Manual</SelectItem>
            </SelectContent>
          </Select>
        }
      />
      <FieldRow
        label="Color minimum"
        value={
          <Input
            aria-label={`${labelPrefix} color minimum`}
            disabled={disabled || settings.colorRangeMode !== "manual"}
            step="any"
            type="number"
            value={settings.colorRangeMin}
            onChange={(event) => settings.setColorRangeMin(event.currentTarget.value)}
          />
        }
      />
      <FieldRow
        label="Color maximum"
        value={
          <Input
            aria-label={`${labelPrefix} color maximum`}
            disabled={disabled || settings.colorRangeMode === "auto"}
            min={settings.colorRangeMode === "symmetric" ? "0" : undefined}
            step="any"
            type="number"
            value={settings.colorRangeMax}
            onChange={(event) => settings.setColorRangeMax(event.currentTarget.value)}
          />
        }
      />
      <FieldRow
        label="Display gain"
        value={
          <Input
            aria-label={`${labelPrefix} display gain`}
            disabled={disabled}
            min="0"
            step="0.1"
            type="number"
            value={settings.displayGain}
            onChange={(event) => settings.setDisplayGain(event.currentTarget.value)}
          />
        }
      />
      <FieldRow
        label="Vector budget"
        value={
          <Input
            aria-label={`${labelPrefix} vector budget`}
            disabled={disabled}
            max="20000"
            min="0"
            step="1"
            type="number"
            value={settings.vectorBudget}
            onChange={(event) => settings.setVectorBudget(event.currentTarget.value)}
          />
        }
      />
      <FieldRow
        label="Vector scope"
        value={
          <Select
            disabled={disabled}
            value={settings.geometryScope}
            onValueChange={(nextValue) => settings.setGeometryScope(nextValue)}
          >
            <SelectTrigger aria-label={`${labelPrefix} vector scope`}>
              <SelectValue placeholder={selectedGeometryScopeLabel}>
                {selectedGeometryScopeLabel}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {MODE_GEOMETRY_SCOPE_ITEMS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <FieldRow
        label="Vector scale"
        value={
          <Input
            aria-label={`${labelPrefix} vector scale`}
            disabled={disabled}
            min="0"
            step="0.1"
            type="number"
            value={settings.vectorScale}
            onChange={(event) => settings.setVectorScale(event.currentTarget.value)}
          />
        }
      />
      <p className="fm-mode-visualization__presentation-note">
        These controls adjust how the computed mode is displayed.
      </p>
    </>
  );
}

function normalizeModeColorSource(
  value: string | null | undefined,
): SurfaceColorSource {
  if (
    value === "solid" ||
    value === "orientation" ||
    value === "component_x" ||
    value === "component_y" ||
    value === "component_z" ||
    value === "magnitude" ||
    value === "colormap"
  ) {
    return value;
  }
  return "orientation";
}

function normalizeModeFieldComponent(
  value: string | null | undefined,
): ModeFieldComponent {
  if (
    value === "component_x" ||
    value === "component_y" ||
    value === "component_z" ||
    value === "magnitude"
  ) {
    return value;
  }
  return "magnitude";
}

function modeFieldComponentLabel(value: ModeFieldComponent): string {
  return (
    MODE_FIELD_COMPONENT_ITEMS.find((item) => item.value === value)?.label ??
    value
  );
}

function modeColormapLabel(value: string | null | undefined): string {
  const normalized = normalizeScalarColorPalette(value);
  return (
    SCALAR_COLOR_PALETTE_ITEMS.find((item) => item.value === normalized)?.label ??
    normalized
  );
}

function modeColorSourceLabel(value: string | null | undefined): string {
  const normalized = normalizeModeColorSource(value);
  return (
    SURFACE_COLOR_SOURCE_ITEMS.find((item) => item.value === normalized)?.label ??
    normalized
  );
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
