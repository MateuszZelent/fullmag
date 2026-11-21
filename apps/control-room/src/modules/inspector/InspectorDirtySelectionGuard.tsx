"use client";

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
// react-doctor-disable-next-line react-doctor/no-flush-sync -- Selection is changed imperatively after Apply or Discard; flush the accepted Inspector draft before that handoff.
import { flushSync } from "react-dom";

import { useKernel } from "@/kernel/KernelContext";
import { registerMeshBuildDraftGuard } from "@/kernel/authoring/meshBuildConfirmation";
import { sessionRequestScopeKey } from "@/kernel/resources/sessionResourceIdentity";
import { useSessionResourceIdentity } from "@/kernel/resources/useSessionStatus";
import type { SelectionController } from "@/kernel/selection/SelectionController";
import { selectionRefEquals, type Selection } from "@/kernel/selection/selectionTypes";
import { antennaNavigationLinks } from "@/modules/explorer/public";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/AlertDialog";
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
  usePrimaryStagedInspectorSessionV2,
  type InspectorEditSession,
  type InspectorEditSessionV2,
} from "./InspectorEditSession";
import {
  antennaNavigationScene,
  antennaNavigationSceneState,
  observeAntennaNavigationScene,
} from "./panels/antenna/AntennaNavigationScene";

export function shouldGuardInspectorSelection(
  session: InspectorEditSession | InspectorEditSessionV2 | null,
): boolean {
  return session?.mode === "staged" && session.dirty;
}

export async function applyInspectorSessionAndShouldContinue(
  session: InspectorEditSession | InspectorEditSessionV2,
): Promise<boolean> {
  return (await session.apply()) === true;
}

function sameSelectionTarget(left: Selection, right: Selection): boolean {
  return (
    left.kind === right.kind &&
    left.label === right.label &&
    left.nodeId === right.nodeId &&
    left.objectId === right.objectId &&
    selectionRefEquals(left.ref, right.ref)
  );
}

interface PendingTransition {
  acknowledged: boolean;
  dirtyCountSnapshot: number;
  dirtyLabelsSnapshot: readonly string[];
  from: Selection;
  generation: number | undefined;
  next: Selection | null;
  nodeTitleSnapshot: string | null;
  relatedLinkKey?: string;
  resolveBuild?: (confirmed: boolean) => void;
  running: boolean;
  scope: string | null;
  session: InspectorEditSession;
  v2Session: InspectorEditSessionV2 | null;
}

