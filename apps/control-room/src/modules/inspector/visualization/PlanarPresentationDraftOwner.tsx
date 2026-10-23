"use client";

import { createContext, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { Button } from "@/shared/ui/Button";
import {
  createInspectorEditSessionStore,
  InspectorEditSessionProvider,
  useRegisterInspectorEditSession,
} from "../InspectorEditSession";
import {
  QuantityFieldDraftScope,
  useQuantityFieldDraftScope,
} from "../primitives/QuantityField";
import {
  EMPTY_QUANTITY_FIELD_DRAFT_SUMMARY,
  type QuantityFieldDraftStore,
} from "../primitives/quantityFieldDraftStore";

const RawDraftContext = createContext<QuantityFieldDraftStore | null>(null);
const FieldContext = createContext("planar");
const noSubscription = () => () => {};
const emptySummary = () => EMPTY_QUANTITY_FIELD_DRAFT_SUMMARY;
const serverVersion = () => 0;

export function usePlanarPresentationDraftState() {
  const store = useContext(RawDraftContext);
  const summary = useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    store?.getSummary ?? emptySummary,
    emptySummary,
  );
  return { store, summary, pending: summary.pendingCount > 0 };
}

/** Context is part of raw interpretation, not an additional API state owner. */
export function PlanarPresentationFieldContext({
  contextKey,
  children,
}: {
  contextKey: string;
  children: ReactNode;
}) {
  return <FieldContext.Provider value={contextKey}>{children}</FieldContext.Provider>;
}

export function usePlanarFieldDraftKey(path: string): string {
  return JSON.stringify(["planar", useContext(FieldContext), path]);
}

/** Keep 2D input drafts alive while the mounted Inspector switches 2D/3D views. */
export function PlanarPresentationDraftOwner({
  identityKey,
  children,
}: {
  identityKey: string;
  children: ReactNode;
}) {
  const raw = useQuantityFieldDraftScope(identityKey);
  const identityRef = useRef(identityKey);
  const acknowledgeAppliedRef = useRef<(() => boolean) | null>(null);
  useLayoutEffect(() => { identityRef.current = identityKey; }, [identityKey]);
  const [childStore] = useState(createInspectorEditSessionStore);
  useSyncExternalStore(childStore.subscribe, childStore.getVersion, serverVersion);
  const child = childStore.getCurrentSession();
  const pendingRaw = raw.summary.pendingCount > 0;
  const reason = pendingRaw
    ? "Complete or discard the pending 2D inputs before applying changes."
    : child?.applyBlockReason;

  async function apply(): Promise<boolean> {
    if (raw.store.getSummary().pendingCount > 0) return false;
    const current = childStore.getCurrentSession();
    if (!current || current.applying || !current.valid || current.lockReason || current.applyBlockReason) return false;
    const rawVersion = raw.store.getVersion();
    const operationIdentity = identityRef.current;
    if (!(await current.apply())) return false;
    if (
      identityRef.current !== operationIdentity ||
      childStore.getCurrentSession() !== current || current.dirty ||
      raw.store.getVersion() !== rawVersion || raw.store.getSummary().pendingCount > 0
    ) return false;
    return acknowledgeAppliedRef.current?.() ?? false;
  }

  async function reset(): Promise<void> {
    const current = childStore.getCurrentSession();
    if (current?.applying) return;
    raw.store.clear();
    if (current?.dirty) await current.reset();
  }

  const acknowledgeApplied = useRegisterInspectorEditSession(
    pendingRaw ? "staged" : child?.mode ?? null,
    child?.applying ?? false,
    pendingRaw || (child?.dirty ?? false),
    !pendingRaw && (child?.valid ?? true),
    child?.lockReason,
    apply,
    reset,
    { applyBlockReason: reason, historyMode: "mutation-owned" },
  );
  useLayoutEffect(() => { acknowledgeAppliedRef.current = acknowledgeApplied; }, [acknowledgeApplied]);

  return (
    <RawDraftContext.Provider value={raw.store}>
      <QuantityFieldDraftScope store={raw.store}>
        <InspectorEditSessionProvider store={childStore}>
          {pendingRaw ? (
            <div className="fm-inspector-panel grid min-w-0 gap-fm-inspector-control">
              <p className="fm-help-text" role="status">{reason}</p>
              <Button disabled={child?.applying} size="sm" type="button" variant="secondary" onClick={() => raw.store.clear()}>
                Discard 2D input
              </Button>
            </div>
          ) : null}
          {children}
        </InspectorEditSessionProvider>
      </QuantityFieldDraftScope>
    </RawDraftContext.Provider>
  );
}
