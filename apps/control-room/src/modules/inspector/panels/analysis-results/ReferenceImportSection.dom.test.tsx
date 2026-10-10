import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { KernelContext } from "@/kernel/KernelContext";
import type { KernelApi } from "@/kernel/types";
import {
  findElement,
  installSimulationPreparationTestDom,
  TestEvent,
  type TestElement,
} from "@/kernel/layout/simulationPreparationTestDom.test-support";
import { MAX_REFERENCE_FILE_BYTES } from "@/shared/domain/analysis/referenceImport";

import { ReferenceImportSection } from "./ReferenceImportSection";

type TestReferenceFile = Pick<File, "name" | "size" | "text">;

function referenceFile(name: string, size: number, text: () => Promise<string>): TestReferenceFile {
  return { name, size, text };
}

function chooseFile(input: TestElement, file: TestReferenceFile): void {
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  input.dispatchEvent(new TestEvent("change", { bubbles: true }));
}

async function flushRead(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("ReferenceImportSection file selection", () => {
  it("clears old table data and fences pending and immediate results by newest selection", async () => {
    const dom = installSimulationPreparationTestDom();
    const container = dom.document.createElement("div");
    const root = createRoot(container as unknown as Element);
    const kernel = {} as unknown as KernelApi;
    let resolveSlowRead!: (text: string) => void;
    const slowText = new Promise<string>((resolve) => { resolveSlowRead = resolve; });
    const slowFile = referenceFile("older.csv", 24, vi.fn(() => slowText));
    const oversizedText = vi.fn().mockResolvedValue("must not be read");
    const oversizedFile = referenceFile("oversized.csv", MAX_REFERENCE_FILE_BYTES + 1, oversizedText);
    const validText = vi.fn().mockResolvedValue("s,f\n1,2\n3,4\n");
    const validFile = referenceFile("current.csv", MAX_REFERENCE_FILE_BYTES, validText);

    try {
      await act(async () => {
        root.render(
          <KernelContext.Provider value={kernel}>
            <ReferenceImportSection />
          </KernelContext.Provider>,
        );
      });
      const input = findElement(
        container,
        (element) => element.tagName.toLowerCase() === "input" && element.getAttribute("aria-label") === "Reference file",
        "Reference file input",
      );
      const trigger = findElement(
        container,
        (element) => element.tagName.toLowerCase() === "button" && element.textContent.includes("Import reference"),
        "Import reference group trigger",
      );
      await act(async () => { trigger.dispatchEvent(new TestEvent("click", { bubbles: true })); });
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
      const content = findElement(
        container,
        (element) => element.getAttribute("data-slot") === "inspector-group-content",
        "Import reference group content",
      );
      expect(content.hasAttribute("hidden")).toBe(false);

      // The first read resolves with an immediate size error; the same turn chooses a newer valid file.
      await act(async () => {
        chooseFile(input, oversizedFile);
        chooseFile(input, validFile);
        await flushRead();
      });
      expect(oversizedText).not.toHaveBeenCalled();
      expect(container.textContent).toContain("2 points.");
      expect(container.textContent).not.toContain("4 MiB or smaller");

      await act(async () => { chooseFile(input, slowFile); });
      expect(container.textContent).not.toContain("2 points.");
      await act(async () => {
        chooseFile(input, oversizedFile);
        await flushRead();
      });
      expect(container.textContent).toContain("4 MiB or smaller");
      expect(container.textContent).not.toContain("2 points.");

      await act(async () => {
        resolveSlowRead("s,f\n8,9\n10,11\n");
        await flushRead();
      });
      expect(container.textContent).toContain("4 MiB or smaller");
      expect(container.textContent).not.toContain("2 points.");
      expect(container.textContent).not.toContain("older.csv");
      expect(slowFile.text).toHaveBeenCalledTimes(1);
      expect(oversizedText).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
