"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface TabsContextValue {
  value: string | undefined;
  setValue: (next: string) => void;
  variant: "underline" | "pill";
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
  variant?: "underline" | "pill";
}

const Tabs = React.forwardRef<HTMLDivElement, TabsProps>(
  ({ className, value, defaultValue, onValueChange, variant = "underline", children, ...props }, ref) => {
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
      () => ({ value: resolvedValue, setValue, variant }),
      [resolvedValue, setValue, variant],
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
  ({ className, ...props }, ref) => {
    const { variant } = useTabsContext("TabsList");
    return (
      <div
        ref={ref}
        role="tablist"
        className={cn(
          "inline-flex items-center justify-center",
          variant === "pill" ? "gap-1 rounded-md p-1 bg-transparent" : "h-9 bg-transparent",
          className,
        )}
        {...props}
      />
    );
  }
);
TabsList.displayName = "TabsList";

interface TabsTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
}

const TabsTrigger = React.forwardRef<HTMLButtonElement, TabsTriggerProps>(
  ({ className, value, onClick, onKeyDown, disabled, ...props }, ref) => {
    const { value: activeValue, setValue, variant } = useTabsContext("TabsTrigger");
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
          "inline-flex items-center justify-center whitespace-nowrap px-3 py-1.5",
          "text-[length:var(--ide-text-xs)] font-medium tracking-wider transition-all duration-150",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ide-accent)] focus-visible:ring-offset-1",
          "disabled:pointer-events-none disabled:opacity-50 cursor-pointer",
          variant === "pill" ? cn(
            "rounded-md text-muted-foreground hover:text-foreground",
            "data-[state=active]:bg-primary/20 data-[state=active]:text-primary"
          ) : cn(
            "rounded-none border-b-2 border-transparent text-muted-foreground hover:text-foreground",
            "data-[state=active]:border-primary data-[state=active]:text-foreground"
          ),
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
          !forceMount && "data-[state=inactive]:hidden",
          className,
        )}
        {...props}
      />
    );
  },
);
TabsContent.displayName = "TabsContent";

export { Tabs, TabsList, TabsTrigger, TabsContent };
