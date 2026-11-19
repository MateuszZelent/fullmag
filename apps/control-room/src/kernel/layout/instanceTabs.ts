import { useSyncExternalStore } from "react";

/**
 * Tabs of other Fullmag instances on this host (ADR 0069). Home and this
 * instance's own session are implicit tabs; this store keeps only the other
 * instances, by Control Room port, and which of them is in front.
 *
 * The list of open tabs is a per-viewer convenience kept in localStorage; a
 * missing or failing storage only means the tabs are not restored on reload.
 */
type Listener = () => void;

export interface InstanceTabsSnapshot {
  /** Ports of the open instance tabs, in tab order. */
  readonly openPorts: readonly number[];
  /** The instance tab in front, or null when Home or this session is. */
  readonly activePort: number | null;
  /**
   * Tabs whose frames are mounted, least recently in front first. A frame
   * keeps its view and WebGL context while hidden; at most
   * `MAX_MOUNTED_FRAMES` stay mounted, so a few tabs never exhaust the
   * browser's WebGL contexts. Restored tabs load lazily.
   */
  readonly framedPorts: readonly number[];
}

export const INSTANCE_TABS_STORAGE_KEY = "fullmag.instance-tabs.v1";
const MAX_OPEN_TABS = 16;
/** Frames of other instances kept mounted besides this page's own viewport. */
export const MAX_MOUNTED_FRAMES = 3;
/** Window name of an instance tab frame; the embedded page checks it. */
export const INSTANCE_TAB_FRAME_NAME = "fullmag-instance-tab";
const EMPTY: InstanceTabsSnapshot = { openPorts: [], activePort: null, framedPorts: [] };

const listeners = new Set<Listener>();
let snapshot: InstanceTabsSnapshot = EMPTY;
let restored = false;

function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65_535;
}

function readStoredPorts(): readonly number[] {
  try {
    const raw = window.localStorage.getItem(INSTANCE_TABS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter(isPort))].slice(0, MAX_OPEN_TABS);
  } catch {
    return [];
  }
}

function writeStoredPorts(ports: readonly number[]): void {
  try {
    window.localStorage.setItem(INSTANCE_TABS_STORAGE_KEY, JSON.stringify(ports));
  } catch {
    // Storage is a convenience; the open tabs stay valid for this page.
  }
}

/** Move `port` to the most recent end and drop the oldest beyond the cap. */
function framedWith(ports: readonly number[], port: number): readonly number[] {
  if (ports[ports.length - 1] === port) return ports;
  return [...ports.filter((framed) => framed !== port), port].slice(-MAX_MOUNTED_FRAMES);
}

function restore(): void {
  if (restored || typeof window === "undefined") return;
  restored = true;
  const openPorts = readStoredPorts();
  if (openPorts.length > 0) snapshot = { openPorts, activePort: null, framedPorts: [] };
}

function publish(next: InstanceTabsSnapshot): void {
  if (
    next.activePort === snapshot.activePort &&
    next.openPorts === snapshot.openPorts &&
    next.framedPorts === snapshot.framedPorts
  ) {
    return;
  }
  const portsChanged = next.openPorts !== snapshot.openPorts;
  snapshot = next;
  if (portsChanged) writeStoredPorts(next.openPorts);
  for (const listener of listeners) listener();
}

export const instanceTabs = {
  getSnapshot: (): InstanceTabsSnapshot => {
    restore();
    return snapshot;
  },
  /** Opens the instance's tab (once) and brings it to the front. */
  open: (port: number): void => {
    if (!isPort(port)) return;
    restore();
    const openPorts = snapshot.openPorts.includes(port)
      ? snapshot.openPorts
      : [...snapshot.openPorts, port].slice(-MAX_OPEN_TABS);
    publish({ openPorts, activePort: port, framedPorts: framedWith(snapshot.framedPorts, port) });
  },
  /** Brings an open instance tab to the front, or null for Home/this session. */
  activate: (port: number | null): void => {
    restore();
    if (port !== null && !snapshot.openPorts.includes(port)) return;
    publish({
      ...snapshot,
      activePort: port,
      framedPorts: port === null ? snapshot.framedPorts : framedWith(snapshot.framedPorts, port),
    });
  },
  /** Closes the tab. The instance and its session keep running. */
  close: (port: number): void => {
    restore();
    if (!snapshot.openPorts.includes(port)) return;
    publish({
      openPorts: snapshot.openPorts.filter((open) => open !== port),
      activePort: snapshot.activePort === port ? null : snapshot.activePort,
      framedPorts: snapshot.framedPorts.filter((framed) => framed !== port),
    });
  },
  subscribe: (listener: Listener): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  resetForTests: (): void => {
    snapshot = EMPTY;
    restored = false;
    listeners.clear();
  },
};

export function useInstanceTabs(): InstanceTabsSnapshot {
  return useSyncExternalStore(
    instanceTabs.subscribe,
    instanceTabs.getSnapshot,
    () => EMPTY,
  );
}

/**
 * Whether this Control Room runs inside another instance's tab. The host
 * names the frame; any other embedding (e.g. an IDE preview pane) keeps the
 * full shell.
 */
export function isEmbeddedInstanceTab(): boolean {
  if (typeof window === "undefined") return false;
  return window.name === INSTANCE_TAB_FRAME_NAME;
}

/** The origin of the instance on `port`, on the host this page was opened with. */
export function instanceOrigin(port: number, location: Pick<Location, "hostname" | "protocol">): string {
  // `hostname` already brackets an IPv6 literal; add them only if it did not.
  const { hostname } = location;
  const host = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
  return `${location.protocol}//${host}:${port}`;
}

const noSubscription = () => () => {};

/** Server and first client render assume a top-level page, then settle. */
export function useEmbeddedInstanceTab(): boolean {
  return useSyncExternalStore(noSubscription, isEmbeddedInstanceTab, () => false);
}

export type PageLocation = Pick<Location, "hostname" | "protocol">;

let pageLocation: PageLocation | null = null;

function readPageLocation(): PageLocation | null {
  if (typeof window === "undefined") return null;
  // The page's host never changes without a navigation; keep one stable snapshot.
  pageLocation ??= { hostname: window.location.hostname, protocol: window.location.protocol };
  return pageLocation;
}

/** The page's host and protocol on the client; null during server rendering. */
export function usePageLocation(): PageLocation | null {
  return useSyncExternalStore(noSubscription, readPageLocation, () => null);
}
