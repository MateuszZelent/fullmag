"use client";

import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface DraggableViewportBlockProps {
  children: (payload: { dragHandleProps: React.HTMLAttributes<HTMLElement> }) => ReactNode;
  className?: string;
  defaultOffset?: { x: number; y: number };
}

export function DraggableViewportBlock({
  children,
  className,
  defaultOffset = { x: 0, y: 0 },
}: DraggableViewportBlockProps) {
  const [offset, setOffset] = useState(defaultOffset);
  const dragHandleProps: React.HTMLAttributes<HTMLElement> = {
    className:
      "cursor-grab active:cursor-grabbing touch-none select-none rounded-md border border-border/20 bg-background/35 px-2 py-1 text-[0.6rem] font-semibold text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground",
    title: "Move panel",
  };
  const dragRef = useRef<{
    dragging: boolean;
    pointerId: number | null;
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
  }>({
    dragging: false,
    pointerId: null,
    startX: 0,
    startY: 0,
    baseX: defaultOffset.x,
    baseY: defaultOffset.y,
  });

  useEffect(() => {
    setOffset(defaultOffset);
    dragRef.current.baseX = defaultOffset.x;
    dragRef.current.baseY = defaultOffset.y;
  }, [defaultOffset]);

  useEffect(() => {
    function onPointerMove(event: PointerEvent) {
      const drag = dragRef.current;
      if (!drag.dragging) {
        return;
      }
      const nextX = drag.baseX + (event.clientX - drag.startX);
      const nextY = drag.baseY + (event.clientY - drag.startY);
      setOffset({ x: nextX, y: nextY });
    }

    function stopDragging() {
      const drag = dragRef.current;
      if (!drag.dragging) {
        return;
      }
      drag.dragging = false;
      drag.pointerId = null;
      drag.baseX = offset.x;
      drag.baseY = offset.y;
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("pointercancel", stopDragging);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
    };
  }, [offset.x, offset.y]);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    dragRef.current.dragging = true;
    dragRef.current.pointerId = event.pointerId;
    dragRef.current.startX = event.clientX;
    dragRef.current.startY = event.clientY;
    dragRef.current.baseX = offset.x;
    dragRef.current.baseY = offset.y;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }, [offset.x, offset.y]);

  dragHandleProps.onPointerDown = handlePointerDown;

  return (
    <div
      className={cn("pointer-events-auto will-change-transform", className)}
      style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0)` }}
    >
      {children({ dragHandleProps })}
    </div>
  );
}
