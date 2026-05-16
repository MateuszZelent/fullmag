# Per-Object Visualization Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add production-grade per-object, per-airbox, and per-part display controls for shader, wireframe, vectors, opacity, and coloring in `apps/control-room`.

**Architecture:** Extend the kernel `ObjectVisualizationController` with small style preferences, keep backend-owned airbox visibility/opacity in `visualization/state`, and let `Viewport3DModule` resolve effective target styles before rendering. The 3D field render model must provide scalar color buffers by requested color mode so one target can use HSL orientation while another target uses monochrome or another scalar mode.

**Tech Stack:** Next.js 16, React 19, TypeScript, Vitest, Three.js, `apps/control-room` frontend v2 module kernel.

---

## File Structure

- Modify `apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts`
  - Add target style fields, defaults, and normalization.
  - Keep snapshots stable by bumping only on semantic patch changes.
- Modify `apps/control-room/src/kernel/visualization/ObjectVisualizationController.test.ts`
  - Cover target style merge, clear, clamp, and airbox local/backend split.
- Create `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.ts`
  - Pure section/control model for inspector display controls.
- Create `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts`
  - Test which controls appear for visible/hidden targets and style values.
- Modify `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx`
  - Render the model sections and patch the same target registry fields.
- Modify `apps/control-room/src/modules/ribbon/ribbonContributions.tsx`
  - Extend `View -> Selected Display` with shader/wireframe/vector style menus.
- Modify `apps/control-room/src/modules/ribbon/ribbonStructure.test.ts`
  - Verify selected object and selected airbox style controls patch the same target.
- Modify `apps/control-room/src/modules/viewport-3d/model/viewport3DTargets.ts`
  - Map backend global display into richer target fallback settings.
- Modify `apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.ts`
  - Add `scalarColorModes` and `scalarColorsByMode`.
- Modify `apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.test.ts`
  - Verify two color modes can be generated for one field vector.
- Modify `apps/control-room/src/modules/viewport-3d/layers/viewport3DLayerSettings.ts`
  - Add style conversion helpers used by all layers.
- Modify 3D layers:
  - `apps/control-room/src/modules/viewport-3d/layers/PrimitiveObjectLayer.tsx`
  - `apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.tsx`
  - `apps/control-room/src/modules/viewport-3d/layers/BoundsLayers.tsx`
  - `apps/control-room/src/modules/viewport-3d/layers/FallbackTopologyMeshLayer.tsx`
  - `apps/control-room/src/modules/viewport-3d/layers/FdmCuboidLayer.tsx`
  - `apps/control-room/src/modules/viewport-3d/layers/TopologyMeshLayer.tsx`
  - `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx`
  - `apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx`
- Update focused layer tests:
  - `apps/control-room/src/modules/viewport-3d/layers/VectorFieldLayer.test.ts`
  - `apps/control-room/src/modules/viewport-3d/layers/BoundsLayers.test.tsx`
  - `apps/control-room/src/modules/viewport-3d/layers/PrimitiveObjectLayer.test.tsx`

---

### Task 1: Extend Target Visualization Settings

**Files:**
- Modify: `apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts`
- Modify: `apps/control-room/src/kernel/visualization/ObjectVisualizationController.test.ts`

- [ ] **Step 1: Write failing controller tests**

Add these imports and tests to `ObjectVisualizationController.test.ts`:

```ts
import {
  DEFAULT_AIRBOX_VISUALIZATION,
  DEFAULT_OBJECT_VISUALIZATION,
} from "./ObjectVisualizationController";
```

```ts
it("keeps production style defaults for object and airbox targets", () => {
  expect(DEFAULT_OBJECT_VISUALIZATION).toMatchObject({
    shaderColorMode: "orientation",
    shaderMonoColor: "var(--fm-surface-magnetic)",
    vectorColorMode: "orientation",
    vectorMonoColor: "var(--fm-accent)",
    vectorAlphaPercent: 100,
    vectorThickness: 1,
    wireframeColor: "var(--fm-border-strong)",
    wireframeOpacityPercent: 100,
  });
  expect(DEFAULT_AIRBOX_VISUALIZATION).toMatchObject({
    shaderColorMode: "monochrome",
    shaderMonoColor: "var(--fm-airbox-fill)",
    vectorColorMode: "orientation",
    vectorMonoColor: "var(--fm-accent)",
    wireframeColor: "var(--fm-airbox-wire)",
    wireframeOpacityPercent: 100,
  });
});

it("patches and normalizes per-target shader wireframe and vector style fields", () => {
  const controller = new ObjectVisualizationController();
  const target = { id: "arch", kind: "object" as const };

  controller.patchTarget(target, {
    shaderColorMode: "monochrome",
    shaderMonoColor: "#ff3366",
    vectorAlphaPercent: 144,
    vectorColorMode: "x",
    vectorMonoColor: "#44ccff",
    vectorThickness: -3,
    wireframeColor: "#111111",
    wireframeOpacityPercent: -20,
  });

  expect(controller.getSettings(target)).toMatchObject({
    shaderColorMode: "monochrome",
    shaderMonoColor: "#ff3366",
    vectorAlphaPercent: 100,
    vectorColorMode: "x",
    vectorMonoColor: "#44ccff",
    vectorThickness: 0.1,
    wireframeColor: "#111111",
    wireframeOpacityPercent: 0,
  });
});

it("keeps local-only airbox style fields out of backend visualization patches", () => {
  expect(
    airboxVisualizationStatePatchFromTargetPatch({
      shaderColorMode: "monochrome",
      shaderMonoColor: "#ffffff",
      vectorAlphaPercent: 44,
      vectorColorMode: "magnitude",
      vectorThickness: 2,
      wireframeColor: "#888888",
      wireframeOpacityPercent: 75,
    }),
  ).toEqual({});
  expect(
    airboxLocalVisualizationPatchFromTargetPatch({
      shaderColorMode: "monochrome",
      shaderMonoColor: "#ffffff",
      vectorAlphaPercent: 44,
      vectorColorMode: "magnitude",
      vectorThickness: 2,
      wireframeColor: "#888888",
      wireframeOpacityPercent: 75,
    }),
  ).toEqual({
    shaderColorMode: "monochrome",
    shaderMonoColor: "#ffffff",
    vectorAlphaPercent: 44,
    vectorColorMode: "magnitude",
    vectorThickness: 2,
    wireframeColor: "#888888",
    wireframeOpacityPercent: 75,
  });
});
```

