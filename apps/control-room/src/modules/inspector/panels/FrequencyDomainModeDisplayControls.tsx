"use client";

import type { RefObject } from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import { useKernel } from "@/kernel/KernelContext";
import {
  useAnalysisFieldOverlay,
  type AnalysisFieldOverlayState,
} from "@/kernel/visualization/AnalysisFieldOverlayController";
import type {
  SurfaceColorSource,
  VisualizationGeometryScope,
} from "@/kernel/visualization/ObjectVisualizationController";
import { useObjectVisualizationSelector } from "@/kernel/visualization/useObjectVisualization";
import { useVisualizationStateResource } from "@/kernel/visualization/useVisualizationStateResource";
import { Button } from "@/shared/ui/Button";

import {
  colorPickerInputValue,
  normalizeScalarColorPalette,
  scalarColorPaletteGradientCss,
  SCALAR_COLOR_PALETTE_ITEMS,
  SURFACE_COLOR_SOURCE_ITEMS,
  surfaceSolidColorPatch,
} from "./ObjectVisualizationPanelModel";
import { FieldRow } from "../primitives/FieldRow";

export const DEFAULT_ANALYSIS_FIELD_VIEW = "phase_rotated_real";
export const ANALYSIS_FIELD_VIEW_OPTIONS = [
  DEFAULT_ANALYSIS_FIELD_VIEW,
  "real",
  "imag",
  "abs",
  "phase",
] as const;

const MODE_GEOMETRY_SCOPE_ITEMS: Array<{
  label: string;
  value: VisualizationGeometryScope;
}> = [
  { label: "Surface", value: "surface" },
  { label: "Full", value: "full" },
];
const MODE_VECTOR_BUDGET_DEFAULT = 1200;

interface FrequencyDomainModeAppearanceCommandInput {
  colorSource: SurfaceColorSource;
  colormap: string;
  geometryScope: VisualizationGeometryScope;
  shaderVisible: boolean;
  solidColor: string;
  vectorBudget: number;
  vectorsVisible: boolean;
}

export interface FrequencyDomainModeDisplaySettings {
  activeAnalysisFieldOverlay: AnalysisFieldOverlayState | null;
  appearanceCommandInput: () => FrequencyDomainModeAppearanceCommandInput;
  colorSource: SurfaceColorSource;
  colormap: string;
  geometryScope: VisualizationGeometryScope;
  setColorSource: (value: string) => void;
  setColormap: (value: string) => void;
  setGeometryScope: (value: string) => void;
  setShaderVisible: (value: boolean) => void;
  setSolidColor: (value: string) => void;
  setVectorBudget: (value: string) => void;
  setVectorsVisible: (value: boolean) => void;
  shaderVisible: boolean;
  solidColor: string;
  vectorBudget: number;
  vectorsVisible: boolean;
}

interface UseFrequencyDomainModeDisplaySettingsOptions {
  onCommandMessage?: (message: string) => void;
  sourceDetail: string;
}

export function useFrequencyDomainModeDisplaySettings({
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
    colorSource,
    colormap,
    geometryScope,
    shaderVisible,
    solidColor,
    vectorBudget,
    vectorsVisible,
  });

  return {
    activeAnalysisFieldOverlay,
    appearanceCommandInput,
    colorSource,
    colormap,
    geometryScope,
    shaderVisible,
    solidColor,
    vectorBudget,
    vectorsVisible,
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
    setVectorsVisible: (value: boolean) => {
      if (activeAnalysisFieldOverlay) {
        updateActiveModeAppearance({ vectorsVisible: value });
      } else {
        kernel.visualization.patchDefaults("part", { vectorsVisible: value });
      }
      onCommandMessage?.(`Mode vectors ${value ? "enabled" : "disabled"}.`);
    },
  };
}

interface FrequencyDomainModeDisplayControlsProps {
  disabled: boolean;
  labelPrefix: string;
  settings: FrequencyDomainModeDisplaySettings;
  viewDefaultValue: string;
  viewOptions: readonly string[];
  viewRef?: RefObject<HTMLSelectElement | null>;
  viewTitle?: string;
}

export function FrequencyDomainModeDisplayControls({
  disabled,
  labelPrefix,
  settings,
  viewDefaultValue,
  viewOptions,
  viewRef,
  viewTitle,
}: FrequencyDomainModeDisplayControlsProps) {
  const pickerValue = colorPickerInputValue(settings.solidColor);
  return (
    <>
      <FieldRow
        label="Mode field view"
        value={
          <select
            aria-label={`${labelPrefix} 3D view`}
            className="fm-inspector-select"
            defaultValue={viewDefaultValue}
            disabled={disabled}
            ref={viewRef}
            title={viewTitle}
          >
            {viewOptions.map((view) => (
              <option key={view} value={view}>
                {analysisFieldViewLabel(view)}
              </option>
            ))}
          </select>
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
          <select
            aria-label={`${labelPrefix} color source`}
            className="fm-inspector-select"
            disabled={disabled}
            value={settings.colorSource}
            onChange={(event) => settings.setColorSource(event.target.value)}
          >
            {SURFACE_COLOR_SOURCE_ITEMS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
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
            <input
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
            <select
              aria-label={`${labelPrefix} colormap`}
              className="fm-inspector-select"
              disabled={disabled}
              value={settings.colormap}
              onChange={(event) => settings.setColormap(event.target.value)}
            >
              {SCALAR_COLOR_PALETTE_ITEMS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
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
        label="Vector budget"
        value={
          <input
            aria-label={`${labelPrefix} vector budget`}
            className="fm-inspector-input"
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
          <select
            aria-label={`${labelPrefix} vector scope`}
            className="fm-inspector-select"
            disabled={disabled}
            value={settings.geometryScope}
            onChange={(event) => settings.setGeometryScope(event.target.value)}
          >
            {MODE_GEOMETRY_SCOPE_ITEMS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        }
      />
    </>
  );
}

export function normalizeAnalysisFieldView(
  value: string | null | undefined,
): string {
  if (value === "amplitude" || value === "complex") return "abs";
  if (value && ANALYSIS_FIELD_VIEW_OPTIONS.includes(value as never)) {
    return value;
  }
  return DEFAULT_ANALYSIS_FIELD_VIEW;
}

export function analysisFieldViewLabel(value: string): string {
  if (value === "real") return "Real";
  if (value === "imag") return "Imag";
  if (value === "abs") return "Complex (abs)";
  if (value === "phase") return "Phase";
  return "Phase-rotated real";
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
