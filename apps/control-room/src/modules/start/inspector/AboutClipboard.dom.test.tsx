import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  findElement,
  installSimulationPreparationTestDom,
  type TestElement,
} from "../../../kernel/layout/simulationPreparationTestDom.test-support";
import { AboutSection } from "../sections/AboutSection";
import type { Provenance } from "../model/provenance";
import type { RecentEntry } from "../model/types";
import { AboutInspector } from "./AboutInspector";
import { AuthorsPanel } from "./ProvenancePanels";

const host = vi.hoisted(() => ({ desktop: false, invoke: vi.fn(async () => null) }));
vi.mock("@/kernel/persistence/ProjectDocumentController", () => ({
  tauriInvoke: () => host.desktop ? host.invoke : null,
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function button(container: TestElement, label: string) {
  return findElement(
    container,
    (element) => element.tagName === "BUTTON" && element.textContent.includes(label),
    label,
  );
}

const projectEntry = (projectId: string, name: string): RecentEntry => ({
  lastOpenedAt: "2026-10-01T00:00:00.000Z",
  name,
  path: "/" + projectId + ".fms",
  projectId,
  solver: "FDM",
  status: "ready",
  workspaceId: "workspace:" + projectId,
});

const projectProvenance = (bibtex: string): Provenance => ({
  authors: [{ name: "Ada Lovelace", role: "creator" }],
  citation: { preferredBibtex: bibtex },
  history: [],
  recorded: true,
  runs: [],
});

describe("About and provenance clipboard actions", () => {
  let dom: ReturnType<typeof installSimulationPreparationTestDom>;
  let roots: Root[];
  let clipboard: { writeText: ReturnType<typeof vi.fn<(value: string) => Promise<void>>> };

  beforeEach(() => {
    host.desktop = false;
    clipboard = { writeText: vi.fn(async (_value: string) => undefined) };
    dom = installSimulationPreparationTestDom({ clipboard });
    roots = [];
  });

  afterEach(async () => {
    await act(async () => roots.forEach((root) => root.unmount()));
    dom.restore();
  });

  async function mount(node: ReactNode) {
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    roots.push(root);
    await act(async () => root.render(node));
    return { container, root };
  }

  it("uses a stable server host snapshot before resolving the desktop host on mount", async () => {
    host.desktop = true;
    const inspector = <AboutInspector compute={null} index={{ kind: "unavailable" }} />;
    const section = <AboutSection compute={null} index={{ kind: "loading" }} />;
    expect(renderToStaticMarkup(inspector)).toContain("Web Browser");
    expect(renderToStaticMarkup(section)).toContain("browser environment");
    const inspectorView = await mount(inspector);
    const sectionView = await mount(section);
    expect(inspectorView.container.textContent).toContain("Desktop (Tauri)");
    expect(sectionView.container.textContent).toContain("desktop mode");
  });

  it("reports pending then acknowledged BibTeX copy, without a fixed version claim", async () => {
    const pending = deferred<void>();
    clipboard.writeText.mockImplementation(() => pending.promise);
    const view = await mount(<AboutSection compute={null} index={{ kind: "loading" }} />);
    const copyButton = button(view.container, "Copy BibTeX");

    expect(view.container.textContent).not.toContain("v0.1.0");
    await act(async () => copyButton.click());
    expect(copyButton.getAttribute("disabled")).not.toBeNull();
    expect(copyButton.textContent).toContain("Copying BibTeX");

    await act(async () => pending.resolve(undefined));
    expect(copyButton.textContent).toContain("BibTeX Copied!");
    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
  });

  it("shows an accessible error when diagnostics copy is denied", async () => {
    clipboard.writeText.mockRejectedValueOnce(new Error("Permission denied"));
    const view = await mount(
      <AboutInspector compute={null} index={{ kind: "unavailable" }} />,
    );
    const copyButton = button(view.container, "Copy Diagnostics");

    await act(async () => {
      copyButton.click();
      await Promise.resolve();
    });

    expect(copyButton.getAttribute("disabled")).toBeNull();
    expect(copyButton.textContent).toContain("Copy Diagnostics");
    expect(
      findElement(
        view.container,
        (element) => element.getAttribute("role") === "alert",
        "clipboard error",
      ).textContent,
    ).toContain("Could not copy to the clipboard");
  });

  it("ignores a late diagnostics acknowledgement after the input snapshot changes", async () => {
    const pending = deferred<void>();
    clipboard.writeText.mockImplementation(() => pending.promise);
    const initial = await mount(
      <AboutSection compute={null} index={{ kind: "loading" }} />,
    );

    await act(async () => button(initial.container, "Copy Diagnostics").click());
    await act(async () =>
      initial.root.render(
        <AboutSection compute={null} index={{ kind: "unavailable" }} />,
      ),
    );
    await act(async () => pending.resolve(undefined));

    expect(initial.container.textContent).toContain("Copy Diagnostics");
    expect(initial.container.textContent).not.toContain("Copied Diagnostics");
  });

  it("does not show a late BibTeX acknowledgement on a retargeted project", async () => {
    const pending = deferred<void>();
    clipboard.writeText.mockImplementation(() => pending.promise);
    const firstEntry = projectEntry("project-a", "First project");
    const view = await mount(
      <AuthorsPanel
        entry={firstEntry}
        provenance={projectProvenance("@misc{first}")}
      />,
    );

    await act(async () => button(view.container, "Copy BibTeX").click());
    await act(async () =>
      view.root.render(
        <AuthorsPanel
          entry={projectEntry("project-b", "Second project")}
          provenance={projectProvenance("@misc{second}")}
        />,
      ),
    );
    await act(async () => pending.resolve(undefined));

    expect(view.container.textContent).toContain("@misc{second}");
    expect(button(view.container, "Copy BibTeX").textContent).toBe("Copy BibTeX");
  });
});