- [ ] **Step 2: Run the focused controller test and verify failure**

Run:

```bash
TMPDIR=/dev/shm pnpm --dir apps/control-room test src/kernel/visualization/ObjectVisualizationController.test.ts
```

Expected: FAIL because the new fields and exports do not exist yet.

- [ ] **Step 3: Add the target style model**

In `ObjectVisualizationController.ts`, add the type and fields:

```ts
export type VisualizationColorMode =
  | "orientation"
  | "x"
  | "y"
  | "z"
  | "magnitude"
  | "monochrome";
```

Extend `VisualizationTargetSettings`:

```ts
  shaderColorMode: VisualizationColorMode;
  shaderMonoColor: string;
  vectorAlphaPercent: number;
  vectorColorMode: VisualizationColorMode;
  vectorMonoColor: string;
  vectorThickness: number;
  wireframeColor: string;
  wireframeOpacityPercent: number;
```

Update defaults:

```ts
export const DEFAULT_OBJECT_VISUALIZATION: VisualizationTargetSettings = {
  boundsVisible: false,
  geometryScope: "full",
  opacityPercent: 55,
  pointsVisible: false,
  renderMode: "surface+edges",
  shaderColorMode: "orientation",
  shaderMonoColor: "var(--fm-surface-magnetic)",
  shaderVisible: true,
  vectorAlphaPercent: 100,
  vectorColorMode: "orientation",
  vectorMonoColor: "var(--fm-accent)",
  vectorThickness: 1,
  vectorsVisible: false,
  visible: true,
  wireframeColor: "var(--fm-border-strong)",
  wireframeOpacityPercent: 100,
  wireframeVisible: true,
};

export const DEFAULT_AIRBOX_VISUALIZATION: VisualizationTargetSettings = {
  boundsVisible: false,
  geometryScope: "full",
  opacityPercent: 28,
  pointsVisible: false,
  renderMode: "wireframe",
  shaderColorMode: "monochrome",
  shaderMonoColor: "var(--fm-airbox-fill)",
  shaderVisible: false,
  vectorAlphaPercent: 100,
  vectorColorMode: "orientation",
  vectorMonoColor: "var(--fm-accent)",
  vectorThickness: 1,
  vectorsVisible: false,
  visible: true,
  wireframeColor: "var(--fm-airbox-wire)",
  wireframeOpacityPercent: 100,
  wireframeVisible: true,
};
```

Add normalization helpers:

```ts
function normalizeColorMode(value: unknown): VisualizationColorMode | undefined {
  return value === "orientation" ||
    value === "x" ||
    value === "y" ||
    value === "z" ||
    value === "magnitude" ||
    value === "monochrome"
    ? value
    : undefined;
}

function clampScale(value: number): number {
  return Math.min(8, Math.max(0.1, value));
}
```

Extend `normalizePatch`:

```ts
  if (normalized.vectorAlphaPercent !== undefined) {
    normalized.vectorAlphaPercent = clampOpacity(normalized.vectorAlphaPercent);
  }
  if (normalized.wireframeOpacityPercent !== undefined) {
    normalized.wireframeOpacityPercent = clampOpacity(
      normalized.wireframeOpacityPercent,
    );
  }
  if (normalized.vectorThickness !== undefined) {
    normalized.vectorThickness = clampScale(normalized.vectorThickness);
  }
  if (normalized.shaderColorMode !== undefined) {
    normalized.shaderColorMode =
      normalizeColorMode(normalized.shaderColorMode) ?? "orientation";
  }
  if (normalized.vectorColorMode !== undefined) {
    normalized.vectorColorMode =
      normalizeColorMode(normalized.vectorColorMode) ?? "orientation";
  }
```

Extend `airboxLocalVisualizationPatchFromTargetPatch` with the local style fields:

```ts
    ...(patch.shaderColorMode === undefined
      ? {}
      : { shaderColorMode: patch.shaderColorMode }),
    ...(patch.shaderMonoColor === undefined
      ? {}
      : { shaderMonoColor: patch.shaderMonoColor }),
    ...(patch.vectorAlphaPercent === undefined
      ? {}
      : { vectorAlphaPercent: patch.vectorAlphaPercent }),
    ...(patch.vectorColorMode === undefined
      ? {}
      : { vectorColorMode: patch.vectorColorMode }),
    ...(patch.vectorMonoColor === undefined
      ? {}
      : { vectorMonoColor: patch.vectorMonoColor }),
    ...(patch.vectorThickness === undefined
      ? {}
      : { vectorThickness: patch.vectorThickness }),
    ...(patch.wireframeColor === undefined
      ? {}
      : { wireframeColor: patch.wireframeColor }),
    ...(patch.wireframeOpacityPercent === undefined
      ? {}
      : { wireframeOpacityPercent: patch.wireframeOpacityPercent }),
```

- [ ] **Step 4: Run controller tests and verify pass**

Run:

```bash
TMPDIR=/dev/shm pnpm --dir apps/control-room test src/kernel/visualization/ObjectVisualizationController.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit controller model**

```bash
git add apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts apps/control-room/src/kernel/visualization/ObjectVisualizationController.test.ts
git commit -m "Add per-target visualization style settings"
```

---

### Task 2: Add Inspector Section Model

**Files:**
- Create: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.ts`
- Create: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts`

- [ ] **Step 1: Write failing model tests**

Create `ObjectVisualizationPanelModel.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  DEFAULT_OBJECT_VISUALIZATION,
  resolveEffectiveVisualizationSettings,
} from "@/kernel/visualization/ObjectVisualizationController";

