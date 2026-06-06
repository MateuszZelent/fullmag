import { describe, expect, it } from "vitest";

import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";

import {
  isMeshBuildConfirmCommandId,
  requestMeshBuildConfirmation,
} from "./meshBuildConfirmation";

describe("mesh build confirmation", () => {
  it("recognizes only mesh build commands as confirmation-gated", () => {
    expect(isMeshBuildConfirmCommandId("mesh.build-selected")).toBe(true);
    expect(isMeshBuildConfirmCommandId("mesh.build-shared-domain")).toBe(true);
    expect(isMeshBuildConfirmCommandId("mesh.open-builds")).toBe(false);
  });

  it("emits a confirmation request without executing a command", () => {
    const bus = new EventBus<KernelEventMap>();
    const requests: KernelEventMap["mesh:build-confirm-requested"][] = [];
    bus.on("mesh:build-confirm-requested", (request) => requests.push(request));

    requestMeshBuildConfirmation(bus, {
      commandId: "mesh.build-shared-domain",
      source: "ribbon",
      sourceDetail: "ribbon-action",
    });

    expect(requests).toEqual([
      {
        commandId: "mesh.build-shared-domain",
        source: "ribbon",
        sourceDetail: "ribbon-action",
      },
    ]);
  });
});
