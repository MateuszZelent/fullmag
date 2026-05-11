"use client";

import { useEffect, useRef, type ComponentPropsWithoutRef } from "react";
import {
  Group,
  type GroupImperativeHandle,
  Panel,
  Separator,
  type Layout,
} from "react-resizable-panels";

import { cn } from "@/shared/utils/className";

type ResizablePanelGroupProps = Omit<
  ComponentPropsWithoutRef<typeof Group>,
  "orientation"
> & {
  autoSaveId?: string;
  direction?: "horizontal" | "vertical";
};

function readStoredPanelLayout(autoSaveId: string | undefined): Layout | undefined {
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

    return parsedLayout as Layout;
  } catch {
    return undefined;
  }
}

export function ResizablePanelGroup({
  autoSaveId,
  className,
  direction = "horizontal",
  onLayoutChanged,
  ...props
}: ResizablePanelGroupProps) {
  const groupRef = useRef<GroupImperativeHandle | null>(null);
  const canPersistLayoutRef = useRef(!autoSaveId);

  useEffect(() => {
    if (!autoSaveId) {
      canPersistLayoutRef.current = true;
      return;
    }

    const storedLayout = readStoredPanelLayout(autoSaveId);
    canPersistLayoutRef.current = true;

    if (storedLayout) {
      groupRef.current?.setLayout(storedLayout);
    }
  }, [autoSaveId]);

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
