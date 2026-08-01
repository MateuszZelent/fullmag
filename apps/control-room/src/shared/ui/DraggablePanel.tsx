"use client";

import { GripHorizontal, X } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Button } from "./Button";
import { cn } from "@/shared/utils/className";

interface DraggablePanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  subtitle?: string;
  className?: string;
  defaultPosition?: { x: number; y: number };
  children: ReactNode;
  headerActions?: ReactNode;
  ariaLabel?: string;
}

interface DragState {
  offsetX: number;
  offsetY: number;
  pointerId: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function DraggablePanel({
  open,
  onOpenChange,
  title,
  subtitle,
  className,
  defaultPosition = { x: 96, y: 96 },
  children,
  headerActions,
  ariaLabel,
}: DraggablePanelProps) {
  const [position, setPosition] = useState(defaultPosition);
  const dragRef = useRef<DragState | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const panel = panelRef.current;
      const width = panel?.offsetWidth ?? 420;
      const height = panel?.offsetHeight ?? 360;
      setPosition({
        x: clamp(event.clientX - drag.offsetX, 8, window.innerWidth - width - 8),
        y: clamp(event.clientY - drag.offsetY, 8, window.innerHeight - height - 8),
      });
    };

    const onPointerUp = (event: PointerEvent) => {
      if (dragRef.current?.pointerId === event.pointerId) {
        dragRef.current = null;
      }
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, [open]);

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (!panel || event.button !== 0) return;
    const bounds = panel.getBoundingClientRect();
    dragRef.current = {
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top,
      pointerId: event.pointerId,
    };
  };

  if (!open) return null;

  return (
    <section
      ref={panelRef}
      aria-label={ariaLabel || title}
      aria-modal="false"
      className={cn("fm-draggable-panel", className)}
      role="dialog"
      style={{ left: position.x, top: position.y }}
    >
      <div className="fm-draggable-panel__handle" onPointerDown={beginDrag}>
        <GripHorizontal size={15} className="text-muted-foreground mr-1" aria-hidden="true" />
        <div className="fm-draggable-panel__heading">
          <h2>{title}</h2>
          {subtitle && <span>{subtitle}</span>}
        </div>
        
        {headerActions && (
          <div className="flex items-center gap-1" onPointerDown={(e) => e.stopPropagation()}>
            {headerActions}
          </div>
        )}

        <Button
          aria-label="Close panel"
          className="fm-draggable-panel__icon-btn ml-auto"
          size="icon"
          title="Close"
          type="button"
          variant="ghost"
          onClick={() => onOpenChange(false)}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <X size={14} aria-hidden="true" />
        </Button>
      </div>

      <div className="fm-draggable-panel__content">
        {children}
      </div>
    </section>
  );
}
