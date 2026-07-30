import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const smokeScriptUrl = new URL(
  "../../../scripts/smoke-viewport-3d-mixed-targets.mjs",
  import.meta.url,
);
const packageJsonUrl = new URL("../../../package.json", import.meta.url);
const repoJustfileUrl = new URL("../../../../../justfile", import.meta.url);
const mixedTargetFixtureUrl = new URL(
  "../../../../../examples/viewport_3d_mixed_targets_smoke.py",
  import.meta.url,
);
const mixedTopologySmokeScriptUrl = new URL(
  "../../../scripts/smoke-viewport-3d-mixed-topology.mjs",
  import.meta.url,
);
const mixedTopologyFixtureUrl = new URL(
  "../../../../../examples/viewport_3d_mixed_topology_smoke.py",
  import.meta.url,
);

describe("viewport 3D mixed-target smoke script", () => {
  it("codifies the production mixed-target proof gate from the field-data report", () => {
    const smokeScript = readFileSync(smokeScriptUrl, "utf8");
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8"));

    expect(packageJson.scripts["smoke:viewport-3d-mixed-targets"]).toBe(
      "node scripts/smoke-viewport-3d-mixed-targets.mjs",
    );
    expect(smokeScript).toContain("buildMixedTargetVisualizationPatch");
    expect(smokeScript).toContain("waitForMixedTargetSceneReady");
    expect(smokeScript).toContain("waitForBinaryVectorEndpointReady");
    expect(smokeScript).toContain("ensureComputeFieldsReady");
    expect(smokeScript).toContain("const detail = await getJsonOrNull(");
    expect(smokeScript).toContain('kind: "compute_fields"');
    expect(smokeScript).toContain("requestTargetsObject");
    expect(smokeScript).toContain('entry.params.scope_kind !== "part"');
    expect(smokeScript).toContain("response.status === 204");
    expect(smokeScript).toContain("CONTROL_ROOM_MIXED_TARGET_A_ID");
    expect(smokeScript).toContain("CONTROL_ROOM_MIXED_TARGET_B_ID");
    expect(smokeScript).toContain("CONTROL_ROOM_MIXED_TARGET_C_ID");
    expect(smokeScript).toContain("TARGET_B_INITIAL_SURFACE_SOURCE");
    expect(smokeScript).toContain('"surface_color_source": "orientation"');
    expect(smokeScript).toContain('"component_x"');
    expect(smokeScript).toContain('"surface_color_source": "solid"');
    expect(smokeScript).toContain('"viewport_colorbar_visible": true');
    expect(smokeScript).toContain('"scope": "airbox"');
    expect(smokeScript).toContain("assertNoDuplicateEquivalentFieldRequests");
    expect(smokeScript).toContain("assertNoAirOrInterfaceColorbar");
    expect(smokeScript).toContain("assertColorbarRemainsMountedAcrossModeSwitch");
    expect(smokeScript).toContain("isSameNode");
    expect(smokeScript).toContain("assertColorbarRangeUpdateDoesNotRemount");
    expect(smokeScript).toContain("assertCanvasNonBlank");
    expect(smokeScript).toContain("waitForViewport3DBuildQuiescence");
    expect(smokeScript).toContain("assertSemanticTargetBuildEvidence");
    expect(smokeScript).toContain('"airbox vectors", "vector-glyph"');
    expect(smokeScript).toContain("fullmag.viewport3d.build-engine");
  });

  it("has a lightweight runtime fixture for the mixed-target live proof", () => {
    const justfile = readFileSync(repoJustfileUrl, "utf8");
    const fixture = readFileSync(mixedTargetFixtureUrl, "utf8");

    expect(justfile).toContain("run-viewport-3d-mixed-target-smoke");
    expect(justfile).toContain(
      'run-cofeb-rings-relax-mixed-target-smoke fem_execution="gpu" cpu_threads="auto" web_port="3193" api_port="8195"',
    );
    expect(justfile).toContain('api_port="8193"');
    expect(justfile).toContain("FULLMAG_API_PORT");
    expect(justfile).toContain("CONTROL_ROOM_API_BASE_URL");
    expect(justfile).toContain("viewport_3d_mixed_targets_smoke.py");
    expect(justfile).toContain("smoke:viewport-3d-mixed-targets");
    expect(fixture).toContain('fm.study("viewport_3d_mixed_targets_smoke")');
    expect(fixture).toContain('"permalloy_layer"');
    expect(fixture).toContain('"cofeb_top_ring"');
    expect(fixture).toContain('"cofeb_bottom_ring"');
    expect(fixture).toContain('study.airbox.visualization(show=True, mode="vectors"');
    expect(fixture).toContain("FULLMAG_VIEWPORT3D_MIXED_TARGET_MAX_STEPS");
    expect(fixture).toContain("study.build_domain_mesh()");
  });

  it("keeps the strict mixed-P1 qualification in a separate topology smoke", () => {
    const smokeScript = readFileSync(mixedTopologySmokeScriptUrl, "utf8");
    const fixture = readFileSync(mixedTopologyFixtureUrl, "utf8");

    expect(smokeScript).toContain("assertStrictMixedTopologyManifest");
    expect(smokeScript).toContain("mixed_layer_topology_certificate");
    expect(smokeScript).toContain("mixed_topology_provenance");
    expect(smokeScript).toContain("mesh.topology.mixed_p1");
    expect(smokeScript).toContain("__FULLMAG_SELECT_VIEWPORT_3D_MESH_CELL__");
    expect(smokeScript).toContain('carrier: "magnetic"');
    expect(smokeScript).toContain('carrier: "airbox"');
    expect(smokeScript).toContain("assertAirboxFullWireframeBuildEvidence");
    expect(smokeScript).toContain("assertNoTopologyRebuildAfterFieldSwitch");
    expect(fixture).toContain('fm.study("viewport_3d_mixed_topology_smoke")');
    expect(fixture).toContain("study.mode(\"strict\")");
    expect(fixture).toContain('study.device("gpu", precision="double")');
    expect(fixture).toContain("film.mesh.thin_film(");
    expect(fixture).toContain("layers=1");
    expect(fixture).toContain('topology="prismatic"');
    expect(fixture).toContain("exact_layers=True");
    expect(fixture).toContain('transition="pyramid_to_tetrahedra"');
    expect(fixture).not.toContain("Ku1");
  });
});
