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

function artifact(
  status: NavigatorArtifactDescriptor["status"] = "complete",
): NavigatorArtifactDescriptor {
  return {
    artifactPath: "eigen/spectrum.v2.json",
    missingReason: null,
    resourceKey: "analysis:eigen:spectrum",
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
    expect(collectNodes(tree).some((node) => node.selectionRef)).toBe(false);
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
