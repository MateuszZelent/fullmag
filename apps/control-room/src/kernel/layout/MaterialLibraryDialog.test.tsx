import { act, type ComponentProps, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MaterialLibraryEntryResource, MaterialLibraryMutationResource } from "@/kernel/api/apiTypes";
import { ControlRoomApiError } from "@/kernel/api/ControlRoomApi";
import {
  findElement,
  findElements,
  installSimulationPreparationTestDom,
  TestElement,
  TestEvent,
} from "./simulationPreparationTestDom.test-support";
import { MaterialLibraryDialog } from "./MaterialLibraryDialog";

const mocks = vi.hoisted(() => ({
  identity: { sessionId: "A", sessionEpoch: "1", requestScopeEpoch: "1" },
  kernel: {} as Record<string, unknown>,
  library: {} as Record<string, unknown>,
  scene: { data: { revision: 7, scene_revision: 7, materials: [], objects: [] } },
  historyMutation: vi.fn(),
}));

vi.mock("@/kernel/KernelContext", () => ({ useKernel: () => mocks.kernel }));
vi.mock("@/kernel/resources/materialLibraryResources", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/kernel/resources/materialLibraryResources")>(),
  useMaterialLibraryResource: () => mocks.library,
}));
vi.mock("@/kernel/resources/useSessionStatus", () => ({ SESSION_STATUS_RESOURCE_KEY: "session:status", useSessionResourceIdentity: () => mocks.identity }));
vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  useSceneResource: () => mocks.scene,
  resolveMaterialResourceKey: (id: string) => `material:${id}`,
}));
vi.mock("@/kernel/authoring/authoringHistoryMutation", () => ({
  authoringWriteOptions: (baseRevision: number, sessionScopeKey: string) => ({ baseRevision, sessionScopeKey }),
  runAuthoringMutationWithHistory: (...args: unknown[]) => mocks.historyMutation(...args),
}));
vi.mock("@/shared/ui/Dialog", () => ({
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) => open ? <>{children}</> : null,
  DialogClose: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogContent: ({ children, onOpenAutoFocus: _open, onCloseAutoFocus: _close, ...props }: ComponentProps<"section"> & {
    onOpenAutoFocus?: unknown; onCloseAutoFocus?: unknown;
  }) => <section role="dialog" {...props}>{children}</section>,
  DialogHeader: (props: ComponentProps<"header">) => <header {...props} />,
  DialogTitle: (props: ComponentProps<"h2">) => <h2 {...props} />,
  DialogDescription: (props: ComponentProps<"p">) => <p {...props} />,
  DialogFooter: (props: ComponentProps<"footer">) => <footer {...props} />,
}));

const builtin = {
  id: "builtin:permalloy", name: "Permalloy Ni80Fe20", revision: 1, kind: "builtin",
  summary: "Reference seed parameters", source: null,
  properties: { Ms: 800000, Aex: 1.3e-11, alpha: 0.01, Dind: null, Dbulk: null },
  references: [{ label: "Measured", url: "https://example.org/first" }, { citation: "Second reference" }],
} as MaterialLibraryEntryResource;
const custom = { ...builtin, id: "custom:sample", name: "Measured film", kind: "custom", revision: 3 } as MaterialLibraryEntryResource;

const original = { catalog_id: builtin.id, catalog_revision: builtin.revision, name: builtin.name, kind: builtin.kind, properties: builtin.properties, references: builtin.references };
const published = {
  display_name: "Measured reference film", archived: false, revision: 6, original,
  source: {
    catalog_id: "custom:published:permalloy:sample_a", catalog_revision: 5, name: "First publication", kind: "custom" as const,
    version: { family: "permalloy", version: "sample_a", source_project: "Film project" },
    properties: { ...builtin.properties, Ms: 900000 }, references: [{ citation: "Sample measurement" }],
  },
};
const archived = {
  ...published, display_name: "Earlier sample", archived: true, revision: 7,
  source: { ...published.source, catalog_id: "custom:published:permalloy:earlier", version: { ...published.source.version, version: "earlier" } },
};

