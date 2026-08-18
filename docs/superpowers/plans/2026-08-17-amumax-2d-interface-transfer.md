# Amumax → Fullmag: interfejs wizualizacji 2D — plan przeniesienia

> **Dla agentów implementujących:** do realizacji tego planu użyj `subagent-driven-development` albo `executing-plans` i wykonuj zadania w kolejności, zachowując bramki akceptacyjne.

**Cel:** przenieść do zakładki `2D View` Fullmag użyteczny model interakcji z wizualizacji 2D Amumax — wybór ilości, komponentu, przekroju, rozdzielczości, skali kolorów, odczytu punktowego i eksportu — bez kopiowania jego transportu, globalnego stanu ani semantyki próbkowania. Pełne sterowanie pozostaje w dedykowanym Inspectorze; powierzchnia renderera nie duplikuje tych kontrolek.

**Architektura:** Amumax dostarcza prosty wzorzec interfejsu: panel sterowania nad jedną powierzchnią pola, szybka zmiana komponentu/warstwy i natychmiastowa aktualizacja heatmapy. Fullmag zachowuje ten wzorzec na aktywnej powierzchni `field-map`, ale źródłem prawdy pozostaje `visualization/state.planar`, monitor `Default`/autorski, API v2 i backendowy `PlanarSamplingEngine`; ciężkie bufory pozostają zasobami binarnymi, a rasteryzacja odbywa się przez istniejący Canvas 2D + worker.

**Technologie:** React 19 / Next.js 16, istniejący moduł `field-map`, `ControlRoomApi` + resource hooks, OpenAPI v2, Canvas 2D, Web Worker, ECharts 6 tylko dla wykresów analitycznych, Radix/shadcn primitives, kodery binarne FMFG/FMCS.

### Decyzja wykonawcza z 2026-08-17

W trakcie implementacji doprecyzowano własność interfejsu: `Source`, `Quantity`, `Component`, `Plane`, pozycja normalna, operator/grubość, zakres, paleta i warstwy są kontrolowane wyłącznie przez Inspector wizualizacji. `FieldMapModule` pokazuje tylko pasywny opis aktywnego pola, osie, colorbar, tooltip/probe oraz akcje powierzchni (`fit`, pan, zoom, eksport). Pozycje z pierwotnego szkicu, które zakładały selektory nad Canvasem, są tym samym zastąpione i nie mogą być ponownie dodane.

## Ograniczenia globalne

- Nie dodawać drugiego kontekstu WebGL; `viewport-3d` pozostaje jedyną powierzchnią Three.js/R3F.
- Nie przenosić Svelte, Flowbite, endpointów `/api/preview/*` ani pełnego komunikatu MsgPack Amumax do Control Room.
- Frontend nie może budować URL-i endpointów ani wywoływać `fetch()` poza fasadą `ControlRoomApi` i resource hooks.
- `Default` jest źródłem sesyjnym (domyślnie `xy`, `position_fraction=0.5`), a nie tworzonym monitorem.
- Zakresy kolorów są `auto | manual | symmetric`, w SI; jednostka prezentacji jest osobną transformacją.
- FDM i FEM muszą używać backendowego próbkowania z wagą miary; średnia po liczbie węzłów nie jest dozwolona.
- Wszystkie klasy CSS w Control Room mają prefiks `fm-`, a kolory pochodzą z tokenów `--fm-*`.
- Każda zmiana renderera 2D wymaga testu lifecycle oraz browser smoke z niezerowym buforem rysowania.
- Dokumentacja i raporty są po polsku; nazwy kodowe, typy i komentarze w kodzie pozostają po angielsku.

---

## 1. Zbadana implementacja Amumax

Analiza została wykonana na lokalnym repozytorium `external_solvers/amumax`, rewizja:

```text
03c9bf19a5266e64db5658d6d118db10a6a4c78f
03c9bf1 Update npm hash
```

Starszy `external_solvers/3` to MuMax3 z serwerowym HTML/JPEG; nie jest wzorcem dla tej migracji. Właściwy Amumax ma frontend SvelteKit.

### 1.1. Mapa interfejsu

