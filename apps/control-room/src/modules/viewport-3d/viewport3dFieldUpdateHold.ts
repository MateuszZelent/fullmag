"use client";

import { sharedResourceRuntimeStore } from "@/kernel/resources/ResourceRuntimeStore";

let holdDepth = 0;
let releaseResourcePause: (() => void) | null = null;

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
  }
}

export function viewport3DFieldUpdateHoldActive(): boolean {
  return holdDepth > 0;
}

export function createViewport3DInteractionFieldHold() {
  let active: { epoch: number | undefined } | null = null;
  return {
    begin(epoch?: number): void {
      if (!active) beginViewport3DFieldUpdateHold();
      active = { epoch };
    },
    end(epoch?: number): void {
      if (!active || (epoch !== undefined && epoch !== active.epoch)) return;
      active = null;
      endViewport3DFieldUpdateHold();
    },
  };
}

export function resetViewport3DFieldUpdateHoldForTest(): void {
  releaseResourcePause?.();
  releaseResourcePause = null;
  holdDepth = 0;
}
