# Plan implementacji renderowania Airboxa FDM/FEM

> **Dla wykonawców agentowych:** wymagany jest skill `executing-plans` lub
> `subagent-driven-development`. Kroki są śledzone checkboxami.

**Cel:** Renderować prawdziwy mesh Airboxa jako `wireframe` i `points` dla FDM
oraz FEM, a następnie potwierdzić `H_demag` na zgodnych carrierach.

**Architektura:** FDM używa istniejącego inactive-cell cuboid modelu opartego
na `DomainMeta + FMRM`; FEM używa manifestu i binarnej topologii. Proceduralne
bounds pozostają osobnym passem i nie zastępują meshu.

**Technologie:** React 19, TypeScript, R3F/Three.js, Vitest, Playwright, HTTP v2.

## Ograniczenia globalne

- Zachować jeden wspólny viewport i domenowo neutralne warstwy renderera.
- Nie zmieniać OpenAPI ani transportu, jeśli obecne zasoby wystarczają.
- Nie dodawać component-level `fetch()` ani ręcznych URL-i.
- Nie nadpisywać istniejących zmian katalogu pól i runtime FDM.
- Każda zmiana zachowania przechodzi RED przed implementacją.
- Surface shader Airboxa pozostaje wyłączony.

---

### Zadanie 1: Kontrakt passów FDM Airbox

**Pliki:**
- Modyfikacja: `apps/control-room/src/modules/viewport-3d/layers/fdmAirboxPassPlan.test.ts`
- Modyfikacja: `apps/control-room/src/modules/viewport-3d/layers/fdmAirboxPassPlan.ts`

**Interfejs:** `resolveFdmAirboxPassPlan(settings)` ma zwracać osobne żądania
inactive-cell geometry, points, wireframe/instances, bounds i vector anchors.

- [ ] Dodać test, że `wireframeVisible=true` ustawia
  `needsInactiveCellGeometry=true` i `needsSurfaceInstances=true`.
- [ ] Dodać test, że `pointsVisible=true` ustawia
  `needsInactiveCellGeometry=true` i `needsPointGeometry=true`.
- [ ] Dodać test niezależności Bounds oraz Vectors.
- [ ] Uruchomić test i potwierdzić RED wynikający z obecnego extent-only planu.
- [ ] Wdrożyć minimalny rozszerzony plan passów.
- [ ] Uruchomić test i potwierdzić GREEN.

### Zadanie 2: FDM inactive-cell model dla wireframe i points

**Pliki:**
- Modyfikacja: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts`
- Modyfikacja: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`
- Modyfikacja: `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.test.ts`
- Modyfikacja: `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx`

**Interfejs:** istniejący `fdmAirboxInstanceModel` pozostaje pojedynczym modelem
inactive cells dla wszystkich passów.

- [ ] Dodać test RED, że build jest włączony dla wireframe/points bez vectors.
- [ ] Dodać test RED, że render settings przekazane do `FdmCuboidLayer`
  zachowują wybrany wireframe albo points i wyłączają tylko surface shader.
- [ ] Zmienić enable/build key tak, aby zależał od całego planu geometrii.
- [ ] Przekazać do `FdmCuboidLayer` ustawienia właściwe dla passu zamiast zerować
  `wireframeVisible` i `pointsVisible`.
- [ ] Potwierdzić GREEN w obu plikach testowych.

### Zadanie 3: Oddzielenie FDM Bounds od meshu

**Pliki:**
- Modyfikacja: `apps/control-room/src/modules/viewport-3d/layers/BoundsLayers.test.tsx`
- Modyfikacja: `apps/control-room/src/modules/viewport-3d/layers/BoundsLayers.tsx`

**Interfejs:** `FdmUniverseOutsideSupportLayer` renderuje wyłącznie bounding
frames bez proceduralnych interior divisions.

