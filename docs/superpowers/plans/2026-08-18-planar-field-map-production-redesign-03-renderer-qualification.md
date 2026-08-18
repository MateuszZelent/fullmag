# Plan wdrożenia renderera, naukowego UX i kwalifikacji 2D

> **Dla agentów wykonawczych:** WYMAGANY SUB-SKILL: użyj `subagent-driven-development` albo `executing-plans`. Bramki backend/API i frontend state/data plane muszą być zielone przed finalną kwalifikacją browserową.

**Cel:** Pokazać jeden revision-safe planar field jako profesjonalny wykres naukowy z osiami świata, poziomą legendą i target-aware wireframe, a następnie udowodnić poprawność danych, accessibility, lifecycle i powrót do zdrowego viewportu 3D.

**Architektura:** `FieldMapModule` pozostaje orkiestratorem jednego planar source, jednego data planu i jednego render modelu. `PlanarSurface` utrzymuje jeden base canvas i jeden overlay canvas; modele osi/legendy są czyste, a DOM/SVG rezerwuje miejsce na scientific chrome. Effective wireframe style pochodzi z canonical registry plus sparse override aktywnego sampled targetu, bez wielotargetowej kompozycji rasterów.

**Tech Stack:** React 19, Canvas 2D, SVG/DOM chrome, Web Worker, ResizeObserver, Vitest, Playwright/browser smoke i Catppuccin tokens.

## Global Constraints

- Nie implementuj tablic target render models, osobnej listy z-order, wielu scalar rasters ani per-target resource controller.
- Field map wyświetla jeden aktywny planar sample; przełączenie view scope/source może pobrać inny sample, ale zmiana samego stylu nie może.
- Target wireframe override dotyczy tylko exact active render target; brak/unsupported/dormant identity używa globalnego fallbacku.
- Standardowe osie pokazują `x/y/z`, nie `u/v`; lokalne `u/v` może pozostać wewnętrzną matematyką i w danych diagnostycznych.
- Oblique pokazuje `x′/y′` oraz kierunki świata.
- Tick values pozostają w metrach; label i unit transform są display-only.
- Plot zachowuje physical aspect ratio z `bounds_uv_m`.
- Legenda leży pod plotem i nie nakłada się na dane.
- Uniform zero nie używa gradientu sugerującego nieistniejącą rozpiętość.
- Stale data jest jawnie oznaczone; error nie pokazuje starych liczb jako aktualnych.
- Jeden mount: 2 canvasy, maksymalnie 1 worker, 1 ResizeObserver, zero idle RAF po settle.
- Style update odrysowuje overlay bez ponownej colorization rastera.
- Wszystkie klasy mają prefix `fm-`; wartości wizualne pochodzą z `--fm-*`.
- Nie obniżaj jakości, resolution lub vector budget jako poprawki wydajności.
- UI task jest zakończony dopiero po commicie. Niezacommitowane lokalne zmiany nie uzasadniają `[x]`.

---

### Zadanie 1: Czysty model osi kartezjańskich — zakończony

**Pliki:**
- Created: `apps/control-room/src/modules/field-map/model/planarAxisModel.ts`
- Created: `apps/control-room/src/modules/field-map/model/planarAxisModel.test.ts`

**Produces:** `resolvePlanarAxes` i powiązane modele axis/cut/ticks.

- [x] `xy` rozwiązuje horizontal `x`, vertical `y`, cut `z`.
- [x] `xz` rozwiązuje horizontal `x`, vertical `z`, cut `y`.
- [x] `yz` rozwiązuje horizontal `y`, vertical `z`, cut `x`.
- [x] Oblique używa `x′/y′` i przechowuje direction vectors.
- [x] Model wybiera wspólną display length unit oraz nice ticks bez zmiany wartości SI.
- [x] Testy pokrywają ujemne/asymetryczne bounds, skalę jednostek i cut coordinate.
- [x] Commit: `2a82ae803 feat: model Cartesian planar axes`.

### Zadanie 2: Naukowa rama wykresu i osie kartezjańskie

**Status:** oczekuje. Pure axis model from commit `2a82ae803` is complete; DOM/SVG integration is not.

**Pliki:**

- Create: `apps/control-room/src/modules/field-map/renderer/PlanarAxes.tsx`
- Create: `apps/control-room/src/modules/field-map/renderer/PlanarAxes.test.tsx`
- Modify: `apps/control-room/src/modules/field-map/FieldMapModule.tsx`
- Modify: `apps/control-room/src/modules/field-map/FieldMapModule.test.tsx`
- Modify: `apps/control-room/src/modules/field-map/renderer/PlanarSurface.tsx`
- Modify: `apps/control-room/src/design/styles/field-map.css`

