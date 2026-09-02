import { readFileSync } from "node:fs";

import { describe, expect, expectTypeOf, it } from "vitest";

import type { components } from "@/kernel/api/generated/openapi-v2-types";
import type { FrequencyDomainJsonArtifactResource } from "@/kernel/api/apiTypes";

import {
  buildFrequencyDomainResultsTree,
  mapNavigatorArtifactState,
  mapResourceResultState,
  navigatorBranchesFromResource,
  navigatorFmrFromResource,
  navigatorKittelFitArtifactFromResource,
  navigatorResonanceFitsArtifactFromResource,
  navigatorResponseFromResource,
  navigatorFieldSweepFromResource,
  navigatorSpectrumFromResource,
  type NavigatorBranchesPayload,
  type NavigatorFmrPayload,
  type NavigatorResponsePayload,
  type NavigatorSpectrumPayload,
  paginateNavigatorItems,
  type FrequencyDomainNavigatorInput,
  type NavigatorArtifactDescriptor,
  type NavigatorModeDescriptor,
  type NavigatorSampleDescriptor,
} from "./resultsNavigatorModel";

const identity = {
  artifactRevision: "sha256:artifact-1",
  runId: "run-a",
  stageId: "stage-a",
};

const resultsNavigatorModuleUrl = new URL("./ResultsNavigatorModule.tsx", import.meta.url);

function fieldSweepArtifact(
  status: NavigatorArtifactDescriptor["status"] = "complete",
): NavigatorArtifactDescriptor {
  return {
    artifactPath: "eigen/field_sweep.v1.json",
    missingReason: null,
    resourceKey: "analysis:eigen:field-sweep",
    resourceRevision: "sha256:field-sweep-1",
    schemaVersion: "eigen/field_sweep.v1",
    status,
  };
}

function fieldSweepResource(): FrequencyDomainJsonArtifactResource {
  const scanAxis = {
    coordinate: "bias_field_a_per_m",
    display_conversions: [{ name: "mu0_H", scale: 1.2566370614e-6, unit: "T" }],
    kind: "bias_field",
    unit: "A/m",
  };
  const topology = {
    indexing: "global_xyz",
    mesh_id: "mesh:test",
    mode_axis: "mode",
    node_count: 4,
    sample_axis: "sample",
    topology_revision: "mesh-rev:1",
  };
  const samples = Array.from({ length: 15 }, (_, index) => {
    const sampleId = `bias-field-sample-${String(index).padStart(4, "0")}`;
    const modeId = `sample-${String(index).padStart(4, "0")}/mode-0000`;
    return {
      bias_field_a_per_m: [40_000 + index * 1_000, 0, 0],
      bias_field_mu0_t: [(40_000 + index * 1_000) * 1.2566370614e-6, 0, 0],
      branch_ids: [0],
      linearization_state_sha256: `sha256:linearization-${index}`,
      modes: [{
        angular_frequency_rad_per_s: 2 * Math.PI * (1e9 + index * 1e8),
        branch_id: 0,
        frequency_hz: 1e9 + index * 1e8,
        mode_artifact_path: `eigen/modes/sample_${String(index).padStart(4, "0")}/mode_0000.json`,
        mode_field_id: `analysis:eigen:sample-${String(index).padStart(4, "0")}:mode-0000`,
        mode_field_resource_key: `/v2/sessions/current/data/fields/analysis:eigen:sample-${String(index).padStart(4, "0")}:mode-0000/samples/vector`,
        mode_id: modeId,
        raw_mode_index: 0,
        residual_relative_l2: 1e-8,
        sample_id: sampleId,
        source_revision: "sha256:spectrum-1",
        status: "complete",
      }],
      operator_input_signature_sha256: `sha256:operator-${index}`,
      equilibrium_artifact_sha256: `sha256:equilibrium-${index}`,
      sample_id: sampleId,
      sample_index: index,
      scan_axis: scanAxis,
      status: "complete",
      topology,
    };
  });
  return {
    artifact_path: "eigen/field_sweep.v1.json",
    missing_reason: null,
    payload: {
      artifact_id: "analysis:eigen:field-sweep",
      completed_sample_count: 15,
      complete: true,
      content_sha256: "sha256:field-sweep-content",
      cross_artifact_refs: [
        { artifact: "eigen/spectrum.v2.json", relation: "source_spectrum", revision: "sha256:spectrum-1" },
        { artifact: "eigen/branches.v2.json", relation: "source_branches", revision: "sha256:branches-1" },
      ],
      requested_execution: {
        backend: "fem",
        device: "cpu",
        engine: "reference",
        execution_mode: "native",
        implementation_id: "fem.reference.v1",
        precision: "double",
        status: "complete",
      },
      requested_sample_count: 15,
      resolved_execution: {
        backend: "fem",
        device: "cpu",
        engine: "reference",
        execution_mode: "native",
        implementation_id: "fem.reference.v1",
        precision: "double",
        status: "complete",
      },
      revision: "sha256:field-sweep-1",
      samples,
      scan_axis: scanAxis,
      schema_version: "eigen/field_sweep.v1",
      scope_id: "scope:bias-field",
      source: { artifact: "eigen/spectrum.v2.json", kind: "modal_eigensolve", revision: "sha256:spectrum-1" },
      source_revision: "sha256:spectrum-1",
      stage_id: "stage-a",
      status: "complete",
      topology,
      units: {
        angular_frequency: "rad/s",
        bias_field: "A/m",
        bias_field_display: "T",
        frequency: "Hz",
      },
    },
    resource_key: "analysis:eigen:field-sweep",
    revision: "sha256:field-sweep-1",
    schema_version: "eigen/field_sweep.v1",
    status: "ready",
  } as unknown as FrequencyDomainJsonArtifactResource;
}

