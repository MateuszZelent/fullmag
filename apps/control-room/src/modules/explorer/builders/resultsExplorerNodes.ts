import {
  classifyFrequencyDomainResult,
  type FrequencyDomainResultEvidence,
} from "@/shared/domain/analysis/frequencyDomainResultClassification";

import type { ExplorerNode, ExplorerNodeKind } from "../explorerTypes";

export interface PhysicsFirstResultProducts {
  coupling?: boolean;
  frequencyPoints?: boolean;
  modeBranches?: boolean;
  modeShapes?: boolean;
  peaks?: boolean;
  responseFields?: boolean;
  responseMap?: boolean;
  responseSpectrum?: boolean;
  spectrum?: boolean;
}

export interface PhysicsFirstResultEntry extends FrequencyDomainResultEvidence {
  artifactRevision: number | string;
  products: PhysicsFirstResultProducts;
  stageLabel: string;
}

export interface PhysicsFirstResultsSnapshot {
  entries: readonly PhysicsFirstResultEntry[];
  resultContextRunId: string;
}

function key(identity: string): string {
  return encodeURIComponent(identity);
}

function node(
  id: string,
  kind: ExplorerNodeKind,
  label: string,
  parentId: string | null,
  overrides: Partial<ExplorerNode> = {},
): ExplorerNode {
  return {
    availability: "available",
    executionState: "completed",
    icon: "folder",
    id,
    kind,
    label,
    parentId,
    resourceState: "ready",
    status: "ready",
    ...overrides,
  };
}

function leaf(
  stageId: string,
  suffix: string,
  kind: ExplorerNodeKind,
  label: string,
  entry: PhysicsFirstResultEntry,
): ExplorerNode {
  return node(`${stageId}:${suffix}`, kind, label, stageId, {
    analysisRunId: entry.runId,
    analysisStageId: entry.stageId,
    badge: String(entry.artifactRevision),
    resourceRef: `artifact-revision:${entry.artifactRevision}`,
  });
}

function hasPublishedProduct(products: PhysicsFirstResultProducts): boolean {
  return Object.values(products).some(Boolean);
}

function resonanceStage(
  rootId: string,
  entry: PhysicsFirstResultEntry,
): ExplorerNode | null {
  if (!hasPublishedProduct(entry.products)) return null;
  const classification = classifyFrequencyDomainResult(entry);
  if (classification.family !== "resonance") return null;
  const method = entry.studyProduct === "modal_eigen" ? "Modal" : "Driven";
  const stageId = `${rootId}:stage:${key(entry.stageId)}:${entry.studyProduct}`;
  const children: ExplorerNode[] = [];

  if (entry.studyProduct === "modal_eigen") {
    if (entry.products.spectrum) {
      children.push(
        leaf(
          stageId,
          "spectrum",
          "results.resonance.modal.spectrum",
          classification.resultLabel,
          entry,
        ),
      );
    }
    if (entry.products.modeShapes) {
      children.push(leaf(stageId, "modes", "results.resonance.modal.modes", "Mode Shapes", entry));
    }
    if (entry.products.coupling && classification.fmrQualified) {
      children.push(
        leaf(
          stageId,
          "rf-coupling",
          "results.resonance.modal.coupling",
          "RF Coupling / FMR Activity",
          entry,
        ),
      );
    }
  } else {
    if (entry.products.responseSpectrum) {
      children.push(
        leaf(
          stageId,
          "response-spectrum",
          "results.resonance.driven.spectrum",
          classification.resultLabel,
          entry,
        ),
      );
    }
    if (entry.products.peaks) {
      children.push(leaf(stageId, "peaks", "results.resonance.driven.peaks", "Resonance Peaks", entry));
    }
    if (entry.products.frequencyPoints) {
      children.push(
        leaf(stageId, "frequency-points", "results.resonance.driven.frequency_points", "Frequency Points", entry),
      );
    }
    if (entry.products.responseFields) {
      children.push(
        leaf(stageId, "response-fields", "results.resonance.driven.fields", "Response Fields", entry),
      );
    }
  }
  children.push(
    leaf(stageId, "provenance", "results.frequency_domain.provenance", "Equilibrium & Provenance", entry),
  );

  return node(stageId, "results.resonance.stage", `${entry.stageLabel} · ${method}`, rootId, {
    analysisRunId: entry.runId,
    analysisStageId: entry.stageId,
    badge: classification.kContext.label,
    children,
  });
}

