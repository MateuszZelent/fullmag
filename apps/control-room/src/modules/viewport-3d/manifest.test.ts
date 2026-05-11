import { describe, expect, it } from "vitest";

import { CommandRegistry } from "@/kernel/commands/CommandRegistry";
import { ALL_MODULES } from "@/modules";

import { viewport3dManifest } from "./manifest";
import { viewport3dStore } from "./viewport3dStore";
import { VIEWPORT_3D_FRAMELOOP } from "./viewport3dTypes";

describe("viewport3dManifest", () => {
  it("registers the 3D viewport as the viewport-main module", () => {
    expect(ALL_MODULES.find((manifest) => manifest.id === "viewport-3d"))
      .toBe(viewport3dManifest);
    expect(viewport3dManifest.slots).toContain("viewport-main");
    expect(viewport3dManifest.listens).toContain("resource:invalidated");
    expect(viewport3dManifest.emits).toContain("workspace:selection-changed");
  });

  it("contributes executable viewport camera commands", async () => {
    const registry = new CommandRegistry();
    for (const command of viewport3dManifest.contributes?.commands ?? []) {
      registry.register(command);
    }
    const before = viewport3dStore.getSnapshot();

    await expect(
      registry.execute("viewport-3d.fit", { source: "test" }),
    ).resolves.toMatchObject({ status: "completed" });
    await expect(
      registry.execute("viewport-3d.reset-camera", { source: "test" }),
    ).resolves.toMatchObject({ status: "completed" });

    expect(viewport3dStore.getSnapshot().fitRevision).toBe(
      before.fitRevision + 1,
    );
    expect(viewport3dStore.getSnapshot().resetCameraRevision).toBe(
      before.resetCameraRevision + 1,
    );
  });

  it("uses demand rendering instead of an always-on R3F loop", () => {
    expect(VIEWPORT_3D_FRAMELOOP).toBe("demand");
  });
});
