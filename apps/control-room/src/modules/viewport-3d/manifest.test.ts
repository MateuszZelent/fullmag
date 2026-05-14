import { describe, expect, it } from "vitest";

import { CommandRegistry } from "@/kernel/commands/CommandRegistry";
import { ALL_MODULES } from "@/modules";

import { viewport3dManifest } from "./manifest";
import { viewport3dStore } from "./viewport3dStore";
import { VIEWPORT_3D_FRAMELOOP } from "./viewport3dTypes";

describe("viewport3dManifest", () => {
  function registerViewportCommands() {
    const registry = new CommandRegistry();
    for (const command of viewport3dManifest.contributes?.commands ?? []) {
      registry.register(command);
    }
    return registry;
  }

  it("registers the 3D viewport as the viewport-main module", () => {
    expect(ALL_MODULES.find((manifest) => manifest.id === "viewport-3d"))
      .toBe(viewport3dManifest);
    expect(viewport3dManifest.slots).toContain("viewport-main");
    expect(viewport3dManifest.listens).toContain("resource:invalidated");
    expect(viewport3dManifest.emits).toContain("workspace:selection-changed");
  });

  it("contributes executable viewport camera commands", async () => {
    viewport3dStore.resetForTest();
    const registry = registerViewportCommands();
    const before = viewport3dStore.getSnapshot();

    await expect(
      registry.execute("viewport-3d.fit", { source: "test" }),
    ).resolves.toMatchObject({ status: "completed" });
    await expect(
      registry.execute("viewport-3d.reset-camera", { source: "test" }),
    ).resolves.toMatchObject({ status: "completed" });
    await expect(
      registry.execute("viewport-3d.capture-frame", { source: "test" }),
    ).resolves.toMatchObject({ status: "completed" });

    expect(viewport3dStore.getSnapshot().fitRevision).toBe(
      before.fitRevision + 1,
    );
    expect(viewport3dStore.getSnapshot().resetCameraRevision).toBe(
      before.resetCameraRevision + 1,
    );
    expect(viewport3dStore.getSnapshot().captureRevision).toBe(
      before.captureRevision + 1,
    );
    expect(viewport3dStore.getSnapshot().visualProfileId).toBe("capture");
    expect(viewport3dStore.getSnapshot().captureReturnProfileId).toBe(
      "interactive",
    );
  });

  it("contributes orientation widget commands for ribbon and palette", async () => {
    viewport3dStore.resetForTest();
    const registry = registerViewportCommands();

    expect(registry.get("viewport-3d.toggle-viewcube")).toBeDefined();
    expect(registry.get("viewport-3d.hsl-reference-auto")).toBeDefined();
    expect(registry.get("viewport-3d.hsl-reference-on")).toBeDefined();
    expect(registry.get("viewport-3d.hsl-reference-off")).toBeDefined();
    expect(registry.get("viewport-3d.profile-figure")).toBeDefined();

    await registry.execute("viewport-3d.toggle-viewcube", { source: "test" });
    expect(viewport3dStore.getSnapshot().widgets.viewCubeVisible).toBe(false);
    expect(registry.isActive("viewport-3d.toggle-viewcube", { source: "test" }))
      .toBe(false);

    await registry.execute("viewport-3d.hsl-reference-on", { source: "test" });
    expect(viewport3dStore.getSnapshot().widgets.hslReferenceMode).toBe("on");
    expect(registry.isActive("viewport-3d.hsl-reference-on", { source: "test" }))
      .toBe(true);

    await registry.execute("viewport-3d.hsl-reference-off", { source: "test" });
    expect(viewport3dStore.getSnapshot().widgets.hslReferenceMode).toBe("off");
    expect(registry.isActive("viewport-3d.hsl-reference-off", { source: "test" }))
      .toBe(true);
  });

  it("contributes visual quality profile commands", async () => {
    viewport3dStore.resetForTest();
    const registry = registerViewportCommands();

    expect(viewport3dStore.getSnapshot().visualProfileId).toBe("interactive");

    await expect(
      registry.execute("viewport-3d.profile-figure", { source: "test" }),
    ).resolves.toMatchObject({ status: "completed" });

    expect(viewport3dStore.getSnapshot().visualProfileId).toBe("figure");
    expect(registry.isActive("viewport-3d.profile-figure", { source: "test" }))
      .toBe(true);
    expect(registry.isActive("viewport-3d.profile-interactive", { source: "test" }))
      .toBe(false);

    await registry.execute("viewport-3d.profile-capture", { source: "test" });
    expect(viewport3dStore.getSnapshot().visualProfileId).toBe("capture");
    expect(viewport3dStore.getSnapshot().captureReturnProfileId).toBeNull();
  });

  it("restores the previous visual profile after one-shot capture", async () => {
    viewport3dStore.resetForTest();
    const registry = registerViewportCommands();

    await registry.execute("viewport-3d.profile-figure", { source: "test" });
    await registry.execute("viewport-3d.capture-frame", { source: "test" });

    expect(viewport3dStore.getSnapshot().visualProfileId).toBe("capture");
    expect(viewport3dStore.getSnapshot().captureReturnProfileId).toBe("figure");

    viewport3dStore.completeCapture();

    expect(viewport3dStore.getSnapshot().visualProfileId).toBe("figure");
    expect(viewport3dStore.getSnapshot().captureReturnProfileId).toBeNull();

    await registry.execute("viewport-3d.profile-capture", { source: "test" });
    await registry.execute("viewport-3d.capture-frame", { source: "test" });
    viewport3dStore.completeCapture();

    expect(viewport3dStore.getSnapshot().visualProfileId).toBe("capture");
    expect(viewport3dStore.getSnapshot().captureReturnProfileId).toBeNull();
  });

  it("uses demand rendering instead of an always-on R3F loop", () => {
    expect(VIEWPORT_3D_FRAMELOOP).toBe("demand");
  });
});
