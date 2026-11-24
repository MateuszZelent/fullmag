import { describe, expect, it } from "vitest";

import { CommandRegistry } from "@/kernel/commands/CommandRegistry";
import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { LayoutController } from "@/kernel/layout/LayoutController";
import { resolveSlotModuleManifest } from "@/kernel/layout/SlotHost.model";
import { SelectionController } from "@/kernel/selection/SelectionController";
import type { KernelApi, ModuleManifest } from "@/kernel/types";
import {
  INSPECTOR_ROUTES,
  LEGACY_SELECTION_KIND_REDIRECTS,
  resolveCanonicalSelection,
  resolveInspectorRoute,
} from "@/modules/inspector/inspectorRouteCatalog";
import { MAGNETIC_TEXTURE_ROUTES } from "@/modules/inspector/routes/magneticTextureRoutes";
import { MESH_ANTENNA_ROUTES } from "@/modules/inspector/routes/meshAntennaRoutes";
import { MODEL_PHYSICS_ROUTES } from "@/modules/inspector/routes/modelPhysicsRoutes";
import { STUDY_RESULTS_START_ROUTES } from "@/modules/inspector/routes/studyResultsStartRoutes";

import { buildModelTree, flattenExplorerNodes } from "./builders/buildModelTree";
import { buildRuntimeDiagnosticTree } from "./builders/diagnosticExplorerNodes";
import { buildRuntimeJobTree } from "./builders/jobExplorerNodes";
import { buildRuntimeResourceTree } from "./builders/resourceExplorerNodes";
import { modelTreeSnapshotFromScene } from "./builders/sceneModelTreeAdapter";
import {
  selectExplorerNode,
  selectionFromExplorerNode,
  selectionRefFromNode,
} from "./explorerSelection";
import type { ExplorerNode } from "./explorerTypes";

function makeMinimalKernel(): KernelApi {
  const bus = new EventBus<KernelEventMap>();
  const commands = new CommandRegistry();
  commands.attach(bus);
  return {
    bus,
    commands,
    layout: new LayoutController(bus),
    selection: new SelectionController(bus),
  } as unknown as KernelApi;
}

