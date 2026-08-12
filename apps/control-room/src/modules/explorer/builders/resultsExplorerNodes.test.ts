import { describe, expect, it } from "vitest";

import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { fieldVectorResourceKey } from "@/kernel/api/fieldQueryIdentity";
import { SelectionController } from "@/kernel/selection/SelectionController";
import type { KernelApi } from "@/kernel/types";
import type { ArtifactResource, TableResource } from "@/kernel/api/apiTypes";

import { buildExplorerTree, flattenExplorerNodes } from "./buildModelTree";
import {
  buildPhysicsFirstResultsTree,
  physicsFirstResultsSnapshotFromResources,
  type PhysicsFirstResultEntry,
} from "./resultsExplorerNodes";
import { selectExplorerNode } from "../explorerSelection";

const modalFinite = {
  artifactRevision: "spectrum-r7",
  boundaryContext: "finite_open",
  equilibriumId: "eq-1",
  observables: [],
  products: {
    modeShapes: true,
    spectrum: true,
  },
  runId: "run:alpha/1",
  stageId: "modal stage",
  stageLabel: "Linear eigenmodes",
  studyProduct: "modal_eigen",
} satisfies PhysicsFirstResultEntry;

const drivenGamma = {
  artifactRevision: "response-r3",
  boundaryContext: "floquet_periodic",
  drive: { identity: "rf-drive", kind: "magnetic_rf" },
  equilibriumId: "eq-1",
  kSampling: { kind: "single", vectorRadPerM: [0, 0, 0] },
  observables: [
    { identity: "chi-xx", kind: "susceptibility", unit: "1" },
  ],
  products: {
    frequencyPoints: true,
    peaks: true,
    responseFields: true,
    responseSpectrum: true,
  },
  runId: "run:alpha/1",
  stageId: "response-stage",
  stageLabel: "RF sweep",
  studyProduct: "driven_response",
} satisfies PhysicsFirstResultEntry;

