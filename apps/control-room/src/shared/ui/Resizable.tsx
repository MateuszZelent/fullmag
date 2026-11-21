"use client";

import { useEffect, useRef, type ComponentPropsWithoutRef } from "react";
import { Group, type GroupImperativeHandle, Panel, Separator, type Layout } from "react-resizable-panels";

import { cn } from "@/shared/utils/className";
import { normalizeStoredPanelLayout } from "./Resizable.model";

type ResizablePanelGroupProps = Omit<
  ComponentPropsWithoutRef<typeof Group>,
  "orientation"
> & {
  autoSaveId?: string;
  direction?: "horizontal" | "vertical";
  panelCount?: number;
};

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

  function handleLayoutChanged(layout: Layout): void {
    if (autoSaveId && canPersistLayoutRef.current) {
      try {
        window.localStorage.setItem(autoSaveId, JSON.stringify(layout));
      } catch {
        return;
      }
    }

    onLayoutChanged?.(layout);
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
