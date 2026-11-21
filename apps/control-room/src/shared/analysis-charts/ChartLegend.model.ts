const COLOR_NAMES = [
  "blue",
  "green",
  "yellow",
  "red",
  "mauve",
  "peach",
  "teal",
  "sky",
  "pink",
  "lavender",
  "flamingo",
  "rosewater",
] as const;

/** Derives a color name from a 0-based index, cycling through the 12-token palette. */
export function chartColorNameForIndex(index: number): string {
  return COLOR_NAMES[index % COLOR_NAMES.length] ?? "blue";
}
