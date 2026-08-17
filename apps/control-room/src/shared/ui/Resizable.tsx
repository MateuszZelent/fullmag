"use client";

import { useEffect, useRef, type ComponentPropsWithoutRef } from "react";
import {
  Group,
  type GroupImperativeHandle,
  Panel,
  Separator,
  type Layout,
  type LayoutChangedMeta,
} from "react-resizable-panels";

import { cn } from "@/shared/utils/className";

type ResizablePanelGroupProps = Omit<
  ComponentPropsWithoutRef<typeof Group>,
  "orientation"
> & {
  autoSaveId?: string;
  direction?: "horizontal" | "vertical";
  panelCount?: number;
};

const PANEL_LAYOUT_TOTAL = 100;
const PANEL_LAYOUT_TOTAL_TOLERANCE = 0.01;

export function normalizeStoredPanelLayout(
  storedLayout: unknown,
  panelCount: number | undefined,
): Layout | undefined {
  if (
    !storedLayout ||
    typeof storedLayout !== "object" ||
    Array.isArray(storedLayout)
  ) {
    return undefined;
  }

  const entries = Object.entries(storedLayout);
  if (entries.length === 0) {
    return undefined;
  }

  if (
    typeof panelCount === "number" &&
    Number.isInteger(panelCount) &&
    panelCount > 0 &&
    entries.length !== panelCount
  ) {
    return undefined;
  }

  const layout: Layout = {};
  for (const [panelId, value] of entries) {
    if (typeof value !== "number") {
      return undefined;
    }
    layout[panelId] = value;
  }

  const sizes = Object.values(layout);
  if (sizes.some((value) => !Number.isFinite(value) || value <= 0)) {
    return undefined;
  }

  const total = sizes.reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - PANEL_LAYOUT_TOTAL) > PANEL_LAYOUT_TOTAL_TOLERANCE) {
    return undefined;
  }

  return layout;
}

function readStoredPanelLayout(
  autoSaveId: string | undefined,
  panelCount: number | undefined,
): Layout | undefined {
  if (!autoSaveId || typeof window === "undefined") {
    return undefined;
  }

  try {
    const storedLayout = window.localStorage.getItem(autoSaveId);

    if (!storedLayout) {
      return undefined;
    }

    const parsedLayout: unknown = JSON.parse(storedLayout);

    if (!parsedLayout || typeof parsedLayout !== "object") {
      return undefined;
    }

    return normalizeStoredPanelLayout(parsedLayout, panelCount);
  } catch {
    return undefined;
  }
}

export function ResizablePanelGroup({
  autoSaveId,
  className,
  direction = "horizontal",
  onLayoutChanged,
  panelCount,
  ...props
}: ResizablePanelGroupProps) {
  const groupRef = useRef<GroupImperativeHandle | null>(null);
  const canPersistLayoutRef = useRef(!autoSaveId);

  useEffect(() => {
    if (!autoSaveId) {
      canPersistLayoutRef.current = true;
      return;
    }

    const storedLayout = readStoredPanelLayout(autoSaveId, panelCount);
    canPersistLayoutRef.current = true;

    if (storedLayout) {
      try {
        groupRef.current?.setLayout(storedLayout);
      } catch {
        try {
          window.localStorage.removeItem(autoSaveId);
        } catch {
          return;
        }
      }
    }
  }, [autoSaveId, panelCount]);

  function handleLayoutChanged(layout: Layout, meta: LayoutChangedMeta): void {
    if (autoSaveId && canPersistLayoutRef.current) {
      try {
        window.localStorage.setItem(autoSaveId, JSON.stringify(layout));
      } catch {
        return;
      }
    }

    onLayoutChanged?.(layout, meta);
  }

  return (
    <Group
      className={cn("fm-resizable-group", className)}
      groupRef={groupRef}
      onLayoutChanged={handleLayoutChanged}
      orientation={direction}
      {...props}
    />
  );
}

export function ResizablePanel({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof Panel>) {
  return <Panel className={cn("fm-resizable-panel", className)} {...props} />;
}

export function ResizableHandle({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof Separator>) {
  return <Separator className={cn("fm-resize-handle", className)} {...props} />;
}
