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
export const MAX_LINE_CHART_POINTS = 320;

export function buildLineChartModel(points: readonly LinePoint[]): LineChartModel | null {
  const finitePoints: LinePoint[] = [];
  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      continue;
    }
    finitePoints.push(point);
    xMin = Math.min(xMin, point.x);
    xMax = Math.max(xMax, point.x);
    yMin = Math.min(yMin, point.y);
    yMax = Math.max(yMax, point.y);
  }
  if (finitePoints.length === 0) return null;

  if (xMin === xMax) {
    xMin -= 1;
    xMax += 1;
  }
  if (yMin === yMax) {
    const pad = Math.max(1, Math.abs(yMin) * 0.1);
    yMin -= pad;
    yMax += pad;
  }

  const pathPoints = decimateLinePoints(finitePoints);
  const xSpan = xMax - xMin;
  const ySpan = yMax - yMin;
  const drawableWidth = CHART_WIDTH - CHART_PADDING * 2;
  const drawableHeight = CHART_HEIGHT - CHART_PADDING * 2;
  const path = pathPoints
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

function decimateLinePoints(points: readonly LinePoint[]): readonly LinePoint[] {
  if (points.length <= MAX_LINE_CHART_POINTS) return points;

  const bucketCount = Math.max(1, Math.floor((MAX_LINE_CHART_POINTS - 2) / 2));
  const interiorCount = points.length - 2;
  const result: LinePoint[] = [points[0]];

  for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
    const start = 1 + Math.floor((bucketIndex * interiorCount) / bucketCount);
    const end = 1 + Math.floor(((bucketIndex + 1) * interiorCount) / bucketCount);
    let minIndex = start;
    let maxIndex = start;

    for (let index = start + 1; index < end; index += 1) {
      if (points[index].y < points[minIndex].y) {
        minIndex = index;
      }
      if (points[index].y > points[maxIndex].y) {
        maxIndex = index;
      }
    }

    if (minIndex === maxIndex) {
      result.push(points[minIndex]);
    } else if (minIndex < maxIndex) {
      result.push(points[minIndex], points[maxIndex]);
    } else {
      result.push(points[maxIndex], points[minIndex]);
    }
  }

  result.push(points[points.length - 1]);
  return result;
}

export const ANALYSIS_PLOT_VIEWBOX = `0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`;
