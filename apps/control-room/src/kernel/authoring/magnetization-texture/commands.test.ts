import { describe, expect, it, vi } from "vitest";

import { MODEL_READINESS_PATH, MODEL_SCENE_PATH } from "@/kernel/api/apiPaths";
import type { CommandContext } from "@/kernel/commands/commandTypes";
import { SESSION_STATUS_RESOURCE_KEY } from "@/kernel/resources/useSessionStatus";
import {
  getTextureDraftBridgeSnapshot,
  resetTextureDraftBridgeForTests,
} from "@/shared/domain/magnetization-texture/textureDraftBridge";
import { ALL_TAB_CONTENT } from "@/modules/ribbon/ribbonContributions";
import type { RibbonMenuNode } from "@/modules/ribbon/ribbonTypes";

import { MAGNETIZATION_TEXTURE_COMMANDS } from "./commands";

function findCommand(id: string) {
  const cmd = MAGNETIZATION_TEXTURE_COMMANDS.find((entry) => entry.id === id);
  if (!cmd) throw new Error(`Missing command ${id}`);
  return cmd;
}

const SCENE_WITH_REGION = {
  revision: 5,
  objects: [
    {
      id: "disk",
      name: "Disk",
      role: "magnet",
      magnetization_ref: "mag:disk:uniform",
      geometry: {
        geometry_kind: "Cylinder",
        geometry_params: { radius: 50e-9, height: 5e-9 },
      },
      regions: [
        {
          region_id: "ring",
          name: "Ring",
          enabled: true,
          priority: 10,
          shape: {
            kind: "cylinder",
            center: [0, 0, 0],
            radius: 40e-9,
            height: 5e-9,
          },
        },
      ],
    },
    {
      id: "cpw",
      name: "CPW",
      role: "antenna",
    },
  ],
};

