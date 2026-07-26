export function AnalysisStatusPill({ label, value }: { label: string; value: string }) {
  return (
    <span aria-label={`${label} ${value}`} className="fm-analysis-plots__status-pill" title={`${label} ${value}`}>
      <span className="fm-analysis-plots__status-label">{label}</span>
      <span className="fm-analysis-plots__status-value">{value}</span>
    </span>
  );
}