- [ ] Dodać test RED zabraniający `BoundsVolumeWireframe` w FDM layer.
- [ ] Zastąpić jego użycie `BoundsBox` dla universe/support frames.
- [ ] Zachować oddzielne opacity, semantic role i picking.
- [ ] Potwierdzić GREEN.

### Zadanie 4: Przywrócenie FEM points i realnych volume edges

**Pliki:**
- Modyfikacja: `apps/control-room/src/modules/viewport-3d/layers/BoundsLayers.test.tsx`
- Modyfikacja: `apps/control-room/src/modules/viewport-3d/layers/BoundsLayers.tsx`
- Modyfikacja: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts`
- Modyfikacja: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.ts`
- Modyfikacja: `apps/control-room/src/kernel/visualization/ObjectVisualizationController.test.ts`
- Modyfikacja: `apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts`

**Interfejs:** Airbox capability oferuje `off|wireframe|points`; runtime zachowuje
points i usuwa jedynie shader.

- [ ] Dodać test RED zachowania `pointsVisible` przez runtime normalization.
- [ ] Dodać test RED, że realne `volumeEdgeIndices` wyłączają proceduralny
  fallback, natomiast brak edge geometry go zachowuje.
- [ ] Dodać test RED przywracający points w capability/Inspectorze.
- [ ] Wdrożyć minimalne zmiany kontrolera, Inspectora i warstwy FEM.
- [ ] Potwierdzić GREEN.

### Zadanie 5: Browser fixture dla geometrii Airboxa

**Pliki:**
- Modyfikacja: `apps/control-room/scripts/smoke-viewport-3d-explorer-inspector-targets.mjs`
- Modyfikacja: `apps/control-room/src/modules/viewport-3d/viewportSmokeProjectionScript.test.ts`

**Interfejs:** smoke zwraca oddzielne dowody `wireframe`, `points`, `vectors`
dla FDM i FEM oraz zapisuje screenshot każdego stanu.

- [ ] Dodać statyczny test RED wymagający osobnych faz geometrii Airboxa.
- [ ] Rozszerzyć helper sterowania trybem Airboxa.
- [ ] Dla każdej fazy sprawdzić pixel delta, WebGL health i telemetryczny key.
- [ ] Zapisać screenshoty z nazwą backendu i passu.
- [ ] Uruchomić fixture FDM i FEM oraz odczytać pełne wyniki.

### Zadanie 6: Weryfikacja `H_demag`

**Pliki:**
- Modyfikacja tylko w razie wykrycia błędu:
  `apps/control-room/src/modules/viewport-3d/model/viewport3DFieldDataPlan.ts`
- Modyfikacja tylko w razie wykrycia błędu:
  `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`
- Modyfikacja tylko w razie wykrycia błędu:
  `apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.ts`
- Testy odpowiadające zmienionej warstwie.

- [ ] Potwierdzić FDM request `H_demag`, `scope_kind=airbox`, sample count,
  generation/fingerprint i mapowanie cell ordinals.
- [ ] Potwierdzić FEM request `H_demag`, dokładny part id, topology identity i
  sampled node indices.
- [ ] Potwierdzić widoczne glyphy oraz zgodny carrier w browser smoke.
- [ ] Jeśli którykolwiek krok zawiedzie, dodać najwęższy test RED, naprawić
  źródło i powtórzyć dowód.

### Zadanie 7: Końcowe bramki

- [ ] `env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run <zmienione testy>`
- [ ] `pnpm --dir apps/control-room typecheck`
- [ ] targeted ESLint dla zmienionych plików
- [ ] `pnpm --dir apps/control-room check:api-hygiene`
- [ ] `pnpm --dir apps/control-room test -- --run viewport`
- [ ] `pnpm --dir apps/control-room test -- --run viewport-memory-stress`
- [ ] `pnpm --dir apps/control-room audit:idle-performance`
- [ ] browser smoke FDM/FEM z screenshotami i WebGL health
- [ ] końcowy diff i requirement-by-requirement audit bez dotykania zmian
  niezwiązanych z Airboxem.
