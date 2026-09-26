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
    expect(history.record).toHaveBeenCalledOnce();
    expect(history.record).toHaveBeenCalledWith(
      expect.objectContaining({
        before: expect.objectContaining({ scene_revision: 4 }),
        after: expect.objectContaining({ scene_revision: 5 }),
        committedRevision: 5,
        label: "Material",
      }),
    );
  });

  it("pins both history snapshots to the captured session scope", async () => {
    const apply = vi.fn(async () => true);
    const history = { record: vi.fn() };
    const api = {
      model: {
        scene: vi
          .fn()
          .mockResolvedValueOnce(scene(8))
          .mockResolvedValueOnce(scene(9)),
      },
    };
    const requestOptions = { sessionScopeKey: "session=A&epoch=4" };

    await expect(
      applyInspectorSessionWithHistory(
        session({ apply }),
        api,
        history,
        "Scoped draft",
        { requestOptions },
      ),
    ).resolves.toBe(true);

    expect(api.model.scene).toHaveBeenNthCalledWith(1, requestOptions);
    expect(api.model.scene).toHaveBeenNthCalledWith(2, requestOptions);
    expect(history.record).toHaveBeenCalledOnce();
  });

  it("does not apply after the session changes while reading the before snapshot", async () => {
    let current = true;
    let resolveScene!: (value: ReturnType<typeof scene>) => void;
    const sceneRead = new Promise<ReturnType<typeof scene>>((resolve) => {
      resolveScene = resolve;
    });
    const apply = vi.fn(async () => true);
    const history = { record: vi.fn() };

    const result = applyInspectorSessionWithHistory(
      session({ apply }),
      { model: { scene: vi.fn(() => sceneRead) } },
      history,
      "Scoped draft",
      { isCurrent: () => current },
    );
    current = false;
    resolveScene(scene(10));

    await expect(result).resolves.toBe(false);
    expect(apply).not.toHaveBeenCalled();
    expect(history.record).not.toHaveBeenCalled();
  });

  it("does not record a staged apply after its session changes", async () => {
    let current = true;
    const apply = vi.fn(async () => {
      current = false;
      return true;
    });
    const history = { record: vi.fn() };
    const sceneRead = vi.fn().mockResolvedValue(scene(10));

    await expect(
      applyInspectorSessionWithHistory(
        session({ apply }),
        { model: { scene: sceneRead } },
        history,
        "Scoped draft",
        { isCurrent: () => current },
      ),
    ).resolves.toBe(false);

    expect(sceneRead).toHaveBeenCalledOnce();
    expect(history.record).not.toHaveBeenCalled();
  });

  it("does not record after the history generation is invalidated", async () => {
    let generation = 4;
    const history = { record: vi.fn() };
    const apply = vi.fn(async () => {
      generation += 1;
      return true;
    });
    const sceneRead = vi.fn().mockResolvedValue(scene(10));

    await expect(
      applyInspectorSessionWithHistory(
        session({ apply }),
        { model: { scene: sceneRead } },
        history,
        "Scoped draft",
        { isHistoryGenerationCurrent: () => generation === 4 },
      ),
    ).resolves.toBe(false);

    expect(sceneRead).toHaveBeenCalledOnce();
    expect(history.record).not.toHaveBeenCalled();
  });

  it("does not create history for a rejected or unchanged apply", async () => {
    const history = { record: vi.fn() };
    const api = {
      model: {
        scene: vi
          .fn()
          .mockResolvedValueOnce(scene(4))
          .mockResolvedValueOnce(scene(4))
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

  it("records a partial scene commit even when the staged callback reports failure", async () => {
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
      applyInspectorSessionWithHistory(
        session({ apply: vi.fn(async () => false) }),
        api,
        history,
      ),
    ).resolves.toBe(false);

    expect(history.record).toHaveBeenCalledOnce();
    expect(history.record).toHaveBeenCalledWith(
      expect.objectContaining({
        before: expect.objectContaining({ scene_revision: 4 }),
        after: expect.objectContaining({ scene_revision: 5 }),
        committedRevision: 5,
      }),
    );
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
