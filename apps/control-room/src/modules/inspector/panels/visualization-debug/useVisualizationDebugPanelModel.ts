"use client";

import {
  createElement,
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
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
import type { VisualizationDebugSnapshot } from "@/kernel/visualization/visualizationDebugTypes";
import { useVisualizationClientAcksResource } from "@/kernel/visualization/useVisualizationClientAcksResource";

import {
  buildVisualizationDebugPanelModel,
  resolveVisualizationDebugTarget,
  visualizationDebugQuerySupportsFieldMeta,
  type VisualizationDebugExactFieldQuery,
  type VisualizationDebugPanelModel,
} from "./VisualizationDebugPanelModel";

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

interface VisualizationDebugDiagnosticsSnapshot {
  entries: readonly RequestDiagnosticEntry[];
  resourceKeys: string;
  signature: string;
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
      if (!visualizationDebugQuerySupportsFieldMeta(query)) continue;
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

  const diagnosticsResourceKeys = useMemo(
    () => visualizationDebugDiagnosticResourceKeys(snapshots),
    [snapshots],
  );
  const diagnosticsSnapshotRef = useRef<VisualizationDebugDiagnosticsSnapshot | null>(
    null,
  );
  const subscribeDiagnostics = useCallback(
    (listener: () => void) => kernel.diagnostics.subscribe(listener),
    [kernel.diagnostics],
  );
  const getDiagnosticsSnapshot = useCallback(() => {
    if (diagnosticsResourceKeys.size === 0) {
      diagnosticsSnapshotRef.current = null;
      return EMPTY_REQUEST_DIAGNOSTICS;
    }
    const entries = kernel.diagnostics
      .listNewestFirst()
      .filter(
        (entry) =>
          entry.resourceKey !== null &&
          entry.resourceKey !== undefined &&
          diagnosticsResourceKeys.has(entry.resourceKey),
      );
    const resourceKeys = [...diagnosticsResourceKeys].sort().join("\u0000");
    const signature = visualizationDebugDiagnosticsSignature(entries);
    const previous = diagnosticsSnapshotRef.current;
    if (
      previous?.resourceKeys === resourceKeys &&
      previous.signature === signature
    ) {
      return previous.entries;
    }
    const next = Object.freeze([...entries]);
    diagnosticsSnapshotRef.current = { entries: next, resourceKeys, signature };
    return next;
  }, [diagnosticsResourceKeys, kernel.diagnostics]);
  const diagnostics = useSyncExternalStore(
    subscribeDiagnostics,
    getDiagnosticsSnapshot,
    () => EMPTY_REQUEST_DIAGNOSTICS,
  );
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

function visualizationDebugDiagnosticResourceKeys(
  snapshots: readonly VisualizationDebugSnapshot[],
): ReadonlySet<string> {
  const resourceKeys = new Set<string>();
  for (const snapshot of snapshots) {
    for (const carrier of snapshot.carriers) {
      const requested = carrier.request.resourceKey;
      const adoptedSurface = carrier.render.adoption.surface.adoptedResourceKey;
      const adoptedVector = carrier.render.adoption.vector.adoptedResourceKey;
      if (requested) resourceKeys.add(requested);
      if (adoptedSurface) resourceKeys.add(adoptedSurface);
      if (adoptedVector) resourceKeys.add(adoptedVector);
    }
  }
  return resourceKeys;
}

function visualizationDebugDiagnosticsSignature(
  entries: readonly RequestDiagnosticEntry[],
): string {
  return JSON.stringify(
    entries.map((entry) => [
      entry.id,
      entry.timestampMs,
      entry.requestId,
      entry.resourceKey ?? null,
      entry.channel,
      entry.direction,
      entry.method,
      entry.outcome,
      entry.status,
      entry.byteLength,
      entry.durationMs,
      entry.contentType,
      entry.etag ?? null,
      entry.messageType,
      entry.detail,
      entry.path,
    ]),
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
  const { data, status } = useFieldMetaResource(
    visualizationDebugFieldMetaHookInput(query),
  );
  useEffect(() => {
    registry.set(
      query.metaQueryKey,
      resolveVisualizationDebugFieldMetaRegistryValue({ data, status }),
    );
  }, [data, query.metaQueryKey, registry, status]);
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
    enabled:
      query !== null && visualizationDebugQuerySupportsFieldMeta(query),
    quantityId: query?.quantityId ?? "m",
    scope_id: query?.scopeId ?? null,
    scope_kind: query?.scopeKind ?? null,
    snapshot_id: query?.snapshotId ?? null,
    stage_id: query?.stageId ?? null,
  };
}