function artifact(
  status: NavigatorArtifactDescriptor["status"] = "complete",
): NavigatorArtifactDescriptor {
  return {
    artifactPath: "eigen/spectrum.v2.json",
    missingReason: null,
    resourceKey: "analysis:eigen:spectrum",
    resourceRevision: "sha256:artifact-1",
    schemaVersion: "eigen_spectrum.v2",
    status,
  };
}

function mode(index: number, modeId = `mode-${index}`): NavigatorModeDescriptor {
  return {
    branchId: "branch-0",
    displayModeIndex: index,
    frequencyHz: 1e9 + index,
    modeId,
    rawModeIndex: index,
  };
}

function sample(
  index: number,
  modes: readonly NavigatorModeDescriptor[] = [mode(index)],
): NavigatorSampleDescriptor {
  return {
    label: `Sample ${index}`,
    modes,
    sampleId: `sample-${index}`,
    sampleIndex: index,
  };
}

function input(
  patch: Partial<FrequencyDomainNavigatorInput> = {},
): FrequencyDomainNavigatorInput {
  return {
    identity,
    manifest: {
      eigenStatus: "available",
      responseStatus: "available",
    },
    resources: {
      branches: artifact(),
      dispersion: artifact(),
      response: artifact(),
      spectrum: artifact(),
    },
    spectrum: { samples: [sample(0)] },
    ...patch,
  };
}

