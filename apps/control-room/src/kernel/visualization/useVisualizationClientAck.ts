"use client";

import { useCallback, useEffect } from "react";

import type { ControlRoomApi } from "../api/ControlRoomApi";
import type { VisualizationClientAckRequest } from "../api/apiTypes";

const VISUALIZATION_CLIENT_ID_STORAGE_KEY = "fullmag.visualization.clientId";

type VisualizationClientAckStatus = VisualizationClientAckRequest["status"];
export interface VisualizationDataAdoptionIdentity {
  fieldBufferId: string;
  fieldRevision: string | null;
  resourceKey: string;
  sessionEpoch: string;
  sessionId: string;
  visualizationRevision: number;
}
export interface VisualizationClientAckInput {
  /** A data revision must be completed by a matching renderer commit. */
  changeKind?: "data" | "style";
  effectiveRenderMode?: string | null;
  enabled?: boolean;
  error?: string | null;
  revision: number | null | undefined;
  dataIdentity?: VisualizationDataAdoptionIdentity | null;
  renderCommit?: VisualizationDataAdoptionIdentity | null;
  resourceKey?: string | null;
  sessionId?: string | null;
  sessionEpoch: string | null;
  status: VisualizationClientAckStatus;
  viewportId: string;
}

let volatileVisualizationClientId: string | null = null;
const MAX_VISUALIZATION_ACK_REVISIONS = 256;
const MAX_PENDING_VISUALIZATION_ACKS = 64;
const VISUALIZATION_ACK_TIMEOUT_MS = 5_000;

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
  effectiveRenderMode,
  enabled = true,
  error,
  revision,
  sendAck,
  sessionId,
  sessionEpoch,
  status,
  viewportId,
}: VisualizationClientAckInput & {
  sendAck: (input: VisualizationClientAckInput) => void;
}) {
  useEffect(() => {
    sendAck({
      effectiveRenderMode,
      enabled,
      error,
      revision,
      sessionId,
      sessionEpoch,
      status,
      viewportId,
    });
  }, [effectiveRenderMode, enabled, error, revision, sendAck, sessionId, sessionEpoch, status, viewportId]);
}

export function useVisualizationClientAckSender({
  api,
}: {
  api: ControlRoomApi;
}) {
  useEffect(() => {
    return retainVisualizationAckCoordinator(api);
  }, [api]);

  return useCallback(
    (input: VisualizationClientAckInput) =>
      sendVisualizationClientAck(api, input),
    [api],
  );
}

interface VisualizationAckCoordinator {
  api: Pick<ControlRoomApi, "visualization">;
  owners: number;
  pending: Map<
    string,
    {
      request: VisualizationClientAckRequest;
      sessionScopeKey: string | null;
      timeoutId: ReturnType<typeof setTimeout>;
    }
  >;
  sentApplied: Set<string>;
  sentTerminal: Set<string>;
  sessionEpoch: string | null;
  sessionScopeKey: string | null;
  send(input: VisualizationClientAckInput): void;
}

const visualizationAckCoordinators = new WeakMap<ControlRoomApi, VisualizationAckCoordinator>();

function getVisualizationAckCoordinator(api: ControlRoomApi): VisualizationAckCoordinator {
  let coordinator = visualizationAckCoordinators.get(api);
  if (!coordinator) {
    coordinator = createVisualizationAckCoordinator(api);
    visualizationAckCoordinators.set(api, coordinator);
  }
  return coordinator;
}

export function retainVisualizationAckCoordinator(api: ControlRoomApi): () => void {
  const coordinator = getVisualizationAckCoordinator(api);
  coordinator.owners += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseVisualizationAckCoordinator(coordinator);
  };
}

export function sendVisualizationClientAck(
  api: ControlRoomApi,
  input: VisualizationClientAckInput,
): void {
  visualizationAckCoordinators.get(api)?.send(input);
}

function releaseVisualizationAckCoordinator(coordinator: VisualizationAckCoordinator): void {
  coordinator.owners = Math.max(0, coordinator.owners - 1);
  if (coordinator.owners > 0) return;
  for (const [key, entry] of coordinator.pending) {
    clearTimeout(entry.timeoutId);
    sendTerminalAck(coordinator.api, coordinator, key, {
      ...entry.request,
      error: "visualization ACK owner released before render commit",
      status: "failed",
    }, entry.sessionScopeKey);
  }
  coordinator.pending.clear();
}

