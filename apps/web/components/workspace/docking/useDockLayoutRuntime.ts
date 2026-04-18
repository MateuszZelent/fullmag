import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Model, type Action } from "flexlayout-react";

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
  onModelChange: (nextModel: Model, action: Action) => void;
  restoreCurrentPresetTemplate: () => void;
  clearStorageAndReset: () => void;
}

function cloneModel(model: unknown): DockLayoutModel {
  return JSON.parse(JSON.stringify(model)) as DockLayoutModel;
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

    setMetrics({
      preset,
      templateId: result.envelope.templateId,
      dockingLayoutSchemaVersion: result.envelope.dockingLayoutSchemaVersion,
      wasRecovered: result.envelope.wasRecovered,
      lastRepairReason: result.envelope.lastRepairReason,
      lastRepairAtUnixMs: result.envelope.lastRepairAtUnixMs,
      repairReasons: result.repairReasons,
    });

    if (result.changed && result.repairReasons.length > 0) {
      console.warn("[docking] repaired layout on store sync", {
        preset,
        templateId: result.envelope.templateId,
        reasons: result.repairReasons,
      });
    }

    if (result.changed) {
      persistModel(nextModel);
    }
  }, [layoutEnvelope, preset, persistModel]);

  useEffect(() => {
    syncFromStore();
  }, [syncFromStore]);

  const onModelChange = useCallback(
    (nextModel: Model, _action: Action) => {
      const raw = nextModel.toJson();
      const result = normalizeDockLayoutEnvelope(raw, preset);
      const nextModelJson = result.envelope.model;
      const nextSerialized = JSON.stringify(nextModelJson);

      if (currentModelJsonRef.current !== nextSerialized) {
        setModel(Model.fromJson(cloneModel(nextModelJson)));
        currentModelJsonRef.current = nextSerialized;
      }

      setMetrics({
        preset,
        templateId: result.envelope.templateId,
        dockingLayoutSchemaVersion: result.envelope.dockingLayoutSchemaVersion,
        wasRecovered: result.envelope.wasRecovered,
        lastRepairReason: result.envelope.lastRepairReason,
        lastRepairAtUnixMs: result.envelope.lastRepairAtUnixMs,
        repairReasons: result.repairReasons,
      });

      if (result.changed && result.repairReasons.length > 0) {
        console.warn("[docking] repaired layout on model change", {
          preset,
          templateId: result.envelope.templateId,
          reasons: result.repairReasons,
        });
      }

      if (result.changed) {
        persistModel(nextModelJson);
        return;
      }

      persistModel(raw);
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
