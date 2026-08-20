import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  createVisualizationAckCoordinator,
  resolveVisualizationEffectiveRenderMode,
  retainVisualizationAckCoordinator,
  sendVisualizationClientAck,
} from "./useVisualizationClientAck";

describe("resolveVisualizationEffectiveRenderMode", () => {
  it("reports surface when the canonical surface layer is visible", () => {
    expect(
      resolveVisualizationEffectiveRenderMode({
        layers: {
          surface: { visible: true },
          wireframe: { visible: false },
        },
      }),
    ).toBe("surface");
  });

  it("reports all visible renderer layers in deterministic order", () => {
    expect(
      resolveVisualizationEffectiveRenderMode({
        layers: {
          points: { visible: true },
          surface: { visible: true },
          vectors: { visible: true },
          wireframe: { visible: true },
        },
      }),
    ).toBe("surface+wireframe+points+vectors");
  });

  it("reports hidden when no renderer layer is visible", () => {
    expect(resolveVisualizationEffectiveRenderMode({ layers: null })).toBe(
      "hidden",
    );
  });
});

describe("visualization ACK coordinator contract", () => {
  it("keeps one terminal ACK across owner cleanup and rejects sends without an active owner", () => {
    const ack = vi.fn().mockResolvedValue(undefined);
    const api = { visualization: { ack } } as never;
    const input = {
      revision: 7,
      sessionEpoch: "epoch-1",
      status: "rendered" as const,
      viewportId: "main",
    };
    const releaseFirstOwner = retainVisualizationAckCoordinator(api);
    const releaseSecondOwner = retainVisualizationAckCoordinator(api);

    sendVisualizationClientAck(api, input);
    releaseFirstOwner();
    sendVisualizationClientAck(api, input);
    releaseSecondOwner();
    sendVisualizationClientAck(api, input);

    expect(ack).toHaveBeenCalledTimes(1);

    const releaseRemountedOwner = retainVisualizationAckCoordinator(api);
    sendVisualizationClientAck(api, input);

    expect(ack).toHaveBeenCalledTimes(1);

    releaseRemountedOwner();
  });

  it("coalesces two owners for the same session, viewport, and revision", () => {
    const ack = vi.fn().mockResolvedValue(undefined);
    const coordinator = createVisualizationAckCoordinator({
      visualization: { ack },
    } as never);
    const input = {
      revision: 7,
      sessionEpoch: "epoch-1",
      status: "rendered" as const,
      viewportId: "main",
    };

    coordinator.send(input);
    coordinator.send(input);

    expect(ack).toHaveBeenCalledTimes(1);
  });

  it("waits for the matching data adoption and frame commit before a terminal ACK", () => {
    vi.useFakeTimers();
    const ack = vi.fn().mockResolvedValue(undefined);
    const coordinator = createVisualizationAckCoordinator({
      visualization: { ack },
    } as never);
    const input = {
      changeKind: "data" as const,
      dataIdentity: {
        fieldBufferId: "session-1:epoch-1:H_demag:7",
        fieldRevision: "7",
        resourceKey: "field:H_demag:r7",
        sessionEpoch: "epoch-1",
        sessionId: "session-1",
        visualizationRevision: 7,
      },
      resourceKey: "field:H_demag:r7",
      revision: 7,
      sessionEpoch: "epoch-1",
      status: "applied" as const,
      viewportId: "main",
    };

    coordinator.send(input);
    vi.advanceTimersByTime(4_999);
    expect(ack).not.toHaveBeenCalled();
    coordinator.send({
      ...input,
      renderCommit: {
        fieldBufferId: "session-1:epoch-1:H_demag:7",
        fieldRevision: "7",
        resourceKey: "field:wrong",
        sessionEpoch: "epoch-1",
        sessionId: "session-1",
        visualizationRevision: 7,
      },
      status: "rendered",
    });
    coordinator.send({
      ...input,
      renderCommit: {
        fieldBufferId: "session-1:epoch-1:H_demag:7",
        fieldRevision: "7",
        resourceKey: "field:H_demag:r7",
        sessionEpoch: "epoch-1",
        sessionId: "session-1",
        visualizationRevision: 8,
      },
      status: "rendered",
    });
    expect(ack).not.toHaveBeenCalled();
    coordinator.send({
      ...input,
      renderCommit: {
        fieldBufferId: "session-1:epoch-1:H_demag:7",
        fieldRevision: "7",
        resourceKey: "field:H_demag:r7",
        sessionEpoch: "epoch-1",
        sessionId: "session-1",
        visualizationRevision: 7,
      },
      status: "rendered",
    });

    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack.mock.calls[0]?.[0]).toMatchObject({ revision: 7, status: "rendered" });
    vi.useRealTimers();
  });

  it("fails closed on missing data commit and bounds a burst without dropping terminal outcomes", () => {
    vi.useFakeTimers();
    const ack = vi.fn().mockResolvedValue(undefined);
    const coordinator = createVisualizationAckCoordinator({ visualization: { ack } } as never);
    for (let revision = 1; revision <= 65; revision += 1) {
      coordinator.send({
        changeKind: "data",
        resourceKey: `field:${revision}`,
        revision,
        sessionEpoch: "epoch-1",
        status: "applied",
        viewportId: "main",
      });
    }
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack.mock.calls[0]?.[0]).toMatchObject({ revision: 65, status: "failed" });
    vi.advanceTimersByTime(5_000);
    expect(ack).toHaveBeenCalledTimes(65);
    expect(new Set(ack.mock.calls.map(([request]) => request.revision)).size).toBe(65);
    expect(ack.mock.calls.every(([request]) => request.status === "failed")).toBe(true);
    vi.useRealTimers();
  });

  it("fails closed when the final owner cleans up a pending data revision", () => {
    const ack = vi.fn().mockResolvedValue(undefined);
    const api = { visualization: { ack } } as never;
    const release = retainVisualizationAckCoordinator(api);
    sendVisualizationClientAck(api, {
      changeKind: "data",
      resourceKey: "field:m",
      revision: 11,
      sessionEpoch: "epoch-1",
      status: "applied",
      viewportId: "main",
    });
    release();
    expect(ack).toHaveBeenCalledOnce();
    expect(ack.mock.calls[0]?.[0]).toMatchObject({ revision: 11, status: "failed" });
  });

  it("fails each pending old epoch revision exactly once before accepting a new epoch", () => {
    const ack = vi.fn().mockResolvedValue(undefined);
    const coordinator = createVisualizationAckCoordinator({ visualization: { ack } } as never);
    coordinator.send({
      changeKind: "data",
      dataIdentity: { fieldBufferId: "s1:e1:m:1", fieldRevision: "1", resourceKey: "field:m", sessionEpoch: "e1", sessionId: "s1", visualizationRevision: 1 },
      resourceKey: "field:m",
      revision: 1,
      sessionEpoch: "e1",
      status: "applied",
      viewportId: "main",
    });
    coordinator.send({
      changeKind: "style",
      revision: 2,
      sessionEpoch: "e2",
      status: "rendered",
      viewportId: "main",
    });
    expect(ack).toHaveBeenCalledTimes(2);
    expect(ack.mock.calls.map(([request]) => [request.revision, request.status])).toEqual([
      [1, "failed"],
      [2, "rendered"],
    ]);
  });

  it("sends a style-only rendered revision once without an applied receipt", () => {
    const ack = vi.fn().mockResolvedValue(undefined);
    const coordinator = createVisualizationAckCoordinator({
      visualization: { ack },
    } as never);

    coordinator.send({
      effectiveRenderMode: "surface+wireframe",
      revision: 8,
      sessionEpoch: "epoch-1",
      status: "rendered",
      viewportId: "main",
    });

    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack.mock.calls[0]?.[0]).toMatchObject({
      effective_render_mode: "surface+wireframe",
      revision: 8,
      status: "rendered",
    });
  });

  it("does not send another ACK for orbit rerenders without a revision change", () => {
    const ack = vi.fn().mockResolvedValue(undefined);
    const coordinator = createVisualizationAckCoordinator({
      visualization: { ack },
    } as never);
    const input = {
      revision: 9,
      sessionEpoch: "epoch-1",
      status: "rendered" as const,
      viewportId: "main",
    };

    coordinator.send(input);
    coordinator.send(input);
    coordinator.send(input);

    expect(ack).toHaveBeenCalledTimes(1);
  });

  it("keys pending and sent ACKs by session epoch, viewport, and revision", () => {
    const source = readFileSync(new URL("./useVisualizationClientAck.ts", import.meta.url), "utf8");

    expect(source).toContain(
      "`${sessionEpoch}\\u0000${viewportId}\\u0000${revision}`",
    );
    expect(source).toContain("coordinator.pending.get(key)");
    expect(source).toContain("coordinator.sessionEpoch !== sessionEpoch");
  });
});
