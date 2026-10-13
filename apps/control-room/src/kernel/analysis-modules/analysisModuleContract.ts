/**
 * Analysis feature module contract (spec frontend-v2/32, ADR 0054).
 *
 * A manifest is metadata only: the kernel evaluates its match rules against
 * published dataset manifests without importing any view, inspector or
 * ribbon code. Module code is loaded lazily through `load` on first
 * expansion or selection of a node the module owns.
 */
import type {
  AnalysisResultDatasetCapabilities,
  AnalysisResultItemKind,
  AnalysisResultProductKind,
} from "@/kernel/api/apiTypes";

export type AnalysisModuleId = `analysis.${string}`;
export type AnalysisNodeKind = `analysis.${string}`;

export interface AxisRoleRequirement {
  /** Published `AnalysisResultAxisResource.role`, e.g. "wavevector", "spectral". */
  role: string;
  /** Inclusive lower bound on the axis cardinality. */
  minCardinality?: number;
  /** Inclusive upper bound on the axis cardinality. */
  maxCardinality?: number;
}

export interface DatasetMatchRule {
  productKinds: readonly AnalysisResultProductKind[];
  itemKinds?: readonly AnalysisResultItemKind[];
  requiredAxes?: readonly AxisRoleRequirement[];
  /** Axis roles that must not be published, e.g. resonance excludes "wavevector" paths. */
  absentAxes?: readonly string[];
  requiredCapabilities?: readonly (keyof AnalysisResultDatasetCapabilities)[];
}

export type AnalysisNodeRole =
  | "overview"
  | "plot-1d"
  | "plot-2d"
  | "plot-feature"
  | "data-collection"
  | "visualization-group"
  | "field-visualization"
  | "derived-value"
  | "quality";

export type AnalysisNodeInstantiation = "auto" | "optional" | "user";

export interface AnalysisNodeTemplate {
  kind: AnalysisNodeKind;
  parent: AnalysisNodeKind | "dataset";
  role: AnalysisNodeRole;
  /** Static label shown before the module code or data is loaded. */
  title: string;
  instantiation: AnalysisNodeInstantiation;
  /** When unmet, an optional template stays visible but disabled with a reason. */
  availableWhen?: DatasetMatchRule;
  children?: { paging: "none" | "server"; pageSize?: number };
}

export interface AnalysisFeatureManifest {
  id: AnalysisModuleId;
  version: string;
  title: string;
  /** One matching rule is enough. */
  matches: readonly DatasetMatchRule[];
  nodeTemplates: readonly AnalysisNodeTemplate[];
  /** Definition schema per user-created node kind, e.g. "analysis.dispersion.mode_visualization.v1". */
  definitionSchemas: Readonly<Partial<Record<AnalysisNodeKind, string>>>;
  load: () => Promise<{ default: AnalysisFeatureModule }>;
}

/**
 * Lazily loaded module code. Views, Inspector sections and ribbon groups are
 * added to this interface as the kernel gains the corresponding hosts
 * (plan stages 3–4); until then a module only identifies itself.
 */
export interface AnalysisFeatureModule {
  id: AnalysisModuleId;
}

/** The subset of a dataset manifest the matcher reads. */
export interface MatchableDataset {
  dataset_id: string;
  product_kind: AnalysisResultProductKind;
  item_kinds: readonly AnalysisResultItemKind[];
  axes: readonly { role: string; cardinality: number }[];
  capabilities: AnalysisResultDatasetCapabilities;
}

export type DatasetMatchResult =
  | { matched: true; ruleIndex: number }
  | { matched: false; reason: string };
