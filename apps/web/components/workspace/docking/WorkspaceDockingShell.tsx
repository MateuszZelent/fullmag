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

import { useCommand, useModel, useTransport, useViewport } from "@/components/runs/control-room/context-hooks";
import RunSidebar from "@/components/runs/control-room/RunSidebar";
import BottomUtilityDock from "@/components/workspace/shell/BottomUtilityDock";
import ChartsDock from "@/components/workspace/docks/ChartsDock";
import EmptyState from "@/components/ui/EmptyState";
import { TooltipProvider } from "@/components/ui/tooltip";
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
      const candidate = model as Partial<IJsonModel>;
      if (candidate.layout && typeof candidate.layout === "object") {
        return candidate as IJsonModel;
      }
      return createDefaultDockLayout(preset);
    } catch {
      return createDefaultDockLayout(preset);
    }
  }
  return createDefaultDockLayout(preset);
}

function parsePositiveNumber(value: string): number | null {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isPositiveFinite(value: number | null | undefined): boolean {
  return Number.isFinite(value) && value > 0;
}

function resolveFiniteMin(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.min(...values);
}

function resolveFiniteMax(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.max(...values);
}

function RightInspectorPanel() {
  const vp = useViewport();
  if (vp.workspaceMode === "build") return <BuildRightInspector />;
  if (vp.workspaceMode === "study") return <StudyRightInspector />;
  return <AnalyzeRightInspector />;
}

export default function WorkspaceDockingShell() {
  const currentStage = useWorkspaceStore((state) => state.currentStage);
  const stageLayouts = useWorkspaceStore((state) => state.dockLayoutByStage[state.currentStage]);
  const setDockLayout = useWorkspaceStore((state) => state.setDockLayout);

  const cmd = useCommand();
  const modelState = useModel();
  const tp = useTransport();
  const solverIntegrator =
    modelState.solverPlan?.integrator ?? modelState.solverSettings.integrator;
  const solverAdaptiveDtMin = modelState.solverPlan?.adaptive?.dtMin;
  const solverAdaptiveDtMax = modelState.solverPlan?.adaptive?.dtMax;
  const fixedDtFromPlan = modelState.solverPlan?.fixedTimestep;
  const fixedDtFromSettings = parsePositiveNumber(modelState.solverSettings.fixedTimestep);
  const fixedDt = useMemo(() => {
    if (typeof fixedDtFromPlan === "number" && Number.isFinite(fixedDtFromPlan) && fixedDtFromPlan > 0) {
      return fixedDtFromPlan;
    }
    return fixedDtFromSettings;
  }, [fixedDtFromPlan, fixedDtFromSettings]);
  const solverDtSamples = useMemo(
    () =>
      tp.scalarRows
        .slice(-128)
        .map((row) => row.solver_dt)
        .filter(isPositiveFinite),
    [tp.scalarRows],
  );
  const solverMinDt = useMemo(() => {
    if (!tp.hasSolverTelemetry) return null;
    return isPositiveFinite(solverAdaptiveDtMin)
      ? solverAdaptiveDtMin
      : resolveFiniteMin(solverDtSamples);
  }, [solverAdaptiveDtMin, tp.hasSolverTelemetry, solverDtSamples]);
  const solverMaxDt = useMemo(() => {
    if (!tp.hasSolverTelemetry) return null;
    return isPositiveFinite(solverAdaptiveDtMax)
      ? solverAdaptiveDtMax
      : resolveFiniteMax(solverDtSamples);
  }, [solverAdaptiveDtMax, tp.hasSolverTelemetry, solverDtSamples]);

  const [viewportWidth, setViewportWidth] = useState(1920);
  const responsivePreset = resolveDockResponsivePreset(viewportWidth);
  const stageLayout = stageLayouts[responsivePreset];

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
    if (stageChanged || presetChanged) {
      setModel(Model.fromJson(parseDockLayout(stageLayout, responsivePreset)));
      stageRef.current = currentStage;
      presetRef.current = responsivePreset;
    }
  }, [currentStage, responsivePreset, stageLayout]);

  const onModelChange = useCallback(
    (nextModel: Model, action: Action) => {
      void action;
      const serialized: DockLayoutModel = { ...nextModel.toJson() };
      setDockLayout(currentStage, responsivePreset, serialized);
    },
    [currentStage, responsivePreset, setDockLayout],
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
          <TooltipProvider delayDuration={250}>
            <div className="h-full min-h-0 min-w-0 overflow-hidden">
              <DockCenterTabs />
            </div>
          </TooltipProvider>
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
        const solverMaxError = (() => {
          const planAtol = modelState.solverPlan?.adaptive?.atol;
          if (typeof planAtol === "number" && Number.isFinite(planAtol)) return planAtol;
          const parsed = Number.parseFloat(modelState.solverSettings.maxError);
          return Number.isFinite(parsed) ? parsed : null;
        })();
        return (
          <div className="flex h-full divide-x divide-border/20 overflow-hidden">
            <div className="flex-1 min-w-0 overflow-hidden">
              <BottomUtilityDock
                activity={cmd.activity}
                workspaceStatus={cmd.workspaceStatus}
                effectiveStep={tp.effectiveStep}
                effectiveTime={tp.effectiveTime}
                effectiveDt={tp.effectiveDt}
                effectiveDmDt={tp.effectiveDmDt}
                effectiveTorqueT={tp.effectiveTorqueT}
                effectiveHEff={tp.effectiveHEff}
                stepsPerSec={tp.stepsPerSec}
                elapsed={tp.elapsed}
                hasSolverTelemetry={tp.hasSolverTelemetry}
                eTotal={tp.effectiveETotal}
                activityDetail={cmd.activity?.detail ?? null}
                solverIntegrator={solverIntegrator}
                solverMaxError={solverMaxError}
                solverMinDt={solverMinDt}
                solverMaxDt={solverMaxDt}
                solverFixedDt={fixedDt}
              />
            </div>
            <div className="w-52 shrink-0 overflow-hidden">
              <ChartsDock />
            </div>
          </div>
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
      fixedDt,
      modelState.solverPlan?.adaptive?.atol,
      solverIntegrator,
      modelState.solverSettings.maxError,
      modelState.solverSettings.fixedTimestep,
      modelState.solverPlan?.fixedTimestep,
      tp.effectiveDmDt,
      tp.effectiveDt,
      tp.effectiveStep,
      tp.effectiveTime,
      tp.effectiveHEff,
      tp.effectiveTorqueT,
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
    <div className="relative h-full w-full min-h-0 min-w-0 overflow-hidden bg-background">
      <TooltipProvider delayDuration={250}>
        <FlexLayout
          key={modelKey}
          model={model}
          factory={factory}
          classNameMapper={classNameMapper}
          onModelChange={onModelChange}
        />
      </TooltipProvider>
    </div>
  );
}
