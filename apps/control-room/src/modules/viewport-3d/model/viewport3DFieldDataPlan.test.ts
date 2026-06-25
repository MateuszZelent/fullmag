import { describe, expect, it } from "vitest";

import {
  DEFAULT_OBJECT_VISUALIZATION,
  type VisualizationTargetSettings,
} from "@/kernel/visualization/ObjectVisualizationController";

import {
  buildViewport3DFieldResourceRequestId,
  buildViewport3DPassDemands,
  buildViewport3DTargetRenderPlan,
  mergeViewport3DFieldVectorQueries,
  planViewport3DFieldResourceRequests,
  resolveViewport3DScalarComponentRequest,
  resolveViewport3DScopedFieldQuery,
  resolveViewport3DTargetFieldQuery,
  type Viewport3DTargetRenderPlan,
} from "./viewport3DFieldDataPlan";

function objectPlan(
  targetId: string,
  patch: Partial<VisualizationTargetSettings>,
): Viewport3DTargetRenderPlan {
  const settings: VisualizationTargetSettings = {
    ...DEFAULT_OBJECT_VISUALIZATION,
    ...patch,
  };
  return buildViewport3DTargetRenderPlan({
    label: targetId,
    quantityId: settings.activeQuantityId,
    settings,
    targetId,
    targetKind: "object",
  });
}

describe("viewport3DFieldDataPlan", () => {
  it("keeps solid-only targets out of the field data plan", () => {
    const plan = objectPlan("object:solid", {
      surfaceColorSource: "solid",
      vectorsVisible: false,
    });

    expect(buildViewport3DPassDemands(plan)).toEqual([]);
    expect(planViewport3DFieldResourceRequests(buildViewport3DPassDemands(plan)))
      .toEqual([]);
  });

  it("uses scalar component data for component surfaces without vectors", () => {
    expect(
      resolveViewport3DTargetFieldQuery({
        surfaceColorMode: "x",
        vectorsVisible: false,
      }),
    ).toEqual({
      component: "x",
      scope_kind: "full",
    });

    const plan = objectPlan("object:mx", {
      surfaceColorSource: "component_x",
      vectorsVisible: false,
    });
    const requests = planViewport3DFieldResourceRequests(
      buildViewport3DPassDemands(plan),
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      query: {
        component: "x",
        scope_id: "object:mx",
        scope_kind: "object",
      },
      quantityId: "m",
    });
  });

  it("upgrades component surfaces with vectors to one complete full-vector request", () => {
    const plan = objectPlan("object:mx-vectors", {
      surfaceColorSource: "component_x",
      vectorBudget: 512,
      vectorsVisible: true,
    });
    const demands = buildViewport3DPassDemands(plan, { maxSamples: 512 });
    const requests = planViewport3DFieldResourceRequests(demands);

    expect(demands.map((demand) => demand.passKind).sort()).toEqual([
      "surface",
      "vector-glyph",
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      consumers: [
        "object:mx-vectors:surface",
        "object:mx-vectors:vector-glyph",
      ],
      query: {
        component: "full",
        scope_id: "object:mx-vectors",
        scope_kind: "object",
      },
      quantityId: "m",
    });
    expect(requests[0]?.query).not.toHaveProperty("max_samples");
  });

  it("allows sampled full-vector requests for vector-only targets", () => {
    const plan = objectPlan("object:vectors", {
      shaderVisible: false,
      vectorBudget: 256,
      vectorsVisible: true,
    });
    const requests = planViewport3DFieldResourceRequests(
      buildViewport3DPassDemands(plan, { maxSamples: 128 }),
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      query: {
        component: "full",
        max_samples: 128,
        scope_id: "object:vectors",
        scope_kind: "object",
      },
    });
  });

  it("keeps orientation surfaces on complete full-vector data", () => {
    const plan = objectPlan("object:orientation", {
      surfaceColorSource: "orientation",
      vectorsVisible: false,
    });
    const requests = planViewport3DFieldResourceRequests(
      buildViewport3DPassDemands(plan),
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      query: {
        component: "full",
        scope_id: "object:orientation",
        scope_kind: "object",
      },
    });
  });

  it("does not create a second equivalent request for viewport colorbars", () => {
    const plan = objectPlan("object:colorbar", {
      surfaceColorSource: "component_y",
      viewportColorbarVisible: true,
      vectorsVisible: false,
    });
    const demands = buildViewport3DPassDemands(plan);
    const requests = planViewport3DFieldResourceRequests(demands);

    expect(demands.map((demand) => demand.passKind).sort()).toEqual([
      "colorbar",
      "surface",
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.consumers).toEqual([
      "object:colorbar:colorbar",
      "object:colorbar:surface",
    ]);
    expect(requests[0]?.query).toMatchObject({
      component: "y",
      scope_id: "object:colorbar",
      scope_kind: "object",
    });
  });

  it("treats multiple scalar component demands for one target as full-vector demand", () => {
    expect(
      mergeViewport3DFieldVectorQueries(
        { component: "x", scope_kind: "full" },
        { component: "y", scope_kind: "full" },
      ),
    ).toEqual({
      component: "full",
      scope_kind: "full",
    });

    expect(
      resolveViewport3DScalarComponentRequest(new Set(["x", "y"]), null),
    ).toEqual({
      component: null,
      needsFullVector: true,
    });
  });

  it("keeps scoped query and request identity in sync", () => {
    const query = resolveViewport3DScopedFieldQuery({
      maxSamples: 1200,
      surfaceColorMode: null,
      vectorsVisible: true,
    });
    const scopedQuery = {
      ...query,
      scope_id: "part:air",
      scope_kind: "airbox",
    };

    expect(buildViewport3DFieldResourceRequestId("H_eff", scopedQuery))
      .toContain("scope_id=part:air");
    expect(buildViewport3DFieldResourceRequestId("H_eff", scopedQuery))
      .toContain("scope_kind=airbox");
    expect(scopedQuery).toEqual({
      component: "full",
      max_samples: 1200,
      scope_id: "part:air",
      scope_kind: "airbox",
    });
  });
});
