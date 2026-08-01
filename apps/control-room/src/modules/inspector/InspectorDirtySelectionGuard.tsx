"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type { SelectionController } from "@/kernel/selection/SelectionController";
import { selectionRefEquals, type Selection } from "@/kernel/selection/selectionTypes";
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
  useInspectorEditSession,
  type InspectorEditSession,
} from "./InspectorEditSession";

export function shouldGuardInspectorSelection(
  session: InspectorEditSession | null,
): boolean {
  return session?.mode === "staged" && session.dirty;
}

export async function applyInspectorSessionAndShouldContinue(
  session: InspectorEditSession,
): Promise<boolean> {
  return (await session.apply()) === true;
}

function sameSelectionTarget(left: Selection, right: Selection): boolean {
  return left.kind === right.kind
    && left.label === right.label
    && left.nodeId === right.nodeId
    && left.objectId === right.objectId
    && selectionRefEquals(left.ref, right.ref);
}

export function InspectorDirtySelectionGuard({
  children,
  controller,
  selection,
}: {
  children: (selection: Selection) => ReactNode;
  controller: SelectionController;
  selection: Selection;
}) {
  const session = useInspectorEditSession();
  const [pending, setPending] = useState<Selection | null>(null);
  const bypass = useRef<Selection | null>(null);

  useEffect(() => {
    return controller.addChangeGuard((next) => {
      if (bypass.current && sameSelectionTarget(bypass.current, next)) {
        bypass.current = null;
        return true;
      }
      if (!shouldGuardInspectorSelection(session)) return true;
      setPending(next);
      return false;
    });
  }, [controller, session, session?.dirty, session?.mode]);

  const accept = useCallback((next: Selection) => {
    bypass.current = next;
    setPending(null);
    controller.set(next, "inspector");
  }, [controller]);

  return (
    <>
      {children(selection)}
      <Dialog open={pending !== null} onOpenChange={(open) => { if (!open) setPending(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unapplied Inspector changes</DialogTitle>
            <DialogDescription>
              Apply or discard the current draft before changing the Explorer selection.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPending(null)}>Cancel</Button>
            <Button
              variant="secondary"
              onClick={async () => {
                if (!pending || !session) return;
                await session.reset();
                accept(pending);
              }}
            >
              Discard
            </Button>
            <Button
              disabled={!session?.valid || session?.applying}
              variant="primary"
              onClick={async () => {
                if (!pending || !session) return;
                const applied = await applyInspectorSessionAndShouldContinue(session);
                if (applied) accept(pending);
              }}
            >
              Apply and continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
