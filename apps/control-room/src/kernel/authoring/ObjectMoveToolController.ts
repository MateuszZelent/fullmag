"use client";

import { useSyncExternalStore } from "react";

export interface ObjectMoveToolState {
  activationId: number;
  mode: "move";
  objectId: string;
}

type Listener = () => void;

export class ObjectMoveToolController {
  private state: ObjectMoveToolState | null = null;
  private nextActivationId = 1;
  private readonly listeners = new Set<Listener>();

  getSnapshot(): ObjectMoveToolState | null {
    return this.state;
  }

  activate(objectId: string): void {
    if (this.state?.objectId === objectId) return;
    this.state = { activationId: this.nextActivationId++, mode: "move", objectId };
    this.notify();
  }

  clear(): void {
    if (this.state === null) return;
    this.state = null;
    this.notify();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export function useObjectMoveTool(
  controller: ObjectMoveToolController,
): ObjectMoveToolState | null {
  return useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.getSnapshot(),
    () => null,
  );
}
