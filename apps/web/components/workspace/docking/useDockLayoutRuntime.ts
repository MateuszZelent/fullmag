/* eslint-disable react-hooks/set-state-in-effect */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Model } from "flexlayout-react";

import type { DockResponsivePreset } from "@/components/workspace/docking/dockLayoutDefaults";
import type { DockLayoutEnvelope, DockLayoutModel } from "@/lib/workspace/dockLayoutContract";
import { normalizeDockLayoutEnvelope } from "@/lib/workspace/dockLayoutContract";
import type { WorkspaceMode } from "@/lib/workspace/workspace-store";

export interface DockLayoutRuntimeMetrics {
  preset: DockResponsivePreset;
  templateId: string;
  dockingLayoutSchemaVersion: number;
  wasRecovered: boolean;
  lastRepairReason: string | null;
  lastRepairAtUnixMs: number | null;
  repairReasons: string[];
}

interface UseDockLayoutRuntimeOptions {
  stage: WorkspaceMode;
  preset: DockResponsivePreset;
  layoutEnvelope: DockLayoutEnvelope | null;
  setDockLayout: (stage: WorkspaceMode, preset: DockResponsivePreset, model: DockLayoutModel) => void;
  setDockLayoutToDefaultTemplate: (
    stage: WorkspaceMode,
    preset: DockResponsivePreset,
  ) => void;
  clearDockingLayoutStorage: () => void;
}

export interface UseDockLayoutRuntimeReturn {
  model: Model;
  metrics: DockLayoutRuntimeMetrics;
  onModelChange: (nextModel: Model) => void;
  restoreCurrentPresetTemplate: () => void;
  clearStorageAndReset: () => void;
}

function cloneModel(model: unknown): DockLayoutModel {
  return JSON.parse(JSON.stringify(model)) as DockLayoutModel;
}

function metricsEqual(a: DockLayoutRuntimeMetrics, b: DockLayoutRuntimeMetrics): boolean {
  if (
    a.preset !== b.preset ||
    a.templateId !== b.templateId ||
    a.dockingLayoutSchemaVersion !== b.dockingLayoutSchemaVersion ||
    a.wasRecovered !== b.wasRecovered ||
    a.lastRepairReason !== b.lastRepairReason ||
    a.lastRepairAtUnixMs !== b.lastRepairAtUnixMs
  ) {
    return false;
  }
  if (a.repairReasons.length !== b.repairReasons.length) {
    return false;
  }
  for (let index = 0; index < a.repairReasons.length; index += 1) {
    if (a.repairReasons[index] !== b.repairReasons[index]) {
      return false;
    }
  }
  return true;
}

function updateMetricsFromEnvelope(
  preset: DockResponsivePreset,
  envelope: DockLayoutEnvelope,
): DockLayoutRuntimeMetrics {
  return {
    preset,
    templateId: envelope.templateId,
    dockingLayoutSchemaVersion: envelope.dockingLayoutSchemaVersion,
    wasRecovered: envelope.wasRecovered,
    lastRepairReason: envelope.lastRepairReason,
    lastRepairAtUnixMs: envelope.lastRepairAtUnixMs,
    repairReasons: [],
  };
}

export function useDockLayoutRuntime({
  stage,
  preset,
  layoutEnvelope,
  setDockLayout,
  setDockLayoutToDefaultTemplate,
  clearDockingLayoutStorage,
}: UseDockLayoutRuntimeOptions): UseDockLayoutRuntimeReturn {
  const initialNormalized = normalizeDockLayoutEnvelope(layoutEnvelope ?? null, preset);
  const currentModelJsonRef = useRef<string | null>(JSON.stringify(initialNormalized.envelope.model));

  const [model, setModel] = useState<Model>(() =>
    Model.fromJson(initialNormalized.envelope.model),
  );

  const [metrics, setMetrics] = useState<DockLayoutRuntimeMetrics>(() =>
    updateMetricsFromEnvelope(preset, initialNormalized.envelope),
  );

  const persistModel = useCallback(
    (serializedModel: unknown) => {
      setDockLayout(stage, preset, cloneModel(serializedModel));
    },
    [preset, setDockLayout, stage],
  );

  const syncFromStore = useCallback(() => {
    const result = normalizeDockLayoutEnvelope(layoutEnvelope ?? null, preset);
    const nextModel = result.envelope.model;
    const nextSerialized = JSON.stringify(nextModel);

    const existing = currentModelJsonRef.current;
    if (existing !== nextSerialized) {
      setModel(Model.fromJson(cloneModel(nextModel)));
      currentModelJsonRef.current = nextSerialized;
    }

    const nextMetrics: DockLayoutRuntimeMetrics = {
      preset,
      templateId: result.envelope.templateId,
      dockingLayoutSchemaVersion: result.envelope.dockingLayoutSchemaVersion,
      wasRecovered: result.envelope.wasRecovered,
      lastRepairReason: result.envelope.lastRepairReason,
      lastRepairAtUnixMs: result.envelope.lastRepairAtUnixMs,
      repairReasons: result.repairReasons,
    };
    setMetrics((previous) => (metricsEqual(previous, nextMetrics) ? previous : nextMetrics));

    if (result.changed && result.repairReasons.length > 0) {
      console.warn("[docking] repaired layout on store sync", {
        preset,
        templateId: result.envelope.templateId,
        reasons: result.repairReasons,
      });
    }

    if (result.changed && existing !== nextSerialized) {
      persistModel(nextModel);
    }
  }, [layoutEnvelope, preset, persistModel]);

  useEffect(() => {
    syncFromStore();
  }, [syncFromStore]);

  const onModelChange = useCallback(
    (nextModel: Model) => {
      const raw = nextModel.toJson();
      const result = normalizeDockLayoutEnvelope(raw, preset);
      const nextModelJson = result.envelope.model;
      const nextSerialized = JSON.stringify(nextModelJson);
      const previousSerialized = currentModelJsonRef.current;

      if (previousSerialized === nextSerialized) {
        return;
      }

      const nextMetrics: DockLayoutRuntimeMetrics = {
        preset,
        templateId: result.envelope.templateId,
        dockingLayoutSchemaVersion: result.envelope.dockingLayoutSchemaVersion,
        wasRecovered: result.envelope.wasRecovered,
        lastRepairReason: result.envelope.lastRepairReason,
        lastRepairAtUnixMs: result.envelope.lastRepairAtUnixMs,
        repairReasons: result.repairReasons,
      };
      setMetrics((previous) => (metricsEqual(previous, nextMetrics) ? previous : nextMetrics));

      if (result.changed && result.repairReasons.length > 0) {
        console.warn("[docking] repaired layout on model change", {
          preset,
          templateId: result.envelope.templateId,
          reasons: result.repairReasons,
        });
      }

      currentModelJsonRef.current = nextSerialized;
      persistModel(nextModelJson);
    },
    [persistModel, preset],
  );

  const restoreCurrentPresetTemplate = useCallback(() => {
    setDockLayoutToDefaultTemplate(stage, preset);
  }, [preset, setDockLayoutToDefaultTemplate, stage]);

  const clearStorageAndReset = useCallback(() => {
    clearDockingLayoutStorage();
    setDockLayoutToDefaultTemplate(stage, preset);
  }, [clearDockingLayoutStorage, preset, setDockLayoutToDefaultTemplate, stage]);

  return useMemo(
    () => ({
      model,
      metrics,
      onModelChange,
      restoreCurrentPresetTemplate,
      clearStorageAndReset,
    }),
    [model, metrics, onModelChange, restoreCurrentPresetTemplate, clearStorageAndReset],
  );
}
