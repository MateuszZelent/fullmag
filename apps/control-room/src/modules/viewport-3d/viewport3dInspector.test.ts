import { afterEach, describe, expect, it } from "vitest";
import {
  getViewport3DInspectorSnapshot,
  openViewport3DExportInspector,
  openViewport3DInspector,
  registerViewport3DExportHost,
  registerViewport3DInspectorHost,
  setViewport3DExportMode,
  setViewport3DInspectorContext,
  setViewport3DInspectorSection,
} from "./viewport3dInspectorState";

afterEach(() => {
  setViewport3DInspectorContext("selection");
  setViewport3DInspectorSection("view");
  setViewport3DExportMode("png");
});

describe("3D inspector UI destination", () => {
  it("opens view settings without changing selection and remembers the section", () => {
    openViewport3DInspector("quality");
    expect(getViewport3DInspectorSnapshot()).toMatchObject({
      context: "view",
      section: "quality",
      visited: true,
    });
    setViewport3DInspectorContext("selection");
    openViewport3DInspector();
    expect(getViewport3DInspectorSnapshot().section).toBe("quality");
    setViewport3DInspectorSection("appearance");
    expect(getViewport3DInspectorSnapshot().section).toBe("appearance");
  });

  it("opens the export context and remembers the selected PNG or 3D mode", () => {
    openViewport3DExportInspector("3d");
    expect(getViewport3DInspectorSnapshot()).toMatchObject({
      context: "export",
      exportMode: "3d",
      exportVisited: true,
    });
    setViewport3DInspectorContext("selection");
    openViewport3DExportInspector();
    expect(getViewport3DInspectorSnapshot().exportMode).toBe("3d");
    setViewport3DExportMode("png");
    expect(getViewport3DInspectorSnapshot().exportMode).toBe("png");
  });

  it("does not let a late host cleanup unregister its replacement", () => {
    const first = {} as HTMLElement;
    const second = {} as HTMLElement;
    const releaseFirst = registerViewport3DInspectorHost(first);
    const releaseSecond = registerViewport3DInspectorHost(second);
    releaseFirst();
    expect(getViewport3DInspectorSnapshot().host).toBe(second);
    releaseSecond();
    expect(getViewport3DInspectorSnapshot().host).toBeNull();

    const firstExport = {} as HTMLElement;
    const secondExport = {} as HTMLElement;
    const releaseFirstExport = registerViewport3DExportHost(firstExport);
    const releaseSecondExport = registerViewport3DExportHost(secondExport);
    releaseFirstExport();
    expect(getViewport3DInspectorSnapshot().exportHost).toBe(secondExport);
    releaseSecondExport();
    expect(getViewport3DInspectorSnapshot().exportHost).toBeNull();
  });
});
