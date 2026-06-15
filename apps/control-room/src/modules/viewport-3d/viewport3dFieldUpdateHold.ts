"use client";

import { useSyncExternalStore } from "react";

import { sharedResourceRuntimeStore } from "@/kernel/resources/ResourceRuntimeStore";

type Listener = () => void;

let holdDepth = 0;
let releaseResourcePause: (() => void) | null = null;
const listeners = new Set<Listener>();

function notify() {
  for (const listener of listeners) {
    listener();
  }
}

function isViewport3DFieldVectorResourceKey(resourceKey: string): boolean {
  return (
    resourceKey.includes("/data/fields/") &&
    resourceKey.includes("/samples/vector")
  );
}

export function beginViewport3DFieldUpdateHold(): void {
  holdDepth += 1;
  if (holdDepth === 1) {
    releaseResourcePause = sharedResourceRuntimeStore.beginPauseMatching(
      isViewport3DFieldVectorResourceKey,
    );
    notify();
  }
}

export function endViewport3DFieldUpdateHold(): void {
  if (holdDepth <= 0) {
    holdDepth = 0;
    return;
  }
  holdDepth -= 1;
  if (holdDepth === 0) {
    releaseResourcePause?.();
    releaseResourcePause = null;
    notify();
  }
}

export function viewport3DFieldUpdateHoldActive(): boolean {
  return holdDepth > 0;
}

function subscribeViewport3DFieldUpdateHold(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useViewport3DFieldUpdateHoldActive(): boolean {
  return useSyncExternalStore(
    subscribeViewport3DFieldUpdateHold,
    viewport3DFieldUpdateHoldActive,
    viewport3DFieldUpdateHoldActive,
  );
}

export function resetViewport3DFieldUpdateHoldForTest(): void {
  releaseResourcePause?.();
  releaseResourcePause = null;
  holdDepth = 0;
  notify();
}
