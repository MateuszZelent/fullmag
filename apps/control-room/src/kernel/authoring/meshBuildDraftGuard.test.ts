import { describe, expect, it } from "vitest";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { awaitMeshBuildConfirmation, registerMeshBuildDraftGuard } from "./meshBuildConfirmation";

describe("mesh build draft guard", () => {
  it("does not request a build after failed Apply", async () => {
    const bus = new EventBus<KernelEventMap>();
    registerMeshBuildDraftGuard(bus, async () => false);
    const requests: unknown[] = [];
    bus.on("mesh:build-confirm-requested", (request) => requests.push(request));
    expect((await awaitMeshBuildConfirmation({ bus, source: "ribbon" }, "mesh.build-selected")).confirmed).toBe(false);
    expect(requests).toEqual([]);
  });
  it("waits for successful Apply and ignores unrelated confirmation", async () => {
    const bus = new EventBus<KernelEventMap>();
    let applied: ((ok: boolean) => void) | undefined;
    registerMeshBuildDraftGuard(bus, () => new Promise((resolve) => { applied = resolve; }));
    let requestId: string | undefined;
    bus.on("mesh:build-confirm-requested", (request) => { requestId = request.requestId; });
    const promise = awaitMeshBuildConfirmation({ bus, source: "palette" }, "mesh.build-selected");
    expect(requestId).toBeUndefined();
    applied?.(true);
    await Promise.resolve();
    expect(requestId).toBeDefined();
    bus.emit("mesh:build-confirm-resolved", { requestId: "unrelated", confirmed: true });
    bus.emit("mesh:build-confirm-resolved", { requestId: requestId!, confirmed: false });
    expect((await promise).confirmed).toBe(false);
  });
});