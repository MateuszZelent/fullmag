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
  resolveViewport3DAirboxFieldVectorDemandPlan,
  resolveViewport3DPrimaryFieldDemandPlan,
  resolveViewport3DScalarComponentRequest,
  resolveViewport3DScopedPartVectorFieldDemandPlan,
  resolveViewport3DScopedFieldQuery,
  resolveViewport3DTargetQuantityFieldDemandPlan,
  resolveViewport3DTargetFieldQuery,
  summarizeViewport3DFieldDemandDiagnostics,
  validateViewport3DFieldResourceRequestEquivalence,
  validateViewport3DFieldResourceRequestIdentities,
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

  it("keeps the surface field projection mode in the shader plan", () => {
    const plan = objectPlan("object:surface-faces", {
      surfaceColorSource: "component_x",
      surfaceProjectionMode: "surface_faces",
      vectorsVisible: false,
    });

    expect(plan.shader.projectionMode).toBe("surface_faces");
  });

  it("reports request id mismatches for scoped data-plane diagnostics", () => {
    expect(
      validateViewport3DFieldResourceRequestIdentities([
        [
          "part-a",
          {
            consumers: ["part-a:surface"],
            quantityId: "m",
            query: {
              component: "x",
              scope_id: "part-a",
              scope_kind: "part",
            },
            requestId: "quantity=m&component=y&scope_id=part-a&scope_kind=part",
          },
        ],
      ]),
    ).toEqual([
      "request-id-mismatch target=part-a expected=component=x&quantity=m&scope_id=part-a&scope_kind=part actual=quantity=m&component=y&scope_id=part-a&scope_kind=part",
    ]);
  });

  it("reports duplicate equivalent field resource requests across data-plane planners", () => {
    const request = {
      consumers: ["part-a:surface"],
      quantityId: "m",
      query: {
        component: "x" as const,
        scope_id: "part-a",
        scope_kind: "part" as const,
      },
      requestId: "component=x&quantity=m&scope_id=part-a&scope_kind=part",
    };

    expect(
      validateViewport3DFieldResourceRequestEquivalence([
        ["part-a", request],
        [
          "target-quantity:part-a",
          {
            ...request,
            consumers: ["part-a:colorbar"],
          },
        ],
      ]),
    ).toEqual([
      "duplicate-equivalent-request request=component=x&quantity=m&scope_id=part-a&scope_kind=part targets=part-a,target-quantity:part-a consumers=part-a:colorbar,part-a:surface",
    ]);
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

  it("requests full scalar values for energy-density colormap surfaces", () => {
    const plan = objectPlan("object:energy", {
      activeQuantityId: "eden_total",
      surfaceColorSource: "colormap",
      vectorsVisible: false,
    });
    const requests = planViewport3DFieldResourceRequests(
      buildViewport3DPassDemands(plan),
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      query: {
        component: "full",
        scope_id: "object:energy",
        scope_kind: "object",
      },
      quantityId: "eden_total",
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

  it("keeps mixed object demands isolated across component, orientation, and vector-only targets", () => {
    const componentPlan = objectPlan("object:component-x", {
      surfaceColorSource: "component_x",
      vectorsVisible: false,
      viewportColorbarVisible: true,
    });
    const orientationPlan = objectPlan("object:orientation", {
      surfaceColorSource: "orientation",
      vectorsVisible: false,
      viewportColorbarVisible: true,
    });
    const vectorOnlyPlan = objectPlan("object:vectors", {
      shaderVisible: false,
      surfaceColorSource: "solid",
      vectorBudget: 512,
      vectorColorMode: "x",
      vectorsVisible: true,
      viewportColorbarVisible: true,
    });
    const demands = [
      ...buildViewport3DPassDemands(componentPlan, { maxSamples: 128 }),
      ...buildViewport3DPassDemands(orientationPlan, { maxSamples: 128 }),
      ...buildViewport3DPassDemands(vectorOnlyPlan, { maxSamples: 128 }),
    ];
    const requests = planViewport3DFieldResourceRequests(demands);

    expect(
      demands
        .map((demand) => ({
          component: demand.component,
          completeness: demand.completeness,
          maxSamples: demand.maxSamples,
          passKind: demand.passKind,
          targetId: demand.targetId,
        }))
        .sort((left, right) =>
          `${left.targetId}:${left.passKind}`.localeCompare(
            `${right.targetId}:${right.passKind}`,
          ),
        ),
    ).toEqual([
      {
        component: "x",
        completeness: "complete",
        maxSamples: null,
        passKind: "colorbar",
        targetId: "object:component-x",
      },
      {
        component: "x",
        completeness: "complete",
        maxSamples: null,
        passKind: "surface",
        targetId: "object:component-x",
      },
      {
        component: "full",
        completeness: "complete",
        maxSamples: null,
        passKind: "surface",
        targetId: "object:orientation",
      },
      {
        component: "x",
        completeness: "complete",
        maxSamples: null,
        passKind: "colorbar",
        targetId: "object:vectors",
      },
      {
        component: "full",
        completeness: "sampled-ok",
        maxSamples: 128,
        passKind: "vector-glyph",
        targetId: "object:vectors",
      },
    ]);
    expect(componentPlan.colorbar.viewportVisible).toBe(true);
    expect(orientationPlan.colorbar.viewportVisible).toBe(false);
    expect(vectorOnlyPlan.colorbar.viewportVisible).toBe(true);
    expect(
      requests
        .map((request) => ({
          consumers: request.consumers,
          query: request.query,
        }))
        .sort((left, right) =>
          String(left.query.scope_id).localeCompare(String(right.query.scope_id)),
        ),
    ).toEqual([
      {
        consumers: [
          "object:component-x:colorbar",
          "object:component-x:surface",
        ],
        query: {
          component: "x",
          scope_id: "object:component-x",
          scope_kind: "object",
        },
      },
      {
        consumers: ["object:orientation:surface"],
        query: {
          component: "full",
          scope_id: "object:orientation",
          scope_kind: "object",
        },
      },
      {
        consumers: [
          "object:vectors:colorbar",
          "object:vectors:vector-glyph",
        ],
        query: {
          component: "full",
          scope_id: "object:vectors",
          scope_kind: "object",
        },
      },
    ]);
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

  it("keeps scoped query identity when scalar components merge to full vector", () => {
    expect(
      mergeViewport3DFieldVectorQueries(
        {
          component: "x",
          scope_id: "object:layer-a",
          scope_kind: "object",
        },
        {
          component: "y",
          scope_id: "object:layer-a",
          scope_kind: "object",
        },
      ),
    ).toEqual({
      component: "full",
      scope_id: "object:layer-a",
      scope_kind: "object",
    });
  });

  it("rejects merging different scoped targets into one broad field query", () => {
    expect(() =>
      mergeViewport3DFieldVectorQueries(
        {
          component: "x",
          scope_id: "object:layer-a",
          scope_kind: "object",
        },
        {
          component: "x",
          scope_id: "object:layer-b",
          scope_kind: "object",
        },
      ),
    ).toThrow("Cannot merge viewport 3D field queries for different scopes");
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

  it("carries replay query identity from pass demand to request planning and diagnostics", () => {
    const plan = objectPlan("object:replay-mx", {
      surfaceColorSource: "component_x",
      vectorsVisible: false,
    });
    const demands = buildViewport3DPassDemands(plan, {
      replayQuery: {
        snapshot_id: "snapshot-17",
        stage_id: "stage-relax",
        view: "saved",
      },
    });
    const requests = planViewport3DFieldResourceRequests(demands);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.query).toMatchObject({
      component: "x",
      scope_id: "object:replay-mx",
      scope_kind: "object",
      snapshot_id: "snapshot-17",
      stage_id: "stage-relax",
      view: "saved",
    });
    expect(requests[0]?.requestId).toContain("snapshot_id=snapshot-17");
    expect(requests[0]?.requestId).toContain("stage_id=stage-relax");
    expect(
      summarizeViewport3DFieldDemandDiagnostics({
        demands,
        requests,
      })[0]?.requests[0],
    ).toContain("snapshot_id=snapshot-17");
  });

  it("explains which target pass demands produced each field request", () => {
    const shaderAndVectorPlan = objectPlan("object:mx-vectors", {
      surfaceColorSource: "component_x",
      vectorBudget: 512,
      vectorsVisible: true,
    });
    const vectorOnlyPlan = objectPlan("object:vectors", {
      shaderVisible: false,
      vectorBudget: 256,
      vectorsVisible: true,
    });
    const demands = [
      ...buildViewport3DPassDemands(shaderAndVectorPlan, { maxSamples: 512 }),
      ...buildViewport3DPassDemands(vectorOnlyPlan, { maxSamples: 128 }),
    ];
    const requests = planViewport3DFieldResourceRequests(demands);

    expect(
      summarizeViewport3DFieldDemandDiagnostics({
        demands,
        requests,
      }),
    ).toEqual([
      {
        demands: [
          "surface:x:complete",
          "vector-glyph:full:complete",
        ],
        requests: [
          "quantity=m component=full scope=object:object:mx-vectors consumers=object:mx-vectors:surface,object:mx-vectors:vector-glyph",
        ],
        targetId: "object:mx-vectors",
      },
      {
        demands: [
          "vector-glyph:full:sampled-ok max_samples=128",
        ],
        requests: [
          "quantity=m component=full scope=object:object:vectors max_samples=128 consumers=object:vectors:vector-glyph",
        ],
        targetId: "object:vectors",
      },
    ]);
  });

  it("owns the primary, scoped part, target quantity, and airbox request planners", () => {
    const primary = resolveViewport3DPrimaryFieldDemandPlan({
      fdmInstanceModelNeedsFieldVector: false,
      fdmSurfaceColorMode: null,
      fdmTopographyEnabled: false,
      fdmVectorsVisible: false,
      fieldRenderOptions: {
        scalarColorModes: new Set(["x"]),
        scalarColorsVisible: true,
      },
      primaryFieldQuantityId: "m",
    });

    expect(primary.request).toMatchObject({
      query: {
        component: "x",
        scope_kind: "full",
      },
      quantityId: "m",
    });

    const scoped = resolveViewport3DScopedPartVectorFieldDemandPlan({
      getPartSettings: () => ({
        ...DEFAULT_OBJECT_VISUALIZATION,
        activeQuantityId: "m",
        shaderVisible: false,
        vectorBudget: 64,
        vectorsVisible: true,
        visible: true,
      }),
      maxVectorGlyphs: 256,
      magneticParts: [{ part: { id: "part-a", label: "Part A" } }],
      vectorDomain: "full",
    });

    expect(scoped.requests.get("part-a")).toMatchObject({
      query: {
        component: "full",
        max_samples: 64,
        scope_id: "part-a",
        scope_kind: "part",
      },
    });

    const targetQuantity = resolveViewport3DTargetQuantityFieldDemandPlan({
      fdmSettings: null,
      getPartSettings: () => ({
        ...DEFAULT_OBJECT_VISUALIZATION,
        activeQuantityId: "H_eff",
        surfaceColorSource: "component_y",
        vectorsVisible: false,
        visible: true,
      }),
      magneticPartScopedFieldIds: new Set(),
      magneticParts: [{ part: { id: "part-b", label: "Part B" } }],
      maxVectorGlyphs: 256,
      primaryFieldQuantityId: "m",
    });

    expect([...targetQuantity.requests.values()][0]).toMatchObject({
      query: {
        component: "y",
        scope_id: "part-b",
        scope_kind: "part",
      },
      quantityId: "H_eff",
    });

    const airbox = resolveViewport3DAirboxFieldVectorDemandPlan({
      airboxParts: [{ id: "airbox-a", label: "Airbox A" }],
      quantityId: "H_demag",
      vectorBudget: 32,
      vectorsVisible: true,
    });

    expect(airbox.requests.get("airbox-a")).toMatchObject({
      query: {
        component: "full",
        max_samples: 32,
        scope_id: "airbox-a",
        scope_kind: "airbox",
      },
      quantityId: "H_demag",
    });

    const surfaceAirbox = resolveViewport3DAirboxFieldVectorDemandPlan({
      airboxParts: [{ id: "airbox-surface", label: "Surface Airbox" }],
      fieldQuery: {
        component: "full",
        geometry_scope: "surface",
        max_samples: 32,
        scope_kind: "full",
      },
      quantityId: "H_demag",
      vectorBudget: 32,
      vectorsVisible: true,
    });
    expect(surfaceAirbox.requests.get("airbox-surface")?.query).toMatchObject({
      geometry_scope: "surface",
      max_samples: 32,
      scope_id: "airbox-surface",
      scope_kind: "airbox",
    });

    const emptyAirbox = resolveViewport3DAirboxFieldVectorDemandPlan({
      airboxParts: [{ id: "airbox-empty", label: "Empty Airbox" }],
      quantityId: "H_demag",
      vectorBudget: 0,
      vectorsVisible: true,
    });
    expect(emptyAirbox.demands).toEqual([]);
    expect(emptyAirbox.requests.size).toBe(0);
  });
});