| Element Amumax | Dowód w kodzie | Zachowanie | Decyzja dla Fullmag |
|---|---|---|---|
| Kontener `Preview` | `external_solvers/amumax/frontend/src/lib/preview/Preview.svelte:20-71` | Jedna karta z kontrolkami i powierzchnią o wysokości 500 px; przy braku danych pokazuje `NO DATA`. | Zachować ideę jednej powierzchni, ale użyć istniejącego `field-map`, jego statusów i responsywnego aspect ratio. |
| Wybór ilości | `.../inputs/QuantityDropdown.svelte:1-39` | Dropdown z grupą `Common` i kategoriami; wysyła `postQuantity`. | Zasilić katalogiem pól Fullmag i `visualizationSync.queuePatch({ planar: { quantity_id } })`. |
| Wybór komponentu | `.../inputs/Component.svelte:1-27` | Radio `3D`, `x`, `y`, `z`; wyłącza się dla skalaru. | Rozszerzyć o istniejące `magnitude`, `in_plane_magnitude`, `orientation`, `u`, `v`, `normal`; opcje wynikają z capability katalogu. |
| Warstwa Z | `.../inputs/Layer.svelte:1-17`; backend `src/api/sec_preview.go:420-435` | Slider wybiera całkowitą warstwę `0..Nz-1`; zmiana odświeża maskę. | Dla `Default` zastąpić wyborem płaszczyzny `XY/XZ/YZ` i suwakiem współrzędnej/frakcji; dla monitora pokazać jego operator/grubość. |
| Rozdzielczość X/Y | `.../inputs/XDataPoints.svelte`, `YDataPoints.svelte`; backend `sec_preview.go:316-349` | Lista tylko dzielników `Nx`/`Ny`; backend wybiera najbliższy legalny rozmiar. | Mapować na `resolution.width/height` i `quality` w profilu; walidować budżet oraz koszt, nie wymuszać dzielników siatki FEM. |
| Heatmapa 2D | `.../preview/preview2D.ts:62-250` | ECharts 5.5.1, renderer `svg`, seria `heatmap`, dataset `[x,y,value]`, osie kategorii, tooltip, axis pointer, `visualMap`, dataZoom, zapis PNG. | Przejąć układ informacji i akcje; raster zostaje Canvas + worker, ponieważ Fullmag nie może tworzyć tysięcy elementów SVG ani React per próbka. |
| Skala kolorów | `.../preview/preview2D.ts:24-30,178-199`; backend `sec_preview.go:203-240` | Diverging palette `blue-white-red` dla zakresu obejmującego zero, w innym przypadku `white-red`; `min/max` wyliczane przy każdym buforze. | Zachować automatyczny/symetryczny/manualny model Fullmag, maskowanie pustych i nie-finite wartości oraz jednostki SI/display. |
| Tooltip | `.../preview/preview2D.ts:89-101` | Pokazuje wartość i jednostkę; brak osobnego zapytania backendowego. | Zachować szybki lokalny hover, ale pin wykonywać przez zasób `/probe` z dokładną współrzędną świata i occupancy. |
| Zoom/export | `.../preview/preview2D.ts:224-248` | DataZoom i `saveAsImage` zapisują PNG z wykresu. | Zachować zoom, fit, PNG i eksport danych jako komendy `field-map.*`; eksport musi używać kanonicznego `render.png`/danych, nie screenshotu DOM. |
| 3D↔2D przełączenie | `.../api/websocket.ts:98-103`, `preview2D.ts:7-21`, `preview3D.ts:1-25` | Po `type` niszczy jeden renderer i tworzy drugi. | Utrzymać zasadę aktywnej jednej ciężkiej powierzchni przez `viewport-main`; `field-map` i `viewport-3d` nie mogą żyć równolegle. |
| Transport stanu | `.../api/engine_state.go:5-37`, `.../api/websocket.go:116-145` | Pełny `EngineState` MsgPack wysyłany okresowo i po POST; `refresh` wymusza rekonstrukcję. | WebSocket v2 tylko unieważnia rewizje; zasoby JSON/binarnie są pobierane żądaniowo przez fasadę. |

### 1.2. Rzeczywisty przepływ danych Amumax

1. `PreviewState` ma jednocześnie identyfikator ilości, komponent, warstwę, typ `2D/3D`, pola, `min/max`, wybrany rozmiar X/Y i flagę `Refresh` (`src/api/sec_preview.go:16-39`).
2. POST dla komponentu/ilości/warstwy/rozmiaru aktualizuje globalny stan i wywołuje `broadcastEngineState` (`sec_preview.go:382-505`).
3. `UpdateQuantityBuffer` kopiuje ilość z GPU do CPU, skaluje ją do `XChosenSize × YChosenSize × 1`, wybiera komponent i publikuje albo listę wektorów, albo tablicę punktów skalarnych (`sec_preview.go:87-135`).
4. `UpdateScalarField` filtruje maską geometrii, wylicza `min/max`, a dane publikuje jako `[x,y,value]` (`sec_preview.go:203-240`).
5. Frontend `parseMsgpack` ustawia store i wywołuje `preview2D()` lub `preview3D()` (`frontend/src/api/websocket.ts:73-105`).
6. `preview2D()` tworzy ECharts tylko po zmianie typu/rozmiaru, a później aktualizuje dataset i `visualMap` (`preview2D.ts:7-60`).

### 1.3. Ważne ograniczenia wzorca Amumax

