import type { EventBus } from "../events/EventBus";
import type { KernelEventMap } from "../events/eventTypes";
import type { ModuleId } from "../types";

import {
  EMPTY_SELECTION,
  orderedSelectedObjectIds,
  selectionRefEquals,
  type Selection,
} from "./selectionTypes";

function normalizeSelectedObjectIds(
  ids: readonly string[] | undefined,
): readonly string[] | undefined {
  if (!ids || ids.length === 0) return undefined;
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  return ordered.length > 0 ? ordered : undefined;
}

function stringArrayEquals(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

type SelectionListener = (selection: Selection) => void;
type SelectionChangeGuard = (
  next: Selection,
  previous: Selection,
  source: ModuleId,
) => boolean;

/**
 * Kernel-owned selection state.
 * Modules read via `get()`, mutate via `set()`.
 * All changes emit `workspace:selection-changed` on the bus.
 */
export class SelectionController {
  private state: Selection = { ...EMPTY_SELECTION };
  private readonly listeners = new Set<SelectionListener>();
  private readonly changeGuards = new Set<SelectionChangeGuard>();

  constructor(private readonly bus: EventBus<KernelEventMap>) {}

  get(): Selection {
    return this.state;
  }

  getSelectedObjectIds(): readonly string[] {
    return orderedSelectedObjectIds(this.state);
  }

  set(
    patch: Partial<Omit<Selection, "moduleSource">>,
    source: ModuleId,
  ): void {
    this.update(patch, source, true);
  }

  setOrderedObjectSelection(
    objectIds: readonly string[],
    primaryPatch: Partial<Omit<Selection, "moduleSource" | "selectedObjectIds">>,
    source: ModuleId,
  ): void {
    const normalized = normalizeSelectedObjectIds(objectIds);
    if (!normalized || normalized.length === 0) {
      this.clear(source);
      return;
    }
    this.update(
      {
        ...primaryPatch,
        objectId: primaryPatch.objectId ?? normalized[0] ?? null,
        selectedObjectIds: normalized.length > 1 ? normalized : undefined,
      },
      source,
      true,
    );
  }

  toggleObjectSelection(
    objectId: string,
    primaryPatch: Partial<Omit<Selection, "moduleSource" | "selectedObjectIds">>,
    source: ModuleId,
  ): void {
    const current = orderedSelectedObjectIds(this.state);
    const existingIndex = current.indexOf(objectId);
    if (existingIndex >= 0) {
      const remaining = current.filter((id) => id !== objectId);
      if (remaining.length === 0) {
        this.clear(source);
        return;
      }
      const nextPrimaryId =
        this.state.objectId === objectId
          ? remaining[0] ?? null
          : this.state.objectId ?? remaining[0] ?? null;
      this.update(
        {
          kind: nextPrimaryId ? "object.root" : null,
          label:
            nextPrimaryId === this.state.objectId
              ? this.state.label
              : nextPrimaryId,
          nodeId: nextPrimaryId ? `model:object:${nextPrimaryId}` : null,
          objectId: nextPrimaryId,
          ref: nextPrimaryId
            ? {
                kind: "object.root",
                nodeId: `model:object:${nextPrimaryId}`,
                objectId: nextPrimaryId,
                type: "scene-object",
                visualizationTargetId: `object:${nextPrimaryId}`,
              }
            : null,
          selectedObjectIds: remaining.length > 1 ? remaining : undefined,
        },
        source,
        true,
      );
      return;
    }

    const nextIds = [...current, objectId];
    this.update(
      {
        ...primaryPatch,
        objectId,
        selectedObjectIds: nextIds.length > 1 ? nextIds : undefined,
      },
      source,
      true,
    );
  }

  rangeSelectObjects(
    orderedVisibleObjectIds: readonly string[],
    targetObjectId: string,
    primaryPatch: Partial<Omit<Selection, "moduleSource" | "selectedObjectIds">>,
    source: ModuleId,
  ): void {
    const current = orderedSelectedObjectIds(this.state);
    const anchorId = current[0] ?? this.state.objectId;
    const anchorIndex = anchorId ? orderedVisibleObjectIds.indexOf(anchorId) : -1;
    const targetIndex = orderedVisibleObjectIds.indexOf(targetObjectId);
    if (anchorIndex < 0 || targetIndex < 0) {
      this.toggleObjectSelection(targetObjectId, primaryPatch, source);
      return;
    }
    const step = anchorIndex <= targetIndex ? 1 : -1;
    const range: string[] = [];
    for (
      let index = anchorIndex;
      step > 0 ? index <= targetIndex : index >= targetIndex;
      index += step
    ) {
      const candidate = orderedVisibleObjectIds[index];
      if (candidate) range.push(candidate);
    }
    this.setOrderedObjectSelection(range, { ...primaryPatch, objectId: targetObjectId }, source);
  }

  private update(
    patch: Partial<Omit<Selection, "moduleSource">>,
    source: ModuleId,
    enforceGuards: boolean,
  ): void {
    const prev = this.state;
    const carriesRef = Object.prototype.hasOwnProperty.call(patch, "ref");
    const carriesSelectedObjectIds = Object.prototype.hasOwnProperty.call(
      patch,
      "selectedObjectIds",
    );
    const normalizedSelectedObjectIds = carriesSelectedObjectIds
      ? normalizeSelectedObjectIds(patch.selectedObjectIds)
      : undefined;
    const next: Selection = {
      ...prev,
      ...patch,
      moduleSource: source,
      ref: carriesRef ? patch.ref ?? null : null,
      ...(normalizedSelectedObjectIds
        ? { selectedObjectIds: normalizedSelectedObjectIds }
        : {}),
    };
    if (!normalizedSelectedObjectIds) {
      delete next.selectedObjectIds;
    }

    // Skip if nothing actually changed.
    if (
      prev.kind === next.kind &&
      prev.label === next.label &&
      prev.objectId === next.objectId &&
      stringArrayEquals(
        orderedSelectedObjectIds(prev),
        orderedSelectedObjectIds(next),
      ) &&
      prev.nodeId === next.nodeId &&
      selectionRefEquals(prev.ref, next.ref)
    ) {
      return;
    }

    for (const guard of this.changeGuards) {
      if (enforceGuards && !guard(next, prev, source)) return;
    }

    this.state = next;

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
      {
        kind: null,
        label: null,
        objectId: null,
        nodeId: null,
        ref: null,
        selectedObjectIds: undefined,
      },
      source,
    );
  }

  /** Lost session ownership cannot be retained by an old dirty draft guard. */
  clearForSessionTransition(source: ModuleId): void {
    this.update({ ...EMPTY_SELECTION }, source, false);
  }

  subscribe(listener: SelectionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  addChangeGuard(guard: SelectionChangeGuard): () => void {
    this.changeGuards.add(guard);
    return () => this.changeGuards.delete(guard);
  }
}
