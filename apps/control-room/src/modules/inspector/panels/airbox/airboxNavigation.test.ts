import { describe, expect, it } from "vitest";

import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { SelectionController } from "@/kernel/selection/SelectionController";

import { navigateToAirboxRoute, navigateToStudyRoot } from "./airboxNavigation";

describe("Airbox Inspector navigation", () => {
  it("routes overview actions through the selection controller", () => {
    const selection = new SelectionController(new EventBus<KernelEventMap>());

    navigateToAirboxRoute(selection, "meshParameters");

    expect(selection.get()).toMatchObject({
      kind: "airbox.mesh.parameters",
      moduleSource: "inspector",
      nodeId: "model:airbox:mesh:parameters",
      ref: { type: "airbox", visualizationTargetId: "airbox" },
    });
  });

  it("keeps dirty-selection guards in force for Airbox and Study routes", () => {
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    selection.set({ kind: "airbox.root", label: "Airbox", nodeId: "model:airbox" }, "explorer");
    selection.addChangeGuard(() => false);

    navigateToAirboxRoute(selection, "meshBuild");
    expect(selection.get().nodeId).toBe("model:airbox");

    navigateToStudyRoot(selection);
    expect(selection.get().nodeId).toBe("model:airbox");
  });
});