- To jest przekrój jednej warstwy siatki FDM, a nie ogólny monitor: brak `XZ/YZ`, grubości, projekcji głębinowej, powierzchni i targetów FEM.
- Frontend otrzymuje już zrasteryzowane punkty i pełne `min/max`; nie ma kontraktu rewizji, ETag, `sample_token` ani fail-closed dla nieaktualnego pola.
- `scalarField` jest reprezentowane jako lista punktów, co zwiększa narzut transportu i pamięci; Fullmag ma używać binarnego wektora.
- `normalizeVectors` dzieli przez `maxnorm` bez osobnej obsługi `maxnorm == 0` (`sec_preview.go:137-165`); nie przenosić tego zachowania.
- `UpdateScalarField` inicjalizuje ekstremum pierwszą komórką przed odfiltrowaniem maski (`sec_preview.go:203-220`); Fullmag musi liczyć zakres po próbkach ważnych i niepustych.
- ECharts jest inicjalizowany z rendererem SVG (`preview2D.ts:62-66`), mimo komentarza o Canvas; ten wybór nie jest właściwy dla dużych FDM/FEM.
- `resizeECharts` rejestruje listener, ale nie wywołuje `chartInstance.resize()` i nie usuwa listenera (`preview2D.ts:263-269`); to przykład lifecycle, którego nie wolno kopiować.

## 2. Docelowy interfejs zakładki 2D Fullmag

### 2.1. Układ powierzchni

```text
┌─────────────────────────────────────────────────────────────────┐
│ 2D View                                                        │
│ [Source: Default ▾] [Quantity ▾] [Component ▾] [Fit] [Export]  │
├─────────────────────────────────────────────────────────────────┤
│ [XY|XZ|YZ]  Position/Coordinate slider  [Plane|Slab ▾]         │  ← tylko Default
│ [Raster] [Contours] [Vectors] [Mesh] [Boundaries] [Probes]    │
├───────────────┬─────────────────────────────────────────────────┤
│               │                                                 │
│  colorbar      │    raster Canvas + overlay Canvas             │
│  min/max/unit  │    u/v axes, hover probe, pinned probe        │
│               │                                                 │
├───────────────┴─────────────────────────────────────────────────┤
│ status: source, operator, resolution, field/mesh revision      │
└─────────────────────────────────────────────────────────────────┘
```

W praktyce istniejący `FieldMapModule` już ma większość tej powierzchni: toolbar, osie, colorbar, statusy, diagnostykę i pinned probe (`apps/control-room/src/modules/field-map/FieldMapModule.tsx:370-459`). Przeniesienie interfejsu oznacza dopracowanie rozmieszczenia i semantyki kontrolek, nie utworzenie drugiego modułu.

### 2.2. Mapowanie kontrolek

| Kontrolka wzorowana na Amumax | Docelowy stan Fullmag | Źródło prawdy |
|---|---|---|
| Quantity dropdown | `planar.quantity_id` | `fieldCatalog` + `useVisualizationStateResource` |
| Component radio/dropdown | `planar.component` | capability ilości; `magnitude` dla skalaru |
| Z Layer | `planar.default_slice.plane` + `position_fraction` albo operator monitora | `DefaultPlanarSourceSection.tsx:44-162`; monitor Inspector |
| X/Y Data Points | `planar.resolution.width/height`, `quality`, `vector_budget` | `PlanarViewProfile` + `buildFieldMapDataPlan` |
| Min/Max | `planar.range` (`auto`, `manual`, `symmetric`) | `PlanarVisualizationSection.tsx:166-233` |
| Colormap | `planar.colormap` | tokenizowana lista palet |
| DataZoom | `planar.interaction.pan_u_m/pan_v_m/zoom` | `PlanarSurface` + `visualizationSync` |
| Tooltip | lokalna interpolacja próbek; pin `/probe` | `fieldMapProbe` + `usePlanarProbeResource` |
| Save as PNG | `field-map.export-png` przez typed client | `fieldMapExport.ts`, zasób `render.png` |
| Reset camera | `field-map.fit` / `field-map.reset-view` | `fieldMapCommands.ts` |

### 2.3. Źródło `Default` i monitor

- Otwarcie zakładki 2D nie tworzy draftu. Resolver ustawia `Default`, płaszczyznę `xy` i pozycję `0.5`.
- Dla `Default` Inspector pokazuje `XY/XZ/YZ`, suwak pozycji 0–100%, współrzędną SI oraz `plane_sample`/`slab_average` z grubością.
- Lista źródeł ma pierwszą opcję `Default`, a dalej autorskie monitory z nazwą i identyfikatorem.
- Po wyborze monitora kontrolki płaszczyzny/pozycji są zastępowane odczytem jego frame/extent/operatora; edycja odbywa się w dedykowanym Inspectorze monitora.
- Zmiana ilości, komponentu, zakresu i palety nie zmienia definicji monitora ani `ProblemIR`.

## 3. Decyzja biblioteczna

