"use client";

import type { StudyPipelineDiagnostic } from "@/lib/study-builder/types";

interface ValidationPanelProps {
  diagnostics: StudyPipelineDiagnostic[];
}

export default function ValidationPanel({ diagnostics }: ValidationPanelProps) {
  return (
    <div className="rounded-lg border border-border/40 bg-background/35 p-3">
      <div className="text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        Validation
      </div>
      <div className="mt-1 text-sm font-semibold text-foreground">Pipeline diagnostics</div>
      {diagnostics.length === 0 ? (
        <div className="mt-2 rounded border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-2 text-[0.72rem] text-emerald-300">
          No validation issues.
        </div>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          {diagnostics.map((item) => (
            <div
              key={item.id}
              className={`rounded border px-2.5 py-2 text-[0.72rem] ${
                item.severity === "error"
                  ? "border-rose-500/25 bg-rose-500/10 text-rose-200"
                  : item.severity === "warning"
                    ? "border-amber-500/25 bg-amber-500/10 text-amber-200"
                    : "border-sky-500/25 bg-sky-500/10 text-sky-200"
              }`}
            >
              <div>{item.message}</div>
              {item.suggestion ? (
                <div className="mt-1 text-[0.68rem] opacity-85">{item.suggestion}</div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
