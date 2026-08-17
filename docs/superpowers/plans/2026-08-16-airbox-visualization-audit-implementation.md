# Produkcyjne domknięcie audytu wizualizacji Airboxa — plan wdrożenia

> **Dla agentów:** plan wykonawczy dla `subagent-driven-development`; każdy etap kończy się własną weryfikacją przed przejściem dalej.

**Cel:** doprowadzić wizualizację FDM single-grid, FDM multilayer i FEM Airboxa do kontraktu produkcyjnego opisanego w audycie z 2026-08-16, wraz z dowodami runtime, browser/WebGL i benchmarkiem.

**Architektura:** HTTP v2 pozostaje źródłem prawdy dla readiness i zasobów, a websocket wyłącznie invaliduje zasoby. Backend publikuje targetowo identyfikowane, generacyjne carriery; frontend utrzymuje zasoby per target, last-good adoption, bounded retry i wspólny target-aware capacity/allocation contract dla Inspectora oraz renderera.

**Technologie:** Rust/Axum/OpenAPI v2, TypeScript/React/React Three Fiber, Vitest, Playwright/browser smoke, skrypty benchmarkowe repozytorium.

## Ograniczenia globalne

- Każda zmiana JSON przechodzi przez źródło OpenAPI, wygenerowane typy i handwritten facade.
- Nie dodawać endpointów ekranowych, bezpośredniego `fetch()` w komponentach ani ścieżki v1.
- FDM i FEM używają jednej ścieżki Inspectora/command facade; różnice pozostają w adapterach i carrierach.
- Nie obniżać domyślnej jakości viewportu jako ukrytego fallbacku.
- Raport, plan i audyt aktualizować po polsku; kod i nazwy symboli pozostają po angielsku.

## Etap 1 — backend readiness i kontrakt availability

**Pliki:** `crates/fullmag-api/src/router_v2/handlers/data/fields.rs`, `crates/fullmag-api/src/schemas/fields.rs`, `crates/fullmag-api/src/openapi_v2.rs`, `crates/fullmag-cli/src/orchestrator.rs`, `crates/fullmag-cli/src/live_workspace.rs` oraz testy routera/sesji.

- Związać completion `compute_fields` z dokładnym `(quantity, component, scope, scope_id, generation, carrier)`.
- Publikować carrier przez immutable generation i atomowy pointer manifestu.
- Rozdzielić `204`, `202 pending`, `404 unknown` i `409 conflict`, zachowując reason code, retry-after i generation.
- Wygenerować v2 transport/types i uruchomić testy API.

Weryfikacja: testy Rust router/session, OpenAPI generation, 100 równoległych odczytów generacji oraz E2E exact URL dla trzech lane’ów.

## Etap 2 — frontend resources i adopcja

**Pliki:** `apps/control-room/src/kernel/api/*`, `src/kernel/resources/*`, `src/modules/viewport-3d/viewport3dResources.ts`, `src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`, adaptery FEM/FDM i testy.

- Użyć availability hooka target/scope/quantity; rozdzielić `supported`, `materializing`, `ready`, `stale`, `adopted`.
- Zastąpić kolekcję `Promise.all` zasobami per target z partial snapshotem.
- Dodać last-good per target, bounded retry z `retry_after_ms`, AbortSignal deadline i per-carrier FEM status.
- Zachować HTTP snapshot jako źródło prawdy, a eventy tylko jako invalidację.

Weryfikacja: testy fake-timer/resource-cache, 404→pending→200, partial success i izolacja trzech targetów.

## Etap 3 — target state, renderer i budżet

**Pliki:** `VisualizationRegistrySyncController.ts`, `ObjectVisualizationController.ts`, `ObjectVisualizationPanelModel.tsx`, `fdmCuboidBuild*`, `viewport3dFieldDataPlan.ts`, `vectorGlyph*`, allocator i testy.

- Scalać override’y po canonical target identity i rebazować reset/patch na optimistic state.
- Oddzielić immutable topology od field/vector build key; vectors-only ma pracować na sampled anchors.
- Przekazywać `Surface|Full` tym samym selection/adjacency algorytmem.
- Wprowadzić globalny, deterministyczny scene allocator oraz jawne `requested/effective/adopted` accounting.
- Raportować worker/fallback, bounded upload i zachować latest-wins/cache/teardown.

Weryfikacja: przeplot 100 patchy, 100 quantity switch, test zero topology rebuildów, forced worker fallback oraz scheduler uploadu.

## Etap 4 — Inspector i trwałość

**Pliki:** `ObjectVisualizationPanel*`, `FdmGridInspectorPanel.tsx`, `ObjectGeneralPanel.tsx`, `VisualizationVectorAccountingRows.tsx`, quantity/availability resources.

- Zastąpić globalny cell count targetowym capacity descriptor (`cells` dla FDM, `nodes` dla FEM, exact/generation/topology).
- Nie uruchamiać pełnego debug scan przy zwykłym otwarciu panelu.
- Pokazać `available candidates`, `requested`, `effective allocation`, `decoded samples`, `adopted arrows` oraz pending/rejected state.
- Usunąć arbitralne `4096`, no-op `Lift above surface` i rozjazdy trwałości FDM/FEM.
- Użyć jednej command facade dla Airboxa i kolorów obiektu.

Weryfikacja: DOM tests dla wszystkich targetów, union node count FEM, revision-bound accounting, rejection/rollback/reload.

## Etap 5 — kwalifikacja i audyt

Uruchomić testy jednostkowe/kontraktowe, E2E exact URL, browser/WebGL smoke dla FDM single-grid, multilayer i FEM (wireframe on → off → vectors on), 20 cold + 20 warm prób benchmarku z p50/p95 i pełnym breakdownem. Zaktualizować audyt tylko świeżymi wynikami; nie oznaczać celu jako zamkniętego przy brakującym dowodzie runtime.
