import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Model } from "flexlayout-react";

import type { DockResponsivePreset } from "@/components/workspace/docking/dockLayoutDefaults";
import type { DockLayoutEnvelope, DockLayoutModel } from "@/lib/workspace/dockLayoutContract";
import {
  normalizeDockLayoutEnvelope,
  normalizeDockLayoutRuntimeModel,
} from "@/lib/workspace/dockLayoutContract";
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
  const initialModelSerialized = JSON.stringify(initialNormalized.envelope.model);
  const currentModelJsonRef = useRef<string | null>(initialModelSerialized);
  const lastPersistedModelJsonRef = useRef<string | null>(initialModelSerialized);
  const pendingStoreHydrationJsonRef = useRef<string | null>(null);

  const [model, setModel] = useState<Model>(() =>
    Model.fromJson(initialNormalized.envelope.model),
  );

  const [metrics, setMetrics] = useState<DockLayoutRuntimeMetrics>(() =>
    updateMetricsFromEnvelope(preset, initialNormalized.envelope),
  );

  const persistModel = useCallback(
    (serializedModel: unknown) => {
      lastPersistedModelJsonRef.current = JSON.stringify(serializedModel);
      setDockLayout(stage, preset, cloneModel(serializedModel));
    },
    [preset, setDockLayout, stage],
  );

  const syncFromStore = useCallback(() => {
    const result = normalizeDockLayoutEnvelope(layoutEnvelope ?? null, preset);
    const nextModel = result.envelope.model;
    const nextSerialized = JSON.stringify(nextModel);
    const currentStoreSerialized = layoutEnvelope ? JSON.stringify(layoutEnvelope.model) : null;

    const existing = currentModelJsonRef.current;
    if (existing !== nextSerialized) {
      currentModelJsonRef.current = nextSerialized;
      if (lastPersistedModelJsonRef.current !== nextSerialized) {
        pendingStoreHydrationJsonRef.current = nextSerialized;
        setModel(Model.fromJson(cloneModel(nextModel)));
      }
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

    if (result.changed && currentStoreSerialized !== nextSerialized) {
      persistModel(nextModel);
    }
  }, [layoutEnvelope, preset, persistModel]);

  useEffect(() => {
    // Runtime reconciliation can push a repaired store model into FlexLayout state.
    syncFromStore();
  }, [syncFromStore]);

  const onModelChange = useCallback(
    (nextModel: Model) => {
      const raw = nextModel.toJson();
      // Use the runtime-only normalizer so that a plain Model.toJson() is never
      // mistaken for a schema-migration target (raw models have no
      // dockingLayoutSchemaVersion, but that is expected and harmless here).
      const result = normalizeDockLayoutRuntimeModel(raw, preset);
      const nextModelJson = result.model;
      const nextSerialized = JSON.stringify(nextModelJson);
      const previousSerialized = currentModelJsonRef.current;
      const pendingStoreHydrationSerialized = pendingStoreHydrationJsonRef.current;
      pendingStoreHydrationJsonRef.current = null;

      if (pendingStoreHydrationSerialized === nextSerialized) {
        currentModelJsonRef.current = nextSerialized;
        lastPersistedModelJsonRef.current = nextSerialized;
        return;
      }

      if (previousSerialized === nextSerialized) {
        return;
      }

      if (result.changed && result.repairReasons.length > 0) {
        console.warn("[docking] repaired layout on model change", {
          preset,
          reasons: [...result.repairReasons],
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