describe("buildPhysicsFirstResultsTree", () => {
  it("builds run-scoped resonance stages and first-class postprocessing roots", () => {
    const tree = buildPhysicsFirstResultsTree({
      entries: [modalFinite, drivenGamma],
      resultContextRunId: "run:alpha/1",
    });
    const nodes = flattenExplorerNodes(tree);

    expect(tree).toHaveLength(1);
    expect(tree[0]?.label).toBe("Results");
    expect(nodes.map((node) => node.label)).toEqual(
      expect.arrayContaining([
        "Dynamics",
        "Resonance & FMR",
        "Linear eigenmodes · Modal",
        "Eigenfrequency Spectrum",
        "Mode Shapes",
        "RF sweep · Driven",
        "FMR Response Spectrum",
        "Resonance Peaks",
        "Frequency Points",
        "Response Fields",
        "Hysteresis",
        "Analysis Views",
        "Derived Values",
        "Tables",
        "Exports",
      ]),
    );
    expect(nodes.map((node) => node.label)).not.toContain("RF Coupling / FMR Activity");
  });

  it("keeps fixed nonzero-k separate from a dispersion relation", () => {
    const tree = buildPhysicsFirstResultsTree({
      entries: [
        {
          ...modalFinite,
          boundaryContext: "floquet_periodic",
          kSampling: { kind: "single", vectorRadPerM: [1e7, 0, 0] },
        },
      ],
      resultContextRunId: modalFinite.runId,
    });
    const nodes = flattenExplorerNodes(tree);

    expect(nodes.map((node) => node.label)).toContain("Eigenfrequencies at fixed k");
    expect(nodes.map((node) => node.label)).not.toContain("Dispersion Relation · fₙ(k)");
  });

  it("separates modal f_n(k) from driven A(k,f)", () => {
    const kPath = { kind: "path", label: "Γ–X", sampleCount: 8 } as const;
    const tree = buildPhysicsFirstResultsTree({
      entries: [
        { ...modalFinite, kSampling: kPath, boundaryContext: "floquet_periodic" },
        {
          ...drivenGamma,
          kSampling: kPath,
          products: { responseMap: true },
        },
      ],
      resultContextRunId: modalFinite.runId,
    });
    const labels = flattenExplorerNodes(tree).map((node) => node.label);

    expect(labels).toContain("Dispersion Relation · fₙ(k)");
    expect(labels).toContain("Spectral Response Map · A(k,f)");
  });

  it("rejects entries from a different run instead of merging them", () => {
    expect(() =>
      buildPhysicsFirstResultsTree({
        entries: [modalFinite, { ...drivenGamma, runId: "run-beta" }],
        resultContextRunId: modalFinite.runId,
      }),
    ).toThrow("Result entry run-beta does not belong to context run:alpha/1");
  });

  it("uses stable encoded identities rather than labels or array indexes", () => {
    const first = flattenExplorerNodes(
      buildPhysicsFirstResultsTree({
        entries: [modalFinite],
        resultContextRunId: modalFinite.runId,
      }),
    );
    const renamed = flattenExplorerNodes(
      buildPhysicsFirstResultsTree({
        entries: [{ ...modalFinite, stageLabel: "Renamed stage" }],
        resultContextRunId: modalFinite.runId,
      }),
    );

    expect(renamed.map((node) => node.id)).toEqual(first.map((node) => node.id));
    expect(first.some((node) => node.id.includes("run%3Aalpha%2F1"))).toBe(true);
  });

  it("does not create a result stage when no published product exists", () => {
    const tree = buildPhysicsFirstResultsTree({
      entries: [{ ...modalFinite, products: {} }],
      resultContextRunId: modalFinite.runId,
    });
    const labels = flattenExplorerNodes(tree).map((node) => node.label);

    expect(labels).not.toContain("Linear eigenmodes · Modal");
  });

  it("publishes only existing table and artifact owners as postprocessing definitions", () => {
    const table: TableResource = {
      binary_rows_href: "/rows.bin",
      columns: [],
      columns_href: "/columns",
      revision: 4,
      rows_href: "/rows",
      schema_revision: 2,
      table_id: "energy",
      total_rows: 3,
    };
    const artifact: ArtifactResource = { kind: "csv", path: "run-7/energy.csv" };
    const tree = buildPhysicsFirstResultsTree({
      entries: [],
      postprocessing: {
        artifactCatalog: {
          data: [artifact],
          error: null,
          missing: false,
          revision: "artifacts:7",
          status: "ready",
        },
        tableCatalog: {
          data: { revision: 4, tables: [table] },
          error: null,
          missing: false,
          revision: 4,
          status: "ready",
        },
      },
      resultContextRunId: "run-7",
    });
    const nodes = flattenExplorerNodes(tree);

    expect(nodes.map((node) => node.label)).toEqual(expect.arrayContaining([
      "Analysis Views unavailable",
      "Derived Values unavailable",
      "Tables",
      "Exports",
      "energy",
      "energy.csv",
    ]));

    const tableNode = nodes.find((node) => node.label === "energy");
    const artifactNode = nodes.find((node) => node.label === "energy.csv");
    expect(tableNode).toMatchObject({
      availability: "available",
      postprocessingCatalogRevision: 4,
      postprocessingFreshness: "fresh",
      postprocessingOwnerId: "energy",
      postprocessingOwnerKind: "table",
      postprocessingOwnerReadiness: "available-ready",
      postprocessingResourceRevision: 4,
      postprocessingSchemaRevision: 2,
      resourceRef: "table:energy",
      resourceState: "ready",
      status: "ready",
    });
    expect(artifactNode).toMatchObject({
      availability: "available",
      resourceRef: "artifact:run-7/energy.csv",
      resourceState: "ready",
      status: "ready",
    });
    if (!tableNode) throw new Error("Missing table postprocessing node");
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    selectExplorerNode({ selection } as KernelApi, tableNode, "explorer");
    expect(selection.get().ref).toMatchObject({
      catalogRevision: 4,
      definitionKind: "table",
      freshness: "fresh",
      ownerId: "energy",
      ownerKind: "table",
      ownerReadiness: "available-ready",
      ownerResourceRevision: 4,
      ownerSchemaRevision: 2,
      resourceRef: "table:energy",
      scope: "definition",
      type: "postprocessing",
    });
    expect(selection.get().ref).not.toHaveProperty("columns");
    expect(selection.get().ref).not.toHaveProperty("rows_href");
  });

  it("emits explicit contract gaps for ownerless definition families", () => {
    const tree = buildPhysicsFirstResultsTree({
      entries: [],
      postprocessing: {
        analysisViews: [{ id: "view-1", kind: "analysis_view", label: "Energy view" }],
        derivedValues: [{ id: "value-1", kind: "derived_value", label: "Mean energy" }],
      },
      resultContextRunId: "run-7",
    });
    const nodes = flattenExplorerNodes(tree);
    const analysisView = nodes.find((node) => node.label === "Energy view");
    const derivedValue = nodes.find((node) => node.label === "Mean energy");

    expect(analysisView).toMatchObject({
      availability: "unavailable",
      badge: "contract gap",
      resourceState: "error",
      status: "unavailable",
    });
    expect(analysisView).not.toHaveProperty("resourceRef");
    expect(derivedValue).toMatchObject({
      availability: "unavailable",
      badge: "contract gap",
      resourceState: "error",
      status: "unavailable",
    });
    expect(derivedValue).not.toHaveProperty("resourceRef");
    expect(analysisView?.contextCommands).toBeUndefined();
    expect(derivedValue?.contextCommands).toBeUndefined();
  });

  it("keeps postprocessing node order and ids stable when owners arrive in a different order", () => {
    const first = buildPhysicsFirstResultsTree({
      entries: [],
      postprocessing: {
        artifactCatalog: {
          data: [
            { kind: "csv", path: "run-7/z.csv" },
            { kind: "csv", path: "run-7/a.csv" },
          ],
          error: null,
          missing: false,
          revision: "artifacts:7",
          status: "ready",
        },
        tableCatalog: {
          data: {
            revision: 1,
            tables: [
              { binary_rows_href: "/b.bin", columns: [], columns_href: "/b-columns", revision: 1, rows_href: "/b-rows", schema_revision: 1, table_id: "z", total_rows: 1 },
              { binary_rows_href: "/a.bin", columns: [], columns_href: "/a-columns", revision: 1, rows_href: "/a-rows", schema_revision: 1, table_id: "a", total_rows: 1 },
            ],
          },
          error: null,
          missing: false,
          revision: 1,
          status: "ready",
        },
      },
      resultContextRunId: "run-7",
    });
    const second = buildPhysicsFirstResultsTree({
      entries: [],
      postprocessing: {
        artifactCatalog: {
          data: [
            { kind: "csv", path: "run-7/a.csv" },
            { kind: "csv", path: "run-7/z.csv" },
          ],
          error: null,
          missing: false,
          revision: "artifacts:7",
          status: "ready",
        },
        tableCatalog: {
          data: {
            revision: 1,
            tables: [
              { binary_rows_href: "/a.bin", columns: [], columns_href: "/a-columns", revision: 1, rows_href: "/a-rows", schema_revision: 1, table_id: "a", total_rows: 1 },
              { binary_rows_href: "/b.bin", columns: [], columns_href: "/b-columns", revision: 1, rows_href: "/b-rows", schema_revision: 1, table_id: "z", total_rows: 1 },
            ],
          },
          error: null,
          missing: false,
          revision: 1,
          status: "ready",
        },
      },
      resultContextRunId: "run-7",
    });

    expect(flattenExplorerNodes(second).map((node) => node.id)).toEqual(
      flattenExplorerNodes(first).map((node) => node.id),
    );
    expect(flattenExplorerNodes(first).map((node) => node.label)).toEqual(
      expect.arrayContaining(["a", "z", "a.csv", "z.csv"]),
    );
  });

  it("wires typed Table and Artifact catalogs through the production Results callsite", () => {
    const table: TableResource = {
      binary_rows_href: "/tables/energy/rows.bin",
      columns: [],
      columns_href: "/tables/energy/columns",
      revision: 8,
      rows_href: "/tables/energy/rows",
      schema_revision: 3,
      table_id: "energy",
      total_rows: 42,
    };
    const artifact: ArtifactResource = {
      kind: "csv",
      path: "run-17/energy.csv",
    };
    const nodes = flattenExplorerNodes(
      buildExplorerTree("results", {
        artifacts: {
          data: [artifact],
          error: null,
          missing: false,
          revision: "artifacts:17",
          status: "ready",
        },
        currentRun: { revision: 17, run_id: "run-17" },
        frequencyDomainManifest: {
          result_manifest: {
            payload: {
              equilibrium_identity: "eq-17",
              requested_execution: { boundary_context: "finite_open" },
              revision: "result-17",
              stage_id: "stage-17",
              stage_label: "Eigenmodes",
              study_product: "modal_eigen",
            },
            status: "ready",
          },
        },
        frequencyDomainSpectrum: { status: "ready" },
        tableCatalog: {
          data: { revision: 12, tables: [table] },
          error: null,
          missing: false,
          revision: 12,
          status: "ready",
        },
      } as never),
    );

    const tableNode = nodes.find((node) => node.label === "energy");
    const artifactNode = nodes.find((node) => node.label === "energy.csv");
    expect(tableNode).toMatchObject({
      postprocessingCatalogRevision: 12,
      postprocessingOwnerKind: "table",
      postprocessingOwnerReadiness: "available-ready",
      postprocessingResourceRevision: 8,
      postprocessingSchemaRevision: 3,
      resourceRef: "table:energy",
      resourceState: "ready",
      status: "ready",
    });
    expect(artifactNode).toMatchObject({
      postprocessingCatalogRevision: "artifacts:17",
      postprocessingOwnerKind: "artifact",
      postprocessingOwnerReadiness: "available-ready",
      postprocessingResourceRevision: "artifacts:17",
      resourceRef: "artifact:run-17/energy.csv",
      resourceState: "ready",
      status: "ready",
    });
  });
});

