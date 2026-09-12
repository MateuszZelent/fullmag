"use client";

import type { ScriptBuilderStageState } from "@/lib/session/types";
import { summarizeMaterializedStage } from "@/lib/study-builder/summaries";

interface MaterializedStagesPanelProps {
  stages: ScriptBuilderStageState[];
}

export default function MaterializedStagesPanel({ stages }: MaterializedStagesPanelProps) {
  return (
    <div className="rounded-lg border border-border/40 bg-background/35 p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Materialized Backend Stages
          </div>
          <div className="mt-1 text-sm font-semibold text-foreground">Compiled stage sequence</div>
        </div>
        <div className="text-[0.65rem] uppercase tracking-[0.14em] text-muted-foreground">
          {stages.length} total
        </div>
      </div>
      <div className="mt-2 flex flex-col gap-2">
        {stages.length === 0 ? (
          <div className="text-[0.7rem] text-muted-foreground">No backend stages generated yet.</div>
        ) : (
          stages.map((stage, index) => (
            <div key={`${stage.kind}-${index}-${stage.entrypoint_kind}`} className="rounded border border-border/30 px-2.5 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[0.72rem] font-semibold text-foreground">
                  {index + 1}. {stage.kind}
                </span>
                <span className="text-[0.6rem] uppercase tracking-[0.14em] text-muted-foreground">
                  {stage.entrypoint_kind || stage.kind}
                </span>
              </div>
              <div className="mt-1 text-[0.68rem] text-muted-foreground">
                {summarizeMaterializedStage(stage) || "No additional parameters"}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
