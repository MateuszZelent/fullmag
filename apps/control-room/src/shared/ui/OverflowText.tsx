"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type ReactNode,
} from "react";

import { cn } from "@/shared/utils/className";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./Tooltip";

export interface OverflowTextProps
  extends Omit<ComponentPropsWithRef<"span">, "title" | "children"> {
  /** Full string kept in the DOM so assistive tech, copy, and find-in-page always see it. */
  children: string;
  /** Optional supplementary detail displayed in the reveal tooltip in addition to the full text. */
  extraDetail?: ReactNode;
  /** Keep the truncated text reachable from keyboard focus when not wrapped by an interactive ancestor. */
  focusable?: boolean;
}

/**
 * Single-line overflow text primitive (`modern-web-guidance: single-line-overflow`).
 * Never uses the mouse-only `title` attribute: reveals the complete untruncated
 * value on both `:hover` and `:focus-visible`, and hides duplicate tooltip text
 * from assistive technology so screen readers do not announce it twice.
 */
export function OverflowText({
  children,
  className,
  extraDetail,
  focusable = true,
  ref,
  tabIndex,
  ...props
}: OverflowTextProps) {
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    const node = hostRef.current;
    if (!node) return;
    let cancelled = false;

    const syncTruncation = () => {
      if (cancelled) return;
      const hiddenWidth =
        children.length === 0
          ? 0
          : Math.max(0, node.scrollWidth - node.clientWidth);
      const nextTruncated = hiddenWidth > 0;
      if (node.style) {
        node.style.setProperty("--scroll-width", String(hiddenWidth));
      }
      setTruncated((previous) =>
        previous === nextTruncated ? previous : nextTruncated,
      );
    };

    const observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(syncTruncation)
        : null;
    observer?.observe(node);

    const frameId =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(syncTruncation)
        : null;
    if (frameId === null) {
      queueMicrotask(syncTruncation);
    }

    return () => {
      cancelled = true;
      observer?.disconnect();
      if (frameId !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(frameId);
      }
    };
  }, [children]);

  const setRefs = useCallback(
    (node: HTMLSpanElement | null) => {
      hostRef.current = node;
      if (typeof ref === "function") {
        ref(node);
      } else if (ref && "current" in ref) {
        ref.current = node;
      }
    },
    [ref],
  );

  const resolvedTabIndex = tabIndex ?? (focusable ? 0 : undefined);

  const textNode = (
    <span
      ref={setRefs}
      className={cn("fm-overflow-text", className)}
      data-slot="overflow-text"
      data-truncated={truncated ? "true" : "false"}
      tabIndex={resolvedTabIndex}
      {...props}
    >
      <span className="fm-overflow-text__inner">{children}</span>
    </span>
  );

  if (!truncated && !extraDetail) {
    return textNode;
  }

  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>{textNode}</TooltipTrigger>
        <TooltipContent>
          <span aria-hidden="true">{children}</span>
          {extraDetail ? <span> {extraDetail}</span> : null}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