describe("Explorer selection and Inspector route catalog", () => {
  it("preserves visualizations-2d.draft and visualizations-2d.plot selection kinds without hijacking to mesh.cross-section.*", () => {
    const draftNode: ExplorerNode = {
      crossSectionDraftId: "draft",
      id: "model:visualizations-2d:draft",
      kind: "visualizations-2d.draft",
      label: "New Cross-Section",
      parentId: "model:visualizations-2d",
    };
    const plotNode: ExplorerNode = {
      crossSectionPlotId: "plot-xy",
      id: "model:visualizations-2d:plot-xy",
      kind: "visualizations-2d.plot",
      label: "Midplane XY",
      parentId: "model:visualizations-2d",
    };

    const draftSelection = selectionFromExplorerNode(draftNode);
    const plotSelection = selectionFromExplorerNode(plotNode);

    expect(draftSelection.kind).toBe("visualizations-2d.draft");
    expect(draftSelection.ref).toMatchObject({
      draftId: "draft",
      kind: "visualizations-2d.draft",
      nodeId: "model:visualizations-2d:draft",
      type: "cross-section-draft",
    });

    expect(plotSelection.kind).toBe("visualizations-2d.plot");
    expect(plotSelection.ref).toMatchObject({
      kind: "visualizations-2d.plot",
      nodeId: "model:visualizations-2d:plot-xy",
      plotId: "plot-xy",
      type: "cross-section-plot",
    });
  });

  it("builds object.magnetic-texture as a childless compass leaf and gives object.region.texture ready Inherited state", () => {
    const snapshot = modelTreeSnapshotFromScene({
      objects: [
        {
          geometry: { geometry_kind: "Box" },
          id: "film",
          initial_magnetization: { kind: "preset", preset_kind: "vortex" },
          name: "Film",
          role: "magnet",
        },
      ],
      universe: {
        id: "universe",
        name: "Universe",
        size: [1e-6, 1e-6, 5e-8],
      },
    } as never);

    const withRegion = {
      ...snapshot,
      objects: snapshot.objects?.map((obj) => ({
        ...obj,
        regions: [
          {
            id: "reg-edge",
            label: "Edge region",
            materialFieldCount: 0,
            materialOverrideCount: 0,
            meshPolicyActive: false,
            textureOverrideActive: false,
          },
        ],
        textureLoadEnabled: true,
        textureTransformAvailable: true,
      })),
    };

    const flattened = flattenExplorerNodes(buildModelTree(withRegion));
    const objectTexture = flattened.find(
      (node) => node.id === "model:object:film:magnetic-texture",
    );
    expect(objectTexture).toBeDefined();
    expect(objectTexture?.icon).toBe("compass");
    expect(objectTexture?.children).toBeUndefined();
    expect(
      flattened.filter((node) =>
        [
          "object.magnetic-texture.asset",
          "object.magnetic-texture.load",
          "object.magnetic-texture.transform",
        ].includes(node.kind),
      ),
    ).toHaveLength(0);

    const regionTexture = flattened.find(
      (node) => node.kind === "object.region.texture",
    );
    expect(regionTexture).toMatchObject({
      badge: "Inherited",
      icon: "compass",
      status: "ready",
    });
  });

  it("unlocks all 13 collection/scope roots as selectable and provides non-null SelectionRef including universe.root", () => {
    const kernel = makeMinimalKernel();
    const universeRef = selectionRefFromNode({
      id: "model:universe",
      kind: "universe.root",
      label: "Universe",
      parentId: "model:session",
    });
    expect(universeRef).toMatchObject({
      kind: "universe.root",
      scopeId: "universe",
      type: "model-scope",
    });

    const unlockedRootNodes: ExplorerNode[] = [
      { id: "model:session", kind: "session.root", label: "Session", parentId: null },
      { id: "model:universe", kind: "universe.root", label: "Universe", parentId: "model:session" },
      { id: "model:objects", kind: "objects.root", label: "Objects", parentId: "model:session" },
      { id: "model:definitions", kind: "definitions.root", label: "Definitions", parentId: "model:session" },
      { id: "model:definitions:planar-monitors", kind: "model.planar.monitors", label: "Planar Monitors", parentId: "model:definitions" },
      { id: "model:visualizations-2d", kind: "visualizations-2d.root", label: "Visualizations 2D", parentId: "model:session" },
      { id: "model:physics:couplings", kind: "physics.couplings", label: "Couplings", parentId: "model:session" },
      { id: "model:physics:field-drives", kind: "physics.field-drives", label: "Field Drives", parentId: "model:physics:global" },
      { id: "model:physics:global", kind: "physics.scope.global", label: "Global Physics", parentId: "model:session" },
      { id: "model:physics:cross-object", kind: "physics.scope.cross-object", label: "Cross-Object", parentId: "model:session" },
      { id: "model:physics:unresolved", kind: "physics.scope.unresolved", label: "Unresolved", parentId: "model:session" },
      { id: "resources:root", kind: "resources.root", label: "Resources", parentId: null },
      { id: "jobs:root", kind: "jobs.root", label: "Jobs", parentId: null },
      { id: "diagnostics:root", kind: "diagnostics.root", label: "Diagnostics", parentId: null },
    ];

    for (const rootNode of unlockedRootNodes) {
      const ref = selectionRefFromNode(rootNode);
      expect(ref, `expected non-null SelectionRef for ${rootNode.kind}`).not.toBeNull();
      selectExplorerNode(kernel, rootNode, "explorer");
      expect(kernel.selection.get().kind).toBe(rootNode.kind);
      expect(kernel.selection.get().ref).not.toBeNull();
    }

    // Built trees also publish selectable !== false on unlocked roots
    const modelFlat = flattenExplorerNodes(
      buildModelTree({
        couplings: [{ enabled: true, id: "c1", kind: "rkky", label: "RKKY" }],
        crossSections: {
          draft: null,
          plots: [
            {
              colorScale: "viridis",
              filterExpression: "",
              frameExtent: "universe",
              id: "p1",
              metric: "aspect_ratio",
              name: "Plot 1",
              plane: "xy",
              positionPercent: 50,
              rotationDegrees: 0,
              shrinkFactor: 1,
              wireframeVisible: false,
            },
          ],
        },
        domainDiscretization: "fem",
        objects: [{ id: "film", label: "Film" }],
        universe: { label: "Universe", size: [1e-6, 1e-6, 1e-8] },
      }),
    );
    for (const kind of [
      "session.root",
      "universe.root",
      "objects.root",
      "definitions.root",
      "model.planar.monitors",
      "physics.couplings",
      "visualizations-2d.root",
    ]) {
      const found = modelFlat.find((n) => n.kind === kind);
      expect(found, `expected ${kind} in model tree`).toBeDefined();
      expect(found?.selectable, `${kind} should be selectable`).not.toBe(false);
    }

    expect(buildRuntimeResourceTree([])[0]?.selectable).not.toBe(false);
    expect(buildRuntimeJobTree([])[0]?.selectable).not.toBe(false);
    expect(buildRuntimeDiagnosticTree([])[0]?.selectable).not.toBe(false);
  });

  it("splits the 163 canonical routes across 4 disjoint domain registries and redirects legacy/U1..U14 aliases cleanly", () => {
    expect(
      MAGNETIC_TEXTURE_ROUTES.length +
        MODEL_PHYSICS_ROUTES.length +
        MESH_ANTENNA_ROUTES.length +
        STUDY_RESULTS_START_ROUTES.length +
        1,
    ).toBe(163);
    expect(INSPECTOR_ROUTES).toHaveLength(163);
    expect(resolveInspectorRoute("object.geometry.node")?.id).toBe("geometry-node");

    // Disjoint selectionKinds across all 4 domain registries
    const seen = new Set<string>();
    for (const group of [
      MAGNETIC_TEXTURE_ROUTES,
      MODEL_PHYSICS_ROUTES,
      MESH_ANTENNA_ROUTES,
      STUDY_RESULTS_START_ROUTES,
    ]) {
      for (const route of group) {
        for (const kind of route.selectionKinds) {
          expect(seen.has(kind), `duplicate route kind ${kind}`).toBe(false);
          seen.add(kind);
        }
      }
    }

    // Explicit new canonical routes from Volume I §4.3 (U2, U9, U11, U13, A1, A2)
    for (const newKind of [
      "results.resonance.modal.field_sweep",
      "results.resonance.driven.fits",
      "results.resonance.kittel_fit",
      "mesh.part.visualization.debug",
      "study.stage.mask_field_drive",
      "results.hysteresis.point",
    ]) {
      const route = resolveInspectorRoute(newKind);
      expect(route, `missing new route ${newKind}`).not.toBeNull();
      expect(route?.id).not.toBe("placeholder");
    }

    // Legacy / merged / U1..U14 redirects resolve to canonical routes without falling into `*`
    const expectedRedirects: ReadonlyArray<readonly [string, string]> = [
      ["object.physics.scope", "object.physics"],
      ["mesh-part-airbox", "airbox.visualization"],
      ["object.magnetic-texture.asset", "object.magnetic-texture"],
      ["object.magnetic-texture.load", "object.magnetic-texture"],
      ["object.magnetic-texture.transform", "object.magnetic-texture"],
      ["object.region-magnetic-texture", "object.region.texture"],
      ["jobs.frequency_domain.stage_run", "jobs.stage"],
      ["results.eigen.field_sweep", "results.resonance.modal.field_sweep"],
      ["results.eigen.samples", "results.dispersion.k_sampling"],
      ["results.eigen.sample", "results.dispersion.modal.modes_at_k"],
      ["results.eigen.mode_metadata", "results.resonance.modal.mode"],
      ["results.eigen.mode_field", "results.resonance.modal.mode"],
      ["results.eigen.mode_residuals", "results.resonance.modal.mode"],
      ["resources.analysis.frequency_response.field", "results.resonance.driven.field"],
      ["results.frequency_domain.fmr_resonance_fits", "results.resonance.driven.fits"],
      ["results.frequency_domain.fmr_resonance_fit", "results.resonance.driven.fits"],
      ["results.frequency_domain.fmr_kittel_fit", "results.resonance.kittel_fit"],
      ["object", "object.root"],
      ["resources.mesh.periodic_pairs", "resources.runtime"],
    ];

    for (const [legacyKind, canonicalKind] of expectedRedirects) {
      expect(LEGACY_SELECTION_KIND_REDIRECTS[legacyKind]).toBe(canonicalKind);
      const redirected = resolveCanonicalSelection({
        kind: legacyKind,
        label: "Legacy",
        moduleSource: "explorer",
        nodeId: "n1",
        objectId: "film",
        ref: null,
      });
      expect(redirected.kind).toBe(canonicalKind);
      const route = resolveInspectorRoute(legacyKind);
      expect(route).not.toBeNull();
      expect(route?.id).toBe(resolveInspectorRoute(canonicalKind)?.id);
      expect(route?.id).not.toBe("placeholder");
    }
  });

  it("keeps ExplorerModule mounted on panel-left when the Results ribbon tab is active", () => {
    const explorer: ModuleManifest = {
      component: async () => ({ default: () => null }),
      id: "explorer",
      slots: ["panel-left"],
      title: "Explorer",
      version: "0.1.0",
    };
    const resultsNavigator: ModuleManifest = {
      ...explorer,
      activationTab: "results",
      id: "results-navigator",
      title: "Results",
    };

    expect(
      resolveSlotModuleManifest([explorer, resultsNavigator], "results")?.id,
    ).toBe("explorer");
  });
});
