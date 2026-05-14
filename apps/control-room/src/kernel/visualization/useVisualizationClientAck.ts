"use client";

import { useEffect, useRef } from "react";

import type { ControlRoomApi } from "../api/ControlRoomApi";
import type { VisualizationClientAckRequest } from "../api/apiTypes";

const VISUALIZATION_CLIENT_ID_STORAGE_KEY = "fullmag.visualization.clientId";

type VisualizationClientAckStatus = VisualizationClientAckRequest["status"];

let volatileVisualizationClientId: string | null = null;

function makeVisualizationClientId(): string {
  return `browser-${
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
  }`;
}

export function resolveVisualizationClientId(): string {
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
}: {
  api: ControlRoomApi;
  effectiveRenderMode?: string | null;
  enabled?: boolean;
  error?: string | null;
  revision: number | null | undefined;
  status: VisualizationClientAckStatus;
  viewportId: string;
}) {
  const lastSentKeyRef = useRef<string | null>(null);

  useEffect(() => {
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
    lastSentKeyRef.current = sentKey;

    void api.visualization.ack(request).catch(() => undefined);
  }, [api, effectiveRenderMode, enabled, error, revision, status, viewportId]);
}
