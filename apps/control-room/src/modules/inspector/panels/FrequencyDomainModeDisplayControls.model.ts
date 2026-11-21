import { type AnalysisFieldOverlaySource, type AnalysisFieldOverlayState } from "@/kernel/visualization/AnalysisFieldOverlayController";
import type { SurfaceColorSource, VisualizationGeometryScope } from "@/kernel/visualization/ObjectVisualizationController";
import type { ModeFieldComponentOption } from "./frequency-domain/FrequencyDomainHelpers";

export const DEFAULT_ANALYSIS_FIELD_VIEW = "phase_rotated_real";

export const ANALYSIS_FIELD_VIEW_OPTIONS = [
  DEFAULT_ANALYSIS_FIELD_VIEW,
  "real",
  "imag",
  "abs",
  "phase",
] as const;

export type ModeFieldComponent =
  | "magnitude"
  | "component_x"
  | "component_y"
  | "component_z";

export const MODE_FIELD_COMPONENT_ITEMS: ModeFieldComponentOption[] = [
  { label: "|delta m|", value: "magnitude" },
  { label: "delta m_x", value: "component_x" },
  { label: "delta m_y", value: "component_y" },
  { label: "delta m_z", value: "component_z" },
];

export interface FrequencyDomainModeAppearanceCommandInput {
  colorRangeMax: number;
  colorRangeMin: number;
  colorRangeMode: "auto" | "manual" | "symmetric";
  colorSource: SurfaceColorSource;
  colormap: string;
  geometryScope: VisualizationGeometryScope;
  displayGain: number;
  shaderVisible: boolean;
  solidColor: string;
  vectorBudget: number;
  vectorScale: number;
  vectorsVisible: boolean;
}

export interface FrequencyDomainModeDisplaySettings {
  activeAnalysisFieldOverlay: AnalysisFieldOverlayState | null;
  appearanceCommandInput: () => FrequencyDomainModeAppearanceCommandInput;
  colorSource: SurfaceColorSource;
  colorRangeMax: number;
  colorRangeMin: number;
  colorRangeMode: "auto" | "manual" | "symmetric";
  colormap: string;
  component: ModeFieldComponent;
  geometryScope: VisualizationGeometryScope;
  displayGain: number;
  setColorSource: (value: string) => void;
  setColorRangeMax: (value: string) => void;
  setColorRangeMin: (value: string) => void;
  setColorRangeMode: (value: string) => void;
  setDisplayGain: (value: string) => void;
  setColormap: (value: string) => void;
  setComponent: (value: string) => void;
  setGeometryScope: (value: string) => void;
  setShaderVisible: (value: boolean) => void;
  setSolidColor: (value: string) => void;
  setVectorBudget: (value: string) => void;
  setVectorScale: (value: string) => void;
  setVectorsVisible: (value: boolean) => void;
  setView: (value: string) => void;
  shaderVisible: boolean;
  solidColor: string;
  vectorBudget: number;
  vectorScale: number;
  vectorsVisible: boolean;
  view: string;
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

export function isActiveAnalysisFieldView(
  settings: FrequencyDomainModeDisplaySettings,
  fieldId: string | null | undefined,
  source: AnalysisFieldOverlaySource,
  view: string,
): boolean {
  const overlay = settings.activeAnalysisFieldOverlay;
  return Boolean(
    fieldId &&
      overlay?.fieldId === fieldId &&
      overlay.source === source &&
      normalizeAnalysisFieldView(overlay.query.view) ===
        normalizeAnalysisFieldView(view),
  );
}
