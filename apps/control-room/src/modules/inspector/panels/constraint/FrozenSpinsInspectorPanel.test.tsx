import { act, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_FROZEN_SPINS_RESOLVED_MASK_PATH } from "@/kernel/api/apiPaths";
import type { FieldMetaResource } from "@/kernel/api/apiTypes";

import {
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
  TestNode,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";

import {
  FrozenSpinsEditor as ScopedFrozenSpinsEditor,
  FrozenSpinsInspectorPanel,
  FrozenSpinsPreviewDetails,
  frozenSpinsPreviewTopologyFingerprint,
  resolveFrozenSpinsSolverBinding,
} from "./FrozenSpinsInspectorPanel";
import { createInspectorEditSessionStore, InspectorEditSessionProvider } from "../../InspectorEditSession";

const preview = {
  activation_candidate_token: "fsact-candidate-1",
  authority: "speculative_authoring_preview" as const,
  bounds_m: [[0, 1e-9], [0, 2e-9], [0, 3e-9]],
  current: true,
  fraction: 0.25,
  free_dof_count: 6,
  frozen_dof_count: 2,
  mask_resource: DATA_FROZEN_SPINS_RESOLVED_MASK_PATH.replace(
    "{mask_id}",
    "mask-1",
  ),
  mask_sha256: "sha256:mask",
  preview_id: "preview-1",
  requested: {
    selector_sha256: "sha256:selector",
    target_object_id: "film",
  },
  resolved: {
    all_active_dofs_frozen: false,
    constraint_ids: ["pin-edge"],
    effective_selector_sha256: "sha256:selector",
    evaluator_id: "fdm-cell-selection",
    qualification: "qualified",
    resolved_reference_sha256: "sha256:reference",
    schema_version: "fullmag.frozen-spins.resolved-plan.v1",
    topology_fingerprint: "sha256:topology",
  },
  revision: 8,
  schema_version: "fullmag.frozen-spins.preview.v1",
  solver_binding: "unbound" as const,
  warnings: [{ code: "bounded", message: "Preview is bounded." }],
};

const activationReceipt = {
  active_site_count: 8,
  activation_candidate_token_consumed: true,
  activation_scope: "authoring_commit" as const,
  authority: "speculative_authoring_preview" as const,
  definition: definitionFixture(),
  free_site_count: 6,
  frozen_site_count: 2,
  mask_resource: preview.mask_resource,
  mask_sha256: preview.mask_sha256,
  reference_sha256: preview.resolved.resolved_reference_sha256,
  preview_id: preview.preview_id,
  revision: 8,
  runtime_application: {
    apply_boundary: "next_runtime_plan" as const,
    current_runtime_unchanged: true,
    pending_revision: 8,
    state: "pending_runtime_plan" as const,
  },
  schema_version: "frozen_spins_activation.v1",
  solver_binding: "pending_runtime_activation" as const,
  source_state_revision: 41,
  topology_fingerprint: "sha256:topology",
};

const solverRuntime = {
  active_constraint_ids: ["pin-edge"],
  active_site_count: 8,
  constraint_activation_epochs: { "pin-edge": 1 },
  free_site_count: 6,
  frozen_site_count: 2,
  mask_sha256: "mask",
  reference_sha256: "sha256:reference",
  resolved_constraint_set_revision: 1,
  scalar_component_dof_count: 24,
  schema: "fullmag.frozen_spins.runtime-status.v1",
  source_state_revision: 41,
  topology_fingerprint: "sha256:topology",
  vector_dimension: 3,
};

const mocks = vi.hoisted(() => ({
  activatePreview: vi.fn(),
  authoringHistory: undefined as { record: ReturnType<typeof vi.fn> } | undefined,
  clear: vi.fn(),
  createPreview: vi.fn(),
  delete: vi.fn(),
  invalidate: vi.fn(),
  patch: vi.fn(),
  patchVisualizationDefaults: vi.fn(),
  flushVisualization: vi.fn(),
  queueVisualizationPatch: vi.fn(),
  refetchFieldMeta: vi.fn(),
  refetchSolverStatus: vi.fn(),
  requestScopeEpoch: "request-a",
  sessionEpoch: "epoch-a",
  sessionId: "session-a",
  scene: vi.fn(),
  setActiveViewportMainModule: vi.fn(),
  setFocusedSlot: vi.fn(),
  solverStatusData: null as unknown,
  definitionResource: {
    data: null as unknown,
    error: null as unknown,
  },
}));

vi.mock("@/kernel/KernelContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/kernel/KernelContext")>();
  return {
    ...actual,
    useKernel: () => ({
    api: {
      model: {
        frozenSpins: {
          activatePreview: mocks.activatePreview,
          createPreview: mocks.createPreview,
          delete: mocks.delete,
          patch: mocks.patch,
        },
        scene: mocks.scene,
      },
    },
    authoringHistory: mocks.authoringHistory,
    commands: { getSessionScopeKey: () => `session=${mocks.sessionId}&epoch=${mocks.sessionEpoch}&request_scope_epoch=${mocks.requestScopeEpoch}` },
    resources: { invalidate: mocks.invalidate },
    selection: { clear: mocks.clear },
    layout: {
      setActiveViewportMainModule: mocks.setActiveViewportMainModule,
      setFocusedSlot: mocks.setFocusedSlot,
    },
    visualizationSync: {
      flushNow: mocks.flushVisualization,
      queuePatch: mocks.queueVisualizationPatch,
    },
    visualization: {
      patchDefaults: mocks.patchVisualizationDefaults,
    },
  }),
  };
});

vi.mock("@/kernel/resources/studyRuntimeResources", () => ({
  useFieldMetaResource: () => ({
    data: {
      field_revision: 42,
      publication_bundle: { topology_hash: "sha256:topology" },
      source_revision: 41,
    },
    refetch: mocks.refetchFieldMeta,
  }),
  useSolverStatusResource: () => ({
    data: mocks.solverStatusData,
    refetch: mocks.refetchSolverStatus,
  }),
}));

