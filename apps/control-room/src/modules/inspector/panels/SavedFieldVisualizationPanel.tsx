"use client";

import { useKernel } from "@/kernel/KernelContext";
import type { MaterializedDatasetResource } from "@/kernel/api/apiTypes";
import { quantityDisplayName } from "@/kernel/api/quantityIds";
import { resolveSavedFieldViewportMetadataEligibility } from "@/kernel/resources/savedFieldViewportResources";
import { useMaterializedDatasetResource } from "@/kernel/resources/solutionSetResources";
import { selectionRefEquals, type PinnedMaterializedDatasetSelectionRef } from "@/kernel/selection/selectionTypes";
import { useObjectVisualizationController, useSavedFieldPresentation } from "@/kernel/visualization/useObjectVisualization";
import type { SavedFieldPresentation, VisualizationColorMode, VisualizationTargetPatch } from "@/kernel/visualization/ObjectVisualizationController";
import { Button } from "@/shared/ui/Button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/Select";
import { VisualizationInspectorOverview } from "./ObjectVisualizationOverview";
import { NumberField } from "./ObjectVisualizationTargetSection";
import { ViewportCameraControls } from "../visualization/ViewportCameraControls";
import { InspectorGroup } from "../primitives/InspectorGroup";
import { InspectorPropertyRow } from "../primitives/InspectorPropertyRow";
import { FieldRow } from "../primitives/FieldRow";
import { FeedbackBanner } from "../primitives/FeedbackBanner";
import { VisualizationDisplayPassesControl } from "../visualization/VisualizationInspectorControls";
import { materializedDatasetSelectionMatches, returnToCurrentFieldView } from "@/kernel/visualization/savedFieldPresentation";
import { SCALAR_COLOR_PALETTE_ITEMS } from "./ObjectVisualizationPanelModel";
import { AntennaColorRangeControl } from "./antenna/AntennaColorRangeControl";

/** Metadata only here; the viewport owns bounded geometry/support/value loading. */
export function SavedFieldVisualizationInspector() {
  const { presentation, projectMatches } = useSavedFieldPresentation();
  const ref = presentation?.selection;
  const resource = useMaterializedDatasetResource(ref?.projectId, ref?.runId, ref?.solutionSetId,
    ref?.containingRevision, ref?.memberId, ref?.artifactId, { enabled: projectMatches });
  if (!presentation) return null;
  const data = resource.data && materializedDatasetSelectionMatches(presentation.selection, resource.data)
    ? resource.data : null;
  const error = !projectMatches ? "Open the project that owns this saved field."
    : resource.error?.message
      ?? ((resource.data || resource.status === "ready") && !data ? "Saved field identity does not match the pinned result." : null);
  return <SavedFieldVisualizationPanel presentation={presentation} dataset={data} error={error}
    refreshWarning={data ? resource.refreshError?.message ?? null : null} />;
}