import {
  buildVisualizationPanelSections,
  VISUALIZATION_COLOR_MODE_ITEMS,
} from "./ObjectVisualizationPanelModel";

describe("ObjectVisualizationPanelModel", () => {
  it("exposes the production color mode options used by Global Display", () => {
    expect(VISUALIZATION_COLOR_MODE_ITEMS.map((item) => item.value)).toEqual([
      "orientation",
      "x",
      "y",
      "z",
      "magnitude",
      "monochrome",
    ]);
  });

  it("builds pass-specific sections for a visible object target", () => {
    const sections = buildVisualizationPanelSections({
      settings: DEFAULT_OBJECT_VISUALIZATION,
      effectiveSettings: resolveEffectiveVisualizationSettings(
        DEFAULT_OBJECT_VISUALIZATION,
      ),
    });

    expect(sections.map((section) => section.id)).toEqual([
      "display-passes",
      "surface-shader",
      "wireframe",
      "vectors",
      "geometry-scope",
      "opacity",
      "overrides",
    ]);
    expect(sections.find((section) => section.id === "surface-shader"))
      .toMatchObject({
        disabled: false,
        fields: expect.arrayContaining([
          expect.objectContaining({ id: "shaderColorMode" }),
          expect.objectContaining({ id: "shaderMonoColor" }),
        ]),
      });
  });

  it("marks pass-specific controls inactive while preserving configured values", () => {
    const hidden = {
      ...DEFAULT_OBJECT_VISUALIZATION,
      visible: false,
      vectorsVisible: true,
    };
    const sections = buildVisualizationPanelSections({
      settings: hidden,
      effectiveSettings: resolveEffectiveVisualizationSettings(hidden),
    });

    expect(sections.find((section) => section.id === "surface-shader"))
      .toMatchObject({ disabled: true });
    expect(sections.find((section) => section.id === "vectors"))
      .toMatchObject({ disabled: true });
  });
});
```

- [ ] **Step 2: Run the model test and verify failure**

Run:

```bash
TMPDIR=/dev/shm pnpm --dir apps/control-room test src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts
```

Expected: FAIL because the model file does not exist.

- [ ] **Step 3: Create the model**

Create `ObjectVisualizationPanelModel.ts`:

```ts
import type {
  VisualizationColorMode,
  VisualizationTargetSettings,
} from "@/kernel/visualization/ObjectVisualizationController";

export const VISUALIZATION_COLOR_MODE_ITEMS: Array<{
  label: string;
  value: VisualizationColorMode;
}> = [
  { value: "orientation", label: "HSL orientation" },
  { value: "x", label: "X component" },
  { value: "y", label: "Y component" },
  { value: "z", label: "Z component" },
  { value: "magnitude", label: "Magnitude" },
  { value: "monochrome", label: "Monochrome" },
];

export interface VisualizationPanelField {
  id: keyof VisualizationTargetSettings;
  kind: "color" | "mode" | "number" | "toggle";
  label: string;
}

export interface VisualizationPanelSection {
  disabled: boolean;
  fields: VisualizationPanelField[];
  id:
    | "display-passes"
    | "geometry-scope"
    | "opacity"
    | "overrides"
    | "surface-shader"
    | "vectors"
    | "wireframe";
  title: string;
}

export function buildVisualizationPanelSections({
  effectiveSettings,
  settings,
}: {
  effectiveSettings: VisualizationTargetSettings;
  settings: VisualizationTargetSettings;
}): VisualizationPanelSection[] {
  const passDisabled = !settings.visible;

  return [
    {
      disabled: false,
      fields: [
        { id: "visible", kind: "toggle", label: "Visible" },
        { id: "shaderVisible", kind: "toggle", label: "Shader" },
        { id: "wireframeVisible", kind: "toggle", label: "Wireframe" },
        { id: "boundsVisible", kind: "toggle", label: "Frame" },
        { id: "pointsVisible", kind: "toggle", label: "Points" },
        { id: "vectorsVisible", kind: "toggle", label: "Vectors" },
      ],
      id: "display-passes",
      title: "Display Passes",
    },
    {
      disabled: passDisabled || !effectiveSettings.shaderVisible,
      fields: [
        { id: "shaderColorMode", kind: "mode", label: "Shader coloring" },
        { id: "shaderMonoColor", kind: "color", label: "Monochrome color" },
      ],
      id: "surface-shader",
      title: "Surface Shader",
    },
    {
      disabled: passDisabled || !effectiveSettings.wireframeVisible,
      fields: [
        { id: "wireframeColor", kind: "color", label: "Wireframe color" },
        {
          id: "wireframeOpacityPercent",
          kind: "number",
          label: "Wireframe opacity",
        },
      ],
      id: "wireframe",
      title: "Wireframe",
    },
    {
      disabled: passDisabled || !effectiveSettings.vectorsVisible,
      fields: [
        { id: "vectorColorMode", kind: "mode", label: "Vector coloring" },
        { id: "vectorMonoColor", kind: "color", label: "Vector mono color" },
        { id: "vectorAlphaPercent", kind: "number", label: "Vector alpha" },
        { id: "vectorThickness", kind: "number", label: "Vector thickness" },
      ],
      id: "vectors",
      title: "Vectors",
    },
    {
      disabled: passDisabled,
      fields: [{ id: "geometryScope", kind: "mode", label: "Geometry scope" }],
      id: "geometry-scope",
      title: "Geometry Scope",
    },
    {
      disabled: false,
      fields: [{ id: "opacityPercent", kind: "number", label: "Opacity" }],
      id: "opacity",
      title: "Opacity",
    },
    {
      disabled: false,
      fields: [],
      id: "overrides",
      title: "Overrides",
    },
  ];
}
```

- [ ] **Step 4: Run model tests and verify pass**

Run:

```bash
TMPDIR=/dev/shm pnpm --dir apps/control-room test src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit inspector model**