describe("magnetization texture Ribbon commands (atomic applyMagnetization, zero patchRegion)", () => {
  it("assigns bloch_skyrmion atomically to the selected object.region via applyMagnetization with zero patchRegion calls", async () => {
    const blochSkyrmionCmd = findCommand("magnetization-texture.assign-bloch-skyrmion");
    const applyMagnetization = vi.fn(async () => ({
      committed_scene: { ...SCENE_WITH_REGION, revision: 6 },
      magnetization_apply: {
        operation_id: "op-reg-1",
        scene_revision: 6,
        scopes: [{ object_id: "disk", region_id: "ring" }],
        status: "initial_state_ready",
      },
      scene_revision: 6,
    }));
    const patchRegion = vi.fn();
    const patchMagnetizationAsset = vi.fn();
    const syncAuthoringScript = vi.fn(async () => ({}));
    const invalidate = vi.fn();
    const sessionScopeKey = "session=A&epoch=A%401&request_scope_epoch=api%3A1";

    const context = {
      api: {
        model: {
          applyMagnetization,
          patchMagnetizationAsset,
          patchRegion,
          scene: vi.fn(async () => SCENE_WITH_REGION),
          syncAuthoringScript,
        },
      },
      authoringHistory: {
        getGeneration: () => 1,
        record: vi.fn(),
      },
      resourceData: {
        [MODEL_SCENE_PATH]: SCENE_WITH_REGION,
      },
      resources: { invalidate },
      sessionScopeKey,
      isCurrentSessionScope: () => true,
      selection: {
        get: () => ({
          kind: "object.region",
          label: "Ring",
          moduleSource: "explorer",
          nodeId: "model:object:disk:region:ring",
          objectId: "disk",
          ref: {
            kind: "object.region",
            nodeId: "model:object:disk:region:ring",
            objectId: "disk",
            regionId: "ring",
            type: "scene-object",
            visualizationTargetId: "region:disk:ring",
          },
        }),
      },
      source: "ribbon",
    } as unknown as CommandContext;

    expect(blochSkyrmionCmd.isEnabled?.(context)).toBe(true);
    await expect(blochSkyrmionCmd.run(context)).resolves.toMatchObject({
      status: "completed",
    });

    expect(patchRegion).not.toHaveBeenCalled();
    expect(patchMagnetizationAsset).not.toHaveBeenCalled();
    expect(applyMagnetization).toHaveBeenCalledTimes(1);
    expect(applyMagnetization).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "region",
        object_id: "disk",
        region_id: "ring",
        texture_override: {
          initial_magnetization: expect.objectContaining({
            kind: "preset_texture",
            preset_kind: "bloch_skyrmion",
            preset_version: 2,
            // Relative to 80 nm diameter ring: radius = 0.25 * 80 nm = 20 nm
            preset_params: expect.objectContaining({
              radius: 20e-9,
              wall_width: 4e-9,
            }),
            mapping: expect.objectContaining({
              space: "region",
              clamp_mode: "none",
            }),
            texture_transform: expect.objectContaining({
              scale: [1, 1, 1],
            }),
          }),
        },
      }),
      expect.objectContaining({ baseRevision: 5, sessionScopeKey }),
    );
    expect(invalidate).toHaveBeenCalledWith(MODEL_READINESS_PATH, 6);
    expect(invalidate).toHaveBeenCalledWith(SESSION_STATUS_RESOURCE_KEY, 6);
  });

  it("assigns relative-sized helical texture to a magnetic object with ui_label: null", async () => {
    const helicalCmd = findCommand("magnetization-texture.assign-helical");
    const applyMagnetization = vi.fn(async () => ({
      committed_scene: { ...SCENE_WITH_REGION, revision: 6 },
      magnetization_apply: {
        operation_id: "op-obj-1",
        scene_revision: 6,
        scopes: [{ object_id: "disk", region_id: null }],
        status: "initial_state_ready",
      },
      scene_revision: 6,
    }));
    const sessionScopeKey = "session=A&epoch=A%401&request_scope_epoch=api%3A1";
    const context = {
      api: {
        model: {
          applyMagnetization,
          scene: vi.fn(async () => SCENE_WITH_REGION),
          syncAuthoringScript: vi.fn(async () => ({})),
        },
      },
      resourceData: { [MODEL_SCENE_PATH]: SCENE_WITH_REGION },
      resources: { invalidate: vi.fn() },
      sessionScopeKey,
      isCurrentSessionScope: () => true,
      selection: {
        get: () => ({
          kind: "object.magnetic-texture",
          objectId: "disk",
          ref: {
            kind: "object.magnetic-texture",
            objectId: "disk",
            type: "scene-object",
          },
        }),
      },
      source: "ribbon",
    } as unknown as CommandContext;

    await expect(helicalCmd.run(context)).resolves.toMatchObject({
      status: "completed",
    });

    expect(applyMagnetization).toHaveBeenCalledTimes(1);
    const [targetPayload] = applyMagnetization.mock.calls[0]!;
    expect(targetPayload).toMatchObject({
      kind: "object",
      object_id: "disk",
      asset: {
        id: "mag:disk:helical",
        kind: "preset_texture",
        preset_kind: "helical",
        preset_version: 2,
        ui_label: null,
      },
    });
    const q = (targetPayload as { asset: { preset_params: { wavevector: number[] } } }).asset
      .preset_params.wavevector;
    expect(Math.hypot(q[0]!, q[1]!, q[2]!)).toBeCloseTo((2 * Math.PI) / 50e-9, 2);
  });

  it("disables preset commands for non-magnetic antenna objects and registers all 20 preset commands", () => {
    const uniformCmd = findCommand("magnetization-texture.assign-uniform");
    const antennaContext = {
      api: { model: {} },
      resourceData: { [MODEL_SCENE_PATH]: SCENE_WITH_REGION },
      selection: {
        get: () => ({
          kind: "object.root",
          objectId: "cpw",
          ref: { kind: "object.root", objectId: "cpw", type: "scene-object" },
        }),
      },
      source: "ribbon",
    } as unknown as CommandContext;

    expect(uniformCmd.isEnabled?.(antennaContext)).toBe(false);
    expect(uniformCmd.disabledReason?.(antennaContext)).toContain("non-magnetic");

    for (const id of [
      "magnetization-texture.assign-uniform",
      "magnetization-texture.assign-random-seeded",
      "magnetization-texture.assign-vortex",
      "magnetization-texture.assign-antivortex",
      "magnetization-texture.assign-bloch-skyrmion",
      "magnetization-texture.assign-neel-skyrmion",
      "magnetization-texture.assign-antiskyrmion",
      "magnetization-texture.assign-skyrmionium",
      "magnetization-texture.assign-bimeron",
      "magnetization-texture.assign-skyrmion-lattice",
      "magnetization-texture.assign-domain-wall",
      "magnetization-texture.assign-two-domain",
      "magnetization-texture.assign-vortex-wall",
      "magnetization-texture.assign-artificial-spin-ice",
      "magnetization-texture.assign-helical",
      "magnetization-texture.assign-conical",
      "magnetization-texture.assign-spiral",
      "magnetization-texture.assign-hopfion",
      "magnetization-texture.assign-hopfion-compact-support",
      "magnetization-texture.assign-bloch-point",
    ]) {
      expect(findCommand(id)).toBeDefined();
    }
  });

  it("switches the Inspector tab to field-file via textureDraftBridge without ephemeral Explorer nodes", () => {
    resetTextureDraftBridgeForTests();
    const activateLoadFileCmd = findCommand("magnetization-texture.activate-load-file");
    const context = {
      api: { model: {} },
      resourceData: { [MODEL_SCENE_PATH]: SCENE_WITH_REGION },
      selection: {
        get: () => ({
          kind: "object.magnetic-texture",
          objectId: "disk",
          ref: { kind: "object.magnetic-texture", objectId: "disk", type: "scene-object" },
        }),
      },
      source: "inspector",
    } as unknown as CommandContext;

    expect(activateLoadFileCmd.isEnabled?.(context)).toBe(true);
    expect(activateLoadFileCmd.run(context)).toMatchObject({
      status: "completed",
    });
    expect(getTextureDraftBridgeSnapshot().tabRequest).toMatchObject({
      targetKey: "object:disk",
      tabId: "field-file",
    });
  });

  it("registers every magnetization-texture.* commandId referenced in Ribbon materialsTab (including gizmo-mode-view)", () => {
    const registeredIds = new Set(MAGNETIZATION_TEXTURE_COMMANDS.map((cmd) => cmd.id));
    const ribbonCommandIds = new Set<string>();

    const collectMenuCommands = (nodes: readonly RibbonMenuNode[] | undefined) => {
      if (!nodes) return;
      for (const node of nodes) {
        if ("commandId" in node && typeof node.commandId === "string") {
          if (node.commandId.startsWith("magnetization-texture.")) {
            ribbonCommandIds.add(node.commandId);
          }
        }
        if (node.type === "radio-group") {
          for (const item of node.items) {
            if (item.commandId?.startsWith("magnetization-texture.")) {
              ribbonCommandIds.add(item.commandId);
            }
          }
        }
        if (node.type === "submenu") {
          collectMenuCommands(node.nodes);
        }
      }
    };

    for (const group of ALL_TAB_CONTENT.materials.groups) {
      for (const action of group.actions) {
        const candidateId = action.commandId ?? action.id;
        if (candidateId.startsWith("magnetization-texture.")) {
          ribbonCommandIds.add(candidateId);
        }
        collectMenuCommands(action.menu);
      }
    }

    expect(ribbonCommandIds.has("magnetization-texture.gizmo-mode-view")).toBe(true);
    expect(ribbonCommandIds.size).toBeGreaterThanOrEqual(27);
    for (const cmdId of ribbonCommandIds) {
      expect(registeredIds.has(cmdId), `Unregistered Ribbon command: ${cmdId}`).toBe(true);
    }

    resetTextureDraftBridgeForTests();
    const viewCmd = findCommand("magnetization-texture.gizmo-mode-view");
    expect(viewCmd.run({} as CommandContext)).toMatchObject({ status: "completed" });
    expect(getTextureDraftBridgeSnapshot().gizmoEnabled).toBe(true);
    expect(getTextureDraftBridgeSnapshot().gizmoMode).toBe("view");
  });
});
