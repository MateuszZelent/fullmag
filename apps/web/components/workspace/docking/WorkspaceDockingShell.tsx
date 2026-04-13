"use client";
/* eslint-disable react-hooks/set-state-in-effect */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Layout as FlexLayout,
  Model,
  TabNode,
  type Action,
  type IJsonModel,
} from "flexlayout-react";

import { useCommand, useTransport, useViewport } from "@/components/runs/control-room/context-hooks";
import RunSidebar from "@/components/runs/control-room/RunSidebar";
import BottomUtilityDock from "@/components/workspace/shell/BottomUtilityDock";
import EmptyState from "@/components/ui/EmptyState";
import {
  AnalyzeRightInspector,
  BuildRightInspector,
  StudyRightInspector,
} from "@/components/workspace/modes/WorkspaceModeInspectors";
import {
  type DockLayoutModel,
  type WorkspaceMode,
  useWorkspaceStore,
} from "@/lib/workspace/workspace-store";

import DockCenterTabs from "./DockCenterTabs";
import {
  createDefaultDockLayout,
  resolveDockResponsivePreset,
  type DockResponsivePreset,
} from "./dockLayoutDefaults";

function parseDockLayout(model: DockLayoutModel | null, preset: DockResponsivePreset): IJsonModel {
  if (model) {
    try {
      return model as unknown as IJsonModel;
    } catch {
      return createDefaultDockLayout(preset);
    }
  }
  return createDefaultDockLayout(preset);
}

function RightInspectorPanel() {
  const vp = useViewport();
  if (vp.workspaceMode === "build") return <BuildRightInspector />;
  if (vp.workspaceMode === "study") return <StudyRightInspector />;
  return <AnalyzeRightInspector />;
}

export default function WorkspaceDockingShell() {
  const currentStage = useWorkspaceStore((state) => state.currentStage);
  const stageLayout = useWorkspaceStore((state) => state.dockLayoutByStage[state.currentStage]);
  const setDockLayout = useWorkspaceStore((state) => state.setDockLayout);

  const cmd = useCommand();
  const tp = useTransport();

  const [viewportWidth, setViewportWidth] = useState(1920);
  const responsivePreset = resolveDockResponsivePreset(viewportWidth);

  const stageRef = useRef<WorkspaceMode>(currentStage);
  const presetRef = useRef<DockResponsivePreset>(responsivePreset);

  const [model, setModel] = useState<Model>(() =>
    Model.fromJson(parseDockLayout(stageLayout, responsivePreset)),
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => setViewportWidth(window.innerWidth);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    const stageChanged = stageRef.current !== currentStage;
    const presetChanged = presetRef.current !== responsivePreset;
    if (stageChanged || (!stageLayout && presetChanged)) {
      setModel(Model.fromJson(parseDockLayout(stageLayout, responsivePreset)));
      stageRef.current = currentStage;
      presetRef.current = responsivePreset;
    }
  }, [currentStage, responsivePreset, stageLayout]);

  const onModelChange = useCallback(
    (nextModel: Model, action: Action) => {
      void action;
      const serialized = nextModel.toJson() as unknown as DockLayoutModel;
      setDockLayout(currentStage, serialized);
    },
    [currentStage, setDockLayout],
  );

  const factory = useCallback(
    (node: TabNode) => {
      const component = node.getComponent();
      if (component === "dock-left") {
        return (
          <div className="h-full min-h-0 min-w-0 overflow-hidden">
            <RunSidebar />
          </div>
        );
      }
      if (component === "dock-center") {
        return (
          <div className="h-full min-h-0 min-w-0 overflow-hidden">
            <DockCenterTabs />
          </div>
        );
      }
      if (component === "dock-right") {
        return (
          <div className="h-full min-h-0 min-w-0 overflow-hidden border-l border-border/20 bg-background/45">
            <RightInspectorPanel />
          </div>
        );
      }
      if (component === "dock-bottom") {
        return (
          <BottomUtilityDock
            activity={cmd.activity}
            workspaceStatus={cmd.workspaceStatus}
            effectiveStep={tp.effectiveStep}
            effectiveTime={tp.effectiveTime}
            effectiveDt={tp.effectiveDt}
            effectiveDmDt={tp.effectiveDmDt}
            effectiveHEff={tp.effectiveHEff}
            stepsPerSec={tp.stepsPerSec}
            elapsed={tp.elapsed}
            hasSolverTelemetry={tp.hasSolverTelemetry}
            eTotal={tp.effectiveETotal}
            activityDetail={cmd.activity?.detail ?? null}
          />
        );
      }

      return (
        <div className="flex h-full items-center justify-center p-4">
          <EmptyState
            title="Unknown dock panel"
            description={`No factory handler for component: ${component ?? "undefined"}`}
            tone="warning"
            compact
          />
        </div>
      );
    },
    [
      cmd.activity,
      cmd.workspaceStatus,
      tp.effectiveDmDt,
      tp.effectiveDt,
      tp.effectiveStep,
      tp.effectiveTime,
      tp.effectiveHEff,
      tp.effectiveETotal,
      tp.elapsed,
      tp.hasSolverTelemetry,
      tp.stepsPerSec,
    ],
  );

  const classNameMapper = useCallback((className: string) => `workspace-docking ${className}`, []);

  const modelKey = useMemo(
    () => `${currentStage}:${responsivePreset}`,
    [currentStage, responsivePreset],
  );

  return (
    <div className="relative h-full min-h-0 min-w-0 overflow-hidden bg-background">
      <FlexLayout
        key={modelKey}
        model={model}
        factory={factory}
        classNameMapper={classNameMapper}
        onModelChange={onModelChange}
      />
    </div>
  );
}
