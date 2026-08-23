import { describe, expect, it, vi } from "vitest";

import { MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import { MODEL_READINESS_PATH } from "@/kernel/api/apiPaths";
import type { CommandContext } from "@/kernel/commands/commandTypes";

import { MAGNETIZATION_TEXTURE_COMMANDS } from "./commands";

const uniformCommand = MAGNETIZATION_TEXTURE_COMMANDS.find(
  (command) => command.id === "magnetization-texture.assign-uniform",
);
const activateLoadFileCommand = MAGNETIZATION_TEXTURE_COMMANDS.find(
  (command) => command.id === "magnetization-texture.activate-load-file",
);

describe("magnetization texture commands", () => {
  it("assigns a uniform texture to the selected region target", async () => {
    const patchMagnetizationAsset = vi.fn(async () => ({
      asset: { id: "mag:body:region:body:uniform" },
      scene_revision: 6,
    }));
    const patchRegion = vi.fn(async () => ({ revision: 7 }));
    const invalidate = vi.fn();
    const context = {
      api: {
        model: {
          patchMagnetizationAsset,
          patchRegion,
        },
      },
      resourceData: {
        [MODEL_SCENE_PATH]: { revision: 5 },
      },
      resources: { invalidate },
      selection: {
        get: () => ({
          kind: "object.region-magnetic-texture",
          label: "Magnetic Texture",
          moduleSource: "explorer",
          nodeId: "node-1",
          objectId: "body",
          ref: {
            kind: "object.region-magnetic-texture",
            nodeId: "node-1",
            objectId: "body",
            regionId: "region:body",
            type: "scene-object",
            visualizationTargetId: "object:body",
          },
        }),
      },
      source: "test",
    } as unknown as CommandContext;

    expect(uniformCommand?.isEnabled?.(context)).toBe(true);
    await expect(uniformCommand?.run(context)).resolves.toMatchObject({
      status: "completed",
    });

    expect(patchMagnetizationAsset).toHaveBeenCalledWith(
      "mag:body:region:body:uniform",
      expect.objectContaining({
        asset: expect.objectContaining({
          id: "mag:body:region:body:uniform",
          kind: "preset_texture",
          preset_kind: "uniform",
          preset_params: { direction: [1, 0, 0] },
        }),
        base_revision: 5,
      }),
    );
    expect(patchRegion).toHaveBeenCalledWith(
      "region:body",
      {
        magnetization_ref: "mag:body:region:body:uniform",
      },
    );
    expect(
      invalidate.mock.calls.filter(([resourceKey]) => resourceKey === MODEL_READINESS_PATH),
    ).toHaveLength(1);
  });

  it("disables assignment when no object or region target is selected", () => {
    const context = {
      selection: {
        get: () => ({
          kind: null,
          label: null,
          moduleSource: null,
          nodeId: null,
          objectId: null,
          ref: null,
        }),
      },
      source: "test",
    } as unknown as CommandContext;

    expect(uniformCommand?.isEnabled?.(context)).toBe(false);
    expect(uniformCommand?.disabledReason?.(context)).toBe(
      "Select an object or region texture target.",
    );
  });

  it("activates the object texture load node through the event bus", async () => {
    const emit = vi.fn();
    const context = {
      bus: { emit },
      selection: {
        get: () => ({
          kind: "object.magnetic-texture",
          label: "Magnetic Texture",
          moduleSource: "explorer",
          nodeId: "model:object:body:magnetic-texture",
          objectId: "body",
          ref: {
            kind: "object.magnetic-texture",
            nodeId: "model:object:body:magnetic-texture",
            objectId: "body",
            type: "scene-object",
            visualizationTargetId: "object:body",
          },
        }),
      },
      source: "inspector",
    } as unknown as CommandContext;

    expect(activateLoadFileCommand?.isEnabled?.(context)).toBe(true);
    expect(activateLoadFileCommand?.run(context)).toMatchObject({
      message: "Load texture node activated.",
      status: "completed",
    });
    expect(emit).toHaveBeenCalledWith("explorer:texture-load-node-requested", {
      objectId: "body",
      source: "inspector",
    });
  });

  it("does not activate texture file loading for region targets", () => {
    const context = {
      selection: {
        get: () => ({
          kind: "object.region-magnetic-texture",
          label: "Magnetic Texture",
          moduleSource: "explorer",
          nodeId: "node-1",
          objectId: "body",
          ref: {
            kind: "object.region-magnetic-texture",
            nodeId: "node-1",
            objectId: "body",
            regionId: "region:body",
            type: "scene-object",
            visualizationTargetId: "object:body",
          },
        }),
      },
      source: "test",
    } as unknown as CommandContext;

    expect(activateLoadFileCommand?.isEnabled?.(context)).toBe(false);
    expect(activateLoadFileCommand?.disabledReason?.(context)).toBe(
      "Field-state texture loading is available on object texture targets.",
    );
  });
});
