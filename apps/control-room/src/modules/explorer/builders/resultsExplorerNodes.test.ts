import { describe, expect, it } from "vitest";

import { flattenExplorerNodes } from "./buildModelTree";
import {
  buildPhysicsFirstResultsTree,
  physicsFirstResultsSnapshotFromResources,
  type PhysicsFirstResultEntry,
} from "./resultsExplorerNodes";

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
});

describe("physicsFirstResultsSnapshotFromResources", () => {
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
