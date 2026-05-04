"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface SwitchProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  (
    {
      className,
      checked,
      defaultChecked = false,
      onCheckedChange,
      onClick,
      disabled,
      ...props
    },
    ref,
  ) => {
    const isControlled = checked !== undefined;
    const [internalChecked, setInternalChecked] = React.useState(defaultChecked);
    const resolvedChecked = isControlled ? checked : internalChecked;

    const toggle = React.useCallback(() => {
      if (disabled) {
        return;
      }
      const next = !resolvedChecked;
      if (!isControlled) {
        setInternalChecked(next);
      }
      onCheckedChange?.(next);
    }, [disabled, isControlled, onCheckedChange, resolvedChecked]);

    return (
      <button
        ref={ref}
        type="button"
        role="switch"
        aria-checked={resolvedChecked}
        data-state={resolvedChecked ? "checked" : "unchecked"}
        className={cn(
          "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent",
          "transition-colors duration-200",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "data-[state=checked]:bg-primary data-[state=unchecked]:bg-[hsla(0,0%,100%,0.1)]",
          className,
        )}
        disabled={disabled}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) {
            toggle();
          }
        }}
        {...props}
      >
        <span
          data-state={resolvedChecked ? "checked" : "unchecked"}
          className={cn(
            "pointer-events-none block h-4 w-4 rounded-full bg-white shadow-lg ring-0",
            "transition-transform duration-200",
            "data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0",
          )}
        />
      </button>
    );
  },
);
Switch.displayName = "Switch";

export { Switch };
