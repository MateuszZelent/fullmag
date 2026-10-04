export type RecentView = "list" | "grid";

export interface StartSettings {
  readonly defaultView: RecentView;
}

const STORAGE_KEY = "fullmag.start-screen.settings";
const DEFAULTS: StartSettings = { defaultView: "list" };

type Listener = () => void;

/** Browser storage can be absent, blocked or full; settings must never throw. */
function readStored(): StartSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const view = (parsed as Record<string, unknown>).defaultView;
      return { defaultView: view === "grid" ? "grid" : "list" };
    }
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
}

export const startSettings = new StartSettingsStore();
