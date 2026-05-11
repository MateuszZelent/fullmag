export const THEME_TOGGLE_EVENT = "fullmag:theme-toggle";

export function requestThemeToggle(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  window.dispatchEvent(new Event(THEME_TOGGLE_EVENT));
  return true;
}
