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

type ToggleGroupOrientation = "horizontal" | "vertical";
type ToggleGroupSize = "sm" | "md";
type ToggleGroupVariant = "default" | "outline";

interface ToggleGroupContextValue {
  disabled: boolean;
  isPressed: (value: string) => boolean;
  orientation: ToggleGroupOrientation;
  rovingTargetValue: string | null;
  setRovingTargetValue: (value: string) => void;
  size: ToggleGroupSize;
  toggleValue: (value: string) => void;
  type: "single" | "multiple";
  variant: ToggleGroupVariant;
}

const ToggleGroupContext = createContext<ToggleGroupContextValue | null>(null);

function useToggleGroupContext(componentName: string): ToggleGroupContextValue {
  const context = useContext(ToggleGroupContext);
  if (!context) {
    throw new Error(`${componentName} must be used within <ToggleGroup>.`);
  }
  return context;
}

interface ToggleGroupBaseProps
  extends Omit<ComponentPropsWithRef<"div">, "defaultValue" | "onChange"> {
  disabled?: boolean;
  orientation?: ToggleGroupOrientation;
  size?: ToggleGroupSize;
  variant?: ToggleGroupVariant;
}

export interface ToggleGroupSingleProps extends ToggleGroupBaseProps {
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  type: "single";
  value?: string;
}

export interface ToggleGroupMultipleProps extends ToggleGroupBaseProps {
  defaultValue?: string[];
  onValueChange?: (value: string[]) => void;
  type: "multiple";
  value?: string[];
}

export type ToggleGroupProps = ToggleGroupSingleProps | ToggleGroupMultipleProps;

export function ToggleGroup(props: ToggleGroupProps) {
  const {
    children,
    className,
    defaultValue,
    disabled = false,
    onValueChange,
    orientation = "horizontal",
    ref,
    size = "sm",
    type,
    value,
    variant = "default",
    ...divProps
  } = props;

  const [uncontrolledSingle, setUncontrolledSingle] = useState<string>(
    type === "single" && typeof defaultValue === "string" ? defaultValue : "",
  );
  const [uncontrolledMultiple, setUncontrolledMultiple] = useState<string[]>(
    type === "multiple" && Array.isArray(defaultValue) ? defaultValue : [],
  );

  const activeSingle =
    type === "single"
      ? (typeof value === "string" ? value : uncontrolledSingle)
      : "";
  const activeMultiple = useMemo(
    () =>
      type === "multiple"
        ? (Array.isArray(value) ? value : uncontrolledMultiple)
        : [],
    [type, uncontrolledMultiple, value],
  );

  const [rovingTargetValue, setRovingTargetValue] = useState<string | null>(
    type === "single"
      ? (activeSingle || null)
      : (activeMultiple[0] ?? null),
  );

  const isPressed = useCallback(
    (itemValue: string) => {
      if (type === "single") return activeSingle === itemValue;
      return activeMultiple.includes(itemValue);
    },
    [activeMultiple, activeSingle, type],
  );

  const toggleValue = useCallback(
    (itemValue: string) => {
      if (disabled) return;
      if (type === "single") {
        const next = activeSingle === itemValue ? "" : itemValue;
        if (value === undefined) setUncontrolledSingle(next);
        (onValueChange as ((nextValue: string) => void) | undefined)?.(next);
        return;
      }
      const next = activeMultiple.includes(itemValue)
        ? activeMultiple.filter((entry) => entry !== itemValue)
        : [...activeMultiple, itemValue];
      if (value === undefined) setUncontrolledMultiple(next);
      (onValueChange as ((nextValue: string[]) => void) | undefined)?.(next);
    },
    [activeMultiple, activeSingle, disabled, onValueChange, type, value],
  );

  const contextValue = useMemo<ToggleGroupContextValue>(
    () => ({
      disabled,
      isPressed,
      orientation,
      rovingTargetValue,
      setRovingTargetValue,
      size,
      toggleValue,
      type,
      variant,
    }),
    [
      disabled,
      isPressed,
      orientation,
      rovingTargetValue,
      size,
      toggleValue,
      type,
      variant,
    ],
  );

  return (
    <ToggleGroupContext.Provider value={contextValue}>
      <div
        ref={ref}
        aria-orientation={orientation}
        className={cn(
          "fm-toggle-group",
          orientation === "vertical" && "fm-toggle-group--vertical",
          className,
        )}
        data-disabled={disabled ? "" : undefined}
        data-orientation={orientation}
        data-size={size}
        data-slot="toggle-group"
        data-variant={variant}
        role={type === "single" ? "radiogroup" : "group"}
        {...divProps}
      >
        {children}
      </div>
    </ToggleGroupContext.Provider>
  );
}

export interface ToggleGroupItemProps
  extends Omit<ComponentPropsWithRef<"button">, "value"> {
  size?: ToggleGroupSize;
  value: string;
  variant?: ToggleGroupVariant;
}

export function ToggleGroupItem({
  children,
  className,
  disabled,
  onClick,
  onFocus,
  onKeyDown,
  ref,
  size,
  value,
  variant,
  ...props
}: ToggleGroupItemProps) {
  const context = useToggleGroupContext("ToggleGroupItem");
  const isDisabled = Boolean(disabled || context.disabled);
  const pressed = context.isPressed(value);
  const effectiveSize = size ?? context.size;
  const effectiveVariant = variant ?? context.variant;

  const isRovingTabStop =
    !isDisabled &&
    (context.rovingTargetValue === value ||
      (context.rovingTargetValue === null && pressed));

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || isDisabled) return;

    const group = event.currentTarget.closest<HTMLElement>('[data-slot="toggle-group"]');
    if (!group) return;
    const enabledItems = Array.from(
      group.querySelectorAll<HTMLButtonElement>('[data-slot="toggle-group-item"]'),
    ).filter((item) => !item.disabled);
    if (enabledItems.length === 0) return;

    const currentIndex = enabledItems.indexOf(event.currentTarget);
    let nextIndex = -1;

    if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = enabledItems.length - 1;
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % enabledItems.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + enabledItems.length) % enabledItems.length;
    }

    if (nextIndex < 0) return;
    const target = enabledItems[nextIndex];
    if (!target) return;
    event.preventDefault();
    const targetValue = target.getAttribute("data-value");
    if (targetValue !== null) context.setRovingTargetValue(targetValue);
    target.focus();
  };

  return (
    <button
      ref={ref}
      aria-checked={context.type === "single" ? pressed : undefined}
      aria-pressed={context.type === "multiple" ? pressed : undefined}
      className={cn(
        "fm-toggle-group-item",
        `fm-toggle-group-item--${effectiveSize}`,
        `fm-toggle-group-item--${effectiveVariant}`,
        className,
      )}
      data-disabled={isDisabled ? "" : undefined}
      data-size={effectiveSize}
      data-slot="toggle-group-item"
      data-state={pressed ? "on" : "off"}
      data-value={value}
      data-variant={effectiveVariant}
      disabled={isDisabled}
      role={context.type === "single" ? "radio" : undefined}
      tabIndex={isDisabled ? -1 : isRovingTabStop || context.rovingTargetValue === null ? 0 : -1}
      type="button"
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented && !isDisabled) {
          context.setRovingTargetValue(value);
          context.toggleValue(value);
        }
      }}
      onFocus={(event) => {
        onFocus?.(event);
        if (!isDisabled) context.setRovingTargetValue(value);
      }}
      onKeyDown={handleKeyDown}
      {...props}
    >
      {children}
    </button>
  );
}
