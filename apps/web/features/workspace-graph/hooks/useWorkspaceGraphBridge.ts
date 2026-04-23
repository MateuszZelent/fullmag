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

function buildWorkspaceGraphBridgeSignature(input: WorkspaceGraphBridgeInput): string {
  const lastScalarRow = input.scalarRows.length > 0
    ? input.scalarRows[input.scalarRows.length - 1]
    : null;
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
      analyze: input.workspaceTabs.analyze.map((tab) => tab.id),
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
        sampleCount: entry.sampleCount,
        hasFinalState: entry.hasFinalState,
      })),
      derivedValues: input.resultsWorkspace.derivedValues.map((entry) => ({
        id: entry.id,
        latestValue: entry.latestValue,
      })),
    },
    quantities: input.quantities.map((quantity) => ({
      id: quantity.id,
      available: quantity.available,
      kind: quantity.kind ?? null,
    })),
    scalarRowsLength: input.scalarRows.length,
    scalarRowsLast: lastScalarRow,
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
