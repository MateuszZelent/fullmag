import { describe, expect, it, vi } from "vitest";

import type { CommandContext } from "../commands/commandTypes";
import { GEOMETRY_LIFECYCLE_COMMANDS } from "./geometryLifecycleCommandContributions";
import { stlScaleToSi, validateStlImport } from "./importedStlImport";

const stlBytes = new Uint8Array([115, 111, 108, 105, 100, 10]);
const stlFile = {
  name: "part.stl",
  size: stlBytes.byteLength,
  arrayBuffer: vi.fn(async () => stlBytes.buffer),
};
const digest = "a".repeat(64);
const before = {
  magnetization_assets: [{ asset_id: "existing-magnetization" }],
  materials: [{ material_id: "existing-material" }],
  objects: [{ object_id: "existing", name: "Existing object", geometry: { geometry_kind: "Sphere" } }],
  revision: 10,
};
const after = { objects: [...before.objects, { object_id: "stl-test", name: "part" }], revision: 11 };

function setup(options: {
  assetImport?: ReturnType<typeof vi.fn>;
  commitTransaction?: ReturnType<typeof vi.fn>;
  scale?: number;
} = {}) {
  const assetImport = options.assetImport ?? vi.fn(async () => ({
    asset_id: "asset-1",
    content_sha256: digest,
    stored_path: "/session/assets/part.stl",
  }));
  const commitTransaction = options.commitTransaction ?? vi.fn(async () => ({
    committed_scene: after,
    scene_revision: 11,
    transaction_kind: "create_object",
  }));
  const selection = { get: vi.fn(() => null), set: vi.fn() };
  const invalidate = vi.fn();
  const record = vi.fn();
  const command = GEOMETRY_LIFECYCLE_COMMANDS.find((entry) => entry.id === "geometry.import-stl");
  if (!command) throw new Error("STL import command is not registered.");
  const context = {
    api: {
      model: { scene: vi.fn(async () => before), commitTransaction },
      persistence: { assets: { import: assetImport } },
    },
    authoringHistory: { getGeneration: () => 1, record },
    input: { file: stlFile, scale: options.scale ?? 0.5, units: "mm" },
    isCurrentSessionScope: () => true,
    resources: { invalidate },
    selection,
    sessionScopeKey: "session-1",
    source: "test",
  } as unknown as CommandContext;
  return { assetImport, command, commitTransaction, context, invalidate, record, selection };
}

describe("geometry.import-stl", () => {
  it("uploads the original asset and adds an explicit, scaled surface to the existing scene", async () => {
    const state = setup();
    const result = await state.command.run(state.context);

    expect(result.status).toBe("completed");
    expect(state.assetImport).toHaveBeenCalledWith({
      content_base64: "c29saWQK",
      file_name: "part.stl",
      target_realization: "geometry",
    }, { sessionScopeKey: "session-1" });
    expect(state.commitTransaction).toHaveBeenCalledWith({
      base_revision: 10,
      geometry: {
        geometry_kind: "ImportedGeometry",
        geometry_params: {
          format: "stl",
          scale: 0.0005,
          source: "/session/assets/part.stl",
        },
        source_asset: {
          archive_path: "project/assets/" + digest + ".stl",
          asset_id: "asset-1",
          content_sha256: digest,
        },
      },
      kind: "create_object",
      magnetization_ref: "",
      material_ref: "",
      name: "part",
      object_id: expect.any(String),
      transform: { rotation_quat: [0, 0, 0, 1], scale: [1, 1, 1], translation: [0, 0, 0] },
    }, { sessionScopeKey: "session-1" });
    const transaction = state.commitTransaction.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(transaction).toHaveProperty("material_ref", "");
    expect(transaction).toHaveProperty("magnetization_ref", "");
    expect(transaction).not.toHaveProperty("material_asset");
    expect(transaction).not.toHaveProperty("magnetization_asset");
    expect(state.selection.set).toHaveBeenCalled();
    expect(state.record).toHaveBeenCalled();
    expect(state.invalidate).toHaveBeenCalled();
    expect(before.objects).toHaveLength(1);
    expect(before.materials).toEqual([{ material_id: "existing-material" }]);
    expect(before.magnetization_assets).toEqual([{ asset_id: "existing-magnetization" }]);
  });

  it("leaves the scene unchanged when the asset service rejects malformed STL", async () => {
    const assetImport = vi.fn(async () => {
      throw new Error("The uploaded STL is malformed.");
    });
    const state = setup({ assetImport });

    const result = await state.command.run(state.context);

    expect(result).toMatchObject({ status: "failed", message: "The uploaded STL is malformed." });
    expect(state.commitTransaction).not.toHaveBeenCalled();
    expect(state.selection.set).not.toHaveBeenCalled();
  });

  it("reports a failed scene transaction after asset upload without selecting an object", async () => {
    const commitTransaction = vi.fn(async () => {
      throw new Error("revision conflict");
    });
    const state = setup({ commitTransaction });

    const result = await state.command.run(state.context);

    expect(state.assetImport).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "failed",
      message: expect.stringContaining("asset was uploaded, but the scene object could not be created"),
    });
    expect(state.selection.set).not.toHaveBeenCalled();
    expect(state.invalidate).not.toHaveBeenCalled();
  });

  it("rejects a non-positive scale before uploading", async () => {
    const state = setup({ scale: 0 });

    const result = await state.command.run(state.context);

    expect(result.status).toBe("failed");
    expect(state.assetImport).not.toHaveBeenCalled();
    expect(state.commitTransaction).not.toHaveBeenCalled();
  });

  it("converts supported coordinate units to SI and rejects underflow", () => {
    expect(stlScaleToSi(0.5, "mm")).toBe(0.0005);
    expect(stlScaleToSi(2, "um")).toBe(2e-6);
    expect(stlScaleToSi(Number.MIN_VALUE, "nm")).toBeNull();
    expect(validateStlImport("part.stl", 6, "nm", Number.MIN_VALUE))
      .toContain("finite, positive value in metres");
  });
});
