import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Selection } from "@/kernel/selection/selectionTypes";
import {
  FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET,
} from "@/kernel/visualization/ObjectVisualizationController";
import {
  ObjectVisualizationPanel,
  VisualizationTargetInspectorPanel,
} from "../ObjectVisualizationPanel";
import {
  FdmGridInspectorPanelView,
  FdmGridUniverseVisualizationPanel,
} from "./FdmGridInspectorPanel";
import type {
  FdmGridInspectorModel,
  FdmGridSelectionInspectorModel,
} from "./fdmGridInspectorModel";
import type { FdmMultilayerInspectorModel } from "./fdmMultilayerInspectorModel";

function readyModel(): FdmGridInspectorModel {
  return {
    cellClassification: "unknown",
    domainId: "domain:fdm",
    generationId: "generation-7",
    membership: {
      encoding: "u32le-v2",
      freshness: "current",
      gridFingerprint: "grid-fingerprint-7",
      legend: [
        {
          numericId: 7,
          objectId: "object:core",
          priority: 0,
          regionId: "region:core",
        },
      ],
      meshRevision: 11,
      regionMembershipRevision: 12,
    },
    notice: null,
    origin: [0, 0, 0],
    shape: [2, 3, 4],
    spacing: [2, 1, 0.5],
    status: "ready",
    statusLabel: "Realized",
    totalCells: 24,
    units: { length: "m", time: "s" },
  };
}

function selectionDetail(
  overrides: Partial<FdmGridSelectionInspectorModel> = {},
): FdmGridSelectionInspectorModel {
  return {
    cell: null,
    notice: null,
    region: null,
    scope: "descriptor",
    snapshotCell: null,
    status: "current",
    support: null,
    title: "Structured Grid Descriptor",
    ...overrides,
  };
}

const universeSelection: Selection = {
  kind: "mesh.grid.universe-outside-support",
  label: "Airbox",
  moduleSource: "inspector",
  nodeId: "model:mesh:grid:universe-outside-support",
  objectId: null,
  ref: {
    kind: "mesh.grid.universe-outside-support",
    nodeId: "model:mesh:grid:universe-outside-support",
    scope: "universe-outside-support",
    type: "fdm-domain",
    visualizationTargetId: FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET.id,
  },
};

