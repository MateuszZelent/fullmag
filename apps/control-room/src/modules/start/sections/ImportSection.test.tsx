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
}) => Promise<void>, disabled: string | null = "Desktop file opening is unavailable.") {
  const dom = installSimulationPreparationTestDom();
  const container = dom.document.createElement("div");
  const root = createRoot(container as unknown as Element);
  const creator = vi.fn(); const open = vi.fn(async () => null);
  try {
    await act(async () => root.render(<ImportSection onOpenFile={open} openDisabledReason={disabled} projectCreator={creator} />));
    const input = findElement(container, (element) => element.tagName === "INPUT" && Reflect.get(element, "type") === "file", "file chooser");
    expect(input.getAttribute("accept")).toContain(".py");
    await run({ container, creator, open, choose: async (file) => {
      Object.assign(input, { files: [file] });
      await act(async () => input.dispatchEvent(new TestEvent("change", { bubbles: true })));
    } });
  } finally {
    await act(async () => root.unmount());
    dom.restore();
  }
}
const pythonFile = (bytes: Uint8Array) => ({ name: "antenna.py", size: bytes.byteLength, arrayBuffer: vi.fn(async () => bytes.buffer) }) as unknown as File;

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
});
