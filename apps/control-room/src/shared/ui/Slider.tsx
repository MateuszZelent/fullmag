"use client";

import * as SliderPrimitive from "@radix-ui/react-slider";
import type { ComponentPropsWithRef } from "react";

import { cn } from "@/shared/utils/className";

function Slider({
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  className,
  ref,
  valueText,
  ...props
}: ComponentPropsWithRef<typeof SliderPrimitive.Root> & {
  /** Formats a thumb value (with its unit) for aria-valuetext. */
  valueText?: (value: number) => string;
}) {
  return (
    <SliderPrimitive.Root
      ref={ref}
      className={cn("fm-slider", className)}
      {...props}
    >
      <SliderPrimitive.Track className="fm-slider__track">
        <SliderPrimitive.Range className="fm-slider__range" />
      </SliderPrimitive.Track>
      {(props.value ?? props.defaultValue ?? [0]).map((thumbValue, i) => (
        <SliderPrimitive.Thumb
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-valuetext={valueText?.(thumbValue)}
          className="fm-slider__thumb"
          key={i}
        />
      ))}
    </SliderPrimitive.Root>
  );
}
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
