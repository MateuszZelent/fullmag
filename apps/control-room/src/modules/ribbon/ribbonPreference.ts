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

/* ── Ribbon visibility ──
 * Independent of density: a collapsed ribbon keeps only its tab strip so the
 * workspace gains the height. Persisted per browser like the density. */
const EXPANDED_STORAGE_KEY = "fullmag.control-room.ribbon-expanded.v1";
let expanded = true;
let expandedHydrated = false;
const expandedListeners = new Set<() => void>();

function hydrateExpandedFromStorage(): void {
  if (expandedHydrated || typeof window === "undefined") return;
  expandedHydrated = true;
  try {
    const stored = window.localStorage.getItem(EXPANDED_STORAGE_KEY);
    if (stored === "false") expanded = false;
  } catch {
    // Storage can be unavailable in private or embedded browsing contexts.
  }
}

export function getRibbonExpanded(): boolean {
  return expanded;
}

export function getServerRibbonExpanded(): boolean {
  return true;
}

export function subscribeRibbonExpanded(listener: () => void): () => void {
  expandedListeners.add(listener);
  hydrateExpandedFromStorage();
  return () => expandedListeners.delete(listener);
}

export function setRibbonExpanded(next: boolean): void {
  hydrateExpandedFromStorage();
  if (expanded === next) return;
  expanded = next;
  try {
    window.localStorage.setItem(EXPANDED_STORAGE_KEY, String(next));
  } catch {
    // Keep the preference for this page even when persistence is unavailable.
  }
  for (const listener of expandedListeners) listener();
}

export function toggleRibbonExpanded(): boolean {
  setRibbonExpanded(!getRibbonExpanded());
  return expanded;
}
