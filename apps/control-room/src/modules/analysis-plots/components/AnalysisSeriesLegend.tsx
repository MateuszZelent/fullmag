import { Button } from "@/shared/ui/Button";

import type { ChartSeries } from "../chartTableModel";
import { buildSeriesLegend } from "../analysisWorkbenchModel";

export function AnalysisSeriesLegend({ ariaLabel, onSelect, series }: { ariaLabel: string; onSelect: (series: ChartSeries) => void; series: readonly ChartSeries[] }) {
  const legend = buildSeriesLegend(series);
  if (legend.length === 0) return null;
  return (
    <div className="fm-analysis-plots__legend" aria-label={ariaLabel}>
      {legend.map((item, index) => (
        <Button
          aria-label={`Series ${item.label} unit ${item.unit} latest ${item.latest}`}
          className="fm-analysis-plots__legend-item"
          key={item.columnId}
          onClick={() => onSelect(item.series)}
          size="sm"
          title={`${item.label} [${item.unit}] latest ${item.latest} from ${item.source}`}
          type="button"
          variant="secondary"
        >
          <span aria-hidden="true" className={`fm-analysis-plots__legend-swatch fm-analysis-plots__legend-swatch--${index % 5}`} />
          <span className="fm-analysis-plots__legend-label">{item.label}</span>
          <span className="fm-analysis-plots__legend-unit">{item.unit}</span>
          <span className="fm-analysis-plots__legend-latest">{item.latest}</span>
        </Button>
      ))}
    </div>
  );
}
