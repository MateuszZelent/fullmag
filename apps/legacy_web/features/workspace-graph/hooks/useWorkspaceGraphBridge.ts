"use client";

import { useEffect, useRef } from "react";
import { createWorkspaceGraphSnapshot } from "../model/createWorkspaceGraphSnapshot";
import type { WorkspaceGraphBridgeInput } from "../model/types";
import { useWorkspaceGraphStore } from "../store/useWorkspaceGraphStore";
import type { StudyPipelineDocument, StudyPipelineNode } from "@/lib/study-builder/types";

function flattenStudyPipelineNodes(nodes: StudyPipelineNode[]): Array<{
  id: string;
  enabled: boolean;
  kind: string;
}> {
  const result: Array<{ id: string; enabled: boolean; kind: string }> = [];
  const walk = (list: StudyPipelineNode[]) => {
    for (const node of list) {
      result.push({
        id: node.id,
        enabled: node.enabled,
        kind: node.node_kind === "primitive" ? node.stage_kind : node.node_kind,
      });
      if (node.node_kind === "group") {
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return result;
}

function signatureForStudyPipeline(
  studyPipeline: StudyPipelineDocument | null,
): Array<{ id: string; enabled: boolean; kind: string }> | null {
  if (!studyPipeline) {
    return null;
  }
  return flattenStudyPipelineNodes(studyPipeline.nodes);
}

export function buildWorkspaceGraphBridgeSignature(input: WorkspaceGraphBridgeInput): string {
  return JSON.stringify({
    enabled: input.enabled !== false,
    projectLabel: input.projectLabel,
    workspaceMode: input.workspaceMode,
    viewMode: input.viewMode,
    renderMode: input.renderMode,
    selectedNodeId: input.selectedNodeId,
    requestedPreviewQuantity: input.requestedPreviewQuantity,
    requestedPreviewComponent: input.requestedPreviewComponent,
    plane: input.plane,
    sliceIndex: input.sliceIndex,
    workspaceTabs: {
      build: input.workspaceTabs.build.map((tab) => tab.id),
      study: input.workspaceTabs.study.map((tab) => tab.id),
    },
    activeWorkspaceTabByStage: input.activeWorkspaceTabByStage,
    studyPipeline: signatureForStudyPipeline(input.studyPipeline),
    resultsWorkspace: {
      activeResultNodeId: input.resultsWorkspace.activeResultNodeId,
      solutions: input.resultsWorkspace.solutions.map((entry) => ({
        id: entry.id,
        revision: entry.revision,
        status: entry.status,
      })),
      datasets: input.resultsWorkspace.datasets.map((entry) => ({
        id: entry.id,
        hasFinalState: entry.hasFinalState,
      })),
      derivedValues: input.resultsWorkspace.derivedValues.map((entry) => ({
        id: entry.id,
        quantityId: entry.quantityId,
        sourceDatasetId: entry.sourceDatasetId,
      })),
    },
    quantities: input.quantities.map((quantity) => ({
      id: quantity.id,
      available: quantity.available,
      kind: quantity.kind ?? null,
    })),
  });
}

export function useWorkspaceGraphBridge(input: WorkspaceGraphBridgeInput): void {
  const applySnapshot = useWorkspaceGraphStore((state) => state.applySnapshot);
  const latestInputRef = useRef(input);
  const bridgeEnabled = input.enabled !== false;
  const signature = buildWorkspaceGraphBridgeSignature(input);

  useEffect(() => {
    latestInputRef.current = input;
  }, [input]);

  useEffect(() => {
    if (!bridgeEnabled) {
      return;
    }
    const latestInput = latestInputRef.current;
    applySnapshot(
      createWorkspaceGraphSnapshot(latestInput, useWorkspaceGraphStore.getState().snapshot),
      signature,
    );
  }, [applySnapshot, bridgeEnabled, signature]);
}
