"use client";

import { useEffect, useState } from "react";

import { Button } from "@/shared/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";

import {
  consentCopy,
  projectCreateState,
  scriptHashPrefix,
  type ProjectCreator,
  type ScriptProjectSource,
} from "../model/scriptProject";

export interface CreateProjectActionProps {
  /** The script to turn into a project; null when none is available. */
  readonly source: ScriptProjectSource | null;
  /** Null where the project document service is missing. */
  readonly creator: ProjectCreator | null;
  readonly label?: string;
  readonly variant?: "primary" | "secondary";
  readonly size?: "sm" | "md";
  readonly className?: string;
  /** Extra reason that keeps the action off (for example a running save). */
  readonly disabled?: boolean;
}

/**
 * "Create project" for a script. The click only opens the consent prompt:
 * the script runs, and the project is created, when the person confirms there.
 * A failure keeps the prompt open with the API's message; nothing is kept.
 */
export function CreateProjectAction({
  source,
  creator,
  label = "Create project…",
  variant = "primary",
  size = "md",
  className,
  disabled = false,
}: CreateProjectActionProps) {
  const state = projectCreateState(source, creator);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);

  const text = source?.text ?? null;
  useEffect(() => {
    if (!open || text === null) return;
    let cancelled = false;
    void scriptHashPrefix(text).then((prefix) => {
      if (!cancelled) setHash(prefix);
    });
    return () => {
      cancelled = true;
    };
  }, [open, text]);

  const confirm = async () => {
    if (!source || !creator) return;
    setBusy(true);
    setFailure(null);
    const outcome = await creator(source);
    setBusy(false);
    if (outcome.kind === "failed") {
      setFailure(outcome.message);
      return;
    }
    setOpen(false);
  };

  const copy = source ? consentCopy(source, hash) : null;

  return (
    <>
      <Button
        className={className}
        disabled={!state.available || disabled}
        onClick={() => {
          setFailure(null);
          setHash(null);
          setOpen(true);
        }}
        size={size}
        title={state.reason ?? undefined}
        type="button"
        variant={variant}
      >
        {label}
      </Button>
      <Dialog
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
        open={open && copy !== null}
      >
        {copy ? (
          <DialogContent aria-describedby="fm-start-project-consent-body">
            <DialogHeader>
              <DialogTitle>{copy.title}</DialogTitle>
              <DialogDescription id="fm-start-project-consent-body">{copy.body}</DialogDescription>
            </DialogHeader>
            <div className="fm-dialog__body">
              <dl className="fm-start-kv__grid">
                {copy.facts.map((fact) => (
                  <div className="fm-start-kv__row" key={fact.label}>
                    <dt>{fact.label}</dt>
                    <dd>{fact.value}</dd>
                  </div>
                ))}
              </dl>
              <div aria-live="polite" role="status">
                {failure ? (
                  <p className="fm-start-notice fm-start-notice--warning" role="alert">
                    {failure}
                  </p>
                ) : null}
              </div>
            </div>
            <DialogFooter>
              <Button disabled={busy} onClick={() => setOpen(false)} type="button" variant="ghost">
                Cancel
              </Button>
              <Button disabled={busy} onClick={() => void confirm()} type="button" variant="primary">
                {busy ? "Running the script…" : copy.confirmLabel}
              </Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}
