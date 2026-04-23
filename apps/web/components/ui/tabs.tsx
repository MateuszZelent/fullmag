"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface TabsContextValue {
  value: string | undefined;
  setValue: (next: string) => void;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

function useTabsContext(component: string): TabsContextValue {
  const context = React.useContext(TabsContext);
  if (!context) {
    throw new Error(`${component} must be used within Tabs.`);
  }
  return context;
}

interface TabsProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
}

const Tabs = React.forwardRef<HTMLDivElement, TabsProps>(
  ({ className, value, defaultValue, onValueChange, children, ...props }, ref) => {
    const isControlled = value !== undefined;
    const [internalValue, setInternalValue] = React.useState<string | undefined>(defaultValue);
    const resolvedValue = isControlled ? value : internalValue;

    const setValue = React.useCallback(
      (next: string) => {
        if (!isControlled) {
          setInternalValue((current) => (current === next ? current : next));
        }
        if (next !== resolvedValue) {
          onValueChange?.(next);
        }
      },
      [isControlled, onValueChange, resolvedValue],
    );

    const context = React.useMemo<TabsContextValue>(
      () => ({ value: resolvedValue, setValue }),
      [resolvedValue, setValue],
    );

    return (
      <TabsContext.Provider value={context}>
        <div ref={ref} className={cn("flex flex-col", className)} {...props}>
          {children}
        </div>
      </TabsContext.Provider>
    );
  },
);
Tabs.displayName = "Tabs";

const TabsList = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      role="tablist"
      className={cn(
        "inline-flex h-9 items-center justify-center rounded-lg p-1",
        "bg-[var(--ide-surface-raised)] border border-[var(--ide-border-subtle)]",
        className,
      )}
      {...props}
    />
  ),
);
TabsList.displayName = "TabsList";

interface TabsTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
}

const TabsTrigger = React.forwardRef<HTMLButtonElement, TabsTriggerProps>(
  ({ className, value, onClick, onKeyDown, disabled, ...props }, ref) => {
    const { value: activeValue, setValue } = useTabsContext("TabsTrigger");
    const active = activeValue === value;
    return (
      <button
        ref={ref}
        type="button"
        role="tab"
        tabIndex={active ? 0 : -1}
        aria-selected={active}
        data-state={active ? "active" : "inactive"}
        disabled={disabled}
        className={cn(
          "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1",
          "text-[length:var(--ide-text-xs)] font-bold uppercase tracking-wider",
          "text-[var(--ide-text-3)]",
          "ring-offset-[var(--ide-bg)] transition-all duration-150",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ide-accent)] focus-visible:ring-offset-1",
          "disabled:pointer-events-none disabled:opacity-50",
          "data-[state=active]:bg-[var(--ide-accent-bg)] data-[state=active]:text-[var(--ide-accent-text)]",
          "data-[state=active]:border data-[state=active]:border-[var(--ide-accent)]",
          "data-[state=active]:shadow-sm",
          "cursor-pointer",
          className,
        )}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented && !disabled) {
            setValue(value);
          }
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented || disabled) {
            return;
          }
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setValue(value);
          }
        }}
        {...props}
      />
    );
  },
);
TabsTrigger.displayName = "TabsTrigger";

interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
  forceMount?: boolean;
}

const TabsContent = React.forwardRef<HTMLDivElement, TabsContentProps>(
  ({ className, value, forceMount, hidden, ...props }, ref) => {
    const { value: activeValue } = useTabsContext("TabsContent");
    const active = activeValue === value;
    if (!active && !forceMount) {
      return null;
    }
    return (
      <div
        ref={ref}
        role="tabpanel"
        data-state={active ? "active" : "inactive"}
        hidden={hidden ?? !active}
        className={cn(
          "mt-2 ring-offset-[var(--ide-bg)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ide-accent)] focus-visible:ring-offset-2",
          "data-[state=inactive]:hidden",
          className,
        )}
        {...props}
      />
    );
  },
);
TabsContent.displayName = "TabsContent";

export { Tabs, TabsList, TabsTrigger, TabsContent };
