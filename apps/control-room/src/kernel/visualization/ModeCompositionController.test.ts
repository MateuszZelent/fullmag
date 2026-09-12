import { describe, expect, it, vi } from "vitest";

import {
  ModeCompositionController,
  type ModeCompositionMutationClient,
  type ModeCompositionResource,
} from "./ModeCompositionController";

function composition(
  revision: number,
  overrides: Partial<ModeCompositionResource> = {},
): ModeCompositionResource {
  return {
    artifact_revision: "artifact-1",
    composition_id: "active",
    layers: [],
    lifecycle: {
      artifact_revision: 1,
      mesh_revision: 4,
      run_id: "run-1",
      session_id: "session-1",
    },
    phase_clock: { master_rate_hz: 1, synchronized: true },
    revision,
    run_id: "run-1",
    schema_version: "mode-composition.v1",
    stage_id: "stage-1",
    ...overrides,
  };
}

function layer(targetId: string, modeId: string) {
  return {
    amplitude_scale: 1,
    animation: {
      enabled: false,
      phase_offset_rad: 0,
      rate_hz: 0,
      synchronized: true,
    },
    appearance: {
      auto_range: true,
      colorbar_visible: true,
      colormap: "coolwarm",
      opacity: 1,
      symmetric_zero: true,
      vector_budget: 0,
      vector_length_scale: 1,
      vectors_visible: false,
    },
    component: "x" as const,
    enabled: true,
    field_id: "mode-field",
    layer_id: `mode-layer:${targetId}`,
    mode: {
      artifact_revision: "artifact-1",
      mode_id: modeId,
      run_id: "run-1",
      sample_id: "sample-1",
      stage_id: "stage-1",
    },
    normalization: "mode_global_max" as const,
    object_id: targetId.slice("object:".length),
    phase_rad: 0,
    representation: "phase_rotated_real" as const,
    target_id: targetId,
  };
}

describe("ModeCompositionController", () => {
  it("serializes independent target assignments and advances baseRevision from acknowledgements", async () => {
    const first = composition(1, { layers: [layer("object:a", "mode-a")] });
    const second = composition(2, {
      layers: [layer("object:a", "mode-a"), layer("object:b", "mode-b")],
    });
    const patchActive = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const client: ModeCompositionMutationClient = {
      getActiveModeComposition: vi.fn(),
      patchActiveModeComposition: patchActive,
    };
    const controller = new ModeCompositionController(client);
    controller.acceptResource(composition(0));

    await Promise.all([
      controller.assign(layer("object:a", "mode-a")),
      controller.assign(layer("object:b", "mode-b")),
    ]);

    expect(patchActive).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ base_revision: 0 }),
    );
    expect(patchActive).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ base_revision: 1 }),
    );
    expect(controller.getSnapshot().resource).toEqual(second);
  });

  it("keeps optimistic target A and B isolated while a patch is pending", async () => {
    let resolvePatch: ((value: ModeCompositionResource) => void) | undefined;
    const client: ModeCompositionMutationClient = {
      getActiveModeComposition: vi.fn(),
      patchActiveModeComposition: vi.fn(
        () =>
          new Promise<ModeCompositionResource>((resolve) => {
            resolvePatch = resolve;
          }),
      ),
    };
    const controller = new ModeCompositionController(client);
    controller.acceptResource(composition(0));

    const pending = controller.assign(layer("object:a", "mode-a"));

    await vi.waitFor(() => {
      expect(resolvePatch).toBeTypeOf("function");
    });

    expect(controller.getSnapshot()).toMatchObject({
      pending_target_ids: ["object:a"],
      resource: { layers: [expect.objectContaining({ target_id: "object:a" })] },
      status: "stale",
    });
    resolvePatch?.(composition(1, { layers: [layer("object:a", "mode-a")] }));
    await pending;
    expect(controller.getSnapshot().pending_target_ids).toEqual([]);
  });

  it("rejects a stale response after an external lifecycle reset and preserves reset resource", async () => {
    let resolvePatch: ((value: ModeCompositionResource) => void) | undefined;
    const client: ModeCompositionMutationClient = {
      getActiveModeComposition: vi.fn(),
      patchActiveModeComposition: vi.fn(
        () =>
          new Promise<ModeCompositionResource>((resolve) => {
            resolvePatch = resolve;
          }),
      ),
    };
    const controller = new ModeCompositionController(client);
    controller.acceptResource(composition(4));
    const pending = controller.assign(layer("object:a", "mode-a"));

    const reset = composition(5, {
      artifact_revision: "artifact-2",
      lifecycle: {
        artifact_revision: 2,
        mesh_revision: 5,
        run_id: "run-2",
        session_id: "session-1",
      },
      layers: [],
      run_id: "run-2",
      stage_id: "stage-2",
    });
    controller.acceptResource(reset);
    resolvePatch?.(composition(5, { layers: [layer("object:a", "mode-a")] }));

    await expect(pending).rejects.toMatchObject({
      reasonCode: "mode_composition_lifecycle_reset",
    });
    expect(controller.getSnapshot()).toMatchObject({
      pending_target_ids: [],
      resource: reset,
      status: "ready",
    });
  });

  it("retries a revision conflict only when the refetched target is unchanged", async () => {
    const expected = composition(3, { layers: [layer("object:a", "mode-a")] });
    const client: ModeCompositionMutationClient = {
      getActiveModeComposition: vi.fn().mockResolvedValue(composition(2)),
      patchActiveModeComposition: vi.fn()
        .mockRejectedValueOnce(
          new Error("mode_composition_revision_conflict: expected 1, received 0"),
        )
        .mockResolvedValueOnce(expected),
    };
    const controller = new ModeCompositionController(client);
    controller.acceptResource(composition(0));

    await expect(controller.assign(layer("object:a", "mode-a"))).resolves.toEqual(expected);
    expect(client.getActiveModeComposition).toHaveBeenCalledTimes(1);
    expect(client.patchActiveModeComposition).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ base_revision: 2 }),
    );
  });

  it("does not retry a revision conflict when the same target changed remotely", async () => {
    const client: ModeCompositionMutationClient = {
      getActiveModeComposition: vi.fn().mockResolvedValue(
        composition(2, { layers: [layer("object:a", "remote-mode")] }),
      ),
      patchActiveModeComposition: vi.fn().mockRejectedValue(
        new Error("mode_composition_revision_conflict: expected 1, received 0"),
      ),
    };
    const controller = new ModeCompositionController(client);
    controller.acceptResource(composition(0));

    await expect(controller.assign(layer("object:a", "mode-a"))).rejects.toMatchObject({
      reasonCode: "mode_composition_revision_conflict",
    });
    expect(client.patchActiveModeComposition).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot()).toMatchObject({
      resource: composition(2, { layers: [layer("object:a", "remote-mode")] }),
      status: "error",
    });
  });
});
