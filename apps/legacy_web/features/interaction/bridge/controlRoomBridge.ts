/**
 * Interaction Bridge — ControlRoom Adapter
 *
 * Bridges the new `useInteractionStore` with the existing ControlRoom
 * selection model (`selectedSidebarNodeId`, `selectedObjectId`,
 * `selectedEntityId`, `focusedEntityId`).
 *
 * Migration strategy (from doc 12, section 9):
 * 1. New store runs alongside existing ControlRoom state.
 * 2. This adapter syncs selection FROM new store TO old model.
 * 3. Gradually, components read from new store instead of old props.
 * 4. Finally, old selection state is removed from ControlRoom.
 *
 * Usage: mount `<InteractionBridge />` inside ControlRoomProvider.
 */

"use client";

import { useEffect, useRef } from "react";
import { useInteractionStore } from "../store/useInteractionStore";
import { initializeInteractionCommands } from "../commands/initCommands";
import { objectIdFromTarget } from "../model/selection";
import type { SelectionTarget } from "../model/selection";

// ── Types for the legacy model interface ──────────────────────

export interface LegacySelectionSink {
  setSelectedSidebarNodeId: (id: string | null) => void;
  setSelectedObjectId: (id: string | null) => void;
  setSelectedEntityId: (id: string | null) => void;
  setFocusedEntityId: (id: string | null) => void;
}

export interface LegacyMeshPartResolver {
  meshParts: Array<{ id: string; role: string; object_id: string }>;
  airPart: { id: string } | null;
}

// ── Initialize commands once ──────────────────────────────────

let commandsReady = false;

function ensureCommands(): void {
  if (!commandsReady) {
    initializeInteractionCommands();
    commandsReady = true;
  }
}

// ── Resolve entity ID from selection target ───────────────────

function resolveEntityId(
  target: SelectionTarget,
  resolver: LegacyMeshPartResolver,
): string | null {
  if (target.kind === "airbox") {
    return resolver.airPart?.id ?? null;
  }
  const objectId = objectIdFromTarget(target);
  if (!objectId) return null;
  return (
    resolver.meshParts.find(
      (part) => part.role === "magnetic_object" && part.object_id === objectId,
    )?.id ?? null
  );
}

// ── Hook: sync new interaction store → legacy ControlRoom ─────

/**
 * Call this hook inside the ControlRoom to sync the new interaction
 * store's selection into the legacy ControlRoom state.
 *
 * When the new store's selection changes, this pushes the derived
 * `selectedSidebarNodeId`, `selectedObjectId`, `selectedEntityId`,
 * and `focusedEntityId` into the legacy sink.
 *
 * This is the "adapter alongside" phase. Once all consumers read
 * from `useInteractionStore` directly, this hook is removed.
 */
export function useInteractionBridge(
  sink: LegacySelectionSink,
  resolver: LegacyMeshPartResolver,
): void {
  // Initialize commands on first mount
  const initRef = useRef(false);
  if (!initRef.current) {
    ensureCommands();
    initRef.current = true;
  }

  // Subscribe to interaction store selection changes
  useEffect(() => {
    let prevRevision = useInteractionStore.getState().selection.revision;

    const unsubscribe = useInteractionStore.subscribe((state) => {
      const selection = state.selection;
      if (selection.revision === prevRevision) return;
      prevRevision = selection.revision;

      // Push to legacy model
      sink.setSelectedSidebarNodeId(selection.nodeId);
      sink.setSelectedObjectId(selection.selectedObjectId);

      const entityId = resolveEntityId(selection.target, resolver);
      sink.setSelectedEntityId(entityId);

      // Only update focusedEntityId for spatial targets
      // (ADR-0006: selection does not auto-focus, but entity highlight is ok)
      sink.setFocusedEntityId(entityId);
    });

    return unsubscribe;
  }, [sink, resolver]);
}

// ── Hook: sync legacy ControlRoom → new interaction store ─────

/**
 * Reverse sync: when legacy code sets `selectedSidebarNodeId`
 * (e.g., from existing viewport click handlers), push it into
 * the new interaction store.
 *
 * This ensures both stores stay in sync during the transition.
 */
export function useLegacySelectionSync(
  legacyNodeId: string | null,
): void {
  const prevRef = useRef<string | null>(null);

  useEffect(() => {
    if (legacyNodeId === prevRef.current) return;
    prevRef.current = legacyNodeId;

    const currentSelection = useInteractionStore.getState().selection;
    if (currentSelection.nodeId === legacyNodeId) return;

    // Legacy code changed selection — push to new store
    useInteractionStore.getState().select({
      nodeId: legacyNodeId,
      origin: "tree",
    });
  }, [legacyNodeId]);
}
