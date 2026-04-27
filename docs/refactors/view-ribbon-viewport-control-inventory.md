# View Ribbon Viewport Control Inventory

Data: 2026-04-27

## Zakres

Ten dokument zamyka etap P0/P1/P2 refaktoryzacji opisanej w `docs/reports/27.04.2026/vieport/`.
Stan po tej iteracji:

- `View` ribbon jest glownym centrum sterowania viewportem 3D.
- Stary `ViewportBar` / `UnifiedViewportBar` jest domyslnie ukryty przez flagi diagnostyczne.
- FEM overlay toolbar jest domyslnie ukryty, zeby canvas zostal czysty.
- Backendowy pelny `VisualizationStateResource` nie jest jeszcze zaimplementowany; menu korzysta z kompatybilnych komend i istniejacego `PATCH /visualization/display` tam, gdzie taki kontrakt juz istnieje.

## Obecne komendy i status migracji

| Obszar | Stara sciezka | Nowa komenda/menu | Status |
| --- | --- | --- | --- |
| Quantity | `preview.select-quantity` / `requestPreviewQuantity` | `viewport.set-quantity` | wrapper, dziala |
| Component | `displayPatchFromPreviewComponent` | `viewport.set-component` | wrapper, dziala |
| Every N | `PATCH /visualization/display { vector_density }` | `viewport.set-vector-density` | wrapper, dziala |
| Colormap | `PATCH /visualization/display { colormap }` | `viewport.set-colormap` | wrapper, dziala dla wspieranych runtime |
| Auto-scale | `PATCH /visualization/display { auto_contrast }` | `viewport.set-auto-scale` | wrapper, dziala |
| Vectors toggle | `setMeshShowArrows` | `viewport.toggle-vectors` | wrapper, dziala |
| Vector style | FEM local arrow setters | `viewport.set-vector-style` | wrapper, dziala lokalnie |
| Airbox visible/opacity | `setAirMeshVisible`, `setAirMeshOpacity` | `viewport.set-airbox-display` | wrapper, dziala lokalnie |
| Mesh render mode | `setMeshRenderMode` | `viewport.set-global-render-mode` | wrapper, dziala |
| Mesh opacity | `setMeshOpacity` | `viewport.set-global-opacity` | wrapper, dziala |
| Global clip | `setMeshClip*` | `viewport.set-global-clip` | wrapper, dziala |
| Selected opacity | `meshEntityViewState[part].opacity` | `viewport.set-selected-opacity` | wrapper, dziala lokalnie per selected object |
| Selected render/clip | per-object backend state brak | `viewport.set-selected-*` | widoczne i capability-gated, pelna persistencja wymaga `VisualizationStateResource` |
| Control mode | builder viewport callbacks | `viewport.set-control-mode` | wrapper, czesciowo dziala |
| Transform gizmo | `viewport.set-transform-scope`, builder tool | `viewport.set-transform-scope`, `viewport.set-transform-tool` | wrapper, dziala gdzie capability istnieje |
| Snapshot | `capture.viewport` | `viewport.capture` | wrapper, dziala |
| Export image/state | `export.results`, `export.state` | `viewport.export-image`, `viewport.export-state` | wrapper, dziala |
| Panels | sidebar/legend callbacks | `viewport.toggle-sidebar`, `viewport.toggle-legend` | reuse, dziala |
| Axes / scale | `viewport.set-axes-scope`, `viewport.toggle-universe-wireframe` | same command ids | reuse, dziala |

## Store fields uzywane przez nowy ribbon

Globalne:

- `requestedPreviewQuantity`
- `requestedPreviewComponent`
- `requestedPreviewEveryN`
- `requestedPreviewAutoScale`
- `requestedPreviewQuantityDataStatus`
- `meshRenderMode`
- `meshOpacity`
- `meshClipEnabled`
- `meshClipAxis`
- `meshClipPos`
- `meshClipFlip`
- `meshShowArrows`
- `airMeshVisible`
- `airMeshOpacity`
- `viewportLegendVisible`
- `viewportAxesScope`
- `universeWireframeVisible`

FEM/vector:

- `femArrowColorMode`
- `femArrowMonoColor`
- `femArrowAlpha`
- `femArrowLengthScale`
- `femArrowThickness`
- `femVectorDomainFilter`
- `femFerromagnetVisibilityMode`

Selected/transient:

- `selectedObjectId`
- `activeTransformScope`
- `builderEnabled`
- `builderSelectedPrimitiveId`
- `meshEntityViewState`
- `meshParts`

## Backend ownership

Istniejacy backend owner:

- `/v2/sessions/current/visualization/display` dla quantity/component/colormap/auto-scale/vector density.
- session/workspace status dla capability i revision context.

Docelowy backend owner po P3/P6:

- `/v2/sessions/current/visualization/state`
- `/v2/sessions/current/visualization/objects/{object_id}/display`
- `/v2/sessions/current/visualization/effective-display`
- visualization realtime invalidation events.

## Jawne ograniczenia po tej iteracji

- Selected opacity zapisuje lokalny `meshEntityViewState` dla czesci mesha nalezacych do zaznaczonego obiektu.
- Pelne per-object render/clip/color overrides sa widoczne w ribbonie, ale backendowy canonical zapis per-object nie istnieje jeszcze.
- Navigation profile, transparent capture, overlay capture toggle i topography state sa pokazane jako planned/disabled tam, gdzie nie ma jeszcze stabilnego kontraktu.
- Airbox shaded/wireframe sa przygotowane w menu docelowym tylko czesciowo; obecny runtime expose'uje glownie visible/opacity/vector-domain.
- Pelny cleanup `ViewportBar.tsx` jako pliku moze nastapic po P3/P6/P7, gdy wszystkie jego lokalne akcje beda pokryte przez canonical visualization state.

## Testy dodane w tej iteracji

- `apps/web/features/shell/registry/__tests__/ribbonMenuAdapter.test.ts`
- `apps/web/features/shell/contributions/__tests__/view.test.ts`

Pokrycie:

- adapter `menuItems -> RibbonMenuNode`,
- docelowe piec grup `View`,
- rich quantity menu z disabled reason,
- per-object opacity czytane z `selectedObjectOpacity`, nie z globalnego opacity,
- `Selected Display` widoczne, ale disabled bez selekcji.