export function SavedFieldVisualizationPanel({ presentation, dataset, error = null, refreshWarning = null }: {
  presentation: SavedFieldPresentation;
  dataset: MaterializedDatasetResource | null;
  error?: string | null;
  refreshWarning?: string | null;
}) {
  const { selection } = useKernel();
  const controller = useObjectVisualizationController();
  const ref = presentation.selection;
  const settings = presentation.settings;
  const patch = (value: VisualizationTargetPatch) => controller.patchSavedFieldPresentation(ref, value);
  const eligibility = resolveSavedFieldViewportMetadataEligibility(dataset);
  const vector = dataset?.field.coverage.component_count === "3";
  const scalar = dataset?.field.coverage.component_count === "1";
  const admissionError = error ?? (dataset && eligibility.status === "unavailable" ? eligibility.reason : null)
    ?? (dataset && dataset.dataset.status.availability !== "ready"
      ? `Saved field availability: ${dataset.dataset.status.availability}. Field values cannot be displayed yet.` : null);
  const ready = dataset !== null && admissionError === null && eligibility.status === "ready" && dataset.dataset.status.availability === "ready";
  const colorItems = [
    { value: "magnitude", label: vector ? "Magnitude" : scalar ? "Scalar value" : "Field value" },
    ...(vector ? [
      { value: "x", label: "X component" }, { value: "y", label: "Y component" },
      { value: "z", label: "Z component" }, { value: "orientation", label: "Direction" },
    ] : []),
  ];
  const rangeComponents = scalar ? ["magnitude" as const] : vector
    ? [...new Set([settings.shaderColorMode, settings.vectorColorMode])].filter(
      (mode): mode is "magnitude" | "x" | "y" | "z" => ["magnitude", "x", "y", "z"].includes(mode))
    : [];
  const quantitySource = dataset
    ? `${quantityDisplayName(dataset.field.descriptor.quantity_id)} · ${dataset.field.descriptor.unit}`
    : `${quantityDisplayName(settings.activeQuantityId)} · verifying saved field…`;
  const arrowLimit = ready ? Math.min(2048, Number(dataset.field.coverage.total_elements)) : 0;
  const context = <InspectorGroup title="Saved sampling domain" collapsible defaultOpen>
      <FieldRow label="Quantity source" value={quantitySource} />
      <FieldRow label="Metadata status" value={admissionError ? "Unavailable" : ready
        ? refreshWarning ? "Last verified · refresh failed" : "Verified" : "Verifying saved field…"} />
      <FieldRow label="Representation" value={dataset?.field.descriptor.value_representation === "physical_field"
        ? "Physical field · values as stored" : dataset?.field.descriptor.value_representation ?? "Verifying saved field…"} />
      <FieldRow label="Samples / components" value={dataset ? `${dataset.field.coverage.total_elements} / ${dataset.field.coverage.component_count}` : "Unavailable"} />
      <FieldRow label="Sampling" value="Own saved mesh and active support" />
      <p className="fm-inspection-source-guidance" role="note">This view uses the selected result’s sampling domain, which may cover only part of space. It does not replace or extend the editable Universe. Missing samples are not zero field.</p>
      {admissionError ? <FeedbackBanner kind="error" message={admissionError} /> : ready && refreshWarning
        ? <FeedbackBanner kind="warning" message={`Metadata refresh failed: ${refreshWarning}. Keeping the last verified metadata for this saved result.`} /> : null}
      <Button size="sm" variant="secondary" onClick={() => returnToCurrentFieldView(controller, selection, "inspector")}>Return to current view</Button>
    </InspectorGroup>;
  const display = <>
      <VisualizationDisplayPassesControl items={[
        { id: "visible", label: "Visible", pressed: settings.visible, disabled: !ready, onToggle: () => patch({ visible: !settings.visible }) },
        { id: "surface", label: "Surface", pressed: settings.shaderVisible, disabled: !ready, onToggle: () => patch({ shaderVisible: !settings.shaderVisible }) },
        { id: "wireframe", label: "Wireframe", pressed: settings.wireframeVisible, disabled: !ready, onToggle: () => patch({ wireframeVisible: !settings.wireframeVisible }) },
        { id: "vectors", label: "Vectors", pressed: vector && settings.vectorsVisible, disabled: !ready || !vector, onToggle: () => patch({ vectorsVisible: !settings.vectorsVisible }) },
        { id: "legend", label: "Legend", pressed: settings.viewportColorbarVisible, disabled: !ready, onToggle: () => patch({ viewportColorbarVisible: !settings.viewportColorbarVisible }) },
      ]} />
      {scalar ? <p role="note">This quantity is scalar and has no vector arrows.</p> : null}
      <p role="note">Display settings are local to this saved result. They do not start a solve. The viewport also verifies its saved geometry and active support before drawing.</p>
      <NumberField label="Wireframe opacity" value={settings.wireframeOpacityPercent} min={0} max={100} step={1} unit="%" disabled={!ready} onChange={value => patch({ wireframeOpacityPercent: value })} />
    </>;
  const surfaceColoring = <InspectorGroup title="Field colors" collapsible defaultOpen>
      <FieldRow label="Color range" value="Automatic per component · active samples only, or manual SI limits" />
      <InspectorPropertyRow label="Surface coloring" layout="stacked">
        <Select value={vector ? settings.shaderColorMode : "magnitude"} disabled={!ready} onValueChange={value => patch({ shaderColorMode: value as VisualizationColorMode })}>
          <SelectTrigger aria-label="Saved surface coloring"><SelectValue /></SelectTrigger>
          <SelectContent>{colorItems.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
        </Select>
      </InspectorPropertyRow>
      {vector ? <InspectorPropertyRow label="Vector coloring" layout="stacked">
        <Select value={settings.vectorColorMode} disabled={!ready} onValueChange={value => patch({ vectorColorMode: value as VisualizationColorMode })}>
          <SelectTrigger aria-label="Saved vector coloring"><SelectValue /></SelectTrigger>
          <SelectContent>{colorItems.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
        </Select>
      </InspectorPropertyRow> : null}
      <InspectorPropertyRow label="Palette" layout="stacked">
        <Select value={settings.scalarColorPalette} disabled={!ready} onValueChange={value => patch({ scalarColorPalette: value })}>
          <SelectTrigger aria-label="Saved field palette"><SelectValue /></SelectTrigger>
          <SelectContent>{SCALAR_COLOR_PALETTE_ITEMS.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
        </Select>
      </InspectorPropertyRow>
      {rangeComponents.map(component => <InspectorGroup key={component}
        title={`${scalar ? "Scalar value" : component === "magnitude" ? "Magnitude" : component.toUpperCase()} color range (SI)`} collapsible defaultOpen>
        <AntennaColorRangeControl context={JSON.stringify([ref, component])}
          range={presentation.colorRanges?.[component]} unit={dataset?.field.descriptor.unit ?? "SI"}
          disabled={!ready} scopeDescription={scalar ? "One scale for this scalar field" : "One scale for this component on surfaces and vectors"}
          onApply={range => controller.setSavedFieldColorRange(ref, component, range)} />
      </InspectorGroup>)}
      <NumberField label="Surface opacity" value={settings.surfaceOpacityPercent} min={0} max={100} step={1} unit="%" disabled={!ready} onChange={value => patch({ surfaceOpacityPercent: value })} />
    </InspectorGroup>;
  const vectors = vector ? <InspectorGroup title="Vector arrows" collapsible defaultOpen>
      <FieldRow label="Placement" value="Active samples throughout the saved domain" />
      <NumberField label="Arrow budget" value={Math.min(arrowLimit, settings.vectorBudget)} min={0} max={arrowLimit} step={1} disabled={!ready} onChange={value => patch({ vectorBudget: value })} />
      <NumberField label="Arrow length" value={settings.vectorLengthScale} min={0.1} max={5} step={0.1} unit="×" disabled={!ready} onChange={value => patch({ vectorLengthScale: value })} />
      <NumberField label="Arrow opacity" value={settings.vectorAlphaPercent} min={0} max={100} step={1} unit="%" disabled={!ready} onChange={value => patch({ vectorAlphaPercent: value })} />
      <NumberField label="Arrow thickness" value={settings.vectorThickness} min={0.1} max={8} step={0.1} disabled={!ready} onChange={value => patch({ vectorThickness: value })} />
      <p role="note">The renderer also limits arrows to active samples and its scene budget. Arrow size represents display gain, not a new field value.</p>
    </InspectorGroup> : null;
  const advanced = <>
    <p role="note">Only active saved samples contain values. Clipping controls for this saved carrier are not qualified in this panel. To select another quantity, choose its saved result in Results.</p>
    <InspectorGroup title="Result identity" collapsible defaultOpen={false}>
      <FieldRow label="Run" value={ref.runId} mono />
      <FieldRow label="Revision" value={ref.containingRevision} mono />
      <FieldRow label="Carrier" value={dataset?.field.descriptor.carrier_id ?? "Unavailable"} mono />
      <FieldRow label="Manifest" value={ref.manifestObjectRef} mono />
    </InspectorGroup>
  </>;
  return <div className="fm-saved-field-visualization" data-saved-field-visualization={ref.nodeId}>
    <VisualizationInspectorOverview
      key={ref.nodeId}
      context={context}
      display={display}
      surfaceColoring={surfaceColoring}
      vectors={vectors}
      camera={<ViewportCameraControls />}
      advanced={advanced}
      quantitySource={quantitySource}
      dataState={admissionError ? "Unavailable" : ready
        ? refreshWarning ? "Last verified metadata · refresh failed" : "Metadata verified" : "Loading metadata"}
      meshState="Checked when displayed"
      meshStateLabel="Saved mesh"
      enabledPassCount={ready && settings.visible
        ? Number(settings.shaderVisible) + Number(settings.wireframeVisible) + Number(vector && settings.vectorsVisible) : 0}
    />
  </div>;
}

export function savedFieldPresentationForDataset(presentation: SavedFieldPresentation | null, ref: PinnedMaterializedDatasetSelectionRef): SavedFieldPresentation | null {
  return presentation && selectionRefEquals(presentation.selection, ref) ? presentation : null;
}
