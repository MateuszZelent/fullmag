"use client";

import { Check, Focus, RotateCcw } from "lucide-react";
import { useId, useRef, useState } from "react";

import { Button } from "@/shared/ui/Button";
import { inspectorActionState, useInspectorEditSession } from "./InspectorEditSession";

/** Only expose actions with a real owner. Live preferences never need Apply. */
export function InspectorFooter({
  focusDisabled = false,
  onFocus,
}: {
  focusDisabled?: boolean;
  onFocus: () => void;
}) {
  const session = useInspectorEditSession();
  const actions = inspectorActionState(session);
  const staged = session?.mode === "staged";
  const live = session?.mode === "liveViewport";
  const reasonId = useId();
  const [operation, setOperation] = useState<"apply" | "reset" | null>(null);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const busy = operation !== null || !!session?.applying;
  const message = session?.lockReason
    ?? (staged ? actions.applyReason ?? "Draft ready to apply"
      : live ? "Display changes apply immediately"
      : session?.mode === "immediate" ? "Use the actions in this panel"
      : "No staged edits in this view");
  const modeLabel = staged ? "Draft" : live ? "Live" : session?.mode === "immediate" ? "Immediate" : null;

  async function run(action: "apply" | "reset") {
    if (!session || inFlight.current || busy || (action === "apply" ? !actions.canApply : !actions.canReset)) return;
    const owner = session;
    inFlight.current = true;
    setOperation(action);
    setError(null);
    try {
      if (action === "apply") {
        if (!(await owner.apply())) setError("Apply did not finish. Review the panel before trying again.");
      } else {
        await owner.reset();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Inspector action failed. Try again.");
    } finally {
      inFlight.current = false;
      setOperation(null);
    }
  }

  return (
    <footer className="fm-inspector__action-bar" data-edit-mode={session?.mode ?? "none"}>
      <div className="fm-inspector__action-controls">
        {!focusDisabled ? (
          <Button className="fm-inspector__action-btn" size="sm" type="button" variant="secondary" onClick={onFocus}>
            <Focus size={14} aria-hidden="true" /> Fit view
          </Button>
        ) : null}
        {staged || live ? (
          <Button
            aria-describedby={reasonId}
            className="fm-inspector__action-btn"
            disabled={!actions.canReset || busy}
            size="sm"
            type="button"
            variant="secondary"
            onClick={() => void run("reset")}
          >
            <RotateCcw size={14} aria-hidden="true" />
            {operation === "reset" ? "Reverting…" : staged ? "Revert" : "Reset display"}
          </Button>
        ) : null}
        {staged ? (
          <Button
            aria-describedby={reasonId}
            className="fm-inspector__action-btn fm-inspector__action-btn--apply"
            disabled={!actions.canApply || busy}
            size="sm"
            type="button"
            variant="primary"
            onClick={() => void run("apply")}
          >
            <Check size={14} aria-hidden="true" /> {session?.applying || operation === "apply" ? "Applying…" : "Apply"}
          </Button>
        ) : null}
      </div>
      <p className="fm-inspector__action-reason" id={reasonId}>
        {modeLabel ? <><strong>{modeLabel}</strong> · </> : null}{message}
      </p>
      {error ? <p className="fm-inspector__action-error" role="alert">{error}</p> : null}
    </footer>
  );
}