| Biblioteka Amumax | Rola w Amumax | Decyzja Fullmag | Uzasadnienie |
|---|---|---|---|
| `echarts@5.5.1` | heatmapa 2D, visualMap, tooltip, dataZoom, PNG | Nie dodawać; użyć istniejącego Canvas/worker dla pola. ECharts 6 pozostaje w `analysis-plots`. | Pole jest dużym buforem naukowym, a wymagany jest aktywny lifecycle, maska i osobne overlaye. ECharts można prototypować wyłącznie jako porównawczy spike, nie jako drugi właściciel rastera. |
| `three@0.171.0` | instanced arrows i TrackballControls w 3D | Nie przenosić do 2D. | Fullmag ma jeden dozwolony kontekst WebGL w `viewport-3d`. |
| `chart.js`, `chartjs-plugin-zoom` | obecne w zależnościach Amumax, niewykorzystane przez `preview2D` | Nie dodawać. | Brak dowodu użycia w wizualizacji 2D; zwiększałoby to powierzchnię zależności. |
| `flowbite-svelte` | dropdown, radio, button, slider | Nie przenosić. | Control Room używa wspólnych Radix/shadcn primitives i tokenów `--fm-*`. |
| `@msgpack/msgpack` + WebSocket | pełny `EngineState` | Nie przenosić kontraktu. | Fullmag wymaga resource-first API, rewizji, ETag i binarnego data plane; realtime jest tylko invalidation. |
| SvelteKit | składanie karty Preview | Nie przenosić frameworka. | Docelowy moduł jest React/Next i musi pozostać w rejestrze modułów v2. |

Wniosek: przejmujemy język interakcji i układ informacji, nie bibliotekę renderującą ani transport. Najmniejsza poprawna zależność dla zakładki 2D Fullmag to już obecny Canvas 2D, `Worker`, `ResizeObserver` i istniejące prymitywy UI.

## 4. Kontrakt danych Fullmag

### 4.1. Przepływ

```text
Inspector/Ribbon command
        │  typed patch
        ▼
visualization/state.planar ── revision invalidation ──► resource hooks
        │                                               │
        │                                               ├─ meta (JSON, frame/operator/revisions)
        │                                               ├─ scalar (binary)
        │                                               ├─ vectors (binary)
        │                                               ├─ empty-mask (binary)
        │                                               ├─ mesh-overlay (FMCS/FMFG)
        │                                               └─ probe (JSON, pinned)
        ▼
FieldMapRenderModel → PlanarSurface → Canvas base + overlay + DOM chrome
```

### 4.2. Zestaw zasobów i trasy

Dla `Default` używać rodziny `planar-default`, dla monitora rodziny `planar-monitors/{monitor_id}`. Aktualny kontrakt znajduje się w `docs/specs/resource-first-control-room-api-v2.md:358-453`, a klient w `apps/control-room/src/kernel/resources/planarFieldResources.ts:79-127,293-461`.

| Potrzeba interfejsu | Zasób | Wymagania |
|---|---|---|
| ilość, jednostka, osie, frame, operator | `.../meta` | sprawdzenie `sample_token`, carrier/field/mesh/scene revision i ETag |
| raster heatmapy | `.../scalar` | dekoder `decodeFieldVector`, rozmiar zgodny z meta |
| wektory i ich komponent normalny | `.../vectors` | ograniczony `vector_budget`; brak normalizacji zmieniającej jednostki |
| puste/aktywne próbki | `.../empty-mask` | maska wpływa na kolor, kontury, hover i extrema |
| siatka/obwód | `.../mesh-overlay` | FMCS v4 dla FEM, FMFG v1 dla strukturalnego FDM; boundaries FDM pozostają niedostępne |
| dokładny odczyt | `.../probe` | współrzędne świata `u_m/v_m`, wartość, occupancy, rewizje |
| eksport obrazu | `.../render.png` | kontrolowany eksport backendowy, nie zrzut SVG/DOM |

### 4.3. Zakresy i kolory

1. `auto`: backend/meta albo frontendowy model zakresu może pominąć `empty`, maskowane i nie-finite próbki.
2. `symmetric`: po znalezieniu maksimum normy ustawia `[-abs(max), +abs(max)]`; dla pustego pola stosuje deterministyczny zakres zero zgodny z kontraktem.
3. `manual`: `min < max`, wartości SI; `display_unit` przelicza wyłącznie etykiety i tooltip.
4. Paleta diverging jest wybierana semantycznie dla zakresu przechodzącego przez zero, ale nazwa palety i jej token pozostają częścią profilu.
5. `raster_opacity` dotyczy wyłącznie Canvas bazowego; overlaye, osie i colorbar nie mogą blednąć razem z rastrem.

## 5. Plan implementacji

### Zadanie 1: zamrożenie kontraktu i inwentaryzacja różnic

**Pliki:**

