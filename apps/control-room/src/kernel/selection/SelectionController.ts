import type { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import type { ModuleId } from "../types";

import {
  EMPTY_SELECTION,
  selectionRefEquals,
  type Selection,
} from "./selectionTypes";

type SelectionListener = (selection: Selection) => void;

/**
 * Kernel-owned selection state.
 * Modules read via `get()`, mutate via `set()`.
 * All changes emit `workspace:selection-changed` on the bus.
 */
export class SelectionController {
  private state: Selection = { ...EMPTY_SELECTION };
  private readonly listeners = new Set<SelectionListener>();

  constructor(private readonly bus: EventBus<KernelEventMap>) {}

  get(): Selection {
    return this.state;
  }

  set(
    patch: Partial<Omit<Selection, "moduleSource">>,
    source: ModuleId,
  ): void {
    const prev = this.state;
    const carriesRef = Object.prototype.hasOwnProperty.call(patch, "ref");
    this.state = {
      ...prev,
      ...patch,
      moduleSource: source,
      ref: carriesRef ? patch.ref ?? null : null,
    };

    // Skip if nothing actually changed.
    if (
      prev.kind === this.state.kind &&
      prev.label === this.state.label &&
      prev.objectId === this.state.objectId &&
      prev.nodeId === this.state.nodeId &&
      selectionRefEquals(prev.ref, this.state.ref)
    ) {
      return;
    }

    this.bus.emit("workspace:selection-changed", {
      selectionId: this.state.objectId ?? this.state.nodeId,
      source,
    });

    for (const listener of this.listeners) {
      listener(this.state);
    }
  }

  clear(source: ModuleId): void {
    this.set(
      { kind: null, label: null, objectId: null, nodeId: null, ref: null },
      source,
    );
  }

  subscribe(listener: SelectionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
