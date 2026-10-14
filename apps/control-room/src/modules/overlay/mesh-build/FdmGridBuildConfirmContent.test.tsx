import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FdmGridBuildConfirmContent } from "./FdmGridBuildConfirmContent";

describe("FdmGridBuildConfirmContent", () => {
  it("renders structured grid target, scene geometry and discretization metrics", () => {
    const html = renderToStaticMarkup(
      <FdmGridBuildConfirmContent
        commandId="grid.build-fdm"
        commandStatus="ready"
        geometryBounds={{
          min: [-5e-8, -2e-8, 0],
          max: [5e-8, 2e-8, 1e-8],
        }}
        gridMemoryMB={12.5}
        gridShape={[100, 40, 10]}
        gridSpacing={[1e-9, 1e-9, 1e-9]}
        membershipRevision={4}
        mode="pre-build"
        objectsCount={3}
        ready={true}
        sceneRevision={7}
        totalCells={40000}
        onApplyBuild={() => undefined}
        onCancel={() => undefined}
        onOpenMeshOverview={() => undefined}
      />,
    );

    expect(html).toContain("FDM Structured Grid &amp; Mask Refresh");
    expect(html).toContain("grid.build-fdm");
    expect(html).toContain("Revision 7");
    expect(html).toContain("3 objects");
    expect(html).toContain("100 × 40 × 10");
    expect(html).toContain("40,000");
    expect(html).toContain("12.50 MB");
    expect(html).toContain("Build Grid &amp; Materialize Masks");
    expect(html).toContain("Mesh Overview");
  });

  it("handles loading and post-build completed states", () => {
    const postBuildHtml = renderToStaticMarkup(
      <FdmGridBuildConfirmContent
        commandId="grid.build-fdm"
        commandStatus="completed"
        mode="post-build"
        objectsCount={1}
        rendered={true}
        onApplyBuild={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(postBuildHtml).toContain("Grid &amp; Masks Materialized");
    expect(postBuildHtml).toContain("Published grid dimensions and membership masks rendered in the viewport.");
    expect(postBuildHtml).toContain("Close");
  });

  it("renders error banner when build fails", () => {
    const errorHtml = renderToStaticMarkup(
      <FdmGridBuildConfirmContent
        commandId="grid.build-fdm"
        commandStatus="failed"
        errorMessage="Geometry intersects non-manifold boundaries"
        mode="error"
        objectsCount={1}
        onApplyBuild={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(errorHtml).toContain("Build Error");
    expect(errorHtml).toContain("Geometry intersects non-manifold boundaries");
  });
});
