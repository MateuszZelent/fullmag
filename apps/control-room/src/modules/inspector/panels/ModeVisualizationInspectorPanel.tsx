"use client";

import { useEffect, useMemo, useRef } from "react";

import { createCommandContext } from "@/kernel/commands/commandContext";
import type { FrequencyDomainFieldResource } from "@/kernel/api/apiTypes";
import { useKernel } from "@/kernel/KernelContext";
import type { SelectionRef } from "@/kernel/selection/selectionTypes";
import type { KernelApi } from "@/kernel/types";

import type { InspectorPanelProps } from "../inspectorTypes";
import { InspectorGroup } from "../primitives/InspectorGroup";
import {
  VisualizationContextSwitch,
  useVisualizationViewContext,
} from "../visualization/VisualizationContextSwitch";
import { PlanarVisualizationSection } from "../visualization/PlanarVisualizationSection";
import {
  ANALYSIS_FIELD_VIEW_OPTIONS,
  DEFAULT_ANALYSIS_FIELD_VIEW,
  FrequencyDomainModeDisplayControls,
  normalizeAnalysisFieldView,
  useFrequencyDomainModeDisplaySettings,
} from "./FrequencyDomainModeDisplayControls";

type ModeVisualizationSelectionRef = Extract<
  SelectionRef,
  { type: "mode-visualization" }
>;

function modeVisualizationRef(
  selection: InspectorPanelProps["selection"],
): ModeVisualizationSelectionRef | null {
  return selection.ref?.type === "mode-visualization" ? selection.ref : null;
}

function modeVisualizationCommandId(
  target: Pick<ModeVisualizationSelectionRef, "source">,
): string {
  return target.source === "eigen-mode"
    ? "analysis.eigen.plot-mode-3d"
    : "analysis.frequency-response.plot-response-field-3d";
}

