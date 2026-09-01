"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import { useKernel } from "../KernelContext";
import type { ModeCompositionResource } from "../visualization/ModeCompositionController";
import {
  ModeCompositionFieldLayerController,
  type ModeCompositionFieldLayerLoaders,
  type ModeCompositionFieldLayerSnapshotMap,
  type ModeCompositionFieldLayerTopologyIdentity,
} from "../visualization/ModeCompositionFieldLayerController";

export type {
  ModeCompositionFieldLayerFailureReason,
  ModeCompositionFieldLayerSnapshot,
  ModeCompositionFieldLayerSnapshotMap,
  ModeCompositionFieldLayerStatus,
  ModeCompositionFieldLayerTopologyIdentity,
} from "../visualization/ModeCompositionFieldLayerController";

export interface UseModeCompositionFieldLayerResourcesOptions {
  readonly composition: ModeCompositionResource | null | undefined;
  readonly enabled?: boolean;
  readonly topologyByTarget: Readonly<
    Record<string, ModeCompositionFieldLayerTopologyIdentity | null | undefined>
  >;
}

/**
 * The only React boundary for per-object complex mode fields. It uses the
 * generated/facade API methods, while the controller owns cancellation,
 * binary-cache identity, retained compatible buffers, and bounded loading.
 */
export function useModeCompositionFieldLayerResources({
  composition,
  enabled = true,
  topologyByTarget,
}: UseModeCompositionFieldLayerResourcesOptions): ModeCompositionFieldLayerSnapshotMap {
  const { api } = useKernel();
  const [controller] = useState(() => new ModeCompositionFieldLayerController());
  const stableTopology = useStableTopologyByTarget(topologyByTarget);
  const loaders = useMemo<ModeCompositionFieldLayerLoaders>(() => ({
    loadMetadata: (layer, signal) => {
      const sampleIndex = layer.mode.sample_index;
      const modeIndex = layer.mode.raw_mode_index;
      if (
        typeof sampleIndex !== "number" ||
        !Number.isSafeInteger(sampleIndex) ||
        typeof modeIndex !== "number" ||
        !Number.isSafeInteger(modeIndex)
      ) {
        return Promise.reject(new Error("Mode layer does not expose canonical metadata indices."));
      }
      return api.analysis.frequencyDomain.eigenModeFieldMeta(sampleIndex, modeIndex, {
        signal,
      });
    },
    loadBinary: async (layer, signal, etag) => {
      const result = await api.data.fields.vector(
        layer.field_id,
        {
          component: "full",
          scope_id: layer.object_id,
          scope_kind: "object",
          view: "complex",
        },
        { etag, signal },
      );
      if (result.status !== "ready") {
        throw new Error(`Object-scoped mode field returned '${result.status}'.`);
      }
      return {
        byteLength: result.byteLength,
        data: result.data,
        encoding: result.responseMetadata.encoding,
        etag: result.etag,
        fieldRevision: result.responseMetadata.fieldRevision,
      };
    },
  }), [api]);
  const subscribe = useCallback(
    (listener: () => void) => controller.subscribe(listener),
    [controller],
  );
  const getSnapshot = useCallback(() => controller.getSnapshot(), [controller]);
  const snapshots = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!enabled || !composition) {
      controller.clear();
      return;
    }
    void controller.activate(composition, stableTopology, loaders);
    return () => controller.clear();
  }, [composition, controller, enabled, loaders, stableTopology]);

  return snapshots;
}

function useStableTopologyByTarget(
  topologyByTarget: Readonly<
    Record<string, ModeCompositionFieldLayerTopologyIdentity | null | undefined>
  >,
) {
  const identity = JSON.stringify(Object.entries(topologyByTarget)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([targetId, topology]) => [
      targetId,
      topology
        ? {
            domainGenerationId: topology.domainGenerationId,
            meshTopologyHash: topology.meshTopologyHash,
            meshTopologyRevision: topology.meshTopologyRevision,
          }
        : null,
    ]));
  return useMemo(
    () => Object.fromEntries(JSON.parse(identity) as ReadonlyArray<readonly [string, ModeCompositionFieldLayerTopologyIdentity | null]>),
    [identity],
  );
}