```bash
git add apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.ts apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts
git commit -m "Add visualization inspector section model"
```

---

### Task 3: Render Per-Target Inspector Style Controls

**Files:**
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts`

- [ ] **Step 1: Extend the model test for concrete patchable fields**

Add this test to `ObjectVisualizationPanelModel.test.ts`:

```ts
it("keeps shader vector and wireframe fields addressable by target setting keys", () => {
  const sections = buildVisualizationPanelSections({
    settings: DEFAULT_OBJECT_VISUALIZATION,
    effectiveSettings: resolveEffectiveVisualizationSettings(
      DEFAULT_OBJECT_VISUALIZATION,
    ),
  });
  const fieldIds = sections.flatMap((section) =>
    section.fields.map((field) => field.id),
  );

  expect(fieldIds).toEqual(expect.arrayContaining([
    "shaderColorMode",
    "shaderMonoColor",
    "wireframeColor",
    "wireframeOpacityPercent",
    "vectorColorMode",
    "vectorMonoColor",
    "vectorAlphaPercent",
    "vectorThickness",
  ]));
});
```

- [ ] **Step 2: Run inspector model tests and verify current pass**

Run:

```bash
TMPDIR=/dev/shm pnpm --dir apps/control-room test src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts
```

Expected: PASS. This confirms the pure model is ready before UI wiring.

- [ ] **Step 3: Render style controls in `ObjectVisualizationPanel.tsx`**

Import the model:

```ts
import {
  buildVisualizationPanelSections,
  VISUALIZATION_COLOR_MODE_ITEMS,
} from "./ObjectVisualizationPanelModel";
```

Inside `ObjectVisualizationPanel`, after `effectiveSettings` is computed:

```ts
  const sections = settings && effectiveSettings
    ? buildVisualizationPanelSections({ effectiveSettings, settings })
    : [];
```

Add helper functions inside the component:

```ts
  function patchColor(field: "shaderMonoColor" | "vectorMonoColor" | "wireframeColor", value: string) {
    void patch({ [field]: value });
  }

  function patchNumber(
    field: "vectorAlphaPercent" | "vectorThickness" | "wireframeOpacityPercent",
    value: number,
  ) {
    void patch({ [field]: value });
  }
```

Add these sections before `Geometry Scope`:

```tsx
      <InspectorSection title="Surface Shader">
        <div className="fm-visualization-segments" role="group" aria-label="Shader coloring">
          {VISUALIZATION_COLOR_MODE_ITEMS.map((mode) => (
            <Button
              key={mode.value}
              size="sm"
              type="button"
              disabled={passControlsDisabled || !effectiveSettings?.shaderVisible}
              variant={settings.shaderColorMode === mode.value ? "primary" : "secondary"}
              onClick={() => void patch({ shaderColorMode: mode.value })}
            >
              {mode.label}
            </Button>
          ))}
        </div>
        <ColorField
          disabled={passControlsDisabled || !effectiveSettings?.shaderVisible}
          label="Monochrome color"
          value={settings.shaderMonoColor}
          onChange={(value) => patchColor("shaderMonoColor", value)}
        />
      </InspectorSection>

      <InspectorSection title="Wireframe">
        <ColorField
          disabled={passControlsDisabled || !effectiveSettings?.wireframeVisible}
          label="Wireframe color"
          value={settings.wireframeColor}
          onChange={(value) => patchColor("wireframeColor", value)}
        />
        <NumberField
          disabled={passControlsDisabled || !effectiveSettings?.wireframeVisible}
          label="Wireframe opacity"
          max={100}
          min={0}
          step={1}
          unit="%"
          value={settings.wireframeOpacityPercent}
          onChange={(value) => patchNumber("wireframeOpacityPercent", value)}
        />
      </InspectorSection>

      <InspectorSection title="Vectors">
        <div className="fm-visualization-segments" role="group" aria-label="Vector coloring">
          {VISUALIZATION_COLOR_MODE_ITEMS.map((mode) => (
            <Button
              key={mode.value}
              size="sm"
              type="button"
              disabled={passControlsDisabled || !effectiveSettings?.vectorsVisible}
              variant={settings.vectorColorMode === mode.value ? "primary" : "secondary"}
              onClick={() => void patch({ vectorColorMode: mode.value })}
            >
              {mode.label}
            </Button>
          ))}
        </div>
        <ColorField
          disabled={passControlsDisabled || !effectiveSettings?.vectorsVisible}
          label="Vector mono color"
          value={settings.vectorMonoColor}
          onChange={(value) => patchColor("vectorMonoColor", value)}
        />
        <NumberField
          disabled={passControlsDisabled || !effectiveSettings?.vectorsVisible}
          label="Vector alpha"
          max={100}
          min={0}
          step={1}
          unit="%"
          value={settings.vectorAlphaPercent}
          onChange={(value) => patchNumber("vectorAlphaPercent", value)}
        />
        <NumberField
          disabled={passControlsDisabled || !effectiveSettings?.vectorsVisible}
          label="Vector thickness"
          max={8}
          min={0.1}
          step={0.1}
          value={settings.vectorThickness}
          onChange={(value) => patchNumber("vectorThickness", value)}
        />
      </InspectorSection>
