export interface LinePoint {
  x: number;
  y: number;
}

export interface LineChartModel {
  path: string;
  xMax: number;
  xMin: number;
  yMax: number;
  yMin: number;
}

const CHART_WIDTH = 320;
const CHART_HEIGHT = 140;
const CHART_PADDING = 12;

export function buildLineChartModel(points: readonly LinePoint[]): LineChartModel | null {
  const finitePoints = points.filter(
    (point) => Number.isFinite(point.x) && Number.isFinite(point.y),
  );
  if (finitePoints.length === 0) return null;

  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  for (const point of finitePoints) {
    xMin = Math.min(xMin, point.x);
    xMax = Math.max(xMax, point.x);
    yMin = Math.min(yMin, point.y);
    yMax = Math.max(yMax, point.y);
  }
  if (xMin === xMax) {
    xMin -= 1;
    xMax += 1;
  }
  if (yMin === yMax) {
    const pad = Math.max(1, Math.abs(yMin) * 0.1);
    yMin -= pad;
    yMax += pad;
  }

  const xSpan = xMax - xMin;
  const ySpan = yMax - yMin;
  const drawableWidth = CHART_WIDTH - CHART_PADDING * 2;
  const drawableHeight = CHART_HEIGHT - CHART_PADDING * 2;
  const path = finitePoints
    .map((point, index) => {
      const x = CHART_PADDING + ((point.x - xMin) / xSpan) * drawableWidth;
      const y =
        CHART_PADDING +
        (1 - (point.y - yMin) / ySpan) * drawableHeight;
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");

  return { path, xMax, xMin, yMax, yMin };
}

export const ANALYSIS_PLOT_VIEWBOX = `0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`;
