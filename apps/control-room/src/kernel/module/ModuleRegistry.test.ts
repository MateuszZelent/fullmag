import { describe, expect, it } from "vitest";

import { ModuleRegistry } from "./ModuleRegistry";
import type { ModuleManifest } from "../types";

function manifest(id: string, slot: ModuleManifest["slots"][number]): ModuleManifest {
  return {
    id,
    title: id,
    version: "1.0.0",
    slots: [slot],
    component: async () => ({ default: () => null }),
  };
}

describe("ModuleRegistry", () => {
  it("registers manifests by id and slot", () => {
    const registry = new ModuleRegistry();
    const explorer = manifest("explorer", "panel-left");

    registry.register(explorer);

    expect(registry.get("explorer")).toBe(explorer);
    expect(registry.forSlot("panel-left")).toEqual([explorer]);
    expect(registry.all()).toEqual([explorer]);
  });

  it("rejects duplicate module ids", () => {
    const registry = new ModuleRegistry();

    registry.register(manifest("explorer", "panel-left"));

    expect(() => registry.register(manifest("explorer", "panel-right"))).toThrow(
      'Module "explorer" is already registered.',
    );
  });
});
