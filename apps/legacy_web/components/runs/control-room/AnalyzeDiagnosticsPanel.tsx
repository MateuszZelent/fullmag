"use client";

import EmptyState from "@/components/ui/EmptyState";

import AnalyzeMeshSemanticsPanel from "./AnalyzeMeshSemanticsPanel";
import AnalyzeRuntimeBadges from "./AnalyzeRuntimeBadges";
import type { AnalyzeRuntimeDiagnosticsState } from "./useAnalyzeRuntimeDiagnostics";

export default function AnalyzeDiagnosticsPanel({
  diagnostics,
}: {
  diagnostics: AnalyzeRuntimeDiagnosticsState;
}) {
  const hasWarnings = diagnostics.warnings.length > 0;
  const hasError = Boolean(diagnostics.backendError);
  const hasLogs = diagnostics.logExcerpt.length > 0;

  return (
    <div className="flex flex-col gap-3">
      <AnalyzeRuntimeBadges badges={diagnostics.badges} />
      <AnalyzeMeshSemanticsPanel summary={diagnostics.meshSemantics} />

      {hasError && (
        <section className="rounded-xl border border-error/25 bg-error/10 p-3">
          <h3 className="text-[0.74rem] font-semibold text-error/90">Backend Error</h3>
          <p className="mt-2 text-[0.7rem] leading-5 text-error/80">{diagnostics.backendError}</p>
        </section>
      )}

      {hasWarnings && (
        <section className="rounded-xl border border-warning/25 bg-warning/10 p-3">
          <h3 className="text-[0.74rem] font-semibold text-warning/90">Warnings</h3>
          <ul className="mt-2 space-y-1.5 text-[0.7rem] leading-5 text-warning/80">
            {diagnostics.warnings.map((warning, index) => (
              <li key={`${warning}-${index}`}>• {warning}</li>
            ))}
          </ul>
        </section>
      )}

      {hasLogs ? (
        <section className="rounded-xl border border-border/35 bg-card/40 p-3">
          <h3 className="text-[0.74rem] font-semibold text-foreground/85">Recent Runtime Log</h3>
          <div className="mt-2 rounded-lg border border-border/25 bg-background/35 p-2">
            <pre className="max-h-44 overflow-auto whitespace-pre-wrap text-[0.68rem] leading-5 text-muted-foreground">
              {diagnostics.logExcerpt.join("\n")}
            </pre>
          </div>
        </section>
      ) : (
        <EmptyState
          title="No runtime diagnostics"
          description="Runtime warnings and backend log excerpts will appear here when available."
          tone="info"
          compact
        />
      )}
    </div>
  );
}
