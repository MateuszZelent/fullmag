import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MaterializedDatasetResource, SolutionSetArtifactResource } from "@/kernel/api/apiTypes";
import { findElement, installSimulationPreparationTestDom, type TestElement } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import type { ModuleProps } from "@/kernel/types";

import { SavedMaterializedArtifactRow } from "./SavedMaterializedArtifactRow";
import { SavedResultsBrowser } from "./SavedResultsBrowser";

const fakes = vi.hoisted(() => ({
  artifactPage: null as null | { items: SolutionSetArtifactResource[]; manifest_digest: string; next_after_artifact_id: string | null },
  metadata: new Map<string, { status: string; data: MaterializedDatasetResource | null; error: Error | null; refreshError?: Error | null }>(),
  reads: [] as string[], active: new Map<string, number>(), peak: 0,
  scalar: vi.fn(),
}));
vi.mock("@/kernel/persistence/ProjectDocumentStatus", () => ({
  useProjectDocumentSnapshot: () => ({ state: "ready", resource: { project_id: "project" } }),
}));
vi.mock("@/kernel/resources/projectRunResources", () => ({
  useProjectRunsResource: () => ({ status: "ready", data: { runs: [{ run_id: "run", catalog_state: "materialized" }] }, refetch() {} }),
  useProjectRunResource: () => ({ status: "ready", data: { tasks: [] }, refetch() {} }),
}));
vi.mock("@/kernel/resources/solutionSetResources", () => ({
  useSolutionSetDiscoveryResource: () => ({
    status: "ready", data: { items: [{ solution_set_id: "solution", revision: "2", manifest_digest: "digest" }] }, refetch() {},
  }),
  useSolutionSetResource: () => ({ status: "ready", data: { manifest_digest: "digest" } }),
  useSolutionSetMembersResource: () => ({
    status: "ready", data: { manifest_digest: "digest", items: [{ member_id: "member", task_id: "task", stage_id: "stage" }] },
  }),
  useSolutionSetArtifactsResource: () => ({ status: "ready", data: fakes.artifactPage }),
  useMaterializedDatasetResource: (
    project: string, run: string, solution: string, revision: string, member: string, artifact: string,
    options: { enabled: boolean },
  ) => {
    const key = JSON.stringify([project, run, solution, revision, member, artifact]);
    const enabled = options.enabled;
    useEffect(() => {
      if (!enabled) return;
      fakes.reads.push(key);
      fakes.active.set(key, (fakes.active.get(key) ?? 0) + 1);
      fakes.peak = Math.max(fakes.peak, [...fakes.active.values()].reduce((sum, count) => sum + count, 0));
      return () => {
        const count = (fakes.active.get(key) ?? 1) - 1;
        if (count) fakes.active.set(key, count); else fakes.active.delete(key);
      };
    }, [enabled, key]);
    return fakes.metadata.get(artifact) ?? { status: "loading", data: null, error: null };
  },
  useSolutionScalarResource: (...args: unknown[]) => {
    fakes.scalar(...args);
    return { status: "idle", data: null, error: null };
  },
  isSolutionScalarArtifact: (artifact: SolutionSetArtifactResource) => artifact.kind === "scalar",
}));

const artifact = (index: number): SolutionSetArtifactResource => ({
  artifact_id: "opaque-" + index, byte_length: "128", object_ref: String(index % 10).repeat(64),
  schema_id: "fullmag.materialized_dataset.v1", kind: "other",
});
function dataset(index: number, quantity: string, unit: string): MaterializedDatasetResource {
  const entry = artifact(index);
  return {
    project_id: "project", run_id: "run", solution_set_id: "solution", containing_solution_revision: "2",
    member_id: "member", artifact_id: entry.artifact_id, manifest_object_ref: entry.object_ref, manifest_byte_length: entry.byte_length,
    dataset: { dataset_id: "dataset-" + index, revision: "1" },
    field_id: "field-" + index, item_id: "item-" + index, sample_id: "sample-" + index,
    field: {
      descriptor: { quantity_id: quantity, unit, sample_location: "node" },
      coverage: { total_elements: "1145", component_count: quantity === "V_electric" ? "1" : "3" },
    },
  } as MaterializedDatasetResource;
}

