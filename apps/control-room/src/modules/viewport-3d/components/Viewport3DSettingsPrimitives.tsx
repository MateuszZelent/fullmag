"use client";

import type { ReactNode } from "react";

import { Button } from "@/shared/ui/Button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/Select";
import { Switch } from "@/shared/ui/Switch";

export function SettingsGroup({
  children,
  onReset,
  resetLabel,
  title,
}: {
  children: ReactNode;
  onReset?: () => void;
  resetLabel?: string;
  title: string;
}) {
  return (
    <fieldset className="fm-viewport-3d-settings__group">
      <legend className="fm-viewport-3d-settings__legend">{title}</legend>
      <div className="fm-viewport-3d-settings__field-list">{children}</div>
      {onReset && resetLabel ? (
        <div className="fm-viewport-3d-settings__actions">
          <Button onClick={onReset} size="sm" variant="secondary">
            {resetLabel}
          </Button>
        </div>
      ) : null}
    </fieldset>
  );
}

export function Choice({
  describedBy,
  disabled = false,
  id,
  label,
  onChange,
  options,
  value,
}: {
  describedBy?: string;
  disabled?: boolean;
  id: string;
  label: string;
  onChange: (value: string) => void;
  options: readonly (readonly [string, string])[];
  value: string;
}) {
  return (
    <div className="fm-viewport-3d-settings__field">
      <label className="fm-viewport-3d-settings__label" htmlFor={id}>
        {label}
      </label>
      <Select
        disabled={disabled}
        onValueChange={(next) => {
          if (next !== undefined) onChange(next);
        }}
        value={value}
      >
        <SelectTrigger
          aria-label={label}
          aria-describedby={describedBy}
          className="fm-viewport-3d-settings__select"
          id={id}
        >
          <SelectValue>{options.find(([optionValue]) => optionValue === value)?.[1]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map(([optionValue, optionLabel]) => (
            <SelectItem key={optionValue} value={optionValue}>
              {optionLabel}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function TogglePreference({
  checked,
  description,
  disabled = false,
  id,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  description: string;
  disabled?: boolean;
  id: string;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  const labelId = `${id}-label`;
  const descriptionId = `${id}-description`;
  return (
    <div className="fm-viewport-3d-settings__toggle">
      <div className="fm-viewport-3d-settings__toggle-copy">
        <span className="fm-viewport-3d-settings__label" id={labelId}>
          {label}
        </span>
        <span className="fm-viewport-3d-settings__help" id={descriptionId}>
          {description}
        </span>
      </div>
      <Switch
        aria-describedby={descriptionId}
        aria-label={label}
        aria-labelledby={labelId}
        checked={checked}
        disabled={disabled}
        id={id}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}
