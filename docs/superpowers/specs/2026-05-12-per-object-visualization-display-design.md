# Per-Object Visualization Display Design

Date: 2026-05-12
Status: Approved design, pending implementation plan

## Goal

Rozbudować szczegółowy widok `Visualization` dla targetów z explorera tak, żeby
wybrany obiekt, airbox albo mesh-part miały własny zestaw ustawień display,
zamiast polegać wyłącznie na globalnym `View -> Global Display`.

Pierwsza wersja implementuje wariant B: produkcyjny rdzeń per-target display.
Global Display pozostaje domyślnym fallbackiem, ale wybrany target może nadpisać
ustawienia shaderów, wireframe, wektorów i widoczności.

## Current State

Istniejące elementy:

- explorer tworzy selekcje `object.visualization`, `airbox.visualization` i mesh
  part selection;
- inspector rozwiązuje je do `ObjectVisualizationPanel`;
- `ObjectVisualizationController` przechowuje małe preferencje display:
  `visible`, `shaderVisible`, `wireframeVisible`, `pointsVisible`,
  `vectorsVisible`, `opacityPercent`, `geometryScope`, `renderMode`;
- `Viewport3DModule` rozwiązuje per-target settings dla primitive objects,
  mesh parts i airbox;
- `View -> Selected Display` istnieje, ale ma tylko częściowy zakres;
- `View -> Global Display` ma bogatsze opcje shader/vector coloring i stylu.

Brakujące elementy:

- per-target shader color mode, np. `orientation` vs `monochrome`;
- per-target mono color dla shaderów;
- per-target wireframe color i opacity;
- per-target vector color mode, mono color, alpha i thickness;
- spójny inspector i ribbon, które czytają i zapisują te same pola;
- renderer 3D, który stosuje style z targetu, a nie tylko globalny fallback.

## Scope

W pierwszym wdrożeniu target visualization settings dostają nowe pola:

- `shaderColorMode`: `orientation | x | y | z | magnitude | monochrome`;
- `shaderMonoColor`: CSS color string;
- `wireframeColor`: CSS color string;
- `wireframeOpacityPercent`: 0-100;
- `vectorColorMode`: `orientation | x | y | z | magnitude | monochrome`;
- `vectorMonoColor`: CSS color string;
- `vectorAlphaPercent`: 0-100;
- `vectorThickness`: numeric scale.

Istniejące pola pozostają częścią tego samego modelu:

- `visible`;
- `renderMode`;
- `shaderVisible`;
- `wireframeVisible`;
- `pointsVisible`;
- `vectorsVisible`;
- `boundsVisible`;
- `geometryScope`;
- `opacityPercent`;

## Non-Goals

Nie wdrażamy w pierwszym kroku per-target density, glyph budget, LOD ani
sampling policy. Te pola wpływają na pobieranie danych, budżetowanie glyphów i
kontrakt backendowy. W tej iteracji target style mogą ograniczać widoczność i
wygląd, ale nie redefiniują resource fetch/sampling.

Nie przenosimy topologii, field arrays, manifestów mesh ani session snapshots do
`ObjectVisualizationController`.

## UX Contract

Explorer:

- wybór `Visualization` pod obiektem otwiera panel targetu;
- wybór `Airbox Visualization` otwiera ten sam panel dla targetu `airbox`;
- wybór mesh part fallback może używać targetu `part:<part_id>`.

Inspector:

- pokazuje target name, id i kind;
- sekcja `Display Passes` nadal kontroluje master visibility oraz pass toggles;
- sekcja `Surface Shader` pojawia się, gdy shader pass jest dostępny;
- sekcja `Wireframe` pojawia się, gdy wireframe pass jest dostępny;
- sekcja `Vectors` pojawia się, gdy vector pass jest dostępny;
- sekcja `Geometry Scope` zostaje przy targetach, które mogą przełączać
  `surface/full`;
- `Reset display` usuwa tylko override wybranego targetu.

Ribbon:

- `View -> Selected Display` czyta aktywny target z kernel selection;
- pokazuje te same wartości co inspector;
- zmiany idą do tego samego `ObjectVisualizationController` albo do airbox patch
  adaptera, jeżeli pole jest backend-backed;
- globalne display menu nie nadpisuje istniejącego per-target override.