export function InspectorDirtySelectionGuard({
  children,
  controller,
  onRestoreSelectionTab,
  selection,
}: {
  children: (selection: Selection) => ReactNode;
  controller: SelectionController;
  onRestoreSelectionTab?: () => void;
  selection: Selection;
}) {
  const session = useInspectorEditSession();
  const v2StagedSession = usePrimaryStagedInspectorSessionV2();
  const editSessions = useInspectorEditSessionStore();
  const kernel = useKernel();
  const { authoringHistory, bus, commands } = kernel;
  const scope = sessionRequestScopeKey(useSessionResourceIdentity());
  const sessionRef = useRef(session);
  const v2SessionRef = useRef(v2StagedSession);
  const restoreTabRef = useRef(onRestoreSelectionTab);

  useLayoutEffect(() => {
    sessionRef.current = session;
    v2SessionRef.current = v2StagedSession;
    restoreTabRef.current = onRestoreSelectionTab;
  }, [onRestoreSelectionTab, session, v2StagedSession]);

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

  const isCurrent = useCallback(
    (transition: PendingTransition) => {
      const registeredOk = editSessions
        ? editSessions.isSessionRegistered(
            transition.v2Session ?? transition.session,
          )
        : sessionRef.current === transition.session;
      return (
        pendingRef.current === transition &&
        registeredOk &&
        scope === transition.scope &&
        (commands.getSessionScopeKey?.() ?? null) === transition.scope &&
        authoringHistory?.getGeneration?.() === transition.generation &&
        sameSelectionTarget(controller.get(), transition.from)
      );
    },
    [authoringHistory, commands, controller, editSessions, scope],
  );

  const continueWhenReady = useCallback(
    (transition: PendingTransition) => {
      if (!isCurrent(transition)) {
        if (pendingRef.current === transition) dismiss();
        return;
      }
      if (!transition.acknowledged || transition.session.applying) return;
      if (transition.session.dirty) {
        transition.acknowledged = false;
        setBusy(false);
        setError(
          "The Inspector still has unapplied changes. Review the draft before continuing.",
        );
        return;
      }
      if (transition.relatedLinkKey) {
        const { scene, error: sceneError } = antennaNavigationSceneState(
          kernel,
          transition.scope,
        );
        if (!scene && !sceneError) {
          setBusy(true);
          return;
        }
        transition.acknowledged = false;
        setBusy(false);
        if (sceneError) {
          setError(`The current scene could not be confirmed: ${sceneError}`);
          return;
        }
        const target = scene
          ? antennaNavigationLinks(scene, transition.from).find(
              (link) => link.key === transition.relatedLinkKey,
            )?.selection
          : null;
        if (
          !target ||
          !transition.next ||
          target.objectId !== transition.next.objectId ||
          !selectionRefEquals(target.ref, transition.next.ref)
        ) {
          setError(
            "The related resource changed or disappeared while saving. The selection was kept; cancel and choose its current binding.",
          );
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
        try {
          controller.set(transition.next, "inspector");
        } finally {
          bypass.current = null;
        }
      }
    },
    [controller, dismiss, isCurrent, kernel],
  );

  const continueAfterEditSessionChange = useEffectEvent(() => {
    const transition = pendingRef.current;
    if (transition) continueWhenReady(transition);
  });
  const continueAfterNavigationSceneChange = useEffectEvent(
    (transition: PendingTransition) => {
      if (pendingRef.current === transition) continueWhenReady(transition);
    },
  );
  const dismissIfHistoryInvalidatesTransition = useEffectEvent(() => {
    const transition = pendingRef.current;
    if (transition && !isCurrent(transition)) dismiss();
  });

  // The form owns both its draft and its post-ACK scene synchronization.
  useEffect(
    () => editSessions?.subscribe(continueAfterEditSessionChange),
    [editSessions],
  );

  useEffect(() => {
    if (!pending?.relatedLinkKey) return;
    return observeAntennaNavigationScene(kernel, pending.scope, () => {
      continueAfterNavigationSceneChange(pending);
    });
  }, [kernel, pending]);

  useEffect(
    () => authoringHistory?.subscribe(dismissIfHistoryInvalidatesTransition),
    [authoringHistory],
  );

  // Scope changes and unmount invalidate callbacks already waiting on Apply/Reset.
  useLayoutEffect(() => dismiss, [dismiss, scope]);
  useLayoutEffect(() => {
    const transition = pendingRef.current;
    if (transition && !isCurrent(transition)) dismiss();
  }, [dismiss, isCurrent, selection, session, v2StagedSession]);

  const begin = useCallback(
    (
      next: Selection | null,
      resolveBuild?: (confirmed: boolean) => void,
      fromRelatedLink = false,
    ) => {
      dismiss();
      const v2Owner =
        v2SessionRef.current && shouldGuardInspectorSelection(v2SessionRef.current)
          ? v2SessionRef.current
          : null;
      const owner = sessionRef.current;
      if (!owner || (commands.getSessionScopeKey?.() ?? null) !== scope) {
        resolveBuild?.(false);
        return;
      }

      // Restore the Selection tab when a selection or build action is triggered from 3D View / Export (Review Focus #3).
      restoreTabRef.current?.();

      const from = controller.get();
      const dirtyLabelsSnapshot = v2Owner ? [...v2Owner.dirtyFieldLabels] : [];
      const dirtyCountSnapshot = v2Owner
        ? Math.max(1, v2Owner.dirtyFields.size)
        : 1;
      const nodeTitleSnapshot = v2Owner?.nodeTitle ?? from.label ?? null;

      const transition: PendingTransition = {
        acknowledged: false,
        dirtyCountSnapshot,
        dirtyLabelsSnapshot,
        from,
        generation: authoringHistory?.getGeneration?.(),
        next,
        nodeTitleSnapshot,
        resolveBuild,
        running: false,
        scope,
        session: owner,
        v2Session: v2Owner,
      };
      if (fromRelatedLink && next) {
        const scene = antennaNavigationScene(kernel, scope);
        transition.relatedLinkKey = scene
          ? antennaNavigationLinks(scene, transition.from).find(
              (link) =>
                link.selection &&
                selectionRefEquals(link.selection.ref, next.ref) &&
                link.selection.objectId === next.objectId,
            )?.key
          : undefined;
      }
      pendingRef.current = transition;
      setPending(transition);
    },
    [authoringHistory, commands, controller, dismiss, kernel, scope],
  );

  useEffect(
    () =>
      controller.addChangeGuard((next, _previous, source) => {
        if (bypass.current && sameSelectionTarget(bypass.current, next)) {
          return true;
        }
        const activeV2 = v2SessionRef.current;
        if (
          !shouldGuardInspectorSelection(activeV2) &&
          !shouldGuardInspectorSelection(sessionRef.current)
        ) {
          return true;
        }
        begin(next, undefined, source === "inspector");
        return false;
      }),
    [begin, controller],
  );

  useEffect(() => {
    const unregister = registerMeshBuildDraftGuard(bus, async () => {
      if (
        !shouldGuardInspectorSelection(v2SessionRef.current) &&
        !shouldGuardInspectorSelection(sessionRef.current)
      ) {
        return true;
      }
      return new Promise<boolean>((resolve) => begin(null, resolve));
    });
    return () => {
      unregister();
      dismiss();
    };
  }, [begin, bus, dismiss]);

  async function decide(apply: boolean): Promise<void> {
    const transition = pendingRef.current;
    if (!transition || transition.running || transition.acknowledged) return;
    if (!isCurrent(transition)) {
      dismiss();
      return;
    }
    const owner = transition.session;
    if (
      owner.applying ||
      owner.lockReason ||
      (apply && (!owner.valid || owner.applyBlockReason))
    ) {
      return;
    }
    transition.running = true;
    setBusy(true);
    setError(null);
    try {
      const accepted = apply
        ? await applyInspectorSessionAndShouldContinue(owner)
        : (await owner.reset(), true);
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
    } catch (cause) {
      if (isCurrent(transition)) {
        const detail =
          cause instanceof Error
            ? cause.message
            : "The Inspector changes could not be applied or discarded.";
        setError(
          `${detail} The selection was kept; review the draft before retrying.`,
        );
      } else if (pendingRef.current === transition) {
        pendingRef.current = null;
        transition.resolveBuild?.(false);
        setPending(null);
        setError(null);
      }
    } finally {
      transition.running = false;
      if (
        pendingRef.current === null ||
        (pendingRef.current === transition && !transition.acknowledged)
      ) {
        // react-doctor-disable-next-line react-doctor/no-loading-flag-reset-outside-finally -- The ownership guard keeps an older request from clearing the busy state of a newer transition.
        setBusy(false);
      }
    }
  }

  const activeV2ModalSession = pending?.v2Session ?? null;
  const firstInvalidKey = activeV2ModalSession
    ? Array.from(activeV2ModalSession.invalidFields.keys())[0] ?? null
    : null;

  return (
    <>
      {children(selection)}
      {pending && activeV2ModalSession ? (
        <AlertDialog
          open={pending !== null}
          onOpenChange={(open) => {
            if (!open) dismiss();
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {pending.nodeTitleSnapshot
                  ? `Unapplied Inspector changes in ${pending.nodeTitleSnapshot}`
                  : "Unapplied Inspector changes"}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {pending.resolveBuild
                  ? "Apply or discard the current draft before reviewing the mesh build."
                  : "Apply or discard the current draft before changing the selection."}
              </AlertDialogDescription>
              {pending.dirtyLabelsSnapshot.length > 0 ? (
                <ul
                  className="fm-inspector-guard__dirty-list"
                  data-slot="dirty-field-list"
                >
                  {pending.dirtyLabelsSnapshot.map((label) => (
                    <li key={label}>{label}</li>
                  ))}
                </ul>
              ) : null}
              {activeV2ModalSession.lockReason ||
              activeV2ModalSession.applyBlockReason ||
              !activeV2ModalSession.valid ? (
                <p role="status">
                  {activeV2ModalSession.lockReason ??
                    activeV2ModalSession.applyBlockReason ??
                    "Resolve validation errors before applying."}
                </p>
              ) : null}
              {error ? <p role="alert">{error}</p> : null}
            </AlertDialogHeader>
            <AlertDialogFooter>
              {firstInvalidKey ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    const targetSession = activeV2ModalSession;
                    dismiss();
                    targetSession.focusField(firstInvalidKey);
                  }}
                >
                  Show first error
                </Button>
              ) : null}
              <Button variant="ghost" onClick={dismiss}>
                Keep editing
              </Button>
              <Button
                disabled={
                  busy ||
                  activeV2ModalSession.applying ||
                  !!activeV2ModalSession.lockReason
                }
                variant="secondary"
                onClick={() => void decide(false)}
              >
                {`Discard ${pending.dirtyCountSnapshot} ${pending.dirtyCountSnapshot === 1 ? "change" : "changes"}`}
              </Button>
              <Button
                disabled={
                  busy ||
                  !activeV2ModalSession.valid ||
                  activeV2ModalSession.applying ||
                  !!activeV2ModalSession.lockReason ||
                  !!activeV2ModalSession.applyBlockReason
                }
                variant="primary"
                onClick={() => void decide(true)}
              >
                Apply and continue
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : (
        <Dialog
          open={pending !== null}
          onOpenChange={(open) => {
            if (!open) dismiss();
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Unapplied Inspector changes</DialogTitle>
              <DialogDescription>
                {pending?.resolveBuild
                  ? "Apply or discard the current draft before reviewing the mesh build."
                  : "Apply or discard the current draft before changing the Explorer selection."}
              </DialogDescription>
              {pending &&
              (session?.lockReason || session?.applyBlockReason || !session?.valid) ? (
                <p role="status">
                  {session?.lockReason ??
                    session?.applyBlockReason ??
                    "Resolve validation errors before applying."}
                </p>
              ) : null}
              {error ? <p role="alert">{error}</p> : null}
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={dismiss}>
                Cancel
              </Button>
              <Button
                disabled={busy || session?.applying || !!session?.lockReason}
                variant="secondary"
                onClick={() => void decide(false)}
              >
                Discard
              </Button>
              <Button
                disabled={
                  busy ||
                  !session?.valid ||
                  session?.applying ||
                  !!session?.lockReason ||
                  !!session?.applyBlockReason
                }
                variant="primary"
                onClick={() => void decide(true)}
              >
                Apply and continue
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