Każde wywołanie w kodzie produkcyjnym, testach i przykładach ma dokładnie postać:

~~~typescript
resolvePlanarAxes(frame, bounds, viewport, plotWidthPx, plotHeightPx)
~~~

#### Krok 2.1 — RED płaszczyzn kanonicznych

~~~typescript
it.each([
  ["xy", "x", "y", "z"],
  ["xz", "x", "z", "y"],
  ["yz", "y", "z", "x"],
])("renders %s with world axes %s/%s", (plane, xLabel, yLabel, normal) => {
  const axes = resolvePlanarAxes(
    frameFixture(plane),
    boundsFixture(plane),
    viewportFixture(),
    640,
    480,
  );
  render(<PlanarAxes axes={axes} plotRect={plotRect(640, 480)} />);
  expect(screen.getByTestId("planar-axis-x")).toHaveTextContent(xLabel);
  expect(screen.getByTestId("planar-axis-y")).toHaveTextContent(yLabel);
  expect(screen.getByTestId("planar-cut-coordinate")).toHaveTextContent(normal);
  expect(screen.queryByText(/^u\s*\(/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/^v\s*\(/i)).not.toBeInTheDocument();
});
~~~

Oczekiwany RED: component absent or rendered labels still expose `u/v`.

#### Krok 2.2 — oblique RED

~~~typescript
it("describes the oblique basis", () => {
  const axes = resolvePlanarAxes(
    obliqueFrameFixture(),
    obliqueBoundsFixture(),
    viewportFixture(),
    640,
    480,
  );
  render(<PlanarAxes axes={axes} plotRect={plotRect(640, 480)} />);
  expect(screen.getByTestId("planar-axis-x")).toHaveTextContent("x′");
  expect(screen.getByTestId("planar-axis-y")).toHaveTextContent("y′");
  expect(screen.getByTestId("planar-plane-description"))
    .toHaveAccessibleDescription(/basis.*world.*normal/i);
});
~~~

Accessible description contains both in-plane direction vectors and normal in world Cartesian components. Oczekiwany RED: missing primed axes or lost basis vectors.

#### Krok 2.3 — plot rectangle model

Create next to renderer layout:

~~~typescript
export interface PlanarPlotRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function resolvePlanarPlotRect(input: {
  availableWidthPx: number;
  availableHeightPx: number;
  horizontalExtentM: number;
  verticalExtentM: number;
}): PlanarPlotRect;
~~~

Algorithm: validate positive finite dimensions/extents; calculate physical aspect; fit the largest centered rectangle; round consistently; derive drawing buffer from the same rectangle and DPR; never stretch axes independently.

~~~typescript
it.each([
  [320, 480, 2, 1],
  [640, 480, 1, 1],
  [1200, 800, 1, 4],
])("preserves physical aspect", (width, height, horizontal, vertical) => {
  const rect = resolvePlanarPlotRect({
    availableWidthPx: width,
    availableHeightPx: height,
    horizontalExtentM: horizontal,
    verticalExtentM: vertical,
  });
  expect(relativeError(rect.width / rect.height, horizontal / vertical))
    .toBeLessThan(0.005);
});
~~~

Oczekiwany RED: old fixed rectangle exceeds 0.5% error.

#### Krok 2.4 — component/layout GREEN skeleton

`PlanarAxes` renders title, vertical axis, SVG ticks/grid and horizontal axis as DOM/SVG chrome outside canvases. It receives the resolved model and plot rectangle; it does no numerical recomputation. `FieldMapModule.tsx` calls:

~~~typescript
const axes = resolvePlanarAxes(
  frame,
  bounds,
  viewport,
  plotRect.width,
  plotRect.height,
);
~~~

One host-owned `ResizeObserver` measures layout. `PlanarAxes` creates none. Remove legacy absolute `fm-field-map__axis--u` and `fm-field-map__axis--v` only after GREEN. All CSS classes use `fm-`, all colors use `--fm-*`.

#### Krok 2.5 — dokładna bramka

~~~bash
pnpm --dir apps/control-room exec vitest run \
  src/modules/field-map/renderer/PlanarAxes.test.tsx \
  src/modules/field-map/FieldMapModule.test.tsx
pnpm --dir apps/control-room typecheck
rg -n 'resolvePlanarAxes\(' apps/control-room/src/modules/field-map
~~~

Oczekiwany GREEN: tests PASS; every positive `rg` match has five arguments; canonical/oblique labels correct; aspect error below 0.5%. Proponowany commit after execution review: `feat: frame planar field map with Cartesian axes`.

### Zadanie 3: Pozioma legenda jako instrument naukowy

**Status:** oczekuje.

**Pliki:**

- Create: `apps/control-room/src/modules/field-map/model/planarLegendModel.ts`
- Create: `apps/control-room/src/modules/field-map/model/planarLegendModel.test.ts`
- Create: `apps/control-room/src/modules/field-map/components/PlanarColorLegend.tsx`
- Create: `apps/control-room/src/modules/field-map/components/PlanarColorLegend.test.tsx`
- Modify: `apps/control-room/src/modules/field-map/FieldMapModule.tsx`
- Modify: `apps/control-room/src/design/styles/field-map.css`

#### Krok 3.1 — zamknięty model stanów

~~~typescript
export type PlanarLegendModel =
  | { kind: "range"; title: string; unit: string; ticks: readonly LegendTick[]; gradient: string; rangeMode: "auto" | "manual" | "symmetric"; staleRevision: string | null }
  | { kind: "uniform"; title: string; unit: string; valueLabel: string; swatch: string; staleRevision: string | null }
  | { kind: "error"; title: string; message: string };
~~~

No null model reaches component. Uniform zero is a valid ready model.

#### Krok 3.2 — RED matrix

~~~typescript
it.each([
  ["auto", -2, 7],
  ["manual", 1.25, 9.75],
  ["symmetric", -8, 8],
])("builds bounded ticks for %s", (rangeMode, min, max) => {
  const model = buildPlanarLegendModel(legendInput({ rangeMode, min, max, widthPx: 640 }));
  expect(model.kind).toBe("range");
  if (model.kind !== "range") throw new Error("expected range");
  expect(model.ticks.length).toBeGreaterThanOrEqual(5);
  expect(model.ticks.length).toBeLessThanOrEqual(7);
});

it("represents legal zero as uniform data", () => {
  expect(buildPlanarLegendModel(legendInput({ min: 0, max: 0 })))
    .toMatchObject({ kind: "uniform", valueLabel: "0" });
});
~~~

Also assert: symmetric zero at center; narrow width reduces tick count without range change; display-unit transform changes labels only; non-finite/reversed range is typed error; stale retains last-good only with revision; error never shows stale values as current.

Oczekiwany RED: old vertical overlay or zero treated as unavailable.

#### Krok 3.3 — component GREEN skeleton

`PlanarColorLegend` renders a bottom-slot `figure` with title, textual unit, horizontal ramp and ticks. Uniform renders one swatch plus `Uniform <value> <unit>`. Error renders `role=status`. Stale renders an explicit revision badge. Its accessible label includes quantity, component, range/value and unit. Color is never the only information carrier.

Remove fixed vertical width/translate rules only after component tests pass. At 200% zoom title may wrap; ramp, x-axis and endpoint labels may not overlap.

#### Krok 3.4 — dokładna bramka

~~~bash
pnpm --dir apps/control-room exec vitest run \
  src/modules/field-map/model/planarLegendModel.test.ts \
  src/modules/field-map/components/PlanarColorLegend.test.tsx \
  src/modules/field-map/FieldMapModule.test.tsx
pnpm --dir apps/control-room typecheck
~~~

Oczekiwany GREEN: all tests PASS, zero renders `Uniform 0`, legend horizontal/outside plot, Mocha/Latte consume tokens. Proponowany commit: `feat: add horizontal planar scientific legend`.
### Zadanie 4: Kursor kartezjański i sonda revision-safe

**Status:** oczekuje.

**Pliki:** `model/fieldMapProbe.ts`, `model/fieldMapProbe.test.ts`, new `components/PlanarCursorReadout.tsx` and test, `renderer/PlanarSurface.tsx`, `FieldMapModule.tsx`.

#### Krok 4.1 — world-coordinate RED

~~~typescript
it.each([
  ["xy", [0.25, 0.75], [expectedX, expectedY, fixedZ]],
  ["xz", [0.25, 0.75], [expectedX, fixedY, expectedZ]],
  ["yz", [0.25, 0.75], [fixedX, expectedY, expectedZ]],
])("maps %s plot coordinates to xyz", (plane, local, expected) => {
  expect(resolvePlanarWorldCoordinate(frameFixture(plane), local)).toEqual(expected);
});
~~~

Oblique RED evaluates `world = origin + u*horizontal_direction + v*vertical_direction` for a manufactured basis and compares all three Cartesian components. Oczekiwany RED: old readout exposes local coordinates or swaps normal axis.

#### Krok 4.2 — local hover versus network pin

- [ ] pointer hover transforms locally, max one update per animation frame, zero HTTP requests;
- [ ] readout shows x/y/z, quantity/component value, display unit and `interactive sample`;
- [ ] local basis coordinates appear only in diagnostics;
- [ ] keyboard focus plus arrows move a bounded cursor;
- [ ] screen-reader announcement is throttled;
- [ ] pin uses current meta probe link through resource facade, never a component-built URL.

#### Krok 4.3 — stale/conflict RED

~~~typescript
it("rejects a probe from a different sample", () => {
  expect(reconcilePinnedProbe({
    requestedSampleToken: "sample-a",
    currentSampleToken: "sample-b",
    requestedFieldRevision: "8",
    currentFieldRevision: "9",
    response: probeFixture(),
  })).toMatchObject({ kind: "conflict" });
});
~~~

Also compare carrier/source revision and generation where published. Mismatched values are never shown as current.

#### Krok 4.4 — gate

~~~bash
pnpm --dir apps/control-room exec vitest run \
  src/modules/field-map/model/fieldMapProbe.test.ts \
  src/modules/field-map/components/PlanarCursorReadout.test.tsx \
  src/modules/field-map/renderer/PlanarSurface.test.tsx
pnpm --dir apps/control-room typecheck
~~~

Oczekiwany GREEN: canonical/oblique coordinate tests PASS, hover request count zero, stale response becomes conflict. Proponowany commit: `feat: report Cartesian planar probe coordinates`.

### Zadanie 5: Jeden render model, izolowane overlaye i stabilny lifecycle

**Status:** oczekuje.

**Pliki:** `model/fieldMapRenderModel.ts` and test, `renderer/PlanarSurface.tsx` and test, `renderer/planarRenderer.ts` and test, `renderer/planarFrameScheduler.ts` and test.

#### Krok 5.1 — render-boundary RED

~~~typescript
it("keeps wireframe style out of base raster identity", () => {
  const before = buildFieldMapRenderModel(renderInput({ wireframe: redStyle }));
  const after = buildFieldMapRenderModel(renderInput({ wireframe: blueStyle }));
  expect(after.baseRasterIdentity).toBe(before.baseRasterIdentity);
  expect(after.scalarBuffer).toBe(before.scalarBuffer);
  expect(after.overlayIdentity).not.toBe(before.overlayIdentity);
});
~~~

Assert one scalar/mask/vector/mesh family and one resolved wireframe style. No target array, z-order or per-target data source. Airbox style affects mesh/bounds overlay only; object does not inherit Airbox; absent/dormant target was already resolved to global fallback.

Oczekiwany RED: shared effect dependencies recolorize/decode base.

#### Krok 5.2 — dependency split

Base dependencies: scalar identity, mask identity, colormap/range, raster opacity, drawing-buffer dimensions. Overlay dependencies: mesh identity, layer flags, vectors/points/contours, resolved wireframe style, plot transform, dimensions. Do not key either by whole visualization revision.

#### Krok 5.3 — counter RED

~~~typescript
it("redraws only overlay for 20 style edits", () => {
  const counters = instrumentRenderer();
  const surface = mountPlanarSurface(initialModel);
  counters.reset();
  for (let index = 0; index < 20; index += 1) {
    surface.update(withWireframeStyle(initialModel, styleAt(index)));
  }
  flushAllScheduledFrames();
  expect(counters.scalarDecode).toBe(0);
  expect(counters.workerColorize).toBe(0);
  expect(counters.baseDraw).toBe(0);
  expect(counters.overlayDraw).toBeGreaterThan(0);
  expect(counters.overlayDraw).toBeLessThanOrEqual(20);
});
~~~

#### Krok 5.4 — lifecycle RED

~~~typescript
it("owns one lifecycle per mount", () => {
  const counters = instrumentPlanarLifecycle();
  const surface = mountPlanarSurface(initialModel);
  for (let index = 0; index < 100; index += 1) surface.update(modelAt(index));
  expect(counters.rendererCreate).toBe(1);
  expect(counters.workerCreate).toBeLessThanOrEqual(1);
  expect(counters.resizeObserverCreate).toBe(1);
  surface.unmount();
  expect(counters.workerTerminate).toBe(counters.workerCreate);
  expect(counters.resizeObserverDisconnect).toBe(1);
  expect(counters.pendingRaf).toBe(0);
});
~~~

Cleanup order: cancel RAF, disconnect observer, terminate worker, remove listeners, revoke owned URLs, release buffers, zero both canvas drawing dimensions. Scheduler coalesces invalidations; idle after settle has zero frame delta.

#### Krok 5.5 — gate

~~~bash
pnpm --dir apps/control-room exec vitest run \
  src/modules/field-map/model/fieldMapRenderModel.test.ts \
  src/modules/field-map/renderer/PlanarSurface.test.tsx \
  src/modules/field-map/renderer/planarRenderer.test.ts \
  src/modules/field-map/renderer/planarFrameScheduler.test.ts
pnpm --dir apps/control-room typecheck
~~~

Oczekiwany GREEN: counters bounded, idle zero. Never lower resolution/vector budget or hide layers. Proponowany commit: `perf: stabilize single planar renderer lifecycle`.

### Zadanie 6: Integracja pojedynczego naukowego FieldMapModule

**Status:** oczekuje.

**Pliki:** `FieldMapModule.tsx` and test, `model/fieldMapEvidence.ts` and test.

#### Krok 6.1 — orchestration boundary

Module owns one visualization resource, one data plan, one hook family, one render model, one plot rectangle, axes/cursor/legend/status. It owns no per-target controller, raster array or duplicate subscription.

Integration order:

1. preserve existing data/resource path;
2. mount new axes next to canvas;
3. call `resolvePlanarAxes(frame, bounds, viewport, plotRect.width, plotRect.height)`;
4. mount bottom legend;
5. mount cursor readout;
6. pass resolved target wireframe style from plan 02;
7. remove legacy labels/legend only after focused GREEN;
8. run request counters after each step.

#### Krok 6.2 — RED stanów danych

~~~typescript
it.each([
  ["ready-nonzero", "range"],
  ["ready-uniform-zero", "uniform"],
  ["stale-compatible", "range"],
  ["missing-meta", "error"],
  ["sample-conflict", "error"],
])("renders %s as %s", (fixture, legendKind) => {
  render(<FieldMapModule {...fieldMapFixture(fixture)} />);
  expect(screen.getByTestId("planar-legend"))
    .toHaveAttribute("data-kind", legendKind);
});
~~~

Uniform zero is ready. Stale last-good requires matching topology/generation/sample. Missing meta/conflict never creates a zero array. Error never shows old values as current.

#### Krok 6.3 — kontrakt dowodowy

Evidence records source kind/id, scope kind/id, field/carrier/source revisions, generation, sample-token digest, scalar sample/finite/nonzero counts, min/max, overlay counts and effective wireframe key/source. Label is never an identity key.

Style-only RED asserts effective wireframe evidence changes while sample-token digest, revisions, request counters, scalar buffer and base canvas identity stay equal.

#### Krok 6.4 — gate

~~~bash
pnpm --dir apps/control-room exec vitest run \
  src/modules/field-map/FieldMapModule.test.tsx \
  src/modules/field-map/model/fieldMapEvidence.test.ts
pnpm --dir apps/control-room typecheck
~~~

Oczekiwany GREEN: state matrix PASS, zero is uniform, no legacy axis/legend nodes. Proponowany commit: `refactor: orchestrate one scientific planar field map`.
### Zadanie 7: Browser smoke danych live, osi i legendy

**Status:** oczekuje; requires green Bramka A/B.

**Pliki:** `scripts/smoke-viewport-2d.mjs`, its test, `scripts/lib/planar-field-evidence.mjs`, reuse `scripts/lib/decode-fmvp.mjs`, create `.superpowers/sdd/planar-redesign-browser-data-evidence.md`.

**Zarządzany launcher:**

~~~bash
just run-viewport-2d-planar-monitor-smoke fdm cpu 3194 8194 base
~~~

This existing recipe owns `examples/viewport_2d_planar_monitor_fdm_smoke.py`, API and Control Room launch. No host-native solver is qualification proof.

#### Krok 7.1 — API preflight RED

Before browser assertions the smoke script:

1. GETs `/v2/sessions/current/data/fields/m/meta`;
2. GETs monitor meta using fixture-published monitor ID;
3. follows `meta.links.scalar` exactly;
4. decodes scalar with `decodeFmvp`;
5. calculates sample/finite/nonzero counts, min/max and SHA-256;
6. records revisions, generation, sample token and ETag;
7. fails unless nonzero fixture has `nonzero_count > 0`;
8. fails unless decoded min/max match meta within codec-derived tolerance.

Oczekiwany RED: current smoke has no independent scalar decoder/comparison. Minimal GREEN reuses the Node decoder from plan 01; DOM never acts as its own oracle.

#### Krok 7.2 — plane matrix

For `xy`, `xz`, `yz`: set plane through external qualification helper or typed facade, wait for matching sample token, assert world-axis labels and normal title, reject visible `u (`/`v (`, compare legend to decoded values, save evidence plus screenshot.

Any test/model call is exactly:

~~~typescript
resolvePlanarAxes(frame, bounds, viewport, widthPx, heightPx)
~~~

#### Krok 7.3 — theme/viewport matrix

Capture Mocha and Latte at 320×480, 640×480, 1200×800. Measure title/y-axis/plot/x-axis/legend boxes. Assert no overlap/overflow, positive legend ramp, unclipped tick labels and physical aspect error below 0.5%.

#### Krok 7.4 — legend fixtures

- live nonzero → range matching decoded endpoints;
- legal zero integration fixture → `Uniform 0`, unit, one swatch;
- symmetric → center zero tick;
- manual → exact converted endpoints;
- stale-compatible → revision badge;
- error → message without current numeric range.

#### Krok 7.5 — command/result

~~~bash
node --test apps/control-room/scripts/smoke-viewport-2d.test.mjs
CONTROL_ROOM_API_BASE_URL=http://127.0.0.1:8194 \
CONTROL_ROOM_URL=http://127.0.0.1:3194/workspace \
CONTROL_ROOM_PLANAR_BACKEND=fdm \
CONTROL_ROOM_PLANAR_OUTPUT_DIR=.superpowers/sdd/planar-browser-data \
  pnpm --dir apps/control-room smoke:viewport-2d
~~~

Oczekiwany GREEN: exit 0, all box/data assertions PASS, evidence has hashes/provenance. Proponowany commit: `test: qualify planar data axes and legend`.

### Zadanie 8: Browser smoke izolacji Airbox/Object/Part

**Status:** oczekuje.

**Pliki:** `scripts/smoke-viewport-2d.mjs`, `scripts/lib/planar-field-evidence.mjs`, create `.superpowers/sdd/planar-redesign-target-isolation-evidence.md`.

#### Krok 8.1 — dokładna fixture

Registry exposes Airbox `airbox`, object `film`, part `film`; object/part labels deliberately match. Use complete live generated response, not a partial registry PATCH. Replacement overrides are Airbox red/0.35, object green/0.90, part blue/0.60.

#### Krok 8.2 — evidence sequence

Retain complete ordered overrides/global fallback, visualization revision/ETag if published, sample token, child ETags, request counters and effective renderer evidence. Execute:

1. Airbox view;
2. object `film` view;
3. part `film` view;
4. return to Airbox;
5. change only Airbox opacity;
6. remove object through fixture-supported action;
7. restore exact object identity;
8. create same-label `film-2`.

#### Krok 8.3 — RED assertions

- [ ] Airbox returns to identical style;
- [ ] object/part do not collide;
- [ ] Airbox edit preserves other/dormant JSON byte-for-byte;
- [ ] global fallback unchanged;
- [ ] style-only data request delta zero;
- [ ] sample token/child ETags unchanged;
- [ ] visualization state changes;
- [ ] missing object override inactive and global renders;
- [ ] exact return reactivates without PATCH;
- [ ] same-label/different-ID does not;
- [ ] Inspector root/focus/scroll/draft stable;
- [ ] zero opacity animations.

Oczekiwany RED: current cross-target leak or broad pending behavior.

#### Krok 8.4 — command/result

~~~bash
CONTROL_ROOM_API_BASE_URL=http://127.0.0.1:8194 \
CONTROL_ROOM_URL=http://127.0.0.1:3194/workspace \
CONTROL_ROOM_PLANAR_BACKEND=fdm \
CONTROL_ROOM_PLANAR_OUTPUT_DIR=.superpowers/sdd/planar-target-isolation \
  pnpm --dir apps/control-room smoke:viewport-2d
~~~

Oczekiwany GREEN: exit 0; ordered JSON/counters satisfy matrix; three distinct screenshots/evidence styles. Proponowany commit: `test: prove exact planar target style isolation`.

### Zadanie 9: Dostępność, responsywność i przegląd wizualny

**Status:** oczekuje.

**Pliki:** `src/design/styles/field-map.css`, component tests from Tasks 2–4, create `.superpowers/sdd/planar-redesign-accessibility-evidence.md`.

#### Krok 9.1 — semantic RED

Plot host is focusable with quantity/component/plane name and keyboard instructions. Axes/legend remain understandable with canvas hidden. Form labels are unique. Cursor live region is polite/throttled. Error/stale/uniform are textual.

#### Krok 9.2 — contrast/focus RED

For both themes record computed colors and ratios: normal text ≥4.5:1, large text ≥3:1, focus ≥3:1. Focus ring uses `--fm-*` and is not clipped. Read-only remains legible.

#### Krok 9.3 — responsive RED

At zoom 200%, Windows scaling 125/150%, 320 px module: no page horizontal overflow; title may wrap without covering plot; legend remains below x-axis; tick model prevents overlap; keyboard reachability remains.

#### Krok 9.4 — motion/color review

Reduced-motion preserves meaning; persistent controls have no opacity animation; colormap is reviewed under deuteranopia/protanopia simulation without drive-by default change; screenshots include both themes and focus.

#### Krok 9.5 — command/result

~~~bash
pnpm --dir apps/control-room exec vitest run \
  src/modules/field-map/renderer/PlanarAxes.test.tsx \
  src/modules/field-map/components/PlanarColorLegend.test.tsx \
  src/modules/field-map/components/PlanarCursorReadout.test.tsx
pnpm --dir apps/control-room lint
~~~

Oczekiwany GREEN: tests/lint exit 0; evidence contains ratios and screenshot paths. Proponowany commit: `test: qualify planar accessibility and responsive layout`.
### Zadanie 10: Wydajność, cleanup i odtworzenie 3D

**Status:** oczekuje.

**Pliki:** `scripts/smoke-viewport-2d.mjs`, `renderer/PlanarSurface.test.tsx`, create `.superpowers/sdd/planar-redesign-lifecycle-evidence.json`.

#### Krok 10.1 — instrumentation

Evidence includes canvas/worker/observer/listener/pending-RAF/object-URL counts, scalar decode, worker colorize, base/overlay draw, planar HTTP request count, JS heap, WebGL lost state and drawing-buffer dimensions. Instrumentation is test-only, not visible production UI.

#### Krok 10.2 — RED cycle matrix

- 100 Airbox → Object → Part → Airbox cycles;
- 100 viewport-3d → field-map → analysis-plots → field-map cycles;
- 100 style-only updates after warm-up;
- five seconds idle;
- final return to 3D.

Assertions: active map exactly two canvases, ≤1 worker/observer; after unmount zero owned resources/pending RAF; idle frame delta zero; style-only decode/colorization/request delta zero; heap growth ≤96 MiB after warm-up/GC; 3D visible, `gl.isContextLost()===false`, positive drawing buffer.

Oczekiwany RED: leak/counter violation or context loss. Minimal GREEN fixes the owner; it may not raise memory threshold, lower resolution/vector budget, hide layers, suppress context-loss logs or add a renderer.

#### Krok 10.3 — command/result

~~~bash
CONTROL_ROOM_API_BASE_URL=http://127.0.0.1:8194 \
CONTROL_ROOM_URL=http://127.0.0.1:3194/workspace \
CONTROL_ROOM_PLANAR_BACKEND=fdm \
CONTROL_ROOM_PLANAR_OUTPUT_DIR=.superpowers/sdd/planar-lifecycle \
CONTROL_ROOM_PLANAR_LIFECYCLE_CYCLES=100 \
  pnpm --dir apps/control-room smoke:viewport-2d
~~~

Oczekiwany GREEN: exit 0 and lifecycle JSON contains all counters/thresholds. Proponowany commit: `test: qualify planar lifecycle and 3d recovery`.

### Zadanie 11: Rzeczywisty rollback UI bez utraty stanu

**Status:** oczekuje.

**Pliki:** create `field-map/fieldMapExperience.ts` and test; modify `field-map/manifest.ts` and test; create `field-map/LegacyFieldMapModule.tsx`; modify `FieldMapModule.test.tsx`; create rollback evidence.

**Owner:** `field-map/manifest.ts` selects build-time `NEXT_PUBLIC_FULLMAG_FIELD_MAP_EXPERIENCE=scientific|legacy`; `modules/registry.ts` keeps one manifest ID.

#### Krok 11.1 — RED loader

Undefined/scientific/invalid selects scientific; legacy selects compatibility module; both satisfy same slot contract; mounting either emits zero visualization PATCH. Oczekiwany RED: flag/resolver/module absent. Minimal GREEN is pure resolver plus manifest lazy choice.

#### Krok 11.2 — sekwencja RED persisted state

1. Save global fallback, Airbox, object and dormant part overrides.
2. Run scientific and capture full visualization JSON digest.
3. Run legacy.
4. Assert zero PATCH during switch/mount.
5. Persist/restart while legacy active.
6. Compare complete ordered JSON digest.
7. Run scientific.
8. Assert Airbox/object styles return.
9. Assert part stays dormant until exact ID returns.
10. Restore exact part and assert reactivation without PATCH.

Oczekiwany RED: no executable rollback or state mutation on mount.

#### Krok 11.3 — commands

~~~bash
pnpm --dir apps/control-room exec vitest run \
  src/modules/field-map/fieldMapExperience.test.ts \
  src/modules/field-map/manifest.test.ts \
  src/modules/field-map/FieldMapModule.test.tsx
NEXT_PUBLIC_FULLMAG_FIELD_MAP_EXPERIENCE=legacy \
  pnpm --dir apps/control-room build:webpack
NEXT_PUBLIC_FULLMAG_FIELD_MAP_EXPERIENCE=scientific \
  pnpm --dir apps/control-room build:webpack
~~~

Oczekiwany GREEN: tests/builds PASS, identical state digests and zero PATCH. Flag does not remove PlanarMonitor, SceneDocument, ProblemIR, Python or API. Proponowany commit: `test: preserve planar settings through ui rollback`.

### Zadanie 12: Bramka C i kwalifikacja produkcyjna

**Status:** oczekuje. No completion claim before all evidence exists.

**Pliki:** create `.superpowers/sdd/planar-redesign-final-qualification.md`; verify every file from Tasks 2–11.

#### Krok 12.1 — evidence matrix

For every invariant record requirement, source owner, RED test, observed RED failure, minimal GREEN diff, focused/integration/live/browser command and result, evidence path and PASS/FAIL/BLOCKED. Missing cell is not PASS.

#### Krok 12.2 — full command gate

~~~bash
cargo test -p fullmag-api planar -- --nocapture
pnpm --dir apps/control-room exec vitest run src/modules/field-map
pnpm --dir apps/control-room exec vitest run \
  src/modules/inspector/visualization/PlanarVisualizationSection.test.tsx
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
pnpm --dir apps/control-room check:api-hygiene
pnpm --dir apps/control-room smoke:viewport-2d
git diff --check
~~~

Record exit code, passed/failed/skipped counts and timestamp.

#### Krok 12.3 — five-argument axis positive gate

~~~bash
rg -n 'resolvePlanarAxes\(' \
  apps/control-room/src/modules/field-map \
  apps/control-room/scripts
~~~

Każde dopasowanie musi mieć dokładnie postać `resolvePlanarAxes(frame, bounds, viewport, widthPx, heightPx)`. Oczekiwany rezultat is positive matches with arity five, not empty output. Add AST/unit assertion if formatting defeats textual review.

#### Krok 12.4 — dodatnia allowlista symboli kanonicznych

~~~bash
rg -n \
  'VisualizationTargetRef|VisualizationTargetRegistryEntry|target_overrides|resolveEffectivePlanarWireframe' \
  apps/control-room/src/kernel/visualization/planarTargetPresentation.ts \
  apps/control-room/src/kernel/api/generated/openapi-v2-types.ts \
  apps/control-room/src/modules/inspector/visualization \
  apps/control-room/src/modules/field-map \
  crates/fullmag-api/src/schemas/visualization_state.rs \
  crates/fullmag-api/src/router_v2/handlers/visualization/display.rs \
  crates/fullmag-api/src/router_v2/tests.rs
~~~

Oczekiwany GREEN: non-empty matches only in listed owners/consumers. Never treat correct symbols as expected-empty.

#### Krok 12.5 — forbidden architecture negative gate

~~~bash
if rg -n \
  'PlanarOverrideIdentity|PlanarOverrideSelectionResolution|PlanarPresentationTarget|PlanarTargetRegistry|planarTargetZOrder|activePlanarTarget|perTarget(Quantity|Range|Raster|Layer)' \
  apps/control-room/src crates/fullmag-api/src; then
  echo 'forbidden parallel planar target architecture found' >&2
  exit 1
fi
~~~

Oczekiwany GREEN: no source match; expression contains only forbidden models.

#### Krok 12.6 — user-facing axis label negative gate

~~~bash
if rg -n --pcre2 \
  '(^|[>"'"'`])\s*[uv]\s*\((m|nm|µm|mm)\)' \
  apps/control-room/src/modules/field-map \
  apps/control-room/src/design/styles/field-map.css; then
  echo 'legacy user-facing u/v axis label found' >&2
  exit 1
fi
~~~

Oczekiwany GREEN: no production/CSS match. Internal variables and negative test assertions are not prohibited labels and are reviewed separately.

#### Krok 12.7 — direct transport negative gate

~~~bash
if rg -n \
  'fetch\(|["`'"']/v2/sessions/current' \
  apps/control-room/src/modules/field-map \
  apps/control-room/src/modules/inspector/visualization; then
  echo 'direct transport found in React modules' >&2
  exit 1
fi
~~~

Oczekiwany GREEN: no match. External smoke scripts may make explicit requests; React uses generated transport/facade/hooks.

#### Krok 12.8 — final review

- [ ] HTTP v2 source of truth; websocket invalidation only.
- [ ] generated files not hand-edited.
- [ ] unified viewport/module preserved.
- [ ] no second target model/registry.
- [ ] optional registry fail-closed.
- [ ] one sample/render model.
- [ ] correct aspect/axes/oblique basis.
- [ ] horizontal scientific legend.
- [ ] independent FMVP proves nonzero data.
- [ ] legal zero ready/uniform.
- [ ] target styles isolated.
- [ ] bounded requests/lifecycle and healthy 3D.
- [ ] rollback variants preserve state.
- [ ] no quality reduction.
- [ ] unrelated dirty changes excluded.

Oznacz PASS wyłącznie przy kompletnych dowodach. Użyj BLOCKED z dokładnie wskazanym brakującym launcherem, fixture albo failing assertion. Review źródła, typecheck, pojedynczy screenshot lub niezdekodowany binary payload nie stanowią kwalifikacji produkcyjnej. To zadanie planistyczne nie tworzy commitu.