describe("FdmGridInspectorPanelView", () => {
  it("uses the same target inspector mutation path as the main visualization entry", () => {
    const gridEntry = FdmGridUniverseVisualizationPanel({
      selection: universeSelection,
    });
    const mainEntry = ObjectVisualizationPanel({
      selection: universeSelection,
    });

    expect(gridEntry.type).toBe(VisualizationTargetInspectorPanel);
    expect(mainEntry.type).toBe(VisualizationTargetInspectorPanel);
    expect(gridEntry.type).toBe(mainEntry.type);
    expect(gridEntry.props.selection.ref).toMatchObject({
      scope: "universe-outside-support",
      type: "fdm-domain",
      visualizationTargetId: FDM_UNIVERSE_OUTSIDE_SUPPORT_TARGET.id,
    });
  });

  it("keeps native-layer facts and target-local visualization controls in one Inspector", () => {
    const multilayer: FdmMultilayerInspectorModel = {
      notice: null,
      rows: [{ label: "Layer ID", value: "layer:bottom", mono: true }],
      status: "ready",
      title: "Bottom · Native Grid",
    };
    const html = renderToStaticMarkup(
      <FdmGridInspectorPanelView
        detail={selectionDetail()}
        model={readyModel()}
        multilayer={multilayer}
        multilayerVisualizationControls={(
          <div data-testid="native-layer-visualization-controls">Target controls</div>
        )}
      />,
    );

    expect(html).toContain("Bottom · Native Grid");
    expect(html).toContain("layer:bottom");
    expect(html).toContain("native-layer-visualization-controls");
  });

  it("renders structured-grid facts and membership provenance without FEM policy controls", () => {
    const html = renderToStaticMarkup(
      <FdmGridInspectorPanelView
        detail={selectionDetail()}
        model={readyModel()}
      />,
    );

    expect(html).toContain("Structured Grid");
    expect(html).toContain("2 × 3 × 4");
    expect(html).toContain("Origin [m]");
    expect(html).toContain("Cell spacing [m]");
    expect(html).toContain(">cells<");
    expect(html).toContain("Display samples");
    expect(html).toContain("Display stride");
    expect(html).toContain("Display budget");
    expect(html).toContain("150,000");
    expect(html).toContain("u32le-v2");
    expect(html).toContain("grid-fingerprint-7");
    expect(html).toContain("region:core");
    expect(html).not.toMatch(/Gmsh|hmax|hmin|tet|quality|Build|FEM|shared-domain/i);
  });

  it("renders an explicit not-materialized state rather than inventing a mask", () => {
    const model = readyModel();
    model.membership = null;
    model.status = "not-materialized";
    model.statusLabel = "Not materialized";
    model.notice = "FDM region membership is not materialized.";

    const html = renderToStaticMarkup(
      <FdmGridInspectorPanelView detail={selectionDetail()} model={model} />,
    );

    expect(html).toContain("Not materialized");
    expect(html).toContain("FDM region membership is not materialized.");
    expect(html).toContain("Unknown until the membership resource is available");
    expect(html).not.toContain("Active cells");
    expect(html).not.toContain("Air cells");
  });

  it("renders canonical region identity for a region-scoped selection", () => {
    const html = renderToStaticMarkup(
      <FdmGridInspectorPanelView
        detail={selectionDetail({
          region: {
            numericId: 7,
            objectId: "object:core",
            priority: 0,
            regionId: "region:core",
          },
          scope: "region",
          title: "FDM Region",
        })}
        model={readyModel()}
      />,
    );

    expect(html).toContain("FDM Region");
    expect(html).toContain("region:core");
    expect(html).toContain("object:core");
    expect(html).toContain("Numeric region");
  });

  it("renders verified current cell facts with grid and membership identity", () => {
    const cell = {
      cellOrdinal: "5",
      gridFingerprint: "grid-fingerprint-7",
      ijk: [1, 2, 0] as const,
      maskState: "region" as const,
      membershipRevision: "11:12",
      numericRegionId: 7,
      regionId: "region:core",
    };
    const html = renderToStaticMarkup(
      <FdmGridInspectorPanelView
        detail={selectionDetail({
          cell,
          scope: "cell",
          snapshotCell: cell,
          title: "FDM Cell",
        })}
        model={readyModel()}
      />,
    );

    expect(html).toContain("Current Cell");
    expect(html).toContain("Cell ordinal");
    expect(html).toContain("[1, 2, 0]");
    expect(html).toContain("region:core");
    expect(html).toContain("grid-fingerprint-7");
    expect(html).toContain("11:12");
    expect(html).toContain("Verified from current mask");
  });

  it("labels a mismatched cell as stale and never presents it as current", () => {
    const html = renderToStaticMarkup(
      <FdmGridInspectorPanelView
        detail={selectionDetail({
          notice: "The selected FDM cell identity does not match the current grid.",
          scope: "cell",
          snapshotCell: {
            cellOrdinal: "5",
            gridFingerprint: "old-grid",
            ijk: [1, 2, 0],
            maskState: "region",
            membershipRevision: "11:11",
            numericRegionId: 7,
            regionId: "region:core",
          },
          status: "stale",
          title: "FDM Cell",
        })}
        model={readyModel()}
      />,
    );

    expect(html).toContain("Selected Cell Snapshot");
    expect(html).toContain("stale");
    expect(html).toContain("old-grid");
    expect(html).toContain("Withheld because the selected snapshot is stale");
    expect(html).not.toContain("Current Cell");
  });

  it("shows fail-closed magnetic support instead of inferred counts", () => {
    const html = renderToStaticMarkup(
      <FdmGridInspectorPanelView
        detail={selectionDetail({
          notice: "The canonical magnetic-support summary is not published; support facts are withheld.",
          scope: "magnetic-support",
          status: "degraded",
          title: "Magnetic Support",
        })}
        model={readyModel()}
      />,
    );

    expect(html).toContain("Magnetic Support");
    expect(html).toContain("support facts are withheld");
    expect(html).not.toContain("Active cells");
  });

  it("delegates Airbox visualization to the shared target editor", () => {
    const html = renderToStaticMarkup(
      <FdmGridInspectorPanelView
        detail={selectionDetail({
          scope: "universe-outside-support",
          title: "Airbox Visualization",
          support: {
            activeCellCount: 16,
            activeUnassignedCellCount: 2,
            boundsMax: [4, 3, 2],
            boundsMin: [0, 0, 0],
            inactiveCellCount: 8,
          },
        })}
        model={readyModel()}
        universeVisualizationControls={(
          <div data-testid="canonical-airbox-visualization-controls">
            Canonical target controls
          </div>
        )}
      />,
    );

    expect(html).toContain("canonical-airbox-visualization-controls");
    expect(html).not.toContain("Airbox · Visualization");
    expect(html).not.toContain("Universe/support bounds opacity");
    expect(html).not.toContain("Grid wireframe opacity");
    expect(html).toContain("Owner: object:core · Region: region:core");
    expect(html).not.toMatch(/Gmsh|hmax|hmin|tet|quality|Build|FEM|shared-domain/i);
  });
});
