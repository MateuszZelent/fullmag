"use client";

import {
  createContext,
  useContext,
  useId,
  type ComponentPropsWithRef,
} from "react";

import { cn } from "@/shared/utils/className";

interface RadioGroupContextValue {
  name: string;
  value?: string;
  onValueChange?: (value: string) => void;
}

const RadioGroupContext = createContext<RadioGroupContextValue | null>(null);

export interface RadioGroupProps
  extends Omit<ComponentPropsWithRef<"div">, "onChange"> {
  name?: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
}

/**
 * Dependency-free radio group (frontend audit 2026-09-03, P2 item — no
 * @radix-ui/react-radio-group in this workspace). API shape mirrors Radix's
 * RadioGroup/RadioGroupItem so it is a familiar drop-in for the rest of the
 * shared/ui library.
 */
export function RadioGroup({
  name,
  value,
  defaultValue,
  onValueChange,
  className,
  role = "radiogroup",
  ...props
}: RadioGroupProps) {
  const generatedName = useId();
  return (
    <RadioGroupContext.Provider
      value={{ name: name ?? generatedName, value: value ?? defaultValue, onValueChange }}
    >
      <div
        className={cn("fm-radio-group", className)}
        data-slot="radio-group"
        role={role}
        {...props}
      />
    </RadioGroupContext.Provider>
  );
}

export interface RadioGroupItemProps
  extends Omit<ComponentPropsWithRef<"input">, "type" | "name" | "onChange"> {
  value: string;
}

export function RadioGroupItem({
  value,
  className,
  disabled,
  id,
  ...props
}: RadioGroupItemProps) {
  const group = useContext(RadioGroupContext);
  const generatedId = useId();
  const inputId = id ?? generatedId;

  return (
    <input
      checked={group?.value === value}
      className={cn("fm-radio", className)}
      data-slot="radio-group-item"
      disabled={disabled}
      id={inputId}
      name={group?.name}
      onChange={() => group?.onValueChange?.(value)}
      type="radio"
      value={value}
      {...props}
    />
  );
}
