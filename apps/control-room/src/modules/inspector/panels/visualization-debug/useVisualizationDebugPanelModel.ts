"use client";

import {
  createElement,
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { FieldMetaResource } from "@/kernel/api/apiTypes";
import type { RequestDiagnosticEntry } from "@/kernel/api/RequestDiagnosticsController";
import { useKernel } from "@/kernel/KernelContext";
import { useLayoutSelector } from "@/kernel/layout/useLayout";
import type { SelectionRef } from "@/kernel/selection/selectionTypes";
import { useFieldMetaResource } from "@/kernel/resources/studyRuntimeResources";
import {
  EMPTY_VISUALIZATION_DEBUG_SNAPSHOTS,
  type VisualizationDebugController,
} from "@/kernel/visualization/VisualizationDebugController";
import { useVisualizationClientAcksResource } from "@/kernel/visualization/useVisualizationClientAcksResource";

import {
  buildVisualizationDebugPanelModel,
  resolveVisualizationDebugTarget,
  type VisualizationDebugExactFieldQuery,
  type VisualizationDebugPanelModel,
} from "./VisualizationDebugPanelModel";

const DIAGNOSTICS_SERVER_VERSION = 0;
const EMPTY_REQUEST_DIAGNOSTICS: readonly RequestDiagnosticEntry[] =
  Object.freeze([]);
const EMPTY_FIELD_META_SNAPSHOT: VisualizationDebugFieldMetaSnapshot =
  Object.freeze({ version: 0, values: new Map() });
const MAX_VISUALIZATION_DEBUG_FIELD_META_ENTRIES = 16;

const selectActiveViewportMainModuleId = (state: {
  activeViewportMainModuleId: string;
}) => state.activeViewportMainModuleId;

export function requestVisualizationDebugTarget(
  controller: VisualizationDebugController,
  targetId: string,
): () => void {
  const releaseDemand = controller.request(targetId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseDemand();
  };
}

interface VisualizationDebugFieldMetaSnapshot {
  version: number;
  values: ReadonlyMap<string, FieldMetaResource | null>;
}

export class VisualizationDebugFieldMetaRegistry {
  private disposed = false;
  private readonly listeners = new Set<() => void>();
  private readonly retainedQueries = new Map<string, number>();
  private snapshot = EMPTY_FIELD_META_SNAPSHOT;

  getSnapshot = (): VisualizationDebugFieldMetaSnapshot => this.snapshot;

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.retainedQueries.clear();
    this.snapshot = EMPTY_FIELD_META_SNAPSHOT;
  }

  retain(key: string): () => void {
    if (this.disposed) return () => undefined;
    if (
      !this.retainedQueries.has(key) &&
      this.retainedQueries.size >= MAX_VISUALIZATION_DEBUG_FIELD_META_ENTRIES
    ) {
      return () => undefined;
    }
    this.retainedQueries.set(key, (this.retainedQueries.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released || this.disposed) return;
      released = true;
      const count = this.retainedQueries.get(key) ?? 0;
      if (count > 1) {
        this.retainedQueries.set(key, count - 1);
        return;
      }
      this.retainedQueries.delete(key);
      if (!this.snapshot.values.has(key)) return;
      const values = new Map(this.snapshot.values);
      values.delete(key);
      this.publish(values);
    };
  }

  set(key: string, value: FieldMetaResource | null): void {
    if (this.disposed || !this.retainedQueries.has(key)) return;
    if (this.snapshot.values.has(key) && this.snapshot.values.get(key) === value) {
      return;
    }
    if (
      !this.snapshot.values.has(key) &&
      this.snapshot.values.size >= MAX_VISUALIZATION_DEBUG_FIELD_META_ENTRIES
    ) {
      return;
    }
    const values = new Map(this.snapshot.values);
    values.set(key, value);
    this.publish(values);
  }

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  stats(): {
    entryCount: number;
    listenerCount: number;
    retainedQueryCount: number;
  } {
    return {
      entryCount: this.snapshot.values.size,
      listenerCount: this.listeners.size,
      retainedQueryCount: this.retainedQueries.size,
    };
  }

  private publish(values: ReadonlyMap<string, FieldMetaResource | null>): void {
    this.snapshot = Object.freeze({
      values,
      version: this.snapshot.version + 1,
    });
    for (const listener of [...this.listeners]) listener();
  }
}

