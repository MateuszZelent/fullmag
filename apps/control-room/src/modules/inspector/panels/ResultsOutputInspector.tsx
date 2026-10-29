"use client";

import { useState } from "react";

import type {
  ResultsArray,
  ResultsEntry,
  ResultsFilePreview,
} from "@/kernel/api/resultsBrowser";
import type {
  SnapshotVisualizationAppearance,
  SnapshotVisualizationAppearancePatch,
  SnapshotVisualizationComponent,
  SnapshotVisualizationRangeMode,
} from "@/kernel/visualization/SnapshotVisualizationController";
import { formatResultsSampleOrdinal } from "@/kernel/results-browser/resultsSampleLabels";
import { formatTooltipValue } from "@/shared/analysis-charts/scientificChartFormatting";
import { Button } from "@/shared/ui/Button";
import { Input } from "@/shared/ui/Input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/Select";
import { Switch } from "@/shared/ui/Switch";

import { FieldRow } from "../primitives/FieldRow";
import { InspectorGroup } from "../primitives/InspectorGroup";

const COMPONENTS: readonly SnapshotVisualizationComponent[] = ["x", "y", "z", "magnitude"];
const RANGE_MODES: readonly SnapshotVisualizationRangeMode[] = ["auto", "manual", "symmetric"];
const MAX_VALUE_PREVIEW = 24;

export interface ResultsOutputInspectorProps {
  entry: ResultsEntry | null;
  array: ResultsArray | null;
  status: string;
  error: unknown;
  sampleIndex: number;
  onSampleIndexChange: (sampleIndex: number) => void;
  onLoadTo3D: () => void;
  onReturnToLive: () => void;
  canReturnToLive: boolean;
  returnActionLabel: "Close results" | "Return to live";
  appearance: SnapshotVisualizationAppearance;
  onAppearanceChange: (patch: SnapshotVisualizationAppearancePatch) => void;
  values: Float64Array | null;
  valuesAvailable: boolean;
  valuesEnabled: boolean;
  valuesError: unknown;
  valuesStatus: string;
  onValuesOpenChange: (open: boolean) => void;
  filePreview: ResultsFilePreview | null;
}

interface LimitDraft {
  baseMax: number | null;
  baseMin: number | null;
  maxText: string;
  minText: string;
}

function errorMessage(error: unknown): string | null {
  if (typeof error === "string" && error.trim().length > 0) return error;
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" && message.trim().length > 0 ? message : null;
  }
  return null;
}

function formatNumber(value: number): string {
  return Number.isFinite(value)
    ? formatTooltipValue(value, "")
    : "Unavailable";
}

export function clampResultsSampleIndex(sampleIndex: number, sampleCount: number): number {
  const last = Math.max(0, Math.floor(sampleCount) - 1);
  return Math.min(last, Math.max(0, Math.floor(Number.isFinite(sampleIndex) ? sampleIndex : 0)));
}

export function formatResultsSampleCoordinate(
  coordinate: ResultsArray["coordinates"][number] | undefined,
  sampleIndex: number,
  sampleCount?: number,
): string {
  const fallback = sampleCount === undefined
    ? `Sample index ${sampleIndex}`
    : formatResultsSampleOrdinal(sampleIndex, sampleCount);
  if (!coordinate) return fallback;
  if (coordinate.kind === "accepted_step" && coordinate.accepted_step) return `Accepted step: ${coordinate.accepted_step}`;
  if (typeof coordinate.value !== "number" || !Number.isFinite(coordinate.value)) return fallback;
  if (coordinate.kind === "physical_time") return `Physical time: ${formatNumber(coordinate.value * 1e9)} ns`;
  return `Accepted step: ${formatNumber(coordinate.value)}`;
}

function formatShape(shape: readonly number[]): string {
  return shape.length > 0 ? shape.join(" × ") : "—";
}

function formatCoordinateValue(
  array: ResultsArray,
  sampleIndex: number,
): string {
  return formatResultsSampleCoordinate(
    array.coordinates.find((coordinate) => coordinate.sample_index === sampleIndex),
    sampleIndex,
    Number.isFinite(array.sample_count)
      ? Math.max(0, Math.floor(array.sample_count))
      : array.coordinates.length,
  );
}