vi.mock("@/kernel/resources/frozenSpinsResources", () => ({
  FROZEN_SPINS_ACTIVE_PREVIEW_RESOURCE_KEY: "model:frozen-spins:active-preview",
  frozenSpinsCollectionResourceKey: () => "model:frozen-spins",
  frozenSpinsDefinitionResourceKey: (id: string) => `model:frozen-spins:${id}`,
  useFrozenSpinsDefinitionResource: () => mocks.definitionResource,
}));

vi.mock("@/kernel/resources/useSessionScopedResourceKey", () => ({
  useSessionScopedResourceKey: (unscopedResourceKey: string) => ({
    resourceKey:
      `session=${mocks.sessionId}&epoch=${mocks.sessionEpoch}&request_scope_epoch=${mocks.requestScopeEpoch}|${unscopedResourceKey}`,
    sessionIdentity: {
      requestScopeEpoch: mocks.requestScopeEpoch,
      sessionEpoch: mocks.sessionEpoch,
      sessionId: mocks.sessionId,
    },
  }),
}));

function FrozenSpinsEditor(props: ComponentProps<typeof ScopedFrozenSpinsEditor>) {
  return (
    <ScopedFrozenSpinsEditor
      sessionScopeKey={`session=${mocks.sessionId}&epoch=${mocks.sessionEpoch}&request_scope_epoch=${mocks.requestScopeEpoch}`}
      {...props}
    />
  );
}

describe("FrozenSpinsInspectorPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authoringHistory = undefined;
    mocks.scene.mockReset();
    mocks.requestScopeEpoch = "request-a";
    mocks.sessionEpoch = "epoch-a";
    mocks.sessionId = "session-a";
    mocks.activatePreview.mockResolvedValue(activationReceipt);
    mocks.flushVisualization.mockResolvedValue(undefined);
    mocks.solverStatusData = null;
    mocks.createPreview.mockResolvedValue(preview);
    mocks.patch.mockResolvedValue({
      definition: definitionFixture(),
      revision: 8,
      runtime_application: activationReceipt.runtime_application,
    });
    mocks.definitionResource = {
      data: {
        definition: {
          enabled: true,
          id: "pin-edge",
          name: "Pinned edge",
          schema_version: "fullmag.frozen-spins.v1",
          selector: { kind: "in_object", object_id: "film" },
        },
        revision: 7,
      },
      error: null,
    };
  });

  it("uses the current full carrier fingerprint when publication metadata is absent", () => {
    const meta = {
      resolved_capability: {
        carriers: [
          {
            carrier_fingerprint: "sha256:part",
            payload_state: "current",
            scope_id: "part:film",
            scope_kind: "part",
          },
          {
            carrier_fingerprint: "sha256:topology-v3",
            payload_state: "current",
            scope_id: null,
            scope_kind: "full",
          },
        ],
      },
    } as unknown as FieldMetaResource;

    expect(frozenSpinsPreviewTopologyFingerprint(meta)).toBe("sha256:topology-v3");
  });

  it("fails closed when carrier fingerprints are ambiguous", () => {
    const meta = {
      resolved_capability: {
        carriers: [
          {
            carrier_fingerprint: "sha256:a",
            payload_state: "current",
            scope_id: "part:a",
            scope_kind: "part",
          },
          {
            carrier_fingerprint: "sha256:b",
            payload_state: "current",
            scope_id: "part:b",
            scope_kind: "part",
          },
        ],
      },
    } as unknown as FieldMetaResource;

    expect(frozenSpinsPreviewTopologyFingerprint(meta)).toBeNull();
  });

  it("renders complete preview evidence including freshness and warnings", () => {
    const markup = renderToStaticMarkup(
      <FrozenSpinsPreviewDetails preview={preview} />,
    );
    expect(markup).toContain("Frozen DOFs");
    expect(markup).toContain("speculative_authoring_preview");
    expect(markup).toContain("unbound");
    expect(markup).toContain("25.00%");
    expect(markup).toContain("sha256:mask");
    expect(markup).toContain("current");
    expect(markup).toContain("Preview is bounded.");
    expect(markup).toContain("Code: bounded");
  });

  it("confirms solver ownership only when the runtime certificate matches every activation identity", () => {
    expect(
      resolveFrozenSpinsSolverBinding(
        activationReceipt,
        solverRuntime,
        "pin-edge",
      ),
    ).toEqual({
      state: "confirmed",
      message: "Solver certificate matches the committed preview identity.",
    });
    expect(
      resolveFrozenSpinsSolverBinding(
        activationReceipt,
        { ...solverRuntime, mask_sha256: "solver-recomputed" },
        "pin-edge",
      ).state,
    ).toBe("mismatch");
    expect(
      resolveFrozenSpinsSolverBinding(
        activationReceipt,
        { ...solverRuntime, reference_sha256: "solver-recomputed" },
        "pin-edge",
      ).state,
    ).toBe("mismatch");
    expect(
      resolveFrozenSpinsSolverBinding(
        activationReceipt,
        { ...solverRuntime, source_state_revision: null },
        "pin-edge",
      ).state,
    ).toBe("confirmed");
    expect(
      resolveFrozenSpinsSolverBinding(
        activationReceipt,
        { ...solverRuntime, frozen_site_count: 3 },
        "pin-edge",
      ).state,
    ).toBe("mismatch");
  });

  it("switches 3D to the solver-owned frozen_spins quantity after certificate confirmation", async () => {
    mocks.solverStatusData = { frozen_spins: solverRuntime };
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <FrozenSpinsEditor
          definition={definitionFixture()}
          objectId="film"
          regionId={null}
          revision={7}
        />,
      ));
      expect(findButton(container, "Preview mask").disabled).toBe(false);
      await act(async () => findButton(container, "Preview mask").click());
      await act(async () => findButton(container, "Commit preview").click());
      await act(async () =>
        findButton(container, "Show solver frozen_spins in 3D").click(),
      );

      expect(mocks.queueVisualizationPatch).toHaveBeenCalledWith({
        active_quantity_id: "frozen_spins",
        field_component: null,
        quantity: {
          active_quantity_id: "frozen_spins",
          field_component: null,
        },
      });
      expect(mocks.flushVisualization).toHaveBeenCalledTimes(1);
      expect(mocks.setActiveViewportMainModule).toHaveBeenCalledWith("viewport-3d");
      expect(mocks.setFocusedSlot).toHaveBeenCalledWith("viewport-main");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("requests a revision-bound preview and publishes only its preview identity", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () =>
        root.render(
          <FrozenSpinsEditor
            definition={{
              enabled: true,
              id: "pin-edge",
              name: "Pinned edge",
              schema_version: "fullmag.frozen-spins.v1",
              selector: {
                kind: "in_region",
                object_id: "film",
                region_id: "edge",
              },
            }}
            objectId="film"
            regionId="edge"
            revision={7}
          />,
        ),
      );
      await act(async () => findButton(container, "Preview mask").click());

      expect(mocks.createPreview).toHaveBeenCalledWith({
        expected_revision: 7,
        expected_source_state_revision: 42,
        expected_topology_fingerprint: "sha256:topology",
        selector: {
          kind: "in_region",
          object_id: "film",
          region_id: "edge",
        },
        stage_id: null,
        target_object_id: "film",
      }, { sessionScopeKey: "session=session-a&epoch=epoch-a&request_scope_epoch=request-a" });
      expect(mocks.invalidate).toHaveBeenCalledWith(
        "model:frozen-spins:active-preview",
        "preview-1",
      );
      expect(container.textContent).toContain("25.00%");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("forwards the active session scope to every Frozen Spins write", async () => {
    const sessionScopeKey = "session=session-a&epoch=epoch-a&request_scope_epoch=request-a";
    mocks.delete.mockResolvedValueOnce({ revision: 9 });
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <FrozenSpinsEditor
          definition={definitionFixture()}
          objectId="film"
          regionId={null}
          revision={7}
          sessionScopeKey={sessionScopeKey}
        />,
      ));
      await editDefinitionName(container);
      await act(async () => findButton(container, "Apply").click());
      expect(mocks.patch).toHaveBeenCalledWith(
        "pin-edge",
        expect.objectContaining({ definition: expect.objectContaining({ name: "Edited pinned edge" }) }),
        { sessionScopeKey: "session=session-a&epoch=epoch-a&request_scope_epoch=request-a" },
      );
      await act(async () => findButton(container, "Preview mask").click());
      await act(async () => findButton(container, "Commit preview").click());
      await act(async () => findButton(container, "Delete").click());

      expect(mocks.patch).toHaveBeenCalledWith(
        "pin-edge",
        expect.objectContaining({ expected_revision: 7, definition: expect.objectContaining({ name: "Edited pinned edge" }) }),
        { sessionScopeKey },
      );
      expect(mocks.createPreview).toHaveBeenCalledWith(
        expect.objectContaining({ expected_revision: 8 }),
        { sessionScopeKey },
      );
      expect(mocks.activatePreview).toHaveBeenCalledWith(
        "preview-1",
        expect.objectContaining({ expected_revision: 8 }),
        { sessionScopeKey },
      );
      expect(mocks.delete).toHaveBeenCalledWith(
        "pin-edge",
        expect.objectContaining({ expected_revision: 8 }),
        { sessionScopeKey },
      );
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it.each([undefined, null])("preserves automatic membership %s when applying an unrelated edit", async (membership) => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <FrozenSpinsEditor
          definition={{
            ...definitionFixture(), membership,
            selector: { kind: "ref", selection_id: "state-dependent-selection" },
          }}
          objectId="film" regionId={null} revision={7}
        />,
      ));
      expect(findByAttribute(container, "aria-label", "Membership").value).toBe("automatic");
      expect(findButton(container, "Apply").disabled).toBe(true);
      await editDefinitionName(container);
      await act(async () => findButton(container, "Apply").click());
      expect(mocks.patch.mock.calls[0]![1].definition.membership).toBe(membership);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("allows an explicit membership policy to return to canonical automatic resolution", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <FrozenSpinsEditor
          definition={{ ...definitionFixture(), membership: { kind: "snapshot_at_activation" } }}
          objectId="film" regionId={null} revision={7}
        />,
      ));
      const membership = findByAttribute(container, "aria-label", "Membership");
      expect(membership.value).toBe("snapshot_at_activation");
      await act(async () => {
        membership.value = "automatic";
        membership.dispatchEvent(new TestEvent("change", { bubbles: true }));
      });
      await act(async () => findButton(container, "Apply").click());
      expect(mocks.patch.mock.calls[0]![1].definition.membership).toBeNull();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it.each(["1, ,3", "x,2,3", "1,2", "0, 0, 1"])("blocks numeric draft %j in both local and global actions, then reverts it", async (text) => {
    const harness = await mountNumericEditor();
    try {
      await harness.edit("Axis", text);
      expect(findByAttribute(harness.container, "aria-label", "Axis").value).toBe(text);
      expect(harness.store.getCurrentSession()).toMatchObject({ dirty: true, valid: false });
      expect(findButton(harness.container, "Apply").disabled).toBe(true);
      expect(findButton(harness.container, "Preview mask").disabled).toBe(true);
      expect(findButton(harness.container, "Delete").disabled).toBe(true);
      let applied: unknown;
      await act(async () => { applied = await harness.store.getCurrentSession()!.apply(); });
      expect(applied).toBe(false);
      await act(async () => findButton(harness.container, "Preview mask").click());
      expect(mocks.patch).not.toHaveBeenCalled();
      expect(mocks.createPreview).not.toHaveBeenCalled();
      await act(async () => harness.store.getCurrentSession()!.reset());
      expect(findByAttribute(harness.container, "aria-label", "Axis").value).toBe("1, 0, 0");
      expect(harness.store.getCurrentSession()).toMatchObject({ dirty: false, valid: true });
    } finally { await harness.dispose(); }
  });

  it("commits a complete vector with explicit zero on Enter", async () => {
    const harness = await mountNumericEditor();
    try {
      await harness.edit("Axis", "0, 0, 1");
      await harness.key("Axis", "Enter");
      expect(harness.store.getCurrentSession()).toMatchObject({ dirty: true, valid: true });
      await act(async () => findButton(harness.container, "Apply").click());
      expect(mocks.patch.mock.calls[0]![1].definition.selector.value.axis).toEqual([0, 0, 1]);
    } finally { await harness.dispose(); }
  });

  it("keeps raw edits and global invalid state after an older Apply ACK", async () => {
    let resolvePatch!: (value: unknown) => void;
    mocks.patch.mockReturnValueOnce(new Promise((resolve) => { resolvePatch = resolve; }));
    const harness = await mountNumericEditor();
    try {
      await editDefinitionName(harness.container);
      await act(async () => findButton(harness.container, "Apply").click());
      await harness.edit("Axis", "1, ,3");
      await act(async () => resolvePatch({ definition: { ...numericDefinitionFixture(), name: "Edited pinned edge" }, revision: 8 }));
      expect(findByAttribute(harness.container, "aria-label", "Axis").value).toBe("1, ,3");
      expect(harness.store.getCurrentSession()).toMatchObject({ dirty: true, valid: false });
      await act(async () => harness.store.getCurrentSession()!.reset());
      expect(findByAttribute(harness.container, "aria-label", "Name").value).toBe("Edited pinned edge");
      expect(findByAttribute(harness.container, "aria-label", "Axis").value).toBe("1, 0, 0");
      expect(harness.store.getCurrentSession()).toMatchObject({ dirty: false, valid: true });
    } finally { await harness.dispose(); }
  });

  it("does not arm a preview candidate while a newer raw edit is unresolved", async () => {
    let resolvePreview!: (value: unknown) => void;
    mocks.createPreview.mockReturnValueOnce(new Promise((resolve) => { resolvePreview = resolve; }));
    const harness = await mountNumericEditor();
    try {
      await act(async () => findButton(harness.container, "Preview mask").click());
      await harness.edit("Axis", "1, ,3");
      await act(async () => resolvePreview(preview));
      expect(findButton(harness.container, "Commit preview").disabled).toBe(true);
      await act(async () => findButton(harness.container, "Commit preview").click());
      expect(mocks.activatePreview).not.toHaveBeenCalled();
      expect(harness.store.getCurrentSession()).toMatchObject({ dirty: true, valid: false });
    } finally { await harness.dispose(); }
  });

  it("protects selector structure while numeric text is unresolved", async () => {
    const harness = await mountNumericEditor();
    try {
      await harness.edit("Axis", "1, ,3");
      const operator = findByAttribute(harness.container, "aria-label", "Operator");
      const scalarKind = findByAttribute(harness.container, "aria-label", "Scalar kind");
      expect(operator.disabled).toBe(true);
      expect(scalarKind.disabled).toBe(true);
      await act(async () => {
        operator.value = "all_magnetic";
        operator.dispatchEvent(new TestEvent("change", { bubbles: true }));
      });
      expect(findByAttribute(harness.container, "data-selection-expression-kind").getAttribute("data-selection-expression-kind")).toBe("approx");
      expect(findByAttribute(harness.container, "aria-label", "Axis").value).toBe("1, ,3");
      await harness.key("Axis", "Escape");
      expect(operator.disabled).toBe(false);
      expect(scalarKind.disabled).toBe(false);
    } finally { await harness.dispose(); }
  });

  it("does not move a numeric draft to the next clause when removing a sibling", async () => {
    const first = numericDefinitionFixture();
    const harness = await mountNumericEditor({
      ...first,
      selector: {
        kind: "and",
        expressions: [first.selector, { ...first.selector, value: { kind: "magnetization_dot", axis: [0, 1, 0] } }],
      },
    });
    try {
      await harness.edit("Axis", "1, ,3");
      const remove = findButton(harness.container, "Remove clause");
      expect(remove.disabled).toBe(true);
      await act(async () => remove.click());
      expect(findElements(harness.container, (element) => element.getAttribute("aria-label") === "Axis")).toHaveLength(2);
      await harness.key("Axis", "Escape");
      await act(async () => remove.click());
      expect(findElements(harness.container, (element) => element.getAttribute("aria-label") === "Axis")).toHaveLength(1);
      expect(findByAttribute(harness.container, "aria-label", "Axis").value).toBe("0, 1, 0");
      expect(harness.store.getCurrentSession()).toMatchObject({ dirty: true, valid: true });
    } finally { await harness.dispose(); }
  });

  it("commits zero tolerance without allowing blank scalar text to fall back", async () => {
    const definition = numericDefinitionFixture();
    const harness = await mountNumericEditor({ ...definition, selector: { ...definition.selector, atol: 1 } });
    try {
      await harness.edit("Absolute tolerance", "");
      await harness.key("Absolute tolerance", "Enter");
      expect(harness.store.getCurrentSession()).toMatchObject({ dirty: true, valid: false });
      expect(findByAttribute(harness.container, "aria-label", "Absolute tolerance").value).toBe("");
      await harness.edit("Absolute tolerance", "0");
      await harness.key("Absolute tolerance", "Enter");
      await act(async () => findButton(harness.container, "Apply").click());
      expect(mocks.patch.mock.calls[0]![1].definition.selector.atol).toBe(0);
    } finally { await harness.dispose(); }
  });

  it("ignores a preview response after its session scope is replaced", async () => {
    let resolvePreview!: (value: unknown) => void;
    mocks.createPreview.mockReturnValueOnce(new Promise((resolve) => { resolvePreview = resolve; }));
    const harness = await mountNumericEditor();
    try {
      await act(async () => findButton(harness.container, "Preview mask").click());
      mocks.sessionId = "session-b";
      await act(async () => resolvePreview(preview));
      expect(findOptionalButton(harness.container, "Commit preview")).toBeNull();
      expect(mocks.invalidate).not.toHaveBeenCalled();
    } finally { await harness.dispose(); }
  });

  it("requires clean edits before Delete and ignores a delete ACK from a replaced session", async () => {
    let resolveDelete!: (value: unknown) => void;
    mocks.delete.mockReturnValueOnce(new Promise((resolve) => { resolveDelete = resolve; }));
    const harness = await mountNumericEditor();
    try {
      await editDefinitionName(harness.container);
      expect(findButton(harness.container, "Delete").disabled).toBe(true);
      await act(async () => findButton(harness.container, "Revert").click());
      await act(async () => findButton(harness.container, "Delete").click());
      mocks.sessionId = "session-b";
      await act(async () => resolveDelete({ revision: 8 }));
      expect(mocks.clear).not.toHaveBeenCalled();
      expect(mocks.invalidate).not.toHaveBeenCalled();
    } finally { await harness.dispose(); }
  });

  it("keeps a raw numeric edit while adopting unrelated fields from a newer revision", async () => {
    const harness = await mountNumericEditor();
    try {
      await harness.edit("Axis", "0, ,1");
      await harness.renderDefinition({ ...numericDefinitionFixture(), name: "Server name" }, 8);
      expect(findByAttribute(harness.container, "aria-label", "Name").value).toBe("Server name");
      expect(findByAttribute(harness.container, "aria-label", "Axis").value).toBe("0, ,1");
      await harness.edit("Axis", "0, 0, 1");
      await harness.blur("Axis");
      await act(async () => findButton(harness.container, "Apply").click());
      expect(mocks.patch.mock.calls[0]![1]).toMatchObject({
        expected_revision: 8,
        definition: { name: "Server name", selector: { value: { axis: [0, 0, 1] } } },
      });
    } finally { await harness.dispose(); }
  });

  it("retains raw fields and blocks a conflicting server selector until Revert", async () => {
    const harness = await mountNumericEditor();
    try {
      await harness.edit("Axis", "0, ,1");
      await harness.renderDefinition({ ...numericDefinitionFixture(), selector: { kind: "all_magnetic" } }, 8);
      expect(findByAttribute(harness.container, "aria-label", "Axis").value).toBe("0, ,1");
      await harness.edit("Axis", "0, 0, 1");
      await harness.key("Axis", "Enter");
      expect(harness.store.getCurrentSession()).toMatchObject({ dirty: true, valid: false });
      expect(findButton(harness.container, "Preview mask").disabled).toBe(true);
      await act(async () => { expect(await harness.store.getCurrentSession()!.apply()).toBe(false); });
      expect(mocks.patch).not.toHaveBeenCalled();
      await act(async () => findButton(harness.container, "Revert").click());
      expect(findByAttribute(harness.container, "data-selection-expression-kind").getAttribute("data-selection-expression-kind")).toBe("all_magnetic");
      expect(harness.store.getCurrentSession()).toMatchObject({ dirty: false, valid: true });
    } finally { await harness.dispose(); }
  });

  it("does not roll the current baseline back to an older Apply ACK", async () => {
    let resolvePatch!: (value: unknown) => void;
    mocks.patch.mockReturnValueOnce(new Promise((resolve) => { resolvePatch = resolve; }));
    const harness = await mountNumericEditor();
    try {
      await editDefinitionName(harness.container);
      await act(async () => findButton(harness.container, "Apply").click());
      await harness.renderDefinition({ ...numericDefinitionFixture(), name: "Newer server name" }, 9);
      await act(async () => resolvePatch({ definition: { ...numericDefinitionFixture(), name: "Edited pinned edge" }, revision: 8 }));
      expect(harness.store.getCurrentSession()).toMatchObject({ dirty: true, valid: false });
      await act(async () => findButton(harness.container, "Revert").click());
      expect(findByAttribute(harness.container, "aria-label", "Name").value).toBe("Newer server name");
      await editDefinitionName(harness.container);
      await act(async () => findButton(harness.container, "Apply").click());
      expect(mocks.patch.mock.calls[1]![1].expected_revision).toBe(9);
    } finally { await harness.dispose(); }
  });

  it("keeps a clean Apply disabled without submitting a write", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <FrozenSpinsEditor definition={definitionFixture()} objectId="film" regionId={null} revision={7} />,
      ));
      expect(findButton(container, "Apply").disabled).toBe(true);
      await act(async () => findButton(container, "Apply").click());
      expect(mocks.patch).not.toHaveBeenCalled();
      expect(mocks.scene).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("ignores a late write ACK after the editor is unmounted", async () => {
    let resolvePatch!: (value: unknown) => void;
    mocks.patch.mockReturnValueOnce(new Promise((resolve) => { resolvePatch = resolve; }));
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <FrozenSpinsEditor
          definition={definitionFixture()}
          objectId="film"
          regionId={null}
          revision={7}
        />,
      ));
      await editDefinitionName(container);
      await act(async () => findButton(container, "Apply").click());
      expect(mocks.patch).toHaveBeenCalledWith(
        "pin-edge",
        expect.objectContaining({ definition: expect.objectContaining({ name: "Edited pinned edge" }) }),
        { sessionScopeKey: "session=session-a&epoch=epoch-a&request_scope_epoch=request-a" },
      );
      await act(async () => root.unmount());
      await act(async () => resolvePatch({
        definition: definitionFixture(),
        revision: 8,
      }));

      expect(mocks.invalidate).not.toHaveBeenCalled();
      expect(mocks.clear).not.toHaveBeenCalled();
    } finally {
      dom.restore();
    }
  });

  it("records an authored Apply after the Frozen Spins ACK advances the scene", async () => {
    const record = vi.fn();
    mocks.authoringHistory = { record };
    const before = { objects: [], revision: 7 };
    const after = { objects: [], revision: 8 };
    mocks.scene.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <FrozenSpinsEditor
          definition={definitionFixture()}
          objectId="film"
          regionId={null}
          revision={7}
        />,
      ));
      await editDefinitionName(container);
      await act(async () => findButton(container, "Apply").click());
      expect(mocks.patch).toHaveBeenCalledWith(
        "pin-edge",
        expect.objectContaining({ definition: expect.objectContaining({ name: "Edited pinned edge" }) }),
        { sessionScopeKey: "session=session-a&epoch=epoch-a&request_scope_epoch=request-a" },
      );

      expect(mocks.patch).toHaveBeenCalledWith("pin-edge", expect.objectContaining({
        definition: expect.objectContaining({ name: "Edited pinned edge" }),
        expected_revision: 7,
      }), { sessionScopeKey: "session=session-a&epoch=epoch-a&request_scope_epoch=request-a" });
      expect(record).toHaveBeenCalledWith(expect.objectContaining({
        before,
        after,
        committedRevision: 8,
        label: "Update Frozen Spins definition",
      }));
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("refreshes field identity after a stale preview revision so the user can retry", async () => {
    mocks.createPreview.mockRejectedValueOnce(
      new Error("selection_stale_revision: expected source-state revision 4, current 5"),
    );
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <FrozenSpinsEditor
          definition={definitionFixture()}
          objectId="film"
          regionId={null}
          revision={7}
        />,
      ));
      await act(async () => findButton(container, "Preview mask").click());

      expect(mocks.refetchFieldMeta).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain("Current field identity was refreshed");
      expect(container.textContent).toContain("retry Preview mask");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("reports an authored edit as a pending runtime revision instead of an in-place solver mutation", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <FrozenSpinsEditor
          definition={definitionFixture()}
          objectId="film"
          regionId={null}
          revision={7}
        />,
      ));
      await editDefinitionName(container);
      await act(async () => findButton(container, "Apply").click());
      expect(mocks.patch).toHaveBeenCalledWith(
        "pin-edge",
        expect.objectContaining({ definition: expect.objectContaining({ name: "Edited pinned edge" }) }),
        { sessionScopeKey: "session=session-a&epoch=epoch-a&request_scope_epoch=request-a" },
      );

      expect(container.textContent).toContain("current solver is unchanged");
      expect(container.textContent).toContain("pending_runtime_plan");
      expect(container.textContent).toContain("Pending scene revision");
      expect(container.textContent).toContain("next_runtime_plan");
      expect(container.textContent).toContain("unchanged");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("reports the tracked accepted-step application command while the solver is running", async () => {
    mocks.patch.mockResolvedValueOnce({
      definition: definitionFixture(),
      revision: 8,
      runtime_application: {
        application_command_id: "fm-frozen-replan-123",
        apply_boundary: "accepted_step",
        current_runtime_unchanged: true,
        pending_revision: 8,
        state: "pending_runtime_plan",
      },
    });
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <FrozenSpinsEditor
          definition={definitionFixture()}
          objectId="film"
          regionId={null}
          revision={7}
        />,
      ));
      await editDefinitionName(container);
      await act(async () => findButton(container, "Apply").click());
      expect(mocks.patch).toHaveBeenCalledWith(
        "pin-edge",
        expect.objectContaining({ definition: expect.objectContaining({ name: "Edited pinned edge" }) }),
        { sessionScopeKey: "session=session-a&epoch=epoch-a&request_scope_epoch=request-a" },
      );

      expect(container.textContent).toContain("next accepted solver step");
      expect(container.textContent).toContain("accepted_step");
      expect(container.textContent).toContain("Application command ID");
      expect(container.textContent).toContain("fm-frozen-replan-123");
      expect(container.textContent).toContain("unchanged");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("atomically commits the exact speculative preview candidate and awaits solver binding", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <FrozenSpinsEditor
          definition={definitionFixture()}
          objectId="film"
          regionId={null}
          revision={7}
        />,
      ));
      await act(async () => findButton(container, "Preview mask").click());
      await act(async () => findButton(container, "Commit preview").click());

      expect(mocks.activatePreview).toHaveBeenCalledWith("preview-1", {
        activation_candidate_token: "fsact-candidate-1",
        definition: expect.objectContaining({
          id: "pin-edge",
          reference: { kind: "capture_current_at_activation" },
          selector: { kind: "in_object", object_id: "film" },
        }),
        expected_revision: 7,
      }, { sessionScopeKey: "session=session-a&epoch=epoch-a&request_scope_epoch=request-a" });
      expect(mocks.invalidate).toHaveBeenCalledWith(
        "model:frozen-spins:active-preview",
        "",
      );
      expect(container.textContent).toContain("solver activation is still pending");
      expect(container.textContent).toContain("authoring_commit");
      expect(container.textContent).toContain("Waiting for a solver stage");
      expect(findOptionalButton(container, "Commit preview")).toBeNull();
      expect(mocks.refetchSolverStatus).toHaveBeenCalledTimes(1);
      expect(mocks.activatePreview).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("keeps a server-rejected activation candidate available for correction and retry", async () => {
    mocks.activatePreview.mockRejectedValueOnce(
      new Error("activation_definition_mismatch"),
    );
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <FrozenSpinsEditor
          definition={definitionFixture()}
          objectId="film"
          regionId={null}
          revision={7}
        />,
      ));
      await act(async () => findButton(container, "Preview mask").click());
      await act(async () => findButton(container, "Commit preview").click());

      expect(container.textContent).toContain("activation_definition_mismatch");
      expect(findButton(container, "Commit preview").disabled).toBe(false);
      expect(container.textContent).toContain("ready (one-time)");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("disables activation after the selector diverges from the previewed selector", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <FrozenSpinsEditor
          definition={definitionFixture()}
          objectId="film"
          regionId={null}
          revision={7}
        />,
      ));
      await act(async () => findButton(container, "Preview mask").click());
      const selectorKind = findElements(
        container,
        (element) => element.tagName === "SELECT",
      )[0]!;
      await act(async () => {
        selectorKind.value = "all_magnetic";
        selectorKind.dispatchEvent(new TestEvent("change", { bubbles: true }));
      });

      expect(findButton(container, "Commit preview").disabled).toBe(true);
      expect(container.textContent).toContain("requires new preview");
      expect(mocks.activatePreview).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("keeps the inspector root and unrelated draft fields stable while activation awaits ACK", async () => {
    let resolveActivation!: (value: unknown) => void;
    mocks.activatePreview.mockReturnValueOnce(
      new Promise((resolve) => { resolveActivation = resolve; }),
    );
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <FrozenSpinsEditor
          definition={definitionFixture()}
          objectId="film"
          regionId={null}
          revision={7}
        />,
      ));
      await act(async () => findButton(container, "Preview mask").click());
      const inspectorRoot = findByAttribute(
        container,
        "data-frozen-spins-inspector-id",
      );
      await act(async () => { findButton(container, "Commit preview").click(); });

      const nameInput = findByAttribute(container, "aria-label", "Name");
      expect(nameInput.disabled).toBe(false);
      expect(findButton(container, "Apply").disabled).toBe(true);
      expect(findButton(container, "Delete").disabled).toBe(true);
      expect(findByAttribute(container, "data-frozen-spins-inspector-id")).toBe(
        inspectorRoot,
      );
      const selectorKind = findElements(
        container,
        (element) => element.tagName === "SELECT",
      )[0]!;
      await act(async () => {
        selectorKind.value = "all_magnetic";
        selectorKind.dispatchEvent(new TestEvent("change", { bubbles: true }));
      });
      await act(async () => resolveActivation({
        active_site_count: 8,
        activation_scope: "authoring_commit",
        activation_candidate_token_consumed: true,
        authority: "speculative_authoring_preview",
        definition: definitionFixture(),
        free_site_count: 6,
        frozen_site_count: 2,
        mask_resource: preview.mask_resource,
        mask_sha256: preview.mask_sha256,
        preview_id: preview.preview_id,
        revision: 8,
        runtime_application: activationReceipt.runtime_application,
        schema_version: "frozen_spins_activation.v1",
        solver_binding: "pending_runtime_activation",
        source_state_revision: 41,
        topology_fingerprint: "sha256:topology",
      }));

      expect(
        findByAttribute(container, "data-selection-expression-kind").getAttribute(
          "data-selection-expression-kind",
        ),
      ).toBe("all_magnetic");
      expect(findByAttribute(container, "data-frozen-spins-inspector-id")).toBe(
        inspectorRoot,
      );
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("exposes but disables activation for a stale preview", async () => {
    mocks.createPreview.mockResolvedValueOnce({ ...preview, current: false });
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <FrozenSpinsEditor
          definition={definitionFixture()}
          objectId="film"
          regionId={null}
          revision={7}
        />,
      ));
      await act(async () => findButton(container, "Preview mask").click());

      expect(findButton(container, "Commit preview").disabled).toBe(true);
      expect(container.textContent).toContain("Activation candidate");
      expect(container.textContent).toContain("stale");
      expect(mocks.activatePreview).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("retains the same inspector root while a revision invalidation refetches", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const selection = {
      kind: "object.frozen-spins",
      label: "Frozen Spins",
      moduleSource: "explorer",
      nodeId: "model:object:film:frozen-spins:pin-edge",
      objectId: "film",
      ref: {
        constraintId: "pin-edge",
        kind: "object.frozen-spins",
        nodeId: "model:object:film:frozen-spins:pin-edge",
        objectId: "film",
        type: "frozen-spins",
      },
    } as const;
    try {
      await act(async () => root.render(<FrozenSpinsInspectorPanel selection={selection} />));
      const before = findByAttribute(container, "data-frozen-spins-inspector-id");
      mocks.definitionResource = { data: null, error: null };
      await act(async () => root.render(<FrozenSpinsInspectorPanel selection={selection} />));
      expect(findByAttribute(container, "data-frozen-spins-inspector-id")).toBe(before);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("does not retain another constraint definition after the target changes", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const selection = {
      kind: "object.frozen-spins",
      label: "Frozen Spins",
      moduleSource: "explorer",
      nodeId: "model:object:film:frozen-spins:pin-edge",
      objectId: "film",
      ref: {
        constraintId: "pin-edge",
        kind: "object.frozen-spins",
        nodeId: "model:object:film:frozen-spins:pin-edge",
        objectId: "film",
        type: "frozen-spins",
      },
    } as const;
    try {
      await act(async () => root.render(<FrozenSpinsInspectorPanel selection={selection} />));
      expect(findByAttribute(container, "data-frozen-spins-inspector-id")).toBeTruthy();

      mocks.definitionResource = { data: null, error: null };
      const otherSelection = {
        ...selection,
        nodeId: "model:object:film:frozen-spins:pin-other",
        ref: {
          ...selection.ref,
          constraintId: "pin-other",
          nodeId: "model:object:film:frozen-spins:pin-other",
        },
      } as const;
      await act(async () =>
        root.render(<FrozenSpinsInspectorPanel selection={otherSelection} />),
      );
      expect(container.textContent).toContain("Loading Frozen Spins definition");
      expect(
        findElements(
          container,
          (element) => element.getAttribute("data-frozen-spins-inspector-id") !== null,
        ),
      ).toHaveLength(0);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("does not retain the same constraint draft after the session changes", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    const selection = {
      kind: "object.frozen-spins",
      label: "Frozen Spins",
      moduleSource: "explorer",
      nodeId: "model:object:film:frozen-spins:pin-edge",
      objectId: "film",
      ref: {
        constraintId: "pin-edge",
        kind: "object.frozen-spins",
        nodeId: "model:object:film:frozen-spins:pin-edge",
        objectId: "film",
        type: "frozen-spins",
      },
    } as const;
    try {
      mocks.definitionResource = {
        data: {
          definition: { ...definitionFixture(), name: "Session A" },
          revision: 7,
        },
        error: null,
      };
      await act(async () => root.render(<FrozenSpinsInspectorPanel selection={selection} />));
      expect(findByAttribute(container, "aria-label", "Name").value).toBe("Session A");

      mocks.sessionId = "session-b";
      mocks.definitionResource = { data: null, error: null };
      await act(async () => root.render(<FrozenSpinsInspectorPanel selection={selection} />));
      expect(container.textContent).toContain("Loading Frozen Spins definition");
      expect(
        findElements(
          container,
          (element) => element.getAttribute("data-frozen-spins-inspector-id") !== null,
        ),
      ).toHaveLength(0);

      mocks.definitionResource = {
        data: {
          definition: { ...definitionFixture(), name: "Session B" },
          revision: 9,
        },
        error: null,
      };
      await act(async () => root.render(<FrozenSpinsInspectorPanel selection={selection} />));
      expect(findByAttribute(container, "aria-label", "Name").value).toBe("Session B");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  it("preserves a field edit made while an apply transaction is awaiting ACK", async () => {
    let resolvePatch!: (value: unknown) => void;
    mocks.patch.mockReturnValueOnce(new Promise((resolve) => { resolvePatch = resolve; }));
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(
        <FrozenSpinsEditor
          definition={definitionFixture()}
          objectId="film"
          regionId={null}
          revision={7}
        />,
      ));
      await editDefinitionName(container);
      await act(async () => findButton(container, "Apply").click());
      expect(mocks.patch).toHaveBeenCalledWith(
        "pin-edge",
        expect.objectContaining({ definition: expect.objectContaining({ name: "Edited pinned edge" }) }),
        { sessionScopeKey: "session=session-a&epoch=epoch-a&request_scope_epoch=request-a" },
      );
      const operator = findElements(container, (element) => element.tagName === "SELECT")[0]!;
      await act(async () => {
        operator.value = "all_magnetic";
        operator.dispatchEvent(new TestEvent("change", { bubbles: true }));
      });
      expect(
        findByAttribute(container, "data-selection-expression-kind").getAttribute(
          "data-selection-expression-kind",
        ),
      ).toBe("all_magnetic");
      await act(async () => resolvePatch({
        definition: definitionFixture(),
        revision: 8,
      }));
      expect(
        findByAttribute(container, "data-selection-expression-kind").getAttribute(
          "data-selection-expression-kind",
        ),
      ).toBe("all_magnetic");
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});

function findButton(root: TestNode, text: string): TestElement {
  const button = findElements(root, (element) =>
    element.tagName === "BUTTON" && element.textContent.includes(text))[0];
  if (!button) throw new Error(`Missing button ${text}`);
  return button;
}

function findOptionalButton(root: TestNode, text: string): TestElement | null {
  return findElements(root, (element) =>
    element.tagName === "BUTTON" && element.textContent.includes(text))[0] ?? null;
}

function findElements(
  root: TestNode,
  predicate: (element: TestElement) => boolean,
): TestElement[] {
  const found: TestElement[] = [];
  const visit = (node: TestNode) => {
    if (node instanceof TestElement && predicate(node)) found.push(node);
    node.childNodes.forEach(visit);
  };
  visit(root);
  return found;
}

function findByAttribute(
  root: TestNode,
  attribute: string,
  value?: string,
): TestElement {
  const element = findElements(root, (candidate) =>
    candidate.getAttribute(attribute) !== null &&
    (value === undefined || candidate.getAttribute(attribute) === value))[0];
  if (!element) throw new Error(`Missing element with ${attribute}`);
  return element;
}

function definitionFixture() {
  return {
    enabled: true,
    id: "pin-edge",
    name: "Pinned edge",
    schema_version: "fullmag.frozen-spins.v1",
    selector: { kind: "in_object" as const, object_id: "film" },
  };
}

function numericDefinitionFixture() {
  return {
    ...definitionFixture(),
    selector: {
      kind: "approx" as const, atol: 0, rtol: 0,
      value: { kind: "magnetization_dot" as const, axis: [1, 0, 0] },
      target: { kind: "constant" as const, value: 0 },
    },
  };
}

async function mountNumericEditor(definition: ComponentProps<typeof ScopedFrozenSpinsEditor>["definition"] = numericDefinitionFixture()) {
  const dom = installSimulationPreparationTestDom();
  const container = dom.document.createElement("div");
  const store = createInspectorEditSessionStore();
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container as unknown as Element);
  const renderDefinition = (nextDefinition: ComponentProps<typeof ScopedFrozenSpinsEditor>["definition"], revision = 7) => act(async () => root.render(
    <InspectorEditSessionProvider store={store}>
      <FrozenSpinsEditor definition={nextDefinition} objectId="film" regionId={null} revision={revision} />
    </InspectorEditSessionProvider>,
  ));
  await renderDefinition(definition);
  return {
    container, store, renderDefinition,
    edit: (label: string, text: string) => act(async () => {
      const input = findByAttribute(container, "aria-label", label);
      const setter = Object.getOwnPropertyDescriptor(TestElement.prototype, "value")?.set;
      if (!setter) throw new Error("Missing native input setter");
      setter.call(input, text);
      input.dispatchEvent(new TestEvent("input", { bubbles: true }));
    }),
    key: (label: string, key: string) => act(async () => {
      findByAttribute(container, "aria-label", label).dispatchEvent(new TestEvent("keydown", { bubbles: true, key }));
    }),
    blur: (label: string) => act(async () => {
      findByAttribute(container, "aria-label", label).dispatchEvent(new TestEvent("focusout", { bubbles: true }));
    }),
    dispose: async () => { await act(async () => root.unmount()); dom.restore(); },
  };
}

async function editDefinitionName(container: TestNode): Promise<void> {
  await act(async () => {
    const input = findByAttribute(container, "aria-label", "Name");
    const nativeValueSetter = Object.getOwnPropertyDescriptor(TestElement.prototype, "value")?.set;
    if (!nativeValueSetter) throw new Error("Missing native test input value setter");
    nativeValueSetter.call(input, "Edited pinned edge");
    input.dispatchEvent(new TestEvent("input", { bubbles: true }));
  });
  expect(findByAttribute(container, "aria-label", "Name").value).toBe("Edited pinned edge");
  expect(findButton(container, "Apply").disabled).toBe(false);
}
