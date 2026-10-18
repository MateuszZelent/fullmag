"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";

import { useKernel } from "@/kernel/KernelContext";
import { registerMeshBuildDraftGuard } from "@/kernel/authoring/meshBuildConfirmation";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import type { SelectionController } from "@/kernel/selection/SelectionController";
import { selectionRefEquals, type Selection } from "@/kernel/selection/selectionTypes";
import { antennaNavigationLinks } from "@/modules/explorer/public";
import { antennaNavigationScene, antennaNavigationSceneState, observeAntennaNavigationScene } from "./panels/antenna/AntennaNavigationScene";
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
  useInspectorEditSessionStore,
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

interface PendingTransition {
  acknowledged: boolean;
  from: Selection;
  generation: number | undefined;
  next: Selection | null;
  relatedLinkKey?: string;
  resolveBuild?: (confirmed: boolean) => void;
  running: boolean;
  scope: string | null;
  session: InspectorEditSession;
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
  const editSessions = useInspectorEditSessionStore();
  const kernel = useKernel();
  const { authoringHistory, bus, commands } = kernel;
  const scope = sessionRequestScopeKey(useSessionResourceIdentity());
  const sessionRef = useRef(session);
  useLayoutEffect(() => { sessionRef.current = session; }, [session]);
  const [pending, setPending] = useState<PendingTransition | null>(null);
  const pendingRef = useRef<PendingTransition | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bypass = useRef<Selection | null>(null);

  const dismiss = useCallback(() => {
    const previous = pendingRef.current;
    pendingRef.current = null;
    previous?.resolveBuild?.(false);
    setPending(null);
    setBusy(false);
    setError(null);
  }, []);

  const isCurrent = useCallback((transition: PendingTransition) =>
    pendingRef.current === transition
    && sessionRef.current === transition.session
    && (!editSessions || editSessions.getCurrentSession() === transition.session)
    && scope === transition.scope
    && (commands.getSessionScopeKey?.() ?? null) === transition.scope
    && authoringHistory?.getGeneration?.() === transition.generation
    && sameSelectionTarget(controller.get(), transition.from),
  [authoringHistory, commands, controller, editSessions, scope]);

  const continueWhenReady = useCallback((transition: PendingTransition) => {
    if (!isCurrent(transition)) {
      if (pendingRef.current === transition) dismiss();
      return;
    }
    if (!transition.acknowledged || transition.session.applying) return;
    if (transition.session.dirty) {
      transition.acknowledged = false;
      setBusy(false);
      setError("The Inspector still has unapplied changes. Review the draft before continuing.");
      return;
    }
    if (transition.relatedLinkKey) {
      const { scene, error: sceneError } = antennaNavigationSceneState(kernel, transition.scope);
      if (!scene && !sceneError) { setBusy(true); return; }
      transition.acknowledged = false;
      setBusy(false);
      if (sceneError) { setError(`The current scene could not be confirmed: ${sceneError}`); return; }
      const target = scene ? antennaNavigationLinks(scene, transition.from).find(link => link.key === transition.relatedLinkKey)?.selection : null;
      if (!target || !transition.next || target.objectId !== transition.next.objectId || !selectionRefEquals(target.ref, transition.next.ref)) {
        setError("The related resource changed or disappeared while saving. The selection was kept; cancel and choose its current binding.");
        return;
      }
      transition.next = target;
    }
    transition.acknowledged = false;
    setBusy(false);
    pendingRef.current = null;
    setPending(null);
    transition.resolveBuild?.(true);
    if (transition.next) {
      bypass.current = transition.next;
      try { controller.set(transition.next, "inspector"); }
      finally { bypass.current = null; }
    }
  }, [controller, dismiss, isCurrent, kernel]);

  // The form owns both its draft and its post-ACK scene synchronization.
  useEffect(() => editSessions?.subscribe(() => {
    const transition = pendingRef.current;
    if (transition) continueWhenReady(transition);
  }), [continueWhenReady, editSessions]);

  useEffect(() => {
    if (!pending?.relatedLinkKey) return;
    return observeAntennaNavigationScene(kernel, pending.scope, () => {
      if (pendingRef.current === pending) continueWhenReady(pending);
    });
  }, [continueWhenReady, kernel, pending]);