function formatAppearanceNumber(value: number | null): string {
  return value === null ? "" : String(value);
}

function kindLabel(entry: ResultsEntry): string {
  return entry.kind === "zarr_array"
    ? "Zarr array"
    : entry.kind === "zarr_group"
      ? "Zarr group"
      : entry.kind[0].toUpperCase() + entry.kind.slice(1);
}

function statusLabel(status: string | null | undefined): string {
  const normalized = status?.trim().toLocaleLowerCase();
  if (!normalized || normalized === "ready") return "Ready";
  if (normalized === "metadata_only") return "Metadata only";
  if (normalized === "unsupported") return "Unsupported";
  if (normalized === "unreadable") return "Unreadable";
  return normalized.replaceAll("_", " ");
}

function ValuePreview({
  columns,
  enabled,
  error,
  onOpenChange,
  status,
  values,
  valuesAvailable,
}: {
  columns?: string[];
  enabled: boolean;
  error: unknown;
  onOpenChange: (open: boolean) => void;
  status: string;
  values: Float64Array | null;
  valuesAvailable: boolean;
}) {
  const preview = values
    ? Array.from(values.subarray(0, MAX_VALUE_PREVIEW))
    : [];
  const errorText = errorMessage(error);
  const valueColumns = values && columns?.length === values.length ? columns : null;
  return (
    <InspectorGroup title="Decoded values" collapsible defaultOpen={false} onOpenChange={onOpenChange}>
      {!valuesAvailable ? <p className="m-0 text-fm-xs text-fm-muted">Decoded values are unavailable for this array.</p> : null}
      {valuesAvailable && enabled && errorText ? <p className="m-0 text-fm-xs text-fm-danger" role="alert">{errorText}</p> : null}
      {valuesAvailable && enabled && !values && !errorText ? <p className="m-0 text-fm-xs text-fm-muted" role="status">{status === "ready" ? "The decoded value payload is empty." : "Loading decoded values…"}</p> : null}
      {values ? (
        <>
          <div className="grid min-w-0 gap-1 text-fm-xs">
            <FieldRow label="Value count" value={values.length} />
            <FieldRow label="Raw bytes" value={values.byteLength} unit="B" />
          </div>
          {preview.length > 0 ? (
            <ol className="m-0 grid min-w-0 gap-0.5 list-decimal pl-5 text-fm-xs text-fm-primary">
              {preview.map((value, index) => (
                <li key={index} className="break-all font-mono">{valueColumns?.[index] ? `${valueColumns[index]}: ` : ""}{formatNumber(value)}</li>
              ))}
            </ol>
          ) : (
            <p className="m-0 text-fm-xs text-fm-muted">The decoded value payload is empty.</p>
          )}
          {values.length > MAX_VALUE_PREVIEW ? (
            <p className="m-0 text-fm-xs text-fm-muted" role="note">Showing the first {MAX_VALUE_PREVIEW} values.</p>
          ) : null}
        </>
      ) : null}
    </InspectorGroup>
  );
}

function FilePreview({ preview }: { preview: ResultsFilePreview }) {
  return (
    <InspectorGroup title="File preview">
      <FieldRow label="Content type" value={preview.content_type} />
      <FieldRow label="Revision" value={preview.revision} mono />
      {preview.content_type === "application/octet-stream" ? <p className="m-0 text-fm-xs text-fm-muted">Binary output. Text preview is unavailable.</p> : <pre className="m-0 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-fm-control border border-fm-subtle bg-fm-canvas p-2 text-fm-xs text-fm-primary">{preview.text}</pre>}
      {preview.truncated ? (
        <p className="m-0 text-fm-xs text-fm-muted" role="note">Preview truncated by the results resource.</p>
      ) : null}
    </InspectorGroup>
  );
}

