const PREVIEW_POINTS_DEFAULT = 16_384;
const PREVIEW_POINTS_MIN = 4_096;
const PREVIEW_POINTS_MAX = 1_048_576;

const REFERENCE_MAX_POINTS = 16_384;
const REFERENCE_GLYPH_BUDGET = 1_200;
const GLYPH_SCALE = REFERENCE_GLYPH_BUDGET / Math.sqrt(REFERENCE_MAX_POINTS);

export const GLYPH_BUDGET_MIN = 8;
export const GLYPH_BUDGET_MAX = 4_096;
export const GLYPH_BUDGET_STEP = 16;
export const PREVIEW_MAX_POINTS_DEFAULT = PREVIEW_POINTS_DEFAULT;

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

export function normalizePreviewMaxPoints(maxPoints: number): number {
  if (!Number.isFinite(maxPoints)) {
    return PREVIEW_POINTS_DEFAULT;
  }
  if (maxPoints <= 0) {
    return PREVIEW_POINTS_MAX;
  }
  return clampNumber(Math.round(maxPoints), PREVIEW_POINTS_MIN, PREVIEW_POINTS_MAX);
}

export function maxPointsToGlyphBudget(maxPoints: number): number {
  const normalizedMaxPoints = normalizePreviewMaxPoints(maxPoints);
  const rawBudget = Math.round(Math.sqrt(normalizedMaxPoints) * GLYPH_SCALE);
  return clampNumber(rawBudget, GLYPH_BUDGET_MIN, GLYPH_BUDGET_MAX);
}

export function glyphBudgetToMaxPoints(glyphBudget: number): number {
  const normalizedBudget = clampNumber(
    Math.round(glyphBudget),
    GLYPH_BUDGET_MIN,
    GLYPH_BUDGET_MAX,
  );
  if (normalizedBudget >= GLYPH_BUDGET_MAX) {
    return 0;
  }
  const rawMaxPoints = Math.round((normalizedBudget / GLYPH_SCALE) ** 2);
  return clampNumber(rawMaxPoints, PREVIEW_POINTS_MIN, PREVIEW_POINTS_MAX);
}
