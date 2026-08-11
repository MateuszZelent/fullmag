export type PostprocessingDefinitionKind =
  | "analysis_view"
  | "derived_value"
  | "export"
  | "table";

export interface PostprocessingDefinition {
  datasetRef: string;
  id: string;
  kind: PostprocessingDefinitionKind;
  label: string;
  persistentOwner: boolean;
  resourceRevision?: number | string;
}

export function definePostprocessing(
  input: PostprocessingDefinition,
): PostprocessingDefinition {
  if (!input.id || !input.datasetRef) {
    throw new Error("Postprocessing definitions require an ID and dataset owner.");
  }
  return { ...input };
}
