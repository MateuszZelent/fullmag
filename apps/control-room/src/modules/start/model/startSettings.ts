import { isKindFilter, isSortKey, type KindFilter, type SortKey } from "./recentRows";

export type RecentView = "list" | "grid";

export interface StartSettings {
  readonly defaultView: RecentView;
  /** Which recents the Home list shows; remembered across sessions. */
  readonly recentKind: KindFilter;
  /** Last chosen sort; coerced to one the active kind offers when it is used. */
  readonly recentSort: SortKey;
}

const STORAGE_KEY = "fullmag.start-screen.settings";
const DEFAULTS: StartSettings = { defaultView: "list", recentKind: "all", recentSort: "last_used" };

type Listener = () => void;

/** Anything stored that is not a known value falls back to its default. */
export function parseStartSettings(parsed: unknown): StartSettings {
  if (!parsed || typeof parsed !== "object") return DEFAULTS;
  const record = parsed as Record<string, unknown>;
  return {
    defaultView: record.defaultView === "grid" ? "grid" : "list",
    recentKind: isKindFilter(record.recentKind) ? record.recentKind : DEFAULTS.recentKind,
    recentSort: isSortKey(record.recentSort) ? record.recentSort : DEFAULTS.recentSort,
  };
}

/** Browser storage can be absent, blocked or full; settings must never throw. */
function readStored(): StartSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    return parseStartSettings(JSON.parse(raw));
  } catch {
    // Fall through to the defaults.
  }
  return DEFAULTS;
}

class StartSettingsStore {
  private listeners = new Set<Listener>();
  // useSyncExternalStore needs a stable snapshot object between changes.
  private snapshot: StartSettings | null = null;

  getSnapshot = (): StartSettings => {
    this.snapshot ??= typeof window === "undefined" ? DEFAULTS : readStored();
    return this.snapshot;
  };

  getServerSnapshot = (): StartSettings => DEFAULTS;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  update(patch: Partial<StartSettings>): void {
    const next = { ...this.getSnapshot(), ...patch };
    this.snapshot = next;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // The setting still applies for this session.
    }
    for (const listener of this.listeners) listener();
  }

  resetForTests(): void {
    this.snapshot = null;
    this.listeners.clear();
  }
}

export const startSettings = new StartSettingsStore();