function kResolvedStage(
  rootId: string,
  entry: PhysicsFirstResultEntry,
): ExplorerNode | null {
  if (!hasPublishedProduct(entry.products)) return null;
  const classification = classifyFrequencyDomainResult(entry);
  if (classification.family !== "k_resolved") return null;
  const method = entry.studyProduct === "modal_eigen" ? "Modal" : "Driven";
  const stageId = `${rootId}:stage:${key(entry.stageId)}:${entry.studyProduct}`;
  const children: ExplorerNode[] = [
    leaf(stageId, "k-sampling", "results.dispersion.k_sampling", classification.kContext.label, entry),
  ];

  if (entry.studyProduct === "modal_eigen") {
    if (entry.products.spectrum || entry.products.modeBranches) {
      children.push(
        leaf(stageId, "dispersion", "results.dispersion.modal.relation", classification.resultLabel, entry),
      );
    }
    if (entry.products.modeBranches) {
      children.push(leaf(stageId, "branches", "results.dispersion.modal.branches", "Mode Branches", entry));
    }
    if (entry.products.modeShapes) {
      children.push(leaf(stageId, "modes-at-k", "results.dispersion.modal.modes_at_k", "Modes at k", entry));
    }
  } else if (entry.products.responseMap) {
    children.push(
      leaf(stageId, "response-map", "results.dispersion.driven.response_map", classification.resultLabel, entry),
    );
  }
  children.push(
    leaf(stageId, "provenance", "results.frequency_domain.provenance", "Equilibrium & Provenance", entry),
  );

  return node(stageId, "results.dispersion.stage", `${entry.stageLabel} · ${method}`, rootId, {
    analysisRunId: entry.runId,
    analysisStageId: entry.stageId,
    badge: classification.kContext.label,
    children,
  });
}

function rootWithChildren(
  id: string,
  kind: ExplorerNodeKind,
  label: string,
  parentId: string,
  children: readonly (ExplorerNode | null)[],
): ExplorerNode {
  return node(id, kind, label, parentId, { children: children.filter((child): child is ExplorerNode => child !== null) });
}

export function buildPhysicsFirstResultsTree(snapshot: PhysicsFirstResultsSnapshot): ExplorerNode[] {
  for (const entry of snapshot.entries) {
    if (entry.runId !== snapshot.resultContextRunId) {
      throw new Error(
        `Result entry ${entry.runId} does not belong to context ${snapshot.resultContextRunId}`,
      );
    }
  }

  const runKey = key(snapshot.resultContextRunId);
  const resultsId = `results:run:${runKey}`;
  const resonanceId = `${resultsId}:resonance`;
  const dispersionId = `${resultsId}:k-resolved`;
  const resonanceStages = snapshot.entries.map((entry) => resonanceStage(resonanceId, entry));
  const dispersionStages = snapshot.entries.map((entry) => kResolvedStage(dispersionId, entry));

  return [
    node(resultsId, "results.root", "Results", null, {
      analysisRunId: snapshot.resultContextRunId,
      children: [
        rootWithChildren(`${resultsId}:dynamics`, "results.dynamics.root", "Dynamics", resultsId, []),
        rootWithChildren(resonanceId, "results.resonance.root", "Resonance & FMR", resultsId, resonanceStages),
        rootWithChildren(
          dispersionId,
          "results.dispersion.root",
          "Dispersion & k-resolved response",
          resultsId,
          dispersionStages,
        ),
        rootWithChildren(`${resultsId}:hysteresis`, "results.hysteresis.root", "Hysteresis", resultsId, []),
        rootWithChildren(`${resultsId}:analysis-views`, "results.analysis_views.root", "Analysis Views", resultsId, []),
        rootWithChildren(`${resultsId}:derived-values`, "results.derived_values.root", "Derived Values", resultsId, []),
        rootWithChildren(`${resultsId}:tables`, "results.tables.root", "Tables", resultsId, []),
        rootWithChildren(`${resultsId}:exports`, "results.exports.root", "Exports", resultsId, []),
      ],
    }),
  ];
}
