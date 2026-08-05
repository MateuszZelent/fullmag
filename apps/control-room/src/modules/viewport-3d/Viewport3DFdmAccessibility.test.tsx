import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it } from "vitest";

import type { FdmRegionMembershipResource } from "@/kernel/api/apiTypes";
import type { SelectionRef } from "@/kernel/selection/selectionTypes";

import {
  Viewport3DFdmSelectionAnnouncement,
  Viewport3DInspectTooltip,
  resolveViewport3DInspectSelectionProvenance,
  resolveViewport3DFdmSelectionAnnouncement,
} from "./Viewport3DModule";

type FdmCellSelectionRef = Extract<SelectionRef, { type: "fdm-cell" }>;

function membership(
  patch: Partial<FdmRegionMembershipResource> = {},
): FdmRegionMembershipResource {
  return {
    binary_path: "fdm_region_membership.v2.bin",
    cell_count: 8,
    cell_m: [1e-9, 2e-9, 3e-9],
    counts: [2, 2, 2],
    encoding: "u32le",
    freshness: "current",
    grid_fingerprint: "grid-7",
    mesh_revision: 11,
    object_ids: ["object:film"],
    origin_m: [0, 0, 0],
    region_legend: [
      {
        numeric_id: 7,
        object_id: "object:film",
        priority: 0,
        region_id: "region:core",
      },
    ],
    region_membership_revision: 12,
    schema_version: "fdm_region_membership.v2",
    ...patch,
  };
}

function selectionRef(
  patch: Partial<FdmCellSelectionRef> = {},
): FdmCellSelectionRef {
  return {
    cellOrdinal: "5",
    gridFingerprint: "grid-7",
    ijk: [1, 0, 1],
    kind: "fdm.cell",
    maskState: "region",
    membershipRevision: "11:12",
    nodeId: "model:mesh:grid",
    numericRegionId: 7,
    regionId: "region:core",
    type: "fdm-cell",
    visualizationTargetId: "fdm-domain",
    ...patch,
  };
}

describe("FDM viewport selection accessibility", () => {
  it("announces exact cell identity and available field/domain provenance", () => {
    const announcement = resolveViewport3DFdmSelectionAnnouncement({
      domainGenerationId: "generation-31",
      fieldIdentityCompatible: true,
      fieldRevision: "field-19",
      membership: membership(),
      quantityId: "m",
      selection: selectionRef(),
    });

    expect(announcement).toContain("Cell 5");
    expect(announcement).toContain("i 1, j 0, k 1");
    expect(announcement).toContain("Mask region");
    expect(announcement).toContain("Region region:core, numeric region 7");
    expect(announcement).toContain("Grid fingerprint grid-7");
    expect(announcement).toContain("Membership revision 11:12");
    expect(announcement).toContain("Quantity m");
    expect(announcement).toContain("Field revision field-19");
    expect(announcement).toContain("Domain generation generation-31");

    const html = renderToStaticMarkup(
      <Viewport3DFdmSelectionAnnouncement announcement={announcement} />,
    );
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('role="status"');
    expect(html).toContain('class="fm-visually-hidden"');
    expect(html).toContain(`title="${announcement}"`);
    expect(html).toContain(announcement);

    const tooltipHtml = renderToStaticMarkup(
      <Viewport3DInspectTooltip
        hover={{
          inspectRevision: 3,
          sample: {
            components: [{ label: "mx", value: 1 }],
            pointIndex: 5,
            quantityId: "m",
            status: "ready",
            targetLabel: "Cell 5",
            unit: null,
            worldPosition: [1e-9, 0, 3e-9],
          },
          screenPosition: { x: 10, y: 20 },
        }}
        provenance={announcement}
      />,
    );
    expect(tooltipHtml).toContain(`title="${announcement}"`);
    expect(tooltipHtml).toContain(announcement);

    const hover = {
      inspectRevision: 3,
      sample: {
        components: [{ label: "mx", value: 1 }],
        pointIndex: 5,
        quantityId: "m",
        status: "ready" as const,
        targetLabel: "Cell 5",
        unit: null,
        worldPosition: [1e-9, 0, 3e-9] as [number, number, number],
      },
      screenPosition: { x: 10, y: 20 },
    };
    expect(
      resolveViewport3DInspectSelectionProvenance({
        announcement,
        hover,
        selectedCellOrdinal: 5,
      }),
    ).toBe(announcement);
    expect(
      resolveViewport3DInspectSelectionProvenance({
        announcement,
        hover,
        selectedCellOrdinal: 4,
      }),
    ).toBeNull();
  });

  it("omits unavailable field provenance without inventing placeholders", () => {
    const announcement = resolveViewport3DFdmSelectionAnnouncement({
      domainGenerationId: null,
      fieldIdentityCompatible: false,
      fieldRevision: "stale-field",
      membership: membership(),
      quantityId: "m",
      selection: selectionRef({
        maskState: "active-unassigned",
        numericRegionId: 0,
        regionId: null,
      }),
    });

    expect(announcement).toContain("Mask active unassigned");
    expect(announcement).not.toContain("Region ");
    expect(announcement).not.toContain("Field revision");
    expect(announcement).not.toContain("Domain generation");
    expect(announcement).not.toContain("unknown");
    expect(announcement).not.toContain("not available");
  });

  it.each([
    ["missing membership", null, selectionRef()],
    ["stale membership", membership({ freshness: "stale" }), selectionRef()],
    ["fingerprint mismatch", membership(), selectionRef({ gridFingerprint: "old-grid" })],
    [
      "revision mismatch",
      membership(),
      selectionRef({ membershipRevision: "11:10" }),
    ],
  ])("fails closed for %s", (_case, currentMembership, selection) => {
    expect(
      resolveViewport3DFdmSelectionAnnouncement({
        domainGenerationId: "generation-31",
        fieldIdentityCompatible: true,
        fieldRevision: "field-19",
        membership: currentMembership,
        quantityId: "m",
        selection,
      }),
    ).toBeNull();

    expect(
      renderToStaticMarkup(
        <Viewport3DFdmSelectionAnnouncement announcement={null} />,
      ),
    ).toBe("");
  });
});
