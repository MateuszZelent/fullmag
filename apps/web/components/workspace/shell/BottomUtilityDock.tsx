"use client";

import type { ActivityInfo } from "@/components/runs/control-room/types";
import LiveDock from "@/components/workspace/docks/LiveDock";
import ProgressDock from "@/components/workspace/docks/ProgressDock";

interface BottomUtilityDockProps {
  activity: ActivityInfo | null;
  workspaceStatus: string;
  effectiveStep: number;
  effectiveTime: number;
  effectiveDt: number;
  effectiveDmDt: number;
  stepsPerSec: number;
  hasSolverTelemetry: boolean;
}

export default function BottomUtilityDock(props: BottomUtilityDockProps) {
  return (
    <div className="flex h-full flex-col bg-card/35 isolate overflow-hidden relative z-40 border-t border-border/30">
      <div className="grid grid-cols-1 gap-2 p-2 md:grid-cols-2">
        <LiveDock
          workspaceStatus={props.workspaceStatus}
          effectiveStep={props.effectiveStep}
          effectiveTime={props.effectiveTime}
          effectiveDt={props.effectiveDt}
          effectiveDmDt={props.effectiveDmDt}
          stepsPerSec={props.stepsPerSec}
          hasSolverTelemetry={props.hasSolverTelemetry}
        />
        <ProgressDock label={props.activity?.label ?? "Progress"} detail={props.activity?.detail ?? null} />
      </div>
    </div>
  );
}
