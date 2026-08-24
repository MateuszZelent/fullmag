"use client";

import { useCallback, useSyncExternalStore } from "react";

import {
  DATA_FROZEN_SPINS_RESOLVED_MASK_PATH,
  MODEL_FROZEN_SPIN_PATH,
  MODEL_FROZEN_SPINS_PATH,
} from "../api/apiPaths";
import type {
  FrozenSpinsCollectionResource,
  FrozenSpinsDefinitionResource,
  FrozenSpinsPreviewResponse,
  ResourceRevision,
} from "../api/apiTypes";
import { useKernel } from "../KernelContext";

import { useResource } from "./useResource";

const FROZEN_MASK_HEADER_BYTES = 64;

export interface DecodedFrozenSpinsMask {
  bitCount: number;
  frozenIndices: Uint32Array;
  maskSha256: string;
  sceneRevision: number;
  sourceStateRevision: number;
}

export const FROZEN_SPINS_ACTIVE_PREVIEW_RESOURCE_KEY =
  "model:frozen-spins:active-preview";

interface ResourceHookOptions {
  enabled?: boolean;
}

export function frozenSpinsCollectionResourceKey(): string {
  return MODEL_FROZEN_SPINS_PATH;
}

export function frozenSpinsDefinitionResourceKey(constraintId: string): string {
  return MODEL_FROZEN_SPIN_PATH.replace(
    "{constraint_id}",
    encodeURIComponent(constraintId),
  );
}

export function frozenSpinsMaskResourceKey(maskId: string): string {
  return DATA_FROZEN_SPINS_RESOLVED_MASK_PATH.replace(
    "{mask_id}",
    encodeURIComponent(maskId),
  );
}

export function frozenSpinsMaskIdFromResource(resource: string): string | null {
  const prefix = DATA_FROZEN_SPINS_RESOLVED_MASK_PATH.split("{mask_id}")[0]!;
  if (!resource.startsWith(prefix)) return null;
  const encoded = resource.slice(prefix.length);
  if (!encoded || encoded.includes("/") || encoded.includes("?")) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

export function frozenSpinsPreviewResourceKey(previewId: string): string {
  return `model:frozen-spins:preview:${encodeURIComponent(previewId)}`;
}

export function useFrozenSpinsCollectionResource(
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const baseKey = frozenSpinsCollectionResourceKey();
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.model.frozenSpins.list({ signal }),
    [api],
  );
  return useResource<FrozenSpinsCollectionResource | null>({
    enabled: options.enabled,
    load,
    resolveRevision: frozenSpinsRevision,
    resourceKey: baseKey,
  });
}

export function useFrozenSpinsDefinitionResource(
  constraintId: string,
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const baseKey = frozenSpinsDefinitionResourceKey(constraintId);
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.model.frozenSpins.get(constraintId, { signal }),
    [api, constraintId],
  );
  return useResource<FrozenSpinsDefinitionResource | null>({
    enabled: options.enabled !== false && constraintId.length > 0,
    load,
    resolveRevision: frozenSpinsRevision,
    resourceKey: baseKey,
  });
}

export function useFrozenSpinsMaskResource(
  maskId: string,
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const baseKey = frozenSpinsMaskResourceKey(maskId);
  const load = useCallback(
    async ({ signal }: { signal: AbortSignal }) => {
      const response = await api.model.frozenSpins.resolvedMask(maskId, {
        signal,
      });
      return response.status === "ready"
        ? decodeFrozenSpinsMask(response.data)
        : null;
    },
    [api, maskId],
  );
  return useResource<DecodedFrozenSpinsMask | null>({
    enabled: options.enabled !== false && maskId.length > 0,
    load,
    resolveRevision: (mask) => mask?.maskSha256 ?? null,
    resourceKey: baseKey,
  });
}

export function useFrozenSpinsPreviewResource(
  previewId: string,
  options: ResourceHookOptions = {},
) {
  const { api } = useKernel();
  const baseKey = frozenSpinsPreviewResourceKey(previewId);
  const load = useCallback(
    ({ signal }: { signal: AbortSignal }) =>
      api.model.frozenSpins.getPreview(previewId, { signal }),
    [api, previewId],
  );
  return useResource<FrozenSpinsPreviewResponse | null>({
    enabled: options.enabled !== false && previewId.length > 0,
    load,
    resolveRevision: (preview) => preview?.revision ?? null,
    resourceKey: baseKey,
  });
}

export function useFrozenSpinsActivePreviewId(): string | null {
  const revision = useResourceRevision(FROZEN_SPINS_ACTIVE_PREVIEW_RESOURCE_KEY);
  return typeof revision === "string" && revision.length > 0 ? revision : null;
}

export function decodeFrozenSpinsMask(buffer: ArrayBuffer): DecodedFrozenSpinsMask {
  if (buffer.byteLength < FROZEN_MASK_HEADER_BYTES) {
    throw new Error("Frozen-spins mask is shorter than the FMSK header.");
  }
  const bytes = new Uint8Array(buffer);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "FMSK") {
    throw new Error("Frozen-spins mask has an invalid FMSK magic.");
  }
  if (bytes[4] !== 1 || bytes[5] !== 1) {
    throw new Error("Frozen-spins mask uses an unsupported version or encoding.");
  }
  const view = new DataView(buffer);
  const bitCount = safeUint64(view, 8, "bit count");
  const sceneRevision = safeUint64(view, 16, "scene revision");
  const sourceStateRevision = safeUint64(view, 24, "source-state revision");
  const payloadBytes = Math.ceil(bitCount / 8);
  if (buffer.byteLength !== FROZEN_MASK_HEADER_BYTES + payloadBytes) {
    throw new Error("Frozen-spins mask payload length does not match its header.");
  }

  const indices: number[] = [];
  for (let index = 0; index < bitCount; index += 1) {
    if ((bytes[FROZEN_MASK_HEADER_BYTES + Math.floor(index / 8)]! & (1 << (index % 8))) !== 0) {
      indices.push(index);
    }
  }
  return {
    bitCount,
    frozenIndices: Uint32Array.from(indices),
    maskSha256: `sha256:${Array.from(bytes.subarray(32, 64), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("")}`,
    sceneRevision,
    sourceStateRevision,
  };
}

function frozenSpinsRevision(
  resource: FrozenSpinsCollectionResource | FrozenSpinsDefinitionResource | null,
): ResourceRevision | null {
  return resource?.revision ?? null;
}

function safeUint64(view: DataView, offset: number, label: string): number {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Frozen-spins mask ${label} exceeds JavaScript safe integer range.`);
  }
  return Number(value);
}

function useResourceRevision(resourceKey: string): ResourceRevision | null {
  const { resources } = useKernel();
  const subscribe = useCallback(
    (listener: () => void) => resources.subscribe(resourceKey, listener),
    [resourceKey, resources],
  );
  const getSnapshot = useCallback(
    () => resources.getRevision(resourceKey),
    [resourceKey, resources],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
