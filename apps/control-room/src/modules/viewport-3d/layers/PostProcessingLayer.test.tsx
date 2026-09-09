import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockN8AO = vi.fn((props: Record<string, unknown>) => null);
const mockBloom = vi.fn((props: Record<string, unknown>) => null);
const mockEffectComposer = vi.fn((props: { children?: React.ReactNode; multisampling: number }) => null);

vi.mock("@react-three/postprocessing", () => ({
  Bloom: (props: Record<string, unknown>) => mockBloom(props),
  EffectComposer: (props: { children?: React.ReactNode; multisampling: number }) => mockEffectComposer(props),
  N8AO: (props: Record<string, unknown>) => mockN8AO(props),
}));

let currentCommandWidgets = {
  effectAmbientOcclusion: false,
  effectAntialias: false,
  effectBloom: false,
};

vi.mock("../viewport3dStore", () => ({
  useViewport3DCommandState: () => ({ widgets: currentCommandWidgets }),
}));

interface MockChildProps {
  aoRadius?: number;
  color?: string;
  halfRes?: boolean;
  intensity?: number;
  luminanceSmoothing?: number;
  luminanceThreshold?: number;
}

type MockChildElement = React.ReactElement<MockChildProps>;

interface MockComposerProps {
  children?: MockChildElement[];
  multisampling?: number;
}

import { PostProcessingLayer } from "./PostProcessingLayer";

describe("PostProcessingLayer (S-16)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentCommandWidgets = {
      effectAmbientOcclusion: false,
      effectAntialias: false,
      effectBloom: false,
    };
  });

  it("returns null when both ambient occlusion and bloom are disabled", () => {
    const result = PostProcessingLayer({ sceneRadius: 10 });
    expect(result).toBeNull();
  });

  it("scales aoRadius proportionally to sceneRadius when ambient occlusion is enabled", () => {
    currentCommandWidgets.effectAmbientOcclusion = true;

    // sceneRadius = 10 -> aoRadius = 10 * 0.05 = 0.5
    const element1 = PostProcessingLayer({ sceneRadius: 10 });
    expect(element1).not.toBeNull();
    const children1 = (element1?.props as { children: MockChildElement[] }).children;
    expect(children1).toHaveLength(1);
    expect(children1[0]!.props.aoRadius).toBe(0.5);

    // sceneRadius = 1e-6 (typical micromagnetic coordinate scale) -> aoRadius = 5e-8
    const element2 = PostProcessingLayer({ sceneRadius: 1e-6 });
    const children2 = (element2?.props as { children: MockChildElement[] }).children;
    expect(children2[0]!.props.aoRadius).toBeCloseTo(5e-8, 12);
  });

  it("enforces minimum aoRadius floor of 1e-9 for degenerate or empty scenes (sceneRadius = 0)", () => {
    currentCommandWidgets.effectAmbientOcclusion = true;

    const element = PostProcessingLayer({ sceneRadius: 0 });
    const children = (element?.props as { children: MockChildElement[] }).children;
    expect(children[0]!.props.aoRadius).toBe(1e-9);

    const elementNegative = PostProcessingLayer({ sceneRadius: -10 });
    const childrenNegative = (elementNegative?.props as { children: MockChildElement[] }).children;
    expect(childrenNegative[0]!.props.aoRadius).toBe(1e-9);
  });

  it("uses luminanceThreshold = 1 for Bloom to prevent burning sequential/diverging palettes", () => {
    currentCommandWidgets.effectBloom = true;

    const element = PostProcessingLayer({ sceneRadius: 1 });
    const children = (element?.props as { children: MockChildElement[] }).children;
    expect(children).toHaveLength(1);
    expect(children[0]!.props.luminanceThreshold).toBe(1);
    expect(children[0]!.props.luminanceSmoothing).toBe(0.1);
    expect(children[0]!.props.intensity).toBe(1.2);
  });

  it("configures EffectComposer multisampling based on effectAntialias", () => {
    currentCommandWidgets.effectBloom = true;
    currentCommandWidgets.effectAntialias = false;

    const elementNoAa = PostProcessingLayer({ sceneRadius: 1 });
    expect((elementNoAa?.props as MockComposerProps).multisampling).toBe(0);

    currentCommandWidgets.effectAntialias = true;
    const elementWithAa = PostProcessingLayer({ sceneRadius: 1 });
    expect((elementWithAa?.props as MockComposerProps).multisampling).toBe(4);
  });

  it("preserves S-16 documentation comments and scale invariants in source", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./PostProcessingLayer.tsx", import.meta.url)),
      "utf8",
    );

    expect(source).toContain("sceneRadius: number;");
    expect(source).toContain("const aoRadius = Math.max(sceneRadius * 0.05, 1e-9);");
    expect(source).toContain("luminanceThreshold={1}");
    expect(source).toContain("aoRadius={aoRadius}");
    // Strip comments to verify JSX attributes specifically
    const stripped = source.replace(/\/\/[^\n]*/g, "");
    expect(stripped).not.toContain("aoRadius={0.5}");
    expect(stripped).not.toContain("luminanceThreshold={0.5}");
  });
});

