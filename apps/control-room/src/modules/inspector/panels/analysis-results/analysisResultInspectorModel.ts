import type {
  AnalysisResultDatasetManifestResource,
  AnalysisResultSpectralItemSummary,
} from "@/shared/domain/analysis/results";

export interface AnalysisResultInspectorRow {
  label: string;
  mono?: boolean;
  value: string;
}

export interface AnalysisResultInspectorRelationRow extends AnalysisResultInspectorRow {
  status: "ready" | "partial" | "stale" | "unavailable";
}

export interface AnalysisResultInspectorModel {
  metadata: readonly AnalysisResultInspectorRow[];
  relations: readonly AnalysisResultInspectorRelationRow[];
}

type InspectorManifest = Pick<
  AnalysisResultDatasetManifestResource,
  "dataset_id" | "dataset_revision" | "product_kind" | "provenance" | "status"
>;
type InspectorItem = Pick<AnalysisResultSpectralItemSummary, "relations" | "source_revision">;
type InspectorRelation = AnalysisResultSpectralItemSummary["relations"][number];

const TIME_DOMAIN_METADATA = [
  ["sampling_clock", "Sampling clock"],
  ["uniformity_proof", "Uniformity proof"],
  ["window", "Window"],
  ["detrend", "Detrend"],
  ["normalization", "Normalization", true],
  ["nyquist_hz", "Nyquist"],
  ["source_drive", "Source drive"],
] as const;

const DSF_METADATA = [
  ["spatial_axis", "Spatial axis"],
  ["phase_convention", "Phase convention", true],
  ["mesh_probe_signature", "Probe signature", true],
  ["array_bounds", "Bounds"],
] as const;

export function buildAnalysisResultInspectorModel({
  item,
  manifest,
}: {
  item: InspectorItem | null;
  manifest: InspectorManifest | null;
}): AnalysisResultInspectorModel {
  return {
    metadata: metadataRows(manifest),
    relations: relationRows(manifest, item),
  };
}

function metadataRows(manifest: InspectorManifest | null): readonly AnalysisResultInspectorRow[] {
  if (!manifest || !isTimeDomainProduct(manifest.product_kind)) return [];
  const fields = manifest.product_kind === "dynamic_structure_factor"
    ? [...TIME_DOMAIN_METADATA, ...DSF_METADATA]
    : TIME_DOMAIN_METADATA;
  return [
    ...fields.map(([key, label, mono]) => ({
      label,
      ...(mono ? { mono } : {}),
      value: publishedValue(manifest.provenance[key]),
    })),
    { label: "Completeness", value: publishedValue(manifest.status.completeness) },
  ];
}

function relationRows(
  manifest: InspectorManifest | null,
  item: InspectorItem | null,
): readonly AnalysisResultInspectorRelationRow[] {
  if (!manifest || !item || item.relations.length === 0) {
    return [{ label: "Item relations", value: "Unavailable", status: "unavailable" }];
  }
  return item.relations.map((relation) => relationRow(manifest, item, relation));
}

function relationRow(
  manifest: InspectorManifest,
  item: InspectorItem,
  relation: InspectorRelation,
): AnalysisResultInspectorRelationRow {
  if (relation.source_revision !== item.source_revision) {
    return staleRelation(relation.relation, "source revision does not match the selected item");
  }
  if (
    relation.target_dataset_id === manifest.dataset_id &&
    relation.target_revision !== manifest.dataset_revision
  ) {
    return staleRelation(relation.relation, "target revision does not match the selected dataset");
  }
  if (!relation.target_dataset_id || !relation.target_item_id || !relation.target_revision) {
    return {
      label: relation.relation,
      mono: true,
      status: "partial",
      value: "Partial: target identity or revision is not published",
    };
  }
  return {
    label: relation.relation,
    mono: true,
    status: "ready",
    value: relationTargetSummary(relation),
  };
}

function staleRelation(label: string, value: string): AnalysisResultInspectorRelationRow {
  return { label, mono: true, status: "stale", value: `Stale: ${value}` };
}

function relationTargetSummary(relation: InspectorRelation): string {
  return [
    relation.target_dataset_id,
    relation.target_sample_id,
    relation.target_item_id,
    relation.target_revision,
    relation.method,
    relation.score == null ? null : `score=${relation.score}`,
    relation.qualification,
  ].filter((value): value is string => Boolean(value)).join(" · ");
}

function publishedValue(value: string | null | undefined): string {
  return typeof value === "string" && value.trim() ? value : "Unavailable";
}

function isTimeDomainProduct(productKind: InspectorManifest["product_kind"]): boolean {
  return productKind === "time_domain_spectrum" || productKind === "dynamic_structure_factor";
}
