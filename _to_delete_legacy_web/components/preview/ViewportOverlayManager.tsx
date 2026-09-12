"use client";

import { ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";

import { ViewportOverlayLayout } from "./ViewportOverlayLayout";

export type ViewportOverlayAnchor =
  | "top-left"
  | "top-center"
  | "top-right"
  | "left"
  | "right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export type ViewportOverlayMode = "full" | "compact" | "icon";
export type ViewportOverlayVariant = "full" | "compact" | "icon" | "drawer" | "hidden";

export interface ViewportOverlayDescriptor {
  id: string;
  anchor: ViewportOverlayAnchor;
  priority?: number;
  minWidth?: number;
  className?: string;
  collapseTarget?: Exclude<ViewportOverlayVariant, "hidden">;
  hidden?: boolean;
  render: (layout: {
    width: number;
    height: number;
    mode: ViewportOverlayMode;
    variant: ViewportOverlayVariant;
  }) => ReactNode;
}

function resolveOverlayVariant(args: {
  descriptor: ViewportOverlayDescriptor;
  width: number;
  mode: ViewportOverlayMode;
}): ViewportOverlayVariant {
  const { descriptor, width, mode } = args;
  if (descriptor.hidden) {
    return "hidden";
  }
  if (mode === "full") {
    return "full";
  }
  if (descriptor.minWidth && width > 0 && width < descriptor.minWidth) {
    return descriptor.collapseTarget ?? mode;
  }
  if (mode === "compact") {
    return descriptor.priority != null && descriptor.priority >= 5
      ? (descriptor.collapseTarget ?? "icon")
      : "compact";
  }
  if (descriptor.priority != null && descriptor.priority >= 4) {
    return descriptor.collapseTarget ?? "drawer";
  }
  return descriptor.collapseTarget ?? "icon";
}

function slotClassForVariant(
  variant: ViewportOverlayVariant,
  anchor: ViewportOverlayAnchor,
): string | undefined {
  if (variant === "drawer") {
    if (anchor === "top-right" || anchor === "right") {
      return "w-[min(24rem,92vw)] max-w-[92vw]";
    }
    return "w-[min(36rem,94vw)] max-w-[94vw]";
  }
  if (variant === "icon") {
    return "max-w-[min(16rem,88vw)]";
  }
  return undefined;
}

export function ViewportOverlayManager({
  className,
  items,
  children,
}: {
  className?: string;
  items?: ViewportOverlayDescriptor[];
  children?: (layout: {
    width: number;
    height: number;
    mode: ViewportOverlayMode;
  }) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect;
      if (!next) {
        return;
      }
      setSize((previous) =>
        previous.width === next.width && previous.height === next.height
          ? previous
          : { width: next.width, height: next.height },
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const mode = useMemo<ViewportOverlayMode>(() => {
    const { width, height } = size;
    if (width > 0 && (width < 1024 || height < 480)) {
      return "icon";
    }
    if (width > 0 && (width < 1440 || height < 640)) {
      return "compact";
    }
    return "full";
  }, [size]);

  const renderedItems = useMemo(() => {
    if (!items) {
      return null;
    }
    const anchors: ViewportOverlayAnchor[] = [
      "top-left",
      "top-center",
      "top-right",
      "left",
      "right",
      "bottom-left",
      "bottom-center",
      "bottom-right",
    ];
    return anchors.map((anchor) => {
      const anchored = items
        .filter((item) => item.anchor === anchor && !item.hidden)
        .sort((left, right) => (left.priority ?? 99) - (right.priority ?? 99));
      if (anchored.length === 0) {
        return null;
      }
      return (
        <ViewportOverlaySlot key={anchor} anchor={anchor}>
          {anchored.map((item) => {
            const variant = resolveOverlayVariant({
              descriptor: item,
              width: size.width,
              mode,
            });
            if (variant === "hidden") {
              return null;
            }
            return (
              <div
                key={item.id}
                className={cn(slotClassForVariant(variant, anchor), item.className)}
              >
                {item.render({
                  width: size.width,
                  height: size.height,
                  mode,
                  variant,
                })}
              </div>
            );
          })}
        </ViewportOverlaySlot>
      );
    });
  }, [items, mode, size.height, size.width]);

  return (
    <div ref={ref} className="absolute inset-0 pointer-events-none z-20">
      <ViewportOverlayLayout className={className}>
        {renderedItems ?? children?.({ width: size.width, height: size.height, mode }) ?? null}
      </ViewportOverlayLayout>
    </div>
  );
}

export function ViewportOverlaySlot({
  anchor,
  className,
  children,
}: {
  anchor: ViewportOverlayAnchor;
  className?: string;
  children: ReactNode;
}) {
  switch (anchor) {
    case "top-left":
      return (
        <ViewportOverlayLayout.TopLeft className={className}>
          {children}
        </ViewportOverlayLayout.TopLeft>
      );
    case "top-center":
      return (
        <ViewportOverlayLayout.TopCenter className={className}>
          {children}
        </ViewportOverlayLayout.TopCenter>
      );
    case "top-right":
      return (
        <ViewportOverlayLayout.TopRight className={className}>
          {children}
        </ViewportOverlayLayout.TopRight>
      );
    case "left":
      return (
        <ViewportOverlayLayout.Left className={className}>
          {children}
        </ViewportOverlayLayout.Left>
      );
    case "right":
      return (
        <ViewportOverlayLayout.Right className={className}>
          {children}
        </ViewportOverlayLayout.Right>
      );
    case "bottom-left":
      return (
        <ViewportOverlayLayout.BottomLeft className={className}>
          {children}
        </ViewportOverlayLayout.BottomLeft>
      );
    case "bottom-center":
      return (
        <ViewportOverlayLayout.BottomCenter className={className}>
          {children}
        </ViewportOverlayLayout.BottomCenter>
      );
    case "bottom-right":
      return (
        <ViewportOverlayLayout.BottomRight className={className}>
          {children}
        </ViewportOverlayLayout.BottomRight>
      );
    default:
      return (
        <ViewportOverlayLayout.TopLeft className={className}>
          {children}
        </ViewportOverlayLayout.TopLeft>
      );
  }
}