- Referencja: `external_solvers/amumax/frontend/src/lib/preview/preview2D.ts`, `Preview.svelte`, `inputs/*.svelte`.
- Referencja backendowa: `external_solvers/amumax/src/api/sec_preview.go`.
- Modyfikacja dokumentacji: ten plik oraz ewentualnie `docs/specs/frontend-v2/15-viewport-2d-module.md` tylko po zatwierdzeniu zmiany kontraktu.
- Test: `apps/control-room/src/modules/field-map/FieldMapModule.test.tsx`, `fieldMapDataPlan.test.ts`, `planarFieldResources.test.ts`.

**Interfejsy:**

- Wejście: istniejący `VisualizationStateResource.planar`, `PlanarFieldMetaResource`, `PlanarFieldQuery`.
- Wyjście: tabela zgodności kontrolka → patch/resource/test, bez nowego typu źródła i bez aliasu `layer` w API v2.

- [ ] **Krok 1:** zapisać w testach listę akcji, które musi obsłużyć zakładka: wybór ilości, komponentu, `Default`, monitora, płaszczyzny, pozycji, rozdzielczości, zakresu, palety, zoom/fit, probe, eksport.
- [ ] **Krok 2:** uruchomić testy modułu i zasobów, aby potwierdzić stan bazowy.

Uruchomienie:

```bash
pnpm --dir apps/control-room test -- src/modules/field-map/FieldMapModule.test.tsx src/kernel/resources/planarFieldResources.test.ts
```

Oczekiwany wynik: istniejące testy przechodzą; każda późniejsza zmiana interfejsu ma dołożyć test regresyjny do właściwej warstwy.

### Zadanie 2: panel Inspectora 2D zgodny z wzorcem Amumax

**Pliki:**

- Modyfikacja: `apps/control-room/src/modules/field-map/FieldMapModule.tsx` — pasywny toolbar metadanych, colorbar i akcje powierzchni; bez selektorów źródła/ilości/komponentu.
- Modyfikacja: `apps/control-room/src/modules/inspector/visualization/PlanarVisualizationSection.tsx` — kontrolki quantity/component/range/palette/layers.
- Modyfikacja: `apps/control-room/src/modules/inspector/visualization/DefaultPlanarSourceSection.tsx` — XY/XZ/YZ, pozycja, współrzędna i operator.
- Modyfikacja: `apps/control-room/src/modules/field-map/fieldMapCommands.ts` — `open`, `fit`, `reset-view`, `export-png`, przełączniki warstw.
- Styl: `apps/control-room/src/design/styles/field-map.css` — tylko klasy `fm-*`, tokeny i responsywność.
- Testy: `PlanarVisualizationSection.test.tsx`, `defaultPlanarSourceModel.test.ts`, `FieldMapModule.test.tsx`, `fieldMapCommands.test.ts`.

**Interfejsy:**

- `quantity_id` i `component` patchują `visualizationSync.queuePatch({ planar: ... })`.
- `Default` patchuje wyłącznie `default_slice`; monitor pozostaje wybranym `monitor_id`.
- Lista komponentów jest wyprowadzana z katalogu pól i capability, a nie zakodowana jako zawsze `3D/x/y/z`.

- [x] **Krok 1:** utrzymać selektor źródła w Inspectorze (pierwsza opcja `Default`, następnie monitory); nie dodawać selektora do powierzchni 2D.
- [ ] **Krok 2:** pokazać komponenty `x`, `y`, `z`, `u`, `v`, `normal`, `magnitude`, `in_plane_magnitude`, `orientation` tylko dla ilości, które je publikują.
- [ ] **Krok 3:** dla `Default` użyć istniejącego `DefaultPlanarSourceSection`; nie dodawać pola `layer` do stanu kanonicznego.
- [ ] **Krok 4:** dodać kontrolki `resolution`/`quality` oraz wyraźny komunikat, gdy FDM/FEM nie obsługuje danego scope/operatora.
- [ ] **Krok 5:** potwierdzić testami, że `Default` nie tworzy monitora, a wybór monitora nie gubi profilu prezentacji.

### Zadanie 3: renderer heatmapy i interakcje Amumax w istniejącym Canvas

**Pliki:**

- Modyfikacja: `apps/control-room/src/modules/field-map/renderer/PlanarSurface.tsx`.
- Modyfikacja: `apps/control-room/src/modules/field-map/renderer/planarRenderer.ts`.
- Modyfikacja: `apps/control-room/src/modules/field-map/renderer/planarInteraction.ts`.
- Modyfikacja: `apps/control-room/src/modules/field-map/model/fieldMapRenderModel.ts`.
- Ewentualny worker: `apps/control-room/src/modules/field-map/renderer/planarRendererWorker.ts` i `planarColorizer.ts`.
- Testy: `PlanarSurface.test.tsx`, `planarRenderer.test.ts`, `planarInteraction.test.ts`, `colorRaster.test.ts`, `planarColorizer.test.ts`.

**Interfejsy:**