  useEffect(() => authoringHistory?.subscribe(() => {
    const transition = pendingRef.current;
    if (transition && !isCurrent(transition)) dismiss();
  }), [authoringHistory, dismiss, isCurrent]);

  // Scope changes and unmount invalidate callbacks already waiting on Apply/Reset.
  useLayoutEffect(() => dismiss, [dismiss, scope]);
  useLayoutEffect(() => {
    const transition = pendingRef.current;
    if (transition && !isCurrent(transition)) dismiss();
  }, [dismiss, isCurrent, selection, session]);

  const begin = useCallback((next: Selection | null, resolveBuild?: (confirmed: boolean) => void, fromRelatedLink = false) => {
    dismiss();
    const owner = sessionRef.current;
    if (!owner || (commands.getSessionScopeKey?.() ?? null) !== scope) {
      resolveBuild?.(false);
      return;
    }
    const transition: PendingTransition = {
      acknowledged: false, from: controller.get(), generation: authoringHistory?.getGeneration?.(),
      next, resolveBuild, running: false, scope, session: owner,
    };
    if (fromRelatedLink && next) {
      const scene = antennaNavigationScene(kernel, scope);
      transition.relatedLinkKey = scene ? antennaNavigationLinks(scene, transition.from).find(link => link.selection && selectionRefEquals(link.selection.ref, next.ref) && link.selection.objectId === next.objectId)?.key : undefined;
    }
    pendingRef.current = transition;
    setPending(transition);
  }, [authoringHistory, commands, controller, dismiss, kernel, scope]);

  useEffect(() => controller.addChangeGuard((next, _previous, source) => {
    if (bypass.current && sameSelectionTarget(bypass.current, next)) return true;
    if (!shouldGuardInspectorSelection(sessionRef.current)) return true;
    begin(next, undefined, source === "inspector");
    return false;
  }), [begin, controller]);

  useEffect(() => {
    const unregister = registerMeshBuildDraftGuard(bus, async () => {
      if (!shouldGuardInspectorSelection(sessionRef.current)) return true;
      return new Promise<boolean>((resolve) => begin(null, resolve));
    });
    return () => { unregister(); dismiss(); };
  }, [begin, bus, dismiss]);

  async function decide(apply: boolean): Promise<void> {
    const transition = pendingRef.current;
    if (!transition || transition.running) return;
    if (!isCurrent(transition)) { dismiss(); return; }
    const owner = transition.session;
    if (owner.applying || owner.lockReason || (apply && (!owner.valid || owner.applyBlockReason))) return;
    transition.running = true;
    setBusy(true);
    setError(null);
    try {
      const accepted = apply ? await applyInspectorSessionAndShouldContinue(owner) : (await owner.reset(), true);
      if (!isCurrent(transition)) {
        if (pendingRef.current === transition) dismiss();
        return;
      }
      if (!accepted) return;
      // The imperative selection controller must see the committed React draft,
      // including any edits made during Apply. Flush only this explicit decision.
      flushSync(() => setBusy(false));
      if (!isCurrent(transition)) {
        if (pendingRef.current === transition) dismiss();
        return;
      }
      transition.acknowledged = true;
      continueWhenReady(transition);
    } catch {
      if (isCurrent(transition)) setError("The Inspector changes could not be applied or discarded. The selection was kept; review the draft and retry.");
      else if (pendingRef.current === transition) dismiss();
    } finally {
      transition.running = false;
      if (pendingRef.current === transition && !transition.acknowledged) setBusy(false);
    }
  }

  return (
    <>
      {children(selection)}
      <Dialog open={pending !== null} onOpenChange={(open) => { if (!open) dismiss(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unapplied Inspector changes</DialogTitle>
            <DialogDescription>
              {pending?.resolveBuild ? "Apply or discard the current draft before reviewing the mesh build." : "Apply or discard the current draft before changing the Explorer selection."}
            </DialogDescription>
            {error ? <p role="alert">{error}</p> : null}
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={dismiss}>Cancel</Button>
            <Button disabled={busy || session?.applying || !!session?.lockReason} variant="secondary" onClick={() => void decide(false)}>
              Discard
            </Button>
            <Button
              disabled={busy || !session?.valid || session?.applying || !!session?.lockReason || !!session?.applyBlockReason}
              variant="primary"
              onClick={() => void decide(true)}
            >
              Apply and continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
