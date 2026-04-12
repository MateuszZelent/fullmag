"use client";

import { useCallback, useMemo, useState } from "react";
import type { ScriptBuilderStageState, StudyPipelineDocumentState } from "@/lib/session/types";
import type {
  MaterializedStageMapEntry,
  StudyPipelineDocument,
  StudyPipelineNode,
} from "@/lib/study-builder/types";
import { migrateFlatStagesToStudyPipeline } from "@/lib/study-builder/migrate";
import { materializeStudyPipeline } from "@/lib/study-builder/materialize";
import { buildExecutionMapStatus } from "@/lib/study-builder/execution-map";
import { findNodeById } from "@/lib/study-builder/operations";
import {
  applyPipelineCommand,
  type StudyPipelineCommand,
} from "@/features/study-authoring/commands/pipelineCommands";
import StageBuilderRibbon from "./StageBuilderRibbon";
import PipelineCanvas from "./PipelineCanvas";
import StageInspector from "./StageInspector";
import ValidationPanel from "./ValidationPanel";
import ExecutionStatusPanel from "./ExecutionStatusPanel";
import MaterializedStagesPanel from "./MaterializedStagesPanel";

function findMaterializedEntry(
  entries: MaterializedStageMapEntry[],
  nodeId: string | null,
): MaterializedStageMapEntry | null {
  if (!nodeId) return null;
  for (const entry of entries) {
    if (entry.nodeId === nodeId) return entry;
    if (entry.childEntries?.length) {
      const child = findMaterializedEntry(entry.childEntries, nodeId);
      if (child) return child;
    }
  }
  return null;
}

interface StudyBuilderWorkspaceProps {
  stages: ScriptBuilderStageState[];
  pipeline: StudyPipelineDocumentState | null;
  activeStageIndex: number | null;
  completedStageCount: number;
  onChangeStages: (next: ScriptBuilderStageState[]) => void;
  onChangePipeline: (next: StudyPipelineDocumentState | null) => void;
}

function reorder(nodes: StudyPipelineNode[], nodeId: string, delta: -1 | 1): StudyPipelineNode[] {
  const index = nodes.findIndex((node) => node.id === nodeId);
  if (index < 0) return nodes;
  const target = index + delta;
  if (target < 0 || target >= nodes.length) return nodes;
  const next = [...nodes];
  const [node] = next.splice(index, 1);
  next.splice(target, 0, node);
  return next;
}

