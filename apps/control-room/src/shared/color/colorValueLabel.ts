const THEME_TOKEN = /^var\(\s*--fm-([a-z0-9-]+)\s*(?:,[^)]*)?\)$/i;
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isThemeColorToken(value: string | null | undefined): boolean {
  return THEME_TOKEN.test(value?.trim() ?? "");
}

/** Human-readable name for a stored colour value; theme tokens are not shown as raw CSS. */
export function colorValueLabel(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "Not set";
  const token = THEME_TOKEN.exec(trimmed);
  if (token) return `Theme · ${token[1].replace(/-/g, " ")}`;
  if (HEX_COLOR.test(trimmed)) return trimmed.toUpperCase();
  return trimmed;
}

/** `rgb(r, g, b)` / `rgba(...)` from getComputedStyle as `#rrggbb`, or null. */
export function computedRgbToHex(value: string | null | undefined): string | null {
  const match = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(value?.trim() ?? "");
  if (!match) return null;
  return `#${match.slice(1, 4).map((part) => Number(part).toString(16).padStart(2, "0")).join("")}`;
}