describe("physicsFirstResultsSnapshotFromResources", () => {
  it("projects existing TableResource and ArtifactResource owners without payload copies", () => {
    const table: TableResource = {
      binary_rows_href: "/tables/energy/rows.bin",
      columns: [{
        column_id: "time",
        dimension: "time",
        label: "Time",
        quantity_id: "time",
        scope: "global",
        unit: "s",
        value_type: "float64",
      }],
      columns_href: "/tables/energy/columns",
      revision: 8,
      rows_href: "/tables/energy/rows",
      schema_revision: 3,
      table_id: "energy",
      total_rows: 42,
    };
    const artifact: ArtifactResource = { kind: "csv", path: "run-17/energy.csv" };
    const adapted = physicsFirstResultsSnapshotFromResources({
      artifacts: {
        data: [artifact],
        error: null,
        missing: false,
        revision: "artifacts:17",
        status: "ready",
      },
      currentRun: { revision: 17, run_id: "run-17" },
      manifest: {
        result_manifest: {
          payload: {
            equilibrium_identity: "eq-17",
            requested_execution: { boundary_context: "finite_open" },
            stage_id: "stage-17",
            study_product: "modal_eigen",
          },
          status: "ready",
        },
      },
      spectrum: { status: "ready" },
      tableCatalog: {
        data: { revision: 8, tables: [table] },
        error: null,
        missing: false,
        revision: 8,
        status: "ready",
      },
    });

    expect(adapted.snapshot.postprocessing).toEqual({
      artifactCatalog: {
        data: [artifact],
        error: null,
        missing: false,
        revision: "artifacts:17",
        status: "ready",
      },
      tableCatalog: {
        data: { revision: 8, tables: [table] },
        error: null,
        missing: false,
        revision: 8,
        status: "ready",
      },
    });
    const nodes = flattenExplorerNodes(buildPhysicsFirstResultsTree(adapted.snapshot));
    expect(nodes.find((node) => node.label === "energy")).toMatchObject({
      resourceRef: "table:energy",
      status: "ready",
    });
    expect(nodes.find((node) => node.label === "energy.csv")).toMatchObject({
      resourceRef: "artifact:run-17/energy.csv",
      status: "ready",
    });
    expect(nodes.find((node) => node.label === "energy")).not.toHaveProperty("columns");
  });

  it("publishes a concrete canonical modal field target with complete provenance", () => {
    const adapted = physicsFirstResultsSnapshotFromResources({
      currentRun: { revision: 17, run_id: "runtime-run-17" },
      manifest: {
        result_manifest: {
          payload: {
            equilibrium_identity: "eq-relax-r4",
            requested_execution: { boundary_context: "finite_open" },
            revision: "eigen-r9",
            stage_id: "eigen-stage",
            study_product: "modal_eigen",
          },
          status: "ready",
        },
      },
      spectrum: {
        payload: {
          modes: [{
            frequency_hz: 12.5e9,
            mode_field_id: "analysis:eigen:sample-0000:mode-0002",
            mode_field_resource_key: "data/fields/analysis:eigen:sample-0000:mode-0002",
            raw_mode_index: 2,
            sample_index: 0,
          }],
        },
        status: "ready",
      },
    });
    const target = flattenExplorerNodes(buildPhysicsFirstResultsTree(adapted.snapshot))
      .find((node) => node.kind === "results.resonance.modal.mode");

    expect(target).toMatchObject({
      analysisFieldRepresentation: "complex-vector-xyz",
      analysisFieldSource: "eigen-mode",
      analysisFieldView: "phase_rotated_real",
      analysisRunId: "runtime-run-17",
      analysisStageId: "eigen-stage",
      artifactRevision: "eigen-r9",
      equilibriumId: "eq-relax-r4",
      fieldId: "analysis:eigen:sample-0000:mode-0002",
      frequencyHz: 12.5e9,
      kContextKind: "finite_open",
      modeIndex: 2,
      resourceRef: "data/fields/analysis:eigen:sample-0000:mode-0002",
      sampleIndex: 0,
      studyProduct: "modal_eigen",
    });
    if (!target) throw new Error("Missing canonical modal field target");
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    selectExplorerNode({ selection } as KernelApi, target, "explorer");
    expect(selection.get().ref).toMatchObject({
      analysisRunId: "runtime-run-17",
      analysisStageId: "eigen-stage",
      artifactRevision: "eigen-r9",
      equilibriumId: "eq-relax-r4",
      fieldId: "analysis:eigen:sample-0000:mode-0002",
      frequencyHz: 12.5e9,
      kind: "results.resonance.modal.mode",
      representation: "complex-vector-xyz",
      resourceRef: "data/fields/analysis:eigen:sample-0000:mode-0002",
      source: "eigen-mode",
      studyProduct: "modal_eigen",
      type: "frequency-domain",
    });
  });

  it("publishes exact path sample identity for a canonical mode-at-k target", () => {
    const adapted = physicsFirstResultsSnapshotFromResources({
      currentRun: { revision: 18, run_id: "runtime-run-18" },
      dispersion: {
        path_metadata: {
          sampling: {
            kind: "path",
            points: [
              { k_vector: [0, 0, 0], label: "Γ" },
              { k_vector: [1e8, 0, 0], label: "X" },
            ],
            samples_per_segment: [4],
          },
        },
        status: "ready",
        text: [
          "sample_index,raw_mode_index,path_s_rad_per_m,frequency_hz,mode_field_id,mode_field_resource_key",
          "2,3,5e7,13e9,analysis:eigen:sample-0002:mode-0003,data/fields/analysis:eigen:sample-0002:mode-0003",
        ].join("\n"),
      },
      manifest: {
        result_manifest: {
          payload: {
            equilibrium_identity: "eq-path",
            requested_execution: { boundary_context: "floquet_periodic" },
            revision: "dispersion-r4",
            stage_id: "dispersion-stage",
            study_product: "modal_eigen",
          },
          status: "ready",
        },
      },
      spectrum: { status: "ready" },
    });
    const target = flattenExplorerNodes(buildPhysicsFirstResultsTree(adapted.snapshot))
      .find((node) => node.kind === "results.dispersion.modal.mode_at_k");

    expect(target).toMatchObject({
      fieldId: "analysis:eigen:sample-0002:mode-0003",
      kContextKind: "k_path",
      kPathCoordinateRadPerM: 5e7,
      modeIndex: 3,
      sampleIndex: 2,
      wavevectorKf: [5e7, 0, 0],
    });
  });

  it("publishes a concrete canonical driven field target with exact frequency identity", () => {
    const adapted = physicsFirstResultsSnapshotFromResources({
      currentRun: { revision: 19, run_id: "runtime-run-19" },
      manifest: {
        result_manifest: {
          payload: {
            equilibrium_identity: "eq-driven",
            requested_execution: { boundary_context: "finite_open" },
            resources: {
              response_field_resources: [{
                field_resource_id: "analysis:response:frequency-0004",
                frequency_index: 4,
              }],
            },
            revision: "response-r5",
            stage_id: "response-stage",
            study_product: "driven_response",
          },
          status: "ready",
        },
      },
      responseSweep: {
        payload: {
          points: [{
            frequency_hz: 8.25e9,
            frequency_index: 4,
            observable_id: "mx",
          }],
          schema_version: "magnetic_response_sweep.v2",
        },
        status: "ready",
      },
    });
    const target = flattenExplorerNodes(buildPhysicsFirstResultsTree(adapted.snapshot))
      .find((node) => node.kind === "results.resonance.driven.field");

    expect(target).toMatchObject({
      analysisFieldRepresentation: "complex-vector-xyz",
      analysisFieldSource: "frequency-response",
      analysisRunId: "runtime-run-19",
      analysisStageId: "response-stage",
      artifactRevision: "response-r5",
      equilibriumId: "eq-driven",
      fieldId: "analysis:response:frequency-0004",
      frequencyHz: 8.25e9,
      frequencyIndex: 4,
      kContextKind: "finite_open",
      observableId: "mx",
      resourceRef: fieldVectorResourceKey("analysis:response:frequency-0004"),
      studyProduct: "driven_response",
    });
  });

  it("does not fabricate a driven response map from modal path metadata and a response sweep", () => {
    const adapted = physicsFirstResultsSnapshotFromResources({
      currentRun: { revision: 21, run_id: "run-21" },
      dispersion: {
        path_metadata: {
          sampling: {
            kind: "path",
            points: [{ label: "Γ" }, { label: "X" }],
            samples_per_segment: [8],
          },
        },
        status: "ready",
      },
      manifest: {
        result_manifest: {
          payload: {
            equilibrium_identity: "eq-21",
            requested_execution: { boundary_context: "floquet_periodic" },
            stage_id: "response-21",
            study_product: "driven_response",
          },
          status: "ready",
        },
      },
      responseSweep: { status: "ready" },
    });

    expect(adapted.snapshot.entries[0]?.products.responseMap).toBeFalsy();
    expect(flattenExplorerNodes(buildPhysicsFirstResultsTree(adapted.snapshot)).map((node) => node.label))
      .not.toContain("Spectral Response Map · A(k,f)");
  });

  it("adapts explicit manifest provenance without trusting the manifest run placeholder", () => {
    const adapted = physicsFirstResultsSnapshotFromResources({
      currentRun: { revision: 17, run_id: "runtime-run-17" },
      dispersion: {
        path_metadata: {
          sampling: {
            kind: "path",
            points: [
              { k_vector: [0, 0, 0], label: "Γ" },
              { k_vector: [1e7, 0, 0], label: "X" },
            ],
            samples_per_segment: [8],
          },
        },
        status: "ready",
      },
      manifest: {
        result_manifest: {
          payload: {
            equilibrium_identity: "eq-relax-r4",
            requested_execution: {
              boundary_context: "floquet_periodic",
              k_sampling: "path",
            },
            revision: "eigen-r9",
            stage_id: "eigen-stage",
            study_product: "modal_eigen",
          },
          status: "ready",
        },
      },
      spectrum: { status: "ready" },
    });

    expect(adapted.contractGaps).toEqual([]);
    expect(adapted.snapshot).toMatchObject({
      resultContextRunId: "runtime-run-17",
      entries: [
        {
          artifactRevision: "eigen-r9",
          equilibriumId: "eq-relax-r4",
          kSampling: { kind: "path", label: "Γ–X", sampleCount: 9 },
          runId: "runtime-run-17",
          stageId: "eigen-stage",
          studyProduct: "modal_eigen",
        },
      ],
    });
  });

  it("fails closed when owner, equilibrium, or boundary evidence is absent", () => {
    const adapted = physicsFirstResultsSnapshotFromResources({
      currentRun: { revision: 2, run_id: "run-2" },
      manifest: {
        result_manifest: {
          payload: { stage_id: "eigen", study_product: "modal_eigen" },
          status: "ready",
        },
      },
      spectrum: { status: "ready" },
    });

    expect(adapted.snapshot.entries).toEqual([]);
    expect(adapted.contractGaps).toEqual([
      "Frequency-domain artifact does not publish equilibrium_identity",
      "Frequency-domain artifact does not publish boundary_context",
    ]);
  });
});
