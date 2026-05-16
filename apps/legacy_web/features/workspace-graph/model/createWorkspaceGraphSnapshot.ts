import type { QuantityDescriptor } from "@/lib/session/types";
import type { StudyPipelineDocument, StudyPipelineNode } from "@/lib/study-builder/types";
import type { WorkspaceGraphBridgeInput, WorkspaceGraphState, StudyNodeRef, QuantityFrameViewModel } from "./types";

function collectStudyNodes(
  nodes: StudyPipelineNode[],
): StudyNodeRef[] {
  const acc: StudyNodeRef[] = [];
  const walk = (list: StudyPipelineNode[]) => {
    for (const node of list) {
      const childIds = node.node_kind === "group" ? node.children.map((child) => child.id) : [];
      acc.push({
        id: node.id,
        label: node.label,
        stageKind:
          node.node_kind === "primitive"
            ? node.stage_kind
            : node.node_kind === "macro"
              ? node.macro_kind
              : "group",
        enabled: node.enabled,
        source: node.source ?? "unknown",
        childIds,
      });
      if (node.node_kind === "group") {
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return acc;
}

function buildQuantityFrames(quantities: QuantityDescriptor[]): QuantityFrameViewModel[] {
  return quantities.map((quantity) => ({
    quantityId: quantity.id,
    label: quantity.label,
    unit: quantity.unit ?? null,
    shape: quantity.kind ?? null,
    location: quantity.location ?? null,
    domain: quantity.domain ?? null,
    nComp: quantity.n_comp ?? null,
    interactivePreview: quantity.interactive_preview,
    available: quantity.available,
  }));
}

function firstAvailableStudyNode(document: StudyPipelineDocument | null): string | null {
  if (!document) return null;
  const stack = [...document.nodes];
  while (stack.length > 0) {
    const node = stack.shift()!;
    if (node.enabled) return node.id;
    if (node.node_kind === "group") {
      stack.unshift(...node.children);
    }
  }
  return document.nodes[0]?.id ?? null;
}

function inferSolutionKind(quantityId: string | null): "live" | "time_dependent" | "frequency_domain" | "eigenfrequency" | "artifact" {
  if (quantityId === "eigenmode" || quantityId === "eigen_freq") return "eigenfrequency";
  return "live";
}

export function createWorkspaceGraphSnapshot(
  input: WorkspaceGraphBridgeInput,
  previousSnapshot?: WorkspaceGraphState | null,
): WorkspaceGraphState {
  const studyNodes = input.studyPipeline ? collectStudyNodes(input.studyPipeline.nodes) : [];
  const quantityFrames = buildQuantityFrames(input.quantities);
  const activeTabId = input.activeWorkspaceTabByStage[input.workspaceMode] ?? null;
  const explicitViewportDocumentId = activeTabId
    ? `viewport:${input.workspaceMode}:${activeTabId}`
    : null;
  const previousActiveViewportDocumentId =
    previousSnapshot?.selection.activeViewportDocumentId ?? null;
  const previousActiveViewportDocument = previousActiveViewportDocumentId
    ? previousSnapshot?.viewportDocuments[previousActiveViewportDocumentId] ?? null
    : null;
  const fallbackViewportDocumentId =
    previousActiveViewportDocument?.workspaceMode === input.workspaceMode
      ? previousActiveViewportDocument.id
      : null;
  const activeViewportDocumentId = explicitViewportDocumentId ?? fallbackViewportDocumentId;
  const inferredDatasetId = input.resultsWorkspace.datasets[0]?.id ?? "dataset:live";
  const inferredStudyId = firstAvailableStudyNode(input.studyPipeline);
  const requestedQuantityId = input.requestedPreviewQuantity ?? quantityFrames.find((q) => q.available)?.quantityId ?? null;
  const liveSolutionId = "solution:live";
  const existingViewportDocument = activeViewportDocumentId
    ? previousSnapshot?.viewportDocuments[activeViewportDocumentId] ?? null
    : null;
  const selectedDatasetId =
    existingViewportDocument?.selectedDatasetId ??
    input.resultsWorkspace.datasets[0]?.id ??
    "dataset:live";
  const selectedResultNodeId =
    input.resultsWorkspace.activeResultNodeId ??
    existingViewportDocument?.selectedResultNodeId ??
    null;
  return {
    version: "workspace_graph.v2",
    project: {
      id: "project:active",
      label: input.projectLabel,
    },
    studyPipeline: input.studyPipeline,
    studyNodes,
    solutions: [
      {
        id: liveSolutionId,
        label: "Live Solution",
        sourceStudyId: inferredStudyId,
        revision: input.scalarRows.length > 0 ? input.scalarRows.length : null,
        kind: inferSolutionKind(requestedQuantityId),
        status: "available",
      },
    ],
    datasets: [
      {
        id: inferredDatasetId,
        label: input.resultsWorkspace.datasets[0]?.label ?? "Live Dataset",
        sourceStudyId: inferredStudyId,
        sourceSolutionId: input.resultsWorkspace.datasets[0]?.sourceSolutionId ?? liveSolutionId,
        quantityIds: quantityFrames.filter((q) => q.available).map((q) => q.quantityId),
        scalarCount: input.scalarRows.length > 0 ? Object.keys(input.scalarRows[input.scalarRows.length - 1] ?? {}).length : 0,
        sampleCount: input.scalarRows.length,
        kind: input.resultsWorkspace.datasets[0] ? "analysis" : "live",
      },
      ...input.resultsWorkspace.datasets
        .filter((dataset) => dataset.id !== inferredDatasetId)
        .map((dataset) => ({
          id: dataset.id,
          label: dataset.label,
          sourceStudyId: dataset.sourceStudyId,
          sourceSolutionId: dataset.sourceSolutionId,
          quantityIds: [],
          scalarCount: 0,
          sampleCount: dataset.sampleCount,
          kind: dataset.hasFinalState ? "artifact" as const : "analysis" as const,
        })),
    ],
    derivedValues: input.resultsWorkspace.derivedValues.length > 0
      ? input.resultsWorkspace.derivedValues.map((entry) => ({
          id: entry.id,
          label: entry.label,
          quantityId: entry.quantityId,
          sourceDatasetId: entry.sourceDatasetId,
          latestValue: entry.latestValue,
          unit: entry.unit ?? null,
        }))
      : quantityFrames
          .filter((q) => q.shape === "global_scalar")
          .slice(0, 8)
          .map((q) => {
            const latestRow = input.scalarRows[input.scalarRows.length - 1];
            const latestValueRaw = latestRow ? Reflect.get(latestRow, q.quantityId) : undefined;
            return {
              id: `derived:${q.quantityId}`,
              label: q.label,
              quantityId: q.quantityId,
              sourceDatasetId: inferredDatasetId,
              latestValue: typeof latestValueRaw === "number" ? latestValueRaw : null,
              unit: q.unit,
            };
          }),
    resultsWorkspace: input.resultsWorkspace,
    quantityFrames,
    viewportDocuments: {
      ...(previousSnapshot?.viewportDocuments ?? {}),
      [activeViewportDocumentId ?? "viewport:default"]: {
        id: activeViewportDocumentId ?? "viewport:default",
        workspaceMode: input.workspaceMode,
        tabId: activeTabId,
        viewMode: input.viewMode,
        quantityId: requestedQuantityId ?? existingViewportDocument?.quantityId ?? null,
        component: input.requestedPreviewComponent ?? existingViewportDocument?.component ?? null,
        plane: input.plane ?? existingViewportDocument?.plane ?? null,
        sliceIndex: input.sliceIndex ?? existingViewportDocument?.sliceIndex ?? null,
        selectedDatasetId,
        selectedResultNodeId,
        renderMode: input.renderMode ?? existingViewportDocument?.renderMode ?? null,
        camera: existingViewportDocument?.camera ?? null,
        overlayToggles: {
          telemetryHudVisible: existingViewportDocument?.overlayToggles.telemetryHudVisible ?? true,
          previewNoticesVisible: existingViewportDocument?.overlayToggles.previewNoticesVisible ?? true,
        },
      },
    },
    workspaceTabs: input.workspaceTabs,
    activeWorkspaceTabByStage: input.activeWorkspaceTabByStage,
    selection: {
      activeNodeId: input.selectedNodeId ?? previousSnapshot?.selection.activeNodeId ?? null,
      activeResultNodeId: selectedResultNodeId,
      activeViewportDocumentId,
    },
    // Scalar samples belong to the runtime/data-plane stores, not the workspace
    // graph. Keep the field as an empty compatibility shim so graph snapshots
    // do not carry high-frequency live sample payloads.
    scalarRows: [],
    updatedAt: Date.now(),
  };
}
