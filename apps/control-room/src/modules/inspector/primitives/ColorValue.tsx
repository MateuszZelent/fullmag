"use client";

import { useRef } from "react";

import { colorValueLabel, computedRgbToHex, isThemeColorToken } from "@/shared/color/colorValueLabel";
import { InspectorPropertyRow } from "./InspectorPropertyRow";

/** Swatch plus readable name; a theme token renders in the active theme's colour. */
export function ColorValue({ value }: { readonly value: string | null | undefined }) {
  return (
    <span className="fm-inspector-color-value" title={value ?? undefined}>
      <span
        aria-hidden="true"
        className="fm-inspector-color-value__swatch"
        style={value ? { background: value } : undefined}
      />
      <span className="fm-inspector-color-value__label">{colorValueLabel(value)}</span>
    </span>
  );
}

/**
 * Colour preference: swatch, an explicit hex in the text box (a theme token is
 * shown as its readable name in the placeholder, never as raw CSS) and the
 * native picker, seeded from the swatch's computed colour.
 */
export function ColorValueField({
  description,
  disabled,
  label,
  value,
  onChange,
}: {
  readonly description?: string;
  readonly disabled?: boolean;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const swatchRef = useRef<HTMLSpanElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null);
  const themeToken = isThemeColorToken(value);
  const seedPicker = () => {
    const hex = swatchRef.current ? computedRgbToHex(getComputedStyle(swatchRef.current).backgroundColor) : null;
    if (hex && pickerRef.current) pickerRef.current.value = hex;
  };
  return (
    <InspectorPropertyRow description={description} label={label}>
      <span className="fm-inspector-color-field" title={value || undefined}>
        <span
          aria-hidden="true"
          className="fm-inspector-color-value__swatch"
          ref={swatchRef}
          style={value ? { background: value } : undefined}
        />
        <input
          aria-label={label}
          className="fm-inspector-color-field__text"
          disabled={disabled}
          placeholder={colorValueLabel(value)}
          type="text"
          value={themeToken ? "" : value}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
        <input
          aria-label={`${label} picker`}
          className="fm-inspector-color-field__picker"
          disabled={disabled}
          ref={pickerRef}
          type="color"
          onChange={(event) => onChange(event.currentTarget.value)}
          onFocus={seedPicker}
          onPointerDown={seedPicker}
        />
      </span>
    </InspectorPropertyRow>
  );
}
