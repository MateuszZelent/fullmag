/**
 * Scientific qualification is supplied by an analysis result, not inferred
 * from transport freshness. A resource can be ready while its qualification
 * is still unknown.
 */
export type ChartScientificTrust =
  | "qualified"
  | "under_resolved"
  | "estimated"
  | "incomplete"
  | "unknown";

export function scientificTrustLabel(trust: ChartScientificTrust): string {
  switch (trust) {
    case "qualified": return "Qualified";
    case "under_resolved": return "Under-resolved";
    case "estimated": return "Estimated";
    case "incomplete": return "Incomplete";
    default: return "Unknown";
  }
}