export function createVisualizationAckCoordinator(
  api: Pick<ControlRoomApi, "visualization">,
): VisualizationAckCoordinator {
  const coordinator: VisualizationAckCoordinator = {
    api,
    owners: 0,
    pending: new Map(),
    sentApplied: new Set(),
    sentTerminal: new Set(),
    sessionEpoch: null,
    sessionScopeKey: null,
    send(input) {
      const {
        changeKind = "style",
        dataIdentity = null,
        effectiveRenderMode,
        enabled = true,
        error,
        renderCommit = null,
        revision,
        sessionId,
        sessionEpoch,
        status,
        viewportId,
      } = input;
      if (!enabled || revision === null || revision === undefined || !sessionEpoch) return;
      const sessionScopeKey = visualizationSessionScopeKey(
        sessionId,
        sessionEpoch,
        dataIdentity,
      );
      if (coordinator.sessionEpoch !== sessionEpoch || coordinator.sessionScopeKey !== sessionScopeKey) {
        for (const [pendingKey, entry] of coordinator.pending) {
          clearTimeout(entry.timeoutId);
          sendTerminalAck(api, coordinator, pendingKey, {
            ...entry.request,
            error: "visualization session epoch changed before render commit",
            status: "failed",
          }, entry.sessionScopeKey);
        }
        coordinator.pending.clear();
        coordinator.sentApplied.clear();
        coordinator.sentTerminal.clear();
        coordinator.sessionEpoch = sessionEpoch;
        coordinator.sessionScopeKey = sessionScopeKey;
      }
      const key = `${sessionEpoch}\u0000${viewportId}\u0000${revision}`;
      if (coordinator.sentTerminal.has(key)) return;
      if (status === "applied" && coordinator.sentApplied.has(key)) return;
      const request: VisualizationClientAckRequest = {
        client_id: resolveVisualizationClientId(),
        client_label: "control-room",
        viewport_id: viewportId,
        revision,
        status,
      };
      if (effectiveRenderMode) request.effective_render_mode = effectiveRenderMode;
      if (error) request.error = error;

      const pending = coordinator.pending.get(key);
      if (pending) {
        if ((status === "rendered" || status === "failed") && pending.request.status === "applied") {
          if (
            status === "rendered" &&
            !isMatchingRenderCommit(renderCommit, dataIdentity)
          ) {
            return;
          }
          clearTimeout(pending.timeoutId);
          coordinator.pending.delete(key);
        } else {
          return;
        }
      }
      if (status === "applied") {
        // `applied` is an internal data-revision registration, never a client ACK.
        // A renderer frame must supply a matching session/revision/resource receipt.
        if (changeKind !== "data") return;
        if (coordinator.pending.size >= MAX_PENDING_VISUALIZATION_ACKS) {
          sendTerminalAck(api, coordinator, key, {
            ...request,
            error: "visualization ACK backlog exhausted",
            status: "failed",
          }, sessionScopeKey);
          return;
        }
        const timeoutId = setTimeout(() => {
          coordinator.pending.delete(key);
          if (coordinator.sentTerminal.has(key)) return;
          sendTerminalAck(api, coordinator, key, {
            ...request,
            error: "visualization render adoption timed out",
            status: "failed",
          }, sessionScopeKey);
        }, VISUALIZATION_ACK_TIMEOUT_MS);
        coordinator.pending.set(key, { request, sessionScopeKey, timeoutId });
        return;
      }
      if (
        status === "rendered" &&
        changeKind === "data" &&
        !isMatchingRenderCommit(renderCommit, dataIdentity)
      ) {
        return;
      }
      sendTerminalAck(api, coordinator, key, request, sessionScopeKey);
    },
  };
  return coordinator;
}

function isMatchingRenderCommit(
  renderCommit: VisualizationClientAckInput["renderCommit"],
  expected: VisualizationClientAckInput["dataIdentity"],
): boolean {
  return Boolean(
    renderCommit && expected &&
      renderCommit.fieldBufferId === expected.fieldBufferId &&
      renderCommit.fieldRevision === expected.fieldRevision &&
      renderCommit.resourceKey === expected.resourceKey &&
      renderCommit.sessionEpoch === expected.sessionEpoch &&
      renderCommit.sessionId === expected.sessionId &&
      renderCommit.visualizationRevision === expected.visualizationRevision,
  );
}

function sendTerminalAck(
  api: Pick<ControlRoomApi, "visualization">,
  coordinator: VisualizationAckCoordinator,
  key: string,
  request: VisualizationClientAckRequest,
  sessionScopeKey: string | null,
): void {
  if (coordinator.sentTerminal.has(key)) return;
  coordinator.sentTerminal.add(key);
  coordinator.sentApplied.delete(key);
  trimVisualizationAckKeys(coordinator.sentTerminal);
  const result = sessionScopeKey === null
    ? api.visualization.ack(request)
    : api.visualization.ack(request, { sessionScopeKey });
  void result.catch(() => undefined);
}

function visualizationSessionScopeKey(
  sessionId: string | null | undefined,
  sessionEpoch: string,
  dataIdentity: VisualizationDataAdoptionIdentity | null,
): string | null {
  const id = sessionId ?? dataIdentity?.sessionId ?? null;
  if (!id) return null;
  return `session=${encodeURIComponent(id)}&epoch=${encodeURIComponent(sessionEpoch)}`;
}

function trimVisualizationAckKeys(keys: Set<string>): void {
  while (keys.size > MAX_VISUALIZATION_ACK_REVISIONS) {
    const oldest = keys.values().next().value;
    if (oldest === undefined) break;
    keys.delete(oldest);
  }
}
