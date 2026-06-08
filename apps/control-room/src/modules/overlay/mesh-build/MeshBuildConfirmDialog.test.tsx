import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MeshBuildConfirmDialogContent } from "./MeshBuildConfirmDialog";

describe("MeshBuildConfirmDialog", () => {
  it("renders a lightweight confirmation surface without build log monitoring", () => {
    const html = renderToStaticMarkup(
      <MeshBuildConfirmDialogContent
        commandId="mesh.build-shared-domain"
        commandStatus="submitted"
        currentSummary={[
          { label: "Mesh", value: "shared-domain" },
          { label: "Revision", value: "42" },
        ]}
        diffRows={[
          {
            currentValue: "2e-8",
            draftValue: "1e-8",
            impact: "resolution",
            label: "airbox_hmax",
            path: "airbox_hmax",
            realizedValue: "2e-8",
            scope: "airbox",
            state: "changed",
          },
        ]}
        newSummary={[
          { label: "Requested target", value: "Shared-domain mesh" },
          { label: "Policy changes", value: "1" },
        ]}
        targetLabel="Shared-domain mesh"
        onApplyBuild={() => undefined}
        onCancel={() => undefined}
        onOpenMeshJobs={() => undefined}
      />,
    );

    expect(html).toContain("Mesh Build Confirmation");
    expect(html).toContain("Shared-domain mesh");
    expect(html).toContain("New Mesh Request");
    expect(html).toContain("Requested target");
    expect(html).toContain("airbox_hmax");
    expect(html).toContain("Accept &amp; Build");
    expect(html).toContain("Open Mesh Jobs");
    expect(html).toContain(">New</th>");
    expect(html).not.toContain("Build console");
    expect(html).not.toContain("Gmsh");
  });

  it("renders a post-build summary with current and new mesh outputs", () => {
    const html = renderToStaticMarkup(
      <MeshBuildConfirmDialogContent
        commandId="cmd-1"
        commandStatus="rendered"
        currentSummary={[{ label: "Mesh", value: "old" }]}
        diffRows={[]}
        mode="post-build"
        newSummary={[{ label: "Requested target", value: "Shared-domain mesh" }]}
        postBuildRows={[
          {
            currentValue: "42",
            group: "topology",
            id: "element_count",
            label: "Elements",
            nextValue: "367",
          },
        ]}
        targetLabel="Shared-domain mesh"
        onApplyBuild={() => undefined}
        onCancel={() => undefined}
        onOpenMeshJobs={() => undefined}
      />,
    );

    expect(html).toContain("Build Result Summary");
    expect(html).toContain("Elements");
    expect(html).toContain("367");
    expect(html).toContain("Close");
    expect(html).not.toContain("Accept &amp; Build");
  });
});
