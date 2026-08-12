"use client";

import { Button } from "@/shared/ui/Button";

import type { AnalysisFieldOverlayContextSnapshot } from "./AnalysisFieldOverlayController";

export function AnalysisFieldOverlayContextNotice({
  context,
  onClear,
  onRebind,
  rebindDisabledReason,
}: {
  context: AnalysisFieldOverlayContextSnapshot;
  onClear: () => void;
  onRebind: () => void;
  rebindDisabledReason: string | null;
}) {
  if (context.status === "compatible" || context.status === "inactive") {
    return null;
  }

  return (
    <section
      className="fm-analysis-overlay-context-notice"
      aria-label="Active Analysis Overlay context warning"
      role="alert"
    >
      <strong className="fm-analysis-overlay-context-notice__title">
        Active Analysis Overlay is not rendered
      </strong>
      <span className="fm-analysis-overlay-context-notice__reason">
        {context.reason}
      </span>
      <div className="fm-analysis-overlay-context-notice__actions">
        <Button size="sm" type="button" variant="secondary" onClick={onClear}>
          Clear
        </Button>
        <Button
          disabled={rebindDisabledReason !== null}
          size="sm"
          title={rebindDisabledReason ?? undefined}
          type="button"
          onClick={onRebind}
        >
          Rebind
        </Button>
      </div>
      {rebindDisabledReason ? (
        <span className="fm-analysis-overlay-context-notice__rebind-reason">
          Rebind unavailable: {rebindDisabledReason}
        </span>
      ) : null}
    </section>
  );
}