export default function StudyBuilderWorkspace({
  stages,
  pipeline,
  activeStageIndex,
  completedStageCount,
  onChangeStages,
  onChangePipeline,
}: StudyBuilderWorkspaceProps) {
  const [document, setDocument] = useState<StudyPipelineDocument>(() =>
    (pipeline as StudyPipelineDocument | null) ?? migrateFlatStagesToStudyPipeline(stages),
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Sync document state with pipeline/stages props during render (React 19 recommended pattern for resets)
  const [prevPipeline, setPrevPipeline] = useState(pipeline);
  const [prevStages, setPrevStages] = useState(stages);

  if (pipeline !== prevPipeline || stages !== prevStages) {
    setPrevPipeline(pipeline);
    setPrevStages(stages);
    setDocument((pipeline as StudyPipelineDocument | null) ?? migrateFlatStagesToStudyPipeline(stages));
  }

  // Derive selection validity during render to avoid secondary effects
  const nodeExists = selectedNodeId ? findNodeById(document.nodes, selectedNodeId) : null;
  const effectiveSelectedNodeId = nodeExists ? selectedNodeId : null;

  const materialized = useMemo(() => materializeStudyPipeline(document), [document]);
  const selectedNode = useMemo(
    () => findNodeById(document.nodes, effectiveSelectedNodeId ?? "") ?? null,
    [document.nodes, effectiveSelectedNodeId],
  );
  const executionEntries = useMemo(
    () => buildExecutionMapStatus(materialized.map, activeStageIndex, completedStageCount),
    [activeStageIndex, completedStageCount, materialized.map],
  );
  const selectedMaterializedEntry = useMemo(
    () => findMaterializedEntry(materialized.map, effectiveSelectedNodeId),
    [effectiveSelectedNodeId, materialized.map],
  );
  const selectedCompiledStages = useMemo(
    () =>
      selectedMaterializedEntry
        ? selectedMaterializedEntry.stageIndexes.map((index) => materialized.stages[index]).filter(Boolean)
        : [],
    [materialized.stages, selectedMaterializedEntry],
  );
  const selectedDiagnostics = useMemo(
    () => materialized.diagnostics.filter((item) => item.nodeId === effectiveSelectedNodeId),
    [effectiveSelectedNodeId, materialized.diagnostics],
  );

  const dispatch = useCallback(
    (cmd: StudyPipelineCommand) => {
      setDocument((prev) => {
        const next = applyPipelineCommand(prev, cmd);
        const mat = materializeStudyPipeline(next);
        onChangeStages(mat.stages);
        onChangePipeline(next);
        return next;
      });
    },
    [onChangeStages, onChangePipeline],
  );

  return (
    <div className="flex flex-col gap-3">
      <StageBuilderRibbon
        onAddPrimitive={(kind, placement) => {
          dispatch({
            type: "stage.add-primitive",
            kind,
            ...(placement !== "append" && selectedNodeId
              ? { anchorId: selectedNodeId, position: placement }
              : {}),
          });
        }}
        onAddMacro={(kind, placement) => {
          dispatch({
            type: "stage.add-macro",
            kind,
            ...(placement !== "append" && selectedNodeId
              ? { anchorId: selectedNodeId, position: placement }
              : {}),
          });
        }}
        selectedNodeId={selectedNodeId}
        onDuplicateSelected={() =>
          selectedNodeId ? dispatch({ type: "stage.duplicate", nodeId: selectedNodeId }) : null
        }
        onToggleSelectedEnabled={() =>
          selectedNodeId ? dispatch({ type: "stage.toggle-enabled", nodeId: selectedNodeId }) : null
        }
      />
      <div className="grid grid-cols-1 gap-3 2xl:grid-cols-[minmax(0,1.2fr)_minmax(24rem,0.9fr)]">
        <div className="min-w-0">
          <PipelineCanvas
            nodes={document.nodes}
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
            onMoveUp={(nodeId) => dispatch({ type: "stage.reorder", nodeId, delta: -1 })}
            onMoveDown={(nodeId) => dispatch({ type: "stage.reorder", nodeId, delta: 1 })}
            onDelete={(nodeId) => dispatch({ type: "stage.delete", nodeId })}
            onDuplicate={(nodeId) => dispatch({ type: "stage.duplicate", nodeId })}
            onToggleEnabled={(nodeId) => dispatch({ type: "stage.toggle-enabled", nodeId })}
            onInsertBeforeRun={(nodeId) => dispatch({ type: "stage.insert-before-run", nodeId })}
            onInsertAfterRun={(nodeId) => dispatch({ type: "stage.insert-after-run", nodeId })}
          />
        </div>
        <div className="flex flex-col gap-3">
          <StageInspector
            node={selectedNode}
            onRename={(value) => {
              if (!selectedNodeId) return;
              dispatch({ type: "stage.rename", nodeId: selectedNodeId, label: value });
            }}
            onToggleEnabled={() => {
              if (!selectedNodeId) return;
              dispatch({ type: "stage.toggle-enabled", nodeId: selectedNodeId });
            }}
            onPatchConfig={(patch) => {
              if (!selectedNodeId) return;
              dispatch({ type: "stage.patch-config", nodeId: selectedNodeId, patch });
            }}
            onPatchNotes={(value) => {
              if (!selectedNodeId) return;
              dispatch({ type: "stage.patch-notes", nodeId: selectedNodeId, notes: value });
            }}
            compiledStages={selectedCompiledStages}
            diagnostics={selectedDiagnostics}
          />
          <ValidationPanel diagnostics={materialized.diagnostics} />
          <MaterializedStagesPanel stages={materialized.stages} />
          <ExecutionStatusPanel entries={executionEntries} />
        </div>
      </div>
    </div>
  );
}
