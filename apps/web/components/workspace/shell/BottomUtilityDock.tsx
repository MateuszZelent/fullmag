"use client";

import EngineConsole from "@/components/panels/EngineConsole";
import type {
  ArtifactEntry,
  CommandStatus,
  EngineLogEntry,
  LiveState,
  MeshWorkspaceState,
  QuantityDescriptor,
  RunManifest,
  ScalarRow,
  SessionManifest,
} from "@/lib/useSessionStream";
import type { ActivityInfo } from "@/components/runs/control-room/types";
import JobsDock from "@/components/workspace/docks/JobsDock";
import ProgressDock from "@/components/workspace/docks/ProgressDock";
import LogDock from "@/components/workspace/docks/LogDock";
import ChartsDock from "@/components/workspace/docks/ChartsDock";
import ProblemsDock from "@/components/workspace/docks/ProblemsDock";

interface BottomUtilityDockProps {
  session: SessionManifest | null;
  run: RunManifest | null;
  liveState: LiveState | null;
  scalarRows: ScalarRow[];
  engineLog: EngineLogEntry[];
  artifacts: ArtifactEntry[];
  quantities: QuantityDescriptor[];
  connection: "connecting" | "connected" | "disconnected";
  error: string | null;
  convergenceThreshold: number;
  commandStatus: CommandStatus | null;
  commandBusy: boolean;
  commandMessage: string | null;
  activity: ActivityInfo | null;
  meshWorkspace: MeshWorkspaceState | null;
  workspaceStatus: string;
}

export default function BottomUtilityDock(props: BottomUtilityDockProps) {
  return (
    <div className="flex h-full flex-col bg-card/35 isolate overflow-hidden relative z-40 border-t border-border/30">
      <div className="grid grid-cols-1 gap-2 border-b border-border/20 p-2 md:grid-cols-5">
        <ProgressDock label={props.activity?.label ?? "Progress"} detail={props.activity?.detail ?? null} />
        <JobsDock status={props.workspaceStatus} commandMessage={props.commandMessage} />
        <ChartsDock scalarRowCount={props.scalarRows.length} />
        <LogDock engineLog={props.engineLog} />
        <ProblemsDock error={props.error} />
      </div>
      <div className="flex-1 min-h-0">
        <EngineConsole
          session={props.session}
          run={props.run}
          liveState={props.liveState}
          scalarRows={props.scalarRows}
          engineLog={props.engineLog}
          artifacts={props.artifacts}
          quantities={props.quantities}
          connection={props.connection}
          error={props.error}
          presentationMode="current"
          convergenceThreshold={props.convergenceThreshold}
          commandStatus={props.commandStatus}
          commandBusy={props.commandBusy}
          commandMessage={props.commandMessage}
          activity={props.activity}
          meshWorkspace={props.meshWorkspace}
        />
      </div>
    </div>
  );
}
