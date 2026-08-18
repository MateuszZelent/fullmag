# Wspólny Inspector wizualizacji 3D/2D — plan implementacji

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zastąpić osobny, monolityczny Inspector 2D jedną kompozycją Inspectora współdzieloną z 3D, zachowując wspólne warstwy i style oraz dodając w 2D wyłącznie Source/Slice/Sampling.

**Architecture:** Współdzielone komponenty prezentacyjne pozostają neutralne względem renderera. Adapter 3D zachowuje `VisualizationTargetSettings`; adapter 2D mapuje te same pojęcia na `visualization/state.planar`. OpenAPI przechowuje brakujące style 2D, a ciężkie bufory pozostają w istniejących resource hooks i rendererze Canvas/worker.

**Tech Stack:** Rust/Serde/Utoipa, OpenAPI v2, generowane typy TypeScript, React 19, Next.js 16, Canvas 2D, Web Worker, Vitest, repozytoryjne testy Rust.

## Global Constraints

- Pracować w bieżącym współdzielonym checkoutcie bez resetu, stashowania i commitów.
- Zachować wszystkie istniejące zmiany niezwiązane z zadaniem.
- Nie dodawać `planar.render_mode`; tryb jest pochodną warstw.
- Nie dodawać bezpośredniego `fetch()` ani ręcznie składanych ścieżek `/v2`.
- Wszystkie klasy CSS mają prefiks `fm-` i korzystają z `--fm-*`.
- Jeden base Canvas i jeden overlay Canvas; bez drugiego WebGL.
- Każdy krok behawioralny przechodzi cykl RED -> GREEN.

---

### Task 1: Semantyka wspólnego Render Mode

**Files:**
- Modify: `apps/control-room/src/modules/inspector/visualization/presentationSemantics.ts`
- Modify: `apps/control-room/src/modules/inspector/visualization/presentationSemantics.test.ts`

**Interfaces:**
- Produces: `PlanarDisplayMode`, `resolvePlanarDisplayMode(layers)`, `planarDisplayModePatch(mode, layers)`.
- Preserves: `contours`, `vectors`, `probes` i `bounds` podczas zmiany trybu głównego.

- [ ] Dodać testy pięciu trybów oraz zachowania niezależnych passów.
- [ ] Uruchomić `pnpm --dir apps/control-room exec vitest run src/modules/inspector/visualization/presentationSemantics.test.ts` i potwierdzić oczekiwany RED.
- [ ] Zaimplementować minimalne funkcje mapujące dokładnie tabelę ze specyfikacji.
- [ ] Uruchomić test ponownie i uzyskać GREEN.

### Task 2: Kanoniczne style prezentacji planarnej

**Files:**
- Modify: `crates/fullmag-api/src/schemas/visualization_state.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/visualization/display.rs`
- Modify: `crates/fullmag-api/src/router_v2/tests.rs`
- Modify: `crates/fullmag-api/src/session_persistence.rs`
- Generated: `apps/control-room/src/kernel/api/generated/openapi-v2.json`
- Generated: `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts`
- Generated: `apps/control-room/src/kernel/api/generated/openapi-v2-client.ts`
- Generated: `apps/control-room/src/kernel/api/generated/openapi-v2-paths.ts`

**Interfaces:**
- Extend `PlanarVisualizationState/Patch` with `visible`, `viewport_colorbar_visible`, `wireframe_style`, `point_style`.
- Extend `PlanarVectorStyleState` with `opacity`, `thickness`, `monochrome_color`.
- New sessions default to `raster=true`, `mesh=false`, `boundaries=false`.

- [ ] Dodać Rust tests defaultów, patchowania, walidacji opacity/thickness/size i wymaganych pól OpenAPI.
- [ ] Uruchomić wąskie testy Rust i potwierdzić RED.
- [ ] Dodać typy Serde/Utoipa, defaulty, walidację i `apply_planar_visualization_patch`.
- [ ] Podnieść persistence schema do v10 i dodać migrację v9 uzupełniającą nowe style bez zmiany zapisanych warstw.
- [ ] Uruchomić wąskie testy Rust do GREEN.
- [ ] Uruchomić `pnpm --dir apps/control-room generate:api` i nie edytować wygenerowanych plików ręcznie.

### Task 3: Wspólne kontrolki prezentacyjne Inspectora

**Files:**
- Create: `apps/control-room/src/modules/inspector/visualization/VisualizationInspectorControls.tsx`
- Create: `apps/control-room/src/modules/inspector/visualization/VisualizationInspectorControls.test.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationTargetSection.tsx`

**Interfaces:**
- Produces: `VisualizationRenderModeControl`, `VisualizationDisplayPassesControl` oraz neutralne layouty Surface Coloring, Vectors, Points i Wireframe.
- Consumers pass values/callbacks; shared controls never import 3D or 2D renderer modules.

- [ ] Dodać test klawiatury, aria state, disabled reason i identycznej kolejności opcji.
- [ ] Uruchomić test i potwierdzić RED z powodu brakujących eksportów.
- [ ] Wydzielić wspólne kontrolki bez zmiany zachowania 3D.
- [ ] Podłączyć istniejące sekcje 3D do wspólnych komponentów.
- [ ] Uruchomić testy nowego komponentu i istniejącego Inspectora 3D do GREEN.

### Task 4: Adapter i kompozycja Inspectora 2D

**Files:**
- Modify: `apps/control-room/src/modules/inspector/visualization/PlanarVisualizationSection.tsx`
- Modify: `apps/control-room/src/modules/inspector/visualization/PlanarPresentationSections.tsx`
- Modify: `apps/control-room/src/modules/inspector/visualization/DefaultPlanarSourceSection.tsx`
- Modify: `apps/control-room/src/modules/inspector/visualization/PlanarVisualizationSection.test.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationOverview.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.route.test.tsx`

