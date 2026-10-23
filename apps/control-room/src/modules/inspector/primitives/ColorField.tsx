"use client";

import { useId, useSyncExternalStore } from "react";

import { NATIVE_COLOR_PICKER_FALLBACK } from "@/design/styles/nativeColorTokens";

import { cn } from "@/shared/utils/className";

import { InspectorPropertyRow } from "./InspectorPropertyRow";

// Browser color syntax support is static; the server snapshot keeps hydration identical.
const subscribeToBrowserSupport = () => () => {};
const browserSupportSnapshot = () => true;
const serverSupportSnapshot = () => false;

export interface ColorFieldProps {
  disabled?: boolean;
  hint?: string;
  label: string;
  onChange: (value: string) => void;
  pickerAriaLabel?: string;
  value: string;
  valueAriaLabel?: string;
}

/** A native opaque picker paired with an unrestricted text value field. */
export function ColorField({
  disabled,
  hint,
  label,
  onChange,
  pickerAriaLabel,
  value,
  valueAriaLabel,
}: ColorFieldProps) {
  const hintId = useId();
  const pickerDescriptionId = useId();
  const browserReady = useSyncExternalStore(
    subscribeToBrowserSupport,
    browserSupportSnapshot,
    serverSupportSnapshot,
  );
  const candidate = value.trim();
  const previewAvailable = browserReady && candidate.length > 0 &&
    typeof CSS !== "undefined" && CSS.supports("color", candidate);
  const nativePickerValue = isHexColor(value) ? value : NATIVE_COLOR_PICKER_FALLBACK;

  return (
    <InspectorPropertyRow description={hint} label={label}>
      <div
        className="fm-inspector-color-control flex min-w-0 w-full items-center justify-end gap-fm-inspector-control"
        data-slot="visualization-color-control"
      >
        <div className="fm-inspector-color-picker relative shrink-0 overflow-hidden rounded-fm-control border border-fm-subtle bg-fm-canvas">
          <span
            aria-hidden="true"
            className={cn(
              "fm-inspector-color-preview absolute inset-1 flex items-center justify-center rounded-sm",
              previewAvailable
                ? "fm-inspector-color-preview--available"
                : "fm-inspector-color-preview--unavailable",
            )}
            style={previewAvailable ? { backgroundColor: value } : undefined}
          >
            {previewAvailable ? null : "—"}
          </span>
          <input
            aria-describedby={
              hint
                ? `${hintId} ${pickerDescriptionId}`
                : pickerDescriptionId
            }
            aria-label={pickerAriaLabel ?? `${label} picker`}
            className="fm-inspector-color-picker__input absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
            disabled={disabled}
            type="color"
            value={nativePickerValue}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
        </div>
        <input
          aria-label={valueAriaLabel ?? `${label} value`}
          aria-describedby={hint ? hintId : undefined}
          className="fm-inspector-input fm-inspector-color-value min-w-0 w-full"
          disabled={disabled}
          type="text"
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
        {hint ? (
          <span className="sr-only" id={hintId}>
            {hint}
          </span>
        ) : null}
        <span className="sr-only" id={pickerDescriptionId}>
          {isHexColor(value)
            ? "The native picker is initialized with the current color."
            : "The native picker opens with white because it cannot represent the current value. The current text value is unchanged until you select a color."}
        </span>
      </div>
    </InspectorPropertyRow>
  );
}

function isHexColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value);
}