function VisualizationControls({
  appearance,
  array,
  onAppearanceChange,
}: {
  appearance: SnapshotVisualizationAppearance;
  array: ResultsArray | null;
  onAppearanceChange: (patch: SnapshotVisualizationAppearancePatch) => void;
}) {
  const [limitDraft, setLimitDraft] = useState<LimitDraft | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const limitsDisabled = array === null;
  const draftIsCurrent =
    limitDraft !== null &&
    limitDraft.baseMin === appearance.min &&
    limitDraft.baseMax === appearance.max;
  const minText = draftIsCurrent ? limitDraft.minText : formatAppearanceNumber(appearance.min);
  const maxText = draftIsCurrent ? limitDraft.maxText : formatAppearanceNumber(appearance.max);

  const updateDraft = (field: "minText" | "maxText", text: string) => {
    setLimitDraft({
      baseMin: appearance.min,
      baseMax: appearance.max,
      minText: field === "minText" ? text : minText,
      maxText: field === "maxText" ? text : maxText,
    });
    setValidationError(null);
  };

  const commitLimits = () => {
    const min = minText.trim() === "" ? null : Number(minText);
    const max = maxText.trim() === "" ? null : Number(maxText);
    if ((min !== null && !Number.isFinite(min)) || (max !== null && !Number.isFinite(max))) {
      setValidationError("Range limits must be finite values.");
      return;
    }
    if (appearance.rangeMode === "manual" && (min === null || max === null || min >= max)) {
      setValidationError("Manual range requires minimum < maximum.");
      return;
    }
    setValidationError(null);
    setLimitDraft(null);
    onAppearanceChange({ min, max });
  };

  return (
    <InspectorGroup title="Visualization" description="Appearance for this snapshot. Changes apply immediately when it is shown in 3D.">
      <div className="grid min-w-0 gap-2">
        {array?.component_count === 1 ? <FieldRow label="Component" value="scalar" /> : (
        <label className="grid min-w-0 gap-1 text-fm-xs text-fm-muted" htmlFor="fm-results-output-component">
          Component
          <Select
            value={appearance.component}
            onValueChange={(value) => {
              if (COMPONENTS.includes(value as SnapshotVisualizationComponent)) {
                onAppearanceChange({ component: value as SnapshotVisualizationComponent });
              }
            }}
          >
            <SelectTrigger id="fm-results-output-component" aria-label="Visualization component"><SelectValue /></SelectTrigger>
            <SelectContent>{COMPONENTS.map((component) => <SelectItem key={component} value={component}>{component}</SelectItem>)}</SelectContent>
          </Select>
        </label>
        )}
        <label className="grid min-w-0 gap-1 text-fm-xs text-fm-muted" htmlFor="fm-results-output-palette">
          Palette
          <Select
            value={appearance.palette === "viridis" ? "viridis" : "coolwarm"}
            onValueChange={(value) => {
              if (value === "coolwarm" || value === "viridis") onAppearanceChange({ palette: value });
            }}
          >
            <SelectTrigger id="fm-results-output-palette" aria-label="Visualization palette"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="coolwarm">coolwarm</SelectItem><SelectItem value="viridis">viridis</SelectItem></SelectContent>
          </Select>
        </label>
        <label className="flex min-w-0 items-center justify-between gap-2 text-fm-xs text-fm-primary" htmlFor="fm-results-output-visible">
          Visible
          <Switch id="fm-results-output-visible" aria-label="Show snapshot field" checked={appearance.visible} onCheckedChange={(visible) => onAppearanceChange({ visible })} />
        </label>
        <label className="grid min-w-0 gap-1 text-fm-xs text-fm-muted" htmlFor="fm-results-output-range-mode">
          Range mode
          <Select
            value={appearance.rangeMode}
            onValueChange={(value) => {
              if (RANGE_MODES.includes(value as SnapshotVisualizationRangeMode)) {
                if (value === "manual" && (appearance.min === null || appearance.max === null || appearance.min >= appearance.max)) {
                  setValidationError("Enter finite minimum and maximum values before selecting manual range.");
                  return;
                }
                setValidationError(null);
                onAppearanceChange({ rangeMode: value as SnapshotVisualizationRangeMode });
              }
            }}
          >
            <SelectTrigger id="fm-results-output-range-mode" aria-label="Visualization range mode" disabled={limitsDisabled}><SelectValue /></SelectTrigger>
            <SelectContent>{RANGE_MODES.map((mode) => <SelectItem key={mode} value={mode}>{mode}</SelectItem>)}</SelectContent>
          </Select>
        </label>
        <div className="grid min-w-0 grid-cols-2 gap-2">
          <label className="grid min-w-0 gap-1 text-fm-xs text-fm-muted" htmlFor="fm-results-output-range-min">
            Minimum
            <Input
              id="fm-results-output-range-min"
              aria-describedby="fm-results-output-range-help"
              disabled={limitsDisabled}
              inputMode="decimal"
              step="any"
              type="number"
              value={minText}
              onBlur={commitLimits}
              onChange={(event) => updateDraft("minText", event.currentTarget.value)}
            />
          </label>
          <label className="grid min-w-0 gap-1 text-fm-xs text-fm-muted" htmlFor="fm-results-output-range-max">
            Maximum
            <Input
              id="fm-results-output-range-max"
              aria-describedby="fm-results-output-range-help"
              disabled={limitsDisabled}
              inputMode="decimal"
              step="any"
              type="number"
              value={maxText}
              onBlur={commitLimits}
              onChange={(event) => updateDraft("maxText", event.currentTarget.value)}
            />
          </label>
        </div>
        <p className="m-0 text-fm-xs text-fm-muted" id="fm-results-output-range-help">Limits use the saved field values; blank limits remain automatic.</p>
        {validationError ? <p className="m-0 text-fm-xs text-fm-danger" role="alert">{validationError}</p> : null}
      </div>
    </InspectorGroup>
  );
}