**Interfaces:**
- 2D renders the same Overview/Display/Surface Coloring/Vectors/Points/Wireframe composition as 3D.
- 2D adds `Source & Slice` and `Sampling & Resolution`.
- Patches go only through `visualizationSync.queuePatch({ planar: ... })`.

- [ ] Dodać test zgodności wspólnych nagłówków i kolejności 3D/2D.
- [ ] Dodać test `Shaded` -> raster on, mesh/boundaries off.
- [ ] Dodać test wspólnego quiver, wireframe, points, opacity i colorbar controls.
- [ ] Uruchomić testy i potwierdzić RED.
- [ ] Przebudować `PlanarVisualizationSection` jako adapter wspólnej kompozycji.
- [ ] Zachować Source/Default Slice/monitor, range, quality, provenance i target scope.
- [ ] Usunąć zastąpioną surową listę `Geometry layers`.
- [ ] Uruchomić testy Inspectora do GREEN.

### Task 5: Style i niezależne overlaye renderera 2D

**Files:**
- Modify: `apps/control-room/src/modules/field-map/model/fieldMapRenderModel.ts`
- Modify: `apps/control-room/src/modules/field-map/model/fieldMapRenderModel.test.ts`
- Modify: `apps/control-room/src/modules/field-map/FieldMapModule.tsx`
- Modify: `apps/control-room/src/modules/field-map/FieldMapModule.test.tsx`
- Modify: `apps/control-room/src/modules/field-map/renderer/PlanarSurface.tsx`
- Modify: `apps/control-room/src/modules/field-map/renderer/PlanarSurface.test.tsx`
- Modify: `apps/control-room/src/modules/field-map/renderer/planarRenderer.ts`
- Modify: `apps/control-room/src/modules/field-map/renderer/planarRenderer.test.ts`

**Interfaces:**
- Render model carries `visible`, wireframe/point/vector style and viewport colorbar visibility.
- Mesh resource gate remains `(mesh || boundaries)` and vector gate remains `vectors`.

- [ ] Dodać testy render modelu dla nowych stylów i `visible=false`.
- [ ] Dodać test renderera: raster+quiver jednocześnie, mesh off bez czyszczenia rastra, opacity/width/color z tokenów.
- [ ] Uruchomić testy i potwierdzić RED.
- [ ] Rozszerzyć model oraz rysowanie overlayów bez remountu rendererów/workera.
- [ ] Warunkować colorbar przez `viewport_colorbar_visible` i raster.
- [ ] Uruchomić testy field-map do GREEN.

### Task 6: Kontrakt, regresje i weryfikacja

**Files:**
- Modify: `apps/control-room/scripts/smoke-viewport-2d.mjs`
- Modify: `docs/superpowers/specs/2026-08-17-unified-3d-2d-visualization-inspector-design.md`
- Modify: `docs/superpowers/plans/2026-08-17-amumax-2d-interface-transfer.md`

- [ ] Rozszerzyć smoke o Shaded bez mesh, Shaded+Wireframe oraz quiver nad rasterem.
- [ ] Uruchomić wąskie testy Rust i frontend.
- [ ] Uruchomić `pnpm --dir apps/control-room check:api-hygiene`.
- [ ] Uruchomić `pnpm --dir apps/control-room check:architecture-hygiene`.
- [ ] Uruchomić targeted ESLint dla zmienionych plików.
- [ ] Uruchomić `pnpm --dir apps/control-room typecheck` i oddzielić błędy istniejące od nowych.
- [ ] Uruchomić `pnpm --dir apps/control-room smoke:viewport-2d`; jeśli środowisko nie ma działającego serwera/przeglądarki, zapisać dokładny blocker.
- [ ] Uruchomić `git diff --check`.
- [ ] Uzupełnić status dokumentacji bez deklarowania browser-verified, jeśli smoke nie przejdzie.

## Status realizacji — 2026-08-17

Zaimplementowano wspólną kompozycję Inspectora 3D/2D, współdzielone kontrolki Display Passes i Render Mode, planarne sekcje Source & Slice oraz Sampling & Resolution, a także style wireframe, points i quiver w zasobie v2. Domyślny profil 2D uruchamia ciągłą heatmapę bez mesh/boundaries. Stan `visible`, widoczność colorbara i style overlayów przechodzą przez Rust/OpenAPI, wygenerowane typy, optimistic projection, adapter field-map i renderer Canvas.

Weryfikacja źródłowa:

- 206 testów frontendowych dla field-map, planar Inspector, projekcji i zasobów — PASS,
- testy Rust: default, round-trip, walidacja, OpenAPI oraz migracja persistence v9 -> v10 — PASS,
- `check:architecture-hygiene` — PASS,
- targeted ESLint — PASS po usunięciu nieużywanego helpera,
- typecheck dochodzi wyłącznie do niezależnego błędu istniejącego fixture `viewport3dDiagnostics.test.ts` (brak `fieldRevision` i `topologyRevision`),
- `check:api-hygiene` blokuje niezależny, istniejący test `visualizationDebugExport.test.ts` z ręcznie zapisanym URL v2,
- browser smoke nie został zakwalifikowany: `localhost:3194` nie nasłuchuje, a połączenie z przeglądarką aplikacji zostało odrzucone przez nieprawidłowy `sandboxCwd` przekazany do runtime. Nie deklarować browser-verified do czasu ponownego uruchomienia smoke.