- `createPlanarRenderer(canvas): PlanarRenderer` pozostaje jedynym właścicielem base canvas.
- `drawPlanarOverlays(context, width, height, layers)` pozostaje właścicielem overlaye.
- `FieldMapRenderModel` dostarcza `bounds`, `viewport`, `range`, `display`, `scalar`, `mask`, `vectors` i warstwy.

- [ ] **Krok 1:** utrzymać tworzenie renderera raz na mount, `ResizeObserver` na zmianę rozmiaru i `dispose()` na unmount.
- [ ] **Krok 2:** dopracować osie `u/v` i etykiety jednostek tak, aby dla `xy` były czytelne jako `x/y`, dla `xz` jako `x/z`, dla `yz` jako `y/z`, a dla arbitralnego monitora jako `u/v`.
- [ ] **Krok 3:** zapewnić cursor-anchored wheel/pinch zoom, drag pan, `0`/double-click fit, `+/-` zoom oraz klawisze strzałek zgodnie z istniejącym `PlanarSurface`.
- [ ] **Krok 4:** utrzymać worker dla colorizacji, konturów i przygotowania glyphów; do React nie przenosić dużych tablic.
- [ ] **Krok 5:** odwzorować ergonomię Amumax (`visualMap`, tooltip, save-as-image) w DOM/SVG chrome Fullmag, bez tworzenia SVG per próbka.
- [ ] **Krok 6:** dodać test, że opacity zmienia tylko raster, a overlaye i colorbar zachowują kontrast.

### Zadanie 4: zakresy, komponenty i parity FDM/FEM

**Pliki:**

- Modyfikacja: `apps/control-room/src/modules/field-map/model/fieldMapRenderModel.ts`.
- Modyfikacja: `apps/control-room/src/kernel/visualization/planarCapabilities.ts`.
- Modyfikacja: `apps/control-room/src/kernel/resources/planarFieldResources.ts` tylko w zakresie stabilnego resource identity.
- Backend kontraktu: istniejący `PlanarSamplingEngine` i zasoby opisane w `docs/physics/0970-planar-monitor-sampling-and-projection.md`; nie tworzyć browserowego samplera.
- Testy: `fieldMapRenderModel.test.ts`, `planarCapabilities.test.ts`, `planarFieldResources.test.ts`, testy samplerów FDM/FEM z planu monitora.

**Interfejsy:**

- `normalizePlanarColorRange(range)` nie może zwracać `pending`; do renderer przekazuje `null` albo terminalny zakres.
- `decodeFieldVector` dostarcza typed array z długością wynikającą z meta.
- Capability error codes pozostają wspólne dla Inspector i `field-map`.

- [ ] **Krok 1:** dodać regresję: pusty albo całkowicie zamaskowany raster ma deterministyczny zakres i nie generuje `NaN` w colorbarze.
- [ ] **Krok 2:** dodać regresję: zmiana `component` unieważnia scalar/vector resource przez canonical query identity, bez używania starego bufora.
- [ ] **Krok 3:** potwierdzić FDM `FMFG v1`: raster i mesh overlay mogą być widoczne, ale dokładne target boundaries pozostają wyłączone.
- [ ] **Krok 4:** potwierdzić FEM `FMCS v4`: `target_boundary` rozróżnia się od `mesh_interior`; nie deduplikować granic z floatów w przeglądarce.
- [ ] **Krok 5:** wykonać manufactured-field testy dla stałej, liniowej, wektorowej, occupancy i refinement invariance; osobno dla plane/slab/depth/surface.

### Zadanie 5: probe, diagnostyka i eksport

**Pliki:**

- Modyfikacja: `apps/control-room/src/modules/field-map/model/fieldMapProbe.ts`.
- Modyfikacja: `apps/control-room/src/modules/field-map/FieldMapModule.tsx` — hover/pinned state i tabela wyniku.
- Modyfikacja: `apps/control-room/src/modules/field-map/fieldMapExport.ts` oraz `fieldMapCommands.ts`.
- Testy: `fieldMapProbe.test.ts`, `fieldMapExport.test.ts`, `FieldMapModule.test.tsx`.

**Interfejsy:**

- Hover: `localProbe(u, v, bounds, resolution, values, mask)` działa lokalnie i jest throttled przez `requestAnimationFrame`.
- Pin: `usePlanarProbeResource(quantityId, source, buildFieldMapProbeQuery(...))` pobiera dokładną wartość backendową.
- Export PNG: komenda korzysta z `render.png` i zachowuje query/revision identity.

- [ ] **Krok 1:** renderować tooltip z wartością, jednostką, współrzędnymi `u/v` i statusem occupancy.
- [ ] **Krok 2:** po kliknięciu/Enter/Spacji przypinać probe i pokazywać wynik terminalny albo jednoznaczny błąd/stale status.
- [ ] **Krok 3:** eksportować PNG i dane z aktywnego źródła, ilości, komponentu, zakresu i frame; nie eksportować przypadkowego widoku DOM.
- [ ] **Krok 4:** dodać test braku danych: `No sample`, brak requestu probe i brak błędnego `0` jako wartości fizycznej.

