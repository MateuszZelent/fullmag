"use client";

import type { AnalyzeMeshSemanticsSummary } from "./useAnalyzeRuntimeDiagnostics";

export default function AnalyzeMeshSemanticsPanel({
  summary,
}: {
  summary: AnalyzeMeshSemanticsSummary;
}) {
  return (
    <section className="rounded-xl border border-border/35 bg-card/40 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[0.74rem] font-semibold text-foreground/85">Mesh Semantics</h3>
        <span className="text-[0.62rem] uppercase tracking-[0.16em] text-muted-foreground">
          solver-aware
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded-lg border border-border/25 bg-background/35 px-3 py-2">
          <div className="text-[0.62rem] uppercase tracking-[0.16em] text-muted-foreground">magnetic</div>
          <div className="mt-1 text-lg font-semibold text-foreground/90">{summary.magneticPartCount}</div>
        </div>
        <div className="rounded-lg border border-border/25 bg-background/35 px-3 py-2">
          <div className="text-[0.62rem] uppercase tracking-[0.16em] text-muted-foreground">air</div>
          <div className="mt-1 text-lg font-semibold text-foreground/90">{summary.hasAir ? "yes" : "no"}</div>
        </div>
        <div className="rounded-lg border border-border/25 bg-background/35 px-3 py-2">
          <div className="text-[0.62rem] uppercase tracking-[0.16em] text-muted-foreground">interfaces</div>
          <div className="mt-1 text-lg font-semibold text-foreground/90">{summary.interfacePartCount}</div>
        </div>
      </div>
      <p className="mt-3 text-[0.68rem] leading-5 text-muted-foreground">{summary.contractLabel}</p>
    </section>
  );
}
