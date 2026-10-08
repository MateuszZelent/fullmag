import type {
  AnalysisFeatureManifest,
  AnalysisNodeTemplate,
  DatasetMatchResult,
  DatasetMatchRule,
  MatchableDataset,
} from "./analysisModuleContract";

/**
 * Explains why a dataset fails a rule, or returns null when it satisfies it.
 * Reads only published manifest fields; labels and file names never count.
 */
export function datasetRuleMismatch(
  rule: DatasetMatchRule,
  dataset: MatchableDataset,
): string | null {
  if (!rule.productKinds.includes(dataset.product_kind)) {
    return `product ${dataset.product_kind} is not handled`;
  }
  if (rule.itemKinds && !rule.itemKinds.some((kind) => dataset.item_kinds.includes(kind))) {
    return `item kinds ${dataset.item_kinds.join(", ") || "none"} do not include ${rule.itemKinds.join(" | ")}`;
  }
  for (const requirement of rule.requiredAxes ?? []) {
    const axis = dataset.axes.find((candidate) => candidate.role === requirement.role);
    if (!axis) {
      return `no ${requirement.role} axis`;
    }
    if (requirement.minCardinality !== undefined && axis.cardinality < requirement.minCardinality) {
      return `${requirement.role} axis has ${axis.cardinality} value(s); at least ${requirement.minCardinality} required`;
    }
    if (requirement.maxCardinality !== undefined && axis.cardinality > requirement.maxCardinality) {
      return `${requirement.role} axis has ${axis.cardinality} values; at most ${requirement.maxCardinality} allowed`;
    }
  }
  for (const role of rule.absentAxes ?? []) {
    if (dataset.axes.some((axis) => axis.role === role)) {
      return `has a ${role} axis`;
    }
  }
  for (const capability of rule.requiredCapabilities ?? []) {
    if (dataset.capabilities[capability] !== true) {
      return `capability ${capability} is not published`;
    }
  }
  return null;
}

export function matchDataset(
  manifest: AnalysisFeatureManifest,
  dataset: MatchableDataset,
): DatasetMatchResult {
  let firstReason: string | null = null;
  for (const [ruleIndex, rule] of manifest.matches.entries()) {
    const mismatch = datasetRuleMismatch(rule, dataset);
    if (mismatch === null) {
      return { matched: true, ruleIndex };
    }
    firstReason ??= mismatch;
  }
  return { matched: false, reason: firstReason ?? "module declares no match rules" };
}

export interface TemplateAvailability {
  template: AnalysisNodeTemplate;
  available: boolean;
  reason: string | null;
}

/** Availability of a module's templates for one dataset the module already matched. */
export function templateAvailability(
  manifest: AnalysisFeatureManifest,
  dataset: MatchableDataset,
): TemplateAvailability[] {
  return manifest.nodeTemplates.map((template) => {
    const reason = template.availableWhen
      ? datasetRuleMismatch(template.availableWhen, dataset)
      : null;
    return { template, available: reason === null, reason };
  });
}