beforeEach(() => {
  mocks.identity = { sessionId: "A", sessionEpoch: "1", requestScopeEpoch: "1" };
  mocks.library = { data: { revision: 8, entries: [builtin, custom], versions: [] }, status: "ready", error: null, refetch: vi.fn() };
  mocks.kernel = {
    api: {
      workspace: {
        createMaterial: vi.fn(async (request) => ({ ...request, catalog_revision: 9, id: "custom:new", kind: request.source ? "modified" : "custom", revision: 1 })),
        updateMaterial: vi.fn(async (id, request) => ({ ...custom, ...request, catalog_revision: 9, id, revision: 4 })),
        deleteMaterial: vi.fn(async () => ({ revision: 9 })),
        publishMaterialVersion: vi.fn(async () => ({ catalog_revision: 10, published })),
        updateMaterialVersion: vi.fn(async (_family, _version, request) => ({ catalog_revision: 9, published: { ...archived, ...request } })),
      },
      model: { createMaterial: vi.fn(async () => ({ scene_revision: 8 })) },
    },
    authoringHistory: { record: vi.fn() },
    commands: { getSessionScopeKey: () => `session=${mocks.identity.sessionId}&epoch=${mocks.identity.sessionEpoch}&request_scope_epoch=${mocks.identity.requestScopeEpoch}` },
    resources: { invalidate: vi.fn() },
  };
  mocks.historyMutation.mockReset();
  mocks.historyMutation.mockImplementation(async (_context, _label, mutation) => mutation({ baseRevision: 7 }));
});

