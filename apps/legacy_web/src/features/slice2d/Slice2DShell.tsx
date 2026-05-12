"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Bug, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Slice2DModel } from "./types";
import type { CrossSurfaceSelectionState } from "../workspaceSync/contracts";

interface Slice2DShellProps {
  model: Slice2DModel;
  children?: ReactNode;
  selection?: CrossSurfaceSelectionState | null;
  debugPanel?: ReactNode;
}

export function Slice2DShell({
  model,
  children,
  selection,
  debugPanel,
}: Slice2DShellProps) {
  const shellRef = useRef<HTMLElement | null>(null);
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugPosition, setDebugPosition] = useState({ x: 24, y: 24 });
  const [debugSize, setDebugSize] = useState({ width: 560, height: 360 });
  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const resizeStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originWidth: number;
    originHeight: number;
  } | null>(null);

  useEffect(() => {
    if (!debugPanel) {
      setDebugOpen(false);
    }
  }, [debugPanel]);

  useEffect(() => {
    if (!debugOpen) {
      dragStateRef.current = null;
      resizeStateRef.current = null;
      return undefined;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const shell = shellRef.current;
      if (!shell) return;
      const bounds = shell.getBoundingClientRect();

      if (dragStateRef.current && dragStateRef.current.pointerId === event.pointerId) {
        const nextX =
          dragStateRef.current.originX + (event.clientX - dragStateRef.current.startX);
        const nextY =
          dragStateRef.current.originY + (event.clientY - dragStateRef.current.startY);
        const maxX = Math.max(0, bounds.width - debugSize.width);
        const maxY = Math.max(0, bounds.height - debugSize.height);
        setDebugPosition({
          x: clamp(nextX, 0, maxX),
          y: clamp(nextY, 0, maxY),
        });
        return;
      }

      if (resizeStateRef.current && resizeStateRef.current.pointerId === event.pointerId) {
        const minWidth = 380;
        const minHeight = 220;
        const maxWidth = Math.max(minWidth, bounds.width - debugPosition.x - 12);
        const maxHeight = Math.max(minHeight, bounds.height - debugPosition.y - 12);
        const nextWidth =
          resizeStateRef.current.originWidth + (event.clientX - resizeStateRef.current.startX);
        const nextHeight =
          resizeStateRef.current.originHeight + (event.clientY - resizeStateRef.current.startY);
        setDebugSize({
          width: clamp(nextWidth, minWidth, maxWidth),
          height: clamp(nextHeight, minHeight, maxHeight),
        });
      }
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (dragStateRef.current?.pointerId === event.pointerId) {
        dragStateRef.current = null;
      }
      if (resizeStateRef.current?.pointerId === event.pointerId) {
        resizeStateRef.current = null;
      }
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [debugOpen, debugPosition.x, debugPosition.y, debugSize.height, debugSize.width]);

  const handleDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: debugPosition.x,
      originY: debugPosition.y,
    };
  };

  const handleResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    resizeStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originWidth: debugSize.width,
      originHeight: debugSize.height,
    };
  };

  return (
    <section
      ref={shellRef}
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
      data-surface="slice2d"
      data-status={model.diagnostics.status}
      data-selected-kind={selection?.primary.kind ?? "none"}
      data-selected-id={selection?.primary.id ?? undefined}
    >
      <div className="min-h-0 flex-1 p-3">
        <main className="relative h-full overflow-hidden rounded border border-border/30 bg-card/20">
          <div className="absolute left-3 top-3 z-10 rounded bg-background/80 px-2 py-1 text-xs text-muted-foreground">
            {model.render.sampling} · {model.render.query?.plane ?? "no slice"}
          </div>
          {debugPanel ? (
            <div className="absolute right-3 top-3 z-20">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 gap-2 bg-background/85 backdrop-blur"
                onClick={() => setDebugOpen((open) => !open)}
              >
                <Bug className="h-3.5 w-3.5" />
                Debug
              </Button>
            </div>
          ) : null}
          {children ?? (
            <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
              No 2D slice renderer is available for this domain.
            </div>
          )}
          {debugPanel && debugOpen ? (
            <div
              className="absolute z-30 overflow-hidden rounded-xl border border-amber-500/40 bg-background/95 shadow-2xl backdrop-blur"
              style={{
                left: `${debugPosition.x}px`,
                top: `${debugPosition.y}px`,
                width: `${debugSize.width}px`,
                height: `${debugSize.height}px`,
              }}
            >
              <div
                className="flex cursor-move items-center justify-between border-b border-border/40 bg-amber-500/10 px-3 py-2"
                onPointerDown={handleDragStart}
              >
                <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                  <Bug className="h-3.5 w-3.5 text-amber-300" />
                  2D Slice Debug
                </div>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={() => setDebugOpen(false)}
                  aria-label="Close 2D slice debug window"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="h-[calc(100%-40px)] overflow-auto p-3">
                {debugPanel}
              </div>
              <div
                className="absolute bottom-0 right-0 h-4 w-4 cursor-se-resize bg-gradient-to-br from-transparent via-amber-300/30 to-amber-300/70"
                onPointerDown={handleResizeStart}
              />
            </div>
          ) : null}
        </main>
      </div>
    </section>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
