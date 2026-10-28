export type RibbonDensity = "full" | "compact" | "collapsed";

export const RIBBON_DENSITIES: readonly RibbonDensity[] = [
  "full",
  "compact",
  "collapsed",
];

const STORAGE_KEY = "fullmag.control-room.ribbon-density.v1";
const DEFAULT_DENSITY: RibbonDensity = "full";

let density: RibbonDensity = DEFAULT_DENSITY;
let hydrated = false;
const listeners = new Set<() => void>();

function isRibbonDensity(value: unknown): value is RibbonDensity {
  return value === "full" || value === "compact" || value === "collapsed";
}

function notify(): void {
  for (const listener of listeners) listener();
}

function hydrateFromStorage(): void {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isRibbonDensity(stored)) density = stored;
  } catch {
    // Storage can be unavailable in private or embedded browsing contexts.
  }
}

export function getRibbonDensity(): RibbonDensity {
  return density;
}

export function getServerRibbonDensity(): RibbonDensity {
  return DEFAULT_DENSITY;
}

export function subscribeRibbonDensity(listener: () => void): () => void {
  listeners.add(listener);
  hydrateFromStorage();
  return () => listeners.delete(listener);
}

export function setRibbonDensity(next: RibbonDensity): void {
  hydrateFromStorage();
  if (density === next) return;
  density = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Keep the preference for this page even when persistence is unavailable.
  }
  notify();
}

export function cycleRibbonDensity(): RibbonDensity {
  hydrateFromStorage();
  const index = RIBBON_DENSITIES.indexOf(density);
  const next = RIBBON_DENSITIES[(index + 1) % RIBBON_DENSITIES.length];
  setRibbonDensity(next);
  return next;
}
