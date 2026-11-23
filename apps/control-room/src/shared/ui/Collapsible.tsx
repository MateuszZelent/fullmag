"use client";

import { Slot } from "@radix-ui/react-slot";
import {
  createContext,
  useCallback,
  useContext,
  useId,
  useMemo,
  useState,
  type ComponentPropsWithRef,
  type MouseEvent,
} from "react";

import { cn } from "@/shared/utils/className";

interface CollapsibleContextValue {
  contentId: string;
  disabled: boolean;
  open: boolean;
  setOpen: (nextOpen: boolean) => void;
}

const CollapsibleContext = createContext<CollapsibleContextValue | null>(null);

function useCollapsibleContext(componentName: string): CollapsibleContextValue {
  const context = useContext(CollapsibleContext);
  if (!context) {
    throw new Error(`${componentName} must be used within <Collapsible>.`);
  }
  return context;
}

export interface CollapsibleProps extends ComponentPropsWithRef<"div"> {
  defaultOpen?: boolean;
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
}

export function Collapsible({
  children,
  className,
  defaultOpen = false,
  disabled = false,
  onOpenChange,
  open: controlledOpen,
  ref,
  ...props
}: CollapsibleProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const contentId = useId();
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;

  const setOpen = useCallback(
    (nextOpen: boolean) => {
      if (disabled) return;
      if (!isControlled) setUncontrolledOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    [disabled, isControlled, onOpenChange],
  );

  const contextValue = useMemo(
    () => ({ contentId, disabled, open, setOpen }),
    [contentId, disabled, open, setOpen],
  );

  return (
    <CollapsibleContext.Provider value={contextValue}>
      <div
        ref={ref}
        className={cn("fm-collapsible", className)}
        data-disabled={disabled ? "" : undefined}
        data-slot="collapsible"
        data-state={open ? "open" : "closed"}
        {...props}
      >
        {children}
      </div>
    </CollapsibleContext.Provider>
  );
}

export interface CollapsibleTriggerProps extends ComponentPropsWithRef<"button"> {
  asChild?: boolean;
}

export function CollapsibleTrigger({
  asChild = false,
  className,
  disabled,
  onClick,
  type = "button",
  ...props
}: CollapsibleTriggerProps) {
  const context = useCollapsibleContext("CollapsibleTrigger");
  const isDisabled = Boolean(disabled || context.disabled);

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (!event.defaultPrevented && !isDisabled) {
      context.setOpen(!context.open);
    }
  };

  if (asChild) {
    return (
      <Slot
        aria-controls={context.contentId}
        aria-expanded={context.open}
        className={cn("fm-collapsible-trigger", className)}
        data-disabled={isDisabled ? "" : undefined}
        data-slot="collapsible-trigger"
        data-state={context.open ? "open" : "closed"}
        onClick={handleClick as ComponentPropsWithRef<typeof Slot>["onClick"]}
        {...(props as ComponentPropsWithRef<typeof Slot>)}
      />
    );
  }

  return (
    <button
      aria-controls={context.contentId}
      aria-expanded={context.open}
      className={cn("fm-collapsible-trigger", className)}
      data-disabled={isDisabled ? "" : undefined}
      data-slot="collapsible-trigger"
      data-state={context.open ? "open" : "closed"}
      disabled={isDisabled}
      type={type}
      onClick={handleClick}
      {...props}
    />
  );
}

export interface CollapsibleContentProps extends ComponentPropsWithRef<"div"> {
  forceMount?: boolean;
}

export function CollapsibleContent({
  children,
  className,
  forceMount = false,
  id,
  ref,
  ...props
}: CollapsibleContentProps) {
  const context = useCollapsibleContext("CollapsibleContent");
  const isHidden = !context.open && !forceMount;

  return (
    <div
      ref={ref}
      className={cn("fm-collapsible-content", className)}
      data-disabled={context.disabled ? "" : undefined}
      data-slot="collapsible-content"
      data-state={context.open ? "open" : "closed"}
      hidden={isHidden}
      id={id ?? context.contentId}
      {...props}
    >
      {children}
    </div>
  );
}
