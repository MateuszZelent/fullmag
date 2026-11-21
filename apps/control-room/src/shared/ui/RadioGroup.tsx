"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ComponentPropsWithRef,
  type KeyboardEvent,
} from "react";

import { cn } from "@/shared/utils/className";

type RadioGroupOrientation = "vertical" | "horizontal";

interface RadioGroupContextValue {
  disabled: boolean;
  name?: string;
  orientation: RadioGroupOrientation;
  required: boolean;
  selectValue: (value: string) => void;
  value: string | undefined;
}

const RadioGroupContext = createContext<RadioGroupContextValue | null>(null);

function useRadioGroupContext(componentName: string): RadioGroupContextValue {
  const context = useContext(RadioGroupContext);
  if (!context) {
    throw new Error(`${componentName} must be used within <RadioGroup>.`);
  }
  return context;
}

export interface RadioGroupProps
  extends Omit<ComponentPropsWithRef<"div">, "defaultValue" | "onChange"> {
  defaultValue?: string;
  disabled?: boolean;
  name?: string;
  onValueChange?: (value: string) => void;
  orientation?: RadioGroupOrientation;
  required?: boolean;
  value?: string;
}

export function RadioGroup({
  children,
  className,
  defaultValue,
  disabled = false,
  name,
  onValueChange,
  orientation = "vertical",
  ref,
  required = false,
  value: controlledValue,
  ...props
}: RadioGroupProps) {
  const [uncontrolledValue, setUncontrolledValue] = useState<string | undefined>(
    defaultValue,
  );
  const isControlled = controlledValue !== undefined;
  const value = isControlled ? controlledValue : uncontrolledValue;

  const selectValue = useCallback(
    (nextValue: string) => {
      if (disabled) return;
      if (!isControlled) setUncontrolledValue(nextValue);
      onValueChange?.(nextValue);
    },
    [disabled, isControlled, onValueChange],
  );

  const contextValue = useMemo<RadioGroupContextValue>(
    () => ({ disabled, name, orientation, required, selectValue, value }),
    [disabled, name, orientation, required, selectValue, value],
  );

  return (
    <RadioGroupContext.Provider value={contextValue}>
      <div
        ref={ref}
        aria-orientation={orientation}
        aria-required={required || undefined}
        className={cn(
          "fm-radio-group",
          orientation === "horizontal" && "fm-radio-group--horizontal",
          className,
        )}
        data-disabled={disabled ? "" : undefined}
        data-orientation={orientation}
        data-slot="radio-group"
        role="radiogroup"
        {...props}
      >
        {children}
      </div>
    </RadioGroupContext.Provider>
  );
}

export interface RadioGroupItemProps
  extends Omit<ComponentPropsWithRef<"button">, "value"> {
  value: string;
}

export function RadioGroupItem({
  children,
  className,
  disabled,
  onClick,
  onKeyDown,
  ref,
  value,
  ...props
}: RadioGroupItemProps) {
  const context = useRadioGroupContext("RadioGroupItem");
  const isDisabled = Boolean(disabled || context.disabled);
  const checked = context.value === value;

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || isDisabled) return;

    const group = event.currentTarget.closest<HTMLElement>('[data-slot="radio-group"]');
    if (!group) return;
    const enabledItems = Array.from(
      group.querySelectorAll<HTMLButtonElement>('[data-slot="radio-group-item"]'),
    ).filter((item) => !item.disabled);
    if (enabledItems.length === 0) return;

    const currentIndex = enabledItems.indexOf(event.currentTarget);
    let nextIndex = -1;

    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % enabledItems.length;
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + enabledItems.length) % enabledItems.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = enabledItems.length - 1;
    } else if (event.key === " ") {
      event.preventDefault();
      context.selectValue(value);
      return;
    }

    if (nextIndex < 0) return;
    const nextItem = enabledItems[nextIndex];
    if (!nextItem) return;

    event.preventDefault();
    const nextValue = nextItem.getAttribute("data-value");
    if (nextValue !== null) context.selectValue(nextValue);
    nextItem.focus();
  };

  return (
    <button
      ref={ref}
      aria-checked={checked}
      className={cn("fm-radio-item", className)}
      data-disabled={isDisabled ? "" : undefined}
      data-slot="radio-group-item"
      data-state={checked ? "checked" : "unchecked"}
      data-value={value}
      disabled={isDisabled}
      role="radio"
      tabIndex={isDisabled ? -1 : checked || context.value === undefined ? 0 : -1}
      type="button"
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented && !isDisabled) {
          context.selectValue(value);
        }
      }}
      onKeyDown={handleKeyDown}
      {...props}
    >
      <span aria-hidden="true" className="fm-radio-item__control">
        <span className="fm-radio-item__indicator" />
      </span>
      {children ? <span className="fm-radio-item__label">{children}</span> : null}
    </button>
  );
}
