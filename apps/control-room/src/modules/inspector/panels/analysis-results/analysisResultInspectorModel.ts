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
  axes: readonly AnalysisResultInspectorRow[];
  metadata: readonly AnalysisResultInspectorRow[];
  provenance: readonly AnalysisResultInspectorRow[];
  relations: readonly AnalysisResultInspectorRelationRow[];
  sources: readonly AnalysisResultInspectorRow[];
}

type InspectorManifest = Pick<
  AnalysisResultDatasetManifestResource,
  | "axes"
  | "dataset_id"
  | "dataset_revision"
  | "product_kind"
  | "provenance"
  | "source_artifacts"
  | "status"
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
    axes: axisRows(manifest),
    metadata: metadataRows(manifest),
    provenance: provenanceRows(manifest),
    relations: relationRows(manifest, item),
    sources: sourceRows(manifest),
  };
}

function axisRows(
  manifest: InspectorManifest | null,
): readonly AnalysisResultInspectorRow[] {
  if (!manifest) return [];
  return manifest.axes.map((axis) => ({
    label: axis.label,
    mono: true,
    value: [
      axis.role,
      axis.value_kind,
      `${axis.cardinality} values`,
      axis.unit_si ?? "dimensionless",
      `semantic=${axis.semantic_id}`,
    ].join(" · "),
  }));
}

function sourceRows(
  manifest: InspectorManifest | null,
): readonly AnalysisResultInspectorRow[] {
  if (!manifest) return [];
  return manifest.source_artifacts.map((source) => ({
    label: source.relation,
    mono: true,
    value: `${source.artifact} · ${source.revision}`,
  }));
}

function provenanceRows(
  manifest: InspectorManifest | null,
): readonly AnalysisResultInspectorRow[] {
  if (!manifest) return [];
  return Object.entries(manifest.provenance)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, value]) => value.trim()
      ? [{ label: provenanceLabel(key), mono: true, value }]
      : []);
}

function provenanceLabel(key: string): string {
  return key
    .split("_")
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
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
