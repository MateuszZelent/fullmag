import { describe, expect, it } from "vitest";

import { activeLaneCapabilityFixture } from "./activeLaneCapabilityFixture.testSupport";
import {
  describeSessionAuthoringDiscretization,
  resolveSessionAuthoringDiscretization,
  hasSessionActiveLaneDeclaration,
  resolveSessionDiscretization,
  type SessionDiscretizationStatus,
} from "./sessionDiscretization";

describe("resolveSessionDiscretization", () => {
  it("detects nested or flat lane declarations by own-property presence", () => {
    expect(hasSessionActiveLaneDeclaration({ capabilities: { active_lane: null } }))
      .toBe(true);
    expect(
      hasSessionActiveLaneDeclaration({
        capabilities: { active_lane_discretization: null },
      }),
    ).toBe(true);
    expect(
      hasSessionActiveLaneDeclaration({
        capabilities: {},
        domain: { discretization: "fem" },
      }),
    ).toBe(false);
  });

  it("uses the resolved active lane ahead of a stale domain artifact", () => {
    const activeLane = activeLaneCapabilityFixture();

    expect(
      resolveSessionDiscretization({
        capabilities: {
          active_lane: {
            ...activeLane,
            resolved: { ...activeLane.resolved, discretization: "fem" },
          },
        },
        domain: { discretization: "fdm" },
      }),
    ).toBe("fem");
  });

  it.each([
    ["explicit null", { active_lane: null }],
    ["unresolved snapshot", { active_lane: { resolved: null } }],
    [
      "invalid resolved lane",
      { active_lane: { resolved: { discretization: "auto" } } },
    ],
  ] satisfies Array<
    [string, NonNullable<SessionDiscretizationStatus["capabilities"]>]
  >)(
    "does not fall back to DomainMeta for an %s active lane",
    (_label, capabilities) => {
      expect(
        resolveSessionDiscretization({
          capabilities,
          domain: { discretization: "fdm" },
        }),
      ).toBeNull();
    },
  );

  it("honors explicit unresolved flattened lane projections", () => {
    expect(
      resolveSessionDiscretization({
        capabilities: { active_lane_discretization: null },
        domainDiscretization: "fdm",
      }),
    ).toBeNull();
  });

  it("prefers the nested active-lane resolution over its flat projection", () => {
    expect(
      resolveSessionDiscretization({
        capabilities: {
          active_lane: {
            resolved: { discretization: "fem" },
          },
          active_lane_discretization: "fdm",
        },
        domainDiscretization: "fdm",
      }),
    ).toBe("fem");
  });

  it("uses the legacy domain only when active-lane data is absent", () => {
    expect(
      resolveSessionDiscretization({ domain: { discretization: "FEM" } }),
    ).toBe("fem");
    expect(
      resolveSessionDiscretization({ domainDiscretization: "fdm" }),
    ).toBe("fdm");
  });
});


describe("accepted model method", () => {
  it.each(["fem", "fdm"])("keeps authored %s editable without runtime resolution", (method) => {
    const status = { capabilities: { active_lane: { authored: { backend: method, discretization: method }, resolved: null } }, domain: { discretization: method === "fem" ? "fdm" : "fem" } };
    expect(resolveSessionAuthoringDiscretization(status)).toBe(method);
    expect(resolveSessionDiscretization(status)).toBeNull();
  });

  it("keeps current model FEM distinct from a retained FDM run", () => {
    const status = { capabilities: { active_lane: { authored: { backend: "fem", discretization: "fem" }, resolved: { discretization: "fdm" } } } };
    expect(resolveSessionAuthoringDiscretization(status)).toBe("fem");
    expect(resolveSessionDiscretization(status)).toBe("fdm");
  });

  it.each([null, { backend: "auto", discretization: "auto" }])("does not infer model method from runtime when authored is %j", (authored) => {
    expect(describeSessionAuthoringDiscretization({ capabilities: { active_lane: { authored, resolved: { discretization: "fem" } } }, domain: { discretization: "fdm" } })).toMatchObject({ method: null, state: "missing" });
  });

  it("distinguishes loading and conflicting published identity", () => {
    expect(describeSessionAuthoringDiscretization(null).state).toBe("loading");
    expect(describeSessionAuthoringDiscretization({ capabilities: { active_lane: { authored: { backend: "fem", discretization: "fdm" } } } })).toMatchObject({ method: null, state: "conflict" });
  });

  it("accepts explicit legacy backend identities without accepting arbitrary tokens", () => {
    expect(resolveSessionAuthoringDiscretization({ capabilities: { active_lane: { authored: { backend: "cpu-fem", discretization: "fem" } } } })).toBe("fem");
    expect(describeSessionAuthoringDiscretization({ capabilities: { active_lane: { authored: { backend: "mystery-fem", discretization: "fem" } } } }).state).toBe("conflict");
  });
});
