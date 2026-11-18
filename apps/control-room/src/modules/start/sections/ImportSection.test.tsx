import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { findElement, installSimulationPreparationTestDom, TestEvent } from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { ImportSection } from "./ImportSection";

async function withImport(run: (context: {
  container: ReturnType<typeof installSimulationPreparationTestDom>["document"]["body"];
  choose(file: File): Promise<void>;
  creator: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
  importStl: ReturnType<typeof vi.fn>;
  createFemWorkspace: ReturnType<typeof vi.fn>;
}) => Promise<void>, disabled: string | null = "Desktop file opening is unavailable.", stlWorkspaceState: "active" | "none" | "unconfirmed" = "active") {
  const dom = installSimulationPreparationTestDom();
  const container = dom.document.createElement("div");
  const root = createRoot(container as unknown as Element);
  const creator = vi.fn(); const open = vi.fn(async () => null);
  const importStl = vi.fn(async () => null);
  const createFemWorkspace = vi.fn(async () => null);
  try {
    await act(async () => root.render(<ImportSection
      onOpenFile={open}
      onCreateFemWorkspace={createFemWorkspace}
      onImportStl={importStl}
      openDisabledReason={disabled}
      projectCreator={creator}
      stlWorkspaceState={stlWorkspaceState}
    />));
    const input = findElement(container, (element) => element.tagName === "INPUT" && Reflect.get(element, "type") === "file", "file chooser");
    expect(input.getAttribute("accept")).toContain(".py");
    await run({ container, creator, open, importStl, createFemWorkspace, choose: async (file) => {
      Object.assign(input, { files: [file] });
      await act(async () => input.dispatchEvent(new TestEvent("change", { bubbles: true })));
    } });
  } finally {
    await act(async () => root.unmount());
    dom.restore();
  }
}
const pythonFile = (bytes: Uint8Array) => ({ name: "antenna.py", size: bytes.byteLength, arrayBuffer: vi.fn(async () => bytes.buffer) }) as unknown as File;
const stlFile = (name = "part.stl") => ({
  name,
  size: 6,
  arrayBuffer: vi.fn(async () => new Uint8Array([115, 111, 108, 105, 100, 10]).buffer),
}) as unknown as File;

describe("ImportSection Python source", () => {
  it("stages source for review without desktop or calling project creation", async () => {
    await withImport(async ({ container, choose, creator, open }) => {
      const text = "# antenna\nraise RuntimeError('review only')\n";
      await choose(pythonFile(new TextEncoder().encode(text)));
      expect(findElement(container, (element) => element.tagName === "PRE", "source review").textContent).toBe(text);
      expect(container.textContent).toContain("relative assets are not included");
      const create = findElement(container, (element) => element.tagName === "BUTTON" && element.textContent === "Create project…", "consent action");
      expect(create.disabled).toBe(false);
      expect(creator).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
    });
  });
  it("shows invalid UTF-8 without staging or creating a project", async () => {
    await withImport(async ({ container, choose, creator, open }) => {
      await choose(pythonFile(new Uint8Array([0xff])));
      expect(container.textContent).toContain("valid UTF-8");
      expect(creator).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
    });
  });
  it("keeps the existing archive route", async () => {
    await withImport(async ({ choose, open, creator }) => {
      const file = { name: "model.fms" } as File;
      await choose(file);
      expect(open).toHaveBeenCalledWith(file); expect(creator).not.toHaveBeenCalled();
    }, null);
  });

  it("requires an explicit coordinate unit and scale for an STL surface", async () => {
    await withImport(async ({ container, choose, importStl }) => {
      await choose(stlFile());
      const form = findElement(container, (element) => element.tagName === "FORM", "STL settings form");
      const unit = findElement(form, (element) => element.tagName === "SELECT", "coordinate unit");
      const scale = findElement(form, (element) => element.tagName === "INPUT" && Reflect.get(element, "type") === "number", "scale");
      expect(unit.getAttribute("required")).not.toBeNull();
      expect(Reflect.get(unit, "value")).toBe("");
      expect(scale.getAttribute("required")).not.toBeNull();
      expect(scale.getAttribute("min")).toBe("5e-324");
      expect(Reflect.get(scale, "value")).toBe("1");
      expect(form.textContent).toContain("does not infer it from the filename");
      expect(importStl).not.toHaveBeenCalled();
    });
  });

  it("asks for a FEM workspace before staging an STL when there is no active session", async () => {
    await withImport(async ({ container, choose, importStl, createFemWorkspace }) => {
      await choose(stlFile());
      expect(container.textContent).toContain("Create a FEM workspace first");
      expect(findElement(container, (element) => element.tagName === "BUTTON" && element.textContent === "Create FEM workspace…", "FEM workspace action")).not.toBeNull();
      expect(importStl).not.toHaveBeenCalled();
      const input = findElement(container, (element) => element.tagName === "INPUT" && Reflect.get(element, "type") === "file", "file chooser");
      expect(input).toBeTruthy();
      const create = findElement(container, (element) => element.tagName === "BUTTON" && element.textContent === "Create FEM workspace…", "FEM workspace action");
      await act(async () => create.dispatchEvent(new TestEvent("click", { bubbles: true })));
      expect(createFemWorkspace).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain("return to Import and choose the STL file again");
    }, "Desktop file opening is unavailable.", "none");
  });
});