```

Add helper components below `ToggleButton`:

```tsx
function ColorField({
  disabled,
  label,
  onChange,
  value,
}: {
  disabled: boolean;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label className="fm-visualization-color-field">
      <span>{label}</span>
      <input
        disabled={disabled}
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function NumberField({
  disabled,
  label,
  max,
  min,
  onChange,
  step,
  unit,
  value,
}: {
  disabled: boolean;
  label: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  step: number;
  unit?: string;
  value: number;
}) {
  return (
    <label className="fm-visualization-range">
      <span>{unit ? `${label}: ${value}${unit}` : `${label}: ${value}`}</span>
      <input
        disabled={disabled}
        max={max}
        min={min}
        step={step}
        type="range"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}
```

- [ ] **Step 4: Run inspector tests and typecheck**

Run:

```bash
TMPDIR=/dev/shm pnpm --dir apps/control-room test src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts src/modules/inspector/inspectorRegistry.test.tsx
TMPDIR=/dev/shm pnpm --dir apps/control-room typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit inspector UI**

```bash
git add apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts
git commit -m "Expand object visualization inspector controls"
```

---

### Task 4: Extend Selected Display Ribbon Controls

**Files:**
- Modify: `apps/control-room/src/modules/ribbon/ribbonContributions.tsx`
- Modify: `apps/control-room/src/modules/ribbon/ribbonStructure.test.ts`

- [ ] **Step 1: Write failing selected object ribbon test**

Add this test to `ribbonStructure.test.ts` after `enables selected display controls from the object visualization registry`:

```ts
  it("patches selected object shader wireframe and vector style controls", () => {
    const visualization = new ObjectVisualizationController();
    const content = buildRibbonTabContent("view", {
      selection: {
        kind: "object.visualization",
        label: "Arch",
        moduleSource: "test",
        nodeId: "model:object:arch:visualization",
        objectId: "arch",
        ref: null,
      },
      visualization,
      visualizationSnapshot: visualization.getSnapshot(),
    });
    const selectedGroup = content?.groups.find(
      (group) => group.id === "view-selected-display",
    );
    const textureAction = selectedGroup?.actions.find(
      (action) => action.id === "view-selected-texture",
    );
    const shaderModeNode = textureAction?.menu?.find(
      (node) => node.type === "radio-group" && node.id === "selected-texture:shader-coloring",
    );
    const vectorModeNode = textureAction?.menu?.find(
      (node) => node.type === "radio-group" && node.id === "selected-texture:vector-coloring",
    );
    const renderAction = selectedGroup?.actions.find(
      (action) => action.id === "view-selected-render",
    );
    const wireframeOpacityNode = renderAction?.menu?.find(
      (node) => node.type === "slider" && node.id === "selected:wireframe-opacity",
    );

    if (
      shaderModeNode?.type !== "radio-group" ||
      vectorModeNode?.type !== "radio-group" ||
      wireframeOpacityNode?.type !== "slider"
    ) {
      throw new Error("Expected selected display style controls");
    }

    shaderModeNode.onValueChange?.("monochrome");
    vectorModeNode.onValueChange?.("x");
    wireframeOpacityNode.onValueChange?.(45);

    expect(visualization.getSettings({ id: "arch", kind: "object" }))
      .toMatchObject({
        shaderColorMode: "monochrome",
        vectorColorMode: "x",
        wireframeOpacityPercent: 45,
      });
  });
```

- [ ] **Step 2: Run ribbon test and verify failure**

Run:

```bash
TMPDIR=/dev/shm pnpm --dir apps/control-room test src/modules/ribbon/ribbonStructure.test.ts
```

Expected: FAIL because the selected style nodes do not exist.

- [ ] **Step 3: Add selected style controls**

In `ribbonContributions.tsx`, reuse `VECTOR_COLOR_ITEMS` for shader and vector color modes.

In `buildSelectedVisualizationGroup`, extend `view-selected-texture.menu` after `selected-texture:visible`:

```ts
          {
            type: "radio-group",
            id: "selected-texture:shader-coloring",
            label: "Shader coloring",
            value: settings?.shaderColorMode ?? "orientation",
            disabled: !enabled || passControlsDisabled,
            items: VECTOR_COLOR_ITEMS,
            onValueChange: (value) =>
              patch({ shaderColorMode: value as VisualizationColorMode }),
          },
          {
            type: "color",
            id: "selected-texture:shader-mono-color",
            label: "Shader mono color",
            value: settings?.shaderMonoColor ?? "var(--fm-surface-magnetic)",
            disabled: !enabled || passControlsDisabled,
          },
```

Extend `view-selected-texture.menu` after `selected-texture:vectors`:

```ts
          {
            type: "radio-group",
            id: "selected-texture:vector-coloring",
            label: "Vector coloring",
            value: settings?.vectorColorMode ?? "orientation",
            disabled: !enabled || passControlsDisabled,
            items: VECTOR_COLOR_ITEMS,
            onValueChange: (value) =>
              patch({ vectorColorMode: value as VisualizationColorMode }),
          },
          {
            type: "slider",
            id: "selected-texture:vector-alpha",
            label: "Vector alpha",
            value: settings?.vectorAlphaPercent ?? 100,
            min: 0,
            max: 100,
            step: 1,
            unit: "%",
            disabled: !enabled || passControlsDisabled,
            onValueChange: (value) => patch({ vectorAlphaPercent: value }),
          },
          {
            type: "slider",
            id: "selected-texture:vector-thickness",
            label: "Vector thickness",
            value: settings?.vectorThickness ?? 1,
            min: 0.1,
            max: 8,
            step: 0.1,
            disabled: !enabled || passControlsDisabled,
            onValueChange: (value) => patch({ vectorThickness: value }),
          },
```

Extend `view-selected-render.menu` after `selected:wireframe`:

```ts
          {
            type: "color",
            id: "selected:wireframe-color",
            label: "Wireframe color",
            value: settings?.wireframeColor ?? "var(--fm-border-strong)",
            disabled: !enabled || passControlsDisabled,
          },
          {
            type: "slider",
            id: "selected:wireframe-opacity",
            label: "Wireframe opacity",
            value: settings?.wireframeOpacityPercent ?? 100,
            min: 0,
            max: 100,
            step: 1,
            unit: "%",
            disabled: !enabled || passControlsDisabled,
            onValueChange: (value) => patch({ wireframeOpacityPercent: value }),
          },
```

Add the import:

```ts
  type VisualizationColorMode,
```

- [ ] **Step 4: Run ribbon tests**

Run:

```bash
TMPDIR=/dev/shm pnpm --dir apps/control-room test src/modules/ribbon/ribbonStructure.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit ribbon controls**

```bash
git add apps/control-room/src/modules/ribbon/ribbonContributions.tsx apps/control-room/src/modules/ribbon/ribbonStructure.test.ts
git commit -m "Add selected target display style controls"
```

---

### Task 5: Add Per-Mode Scalar Color Buffers

**Files:**
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.test.ts`

- [ ] **Step 1: Write failing render-model test**

Add this test to `viewport3dRenderModel.test.ts`:

```ts
  it("builds scalar color buffers for every requested target shader mode", () => {
    const topology = buildViewport3DTopologyRenderModel(
      {
        indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
        nodeCount: 4,
        positions: new Float32Array([
          0, 0, 0,
          1, 0, 0,
          0, 1, 0,
          0, 0, 1,
        ]),
      },
      [],
      [],
    );
    const fieldVector = {
      component: "full",
      pointCount: 4,
      values: new Float32Array([
        1, 0, 0,
        0, 0, 1,
        0, 1, 0,
        0, 0, -1,
      ]),
    };

    const model = buildViewport3DFieldRenderModel(
      topology,
      fieldVector,
      1,
      {
        scalarColorModes: new Set(["orientation", "magnitude", "monochrome"]),
      },
    );

    expect(model?.scalarColorsByMode.get("orientation")?.colors.length).toBe(12);
    expect(model?.scalarColorsByMode.get("magnitude")?.colors.length).toBe(12);
    expect(model?.scalarColorsByMode.has("monochrome")).toBe(false);
  });
```

- [ ] **Step 2: Run render-model test and verify failure**

Run:

```bash
TMPDIR=/dev/shm pnpm --dir apps/control-room test src/modules/viewport-3d/viewport3dRenderModel.test.ts
```

Expected: FAIL because `scalarColorModes` and `scalarColorsByMode` do not exist.

- [ ] **Step 3: Extend render model**

In `viewport3dRenderModel.ts`, update interfaces:

```ts
export interface Viewport3DFieldRenderModel {
  fullVectorSegments: Float32Array | null;
  partVectorSegments: Map<string, Float32Array | null>;
  scalarColors: ScalarColorBuffer | null;
  scalarColorsByMode: Map<string, ScalarColorBuffer | null>;
}

export interface Viewport3DFieldRenderOptions {
  fullVectorBudget?: number;
  partVectorBudgets?: ReadonlyMap<string, number>;
  partVectorScopes?: ReadonlyMap<string, "surface" | "full">;
  scalarColorModes?: ReadonlySet<string>;
  scalarColorsVisible?: boolean;
  vectorColorMode?: string;
}
```

In `buildViewport3DFieldRenderModel`, replace scalar color construction with:

```ts
  const requestedScalarColorModes = new Set(
    options.scalarColorModes && options.scalarColorModes.size > 0
      ? [...options.scalarColorModes]
      : [options.vectorColorMode ?? "magnitude"],
  );
  requestedScalarColorModes.delete("monochrome");
  const scalarColorsByMode =
    options.scalarColorsVisible === false
      ? new Map<string, ScalarColorBuffer | null>()
      : new Map(
          [...requestedScalarColorModes].map((colorMode) => [
            colorMode,
            buildCachedVertexScalarColors(fieldVector, topology.nodeCount, colorMode),
          ]),
        );
  const scalarColors =
    scalarColorsByMode.get(options.vectorColorMode ?? "magnitude") ?? null;
```

Return `scalarColorsByMode`:

```ts
    scalarColors,
    scalarColorsByMode,
```

- [ ] **Step 4: Run render-model tests**

Run:

```bash
TMPDIR=/dev/shm pnpm --dir apps/control-room test src/modules/viewport-3d/viewport3dRenderModel.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit render model**

```bash
git add apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.ts apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.test.ts
git commit -m "Build viewport scalar colors by target mode"
```

---

### Task 6: Add Viewport Style Helpers and Layer Wiring

**Files:**
- Modify: `apps/control-room/src/modules/viewport-3d/layers/viewport3DLayerSettings.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/VectorFieldLayer.test.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/PrimitiveObjectLayer.test.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/BoundsLayers.test.tsx`
- Modify: layer files listed in File Structure.

- [ ] **Step 1: Write failing helper tests**

Add to `VectorFieldLayer.test.ts`:

```ts
import {
  shaderColorFromSettings,
  vectorColorModeFromSettings,
  vectorStyleFromSettings,
  wireframeOpacityFromSettings,
} from "./viewport3DLayerSettings";
import { DEFAULT_OBJECT_VISUALIZATION } from "@/kernel/visualization/ObjectVisualizationController";
```

```ts
  it("maps target display settings into shader wireframe and vector layer styles", () => {
    const settings = {
      ...DEFAULT_OBJECT_VISUALIZATION,
      opacityPercent: 50,
      shaderColorMode: "monochrome",
      shaderMonoColor: "#ff3366",
      vectorAlphaPercent: 40,
      vectorColorMode: "x",
      vectorMonoColor: "#44ccff",
      vectorThickness: 2,
      wireframeOpacityPercent: 30,
    };

    expect(shaderColorFromSettings(settings, "#dddddd")).toBe("#ff3366");
    expect(wireframeOpacityFromSettings(settings)).toBe(0.15);
    expect(vectorColorModeFromSettings(settings, "orientation")).toBe("x");
    expect(vectorStyleFromSettings(settings, {})).toEqual({
      alpha: 0.4,
      monoColor: "#44ccff",
      thickness: 2,
    });
  });
```

- [ ] **Step 2: Run helper tests and verify failure**

Run:

```bash
TMPDIR=/dev/shm pnpm --dir apps/control-room test src/modules/viewport-3d/layers/VectorFieldLayer.test.ts
```

Expected: FAIL because helper functions do not exist.

- [ ] **Step 3: Implement helpers**

In `viewport3DLayerSettings.ts`:

```ts
import type { ColorRepresentation } from "three";
import type { VectorFieldLayerVectorStyle } from "./VectorFieldLayer";

export function percentToUnit(value: number): number {
  return Math.max(0, Math.min(1, value / 100));
}

export function shaderColorFromSettings(
  settings: VisualizationTargetSettings,
  fallback: ColorRepresentation,
): ColorRepresentation {
  return settings.shaderColorMode === "monochrome"
    ? settings.shaderMonoColor
    : fallback;
}

export function shaderUsesVertexColors(
  settings: VisualizationTargetSettings,
): boolean {
  return settings.shaderColorMode !== "monochrome";
}

export function vectorColorModeFromSettings(
  settings: VisualizationTargetSettings,
  fallback: string,
): string {
  return settings.vectorColorMode ?? fallback;
}

export function vectorStyleFromSettings(
  settings: VisualizationTargetSettings,
  fallback: VectorFieldLayerVectorStyle,
): VectorFieldLayerVectorStyle {
  return {
    alpha: percentToUnit(settings.vectorAlphaPercent),
    monoColor: settings.vectorMonoColor ?? fallback.monoColor,
    thickness: settings.vectorThickness ?? fallback.thickness,
  };
}

export function wireframeColorFromSettings(
  settings: VisualizationTargetSettings,
  fallback: ColorRepresentation,
): ColorRepresentation {
  return settings.wireframeColor || fallback;
}

export function wireframeOpacityFromSettings(
  settings: VisualizationTargetSettings,
): number {
  return opacityFromSettings(settings) * percentToUnit(settings.wireframeOpacityPercent);
}
```

- [ ] **Step 4: Wire helpers into layers**

Use the helpers in:

- `PrimitiveObjectLayer.tsx`: shader material color uses `shaderColorFromSettings`; wire material uses `wireframeColorFromSettings` and `wireframeOpacityFromSettings`.
- `MeshPartLayer.tsx`: select scalar buffer with `fieldModel?.scalarColorsByMode.get(settings.shaderColorMode)` and pass `vectorColorModeFromSettings(settings, vectorColorMode)` plus `vectorStyleFromSettings(settings, vectorStyle)` to `VectorFieldLayer`.
- `BoundsLayers.tsx`: same wireframe/vector helper usage for airbox.
- `FallbackTopologyMeshLayer.tsx`: same helper usage for fallback settings.
- `FdmCuboidLayer.tsx`: shader/wire material color and wire opacity use helpers.

For mesh shader vertex colors, use:

```tsx
const scalarColors = fieldModel?.scalarColorsByMode.get(settings.shaderColorMode) ?? null;
const vertexColors = shaderUsesVertexColors(settings) &&
  canApplyVertexScalarColorBuffer(scalarColors, topologyModel?.nodeCount ?? 0);
```

Then pass `scalarColors` to `applyVertexScalarColorBuffer`.

- [ ] **Step 5: Run focused layer tests**

Run:

```bash
TMPDIR=/dev/shm pnpm --dir apps/control-room test src/modules/viewport-3d/layers/VectorFieldLayer.test.ts src/modules/viewport-3d/layers/BoundsLayers.test.tsx src/modules/viewport-3d/layers/PrimitiveObjectLayer.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit viewport layer styles**

```bash
git add apps/control-room/src/modules/viewport-3d/layers apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.ts
git commit -m "Apply target display styles in viewport layers"
```

---

### Task 7: Gather Target Shader Modes in Viewport3DModule

**Files:**
- Modify: `apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/model/viewport3DTargets.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/model/viewport3DTargets.test.ts`

- [ ] **Step 1: Write failing target fallback test**

Add to `viewport3DTargets.test.ts`:

```ts
  it("maps global vector style into object display fallback style fields", () => {
    expect(
      resolveGlobalObjectVisualizationSettings({
        vector_style: {
          alpha: 0.4,
          color_mode: "x",
          length_scale: 1,
          mono_color: "#44ccff",
          thickness: 2,
        },
      } as never),
    ).toMatchObject({
      shaderColorMode: "x",
      vectorAlphaPercent: 40,
      vectorColorMode: "x",
      vectorMonoColor: "#44ccff",
      vectorThickness: 2,
    });
  });
```

- [ ] **Step 2: Run target tests and verify failure**

Run:

```bash
TMPDIR=/dev/shm pnpm --dir apps/control-room test src/modules/viewport-3d/model/viewport3DTargets.test.ts
```

Expected: FAIL because fallback style fields are not mapped from global state yet.

- [ ] **Step 3: Map global fallback style**

In `resolveGlobalObjectVisualizationSettings`, add:

```ts
    shaderColorMode: state?.vector_style?.color_mode ?? DEFAULT_OBJECT_VISUALIZATION.shaderColorMode,
    shaderMonoColor: state?.vector_style?.mono_color ?? DEFAULT_OBJECT_VISUALIZATION.shaderMonoColor,
    vectorAlphaPercent: Math.round((state?.vector_style?.alpha ?? 1) * 100),
    vectorColorMode: state?.vector_style?.color_mode ?? DEFAULT_OBJECT_VISUALIZATION.vectorColorMode,
    vectorMonoColor: state?.vector_style?.mono_color ?? DEFAULT_OBJECT_VISUALIZATION.vectorMonoColor,
    vectorThickness: state?.vector_style?.thickness ?? DEFAULT_OBJECT_VISUALIZATION.vectorThickness,
```

Keep airbox base settings using backend airbox layer fields plus default local style values from `DEFAULT_AIRBOX_VISUALIZATION`.

- [ ] **Step 4: Gather scalar color modes in `Viewport3DModule`**

Inside `useViewport3DFieldRenderOptions`, add a `scalarColorModes` set:

```ts
    const scalarColorModes = new Set<string>();
```

When a part or fallback has visible shader:

```ts
          scalarColorModes.add(settings.shaderColorMode);
```

For fallback:

```ts
      if (fallbackSettings.visible && fallbackSettings.shaderVisible) {
        scalarColorModes.add(fallbackSettings.shaderColorMode);
      }
```

Return it:

```ts
      scalarColorModes,
```

Add dependencies for the new fields used by the memo:

```ts
    airboxSettings.shaderColorMode,
    fallbackSettings.shaderColorMode,
```

- [ ] **Step 5: Run target and render-model tests**

Run:

```bash
TMPDIR=/dev/shm pnpm --dir apps/control-room test src/modules/viewport-3d/model/viewport3DTargets.test.ts src/modules/viewport-3d/viewport3dRenderModel.test.ts src/modules/viewport-3d/layers/Viewport3DScene.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit viewport target resolution**

```bash
git add apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx apps/control-room/src/modules/viewport-3d/model/viewport3DTargets.ts apps/control-room/src/modules/viewport-3d/model/viewport3DTargets.test.ts
git commit -m "Resolve target shader modes for viewport rendering"
```

---

### Task 8: Final Verification and Completion Audit

**Files:**
- Inspect all files modified by Tasks 1-7.

- [ ] **Step 1: Run focused feature tests**

Run:

```bash
TMPDIR=/dev/shm pnpm --dir apps/control-room test src/kernel/visualization/ObjectVisualizationController.test.ts src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts src/modules/ribbon/ribbonStructure.test.ts src/modules/viewport-3d/model/viewport3DTargets.test.ts src/modules/viewport-3d/viewport3dRenderModel.test.ts src/modules/viewport-3d/layers/VectorFieldLayer.test.ts src/modules/viewport-3d/layers/BoundsLayers.test.tsx src/modules/viewport-3d/layers/PrimitiveObjectLayer.test.tsx
```

Expected: PASS.

- [ ] **Step 2: Run module-wide tests**

Run:

```bash
TMPDIR=/dev/shm pnpm --dir apps/control-room test src/modules/inspector src/modules/ribbon src/modules/viewport-3d
```

Expected: PASS.

- [ ] **Step 3: Run required control-room gates**

Run:

```bash
TMPDIR=/dev/shm pnpm --dir apps/control-room typecheck
TMPDIR=/dev/shm pnpm --dir apps/control-room lint
TMPDIR=/dev/shm pnpm --dir apps/control-room test
```

Expected: all PASS.

- [ ] **Step 4: Run architecture hygiene searches**

Run:

```bash
rg "fetch\\(" apps/control-room/src/modules apps/control-room/src/kernel
rg "from ['\"]\\.\\./" apps/control-room/src/modules
rg "apps/web|ControlRoomContext|normalizeSession|mergeSession" apps/control-room/src
```

Expected:

- no new direct module `fetch(` calls;
- no new cross-module internal imports from this change;
- no `apps/web` imports.

- [ ] **Step 5: Audit acceptance criteria**

Check the prompt-to-artifact matrix:

| Requirement | Evidence |
|---|---|
| Explorer object visualization opens detailed target display | existing explorer selection plus inspector panel model and `inspectorRegistry.test.tsx` |
| Arch/object shader can choose HSL orientation or monochrome independently | `ObjectVisualizationController.test.ts`, `ObjectVisualizationPanelModel.test.ts`, `ribbonStructure.test.ts` |
| Airbox visualization exposes same local style sections where backend allows it | airbox local patch test and selected airbox ribbon test |
| Shader/wireframe/vector sections reveal pass-specific options | `ObjectVisualizationPanelModel.test.ts` |
| Ribbon and inspector use one target registry | ribbon selected-display tests patch `ObjectVisualizationController` |
| Viewport applies target styles | viewport layer helper tests and render-model tests |
| Global Display remains fallback | `viewport3DTargets.test.ts` |
| Gates pass | typecheck, lint, full Vitest output |

- [ ] **Step 6: Commit final cleanup if any**

If verification required small fixes, commit only files from the feature scope:

```bash
git add apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts apps/control-room/src/kernel/visualization/ObjectVisualizationController.test.ts
git add apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.ts apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts
git add apps/control-room/src/modules/ribbon/ribbonContributions.tsx apps/control-room/src/modules/ribbon/ribbonStructure.test.ts
git add apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx apps/control-room/src/modules/viewport-3d/model/viewport3DTargets.ts apps/control-room/src/modules/viewport-3d/model/viewport3DTargets.test.ts
git add apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.ts apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.test.ts
git add apps/control-room/src/modules/viewport-3d/layers/viewport3DLayerSettings.ts apps/control-room/src/modules/viewport-3d/layers/PrimitiveObjectLayer.tsx apps/control-room/src/modules/viewport-3d/layers/PrimitiveObjectLayer.test.tsx apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.tsx apps/control-room/src/modules/viewport-3d/layers/BoundsLayers.tsx apps/control-room/src/modules/viewport-3d/layers/BoundsLayers.test.tsx apps/control-room/src/modules/viewport-3d/layers/FallbackTopologyMeshLayer.tsx apps/control-room/src/modules/viewport-3d/layers/FdmCuboidLayer.tsx apps/control-room/src/modules/viewport-3d/layers/TopologyMeshLayer.tsx apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx apps/control-room/src/modules/viewport-3d/layers/VectorFieldLayer.test.ts
git commit -m "Stabilize per-object visualization display"
```

Do not commit unrelated dirty worktree files.