function makeKernel() {
  let selection: { ref: unknown } = { ref: null };
  const set = vi.fn((next: { ref: unknown }) => { selection = next; });
  return {
    selection: { set, get: () => selection },
    visualization: { setSavedFieldPresentation: vi.fn() },
  } as unknown as ModuleProps["kernel"];
}

describe("saved field labels before inspection", () => {
  let dom: ReturnType<typeof installSimulationPreparationTestDom>;
  let root: ReturnType<typeof createRoot>;
  let container: TestElement;
  let kernel: ReturnType<typeof makeKernel>;

  beforeEach(() => {
    dom = installSimulationPreparationTestDom();
    container = dom.document.createElement("div") as unknown as TestElement;
    root = createRoot(container as unknown as Element);
    kernel = makeKernel();
    fakes.reads = []; fakes.active.clear(); fakes.peak = 0; fakes.metadata.clear(); fakes.scalar.mockClear();
    fakes.artifactPage = { items: [artifact(0), artifact(1), artifact(2)], manifest_digest: "digest", next_after_artifact_id: null };
    for (const [index, quantity, unit] of [[0, "V_electric", "V"], [1, "J_charge", "A/m^2"], [2, "H_ant", "A/m"]] as const) {
      fakes.metadata.set("opaque-" + index, { status: "ready", error: null, data: dataset(index, quantity, unit) });
    }
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    expect(fakes.active.size).toBe(0);
    dom.restore();
  });
  const render = () => act(async () => root.render(<SavedResultsBrowser kernel={kernel} moduleId="results-navigator" />));
  const clickText = async (text: string) => {
    const node = findElement(container, element => element.tagName === "BUTTON" && element.textContent === text, text);
    await act(async () => node.click());
  };
  const clickTitle = async (title: string) => {
    const node = findElement(container, element => element.tagName === "BUTTON" && element.getAttribute("title") === title, title);
    await act(async () => node.click());
  };
  async function openFields() {
    await render();
    await clickTitle("run");
    await clickTitle("digest");
    await clickTitle("task");
  }

  it("shows V/J/H quantities and units before Inspect and reuses each row owner for selection", async () => {
    await openFields();
    for (const label of ["V_electric [V]", "J_charge [A/m^2]", "H_ant [A/m]"]) expect(container.textContent).toContain(label);
    expect(container.textContent).toContain("1145 node");
    expect(container.textContent).not.toContain("Inspect pinned dataset");
    expect(fakes.reads).toHaveLength(3);
    await clickTitle("opaque-2 · " + artifact(2).object_ref);
    expect(container.textContent).toContain("Inspect pinned dataset");
    await clickText("Inspect pinned dataset");
    expect(fakes.reads).toHaveLength(3);
    expect([...fakes.active.values()]).toEqual([1, 1, 1]);
    expect(kernel.selection.set).toHaveBeenCalledTimes(1);
    expect(kernel.visualization.setSavedFieldPresentation).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: "opaque-2" }), "H_ant", "3",
    );
  });

  it("pages all fields with at most four simultaneous metadata owners and leaves scalar selection independent", async () => {
    fakes.artifactPage!.items = Array.from({ length: 9 }, (_, index) => artifact(index));
    fakes.artifactPage!.items.push({ ...artifact(9), kind: "scalar", schema_id: "fullmag.scalar.v1" });
    for (let index = 3; index < 9; index += 1) {
      fakes.metadata.set("opaque-" + index, { status: "ready", error: null, data: dataset(index, "m", "1") });
    }
    await openFields();
    expect(fakes.active.size).toBe(4); expect(fakes.reads).toHaveLength(4);
    expect(container.textContent).toContain("Fields page 1 / 3");
    await clickText("Next fields");
    expect(fakes.active.size).toBe(4);
    expect(container.textContent).toContain("opaque-4");
    expect(container.textContent).not.toContain("opaque-0");
    await clickText("Next fields");
    expect(fakes.active.size).toBe(1);
    expect(container.textContent).toContain("opaque-8");
    await clickText("Previous fields");
    expect(fakes.active.size).toBe(4);
    expect(fakes.peak).toBe(4);
    await clickTitle(artifact(9).object_ref);
    expect(fakes.scalar).toHaveBeenLastCalledWith(
      "project", "run", "solution", "2", "member", "opaque-9",
      { manifestDigest: "digest", objectRef: artifact(9).object_ref, byteLength: "128" },
      { enabled: true },
    );
  });

  it.each(["project_id", "run_id", "solution_set_id", "containing_solution_revision", "member_id", "artifact_id", "manifest_object_ref", "manifest_byte_length"] as const)(
    "does not label or inspect stale metadata with a foreign %s", async (key) => {
      fakes.metadata.get("opaque-2")!.data![key] = "foreign";
      await openFields();
      expect(container.textContent).not.toContain("H_ant [A/m]");
      expect(container.textContent).toContain("Manifest does not match this artifact");
      await clickTitle("opaque-2 · " + artifact(2).object_ref);
      expect(container.textContent).not.toContain("Inspect pinned dataset");
      expect(kernel.selection.set).not.toHaveBeenCalled();
    },
  );

  it.each(["error", "refreshError"] as const)("does not present cached labels as verified after a metadata %s", async (key) => {
    await openFields();
    fakes.metadata.get("opaque-2")![key] = new Error("Metadata connection unavailable");
    await render();
    expect(container.textContent).not.toContain("H_ant [A/m]");
    expect(container.textContent).toContain("Metadata connection unavailable");
    await clickTitle("opaque-2 · " + artifact(2).object_ref);
    expect(container.textContent).not.toContain("Inspect pinned dataset");
  });

  it("does not show a retained metadata label while that resource is loading", async () => {
    fakes.metadata.get("opaque-2")!.status = "loading";
    await openFields();
    expect(container.textContent).not.toContain("H_ant [A/m]");
    expect(container.textContent).toContain("Loading field metadata");
    await clickTitle("opaque-2 · " + artifact(2).object_ref);
    expect(container.textContent).not.toContain("Inspect pinned dataset");
  });

  it("disables its metadata owner for an unverified artifact page even with retained data", async () => {
    await act(async () => root.render(<SavedMaterializedArtifactRow
      artifact={artifact(2)} kernel={kernel} moduleId="results-navigator"
      projectId="project" runId="run" solutionSetId="solution" revision="2" memberId="member"
      pageManifestMatches={false} selected onSelect={() => {}}
    />));
    expect(fakes.reads).toHaveLength(0);
    expect(container.textContent).toContain("Artifact page is not verified");
    expect(container.textContent).not.toContain("H_ant [A/m]");
    expect(container.textContent).not.toContain("Inspect pinned dataset");
  });

  it("unmounts metadata owners and labels when the artifact-page digest becomes foreign", async () => {
    await openFields();
    fakes.artifactPage!.manifest_digest = "foreign";
    await render();
    expect(fakes.active.size).toBe(0);
    expect(container.textContent).not.toContain("H_ant [A/m]");
    expect(container.textContent).toContain("Artifact page manifest digest differs");
  });

  it("keeps SSR deterministic and never infers a quantity from an artifact ID", () => {
    const props = {
      artifact: { ...artifact(0), artifact_id: "H_ant-in-the-id" }, kernel,
      moduleId: "results-navigator", projectId: "project", runId: "run", solutionSetId: "solution",
      revision: "2", memberId: "member", pageManifestMatches: true, selected: false, onSelect() {},
    };
    const first = renderToStaticMarkup(<SavedMaterializedArtifactRow {...props} />);
    expect(first).toBe(renderToStaticMarkup(<SavedMaterializedArtifactRow {...props} />));
    expect(first).toContain("Saved field");
    expect(first).toContain("Loading field metadata");
    expect(first).not.toContain("H_ant [A/m]");
    expect(fakes.reads).toHaveLength(0);
  });
});