describe("MaterialLibraryDialog mounted catalog", () => {
  it("shows backend entries, all references, SI units, and protected built-ins", async () => {
    const mounted = await mount();
    try {
      expect(mounted.body.textContent).toContain("Permalloy Ni80Fe20");
      expect(mounted.body.textContent).toContain("Second reference");
      expect(mounted.body.textContent).toContain("J/m²");
      expect(mounted.body.textContent).not.toContain("J/m³");
      expect(buttons(mounted.body, "Edit entry")).toHaveLength(0);
      expect(buttons(mounted.body, "Delete entry")).toHaveLength(0);
      expect(button(mounted.body, "Create variant")).toBeTruthy();
      await act(async () => change(input(mounted.body, "Search materials"), "Measured film"));
      expect(findElements(mounted.body, (element) => element.getAttribute("data-material-id") === builtin.id)).toHaveLength(0);
      expect(findElements(mounted.body, (element) => element.getAttribute("data-material-id") === custom.id)).toHaveLength(1);
      await act(async () => radio(mounted.body, "Built-in").click());
      expect(mounted.body.textContent).toContain("No matching materials");
    } finally { await mounted.dispose(); }
  });

  it("groups published versions, searches stable keys, and passes the immutable snapshot to the chooser", async () => {
    mocks.library.data = { revision: 8, entries: [builtin, custom], versions: [published, archived] };
    const onUseMaterial = vi.fn(async () => {});
    const mounted = await mount({ onUseMaterial });
    try {
      const family = findElement(mounted.body, (element) => element.getAttribute("data-material-family") === "permalloy", "material family");
      expect(family.textContent).toContain(builtin.name);
      expect(family.textContent).toContain(published.display_name);
      expect(mounted.body.textContent).not.toContain(archived.display_name);
      await act(async () => change(input(mounted.body, "Search materials"), "permalloy.sample_a"));
      await act(async () => selectEntry(mounted.body, published.source.catalog_id));
      expect(mounted.body.textContent).toContain("800000 → 900000 A/m");
      expect(mounted.body.textContent).toContain("Film project");
      expect(mounted.body.textContent).toContain("Sample measurement");
      await act(async () => button(mounted.body, "Use in model").click());
      expect(onUseMaterial).toHaveBeenCalledWith(published);
    } finally { await mounted.dispose(); }
  });

  it("exposes archived versions through an explicit filter and updates only display metadata", async () => {
    mocks.library.data = { revision: 8, entries: [builtin, custom], versions: [published, archived] };
    const mounted = await mount();
    try {
      await act(async () => button(mounted.body, "Show archived versions").click());
      await act(async () => selectEntry(mounted.body, archived.source.catalog_id));
      expect(buttons(mounted.body, "Use in model")).toHaveLength(0);
      await act(async () => button(mounted.body, "Manage version").click());
      await act(async () => change(input(mounted.body, "Display name"), "Renamed sample"));
      await act(async () => submit(mounted.body));
      expect(workspace().updateMaterialVersion).toHaveBeenCalledWith("permalloy", "earlier", {
        base_revision: 7, display_name: "Renamed sample", archived: true,
      });
      expect(workspace().updateMaterial).not.toHaveBeenCalled();
      expect(resources().invalidate).toHaveBeenCalledWith("/v2/workspace/material-library", 9);
    } finally { await mounted.dispose(); }
  });

  it("saves a working copy before publishing and keeps the copied project's name", async () => {
    const snapshot = { state: "ready", resource: { name: "Earlier project" } };
    mocks.kernel.projectDocument = { subscribe: () => () => {}, getSnapshot: () => snapshot };
    const modelMaterial = { id: "mat:model", name: "Model film", properties: { ...builtin.properties, Ms: 900000 }, references: builtin.references, source: original };
    const mounted = await mount({ modelMaterial });
    try {
      await act(async () => button(mounted.body, "Save model copy to database").click());
      await act(async () => button(mounted.body, "Save and continue to publish").click());
      expect(input(mounted.body, "Family key").value).toBe("permalloy");
      expect(input(mounted.body, "Display name").value).toBe("Model film");
      await act(async () => change(input(mounted.body, "Version key"), "sample_a"));
      await act(async () => submit(mounted.body));
      expect(workspace().publishMaterialVersion).toHaveBeenCalledWith({
        material_id: "custom:new", base_revision: 1, family: "permalloy", version: "sample_a",
        display_name: "Model film", source_project: "Earlier project",
      });
      expect(model().createMaterial).not.toHaveBeenCalled();
    } finally { await mounted.dispose(); }
  });

  it("keeps zero exchange valid in a working copy and requires positive exchange for publishing", async () => {
    const modelMaterial = {
      id: "mat:model", name: "Model film", properties: { ...builtin.properties, Aex: 0 }, references: builtin.references, source: original,
    };
    const mounted = await mount({ modelMaterial });
    try {
      await act(async () => button(mounted.body, "Save model copy to database").click());
      await act(async () => button(mounted.body, "Save and continue to publish").click());
      expect(mounted.body.textContent).toContain("Aex must be greater than 0 J/m to publish a version.");
      expect(workspace().createMaterial).not.toHaveBeenCalled();
      await act(async () => submit(mounted.body));
      expect(workspace().createMaterial).toHaveBeenCalledWith(expect.objectContaining({
        properties: expect.objectContaining({ Aex: 0 }),
      }));
    } finally { await mounted.dispose(); }
  });

  it("retains the source project when publishing a saved model copy after reopening the database", async () => {
    const projectSnapshot = { state: "ready", resource: { name: "Earlier project" } };
    mocks.kernel.projectDocument = { getSnapshot: () => projectSnapshot };
    const modelMaterial = {
      id: "mat:model", name: "Model film", properties: builtin.properties, references: builtin.references, source: original,
    };
    const mounted = await mount({ modelMaterial });
    try {
      await act(async () => button(mounted.body, "Save model copy to database").click());
      await act(async () => submit(mounted.body));
      expect(workspace().createMaterial).toHaveBeenCalledWith(expect.objectContaining({
        name: "Model film", source_project: "Earlier project",
      }));
      const saved = await workspace().createMaterial.mock.results[0]?.value;
      await mounted.setOpen(false);
      delete mocks.kernel.projectDocument;
      mocks.library.data = { revision: saved.catalog_revision, entries: [builtin, custom, saved], versions: [] };
      await mounted.setOpen(true);
      await act(async () => selectEntry(mounted.body, saved.id));
      await act(async () => button(mounted.body, "Publish version").click());
      expect(mounted.body.textContent).toContain("Copied from project Earlier project");
      await act(async () => change(input(mounted.body, "Version key"), "sample_a"));
      await act(async () => submit(mounted.body));
      expect(workspace().publishMaterialVersion).toHaveBeenCalledWith({
        material_id: saved.id, base_revision: saved.revision, family: "permalloy", version: "sample_a",
        display_name: "Model film", source_project: "Earlier project",
      });
    } finally { await mounted.dispose(); }
  });

  it("preserves publication input after a duplicate key and allows changing the key", async () => {
    workspace().publishMaterialVersion.mockRejectedValueOnce(new ControlRoomApiError("Version permalloy.sample_a already exists", 409));
    const mounted = await mount();
    try {
      await act(async () => selectEntry(mounted.body, custom.id));
      await act(async () => button(mounted.body, "Publish version").click());
      await act(async () => change(input(mounted.body, "Family key"), "permalloy"));
      await act(async () => change(input(mounted.body, "Version key"), "sample_a"));
      await act(async () => submit(mounted.body));
      expect(mounted.body.textContent).toContain("Version permalloy.sample_a already exists");
      expect(input(mounted.body, "Version key").value).toBe("sample_a");
      await act(async () => change(input(mounted.body, "Version key"), "sample_b"));
      await act(async () => submit(mounted.body));
      expect(workspace().publishMaterialVersion).toHaveBeenLastCalledWith(expect.objectContaining({
        material_id: custom.id, base_revision: custom.revision, family: "permalloy", version: "sample_b",
      }));
      expect(resources().invalidate).toHaveBeenCalledExactlyOnceWith("/v2/workspace/material-library", 10);
    } finally { await mounted.dispose(); }
  });

  it("creates a catalog entry without changing scene history and preserves every reference", async () => {
    const mounted = await mount();
    try {
      await act(async () => button(mounted.body, "Create variant").click());
      await act(async () => change(input(mounted.body, "Material name"), "Measured variant"));
      await act(async () => change(input(mounted.body, "alpha (1)"), ""));
      await act(async () => submit(mounted.body));
      expect(mounted.body.textContent).toContain("alpha is required");
      expect(workspace().createMaterial).not.toHaveBeenCalled();
      await act(async () => change(input(mounted.body, "alpha (1)"), "0"));
      await act(async () => submit(mounted.body));
      expect(workspace().createMaterial).toHaveBeenCalledWith(expect.objectContaining({
        name: "Measured variant", properties: expect.objectContaining({ alpha: 0 }),
        references: builtin.references,
        source: expect.objectContaining({ catalog_id: builtin.id, catalog_revision: 1 }),
      }));
      expect(workspace().updateMaterial).not.toHaveBeenCalled();
      expect(mocks.historyMutation).not.toHaveBeenCalled();
      expect(model().createMaterial).not.toHaveBeenCalled();
    } finally { await mounted.dispose(); }
  });

  it("requires an explicit choice before discarding drafts on selection or close", async () => {
    const mounted = await mount();
    try {
      await act(async () => button(mounted.body, "New material").click());
      await act(async () => change(input(mounted.body, "Material name"), "Unsaved film"));
      await act(async () => selectEntry(mounted.body, custom.id));
      expect(mounted.body.textContent).toContain("Discard unsaved changes?");
      await act(async () => button(mounted.body, "Keep editing").click());
      expect(input(mounted.body, "Material name").value).toBe("Unsaved film");
      await act(async () => button(mounted.body, "Close material database").click());
      expect(mounted.onOpenChange).not.toHaveBeenCalled();
      await act(async () => button(mounted.body, "Discard changes").click());
      expect(mounted.onOpenChange).toHaveBeenCalledWith(false);
    } finally { await mounted.dispose(); }
  });

  it("keeps a conflicting draft until an explicit reload", async () => {
    workspace().updateMaterial.mockRejectedValue(new ControlRoomApiError("Catalog revision conflict", 409));
    const mounted = await mount();
    try {
      await act(async () => selectEntry(mounted.body, custom.id));
      await act(async () => button(mounted.body, "Edit entry").click());
      await act(async () => change(input(mounted.body, "Material name"), "My unsaved revision"));
      await act(async () => submit(mounted.body));
      expect(input(mounted.body, "Material name").value).toBe("My unsaved revision");
      expect(mounted.body.textContent).toContain("Catalog revision conflict");
      expect(button(mounted.body, "Reload catalog entry")).toBeTruthy();
      expect(workspace().updateMaterial).toHaveBeenCalledWith(custom.id, expect.objectContaining({ base_revision: 3 }));
      expect(workspace().createMaterial).not.toHaveBeenCalled();
      await act(async () => change(input(mounted.body, "Material name"), "More local edits"));
      await act(async () => submit(mounted.body));
      expect(workspace().updateMaterial).toHaveBeenCalledTimes(1);
      expect(input(mounted.body, "Material name").value).toBe("More local edits");
      await act(async () => button(mounted.body, "Reload catalog entry").click());
      expect(mounted.body.textContent).toContain("Discard unsaved changes?");
    } finally { await mounted.dispose(); }
  });

  it("submits once and preserves edits made while a save is pending", async () => {
    const pending = deferred<MaterialLibraryMutationResource>();
    workspace().createMaterial.mockReturnValue(pending.promise);
    const mounted = await mount();
    try {
      await act(async () => button(mounted.body, "New material").click());
      await act(async () => change(input(mounted.body, "Material name"), "First snapshot"));
      await act(async () => { submit(mounted.body); submit(mounted.body); });
      expect(workspace().createMaterial).toHaveBeenCalledTimes(1);
      expect(input(mounted.body, "Material name").hasAttribute("disabled")).toBe(false);
      await act(async () => change(input(mounted.body, "Material name"), "Newer edits"));
      await act(async () => pending.resolve({ ...custom, catalog_revision: 9, id: "custom:new", name: "First snapshot", revision: 1 }));
      expect(input(mounted.body, "Material name").value).toBe("Newer edits");
      expect(mounted.body.textContent).toContain("newer edits remain unsaved");
    } finally { await mounted.dispose(); }
  });

  it("ignores a late save acknowledgement after the session changes", async () => {
    const pending = deferred<MaterialLibraryMutationResource>();
    workspace().createMaterial.mockReturnValue(pending.promise);
    const mounted = await mount();
    try {
      await act(async () => button(mounted.body, "New material").click());
      await act(async () => change(input(mounted.body, "Material name"), "Old session draft"));
      await act(async () => submit(mounted.body));
      mocks.identity = { sessionId: "B", sessionEpoch: "2", requestScopeEpoch: "2" };
      await mounted.rerender();
      await act(async () => pending.resolve({ ...custom, catalog_revision: 9, id: "custom:late" }));
      expect(mounted.body.textContent).not.toContain("Material saved to database");
      expect(mounted.onOpenChange).not.toHaveBeenCalled();
    } finally { await mounted.dispose(); }
  });

  it("ignores an old save acknowledgement after closing and reopening the modal", async () => {
    const pending = deferred<MaterialLibraryMutationResource>();
    workspace().createMaterial.mockReturnValue(pending.promise);
    const mounted = await mount();
    try {
      await act(async () => button(mounted.body, "New material").click());
      await act(async () => change(input(mounted.body, "Material name"), "Old open generation"));
      await act(async () => submit(mounted.body));
      await mounted.setOpen(false);
      await mounted.setOpen(true);
      await act(async () => pending.resolve({ ...custom, catalog_revision: 9, id: "custom:old-open" }));
      expect(mounted.body.textContent).not.toContain("Material saved to database");
      expect(mounted.body.textContent).toContain("Permalloy Ni80Fe20");
      expect(mounted.onOpenChange).not.toHaveBeenCalled();
      expect(resources().invalidate).toHaveBeenCalledWith("/v2/workspace/material-library", 9);
    } finally { await mounted.dispose(); }
  });

  it("passes the selected snapshot to the Inspector callback once", async () => {
    const pending = deferred<void>();
    const onUseMaterial = vi.fn(() => pending.promise);
    const mounted = await mount({ onUseMaterial });
    try {
      await act(async () => { button(mounted.body, "Use in model").click(); button(mounted.body, "Use in model").click(); });
      expect(onUseMaterial).toHaveBeenCalledTimes(1);
      expect(onUseMaterial).toHaveBeenCalledWith(builtin);
      expect(workspace().createMaterial).not.toHaveBeenCalled();
      await act(async () => pending.resolve());
      expect(mounted.onOpenChange).toHaveBeenCalledWith(false);
    } finally { await mounted.dispose(); }
  });

  it("uses a new independent scene id, source snapshot, and authoring history from Tools", async () => {
    const mounted = await mount();
    try {
      await act(async () => button(mounted.body, "Use in model").click());
      expect(mocks.historyMutation).toHaveBeenCalledTimes(1);
      expect(model().createMaterial).toHaveBeenCalledWith(
        expect.stringMatching(/^mat:[0-9a-f-]{36}$/), builtin.name, builtin.properties, builtin.references,
        expect.objectContaining({ baseRevision: 7 }),
        { source: expect.objectContaining({ catalog_id: builtin.id, catalog_revision: builtin.revision, properties: builtin.properties, references: builtin.references }) },
      );
      expect(workspace().createMaterial).not.toHaveBeenCalled();
    } finally { await mounted.dispose(); }
  });

  it("does not replace another entry after an old draft is discarded during a pending save", async () => {
    const pending = deferred<MaterialLibraryMutationResource>();
    workspace().createMaterial.mockReturnValue(pending.promise);
    const mounted = await mount();
    try {
      await act(async () => button(mounted.body, "New material").click());
      await act(async () => change(input(mounted.body, "Material name"), "Pending old draft"));
      await act(async () => submit(mounted.body));
      await act(async () => selectEntry(mounted.body, custom.id));
      await act(async () => button(mounted.body, "Discard changes").click());
      await act(async () => pending.resolve({ ...custom, catalog_revision: 9, id: "custom:old-ack" }));
      expect(mounted.body.textContent).toContain("Measured film");
      expect(mounted.body.textContent).not.toContain("Material saved to database");
      expect(buttons(mounted.body, "Edit entry")).toHaveLength(1);
    } finally { await mounted.dispose(); }
  });

  it("saves the selected model copy without assigning or modifying its scene material", async () => {
    const source = { catalog_id: builtin.id, catalog_revision: 1, name: builtin.name, kind: builtin.kind, properties: builtin.properties, references: builtin.references };
    const modelMaterial = { id: "mat:model", name: "Model film", properties: { ...builtin.properties, Ms: 900000 }, references: builtin.references, source };
    const mounted = await mount({ modelMaterial });
    try {
      await act(async () => button(mounted.body, "Save model copy to database").click());
      await act(async () => submit(mounted.body));
      expect(workspace().createMaterial).toHaveBeenCalledWith(expect.objectContaining({ name: "Model film", properties: expect.objectContaining({ Ms: 900000 }), source }));
      expect(model().createMaterial).not.toHaveBeenCalled();
      expect(mocks.historyMutation).not.toHaveBeenCalled();
    } finally { await mounted.dispose(); }
  });

  it("invalidates the shared catalog when a delete finishes after navigating to another entry", async () => {
    const pending = deferred<{ revision: number }>();
    workspace().deleteMaterial.mockReturnValue(pending.promise);
    const mounted = await mount();
    try {
      await act(async () => selectEntry(mounted.body, custom.id));
      await act(async () => button(mounted.body, "Delete entry").click());
      await act(async () => button(mounted.body, "Delete from database").click());
      await act(async () => selectEntry(mounted.body, builtin.id));
      await act(async () => pending.resolve({ revision: 9 }));
      expect(resources().invalidate).toHaveBeenCalledWith("/v2/workspace/material-library", 9);
      expect(mounted.body.textContent).not.toContain("Material removed from database");
      expect(mounted.body.textContent).toContain("Permalloy Ni80Fe20");
    } finally { await mounted.dispose(); }
  });

  it("guards returning to the catalog so a narrow-screen draft remains reachable", async () => {
    const mounted = await mount();
    try {
      await act(async () => button(mounted.body, "New material").click());
      await act(async () => change(input(mounted.body, "Material name"), "Keep this draft"));
      await act(async () => button(mounted.body, "Back to materials").click());
      expect(mounted.body.textContent).toContain("Discard unsaved changes?");
      expect(findElement(mounted.body, (element) => element.hasAttribute("data-detail-open"), "responsive layout").getAttribute("data-detail-open")).toBe("true");
      await act(async () => button(mounted.body, "Keep editing").click());
      expect(input(mounted.body, "Material name").value).toBe("Keep this draft");
      expect(findElement(mounted.body, (element) => element.hasAttribute("data-detail-open"), "responsive layout").getAttribute("data-detail-open")).toBe("true");
      await act(async () => button(mounted.body, "Back to materials").click());
      await act(async () => button(mounted.body, "Discard changes").click());
      expect(findElement(mounted.body, (element) => element.hasAttribute("data-detail-open"), "responsive layout").getAttribute("data-detail-open")).toBe("false");
    } finally { await mounted.dispose(); }
  });

  it("requires confirmation before deleting only the selected custom entry", async () => {
    const mounted = await mount();
    try {
      await act(async () => selectEntry(mounted.body, custom.id));
      await act(async () => button(mounted.body, "Delete entry").click());
      expect(workspace().deleteMaterial).not.toHaveBeenCalled();
      expect(mounted.body.textContent).toContain("Copies already saved in models remain unchanged");
      await act(async () => button(mounted.body, "Delete from database").click());
      expect(workspace().deleteMaterial).toHaveBeenCalledWith(custom.id, { base_revision: 3 });
      expect(model().createMaterial).not.toHaveBeenCalled();
    } finally { await mounted.dispose(); }
  });
});

