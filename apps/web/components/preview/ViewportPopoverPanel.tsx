"use client";

import {
  ReactNode,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
  cloneElement,
  isValidElement,
  Children,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

// ─── types ────────────────────────────────────────────────────────────────────

export interface ViewportPopoverPanelProps {
  /**
   * Ref to the trigger element (button/icon) used to calculate anchor position.
   * Either pass anchorRef OR wrap trigger + panel together in ViewportPopoverTrigger.
   */
  anchorRef?: RefObject<HTMLElement | null>;
  anchorElement?: HTMLElement | null;
  children: ReactNode;
  title?: ReactNode;
  className?: string;
  /** Which horizontal edge of the anchor to align against first. Default "left". */
  preferredHorizontal?: "left" | "right";
  /** Open below or above the anchor first. Default "bottom". */
  preferredVertical?: "bottom" | "top";
}

// ─── main panel (portal + fixed positioning) ──────────────────────────────────

export function ViewportPopoverPanel({
  anchorRef,
  anchorElement,
  children,
  title,
  className,
  preferredHorizontal = "left",
  preferredVertical = "bottom",
}: ViewportPopoverPanelProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [style, setStyle] = useState<React.CSSProperties>({
    visibility: "hidden",
    position: "fixed",
    top: 0,
    left: 0,
  });
  const mounted = typeof document !== "undefined";

  useLayoutEffect(() => {
    if (!mounted) return;

    function reposition() {
      const anchor = anchorElement ?? anchorRef?.current ?? null;
      const panel = panelRef.current;
      if (!anchor || !panel || typeof window === "undefined") return;

      const aRect = anchor.getBoundingClientRect();
      const pRect = panel.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const GAP = 6;
      const MARGIN = 8;

      // ── Vertical ──────────────────────────────────────────────────────────
      let top: number;
      if (preferredVertical === "bottom") {
        const candidate = aRect.bottom + GAP;
        top = candidate + pRect.height > vh - MARGIN ? aRect.top - GAP - pRect.height : candidate;
      } else {
        const candidate = aRect.top - GAP - pRect.height;
        top = candidate < MARGIN ? aRect.bottom + GAP : candidate;
      }
      top = Math.max(MARGIN, Math.min(top, vh - pRect.height - MARGIN));

      // ── Horizontal ────────────────────────────────────────────────────────
      let left: number;
      if (preferredHorizontal === "left") {
        left = aRect.left;
        if (left + pRect.width > vw - MARGIN) left = aRect.right - pRect.width;
      } else {
        left = aRect.right - pRect.width;
        if (left < MARGIN) left = aRect.left;
      }
      left = Math.max(MARGIN, Math.min(left, vw - pRect.width - MARGIN));

      setStyle({ position: "fixed", top, left, visibility: "visible" });
    }

    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [mounted, anchorElement, anchorRef, children, preferredHorizontal, preferredVertical, title]);

  if (!mounted) return null;

  return createPortal(
    <div
      ref={panelRef}
      style={style}
      className={cn(
        "min-w-[200px] max-w-[320px] p-2.5 rounded-lg z-[9999]",
        "bg-popover/95 backdrop-blur-md border border-border/50 shadow-xl",
        "flex flex-col gap-2 pointer-events-auto",
        "max-h-[min(22rem,calc(100vh-2rem))] overflow-y-auto",
        className,
      )}
    >
      {title && (
        <div className="text-[0.65rem] font-bold uppercase tracking-widest text-muted-foreground pb-1 border-b border-border/30 mb-1 sticky top-0 bg-popover/95">
          {title}
        </div>
      )}
      {children}
    </div>,
    document.body,
  );
}

// ─── convenience wrapper ──────────────────────────────────────────────────────
/**
 * Wraps a trigger element and its popover panel together.
 * The trigger MUST be the first child; the panel (ViewportPopoverPanel without anchorRef) MUST be
 * the second child.
 *
 * Usage:
 *   <ViewportPopoverTrigger preferredHorizontal="left">
 *     <ViewportIconAction ... />
 *     {open && <ViewportPopoverPanel title="...">...</ViewportPopoverPanel>}
 *   </ViewportPopoverTrigger>
 */
export interface ViewportPopoverTriggerProps {
  children: ReactNode;
  className?: string;
  preferredHorizontal?: "left" | "right";
  preferredVertical?: "bottom" | "top";
}

export function ViewportPopoverTrigger({
  children,
  className,
  preferredHorizontal = "left",
  preferredVertical = "bottom",
}: ViewportPopoverTriggerProps) {
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const array = Children.toArray(children);
  const trigger = array[0];
  const panel = array[1];

  return (
    <div ref={triggerRef} className={cn("relative inline-flex", className)}>
      {trigger}
      {panel && isValidElement<ViewportPopoverPanelProps>(panel)
        ? cloneElement(panel, {
            anchorRef: triggerRef as RefObject<HTMLElement | null>,
            preferredHorizontal: panel.props.preferredHorizontal ?? preferredHorizontal,
            preferredVertical: panel.props.preferredVertical ?? preferredVertical,
          })
        : null}
    </div>
  );
}

// ─── helper row ──────────────────────────────────────────────────────────────

export function ViewportPopoverRow({ children, label }: { children: ReactNode; label: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-[0.65rem] font-semibold text-muted-foreground w-12 shrink-0">{label}</span>
      <div className="flex items-center gap-1.5 flex-1">{children}</div>
    </div>
  );
}
