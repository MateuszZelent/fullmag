"use client";

import { useCallback, useEffect, useRef } from "react";

import type { ControlRoomApi } from "../api/ControlRoomApi";
import type { VisualizationClientAckRequest } from "../api/apiTypes";

const VISUALIZATION_CLIENT_ID_STORAGE_KEY = "fullmag.visualization.clientId";

type VisualizationClientAckStatus = VisualizationClientAckRequest["status"];
interface VisualizationClientAckInput {
  effectiveRenderMode?: string | null;
  enabled?: boolean;
  error?: string | null;
  revision: number | null | undefined;
  status: VisualizationClientAckStatus;
  viewportId: string;
}

let volatileVisualizationClientId: string | null = null;

function makeVisualizationClientId(): string {
  return `browser-${
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
  }`;
}

function resolveVisualizationClientId(): string {
  if (typeof window === "undefined") {
    return (
      volatileVisualizationClientId ??
      (volatileVisualizationClientId = makeVisualizationClientId())
    );
  }

  try {
    const stored = window.localStorage.getItem(
      VISUALIZATION_CLIENT_ID_STORAGE_KEY,
    );
    if (stored) return stored;

    const next = makeVisualizationClientId();
    window.localStorage.setItem(VISUALIZATION_CLIENT_ID_STORAGE_KEY, next);
    return next;
  } catch {
    return (
      volatileVisualizationClientId ??
      (volatileVisualizationClientId = makeVisualizationClientId())
    );
  }
}

export function resolveVisualizationEffectiveRenderMode({
  layers,
}: {
  layers: {
    points?: { visible?: boolean } | null;
    surface?: { visible?: boolean } | null;
    vectors?: { visible?: boolean } | null;
    volume_mesh?: { visible?: boolean } | null;
    wireframe?: { visible?: boolean } | null;
  } | null | undefined;
}): string {
  const visibleLayers = [
    layers?.surface?.visible ? "surface" : null,
    layers?.wireframe?.visible ? "wireframe" : null,
    layers?.volume_mesh?.visible ? "volume_mesh" : null,
    layers?.points?.visible ? "points" : null,
    layers?.vectors?.visible ? "vectors" : null,
  ].filter((layer): layer is string => Boolean(layer));

  return visibleLayers.length > 0 ? visibleLayers.join("+") : "hidden";
}

export function useVisualizationClientAck({
  api,
  effectiveRenderMode,
  enabled = true,
  error,
  revision,
  status,
  viewportId,
}: VisualizationClientAckInput & {
  api: ControlRoomApi;
}) {
  const sendAck = useVisualizationClientAckSender({ api });

  useEffect(() => {
    sendAck({
      effectiveRenderMode,
      enabled,
      error,
      revision,
      status,
      viewportId,
    });
  }, [effectiveRenderMode, enabled, error, revision, sendAck, status, viewportId]);
}

export function useVisualizationClientAckSender({
  api,
}: {
  api: ControlRoomApi;
}) {
  const lastSentKeyRef = useRef<string | null>(null);
  const pendingAcksRef = useRef<
    Map<
      number,
      {
        request: VisualizationClientAckRequest;
        timeoutId: ReturnType<typeof setTimeout>;
        sentKey: string;
      }
    >
  >(new Map());

  // Clean up all pending timeouts on unmount to avoid memory leaks or late triggers
  useEffect(() => {
    const pending = pendingAcksRef.current;
    return () => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timeoutId);
      }
      pending.clear();
    };
  }, []);

  return useCallback(
    ({
      effectiveRenderMode,
      enabled = true,
      error,
      revision,
      status,
      viewportId,
    }: VisualizationClientAckInput) => {
      if (!enabled || revision === null || revision === undefined) return;

      const request: VisualizationClientAckRequest = {
        client_id: resolveVisualizationClientId(),
        client_label: "control-room",
        viewport_id: viewportId,
        revision,
        status,
      };

      if (effectiveRenderMode) {
        request.effective_render_mode = effectiveRenderMode;
      }
      if (error) {
        request.error = error;
      }

      const sentKey = JSON.stringify(request);
      if (lastSentKeyRef.current === sentKey) return;

      // Check if there is already a pending ACK for this revision
      const pending = pendingAcksRef.current.get(revision);
      if (pending) {
        // If the new status is "rendered" or "failed", and the pending one is "applied",
        // then the new status completely supersedes and cancels the "applied" status.
        if (
          (status === "rendered" || status === "failed") &&
          pending.request.status === "applied"
        ) {
          clearTimeout(pending.timeoutId);
          pendingAcksRef.current.delete(revision);
        } else {
          // If a rendered/failed ACK is already pending or sent, ignore any redundant/slower status updates.
          return;
        }
      }

      // If this is an "applied" status, we defer sending it slightly (50ms) to see if "rendered" or "failed" arrives.
      if (status === "applied") {
        const timeoutId = setTimeout(() => {
          pendingAcksRef.current.delete(revision);
          lastSentKeyRef.current = sentKey;
          void api.visualization.ack(request).catch(() => undefined);
        }, 50);
        pendingAcksRef.current.set(revision, { request, timeoutId, sentKey });
      } else {
        // "rendered" and "failed" are high priority and sent immediately
        lastSentKeyRef.current = sentKey;
        void api.visualization.ack(request).catch(() => undefined);
      }
    },
    [api],
  );
}