export function ResultsOutputInspector({
  entry,
  array,
  status,
  error,
  sampleIndex,
  onSampleIndexChange,
  onLoadTo3D,
  onReturnToLive,
  canReturnToLive,
  returnActionLabel,
  appearance,
  onAppearanceChange,
  values,
  valuesAvailable,
  valuesEnabled,
  valuesError,
  valuesStatus,
  onValuesOpenChange,
  filePreview,
}: ResultsOutputInspectorProps) {
  if (!entry) {
    return (
      <section aria-label="Results output Inspector" className="fm-inspector-panel grid min-w-0 gap-3 p-3">
        <h2 className="m-0 text-fm-md font-semibold text-fm-primary">Results output</h2>
        <p className="m-0 text-fm-xs text-fm-muted" role="status">Select a saved output to inspect its metadata and samples.</p>
        {canReturnToLive ? <Button size="sm" type="button" variant="secondary" onClick={onReturnToLive}>{returnActionLabel}</Button> : null}
      </section>
    );
  }

  const errorText = errorMessage(error);
  const sampleCount = array && Number.isFinite(array.sample_count)
    ? Math.max(0, Math.floor(array.sample_count))
    : array?.coordinates.length ?? 0;
  const selectedSampleIndex = clampResultsSampleIndex(sampleIndex, sampleCount);
  const hasSamples = sampleCount > 0;
  const lastSampleIndex = Math.max(0, sampleCount - 1);
  const loadDisabled = array?.can_visualize_3d !== true;

  const selectSample = (next: number) => {
    if (!hasSamples) return;
    onSampleIndexChange(clampResultsSampleIndex(next, sampleCount));
  };

  return (
    <section aria-label="Results output Inspector" className="fm-inspector-panel grid min-w-0 gap-3 p-3" data-inspector-owner="results-output">
      <header className="grid min-w-0 gap-1">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="m-0 truncate text-fm-md font-semibold text-fm-primary" title={entry.name}>{entry.name || entry.path}</h2>
            <p className="m-0 truncate text-fm-xs text-fm-muted" title={entry.path}>{entry.path}</p>
          </div>
          {canReturnToLive ? <Button size="sm" type="button" variant="secondary" onClick={onReturnToLive}>{returnActionLabel}</Button> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button disabled={loadDisabled} disabledReason={array?.reason ?? "This output has no verified 3D visualization."} size="sm" type="button" variant="primary" onClick={onLoadTo3D}>Load into 3D</Button>
          <span className="self-center text-fm-xs text-fm-muted">{kindLabel(entry)} · {status}</span>
        </div>
      </header>

      {errorText ? <p className="m-0 text-fm-xs text-fm-danger" role="alert">{errorText}</p> : null}
      {status === "loading" && !array && !filePreview ? <p className="m-0 text-fm-xs text-fm-muted" role="status">Reading output metadata…</p> : null}


      {array?.reason ? <p className="m-0 text-fm-xs text-fm-muted" role="note">{array.reason}</p> : null}

      {array ? (
        <InspectorGroup title="Samples">
          <div className="grid min-w-0 gap-2">
            <div className="flex items-center justify-between gap-2 text-fm-xs text-fm-muted">
              <span>Sample</span>
              <output aria-live="polite">{hasSamples ? formatResultsSampleOrdinal(selectedSampleIndex, sampleCount) : "Sample unavailable"}</output>
            </div>
            <Input
              aria-label="Saved sample"
              aria-valuetext={formatResultsSampleOrdinal(selectedSampleIndex, sampleCount)}
              disabled={!hasSamples}
              max={lastSampleIndex}
              min={0}
              step={1}
              type="range"
              value={selectedSampleIndex}
              onChange={(event) => selectSample(Number(event.currentTarget.value))}
            />
            <p className="m-0 text-fm-xs text-fm-muted" aria-live="polite">{formatCoordinateValue(array, selectedSampleIndex)}</p>
            <div aria-label="Sample navigation" className="flex flex-wrap gap-1">
              <Button aria-label="First sample" disabled={!hasSamples || selectedSampleIndex === 0} size="sm" type="button" variant="secondary" onClick={() => selectSample(0)}>First</Button>
              <Button aria-label="Previous sample" disabled={!hasSamples || selectedSampleIndex === 0} size="sm" type="button" variant="secondary" onClick={() => selectSample(selectedSampleIndex - 1)}>Previous</Button>
              <Button aria-label="Next sample" disabled={!hasSamples || selectedSampleIndex >= lastSampleIndex} size="sm" type="button" variant="secondary" onClick={() => selectSample(selectedSampleIndex + 1)}>Next</Button>
              <Button aria-label="Last sample" disabled={!hasSamples || selectedSampleIndex >= lastSampleIndex} size="sm" type="button" variant="secondary" onClick={() => selectSample(lastSampleIndex)}>Last</Button>
            </div>
          </div>
        </InspectorGroup>
      ) : null}

      {array?.can_visualize_3d ? <VisualizationControls appearance={appearance} array={array} onAppearanceChange={onAppearanceChange} /> : null}
      {filePreview ? <FilePreview preview={filePreview} /> : null}
      <InspectorGroup title="Output metadata" collapsible defaultOpen={!array}>
        <FieldRow label="Path" value={entry.path} mono />
        <FieldRow label="Kind" value={kindLabel(entry)} />
        <FieldRow label="Status" value={statusLabel(entry.status)} />
        {!array && entry.reason ? <FieldRow label="Reason" value={entry.reason} /> : null}
        <FieldRow label="Size" value={entry.size_bytes === null ? "—" : entry.size_bytes} unit={entry.size_bytes === null ? undefined : "B"} />
        <FieldRow label="Array id" value={entry.array_id ?? "—"} mono />
        {array ? (
          <>
            <FieldRow label="Shape" value={formatShape(array.shape)} />
            <FieldRow label="Chunks" value={formatShape(array.chunks)} />
            <FieldRow label="Revision" value={array.revision} mono />
            <FieldRow label="Dtype" value={array.dtype} mono />
            <FieldRow label="Quantity" value={array.quantity_id ?? "Unavailable"} mono />
            <FieldRow label="Unit" value={array.unit ?? "Unavailable"} />
            <FieldRow label="Components" value={array.component_count ?? "Unavailable"} />
            <FieldRow label="Field layout" value={array.field_layout ?? "Unavailable"} />
            <FieldRow label="Geometry" value={array.geometry == null ? "Unavailable" : "Published"} />
            <FieldRow label="Samples" value={array.sample_count} />
            <FieldRow label="3D visualization" value={array.can_visualize_3d ? "Available" : "Unavailable"} status={array.can_visualize_3d ? "ready" : "unsupported"} />
          </>
        ) : null}
      </InspectorGroup>

      {array ? (
        <ValuePreview
          columns={array.quantity_ids}
          enabled={valuesEnabled}
          error={valuesError}
          onOpenChange={onValuesOpenChange}
          status={valuesStatus}
          values={values}
          valuesAvailable={valuesAvailable}
        />
      ) : null}
    </section>
  );
}
