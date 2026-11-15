import { afterEach, describe, expect, it } from "vitest";
import {
  getViewport3DInspectorSnapshot, openViewport3DInspector,
  registerViewport3DInspectorHost, setViewport3DInspectorContext,
  setViewport3DInspectorSection,
} from "./viewport3dInspectorState";

afterEach(() => setViewport3DInspectorContext("selection"));

describe("3D inspector UI destination", () => {
  it("opens view settings without changing selection and remembers the section", () => {
    openViewport3DInspector("quality");
    expect(getViewport3DInspectorSnapshot()).toMatchObject({ context: "view", section: "quality", visited: true });
    setViewport3DInspectorContext("selection");
    openViewport3DInspector();
    expect(getViewport3DInspectorSnapshot().section).toBe("quality");
    setViewport3DInspectorSection("export");
    expect(getViewport3DInspectorSnapshot().section).toBe("export");
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
  });
});
