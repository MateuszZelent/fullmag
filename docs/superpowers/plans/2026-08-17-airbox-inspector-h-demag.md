# Airbox Inspector i H_demag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Usunąć podwójną ramę Airbox Inspectora, ujednolicić carrier-scoped identity `H_demag` i udowodnić widoczne wektory w przeglądarce.

**Architecture:** Self-framing visualization panel omija ogólny route frame. Jeden czysty resolver Airbox carrier identity zasila wszystkie frontendowe query i request keys; backendowy v2 field resource pozostaje jedynym źródłem danych, a renderer tylko adoptuje payload zgodny z targetem i topologią.

**Tech Stack:** React 19, Next.js 16, TypeScript, Vitest, Playwright, Rust/Axum OpenAPI v2, R3F/Three.js.

## Global Constraints

- Zachować niezależne zmiany współdzielonego checkoutu.
- Nie dodawać direct `fetch()` ani ręcznych ścieżek `/v2` w komponentach.
- Nie obniżać jakości, liczby glyphów ani widoczności warstw jako sposobu naprawy.
- FDM używa `scope_id=airbox`; FEM używa aktualnego Airbox mesh-part id.
- Test browserowy wektorów wykonuje klatkę z wyłączonym wireframe.

---

### Task 1: Pojedyncza rama Airbox Inspectora

**Files:**
- Modify: `apps/control-room/src/modules/inspector/panels/DedicatedExplorerInspectorPanels.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.route.test.tsx`
- Modify: `apps/control-room/scripts/smoke-inspector.mjs`

**Interfaces:**
- Consumes: `AirboxVisualizationPanel(props: InspectorPanelProps)`.
- Produces: route bez `DedicatedInspectorRouteFrame`, z jednym `data-inspector-owner="airbox.visualization"`.

- [ ] Dodać test, który renderuje route Airbox i wymaga jednej `.fm-scientific-inspector`, braku zewnętrznego `data-inspector-route-owner="airbox.visualization"` oraz kolejności `View` przed `Status`.
- [ ] Uruchomić test i potwierdzić RED z powodu podwójnej ramy.
- [ ] Zwrócić `AirboxVisualizationPanel` bezpośrednio dla `AirboxVisualizationInspectorPanel` i `MeshPartAirboxInspectorPanel`; nie zmieniać pozostałych route frames.
- [ ] Uruchomić test i smoke contract do GREEN.

### Task 2: Kanoniczny resolver Airbox carrier identity

**Files:**
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/model/viewport3DFieldDataPlan.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/model/viewport3DFieldDataPlan.test.ts`

**Interfaces:**
- Produces: `resolveAirboxFieldCarrierIdentity({ lane, airboxPartIds }): { scopeId: string; scopeKind: "airbox" } | null`.
- Consumes: resolved discretization lane i bieżące Airbox part IDs.

- [ ] Dodać RED testy: FDM → `airbox`, FEM `part:__air__` → `part:__air__`, nierozstrzygnięty FEM → `null`.
- [ ] Dodać RED test zabraniający vector requestu z `scope_kind=airbox` i pustym `scope_id`.
- [ ] Zaimplementować czysty resolver i użyć go w meta, availability oraz vector scope modelu.
- [ ] Użyć tej samej identity w field-data planie, bez zmiany topology demand.
- [ ] Uruchomić oba zestawy do GREEN.

### Task 3: Resource hook, cache i debug identity

**Files:**
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dResources.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dResources.test.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/visualization-debug/visualizationDebugExport.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/visualization-debug/visualizationDebugExport.test.ts`

**Interfaces:**
- Consumes: identity z Task 2.
- Produces: identyczne query w availability/meta/vector key/API query/debug log.

- [ ] Dodać RED test porównujący request key i API query dla FDM oraz FEM Airbox.
- [ ] Dodać RED test debug export wymagający jawnego `scope_id`.
- [ ] Przekazać resolved identity do resource hooks i builderów requestów; brak identity ma nie inicjować transportu.
- [ ] Uruchomić testy do GREEN i sprawdzić brak ad-hoc `/v2` w komponentach.

### Task 4: Backend publication/materialization H_demag

**Files:**
- Inspect/modify only if failing evidence requires: `crates/fullmag-api/src/router_v2/handlers/data/fields.rs`
- Inspect/modify only if failing evidence requires: `crates/fullmag-api/src/router_v2/handlers/data/field_resolution.rs`
- Test: `crates/fullmag-api/src/router_v2/tests.rs`

**Interfaces:**
- Consumes: scoped GET `/data/fields/H_demag/samples/vector` przez wygenerowany transport.
- Produces: ready binary payload lub jawny materializing response dla tego samego carrier identity.

- [ ] Uruchomić istniejące scoped FDM/FEM tests dla `H_demag` i zanotować faktyczny wynik.
- [ ] Jeżeli test reprodukuje brak publikacji, dodać RED test dla właściwego lane/carriera i naprawić globalny catalog/materialization path, bez one-off UI fallbacku.
- [ ] Uruchomić router v2 tests oraz OpenAPI generation tylko wtedy, gdy schema ulegnie zmianie.

### Task 5: Browser/WebGL proof

**Files:**
- Modify: `apps/control-room/scripts/smoke-airbox-field-routing.mjs`
- Modify: `apps/control-room/src/modules/viewport-3d/airboxFieldRoutingSmokeScript.test.ts`
- Create/update artifact: `apps/control-room/.artifacts/viewport-3d-browser-audit/airbox-h-demag-vectors.png`

**Interfaces:**
- Consumes: real v2 resource path i wspólny viewport.
- Produces: terminalny raport request/adoption/render oraz screenshot.

- [ ] Dodać RED contract test wymagający: `H_demag`, jawny `scope_id`, wireframe off, glyph count > 0, canvas visible, `isContextLost() === false`, drawing buffer > 0 i screenshot.
- [ ] Rozszerzyć smoke bez mockowania gotowości pola; fixture jest dozwolony wyłącznie dla deterministycznego testu skryptu, final proof korzysta z uruchomionego runtime.
- [ ] Uruchomić focused tests, typecheck, ESLint, React Doctor i `git diff --check`.
- [ ] Uruchomić czysty Playwright, zapisać screenshot i potwierdzić brak hydration mismatch oraz błędów konsoli aplikacji.

