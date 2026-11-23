import { describe, expect, it } from "vitest";

import {
  createObjectMaterialMutationCoordinator,
  objectMaterialMutationScopeKey,
} from "./ObjectMaterialPanelEditSession";
import "./constraint/ObjectExtensionsSpecs.dom.test";

describe("ObjectMaterialPanelEditSession coordinator fence", () => {
  it("enforces exclusive mutation leases within one scope while isolating independent scopes", () => {
    const coordinator = createObjectMaterialMutationCoordinator();
    const scopeA = objectMaterialMutationScopeKey("session=A&epoch=1", "strip-1");
    const scopeB = objectMaterialMutationScopeKey("session=B&epoch=2", "strip-1");

    const leaseA = coordinator.acquire(scopeA, "patch-absorbing-boundary");
    expect(leaseA).not.toBeNull();
    expect(coordinator.acquire(scopeA, "concurrent-write")).toBeNull();
    expect(coordinator.getActive(scopeA)?.operation).toBe("patch-absorbing-boundary");
    expect(coordinator.getActive(scopeB)).toBeNull();

    const leaseB = coordinator.acquire(scopeB, "patch-absorbing-boundary");
    expect(leaseB).not.toBeNull();

    expect(coordinator.finish(leaseA!)).toBe(true);
    expect(coordinator.getActive(scopeA)).toBeNull();
    expect(coordinator.getActive(scopeB)).toEqual(leaseB);
    expect(coordinator.finish(leaseB!)).toBe(true);
  });
});
