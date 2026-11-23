"use client";

import * as PopoverPrimitive from "@radix-ui/react-popover";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type FocusEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import { cn } from "@/shared/utils/className";

interface HoverCardContextValue {
  closeImmediately: () => void;
  openImmediately: () => void;
  scheduleClose: () => void;
  scheduleOpen: () => void;
}

const HoverCardContext = createContext<HoverCardContextValue | null>(null);

function useHoverCardContext(componentName: string): HoverCardContextValue {
  const context = useContext(HoverCardContext);
  if (!context) {
    throw new Error(`${componentName} must be used within <HoverCard>.`);
  }
  return context;
}

export interface HoverCardProps {
  children: ReactNode;
  closeDelay?: number;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  openDelay?: number;
}

/**
 * Hover and keyboard-focus definition card built on `@radix-ui/react-popover`
 * without requiring an extra Radix package dependency.
 */
export function HoverCard({
  children,
  closeDelay = 80,
  defaultOpen = false,
  onOpenChange,
  open: controlledOpen,
  openDelay = 350,
}: HoverCardProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;

  const clearTimers = useCallback(() => {
    if (openTimerRef.current !== null) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const setOpen = useCallback(
    (nextOpen: boolean) => {
      if (!isControlled) setUncontrolledOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [isControlled, onOpenChange],
  );

  const scheduleOpen = useCallback(() => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (openDelay <= 0) {
      setOpen(true);
      return;
    }
    if (openTimerRef.current !== null) clearTimeout(openTimerRef.current);
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = null;
      setOpen(true);
    }, openDelay);
  }, [openDelay, setOpen]);

  const scheduleClose = useCallback(() => {
    if (openTimerRef.current !== null) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeDelay <= 0) {
      setOpen(false);
      return;
    }
    if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
    }, closeDelay);
  }, [closeDelay, setOpen]);

  const openImmediately = useCallback(() => {
    clearTimers();
    setOpen(true);
  }, [clearTimers, setOpen]);

  const closeImmediately = useCallback(() => {
    clearTimers();
    setOpen(false);
  }, [clearTimers, setOpen]);

  useEffect(() => clearTimers, [clearTimers]);

  const contextValue = useMemo(
    () => ({ closeImmediately, openImmediately, scheduleClose, scheduleOpen }),
    [closeImmediately, openImmediately, scheduleClose, scheduleOpen],
  );

  return (
    <HoverCardContext.Provider value={contextValue}>
      <PopoverPrimitive.Root modal={false} open={open} onOpenChange={setOpen}>
        {children}
      </PopoverPrimitive.Root>
    </HoverCardContext.Provider>
  );
}

export function HoverCardTrigger({
  onBlur,
  onFocus,
  onPointerEnter,
  onPointerLeave,
  ref,
  ...props
}: ComponentPropsWithRef<typeof PopoverPrimitive.Trigger>) {
  const context = useHoverCardContext("HoverCardTrigger");

  return (
    <PopoverPrimitive.Trigger
      ref={ref}
      data-slot="hover-card-trigger"
      onBlur={(event: FocusEvent<HTMLButtonElement>) => {
        onBlur?.(event);
        context.scheduleClose();
      }}
      onFocus={(event: FocusEvent<HTMLButtonElement>) => {
        onFocus?.(event);
        context.openImmediately();
      }}
      onPointerEnter={(event: PointerEvent<HTMLButtonElement>) => {
        onPointerEnter?.(event);
        if (event.pointerType !== "touch") context.scheduleOpen();
      }}
      onPointerLeave={(event: PointerEvent<HTMLButtonElement>) => {
        onPointerLeave?.(event);
        if (event.pointerType !== "touch") context.scheduleClose();
      }}
      {...props}
    />
  );
}
HoverCardTrigger.displayName = "HoverCardTrigger";

export function HoverCardContent({
  align = "center",
  className,
  collisionPadding = 8,
  onCloseAutoFocus,
  onOpenAutoFocus,
  onPointerEnter,
  onPointerLeave,
  ref,
  side = "left",
  sideOffset = 6,
  ...props
}: ComponentPropsWithRef<typeof PopoverPrimitive.Content>) {
  const context = useHoverCardContext("HoverCardContent");

  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ref}
        align={align}
        className={cn("fm-hover-card", className)}
        collisionPadding={collisionPadding}
        data-slot="hover-card-content"
        side={side}
        sideOffset={sideOffset}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onCloseAutoFocus?.(event);
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          onOpenAutoFocus?.(event);
        }}
        onPointerEnter={(event) => {
          onPointerEnter?.(event);
          context.openImmediately();
        }}
        onPointerLeave={(event) => {
          onPointerLeave?.(event);
          context.scheduleClose();
        }}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}
HoverCardContent.displayName = "HoverCardContent";
