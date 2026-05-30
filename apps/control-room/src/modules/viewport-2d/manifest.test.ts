import { describe, expect, it } from "vitest";

import type { CommandContribution } from "@/kernel/commands/commandTypes";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { LayoutController } from "@/kernel/layout/LayoutController";
import { ALL_MODULES } from "@/modules";

import { viewport2dManifest } from "./manifest";

describe("viewport2dManifest", () => {
  it("registers the 2D cross-section module in the auxiliary viewport slot", () => {
    expect(viewport2dManifest).toMatchObject({
      id: "viewport-2d",
      slots: ["viewport-aux"],
      title: "2D Cross-Section",
    });
    expect(ALL_MODULES.map((manifest) => manifest.id)).toContain("viewport-2d");
  });

  it("focuses the auxiliary viewport and emits a real fit request", async () => {
    const bus = new EventBus<KernelEventMap>();
    const layout = new LayoutController(bus);
    const fitCommand = command("viewport-2d.fit");
    const fitRequests: KernelEventMap["viewport-2d:fit-requested"][] = [];
    bus.on("viewport-2d:fit-requested", (event) => fitRequests.push(event));

    const result = await fitCommand.run({
      bus,
      layout,
      source: "test",
    });

    expect(result).toEqual({ status: "completed" });
    expect(layout.get().focusedSlot).toBe("viewport-aux");
    expect(fitRequests).toEqual([{ source: "command" }]);
  });

  it("toggles focus between the 2D auxiliary viewport and main viewport", async () => {
    const bus = new EventBus<KernelEventMap>();
    const layout = new LayoutController(bus);
    const toggleCommand = command("viewport-2d.toggle");

    const firstResult = await toggleCommand.run({ layout, source: "test" });
    expect(firstResult).toEqual({ status: "completed" });
    expect(layout.get().focusedSlot).toBe("viewport-aux");
    expect(toggleCommand.isActive?.({ layout, source: "test" })).toBe(true);

    const secondResult = await toggleCommand.run({ layout, source: "test" });
    expect(secondResult).toEqual({ status: "completed" });
    expect(layout.get().focusedSlot).toBe("viewport-main");
    expect(toggleCommand.isActive?.({ layout, source: "test" })).toBe(false);
  });
});

function command(id: string): CommandContribution {
  const match = viewport2dManifest.contributes?.commands?.find(
    (entry) => entry.id === id,
  );
  if (!match) throw new Error(`Missing command: ${id}`);
  return match;
}
