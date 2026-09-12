"use client";

/**
 * P6 — Builder Context Menu Actions
 *
 * Returns context menu items for geometry builder primitives.
 */

import type { PrimitiveNode } from "../model/types";
import { useGeometryBuilderStore } from "../store/useGeometryBuilderStore";

export interface BuilderContextMenuItem {
  id: string;
  label: string;
  icon?: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  action: () => void;
}

export function useBuilderContextMenu(primitiveId: string | null): BuilderContextMenuItem[] {
  const node = useGeometryBuilderStore((s) =>
    primitiveId ? s.getPrimitive(primitiveId) : null,
  );
  const removePrimitive = useGeometryBuilderStore((s) => s.removePrimitive);
  const duplicatePrimitive = useGeometryBuilderStore((s) => s.duplicatePrimitive);
  const setPrimitiveVisible = useGeometryBuilderStore((s) => s.setPrimitiveVisible);
  const setPrimitiveEnabled = useGeometryBuilderStore((s) => s.setPrimitiveEnabled);
  const setPrimitiveLocked = useGeometryBuilderStore((s) => s.setPrimitiveLocked);
  const setPrimitiveTransform = useGeometryBuilderStore((s) => s.setPrimitiveTransform);

  if (!node || !primitiveId) return [];

  return [
    {
      id: "builder.duplicate",
      label: "Duplicate",
      icon: "copy",
      shortcut: "Ctrl+D",
      action: () => duplicatePrimitive(primitiveId),
    },
    {
      id: "builder.toggle-visible",
      label: node.visible ? "Hide" : "Show",
      icon: node.visible ? "eye-off" : "eye",
      action: () => setPrimitiveVisible(primitiveId, !node.visible),
    },
    {
      id: "builder.toggle-enabled",
      label: node.enabled ? "Disable" : "Enable",
      icon: node.enabled ? "power-off" : "power",
      action: () => setPrimitiveEnabled(primitiveId, !node.enabled),
    },
    {
      id: "builder.toggle-locked",
      label: node.locked ? "Unlock" : "Lock",
      icon: node.locked ? "unlock" : "lock",
      action: () => setPrimitiveLocked(primitiveId, !node.locked),
    },
    {
      id: "builder.center-in-universe",
      label: "Center in Universe",
      icon: "crosshair",
      action: () =>
        setPrimitiveTransform(primitiveId, {
          ...node.transform,
          translation: [0, 0, 0],
        }),
    },
    {
      id: "builder.reset-transform",
      label: "Reset Transform",
      icon: "rotate-ccw",
      action: () =>
        setPrimitiveTransform(primitiveId, {
          translation: [0, 0, 0],
          rotationQuat: [0, 0, 0, 1],
          scale: [1, 1, 1],
        }),
    },
    {
      id: "builder.delete",
      label: "Delete",
      icon: "trash-2",
      shortcut: "Del",
      danger: true,
      action: () => removePrimitive(primitiveId),
    },
  ];
}
