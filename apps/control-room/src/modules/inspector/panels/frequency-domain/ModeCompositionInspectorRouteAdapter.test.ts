import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { InspectorPanelProps } from "../../inspectorTypes";
import {
  EigenSpectrumCompositionInspectorRoute,
  ModeCompositionActiveInspectorRoute,
  ModeCompositionObjectInspectorRoute,
  ModeCompositionObjectsInspectorRoute,
} from "./ModeCompositionInspectorRouteAdapter";
import { modeCompositionInspectorDependenciesFromResources } from "./modeCompositionInspectorDependencies";

const fixtures = vi.hoisted(() => ({
  composition: { source: "composition-resource" },
  controller: { source: "kernel-controller" },
  scene: { source: "scene-resource" },
  spectrum: { source: "spectrum-v3-resource" },
  dependencies: { source: "converted-dependencies" },
  panels: {
    spectrum: vi.fn((props: unknown) => { void props; return null; }),
    active: vi.fn((props: unknown) => { void props; return null; }),
    objects: vi.fn((props: unknown) => { void props; return null; }),
    object: vi.fn((props: unknown) => { void props; return null; }),
  },
}));

vi.mock("@/kernel/KernelContext", () => ({
  useKernel: () => ({ modeComposition: fixtures.controller }),
}));
vi.mock("@/kernel/resources/geometryLifecycleResources", () => ({
  useSceneResource: () => ({ data: fixtures.scene }),
}));
vi.mock("@/kernel/resources/modeCompositionResources", () => ({
  useModeCompositionControllerResource: () => ({ resource: { data: fixtures.composition } }),
}));
vi.mock("@/kernel/resources/studyRuntimeResources", () => ({
  useFrequencyDomainEigenSpectrumV3Resource: () => ({ data: fixtures.spectrum }),
}));
vi.mock("./modeCompositionInspectorDependencies", () => ({
  modeCompositionInspectorDependenciesFromResources: vi.fn(() => fixtures.dependencies),
}));
vi.mock("./ModeCompositionInspectors", () => ({
  EigenSpectrumCompositionInspectorPanel: fixtures.panels.spectrum,
  ModeCompositionActiveInspectorPanel: fixtures.panels.active,
  ModeCompositionObjectsInspectorPanel: fixtures.panels.objects,
  ModeCompositionObjectInspectorPanel: fixtures.panels.object,
}));

// Active route ownership is checked by inspectorRegistry.test.tsx. These
// optional composition adapters must not redefine the existing spectrum route.
describe("ModeCompositionInspectorRouteAdapter resource boundary", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["spectrum", EigenSpectrumCompositionInspectorRoute],
    ["active", ModeCompositionActiveInspectorRoute],
    ["objects", ModeCompositionObjectsInspectorRoute],
    ["object", ModeCompositionObjectInspectorRoute],
  ] as const)("passes resource-derived dependencies to the %s panel", (name, Route) => {
    const props: InspectorPanelProps = {
      selection: {
        kind: "results.eigen.spectrum", label: "Spectrum", moduleSource: "inspector",
        nodeId: null, objectId: null, ref: null,
      },
    };
    renderToStaticMarkup(createElement(Route, props));

    expect(modeCompositionInspectorDependenciesFromResources).toHaveBeenCalledWith({
      composition: fixtures.composition,
      controller: fixtures.controller,
      scene: fixtures.scene,
      spectrumArtifact: fixtures.spectrum,
    });
    expect(fixtures.panels[name]).toHaveBeenCalledTimes(1);
    expect(fixtures.panels[name].mock.calls[0]?.[0]).toEqual({
      ...props,
      dependencies: fixtures.dependencies,
    });
  });
});
