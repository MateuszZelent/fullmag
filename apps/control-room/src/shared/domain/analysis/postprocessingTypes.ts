export type PostprocessingDefinitionKind =
  | "analysis_view"
  | "derived_value"
  | "export"
  | "table";

export type PostprocessingOwnerKind = "artifact" | "table";

export type PostprocessingOwnerReadiness =
  | "available-ready"
  | "loading"
  | "stale"
  | "error"
  | "unavailable";

export type PostprocessingFreshness = "fresh" | "stale" | "unknown";

export type PostprocessingSelectionScope = "definition" | "root";