### Zadanie 6: lifecycle, dostępność i aktywna powierzchnia

**Pliki:**

- Modyfikacja: `apps/control-room/src/modules/field-map/renderer/PlanarSurface.tsx`.
- Modyfikacja: `apps/control-room/src/kernel/resources/inactiveViewportResourcePolicy.ts` tylko jeśli test ujawni brak pauzy zasobów.
- Testy: `PlanarSurface.test.tsx`, testy tab hosta, `smoke:viewport-2d`, skrypt audytu pamięci powierzchni.

- [ ] **Krok 1:** zapewnić `role=img`, stabilne `aria-label`, focusable canvas tylko gdy probe jest włączony i komunikaty `role=status/alert`.
- [ ] **Krok 2:** przełączyć 100 razy `viewport-3d → field-map → viewport-3d` i potwierdzić brak rosnącej liczby workerów, listenerów, canvasów, RAF i object URL.
- [ ] **Krok 3:** po powrocie do 3D sprawdzić `gl.isContextLost() === false` i niezerowy drawing buffer.
- [ ] **Krok 4:** wykonać browser smoke z aktywną zakładką 2D, zmianą komponentu, zmianą płaszczyzny, hover/pin, zoom i eksportem PNG.

### Zadanie 7: dokumentacja, telemetryka i rollout

**Pliki:**

- Aktualizacja: `docs/specs/frontend-v2/15-viewport-2d-module.md` — tylko nowe, zweryfikowane zachowania interfejsu.
- Aktualizacja: `docs/adr/0020-planar-field-map-and-monitor.md` — jeśli zmiana jest decyzją architektoniczną, nie samym polish UI.
- Aktualizacja: `docs/status/2d-slice-capabilities.md` — status FDM/FEM i browser qualification.
- Test/komenda: `apps/control-room/scripts/smoke-viewport-2d.mjs`, `pnpm --dir apps/control-room typecheck`, `pnpm --dir apps/control-room lint`.

- [ ] **Krok 1:** opisać w statusie rozdział „Amumax parity” z linkiem do rewizji źródłowej i listą elementów przejętych/odrzuconych.
- [ ] **Krok 2:** dodać do browser evidence aktywne źródło, komponent, operator, zakres, checksum rastra, sample identity i liczbę glyphów.
- [ ] **Krok 3:** uruchomić pełny zestaw bramek: typecheck, lint, testy modułu, API hygiene, architecture hygiene i smoke 2D.
- [ ] **Krok 4:** wdrażać etapami: najpierw controls + `Default`, potem monitor, następnie overlay/probe/export, na końcu usunięcie kompatybilnych ścieżek legacy.

## 6. Kryteria akceptacji

### Interfejs

- Zakładka `2D View` otwiera się jednym kliknięciem i skrótem, bez wcześniejszego tworzenia monitora.
- Pierwsze źródło to `Default`; domyślna płaszczyzna to `XY`, a suwak pozycji zmienia współrzędną normalną.
- Lista quantity/component jest dynamiczna i nie pokazuje niedostępnych opcji jako działających.
- Przełączenie `Default ↔ monitor` nie zmienia ilości, zakresu ani profilu bardziej niż wynika to z kontraktu źródła.
- Widok ma czytelne osie, jednostki, colorbar, tooltip/pin, zoom/pan/fit, warstwy i eksport.

### Dane i fizyka

- FDM oraz FEM przechodzą manufactured-field i refinement tests dla wszystkich wspieranych operatorów.
- Każdy raster ma zgodne `sample_token`, rewizje i rozmiar z meta; stare odpowiedzi nie mogą nadpisać nowego widoku.
- `min/max` nie pozostaje w stanie `pending` po terminalnym błędzie ani dla pustej maski.
- Nie ma niejawnego fallbacku FEM→FDM, node-count averaging ani normalizacji zmieniającej jednostki.
- FDM `FMFG v1` nie jest prezentowany jako dokładna granica targetu; FEM `FMCS v4` zachowuje klasy segmentów.

### Lifecycle i wydajność

- Jedna instancja renderera na mount, jeden worker colorizacji, brak idle redraw.
- Przełączanie 3D/2D nie zostawia aktywnych resource hooks ciężkiej powierzchni ani WebGL contextów.
- Dla 2048² próbek tablice pozostają poza React state, a komunikacja używa bounded binary resources.
- 100 przełączeń nie zwiększa trwale liczby workerów/listenerów/canvasów ani użycia pamięci poza ustalonym limitem.

## 7. Elementy, których nie przenosić

