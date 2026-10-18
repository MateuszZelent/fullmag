import { useMemo, useState } from "react";
import { QuickChartView } from "@/shared/analysis-charts/QuickChartView";
import type { ChartRenderModel } from "@/shared/analysis-charts/chartRenderer";
import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import { FormField } from "../../primitives/FormField";
import { FieldRow } from "../../primitives/FieldRow";
import { InspectorGroup } from "../../primitives/InspectorGroup";
import { FeedbackBanner } from "../../primitives/FeedbackBanner";
import { defaultDrivePreviewRange, sampleAntennaDrive, MAX_DRIVE_PREVIEW_POINTS } from "./AntennaDrivePreviewModel";
import type { SolvedDrive } from "./SolvedAntennaDriveEditorModel";

export function AntennaDrivePreview({ drive, revision }: { drive: SolvedDrive | null; revision: number }) {
  const [range, setRange] = useState<{ id: string; from: string; to: string } | null>(null);
  const [cursor, setCursor] = useState(0);
  const signature = JSON.stringify(drive);
  const preview = useMemo(() => {
    const current = JSON.parse(signature) as SolvedDrive | null;
    const defaults = current ? defaultDrivePreviewRange(current) : [0, 1e-9];
    const activeRange = current && range?.id === current.id ? range : null;
    const from = activeRange ? activeRange.from : String(defaults[0]);
    const to = activeRange ? activeRange.to : String(defaults[1]);
    let error: string | null = null, points: ReturnType<typeof sampleAntennaDrive> = [];
    try {
      if (!current) throw new Error("Correct the drive parameters to preview the current.");
      if (!from.trim() || !to.trim()) throw new Error("Enter both preview time limits.");
      points = sampleAntennaDrive(current, Number(from), Number(to));
    } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    const model: ChartRenderModel = {
      key: "antenna-authored-current", ariaLabel: "Authored antenna current I(t)", status: error ? "error" : "ready", statusMessage: error ?? undefined,
      xAxis: { label: current?.time_origin === "absolute" ? "Absolute simulation time" : "Stage-local waveform time", unit: "s" },
      yAxes: [{ label: "Current I(t)", unit: "A" }],
      series: [{ id: "authored-current", label: "Authored current I(t)", unit: "A", kind: "line", yAxis: 0, points }],
      provenance: { resourceKey: MODEL_SCENE_PATH, dataRevision: revision, query: `drive=${current?.id ?? "invalid"}; authored draft preview; time_origin=${current?.time_origin ?? "unknown"}`,
        decimation: `bounded analytic samples with explicit knots and pulse boundaries; maximum ${MAX_DRIVE_PREVIEW_POINTS}`,
        qualification: "authored waveform preview; not a solver result", scientificTrust: "unknown" },
    };
    return { from, to, model, error };
  }, [signature, range, revision]);
  const points = preview.model.series[0].points;
  const index = Math.min(cursor, Math.max(0, points.length - 1)), point = points[index];
  return <div data-testid="antenna-drive-preview"><InspectorGroup title="Current preview I(t)" badge="authored waveform">
    <p className="fm-inspector-hint">I(t) = signed current scale × waveform(t). Preview uses the selected waveform clock; stage activation and the physical time origin are resolved at execution. Negative preview times show the mathematical waveform only.</p>
    <FormField label="Preview from" unit="s" value={preview.from} onChange={event => drive && setRange({ id: drive.id, from: event.currentTarget.value, to: preview.to })} />
    <FormField label="Preview to" unit="s" value={preview.to} onChange={event => drive && setRange({ id: drive.id, from: preview.from, to: event.currentTarget.value })} />
    <QuickChartView model={preview.model} onPointSelect={selection => setCursor(selection.rowIndex)} />
    <FormField label="Preview sample" type="range" min={0} max={Math.max(0, points.length - 1)} step={1} value={index} disabled={!points.length} onChange={event => setCursor(Number(event.currentTarget.value))} />
    <FieldRow label="Sample time" value={point ? `${point.x.toExponential(6)} s` : "unavailable"} mono />
    <FieldRow label="Sample current (one-sided at pulse edges)" value={point ? `${point.y.toExponential(6)} A` : "unavailable"} mono />
    <FieldRow label="Preview samples" value={`${points.length} / ${MAX_DRIVE_PREVIEW_POINTS}`} />
    {preview.error ? <FeedbackBanner kind="warning" message={preview.error} /> : null}
  </InspectorGroup></div>;
}
