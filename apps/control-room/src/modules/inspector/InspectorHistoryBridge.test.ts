import { describe, expect, it, vi } from "vitest";

import type { InspectorEditSession } from "./InspectorEditSession";
import { applyInspectorSessionWithHistory } from "./InspectorHistoryBridge";

function session(patch: Partial<InspectorEditSession> = {}): InspectorEditSession {
  return {
    apply: vi.fn(async () => true),
    applying: false,
    dirty: true,
    mode: "staged",
    reset: vi.fn(),
    valid: true,
    ...patch,
  };
}

function scene(scene_revision: number) {
  return { objects: [], revision: scene_revision, scene_revision } as never;
}

describe("applyInspectorSessionWithHistory", () => {
  it("brackets a staged apply with authoritative scene revisions", async () => {
    const apply = vi.fn(async () => true);
    const history = { record: vi.fn() };
    const api = {
      model: {
        scene: vi
          .fn()
          .mockResolvedValueOnce(scene(4))
          .mockResolvedValueOnce(scene(5)),
      },
    };

    await expect(
      applyInspectorSessionWithHistory(session({ apply }), api, history, "Material"),
    ).resolves.toBe(true);

    expect(apply).toHaveBeenCalledOnce();
    expect(history.record).toHaveBeenCalledWith(
      expect.objectContaining({
        before: expect.objectContaining({ scene_revision: 4 }),
        after: expect.objectContaining({ scene_revision: 5 }),
        committedRevision: 5,
        label: "Material",
      }),
    );
  });

  it("does not create history for a rejected or unchanged apply", async () => {
    const history = { record: vi.fn() };
    const api = {
      model: {
        scene: vi
          .fn()
          .mockResolvedValueOnce(scene(4))
          .mockResolvedValueOnce(scene(4)),
      },
    };

    await expect(
      applyInspectorSessionWithHistory(
        session({ apply: vi.fn(async () => true) }),
        api,
        history,
      ),
    ).resolves.toBe(true);
    await expect(
      applyInspectorSessionWithHistory(
        session({ apply: vi.fn(async () => false) }),
        api,
        history,
      ),
    ).resolves.toBe(false);

    expect(history.record).not.toHaveBeenCalled();
  });

  it("does not bracket live viewport or immediate actions", async () => {
    const apply = vi.fn(async () => true);
    const history = { record: vi.fn() };
    const api = { model: { scene: vi.fn() } };

    await expect(
      applyInspectorSessionWithHistory(
        session({ apply, mode: "liveViewport" }),
        api,
        history,
      ),
    ).resolves.toBe(true);
    await expect(
      applyInspectorSessionWithHistory(
        session({ apply, mode: "immediate" }),
        api,
        history,
      ),
    ).resolves.toBe(true);

    expect(api.model.scene).not.toHaveBeenCalled();
    expect(history.record).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("keeps a valid apply successful when history capture is unavailable", async () => {
    const apply = vi.fn(async () => true);
    const history = { record: vi.fn() };
    const api = {
      model: {
        scene: vi.fn().mockRejectedValue(new Error("session unavailable")),
      },
    };

    await expect(
      applyInspectorSessionWithHistory(session({ apply }), api, history),
    ).resolves.toBe(true);
    expect(apply).toHaveBeenCalledOnce();
    expect(history.record).not.toHaveBeenCalled();
  });
});

