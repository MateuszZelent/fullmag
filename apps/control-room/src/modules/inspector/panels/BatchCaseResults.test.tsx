import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MaterializedDatasetResource } from "@/kernel/api/apiTypes";
import {
  findElement,
  installSimulationPreparationTestDom,
  type TestElement,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

import { BatchCaseResults } from "./BatchCaseResults";

const fakes = vi.hoisted(() => ({
  kernel: vi.fn(),
  setSelection: vi.fn(),
  solution: vi.fn(),
  members: vi.fn(),
  artifacts: vi.fn(),
  materializedDataset: vi.fn(),
  scalar: vi.fn(),
}));

vi.mock("@/kernel/KernelContext", () => ({ useKernel: fakes.kernel }));

vi.mock("@/kernel/resources/solutionSetResources", () => ({
  useSolutionSetResource: fakes.solution,
  useSolutionSetMembersResource: fakes.members,
  useSolutionSetArtifactsResource: fakes.artifacts,
  useMaterializedDatasetResource: fakes.materializedDataset,
  useSolutionScalarResource: fakes.scalar,
  isSolutionScalarArtifact: (artifact: { kind: string; schema_id: string }) =>
    artifact.kind === "table" && artifact.schema_id === "fullmag.study.scalar_json@v1",
}));

describe("BatchCaseResults", () => {
  let dom: ReturnType<typeof installSimulationPreparationTestDom>;
  let roots: Array<ReturnType<typeof createRoot>>;

  beforeEach(() => {
    dom = installSimulationPreparationTestDom();
    roots = [];
    vi.clearAllMocks();
    fakes.kernel.mockReturnValue({ selection: { set: fakes.setSelection } });
    fakes.solution.mockReturnValue({
      data: {
        manifest_digest: "digest-a",
        revision: "4",
        solution_set_id: "solution-a",
      },
      error: null,
      status: "ready",
    });
    fakes.members.mockReturnValue({
      data: {
        items: [{
          artifact_count: 2,
          attempt_id: "attempt-1",
          execution_status: "completed",
          member_id: "member-1",
          ownership_epoch: "1",
          scientific_assessment: { status: "not_assessed", evidence_artifact_count: 0 },
          stage_id: "stage-1",
          task_id: "task-1",
        }],
        manifest_digest: "digest-a",
        next_after_member_id: null,
        project_id: "project-a",
        revision: "4",
        run_id: "run-a",
        solution_set_id: "solution-a",
      },
      error: null,
      status: "ready",
    });
    fakes.artifacts.mockImplementation((_projectId, _runId, _solutionSetId, _revision, memberId) => ({
      data: memberId ? {
        items: [
          {
            artifact_id: "scalar-artifact",
            byte_length: "48",
            integrity: "verified",
            kind: "table",
            object_ref: "cas://scalar",
            schema_id: "fullmag.study.scalar_json@v1",
            scientific_evidence: false,
          },
          {
            artifact_id: "dataset-artifact",
            byte_length: "120",
            integrity: "verified",
            kind: "other",
            object_ref: "cas://dataset-manifest",
            schema_id: "fullmag.materialized_dataset.v1",
            scientific_evidence: true,
          },
        ],
        manifest_digest: "digest-a",
        member_id: "member-1",
        next_after_artifact_id: null,
        project_id: "project-a",
        revision: "4",
        run_id: "run-a",
        solution_set_id: "solution-a",
      } : null,
      error: null,
      status: memberId ? "ready" : "idle",
    }));
    fakes.materializedDataset.mockImplementation((_projectId, _runId, _solutionSetId, _revision, _memberId, artifactId) => ({
      data: artifactId === "dataset-artifact" ? {
        artifact_id: "dataset-artifact",
        containing_solution_revision: "4",
        dataset: { dataset_id: "dataset-1", revision: "2" },
        field_id: "field-1",
        integrity: "verified",
        item_id: "item-1",
        manifest_byte_length: "120",
        manifest_object_ref: "cas://dataset-manifest",
        member_id: "member-1",
        project_id: "project-a",
        run_id: "run-a",
        sample_id: "sample-1",
        solution_set_id: "solution-a",
      } as unknown as MaterializedDatasetResource : null,
      error: null,
      status: artifactId ? "ready" : "idle",
    }));
    fakes.scalar.mockReturnValue({ data: null, error: null, status: "idle" });
  });

  afterEach(async () => {
    await act(async () => roots.forEach((root) => root.unmount()));
    dom.restore();
  });

  it("browses a digest-bound case and opens only its verified pinned dataset", async () => {
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    roots.push(root);

    await act(async () => root.render(
      <BatchCaseResults
        projectId="project-a"
        runId="run-a"
        solution={{
          manifest_digest: "digest-a",
          revision: "4",
          solution_set_id: "solution-a",
        }}
      />,
    ));
    expect(container.textContent).toContain("Attempt attempt-1 · scientific not_assessed");

    const member = findElement(
      container as unknown as TestElement,
      (element) => element.tagName === "BUTTON" && element.textContent?.includes("member-1"),
      "solution member",
    );
    await act(async () => member.click());

    const dataset = findElement(
      container as unknown as TestElement,
      (element) => element.tagName === "BUTTON" && element.textContent?.includes("dataset-artifact"),
      "materialized dataset artifact",
    );
    await act(async () => dataset.click());

    const inspect = findElement(
      container as unknown as TestElement,
      (element) => element.tagName === "BUTTON" && element.textContent?.trim() === "Inspect pinned dataset",
      "verified dataset inspection button",
    );
    await act(async () => inspect.click());

    expect(fakes.setSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "results.materialized_dataset",
        label: "dataset-1",
        ref: expect.objectContaining({
          artifactId: "dataset-artifact",
          containingRevision: "4",
          datasetId: "dataset-1",
          fieldId: "field-1",
          manifestObjectRef: "cas://dataset-manifest",
          memberId: "member-1",
          projectId: "project-a",
          runId: "run-a",
          solutionSetId: "solution-a",
        }),
      }),
      "inspector",
    );
  });

  it("blocks dataset inspection when verified metadata points at different bytes", async () => {
    fakes.materializedDataset.mockImplementation((_projectId, _runId, _solutionSetId, _revision, _memberId, artifactId) => ({
      data: artifactId === "dataset-artifact" ? {
        artifact_id: "dataset-artifact",
        containing_solution_revision: "4",
        dataset: { dataset_id: "dataset-1", revision: "2" },
        field_id: "field-1",
        integrity: "verified",
        item_id: "item-1",
        manifest_byte_length: "121",
        manifest_object_ref: "cas://dataset-manifest",
        member_id: "member-1",
        project_id: "project-a",
        run_id: "run-a",
        sample_id: "sample-1",
        solution_set_id: "solution-a",
      } as unknown as MaterializedDatasetResource : null,
      error: null,
      status: artifactId ? "ready" : "idle",
    }));
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    roots.push(root);

    await act(async () => root.render(
      <BatchCaseResults
        projectId="project-a"
        runId="run-a"
        solution={{
          manifest_digest: "digest-a",
          revision: "4",
          solution_set_id: "solution-a",
        }}
      />,
    ));
    const member = findElement(
      container as unknown as TestElement,
      (element) => element.tagName === "BUTTON" && element.textContent?.includes("member-1"),
      "solution member",
    );
    await act(async () => member.click());
    const dataset = findElement(
      container as unknown as TestElement,
      (element) => element.tagName === "BUTTON" && element.textContent?.includes("dataset-artifact"),
      "materialized dataset artifact",
    );
    await act(async () => dataset.click());

    expect(container.textContent).toContain("Verified dataset metadata does not match the selected artifact page entry.");
    expect(container.textContent).not.toContain("Inspect pinned dataset");
    expect(fakes.setSelection).not.toHaveBeenCalled();
  });

  it("pins scalar reads to the selected page digest, object reference, and byte length", async () => {
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    roots.push(root);

    await act(async () => root.render(
      <BatchCaseResults
        projectId="project-a"
        runId="run-a"
        solution={{
          manifest_digest: "digest-a",
          revision: "4",
          solution_set_id: "solution-a",
        }}
      />,
    ));
    const member = findElement(
      container as unknown as TestElement,
      (element) => element.tagName === "BUTTON" && element.textContent?.includes("member-1"),
      "solution member",
    );
    await act(async () => member.click());
    const scalar = findElement(
      container as unknown as TestElement,
      (element) => element.tagName === "BUTTON" && element.textContent?.includes("scalar-artifact"),
      "scalar artifact",
    );
    await act(async () => scalar.click());

    expect(fakes.scalar).toHaveBeenLastCalledWith(
      "project-a",
      "run-a",
      "solution-a",
      "4",
      "member-1",
      "scalar-artifact",
      {
        manifestDigest: "digest-a",
        objectRef: "cas://scalar",
        byteLength: "48",
      },
      { enabled: true },
    );
  });

  it("does not expose members from a page pinned to a different manifest digest", async () => {
    fakes.members.mockReturnValue({
      data: {
        items: [{ member_id: "member-from-other-revision" }],
        manifest_digest: "digest-b",
        next_after_member_id: null,
      },
      error: null,
      status: "ready",
    });
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    roots.push(root);

    await act(async () => root.render(
      <BatchCaseResults
        projectId="project-a"
        runId="run-a"
        solution={{
          manifest_digest: "digest-a",
          revision: "4",
          solution_set_id: "solution-a",
        }}
      />,
    ));

    expect(container.textContent).toContain("Member page manifest digest differs from the selected SolutionSet revision.");
    expect(container.textContent).not.toContain("member-from-other-revision");
  });
});
