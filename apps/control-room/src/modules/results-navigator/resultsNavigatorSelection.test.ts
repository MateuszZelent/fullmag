import { describe, expect, it } from "vitest";

import {
  buildModalNodeId,
  buildResponsePointNodeId,
  kernelSelectionForResultsNavigatorNode,
  inspectorSelectionKindForResultsNodeKind,
  modalSelectionRef,
  responseSelectionRef,
  resultsSelectionRefEquals,
  toKernelFrequencyDomainSelectionRef,
  toKernelFrequencyDomainNodeSelectionRef,
  type ModalSelectionRef,
  type ResponseSelectionRef,
} from "./resultsNavigatorSelection";
import { selectionRefEquals } from "@/kernel/selection/selectionTypes";

describe("results navigator stable selection references", () => {
  it("uses semantic sample/mode IDs and keeps display indexes out of identity", () => {
    const first: ModalSelectionRef = modalSelectionRef({
      artifactRevision: "sha256:run-a",
      branchId: "branch-0",
      modeId: "mode-a",
      rawModeIndex: 7,
      runId: "run-a",
      sampleId: "sample-a",
      sampleIndex: 0,
      stageId: "stage-a",
    });
    const reordered: ModalSelectionRef = modalSelectionRef({
      ...first,
      rawModeIndex: 0,
      sampleIndex: 12,
    });

    expect(first).toMatchObject({
      kind: "modal-mode",
      modeId: "mode-a",
      sampleId: "sample-a",
    });
    expect(buildModalNodeId(first)).toBe(buildModalNodeId(reordered));
    expect(buildModalNodeId(first)).toContain("sample-a");
    expect(buildModalNodeId(first)).toContain("mode-a");
    expect(buildModalNodeId(first)).not.toContain("raw-mode");
    expect(resultsSelectionRefEquals(first, reordered)).toBe(true);
    expect(
      toKernelFrequencyDomainSelectionRef(first, buildModalNodeId(first), "results.frequency-domain.mode"),
    ).toMatchObject({
      artifactRevision: "sha256:run-a",
      analysisRunId: "run-a",
      analysisStageId: "stage-a",
      modeId: "mode-a",
      modeIndex: 7,
      rawModeIndex: 7,
      resourceRef: "sha256:run-a",
      sampleId: "sample-a",
      sampleIndex: 0,
      type: "frequency-domain",
    });

    const changedStableMode = toKernelFrequencyDomainSelectionRef(
      { ...first, modeId: "mode-b", rawModeIndex: 7 },
      buildModalNodeId({ ...first, modeId: "mode-b" }),
      "results.eigen.mode",
    );
    expect(selectionRefEquals(
      toKernelFrequencyDomainSelectionRef(first, buildModalNodeId(first), "results.eigen.mode"),
      changedStableMode,
    )).toBe(false);
  });

  it("creates response refs from point IDs and keeps frequency index presentational", () => {
    const point: ResponseSelectionRef = responseSelectionRef({
      artifactRevision: "sha256:response",
      frequencyIndex: 41,
      observableId: "mx-transverse",
      pointId: "point-41",
      runId: "run-a",
      stageId: "stage-response",
    });

    expect(point.kind).toBe("response-point");
    expect(buildResponsePointNodeId(point)).toBe(
      "results:run:run-a:stage:stage-response:frequency-domain:response:point:point-41",
    );
    expect(buildResponsePointNodeId(responseSelectionRef({ ...point, frequencyIndex: 0 }))).toBe(
      buildResponsePointNodeId(point),
    );
    expect(
      toKernelFrequencyDomainSelectionRef(point, buildResponsePointNodeId(point), "results.frequency_response.frequency_point"),
    ).toMatchObject({
      artifactRevision: "sha256:response",
      pointId: "point-41",
      type: "frequency-domain",
    });
  });

  it("maps Results semantic nodes to the dedicated inspector selection vocabulary", () => {
    expect(inspectorSelectionKindForResultsNodeKind("results.frequency-domain.overview")).toBe(
      "results.frequency_domain.root",
    );
    expect(inspectorSelectionKindForResultsNodeKind("results.frequency-domain.spectrum")).toBe(
      "results.eigen.spectrum",
    );
    expect(inspectorSelectionKindForResultsNodeKind("results.frequency-domain.branches")).toBe(
      "results.eigen.branches",
    );
    expect(inspectorSelectionKindForResultsNodeKind("results.frequency-domain.fmr-views")).toBe(
      "results.frequency_domain.fmr",
    );
    expect(
      inspectorSelectionKindForResultsNodeKind(
        "results.frequency-domain.resonance-fits",
      ),
    ).toBe("results.frequency_domain.fmr_resonance_fits");
    expect(
      inspectorSelectionKindForResultsNodeKind(
        "results.frequency-domain.resonance-fit",
      ),
    ).toBe("results.frequency_domain.fmr_resonance_fits");
    expect(
      inspectorSelectionKindForResultsNodeKind(
        "results.frequency-domain.kittel-fit",
      ),
    ).toBe("results.frequency_domain.fmr_kittel_fit");
    expect(
      inspectorSelectionKindForResultsNodeKind(
        "results.frequency-domain.field-frequency-map",
      ),
    ).toBe("results.frequency_domain.response_map");
    expect(
      inspectorSelectionKindForResultsNodeKind(
        "results.frequency-domain.modal-driven-comparison",
      ),
    ).toBe("results.frequency_domain.comparison");
    expect(inspectorSelectionKindForResultsNodeKind("results.frequency-domain.validation")).toBe(
      "results.eigen.provenance",
    );
    expect(
      toKernelFrequencyDomainNodeSelectionRef(
        "results.frequency-domain.overview",
        "results:overview",
        "analysis:frequency-domain:manifest",
      ),
    ).toMatchObject({
      kind: "results.frequency_domain.root",
      nodeId: "results:overview",
      resourceRef: "analysis:frequency-domain:manifest",
      type: "frequency-domain",
    });

    expect(
      kernelSelectionForResultsNavigatorNode({
        id: "results:spectrum",
        kind: "results.frequency-domain.spectrum",
        resourceKey: "analysis:eigen:spectrum",
      }),
    ).toEqual({
      kind: "results.eigen.spectrum",
      ref: {
        kind: "results.eigen.spectrum",
        nodeId: "results:spectrum",
        resourceRef: "analysis:eigen:spectrum",
        type: "frequency-domain",
      },
    });
    expect(
      kernelSelectionForResultsNavigatorNode({
        id: "results:fmr:resonance-fits",
        kind: "results.frequency-domain.resonance-fits",
        resourceKey: "analysis:frequency-domain:fmr:resonance-fits",
      }),
    ).toEqual({
      kind: "results.frequency_domain.fmr_resonance_fits",
      ref: {
        kind: "results.frequency_domain.fmr_resonance_fits",
        nodeId: "results:fmr:resonance-fits",
        resourceRef: "analysis:frequency-domain:fmr:resonance-fits",
        type: "frequency-domain",
      },
    });
    expect(
      kernelSelectionForResultsNavigatorNode({
        id: "results:fmr:kittel-fit",
        kind: "results.frequency-domain.kittel-fit",
        resourceKey: "analysis:frequency-domain:fmr:kittel-fit",
      }),
    ).toEqual({
      kind: "results.frequency_domain.fmr_kittel_fit",
      ref: {
        kind: "results.frequency_domain.fmr_kittel_fit",
        nodeId: "results:fmr:kittel-fit",
        resourceRef: "analysis:frequency-domain:fmr:kittel-fit",
        type: "frequency-domain",
      },
    });
  });
});