1. SvelteKit/Flowbite i style `#282a36`/`#6e9bcb` jako osobny system wizualny.
2. `PreviewState` jako globalny, mutable singleton z pełnym polem w każdym komunikacie.
3. Endpointy POST `/api/preview/component`, `/layer`, `/XChosenSize` i ręczne `broadcastEngineState`.
4. SVG-owy ECharts heatmap jako drugi renderer obok istniejącego Canvas.
5. Przekrój tylko po `z` jako model monitora dla FEM.
6. Wyliczanie `min/max` z pierwszej komórki przed maskowaniem i traktowanie braku danych jak zera fizycznego.
7. `normalizeVectors` bez ochrony przed zerową normą.
8. `resizeECharts` bez `resize()` i bez teardown listenera.

## 8. Ryzyka i sposób ich zamknięcia

| Ryzyko | Objaw | Zamknięcie |
|---|---|---|
| Skojarzenie `layer` z monitorem | UI pokazuje warstwę, ale operator jest inny | Wymusić `DefaultPlanarSourceSection` i osobne pola monitora; test round-trip. |
| `pending` w colorbarze | komponent zmieniony, ale min/max nie nadchodzi | Resource state rozdziela `loading`, `ready`, `stale`, `error`; renderer dopuszcza tylko zakres terminalny. |
| Drugi renderer ECharts | wzrost pamięci i niespójny zoom | Pozostać przy `PlanarSurface`; ECharts tylko dla `analysis-plots`. |
| FDM/FEM różne jednostki | tooltip i eksport różnią się od 3D | `canonical_unit` w meta, display transform w profilu, test jednostek dla obu backendów. |
| Stare zasoby po zmianie komponentu | raster wygląda jak poprzedni komponent | canonical query + ETag + sample token + test odrzucenia stale. |
| Przeciążenie wektorami | zbyt wiele glyphów i spadek FPS | `vector_budget`, worker preparation, browser budget gate. |

## 9. Kolejność wdrożenia i rollback

1. Kontrakt i testy bez zmiany UX.
2. Kontrolki `Default`, quantity/component/range/palette.
3. Płaszczyzny XY/XZ/YZ i pozycja normalna.
4. Przeniesienie ergonomii heatmapy: osie, colorbar, tooltip, zoom/fit.
5. Monitor autorski, operator grubości/projekcji i lista źródeł.
6. Wektory, kontury, mesh/boundary, probe i eksport.
7. Browser/lifecycle qualification i aktualizacja statusu.

Rollback może ukryć nową kontrolkę albo przywrócić kompatybilny zasób PNG, ale nie może usuwać monitorów, zmieniać `ProblemIR`, przywracać node averaging ani tworzyć osobnego modułu `viewport-2d`.

## 10. Weryfikacja końcowa

Minimalny zestaw poleceń po implementacji:

```bash
pnpm --dir apps/control-room test -- src/modules/field-map src/modules/inspector/visualization src/kernel/resources/planarFieldResources.test.ts
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room check:api-hygiene
pnpm --dir apps/control-room check:architecture-hygiene
pnpm --dir apps/control-room smoke:viewport-2d
git diff --check
```

Wynik uznaje się za gotowy dopiero, gdy testy źródłowe, managed FDM/FEM, API/resource identity, browser smoke i audyt lifecycle są zielone. Sam poprawny wygląd heatmapy albo przejście TypeScriptu nie jest dowodem parity.

## Stan po refaktorze wykonanym 2026-08-17

Zrealizowano i zweryfikowano lokalnie:

- jeden imperatywny renderer Canvas 2D oraz jeden worker pozostają właścicielami powierzchni; aktualizacja bufora nie remountuje renderera;
- hover Amumax-style ma lokalny odczyt `u`, `v`, wartości i dashed axis-pointer w overlay Canvas;
- wheel, drag, fit, klawisze `+/-`/strzałki oraz pinch zoom pozostają zakotwiczone w przestrzeni fizycznej;
- wszystkie selektory `Source`/`Quantity`/`Component`/`Plane` są jawnie własnością Inspectora i mają regresję przeciw duplikacji w `FieldMapModule`;
- pusty, zamaskowany lub niefinitywny raster kończy się zakresem `{min: 0, max: 0}`, a dowód `ready` odrzuca nie-finitywne extrema;
- po zmianie komponentu klucz zasobu i bufor scalar są rozdzielone, bez ponownego użycia starego ETag;
- colorbar 2D ma strukturę i tokenizowany styl zgodny z legendą 3D (`quantity`, `component`, `display unit`, `Rendered range`, `min/max`, ramp).

Dowód testowy dla powyższego zakresu: 10 plików Vitest, 113 testów przechodzących; osobny test rendererów po poprawce tokenu koloru: 12/12. Pełny typecheck, lint całej aplikacji i browser smoke wymagają osobnej bramki, ponieważ bieżący współdzielony checkout zawiera niezależne, niekompilujące zmiany w `viewport-3d`, Inspectorze i zasobach.
