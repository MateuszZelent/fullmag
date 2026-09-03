import { normalizeWorkspaceStage, type LaunchEntryKind, type WorkspaceStage } from "./launch-intent";

export interface RecentSimulationEntry {
  id: string;
  name: string;
  path: string;
  kind: LaunchEntryKind;
  backend: string | null;
  updatedAtUnixMs: number;
  lastStage: WorkspaceStage | null;
}

const STORAGE_KEY = "fullmag.recent_simulations.v1";
const MAX_RECENTS = 12;

export function readRecentSimulations(): RecentSimulationEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === "object")
      .map((item) => {
        const raw = item as RecentSimulationEntry & { lastStage?: unknown };
        return {
          ...raw,
          lastStage: normalizeWorkspaceStage(raw.lastStage),
        };
      });
  } catch {
    return [];
  }
}

export function writeRecentSimulations(entries: RecentSimulationEntry[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_RECENTS)));
}

export function upsertRecentSimulation(entry: RecentSimulationEntry): RecentSimulationEntry[] {
  const current = readRecentSimulations().filter((candidate) => candidate.id !== entry.id);
  const next = [entry, ...current].slice(0, MAX_RECENTS);
  writeRecentSimulations(next);
  return next;
}
