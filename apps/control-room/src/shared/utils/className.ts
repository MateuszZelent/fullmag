import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Extended tailwind-merge that distinguishes our custom @theme token groups.
// Without this, tailwind-merge incorrectly deduplicates `text-fm-control` (font-size)
// and `text-fm-inverse` (color) as conflicting `text-*` utilities.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        // --text-fm-* @theme tokens → font-size utilities
        {
          "text-fm": [
            "2xs", "xs", "sm", "md", "lg", "xl",
            "label", "control", "help",
          ],
        },
      ],
      "text-color": [
        // --color-fm-* @theme tokens → text color utilities
        {
          "text-fm": [
            "app", "chrome", "panel", "raised", "canvas",
            "overlay", "selected", "hover", "disabled",
            "primary", "secondary", "muted", "disabled-text", "inverse",
            "subtle", "moderate", "border", "strong",
            "accent", "accent-soft",
            "success", "warning", "danger", "stale", "degraded",
          ],
        },
      ],
      "leading": [
        // --leading-fm-* @theme tokens → line-height utilities
        { "leading-fm": ["control", "tight"] },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
