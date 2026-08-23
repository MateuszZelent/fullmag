"use client";

import { useState, type ReactNode } from "react";

import {
  MODEL_SCENE_PATH,
  SESSIONS_PATH,
  SESSION_CURRENT_PATH,
} from "../api/apiPaths";
import { useKernel } from "../KernelContext";
import { SESSION_STATUS_RESOURCE_KEY } from "../resources/useSessionStatus";
import { Button } from "@/shared/ui/Button";
import { Checkbox } from "@/shared/ui/Checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/Dialog";
import { Input } from "@/shared/ui/Input";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";

type Backend = "fdm" | "fem";

export function NewProblemDialog({
  hasActiveSession,
  onOpenChange,
  open,
}: {
  readonly hasActiveSession: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
}) {
  const kernel = useKernel();
  const [backend, setBackend] = useState<Backend>("fdm");
  const [name, setName] = useState("Untitled problem");
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setPending(true);
    setError(null);
    try {
      const response = await kernel.api.sessions.create({
        backend,
        device: "cpu",
        name,
        precision: "double",
        replace_current: hasActiveSession,
      });
      const revision = response.revisions.state_version;
      kernel.resources.invalidate(SESSIONS_PATH, revision);
      kernel.resources.invalidate(SESSION_STATUS_RESOURCE_KEY, revision);
      kernel.resources.invalidatePrefix(SESSION_CURRENT_PATH, revision);
      kernel.resources.invalidate(MODEL_SCENE_PATH, revision);
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create the simulation.");
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby="fm-new-problem-description">
        <DialogHeader>
          <DialogTitle>New Problem</DialogTitle>
          <DialogDescription id="fm-new-problem-description">
            Create an empty canonical simulation problem.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <label className="grid gap-1.5 font-fm-ui text-fm-control text-fm-secondary" htmlFor="fm-new-problem-name">
            Name
            <Input disabled={pending} id="fm-new-problem-name" value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <Selection label="Discretization">
            <SegmentedControl aria-label="Discretization" disabled={pending} options={[{ label: "FDM", value: "fdm" }, { label: "FEM", value: "fem" }]} value={backend} onValueChange={setBackend} />
          </Selection>
          <Selection label="Device">
            <SegmentedControl aria-label="Device" disabled options={[{ label: "CPU", value: "cpu" }]} value="cpu" onValueChange={() => undefined} />
          </Selection>
          <Selection label="Precision">
            <SegmentedControl aria-label="Precision" disabled options={[{ label: "Double", value: "double" }]} value="double" onValueChange={() => undefined} />
          </Selection>
          {hasActiveSession ? (
            <label className="flex items-start gap-2 text-fm-control text-fm-secondary">
              <Checkbox checked={replaceConfirmed} disabled={pending} onChange={(event) => setReplaceConfirmed(event.target.checked)} />
              Replace the active session. Its unsaved workspace state will be lost.
            </label>
          ) : null}
          {error ? <p className="text-fm-control text-fm-danger" role="alert">{error}</p> : null}
        </div>
        <DialogFooter>
          <DialogClose asChild><Button disabled={pending} size="sm" type="button" variant="ghost">Cancel</Button></DialogClose>
          <Button disabled={pending || !name.trim() || (hasActiveSession && !replaceConfirmed)} size="sm" type="button" onClick={create}>{pending ? "Creating…" : "Create"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Selection({ children, label }: { readonly children: ReactNode; readonly label: string }) {
  return <div className="grid gap-1.5"><span className="font-fm-ui text-fm-control text-fm-secondary">{label}</span>{children}</div>;
}