Viewport:

- primitive object layers, FEM mesh part layers i airbox layers dostają efektywne
  ustawienia targetu;
- shader surface używa `shaderColorMode` i `shaderMonoColor`;
- vector glyphs używają `vectorColorMode`, `vectorMonoColor`,
  `vectorAlphaPercent` i `vectorThickness`;
- wireframe używa `wireframeColor` i `wireframeOpacityPercent`;
- zmiana stylu targetu nie przebudowuje topologii dla innych targetów.

## State Ownership

`ObjectVisualizationController` pozostaje właścicielem tymczasowego client-owned
display registry dla obiektów i part fallbacków. Przechowuje wyłącznie małe
preferencje UI/render style.

Airbox dalej używa backend-backed `visualization/state.layers.airbox` dla pól,
które już istnieją w v2 API: `visible`, surface/wireframe/points/vectors
visibility i opacity. Nowe lokalne style, których API jeszcze nie ma, pozostają
w kernelowym target override.

Global display jest fallbackiem:

1. domyślne wartości w `DEFAULT_OBJECT_VISUALIZATION` i
   `DEFAULT_AIRBOX_VISUALIZATION`;
2. wartości z backend visualization state, jeśli istnieją;
3. per-kind defaults z controller;
4. per-target override z controller.

## Architecture

Affected files:

- `apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts`;
- `apps/control-room/src/kernel/visualization/ObjectVisualizationController.test.ts`;
- `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx`;
- `apps/control-room/src/modules/ribbon/ribbonContributions.tsx`;
- `apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx`;
- `apps/control-room/src/modules/viewport-3d/model/viewport3DTargets.ts`;
- `apps/control-room/src/modules/viewport-3d/layers/PrimitiveObjectLayer.tsx`;
- `apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.tsx`;
- `apps/control-room/src/modules/viewport-3d/layers/BoundsLayers.tsx`;
- `apps/control-room/src/modules/viewport-3d/layers/VectorFieldLayer.tsx`;
- relevant tests in `apps/control-room/src/modules/*`.

No module may import another module's store or component. Shared target display
types stay in `kernel/visualization`. Viewport-specific conversions stay inside
`viewport-3d`.

## Error Handling

Object and part target style changes are local, synchronous display preference
updates. Invalid numeric values are clamped in the controller.

Airbox backend-backed patches keep the existing async error handling:

- inspector shows a `FeedbackBanner` on API failure;
- ribbon callbacks remain non-throwing and rely on resource refresh errors for
  visibility;
- local-only airbox fields patch the controller even when the API is unavailable.

## Testing Plan

Required tests:

- controller normalizes and merges new style fields;
- controller clamps opacity/alpha/thickness inputs;
- inspector renders shader, wireframe and vector style controls for selected
  object and airbox targets;
- ribbon `Selected Display` exposes matching style controls and patches the same
  target;
- viewport target resolution passes per-target shader/vector/wireframe style to
  primitive, mesh part and airbox layers;
- existing airbox backend-backed patch tests keep passing;
- no direct `fetch()` is introduced in module UI.

Verification commands:

```bash
TMPDIR=/dev/shm pnpm --dir apps/control-room test src/kernel/visualization/ObjectVisualizationController.test.ts
TMPDIR=/dev/shm pnpm --dir apps/control-room test src/modules/inspector src/modules/ribbon src/modules/viewport-3d
TMPDIR=/dev/shm pnpm --dir apps/control-room typecheck
TMPDIR=/dev/shm pnpm --dir apps/control-room lint
TMPDIR=/dev/shm pnpm --dir apps/control-room test
```

## Acceptance Criteria

- Selecting an object's `Visualization` node exposes per-object shader coloring.
- For an `arch` object, the user can choose `orientation` or `monochrome`
  shader coloring independently of global display.
- Airbox visualization exposes the same local style sections where the backend
  contract allows it.
- Shader, wireframe and vector sections reveal controls relevant to the selected
  pass.
- Ribbon `Selected Display` and inspector stay synchronized through one target
  registry.
- Viewport 3D applies target styles without changing unrelated targets.
- Global Display remains a fallback and does not erase explicit per-target
  overrides.
- Typecheck, lint and relevant tests pass.
