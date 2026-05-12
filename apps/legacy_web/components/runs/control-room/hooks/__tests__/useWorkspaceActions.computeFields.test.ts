import { describe, expect, it, vi } from "vitest";

import { syncSceneBeforeComputeFields } from "../useWorkspaceActions";
import type { ControlRoomApi } from "../../controlRoomApi";
import type { MagnetizationAsset, SceneDocument } from "@/lib/session/types";

function asset(kind: string): MagnetizationAsset {
  return {
    id: "mag:free",
    name: "free magnetization",
    kind: "preset_texture",
    value: null,
    seed: null,
    source_path: null,
    source_format: null,
    dataset: null,
    sample_index: null,
    mapping: {
      space: "object",
      projection: "object_local",
      clamp_mode: "none",
    },
    texture_transform: {
      translation: [0, 0, 0],
      rotation_quat: [0, 0, 0, 1],
      scale: [1, 1, 1],
      pivot: [0, 0, 0],
    },
    preset_kind: kind,
    preset_params: kind === "vortex" ? { circulation: 1, core_polarity: 1, plane: "xy" } : {},
    preset_version: 1,
    ui_label: kind,
  };
}

function scene(kind: string): SceneDocument {
  const magnetization = asset(kind);
  return {
    objects: [
      {
        id: "free",
        name: "free",
        magnetization_ref: magnetization.id,
      },
    ],
    magnetization_assets: [magnetization],
  } as unknown as SceneDocument;
}

function makeArgs(overrides: {
  localScene?: SceneDocument | null;
  remoteScene?: SceneDocument | null;
  updateSceneDocument?: ReturnType<typeof vi.fn>;
}) {
  const calls: string[] = [];
  const localScene = overrides.localScene ?? scene("vortex");
  const committedScene = { ...localScene, revision: 2 } as SceneDocument;
  const updateSceneDocument =
    overrides.updateSceneDocument ??
    vi.fn(async () => {
      calls.push("updateSceneDocument");
      return committedScene;
    });
  return {
    calls,
    committedScene,
    args: {
      localScene,
      remoteScene: overrides.remoteScene ?? scene("uniform"),
      liveApi: {
        updateSceneDocument,
      } as unknown as ControlRoomApi,
      refreshLiveState: vi.fn(async () => {
        calls.push("refreshLiveState");
      }),
      setSceneDocument: vi.fn(() => {
        calls.push("setSceneDocument");
      }),
      setCommandErrorMessage: vi.fn(),
      setPreviewMessage: vi.fn(),
      appendFrontendTrace: vi.fn(),
    },
  };
}

describe("syncSceneBeforeComputeFields", () => {
  it("syncs dirty magnetic texture before compute fields can start", async () => {
    const { args, calls, committedScene } = makeArgs({});

    await expect(syncSceneBeforeComputeFields(args)).resolves.toBe(true);

    expect(args.liveApi.updateSceneDocument).toHaveBeenCalledWith(args.localScene);
    expect(args.setSceneDocument).toHaveBeenCalledWith(committedScene);
    expect(calls).toEqual(["updateSceneDocument", "setSceneDocument", "refreshLiveState"]);
    expect(args.setCommandErrorMessage).toHaveBeenCalledWith(null);
  });

  it("skips sync when local and remote magnetic texture state already match", async () => {
    const sameScene = scene("vortex");
    const { args } = makeArgs({
      localScene: sameScene,
      remoteScene: sameScene,
    });

    await expect(syncSceneBeforeComputeFields(args)).resolves.toBe(true);

    expect(args.liveApi.updateSceneDocument).not.toHaveBeenCalled();
    expect(args.refreshLiveState).not.toHaveBeenCalled();
  });

  it("blocks compute fields when magnetic texture sync fails", async () => {
    const { args } = makeArgs({
      updateSceneDocument: vi.fn(async () => {
        throw new Error("backend rejected scene");
      }),
    });

    await expect(syncSceneBeforeComputeFields(args)).resolves.toBe(false);

    expect(args.refreshLiveState).not.toHaveBeenCalled();
    expect(args.setCommandErrorMessage).toHaveBeenCalledWith(
      "Compute fields blocked: magnetic texture sync failed: backend rejected scene",
    );
  });
});
