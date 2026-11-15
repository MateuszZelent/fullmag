"use client";

import { GripHorizontal, Maximize2, Minimize2, MoveDiagonal2, X } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
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
  resizable?: boolean;
  maximizable?: boolean;
  onMaximize?: () => void;
  closeLabel?: string;
  role?: "dialog" | "region";
  keepMounted?: boolean;
}

interface DragState {
  offsetX: number;
  offsetY: number;
  pointerId: number;
  kind: "move" | "resize";
  width: number;
  height: number;
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
  resizable = false,
  maximizable = false,
  onMaximize,
  closeLabel = "Close panel",
  role = "dialog",
  keepMounted = false,
}: DraggablePanelProps) {
  const [position, setPosition] = useState(defaultPosition);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [maximized, setMaximized] = useState(false);
  const restorePositionRef = useRef(defaultPosition);
  const dragRef = useRef<DragState | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const headingId = useId();

  // Non-modal dialog focus contract: move focus into the panel when it opens
  // and return it to the invoker on close. Regions never steal focus.
  useEffect(() => {
    if (!open || role !== "dialog") return;
    const panel = panelRef.current;
    if (!panel) return;
    const active = document.activeElement;
    if (!panel.contains(active)) {
      returnFocusRef.current = active instanceof HTMLElement ? active : null;
      panel.focus({ preventScroll: true });
    }
    return () => {
      const target = returnFocusRef.current;
      returnFocusRef.current = null;
      const focusLeftPanel = !panel.isConnected
        || panel.contains(document.activeElement)
        || document.activeElement === document.body;
      if (target?.isConnected && focusLeftPanel) target.focus({ preventScroll: true });
    };
  }, [open, role]);

  useLayoutEffect(() => {
    if (!open) return;

    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const panel = panelRef.current;
      const width = panel?.offsetWidth ?? 420;
      const height = panel?.offsetHeight ?? 360;
      if (drag.kind === "resize") {
        const bounds = panel?.getBoundingClientRect();
        setSize({
          width: clamp(drag.width + event.clientX - drag.offsetX, 320, window.innerWidth - (bounds?.left ?? 8) - 8),
          height: clamp(drag.height + event.clientY - drag.offsetY, 240, window.innerHeight - (bounds?.top ?? 8) - 8),
        });
        return;
      }
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
    const constrainPosition = () => {
      if (maximized) return;
      const panel = panelRef.current;
      // ResizeObserver can run after the maximize commit, before this effect
      // is cleaned up. Never clamp the saved position to maximized dimensions.
      if (!panel || panel.dataset.maximized === "true") return;
      const maxX = window.innerWidth - panel.offsetWidth - 8;
      const maxY = window.innerHeight - panel.offsetHeight - 8;
      setPosition(previous => {
        const x = clamp(previous.x, 8, maxX);
        const y = clamp(previous.y, 8, maxY);
        return x === previous.x && y === previous.y ? previous : { x, y };
      });
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(constrainPosition);
    if (panelRef.current) observer?.observe(panelRef.current);
    window.addEventListener("resize", constrainPosition);
    constrainPosition();
    return () => {
      dragRef.current = null;
      observer?.disconnect();
      window.removeEventListener("resize", constrainPosition);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, [open, maximized]);

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (!panel || event.button !== 0 || maximized) return;
    if ((event.target as HTMLElement).closest("button:not([data-window-move])")) return;
    const bounds = panel.getBoundingClientRect();
    dragRef.current = {
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top,
      pointerId: event.pointerId,
      kind: "move",
      width: bounds.width,
      height: bounds.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const beginResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const panel = panelRef.current;
    if (!panel || event.button !== 0 || maximized) return;
    event.preventDefault();
    const bounds = panel.getBoundingClientRect();
    dragRef.current = {
      kind: "resize", pointerId: event.pointerId,
      offsetX: event.clientX, offsetY: event.clientY,
      width: bounds.width, height: bounds.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const adjustWithKeyboard = (event: ReactKeyboardEvent, kind: "move" | "resize") => {
    const delta = event.shiftKey ? 40 : 10;
    const dx = event.key === "ArrowRight" ? delta : event.key === "ArrowLeft" ? -delta : 0;
    const dy = event.key === "ArrowDown" ? delta : event.key === "ArrowUp" ? -delta : 0;
    const panel = panelRef.current;
    if ((!dx && !dy) || !panel || maximized) return;
    event.preventDefault();
    event.stopPropagation();
    if (kind === "move") {
      setPosition(previous => ({
        x: clamp(previous.x + dx, 8, window.innerWidth - panel.offsetWidth - 8),
        y: clamp(previous.y + dy, 8, window.innerHeight - panel.offsetHeight - 8),
      }));
    } else {
      setSize({
        width: clamp(panel.offsetWidth + dx, 320, window.innerWidth - position.x - 8),
        height: clamp(panel.offsetHeight + dy, 240, window.innerHeight - position.y - 8),
      });
    }
  };

  if (!open && !keepMounted) return null;

  return (
    <section
      ref={panelRef}
      aria-label={ariaLabel || undefined}
      aria-labelledby={ariaLabel ? undefined : headingId}
      hidden={!open}
      tabIndex={role === "dialog" ? -1 : undefined}
      aria-modal={role === "dialog" ? false : undefined}
      className={cn("fm-draggable-panel", className)}
      role={role}
      data-maximized={maximized}
      data-resizable={resizable}
      // Geometry must update synchronously: even a reduced-motion 1 ms
      // transition exposes stale dimensions to the viewport constraint.
      style={{ ...(maximized
        ? { left: 8, top: 8, width: "calc(100vw - 16px)", height: "calc(100dvh - 16px)" }
        : { left: position.x, top: position.y, ...(resizable ? size : {}) }),
        transitionProperty: "none",
        ...(!open ? { display: "none" } : {}),
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.stopPropagation();
          onOpenChange(false);
        }
      }}
    >
      <div className="fm-draggable-panel__handle" onPointerDown={beginDrag}>
        <Button
          aria-label="Move window with arrow keys"
          title="Drag the title bar or use arrow keys here (Shift for larger steps)"
          className="fm-draggable-panel__move"
          data-window-move
          disabled={maximized}
          size="icon"
          variant="ghost"
          type="button"
          onKeyDown={(event) => adjustWithKeyboard(event, "move")}
        >
          <GripHorizontal size={15} aria-hidden="true" />
        </Button>
        <div className="fm-draggable-panel__heading">
          <h2 id={headingId}>{title}</h2>
          {subtitle && <span>{subtitle}</span>}
        </div>
        
        {headerActions && (
          <div className="fm-draggable-panel__actions" onPointerDown={(e) => e.stopPropagation()}>
            {headerActions}
          </div>
        )}

        {maximizable ? (
          <Button
            aria-label={maximized ? "Restore window size" : "Maximize window"}
            title={maximized ? "Restore window size" : "Maximize window"}
            size="icon" variant="ghost" type="button"
            onClick={() => {
              if (!maximized) {
                restorePositionRef.current = position;
                onMaximize?.();
              } else {
                setPosition(restorePositionRef.current);
              }
              setMaximized(previous => !previous);
            }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {maximized ? <Minimize2 size={15} aria-hidden="true" /> : <Maximize2 size={15} aria-hidden="true" />}
          </Button>
        ) : null}
        <Button
          aria-label={closeLabel}
          className="fm-draggable-panel__icon-btn"
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
      {resizable && !maximized ? (
        <Button
          aria-label="Resize window with arrow keys"
          title="Drag to resize, or use arrow keys"
          className="fm-draggable-panel__resize"
          size="icon" variant="ghost" type="button"
          onPointerDown={beginResize}
          onKeyDown={(event) => adjustWithKeyboard(event, "resize")}
        >
          <MoveDiagonal2 size={16} aria-hidden="true" />
        </Button>
      ) : null}
    </section>
  );
}
