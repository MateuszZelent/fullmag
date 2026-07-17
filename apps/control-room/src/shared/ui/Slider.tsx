"use client";

import * as SliderPrimitive from "@radix-ui/react-slider";
import type { ComponentPropsWithRef } from "react";

import { cn } from "@/shared/utils/className";

function Slider({
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  className,
  ref,
  ...props
}: ComponentPropsWithRef<typeof SliderPrimitive.Root>) {
  return (
    <SliderPrimitive.Root
      ref={ref}
      className={cn("fm-slider", className)}
      {...props}
    >
      <SliderPrimitive.Track className="fm-slider__track">
        <SliderPrimitive.Range className="fm-slider__range" />
      </SliderPrimitive.Track>
      {(props.defaultValue ?? props.value ?? [0]).map((_, i) => (
        <SliderPrimitive.Thumb
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          className="fm-slider__thumb"
          key={i}
        />
      ))}
    </SliderPrimitive.Root>
  );
}
Slider.displayName = SliderPrimitive.Root.displayName;

export { Slider };
