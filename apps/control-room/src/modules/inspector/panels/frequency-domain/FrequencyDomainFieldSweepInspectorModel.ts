import {
  formatFieldSweepSampleLabel,
  type NavigatorFieldSweepPayload,
} from "@/modules/results-navigator/public";

export interface FrequencyDomainFieldSweepInspectorModel {
  axis: string;
  branchTracking: string;
  completedSamples: string;
  conversions: string;
  datasetRevision: string;
  fieldAvailability: string;
  requestedSamples: string;
  selectedCoordinates: string;
  selectedSample: string;
  sampleStatus: string;
  sourceRevision: string;
  topology: string;
  units: string;
}

function published(value: string | number | null | undefined): string {
  return value == null || String(value).trim().length === 0
    ? "not published"
    : String(value);
}

function coordinateVector(value: readonly [number, number, number] | null): string {
  return value == null
    ? "not published"
    : `[${value.map((component) => String(component)).join(", ")}]`;
}

export function buildFrequencyDomainFieldSweepInspectorModel(
  payload: NavigatorFieldSweepPayload,
  selectedSampleId?: string | null,
): FrequencyDomainFieldSweepInspectorModel {
  const selectedSample =
    payload.samples.find((sample) => sample.sampleId === selectedSampleId)
    ?? payload.samples[0]
    ?? null;
  const totalModes = selectedSample
    ? selectedSample.fieldModeCount
    : payload.samples.reduce((total, sample) => total + sample.fieldModeCount, 0);
  const availableModes = selectedSample
    ? selectedSample.fieldAvailableCount
    : payload.samples.reduce((total, sample) => total + sample.fieldAvailableCount, 0);
  const axis = payload.axis
    ? `${payload.axis.kind} / ${payload.axis.coordinate} [${payload.axis.unit}]`
    : "not published";
  const conversions = payload.axis?.displayConversions
    .map((conversion) => `${conversion.name} [${conversion.unit}]`)
    .join(", ") || "not published";
  const selectedLabel = selectedSample
    ? selectedSample.label ?? formatFieldSweepSampleLabel(selectedSample)
    : "not selected";
  const selectedCoordinates = selectedSample
    ? [
        selectedSample.biasFieldAPerM
          ? `H=${coordinateVector(selectedSample.biasFieldAPerM)} ${payload.units?.biasField ?? "A/m"}`
          : null,
        selectedSample.biasFieldMu0T
          ? `μ₀H=${coordinateVector(selectedSample.biasFieldMu0T)} T`
          : null,
      ].filter((value): value is string => value != null).join("; ") || "not published"
    : "not selected";
  const topology = selectedSample?.topology ?? payload.topology;
  const units = payload.units
    ? `H: ${payload.units.biasField} → ${payload.units.biasFieldDisplay}; f: ${payload.units.frequency}; ω: ${payload.units.angularFrequency}`
    : "not published";

  return {
    axis,
    branchTracking: selectedSample?.branchIds.join(", ") || "not published",
    completedSamples: published(payload.completedSampleCount),
    conversions,
    datasetRevision: published(payload.datasetRevision),
    fieldAvailability: `${availableModes}/${totalModes} available`,
    requestedSamples: published(payload.requestedSampleCount),
    selectedCoordinates,
    selectedSample: selectedSample
      ? `${selectedLabel} (${selectedSample.sampleId})`
      : "not selected",
    sampleStatus: selectedSample?.status ?? "not published",
    sourceRevision: published(payload.sourceRevision),
    topology: topology
      ? `${topology.meshId} / ${topology.topologyRevision} / ${topology.indexing}`
      : "not published",
    units,
  };
}
