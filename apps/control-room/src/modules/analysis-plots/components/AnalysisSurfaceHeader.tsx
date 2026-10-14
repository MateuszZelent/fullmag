import type { AnalysisSubview, AnalysisSurface } from "@/kernel/workspace/analysisViewPreferences";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/shared/ui/Select";

const SURFACES: readonly { id: AnalysisSurface; label: string }[] = [
  { id: "dynamics", label: "Dynamics" },
  { id: "resonance-fmr", label: "Resonance & FMR" },
  { id: "dispersion", label: "Dispersion" }, { id: "hysteresis", label: "Hysteresis" }, { id: "comparison", label: "Comparison" },
];

const SUBVIEW_LABELS: Readonly<Record<AnalysisSubview, string>> = {
  "comparison.sources": "Sources",
  "dispersion.branches": "Branches",
  "dispersion.driven-map": "Driven A(k,f)",
  "dispersion.modal": "Modal fₙ(k)",
  "dynamics.s-k-f": "S(k,f)",
  "dynamics.temporal-fft": "Temporal FFT",
  "dynamics.time-traces": "Time Traces",
  "hysteresis.branches": "Branches",
  "hysteresis.loop": "Loop",
  "resonance.eigenmodes": "Eigenmodes",
  "resonance.frequency-response": "Frequency Response",
  "resonance.modal-driven": "Modal–Driven",
};

/**
 * Read-only header of the active Analysis surface. Surfaces are switched only
 * from the Explorer Results tree (ADR 0054); this header names the surface and
 * exposes the contextual subview control.
 */
export function AnalysisSurfaceHeader({
  active,
  activeSubview,
  onSubviewChange = () => undefined,
  subviews = [],
}: {
  active: AnalysisSurface;
  activeSubview?: AnalysisSubview;
  onSubviewChange?: (subview: AnalysisSubview) => void;
  subviews?: readonly AnalysisSubview[];
}) {
  const surfaceLabel = SURFACES.find((surface) => surface.id === active)?.label ?? "Analysis";
  return <div className="fm-analysis-plots__navigation">
    <h2 className="fm-analysis-plots__surface-title" data-analysis-surface-title={active}>{surfaceLabel}</h2>
    {activeSubview && subviews.length > 0 ? <Select onValueChange={(value) => onSubviewChange(value as AnalysisSubview)} value={activeSubview}>
      <SelectTrigger aria-label={`${surfaceLabel} subview`} className="fm-analysis-plots__subview" data-analysis-subview={activeSubview} density="compact">
        <SelectValue>{SUBVIEW_LABELS[activeSubview]}</SelectValue>
      </SelectTrigger>
      <SelectContent>{subviews.map((subview) => <SelectItem key={subview} value={subview}>{SUBVIEW_LABELS[subview]}</SelectItem>)}</SelectContent>
    </Select> : null}
  </div>;
}