export function VisualizationDebugPanelModelAdapter({
  children,
  selection,
}: {
  children: (model: VisualizationDebugPanelModel) => ReactNode;
  selection: SelectionRef | null;
}) {
  const [fieldMetaRegistry] = useState(
    () => new VisualizationDebugFieldMetaRegistry(),
  );
  const fieldMetaSnapshot = useSyncExternalStore(
    fieldMetaRegistry.subscribe,
    fieldMetaRegistry.getSnapshot,
    () => EMPTY_FIELD_META_SNAPSHOT,
  );
  const model = useVisualizationDebugPanelModelState({
    fieldMetaByQueryKey: fieldMetaSnapshot.values,
    selection,
  });
  const metaQueries = useMemo(() => {
    const queries = new Map<string, VisualizationDebugExactFieldQuery>();
    for (const query of model.fieldQueries) {
      if (!queries.has(query.metaQueryKey)) {
        queries.set(query.metaQueryKey, query);
      }
    }
    return [...queries.values()];
  }, [model.fieldQueries]);
  useEffect(() => {
    return () => fieldMetaRegistry.dispose();
  }, [fieldMetaRegistry]);

  return createElement(
    Fragment,
    null,
    ...metaQueries.map((query) =>
      createElement(VisualizationDebugFieldMetaObserver, {
        key: query.metaQueryKey,
        query,
        registry: fieldMetaRegistry,
      }),
    ),
    children(model),
  );
}

function useVisualizationDebugPanelModelState({
  fieldMetaByQueryKey,
  selection,
}: {
  fieldMetaByQueryKey: ReadonlyMap<string, FieldMetaResource | null>;
  selection: SelectionRef | null;
}): VisualizationDebugPanelModel {
  const kernel = useKernel();
  const target = useMemo(
    () => resolveVisualizationDebugTarget(selection),
    [selection],
  );
  const targetId = target?.id ?? null;
  const activeViewportMainModuleId = useLayoutSelector(
    selectActiveViewportMainModuleId,
  );

  useEffect(() => {
    if (!targetId) return;
    return requestVisualizationDebugTarget(kernel.visualizationDebug, targetId);
  }, [kernel.visualizationDebug, targetId]);

  const subscribeSnapshots = useCallback(
    (listener: () => void) =>
      targetId
        ? kernel.visualizationDebug.subscribe(targetId, listener)
        : () => undefined,
    [kernel.visualizationDebug, targetId],
  );
  const getSnapshots = useCallback(
    () =>
      targetId
        ? kernel.visualizationDebug.getSnapshots(targetId)
        : EMPTY_VISUALIZATION_DEBUG_SNAPSHOTS,
    [kernel.visualizationDebug, targetId],
  );
  const snapshots = useSyncExternalStore(
    subscribeSnapshots,
    getSnapshots,
    () => EMPTY_VISUALIZATION_DEBUG_SNAPSHOTS,
  );

  const diagnosticsVersion = useSyncExternalStore(
    (listener) => kernel.diagnostics.subscribe(listener),
    () => kernel.diagnostics.getVersion(),
    () => DIAGNOSTICS_SERVER_VERSION,
  );
  const diagnostics = useMemo(() => {
    return diagnosticsVersion === DIAGNOSTICS_SERVER_VERSION
      ? EMPTY_REQUEST_DIAGNOSTICS
      : kernel.diagnostics.listNewestFirst();
  }, [diagnosticsVersion, kernel.diagnostics]);
  const clientAcks = useVisualizationClientAcksResource({
    enabled: target !== null,
  });

  return useMemo(
    () =>
      buildVisualizationDebugPanelModel({
        activeViewportMainModuleId,
        clientAcks: clientAcks.data,
        diagnostics,
        fieldMetaByQueryKey,
        selection,
        snapshots,
      }),
    [
      activeViewportMainModuleId,
      clientAcks.data,
      diagnostics,
      fieldMetaByQueryKey,
      selection,
      snapshots,
    ],
  );
}

function VisualizationDebugFieldMetaObserver({
  query,
  registry,
}: {
  query: VisualizationDebugExactFieldQuery;
  registry: VisualizationDebugFieldMetaRegistry;
}) {
  useEffect(
    () => registry.retain(query.metaQueryKey),
    [query.metaQueryKey, registry],
  );
  const resource = useFieldMetaResource(
    visualizationDebugFieldMetaHookInput(query),
  );
  useEffect(() => {
    registry.set(
      query.metaQueryKey,
      resolveVisualizationDebugFieldMetaRegistryValue(resource),
    );
  }, [query.metaQueryKey, registry, resource.data, resource.status]);
  return null;
}

export function resolveVisualizationDebugFieldMetaRegistryValue(resource: {
  data: FieldMetaResource | null;
  status: string;
}): FieldMetaResource | null {
  return resource.status === "ready" ? resource.data : null;
}

export function visualizationDebugFieldMetaHookInput(
  query: VisualizationDebugExactFieldQuery | null,
): Parameters<typeof useFieldMetaResource>[0] {
  return {
    component: query?.component ?? null,
    enabled: query !== null,
    quantityId: query?.quantityId ?? "m",
    scope_id: query?.scopeId ?? null,
    scope_kind: query?.scopeKind ?? null,
    snapshot_id: query?.snapshotId ?? null,
    stage_id: query?.stageId ?? null,
  };
}