function modeVisualizationIndexLabel(target: ModeVisualizationSelectionRef): string {
  if (target.source === "frequency-response" && target.frequencyIndex !== undefined) {
    return `frequency ${target.frequencyIndex}`;
  }
  if (target.sampleIndex !== undefined && target.modeIndex !== undefined) {
    return `sample ${target.sampleIndex}, mode ${target.modeIndex}`;
  }
  return "field";
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function integerLabel(value: unknown): string {
  const number = finiteNumber(value);
  return number == null ? "not published" : number.toLocaleString("en-US");
}

function listLabel(value: unknown): string {
  return Array.isArray(value) && value.length > 0
    ? value.map((entry) => String(entry)).join(", ")
    : "not published";
}

function numberListLabel(value: unknown): string {
  return Array.isArray(value) && value.length > 0
    ? value.map((entry) => String(entry)).join(" x ")
    : "not published";
}

function inferNodeCount(meta: FrequencyDomainFieldResource | null): number | null {
  if (!meta) return null;
  const componentCount = finiteNumber(meta.component_count);
  if (!componentCount || componentCount <= 0) return null;
  const complexPairCount = finiteNumber(meta.complex_pair_count);
  if (complexPairCount != null) {
    return Math.trunc(complexPairCount / componentCount);
  }
  const payloadValueCount = finiteNumber(meta.payload_value_count);
  if (payloadValueCount != null) {
    return Math.trunc(payloadValueCount / (2 * componentCount));
  }
  return null;
}

function statsRecord(meta: FrequencyDomainFieldResource | null) {
  const metaRecord = record(meta);
  return (
    record(metaRecord?.stats) ??
    record(metaRecord?.value_stats) ??
    record(metaRecord?.scalar_stats) ??
    record(metaRecord?.magnitude_stats)
  );
}

function statLabel(meta: FrequencyDomainFieldResource | null, key: string): string {
  const value = finiteNumber(statsRecord(meta)?.[key]);
  return value == null ? "not published" : value.toExponential(6);
}

export interface ModeFieldDiagnosticRow {
  label: string;
  value: string;
}

export function buildModeFieldDiagnosticRows({
  meta,
  metaStatus,
  target,
}: {
  meta: FrequencyDomainFieldResource | null;
  metaStatus: string;
  target: Pick<
    ModeVisualizationSelectionRef,
    "fieldId" | "source"
  >;
}): ModeFieldDiagnosticRow[] {
  const nodeCount = inferNodeCount(meta);
  return [
    { label: "Meta status", value: metaStatus },
    { label: "Requested field", value: target.fieldId },
    { label: "Published field", value: meta?.field_id ?? "not published" },
    { label: "Resource key", value: meta?.resource_key ?? "not published" },
    { label: "Artifact path", value: meta?.artifact_path ?? "not published" },
    { label: "Source family", value: meta?.source_family ?? target.source },
    { label: "Quantity", value: meta?.quantity ?? "not published" },
    { label: "Field status", value: meta?.status ?? "not published" },
    { label: "Value kind", value: meta?.value_kind ?? "not published" },
    { label: "Component basis", value: meta?.component_basis ?? "not published" },
    { label: "Components", value: listLabel(meta?.components) },
    { label: "Component count", value: integerLabel(meta?.component_count) },
    {
      label: "Inferred nodes",
      value: nodeCount == null ? "not published" : nodeCount.toLocaleString("en-US"),
    },
    { label: "Complex pairs", value: integerLabel(meta?.complex_pair_count) },
    { label: "Payload values", value: integerLabel(meta?.payload_value_count) },
    { label: "Payload encoding", value: meta?.payload_encoding ?? "not published" },
    { label: "Binary layout", value: meta?.binary_layout ?? "not published" },
    { label: "Storage format", value: meta?.storage_format ?? "not published" },
    { label: "Default view", value: meta?.default_view ?? "not published" },
    {
      label: "Default phase",
      value:
        finiteNumber(meta?.default_phase_rad) == null
          ? "not published"
          : `${finiteNumber(meta?.default_phase_rad)} rad`,
    },
    { label: "Available views", value: listLabel(meta?.available_views) },
    { label: "Min", value: statLabel(meta, "min") },
    { label: "Max", value: statLabel(meta, "max") },
    { label: "Mean", value: statLabel(meta, "mean") },
    { label: "RMS", value: statLabel(meta, "rms") },
    { label: "Zarr store", value: meta?.zarr_store_path ?? "not published" },
    { label: "Zarr array", value: meta?.zarr_array_path ?? "not published" },
    { label: "Zarr dtype", value: meta?.zarr_dtype ?? "not published" },
    { label: "Zarr shape", value: numberListLabel(meta?.zarr_shape) },
    { label: "Zarr chunk", value: numberListLabel(meta?.zarr_chunk_shape) },
    {
      label: "Tangent payload",
      value: meta?.tangent_field_payload_path ?? "not published",
    },
    {
      label: "Tangent kind",
      value: meta?.tangent_value_kind ?? "not published",
    },
    {
      label: "Tangent basis",
      value: meta?.tangent_component_basis ?? "not published",
    },
    {
      label: "Tangent components",
      value: listLabel(meta?.tangent_components),
    },
    { label: "Tangent count", value: integerLabel(meta?.tangent_component_count) },
    { label: "Tangent pairs", value: integerLabel(meta?.tangent_complex_pair_count) },
    { label: "Tangent values", value: integerLabel(meta?.tangent_payload_value_count) },
  ];
}

export function executeModeVisualizationActivation({
  kernel,
  label,
  sourceDetail,
  target,
  view,
}: {
  kernel: KernelApi;
  label: string;
  sourceDetail: string;
  target: Pick<ModeVisualizationSelectionRef, "fieldId" | "source">;
  view: string;
}) {
  return kernel.commands.execute(
    modeVisualizationCommandId(target),
    createCommandContext("inspector", kernel, { sourceDetail }),
    {
      fieldId: target.fieldId,
      label,
      phaseRad: 0,
      source: target.source,
      view,
    },
  );
}

export function ModeVisualizationViewControls({ selection }: InspectorPanelProps) {
  const visualizationViewContext = useVisualizationViewContext();
  const target = modeVisualizationRef(selection);
  const kernel = useKernel();
  const sourceDetail = useMemo(
    () =>
      target
        ? `Model object mode visualization ${target.objectId} ${modeVisualizationIndexLabel(target)}`
        : "Model object mode visualization",
    [target],
  );
  const settings = useFrequencyDomainModeDisplaySettings({
    activation: target
      ? {
          commandId: modeVisualizationCommandId(target),
          fieldId: target.fieldId,
          label: selection.label ?? modeVisualizationIndexLabel(target),
          source: target.source,
        }
      : undefined,
    sourceDetail,
  });
  const requestedView = normalizeAnalysisFieldView(
    target?.view ?? settings.activeAnalysisFieldOverlay?.query.view,
  );
  const activationKey = target
    ? `${target.objectId}:${target.source}:${target.fieldId}:${requestedView}`
    : null;
  const lastActivationKey = useRef<string | null>(null);

  useEffect(() => {
    if (visualizationViewContext === "planar") return;
    if (!target || !activationKey) return;
    const overlay = settings.activeAnalysisFieldOverlay;
    if (
      overlay?.fieldId === target.fieldId &&
      overlay.source === target.source &&
      normalizeAnalysisFieldView(overlay.query.view) === requestedView
    ) {
      return;
    }
    if (lastActivationKey.current === activationKey) return;
    lastActivationKey.current = activationKey;
    void executeModeVisualizationActivation({
      kernel,
      label: selection.label ?? modeVisualizationIndexLabel(target),
      sourceDetail,
      target,
      view: requestedView,
    });
  }, [
    activationKey,
    kernel,
    target,
    requestedView,
    selection.label,
    settings.activeAnalysisFieldOverlay,
    sourceDetail,
    visualizationViewContext,
  ]);

  if (!target) {
    return (
      <InspectorGroup title="Mode Visualization">
        <p className="fm-inspector-empty">No mode visualization target selected.</p>
      </InspectorGroup>
    );
  }

  if (visualizationViewContext === "planar") {
    return (
      <div className="fm-inspector-panel">
        <InspectorGroup title="View">
          <VisualizationContextSwitch />
        </InspectorGroup>
        <PlanarVisualizationSection selection={selection} />
      </div>
    );
  }

  return (
    <>
      <InspectorGroup title="View">
        <VisualizationContextSwitch />
      </InspectorGroup>
      <InspectorGroup title="Render controls">
        <FrequencyDomainModeDisplayControls
          disabled={false}
          labelPrefix="Mode visualization"
          settings={settings}
          viewDefaultValue={target.view ?? DEFAULT_ANALYSIS_FIELD_VIEW}
          viewOptions={ANALYSIS_FIELD_VIEW_OPTIONS}
        />
      </InspectorGroup>
    </>
  );
}

export function ModeVisualizationInspectorPanel(props: InspectorPanelProps) {
  return <ModeVisualizationViewControls {...props} />;
}