function workspace() {
  return (mocks.kernel.api as { workspace: Record<string, ReturnType<typeof vi.fn>> }).workspace;
}
function resources() {
  return mocks.kernel.resources as { invalidate: ReturnType<typeof vi.fn> };
}
function model() {
  return (mocks.kernel.api as { model: Record<string, ReturnType<typeof vi.fn>> }).model;
}
async function mount(extra: Partial<ComponentProps<typeof MaterialLibraryDialog>> = {}) {
  const dom = installSimulationPreparationTestDom();
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  Object.assign(dom.document, {
    getElementById: (id: string) => findElements(dom.document.body, (element) => element.getAttribute("id") === id)[0] ?? null,
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container as unknown as Element);
  const onOpenChange = vi.fn();
  let open = true;
  const render = () => root.render(<MaterialLibraryDialog open={open} onOpenChange={onOpenChange} {...extra} />);
  try {
    await act(async () => render());
  } catch (error) {
    await act(async () => root.unmount());
    dom.restore();
    throw error;
  }
  return {
    body: dom.document.body, onOpenChange,
    rerender: async () => { await act(async () => render()); },
    setOpen: async (next: boolean) => { open = next; await act(async () => render()); },
    dispose: async () => { await act(async () => root.unmount()); dom.restore(); },
  };
}
function buttons(body: TestElement, name: string) {
  return findElements(body, (element) => element.tagName === "BUTTON" && (element.getAttribute("aria-label") || element.textContent.trim()) === name);
}
function button(body: TestElement, name: string): TestElement {
  return findElement(body, (element) => element.tagName === "BUTTON" && (element.getAttribute("aria-label") || element.textContent.trim()) === name, `${name} button`);
}
function input(body: TestElement, label: string): TestElement {
  const fieldLabel = findElement(body, (element) => element.tagName === "LABEL" && element.textContent.trim() === label, `${label} label`);
  return findElement(body, (element) => element.getAttribute("id") === fieldLabel.getAttribute("for"), `${label} input`);
}
function change(control: TestElement, value: string) {
  // The browser defaults a missing type to "text"; the lightweight DOM does not.
  // React's change-event plugin checks this property before tracking text edits.
  if (control.tagName === "INPUT") {
    const typedControl = control as TestElement & { type?: string };
    typedControl.type ??= control.getAttribute("type") ?? "text";
  }
  const setter = Object.getOwnPropertyDescriptor(TestElement.prototype, "value")?.set;
  if (!setter) throw new Error("Missing test input value setter");
  setter.call(control, value);
  control.dispatchEvent(new TestEvent("input", { bubbles: true }));
}
function submit(body: TestElement) {
  findElement(body, (element) => element.tagName === "FORM", "material form").dispatchEvent(new TestEvent("submit", { bubbles: true }));
}
function selectEntry(body: TestElement, id: string) {
  findElement(body, (element) => element.getAttribute("data-material-id") === id, `catalog entry ${id}`).click();
}
function radio(body: TestElement, name: string) {
  return findElement(body, (element) => element.getAttribute("role") === "radio" && element.textContent.trim() === name, `${name} filter`);
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
