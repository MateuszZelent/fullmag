"use client";

/**
 * React hook for session persistence operations.
 *
 * Wraps the API layer with loading/error state and convenience methods
 * for Save, Open, and Inspect flows.
 */

import { useCallback, useState } from "react";
import {
  exportSession,
  inspectSession,
  commitSessionImport,
  listCheckpoints,
  listRecovery,
  clearRecovery,
  fileToBase64,
  downloadFmsFile,
  type SaveProfile,
  type SessionExportResponse,
  type SessionInspection,
  type SessionImportCommitResponse,
  type CheckpointEntry,
  type RecoveryEntry,
} from "../api/sessionPersistence";
import { useWorkspaceStore } from "../workspace/workspace-store";

export interface UseSessionPersistenceResult {
  /** True while any persistence operation is in flight. */
  loading: boolean;
  /** Last error message, or null. */
  error: string | null;

  /** Export the current session to a downloadable .fms file. */
  saveSession: (
    profile: SaveProfile,
    name?: string,
  ) => Promise<SessionExportResponse | null>;

  /** Inspect a .fms file without importing. */
  inspectFile: (file: File) => Promise<SessionInspection | null>;

  /** Import and commit a .fms file into the session store. */
  openFile: (
    file: File,
    restoreMode?: string,
  ) => Promise<SessionImportCommitResponse | null>;

  /** List checkpoints for the current run. */
  fetchCheckpoints: () => Promise<CheckpointEntry[]>;

  /** List recovery snapshots. */
  fetchRecovery: () => Promise<RecoveryEntry[]>;

  /** Clear all recovery snapshots. */
  doClearRecovery: () => Promise<number>;

  /** Reset error state. */
  clearError: () => void;
}

export function useSessionPersistence(): UseSessionPersistenceResult {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wrap = useCallback(
    async <T>(fn: () => Promise<T>): Promise<T | null> => {
      setLoading(true);
      setError(null);
      try {
        return await fn();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const saveSession = useCallback(
    async (profile: SaveProfile, name?: string) => {
      return wrap(async () => {
        const uiState = useWorkspaceStore.getState().exportUiStateSnapshot();
        const resp = await exportSession({ profile, name, ui_state: uiState });
        const filename = `${name ?? "session"}.fms`;
        downloadFmsFile(resp.fms_base64, filename);
        return resp;
      });
    },
    [wrap],
  );

  const inspectFile = useCallback(
    async (file: File) => {
      return wrap(async () => {
        const base64 = await fileToBase64(file);
        const resp = await inspectSession({ fms_base64: base64 });
        return resp.inspection;
      });
    },
    [wrap],
  );

  const openFile = useCallback(
    async (file: File, restoreMode?: string) => {
      return wrap(async () => {
        const base64 = await fileToBase64(file);
        const response = await commitSessionImport({
          fms_base64: base64,
          restore_mode: restoreMode,
        });
        if (response.ui_state !== undefined) {
          useWorkspaceStore.getState().importUiStateSnapshot(response.ui_state);
        }
        return response;
      });
    },
    [wrap],
  );

  const fetchCheckpoints = useCallback(async () => {
    const result = await wrap(async () => {
      const resp = await listCheckpoints();
      return resp.checkpoints;
    });
    return result ?? [];
  }, [wrap]);

  const fetchRecovery = useCallback(async () => {
    const result = await wrap(async () => {
      const resp = await listRecovery();
      return resp.snapshots;
    });
    return result ?? [];
  }, [wrap]);

  const doClearRecovery = useCallback(async () => {
    const result = await wrap(async () => {
      const resp = await clearRecovery();
      return resp.cleared;
    });
    return result ?? 0;
  }, [wrap]);

  const clearError = useCallback(() => setError(null), []);

  return {
    loading,
    error,
    saveSession,
    inspectFile,
    openFile,
    fetchCheckpoints,
    fetchRecovery,
    doClearRecovery,
    clearError,
  };
}
