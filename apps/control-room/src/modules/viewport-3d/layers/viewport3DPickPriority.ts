interface Viewport3DPickObject {
  readonly parent?: Viewport3DPickObject | null;
  readonly userData?: Record<string, unknown>;
}

export const VIEWPORT_3D_PICK_PRIORITY = {
  airbox: 10,
  meshPart: 20,
} as const;

export function viewport3DPickShouldDefer(
  intersections: readonly { readonly object: Viewport3DPickObject }[],
  currentPriority: number,
): boolean {
  return intersections.some(
    ({ object }) => semanticPickPriority(object) > currentPriority,
  );
}

function semanticPickPriority(object: Viewport3DPickObject | null | undefined): number {
  let current = object;
  while (current) {
    const priority = current.userData?.viewportSemanticPickPriority;
    if (typeof priority === "number" && Number.isFinite(priority)) {
      return priority;
    }
    current = current.parent;
  }
  return 0;
}