describe("results navigator model", () => {
  it("builds the canonical frequency-domain hierarchy with resource-derived states", () => {
    const tree = buildFrequencyDomainResultsTree(input());
    const ids = tree.map((node) => node.id);
    const all = tree.flatMap((node) => node.children ?? []);

    expect(ids).toEqual(["results"]);
    expect(all.map((node) => node.label)).toEqual(["Runs"]);

    const frequencyDomain = all[0]?.children?.[0]?.children?.[0]?.children?.[0];
    expect(frequencyDomain?.label).toBe("Frequency Domain");
    expect(frequencyDomain?.children?.map((node) => node.label)).toEqual([
      "Overview",
      "Modal Eigen",
      "Driven Response",
      "FMR Views",
      "Validation & Provenance",
      "Artifacts & Exports",
    ]);

    const modal = frequencyDomain?.children?.find((node) => node.label === "Modal Eigen");
    expect(modal?.children?.map((node) => node.label)).toEqual([
      "Spectrum",
      "Field Sweep",
      "Dispersion",
      "Samples",
      "Branches",
    ]);
    expect(modal?.children?.find((node) => node.label === "Spectrum")?.status).toBe(
      "ready",
    );
  });

  it("does not report missing resources as ready or silently drop semantic nodes", () => {
    const tree = buildFrequencyDomainResultsTree(
      input({
        identity: null,
        manifest: null,
        resources: {
          branches: null,
          dispersion: null,
          response: null,
          spectrum: null,
        },
        spectrum: null,
      }),
    );
    const nodes = collectNodes(tree);
    const statusByLabel = new Map(nodes.map((node) => [node.label, node.status]));

    expect(statusByLabel.get("Overview")).toBe("missing");
    expect(statusByLabel.get("Spectrum")).toBe("missing");
    expect(statusByLabel.get("Driven Response")).toBe("missing");
    expect(statusByLabel.get("Modal Resonances")).toBe("unsupported");
    expect(nodes.some((node) => node.status === "ready" && node.resourceKey == null)).toBe(
      false,
    );
  });

  it("maps a corrupt artifact to error and retains an operator-facing reason", () => {
    const tree = buildFrequencyDomainResultsTree(
      input({
        resources: {
          branches: artifact(),
          dispersion: artifact(),
          response: artifact(),
          spectrum: artifact("corrupt"),
        },
        spectrum: null,
      }),
    );
    const spectrumNode = collectNodes(tree).find((node) => node.label === "Spectrum");
    expect(spectrumNode).toMatchObject({
      status: "error",
      statusReason: "Artifact payload is corrupt.",
    });
  });

  it("publishes stable mode node IDs even when display ordering changes", () => {
    const first = buildFrequencyDomainResultsTree(
      input({ spectrum: { samples: [sample(0, [mode(0, "stable-mode")])] } }),
    );
    const reordered = buildFrequencyDomainResultsTree(
      input({
        spectrum: {
          samples: [{ ...sample(4, [mode(99, "stable-mode")]), sampleId: "sample-0" }],
        },
      }),
    );

    const firstMode = collectNodes(first).find((node) => node.label === "Mode stable-mode");
    const reorderedMode = collectNodes(reordered).find(
      (node) => node.label === "Mode stable-mode",
    );
    expect(firstMode?.id).toBe(reorderedMode?.id);
  });

  it("publishes semantic mode and response detail nodes without inventing unavailable field payloads", () => {
    const tree = buildFrequencyDomainResultsTree(
      input({ response: { points: [{ frequencyIndex: 0, pointId: "point-a" }] } }),
    );
    const nodes = collectNodes(tree);
    const modeNode = nodes.find((node) => node.label === "Mode mode-0");
    const responsePoint = nodes.find((node) => node.label === "Point point-a");

    expect(modeNode?.children?.map((node) => node.label)).toEqual([
      "Metadata",
      "Field",
      "Residuals",
    ]);
    expect(modeNode?.children?.map((node) => node.status)).toEqual([
      "unsupported",
      "unsupported",
      "unsupported",
    ]);
    expect(modeNode?.children?.map((node) => node.selectionRef?.kind)).toEqual([
      "modal-detail",
      "modal-detail",
      "modal-detail",
    ]);

    expect(responsePoint?.children?.map((node) => node.label)).toEqual([
      "Observables",
      "Field",
    ]);
    expect(responsePoint?.children?.map((node) => node.status)).toEqual([
      "unsupported",
      "unsupported",
    ]);
    expect(responsePoint?.children?.map((node) => node.selectionRef?.kind)).toEqual([
      "response-detail",
      "response-detail",
    ]);
  });

  it("marks a sample with an absent stable mode ID as partial instead of inventing a selection", () => {
    const tree = buildFrequencyDomainResultsTree(
      input({
        spectrum: {
          samples: [sample(0, [{ ...mode(0), modeId: null }])],
        },
      }),
    );
    const modeNode = collectNodes(tree).find((node) => node.label === "Modes");
    expect(modeNode?.status).toBe("partial");
    expect(
      collectNodes(tree).some((node) => node.selectionRef?.kind === "modal-mode"),
    ).toBe(false);
  });

  it("paginates without a silent fixed slice and preserves total count", () => {
    const items = Array.from({ length: 130 }, (_, index) => ({
      id: `mode-${index}`,
    }));
    const page = paginateNavigatorItems(items, { page: 2, pageSize: 50 });

    expect(page.total).toBe(130);
    expect(page.pageCount).toBe(3);
    expect(page.items).toHaveLength(50);
    expect(page.items[0]?.id).toBe("mode-50");
    expect(page.items.at(-1)?.id).toBe("mode-99");
  });

  it("maps transport state and preserves partial data during stale refresh", () => {
    expect(
      mapResourceResultState({ data: null, error: null, revision: null, status: "idle" }),
    ).toBe("missing");
    expect(
      mapResourceResultState({ data: null, error: null, revision: null, status: "loading" }),
    ).toBe("loading");
    expect(
      mapResourceResultState({
        data: { status: "partial" },
        error: null,
        revision: "r1",
        status: "stale",
      }),
    ).toBe("partial");
    expect(
      mapResourceResultState({
        data: null,
        error: new Error("boom"),
        revision: null,
        status: "error",
      }),
    ).toBe("error");
    expect(
      mapResourceResultState({
        data: { status: "corrupt" },
        error: null,
        revision: "r2",
        status: "ready",
      }),
    ).toBe("error");
    expect(
      mapNavigatorArtifactState({
        ...artifact("partial"),
        missingReason: "Only one fit was published.",
      }),
    ).toBe("partial");
    expect(
      mapNavigatorArtifactState({
        ...artifact("corrupt"),
        missingReason: "Artifact checksum failed.",
      }),
    ).toBe("error");
  });

  it("accepts typed collection payloads for spectrum, branches, response, and FMR", () => {
    const spectrum: NavigatorSpectrumPayload = { samples: [sample(0)] };
    const branches: NavigatorBranchesPayload = {
      branches: [{ branchId: "branch-a", modeCount: 2 }],
    };
    const response: NavigatorResponsePayload = {
      points: [{ frequencyHz: 1e9, frequencyIndex: 0, pointId: "point-a" }],
    };
    const fmr: NavigatorFmrPayload = {
      peaks: [{ frequencyHz: 1e9, peakId: "peak-a" }],
    };
    const tree = buildFrequencyDomainResultsTree(
      input({ branches, response, spectrum, fmr: { payload: fmr, peaks: artifact() } }),
    );
    const nodes = collectNodes(tree);
    expect(nodes.find((node) => node.label === "Mode mode-0")?.status).toBe("ready");
    expect(nodes.find((node) => node.label === "Branch branch-a")?.status).toBe("ready");
    expect(nodes.find((node) => node.label === "Point point-a")?.status).toBe("ready");
    expect(nodes.find((node) => node.label === "Peak peak-a")?.status).toBe("ready");
  });

  it("keeps resonance-fit identity stable and distinct from its collection route", () => {
    const tree = buildFrequencyDomainResultsTree(
      input({
        fmr: {
          resonanceFits: artifact(),
          resonanceFitsPayload: { fits: [{ fitId: "fit-a" }] },
          states: { resonanceFits: "ready" },
        },
      }),
    );
    const nodes = collectNodes(tree);
    const fits = nodes.find((node) => node.label === "Resonance Fits");
    const fit = nodes.find((node) => node.label === "Fit fit-a");

    expect(fits?.inspectorId).toBe("results.frequency_domain.fmr_resonance_fits");
    expect(fit).toMatchObject({
      inspectorId: "results.frequency_domain.fmr_resonance_fit",
      selectionRef: {
        artifactRevision: "sha256:artifact-1",
        fitId: "fit-a",
        kind: "fmr-resonance-fit",
      },
      status: "ready",
    });
    expect(fit?.id).toContain("fit:fit-a");
  });

  it.each([
    ["partial", "partial"],
    ["corrupt", "error"],
  ] as const)("does not mark Fit ready when resonance fits are %s", (artifactStatus, expectedStatus) => {
    const tree = buildFrequencyDomainResultsTree(
      input({
        fmr: {
          resonanceFits: artifact(artifactStatus),
          resonanceFitsPayload: { fits: [{ fitId: "fit-a" }] },
          states: { resonanceFits: "ready" },
        },
      }),
    );

    expect(collectNodes(tree).find((node) => node.label === "Fit fit-a")?.status).toBe(
      expectedStatus,
    );
  });

  it("binds a modal selection to the spectrum resource revision, not the manifest revision", () => {
    const tree = buildFrequencyDomainResultsTree(
      input({
        resources: {
          branches: artifact(),
          dispersion: artifact(),
          response: artifact(),
          spectrum: { ...artifact(), resourceRevision: "spectrum-revision-2" },
        },
      }),
    );

    expect(collectNodes(tree).find((node) => node.label === "Mode mode-0")?.selectionRef).toMatchObject({
      artifactRevision: "spectrum-revision-2",
    });
  });

  it("fails fit artifacts closed when semantic payloads are missing, partial, or corrupt", () => {
    const resource = (
      payload: FrequencyDomainJsonArtifactResource["payload"],
      status = "ready",
      missingReason: string | null = null,
    ): FrequencyDomainJsonArtifactResource => ({
      artifact_path: "fmr/result.v1.json",
      missing_reason: missingReason,
      payload,
      resource_key: "analysis:frequency-domain:fmr:fit",
      schema_version: "fmr/result.v1",
      status,
    });

    expect(
      navigatorResonanceFitsArtifactFromResource(
        resource(null, "missing", "Resonance fits were not published."),
      ),
    ).toMatchObject({
      missingReason: "Resonance fits were not published.",
      status: "missing",
    });
    expect(
      navigatorResonanceFitsArtifactFromResource(
        resource({
          complete: false,
          fits: [],
          schema_version: "fmr/resonance_fits.v1",
          source_revision: "sha256:peaks",
          status: "partial",
          units: { frequency: "Hz", linewidth: "Hz" },
        }),
      ),
    ).toMatchObject({ status: "partial" });
    expect(
      navigatorResonanceFitsArtifactFromResource(
        resource({
          complete: true,
          schema_version: "fmr/resonance_fits.v1",
          source_revision: "sha256:peaks",
          status: "ready",
          units: { frequency: "Hz", linewidth: "Hz" },
        }),
      ),
    ).toMatchObject({
      missingReason: "Resonance fits artifact payload is corrupt.",
      status: "corrupt",
    });
    expect(
      navigatorKittelFitArtifactFromResource(
        resource({
          complete: true,
          parameters: [{ name: "gamma", unit: "rad/(s*T)", value: 1.76e11 }],
          points: [],
          schema_version: "fmr/kittel_fit.v1",
          source_revision: "sha256:field-sweep",
          status: "ready",
          units: { bias_field: "A/m", frequency: "Hz" },
        }),
      ),
    ).toMatchObject({ missingReason: null, status: "ready" });
  });

  it("adapts generated A2 payloads without reading an unknown transport body", () => {
    const spectrumResource = {
      artifact_path: "eigen/spectrum.v2.json",
      missing_reason: null,
      payload: {
        samples: [{
          modes: [{ frequency_hz: 1e9, mode_id: "sample-0000/mode-0000", raw_mode_index: 0 }],
          sample_id: "bias-field-sample-0000",
          sample_index: 0,
        }],
        schema_version: "eigen_spectrum.v2",
      },
      resource_key: "analysis:eigen:spectrum",
      schema_version: "eigen_spectrum.v2",
      status: "complete",
    } as FrequencyDomainJsonArtifactResource;
    const branchesResource = {
      ...spectrumResource,
      payload: {
        branches: [{ branch_id: 2, points: [{ raw_mode_index: 0, sample_index: 0 }] }],
        schema_version: "eigen_branches.v2",
      },
    } as FrequencyDomainJsonArtifactResource;
    const responseResource = {
      ...spectrumResource,
      payload: {
        complete: true,
        points: [{ frequency_hz: 1e9, frequency_index: 0, point_id: "frequency-point-0000" }],
        schema_version: "response_sweep.v2",
      },
    } as FrequencyDomainJsonArtifactResource;
    const fmrResource = {
      ...spectrumResource,
      payload: {
        peaks: [{
          frequency_hz: 1e9,
          mode_id: "sample-0000/mode-0000",
          peak_id: "peak-a",
          sample_id: "bias-field-sample-0000",
        }],
        schema_version: "fmr_peaks.v1",
      },
    } as FrequencyDomainJsonArtifactResource;

    expect(navigatorSpectrumFromResource(spectrumResource)?.samples[0]?.modes[0]).toMatchObject({
      frequencyHz: 1e9,
      modeId: "sample-0000/mode-0000",
      rawModeIndex: 0,
    });
    expect(navigatorBranchesFromResource(branchesResource)?.branches[0]).toMatchObject({
      branchId: "2",
      stableIdentityAvailable: true,
    });
    expect(navigatorResponseFromResource(responseResource)?.points[0]).toMatchObject({
      frequencyIndex: 0,
      pointId: "frequency-point-0000",
    });
    expect(navigatorFmrFromResource(fmrResource)?.peaks[0]).toMatchObject({
      peakId: "peak-a",
      stableIdentityAvailable: true,
    });
  });

  it("adapts the full typed field sweep without using extra and preserves physical samples", () => {
    const adapted = navigatorFieldSweepFromResource(fieldSweepResource());

    expect(adapted?.samples).toHaveLength(15);
    expect(adapted?.samples[0]).toMatchObject({
      biasFieldAPerM: [40_000, 0, 0],
      label: "μ₀ Hx = 50.3 mT",
      sampleId: "bias-field-sample-0000",
    });
    expect(adapted?.samples[0]?.biasFieldMu0T?.[0]).toBeCloseTo(0.050265482456, 15);
    expect(adapted?.axis).toMatchObject({
      coordinate: "bias_field_a_per_m",
      unit: "A/m",
    });
    expect(adapted?.axis?.displayConversions[0]).toMatchObject({
      name: "mu0_H",
      unit: "T",
    });
    expect(adapted?.samples[0]?.modes[0]).toMatchObject({
      modeFieldId: "analysis:eigen:sample-0000:mode-0000",
      modeFieldResourceKey: expect.stringContaining("/data/fields/"),
      modeId: "sample-0000/mode-0000",
      sampleId: "bias-field-sample-0000",
    });
  });

  it("keeps a legacy minimal field sweep partial instead of promoting it to ready", () => {
    const adapted = navigatorFieldSweepFromResource({
      artifact_path: "eigen/field_sweep.v1.json",
      missing_reason: null,
      payload: {
        samples: [],
        schema_version: "eigen/field_sweep.v1",
        status: "complete",
      },
      resource_key: "analysis:eigen:field-sweep",
      revision: "sha256:legacy-field-sweep",
      schema_version: "eigen/field_sweep.v1",
      status: "ready",
    } as unknown as FrequencyDomainJsonArtifactResource);

    expect(adapted).toMatchObject({ complete: false, status: "incomplete" });
    const tree = buildFrequencyDomainResultsTree(
      input({
        fieldSweep: adapted,
        resources: {
          branches: artifact(),
          dispersion: artifact(),
          fieldSweep: fieldSweepArtifact(),
          response: artifact(),
          spectrum: artifact(),
        },
      }),
    );
    expect(collectNodes(tree).find((node) => node.label === "Field Sweep")).toMatchObject({
      status: "partial",
    });
  });

  it("uses field-sweep samples as the modal source and binds mode fields to its revision", () => {
    const adapted = navigatorFieldSweepFromResource(fieldSweepResource());
    const tree = buildFrequencyDomainResultsTree(
      input({
        fieldSweep: adapted,
        resources: {
          branches: artifact(),
          dispersion: artifact(),
          fieldSweep: fieldSweepArtifact(),
          response: artifact(),
          spectrum: { ...artifact(), resourceRevision: "sha256:spectrum-1" },
        },
        spectrum: { samples: [sample(0)] },
      }),
    );
    const nodes = collectNodes(tree);
    const samples = nodes.filter((node) => node.kind === "results.frequency-domain.sample");
    const mode = nodes.find((node) => node.label === "Mode sample-0000/mode-0000");

    expect(samples).toHaveLength(15);
    expect(samples[0]?.label).toBe("μ₀ Hx = 50.3 mT");
    expect(mode).toMatchObject({
      resourceKey: "analysis:eigen:field-sweep",
      resourceRevision: "sha256:field-sweep-1",
      selectionRef: {
        artifactRevision: "sha256:field-sweep-1",
        modeId: "sample-0000/mode-0000",
        sampleId: "bias-field-sample-0000",
      },
      status: "ready",
    });
    expect(mode?.children?.find((child) => child.label === "Field")).toMatchObject({
      resourceKey: expect.stringContaining("/data/fields/"),
      status: "ready",
    });
  });

  it("marks stale companion revisions partial without falling back to array positions", () => {
    const adapted = navigatorFieldSweepFromResource(fieldSweepResource(), {
      branches: { branches: [{ branchId: "0" }] },
      branchesRevision: "sha256:branches-1",
      spectrum: { samples: [sample(0)] },
      spectrumRevision: "sha256:stale-spectrum",
    });
    const tree = buildFrequencyDomainResultsTree(
      input({
        fieldSweep: adapted,
        resources: {
          branches: artifact(),
          dispersion: artifact(),
          fieldSweep: fieldSweepArtifact(),
          response: artifact(),
          spectrum: { ...artifact(), resourceRevision: "sha256:stale-spectrum" },
        },
        spectrum: { samples: [sample(0)] },
      }),
    );

    expect(adapted?.joins.spectrum).toBe("stale");
    expect(collectNodes(tree).filter((node) => node.kind === "results.frequency-domain.sample"))
      .toHaveLength(15);
    expect(collectNodes(tree).find((node) => node.label === "Field Sweep")).toMatchObject({
      status: "partial",
      statusReason: expect.stringContaining("stale revisions"),
    });
  });

  it("exposes typed field-sweep input in the Results module without transport-body parsing", () => {
    const source = readFileSync(resultsNavigatorModuleUrl, "utf8");

    expect(source).toContain("navigatorFieldSweepFromResource");
    expect(source).toContain("fieldSweep: typedFieldSweep");
    expect(source).not.toContain("payload.extra");
  });

  it("propagates loading state into semantic groups when the typed payload is pending", () => {
    const tree = buildFrequencyDomainResultsTree(
      input({
        resources: {
          branches: null,
          dispersion: null,
          response: null,
          spectrum: null,
          states: {
            response: "loading",
            spectrum: "loading",
          },
        },
        spectrum: null,
      }),
    );
    const nodes = collectNodes(tree);
    expect(nodes.find((node) => node.label === "Spectrum")?.status).toBe("loading");
    expect(nodes.find((node) => node.label === "Frequency Sweep")?.status).toBe("loading");
    expect(nodes.find((node) => node.label === "Frequency Points")?.status).toBe("loading");
  });

  it("keeps typed FMR peak children stable and bounded by explicit pagination metadata", () => {
    const tree = buildFrequencyDomainResultsTree(
      input({
        fmr: {
          payload: {
            peaks: Array.from({ length: 75 }, (_, index) => ({
              frequencyHz: 1e9 + index,
              peakId: `peak-${index}`,
            })),
          },
          peaks: {
            ...artifact(),
            resourceKey: "analysis:frequency-domain:fmr:peaks",
          },
        },
      }),
    );
    const nodes = collectNodes(tree);
    const peaks = nodes.find((node) => node.label === "Peaks");

    expect(peaks?.collection).toEqual({ pageCount: 2, pageSize: 50, totalCount: 75 });
    expect(nodes.some((node) => node.id.endsWith(":peak:peak-74"))).toBe(true);
  });

  it("uses dedicated field-sweep and FMR resources without inferring them from the driven response", () => {
    const tree = buildFrequencyDomainResultsTree(
      input({
        fmr: {
          kittelFit: {
            ...artifact("corrupt"),
            missingReason: "Kittel payload checksum failed.",
          },
          peaks: {
            ...artifact(),
            resourceKey: "analysis:frequency-domain:fmr:peaks",
          },
          resonanceFits: {
            ...artifact("partial"),
            missingReason: "Only one resonance fit is available.",
          },
          states: {
            kittelFit: "error",
            peaks: "ready",
            resonanceFits: "partial",
          },
        },
        resources: {
          branches: artifact(),
          dispersion: artifact(),
          fieldSweep: {
            ...artifact("partial"),
            missingReason: "Field sweep stopped after sample 3.",
            resourceKey: "analysis:eigen:field-sweep",
          },
          response: artifact(),
          spectrum: artifact(),
          states: { fieldSweep: "partial" },
        },
      }),
    );
    const nodes = collectNodes(tree);

    expect(nodes.find((node) => node.label === "Field Sweep")).toMatchObject({
      resourceKey: "analysis:eigen:field-sweep",
      status: "partial",
      statusReason: "Field sweep stopped after sample 3.",
    });
    expect(nodes.find((node) => node.label === "Peaks")).toMatchObject({
      resourceKey: "analysis:frequency-domain:fmr:peaks",
      status: "partial",
    });
    expect(nodes.find((node) => node.label === "Resonance Fits")).toMatchObject({
      status: "partial",
      statusReason: "Only one resonance fit is available.",
    });
    expect(nodes.find((node) => node.label === "Kittel Fit")).toMatchObject({
      status: "error",
      statusReason: "Kittel payload checksum failed.",
    });
  });

  it("wires Navigator input to dedicated hooks instead of deriving FMR from driven response", () => {
    const source = readFileSync(resultsNavigatorModuleUrl, "utf8");

    expect(source).toContain("useFrequencyDomainEigenFieldSweepResource");
    expect(source).toContain("useFrequencyDomainFmrPeaksResource");
    expect(source).toContain("useFrequencyDomainFmrResonanceFitsResource");
    expect(source).toContain("useFrequencyDomainFmrKittelFitResource");
    expect(source).toContain("navigatorResonanceFitsArtifactFromResource");
    expect(source).toContain("navigatorKittelFitArtifactFromResource");
    expect(source).toContain("fieldSweep: navigatorArtifactFromResource(fieldSweep.data)");
    expect(source).toContain("navigatorFmrFromResource(fmrPeaks.data)");
    expect(source).not.toContain("navigatorFmrFromResource(response.data)");
  });

  it("reads stable identities directly from the generated frequency-domain payload union", () => {
    const source = readFileSync(new URL("./resultsNavigatorTypes.ts", import.meta.url), "utf8");

    expect(source).not.toContain("as typeof");
    expectTypeOf<
      components["schemas"]["FrequencyDomainSpectrumSamplePayload"]["sample_id"]
    >().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<
      components["schemas"]["FrequencyDomainSpectrumModePayload"]["mode_id"]
    >().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<
      components["schemas"]["FrequencyDomainResponsePointPayload"]["point_id"]
    >().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<
      components["schemas"]["FrequencyDomainFmrPeakPayload"]["sample_id"]
    >().toEqualTypeOf<string | null | undefined>();
    expectTypeOf<
      components["schemas"]["FrequencyDomainFmrPeakPayload"]["mode_id"]
    >().toEqualTypeOf<string | null | undefined>();
    expect(source).not.toContain("observable_id");
  });
});

function collectNodes(
  roots: ReturnType<typeof buildFrequencyDomainResultsTree>,
): ReturnType<typeof buildFrequencyDomainResultsTree> {
  const result: ReturnType<typeof buildFrequencyDomainResultsTree> = [];
  const visit = (nodes: ReturnType<typeof buildFrequencyDomainResultsTree>) => {
    for (const node of nodes) {
      result.push(node);
      if (node.children) visit(node.children);
    }
  };
  visit(roots);
  return result;
}
