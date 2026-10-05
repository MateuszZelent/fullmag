"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useKernel } from "@/kernel/KernelContext";

import {
  TELEMETRY_SETTING_KEY,
  UPDATE_SETTING_KEY,
  parseSettingAnswer,
  telemetryEnabledOf,
  updateNoticeOf,
  type PreferencesState,
} from "./startPreferences";
import { isRouteMissing } from "./useWorkspaceItems";

export interface StartPreferencesController {
  readonly state: PreferencesState;
  /** Saves the telemetry choice; resolves to a failure message, or null. */
  readonly setTelemetry: (enabled: boolean) => Promise<string | null>;
  readonly saving: boolean;
}

const WORKSPACE_SETTINGS_UNAVAILABLE = "This backend does not store settings yet.";

/** Reads both allow-listed settings once on mount; local backend only, no timer. */
export function useStartPreferences(): StartPreferencesController {
  const { api } = useKernel();
  const [state, setState] = useState<PreferencesState>({ kind: "loading" });
  const [saving, setSaving] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    void (async () => {
      try {
        const [telemetry, update] = await Promise.all([
          api.workspace.setting(TELEMETRY_SETTING_KEY, { signal: controller.signal }),
          api.workspace.setting(UPDATE_SETTING_KEY, { signal: controller.signal }),
        ]);
        if (!alive.current) return;
        setState({
          kind: "ready",
          telemetryEnabled: telemetryEnabledOf(parseSettingAnswer(telemetry)),
          update: updateNoticeOf(parseSettingAnswer(update)),
        });
      } catch (error) {
        if (!alive.current || controller.signal.aborted) return;
        setState({
          kind: "unavailable",
          reason: isRouteMissing(error)
            ? WORKSPACE_SETTINGS_UNAVAILABLE
            : `Could not read the settings: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    })();
    return () => {
      alive.current = false;
      controller.abort();
    };
  }, [api]);

  const setTelemetry = useCallback(
    async (enabled: boolean): Promise<string | null> => {
      setSaving(true);
      try {
        const saved = parseSettingAnswer(await api.workspace.saveSetting(TELEMETRY_SETTING_KEY, enabled));
        if (alive.current) {
          // Shown value is the stored one, not the one that was asked for.
          setState((current) =>
            current.kind === "ready"
              ? { ...current, telemetryEnabled: telemetryEnabledOf(saved) }
              : current,
          );
        }
        return null;
      } catch (error) {
        return `Could not save the telemetry choice: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        if (alive.current) setSaving(false);
      }
    },
    [api],
  );

  return { state, setTelemetry, saving };
}
