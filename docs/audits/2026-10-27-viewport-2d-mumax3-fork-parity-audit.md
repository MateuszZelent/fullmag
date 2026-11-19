# Audyt widoku 2D: stan względem forka MuMax3 (`external_solvers/3`)

Data: 2026-10-27
Rewizja fullmag: `457277c47` (master)
Rewizja referencji: `external_solvers/3` @ `984c6e9d` (fork MateuszZelent, frontend SvelteKit; zgodna z pinem submodułu)
Charakter: audyt źródłowy (kod + dokumenty). Nie uruchamiano testów, buildu ani runtime.

Oznaczenia: **[V]** zweryfikowane w kodzie, **[H]** hipoteza z krokiem weryfikacji.

## 1. Werdykt

1. Widok 2D Fullmag (`field-map`) jest **jedną wspólną ścieżką dla FDM i FEM**: frontend,
   endpointy `planar-default`/`planar-monitors`, formaty binarne i `PlanarSamplingEngine`
   są wspólne. Różnice FDM/FEM leżą w adapterach próbkowania, zakresach (scope),
   overlayu siatki i odrzucanych typach elementów — oraz w **nieużywanym starym stosie**
   `samples/slice`, który wygląda jak osobna implementacja per metoda. [V]
2. Najbardziej prawdopodobna przyczyna, że widok „nie działa”: **ilość wybrana w 2D nie
   jest zgłaszana do runtime jako zapotrzebowanie obserwacyjne**. Runtime materializuje
   tylko `quantity.active_quantity_id` (3D) i ilości widocznych targetów 3D. Oczekiwany
   wynik: `m` działa (pochodzi z `live_state.magnetization`), a `H_demag`, `Edens_*` itd.
   wybrane wyłącznie w 2D nie odświeżają się albo kończą się
   `404 quantity_not_materialized`. Działają tylko wtedy, gdy przypadkiem są też aktywną
   ilością 3D. [V w API, efekt runtime H — potwierdza macierz §7]
3. Model interakcji różni się istotnie od forka: Fullmag ma ciągłą pozycję
   (`position_fraction`) zamiast indeksu warstwy, domyślny raster 128×128 niezależny od
   siatki, próbkowanie „najbliższa komórka” zamiast uśredniania powierzchniowego,
   wszystkie kontrolki wyłącznie w Inspectorze i transport „invalidacja WS → kilka
   żądań HTTP → próbkowanie CPU” zamiast pushu gotowej klatki.
4. Plan przeniesienia z 2026-08-17 (`docs/superpowers/plans/2026-08-17-amumax-2d-interface-transfer.md`)
   mierzył się z `amumax @03c9bf1` i wprost stwierdza, że `external_solvers/3` *nie jest*
   wzorcem. Od 2026-10-27 submoduł wskazuje fork MuMax3 użytkownika, a kilka „ograniczeń, których nie
   kopiować” z tego planu **jest w forku już usuniętych** (patrz §3). Ten plan wymaga
   aktualizacji referencji.
5. Brak ważnego dowodu runtime/przeglądarki dla obecnego HEAD. Ostatni smoke
   `viewport-2d-default-slice` (FDM CPU, 2026-08-19) zakończył się `exit code 1`, ale
   log kończy się hydration mismatch wywołanym rozszerzeniem przeglądarki
   (`ext-megabonus-*`), więc **nie jest dowodem awarii 2D** — jest po prostu brakiem
   dowodu.

## 2. Referencja: jak działa 2D w forku

| Element | Implementacja w forku |
|---|---|
| Stan | Jeden serwerowy `PreviewState` (`webui/sec_preview.go`): quantity, component, `plane` (xy/yz/xz), `sliceIndex` per oś, `allLayers` (średnia), rozmiary U/V, `maxPoints`, autoscale. |
| Sterowanie | `POST preview/section {plane, mode: single|average, sliceIndex}` (atomowo), `preview/planeResolution {uSize,vSize}`, `preview/quantity`, `preview/component`, `preview/maxpoints` (`webui/sec_preview_plane.go:75-141`). |
| Przechwycenie | `engine.InjectAndWait` na wątku solvera — działa także w stanie bezczynnym, bez czekania na krok (`sec_preview.go:287-322`). |
| Próbkowanie | GPU `cuda.ResizePreviewPlane(dst, comp, u, v, layer)`; `layer=-1` = średnia arytmetyczna po wszystkich warstwach; downsampling uśrednianiem powierzchni. |
| Budżet | Presety rozmiaru = dzielniki `N_u`, `N_v`; domyślnie najbliższy dzielnik do `min(N, 100)` na oś, `preview/fullResolution` ustawia siatkę natywną (`sec_preview.go:863-866`, `:1029`); `resolvePreviewSizing` przycina do `maxPoints`/hard limit i publikuje `AutoDownscaleMessage`. |
| Maska | Geometria próbkowana tą samą płaszczyzną/redukcją; zakres min/max liczony po komórkach zajętych i skończonych; `InvalidCount` (`sec_preview.go:672-745`). |
| Transport | Push msgpack przez WebSocket z `sequence`, `captureMs`, `processMs`. |
| Renderer | ECharts heatmap, renderer `canvas`, `useDirtyRect`, progresywny >16384 pkt, `dataZoom` (okno u/v), tooltip z nm i numerem warstwy, `saveAsImage`, autoscale/fit aspect (`frontend/src/lib/preview/preview2D.ts`). |
| UI | Nad powierzchnią: wybór płaszczyzny (ikony cięcia), `Single layer / Average`, suwak warstwy z nm, przełącznik komponentu, 2D/3D, popout/fullscreen (`Preview.svelte:386-460`). |

## 3. Plan z 2026-08-17 a obecny fork

Ograniczenia, które plan opisał jako cechy wzorca (amumax) i zakazał kopiować, a które
w forku **już nie występują**:

- brak XZ/YZ → fork ma `xy/yz/xz` + `sliceIndex` per oś;
- renderer SVG → fork używa `canvas` + `useDirtyRect`;
- `resizeECharts` bez `resize()` → fork ma poprawny `ResizeObserver` i `resize()`;
- min/max inicjalizowane przed maską → fork liczy po maskowaniu (`hasValue`);
- przechwycenie tylko w pętli solvera → fork robi `InjectAndWait`, także w idle.

Wniosek: tabela „Mapa interfejsu” i sekcja 1.3 planu nie odpowiadają obecnej referencji.

## 4. Stan Fullmag — co jest zrobione

### 4.1 Frontend (`apps/control-room/src/modules/field-map`, ~8,3 tys. linii z testami) [V]

- `FieldMapModule.tsx`: jedna ścieżka dla FDM/FEM. Zasoby `meta → scalar/mask/vectors/mesh-overlay/probe`
  przez `kernel/resources/planarFieldResources.ts`; kanoniczne zapytanie z rewizjami
  (`expected_*_revision`, 409 przy niezgodności).
- Renderer Canvas 2D + Web Worker (`renderer/planarRenderer.ts`, `PlanarSurface.tsx`),
  osie kartezjańskie (`model/planarAxisModel.ts`), colorbar, kontury (marching squares),
  wektory, overlay siatki, maska, pin probe, eksport PNG, retencja ostatniej klatki
  przy odświeżeniu (`useRetainedPlanarFrame`).
- Inspector (`modules/inspector/visualization/`): źródło `Default`/monitor, ilość,
  komponent, płaszczyzna XY/XZ/YZ, suwak `Position` (frakcja 0–1) + współrzędna w m,
  `Plane sample`/`Slab average` + grubość, paleta, jednostka, zakres
  auto/manual/symmetric, krycie, jakość, rozdzielczość 16–2048, gęstość wektorów.

### 4.2 Backend (`crates/fullmag-api/src`) [V]

- Trasy: `router_v2/mod.rs:688-740`, handler `router_v2/handlers/data/planar_fields.rs`;
  rodziny `…/fields/{q}/planar-default/*` i `…/planar-monitors/{id}/*`.
- Wspólne typy: `ResolvedSpatialField`, `TargetField::{Fdm,Fem}`,
  `ResolvedPlanarSampleRequest`, `PlanarSampleResult`, payload `field-vector` v2, maska u8.
- **FDM** (`planar_sampling/fdm.rs`): CPU, w procesie API.
  - `plane_sample` = wartość jednej komórki pod środkiem piksela (`fdm.rs:259-304`).
  - Slab/depth = ważenie objętością przecięcia (`fdm.rs:306-417`).
  - Surface → 422.
  - Pozycja snapowana do środka komórki (`planar_sampling/source.rs:85`).
- **FEM** (`planar_sampling/fem.rs`): CPU.
  - Tet4 barycentrycznie, Prism6 izoparametrycznie (Newton).
  - Slab/depth przez obcięte objętości; surface tylko `ObjectBoundary`.
  - Dokładny przekrój siatki `fmcs.v4`.
  - Pyramid5/Hex8 i wartości per element → 422 (`target.rs:339`, `target.rs:741-778`).
- Odświeżanie: WS `/v2/sessions/current/events/ws` wysyła **invalidacje**, frontend
  ponownie pobiera zasoby HTTP z ETag (`kernel/realtime/RealtimeInvalidationBridge.ts:534-620`).

## 5. Tabela parity: fork vs Fullmag

| Funkcja | Fork | Fullmag FDM | Fullmag FEM | Luka |
|---|---|---|---|---|
| Wybór płaszczyzny XY/YZ/XZ | tak, nad powierzchnią | tak, Inspector | tak, Inspector | położenie kontrolek (decyzja §8) |
| Dyskretna warstwa (`sliceIndex`, „layer N”, nm) | tak | **nie** — ciągła frakcja, cicho snapowana do środka komórki | n/d (ciągła jest poprawna) | brak selektora warstwy i odczytu użytej warstwy |
| Średnia po całej grubości | `Average` (arytmetyczna, zera wliczone) | tylko `Slab average` z ręczną grubością (domyślnie 1 nm), ważona objętością | j.w. | brak skrótu „cała grubość”; semantyka inna (świadomie) |
| Rozdzielczość powiązana z siatką | presety-dzielniki N, domyślnie ≈min(N,100), przycisk „Full resolution” | domyślnie 128×128 niezależnie od siatki, dowolna liczba 16–2048 | 128×128 | brak presetów-dzielników i trybu „native grid” dla FDM |
| Downsampling | uśrednianie powierzchniowe na GPU | najbliższa komórka → aliasing przy rastrze < siatki | interpolacja punktowa | brak area-average dla `plane_sample` |
| Budżet `maxPoints` + komunikat auto-downscale | tak | limit 1 048 576 pkt, bez komunikatu | j.w. | brak komunikatu „zredukowano z A do B” |
| Maska geometrii, `InvalidCount` | tak | maska tak; licznik invalid nie | maska tak | drobne |
| Katalog ilości (`Edens_*`, `geom`, `regions`, mapy materiałowe) | pełny | sampler obsługuje `H_*`, `Edens_*`, `mat_*`, ale runtime ich nie dostarcza dla 2D (§6.1) | `Edens_*` tylko z projekcją nodalną; `Cell` → 422 | P0 |
| Przełączanie ilości w idle | natychmiast (`InjectAndWait`) | tylko dla ilości w `observation_quantities` (2D nie dodaje swojej) | j.w. | P0 |
| Odświeżanie live | push klatki WS | invalidacja + 3–5 żądań HTTP + ponowne próbkowanie CPU | j.w., bez indeksu przestrzennego | wydajność |
| Tooltip (u, v w nm, warstwa, wartość) | tak | hover + pin probe (backend `/probe`) | tak | brak numeru warstwy |
| Zoom/okno u/v | `dataZoom` + presety okna | pan/zoom (`planarInteraction`) | tak | OK |
| Eksport PNG | `saveAsImage` | `render.png` (backend, **zawsze viridis**) + eksport | j.w. | PNG ignoruje paletę/zakres |
| Kontury, wektory, overlay siatki, probe | wektory w 3D | tak | tak (dokładny przekrój) | Fullmag bogatszy |
| Multilayer FDM | n/d | backend ma `scope_kind=layer`, frontend go nigdy nie wysyła | n/d | P1 |
| Airbox / mesh part | n/d | frontend blokuje FDM airbox (`kernel/visualization/planarCapabilities.ts:23`), backend ma `FdmAirboxCells` | obsługiwane | P1 |
| FDM GPU | natywnie | sampler CPU po kopii D→H; status `not_qualified` | sampler CPU | kwalifikacja |

## 6. Ustalenia szczegółowe

### 6.1 [P0] Ilość 2D nie trafia do zapotrzebowania runtime

- `observation_quantities_for_visualization_state`
  (`crates/fullmag-api/src/router_v2/handlers/visualization/display.rs:2407-2428`) zbiera
  `visualization.quantity.active_quantity_id` oraz ilości widocznych targetów 3D.
  **`visualization.planar.quantity_id` nie jest dodawane.** [V]
- W idle `fullmag-cli/src/interactive_runtime_host.rs:1192-1225` materializuje w pełnej
  rozdzielczości wyłącznie `observation_quantities`
  (`full_field_materialization_request`). [V]
- W trakcie runu zapotrzebowanie obserwacyjne obsługuje jawnie
  `fullmag-runner/src/fdm/gpu/cuda/live_observations.rs:351-404` (FDM CUDA). [V]
- [H] Dla FDM CPU i FEM w trakcie runu nie znaleziono równoważnego schedulera; do
  sprawdzenia, skąd te linie publikują inne ilości niż display.
- Brak materializacji na żądanie: ani handler planar (`planar_fields.rs:600-613` zwraca
  `quantity_not_materialized`), ani frontend (`fieldMapRenderModel.ts:365` pokazuje tylko
  „not materialized”) nie zlecają policzenia brakującego pola. [V]
- [H] Rewizja zapotrzebowania: `patch_visualization_state` (`display.rs:292-352`) przelicza
  demand przez `synchronize_observation_quantities`, która używa
  `set_observation_quantities` **bez podbicia rewizji** i zakłada, że patch już ją podbił.
  Patch zmieniający wyłącznie `planar.*` może nie podbić `selection.revision`, a wtedy
  runtime (`ObservationDemand.revision`) może zignorować nową listę. Po samym dodaniu
  `planar.quantity_id` do listy trzeba to sprawdzić.
- Weryfikacja: sesja FDM, 2D z `H_demag`, 3D z `m` → oczekiwane 404/stale; po
  poprawce → świeży raster w idle i podczas runu.

### 6.2 [P1/H] Klatki display są przycinane, a sampler wymaga pełnej domeny

- `field_value_count_matches_current_domain` (`router_v2/handlers/data/field_resolution.rs:27-85`)
  akceptuje tylko pola o liczbie punktów pełnej siatki FDM (albo natywnej multilayer). [V]
- Klatka display z runnera niesie wyłącznie `selection.quantity` (aktywną ilość 3D) i ma
  domyślnie `max_points: 16_384` z auto-downscale (`fullmag-runner/src/types.rs:2251-2270`);
  viewport 3D może wysyłać własne `max_points`. [V]
- Skutek dotyczy więc tylko **ilości aktywnej w 3D**, w trakcie runu, na liniach bez
  schedulera obserwacji (FDM CPU, FEM — [H]). Dla siatek większych niż budżet klatka
  display nie przechodzi bramki i 2D tej ilości pokazuje ostatnią materializację. Mała
  siatka **nie ratuje** ilości wybranej tylko w 2D — ta zależy wyłącznie od §6.1.
- Weryfikacja: macierz reprodukcji z §7.

### 6.3 [P1] FDM: ciągła pozycja zamiast warstwy

- UI: suwak `Position` 0–1 i pole `Coordinate (m)`
  (`DefaultPlanarSourceSection.tsx:112-131`).
- Backend snapuje do `origin + (idx+0.5)·dx` (`planar_sampling/source.rs:85`).
- Użytkownik nie widzi numeru warstwy ani faktycznie użytej współrzędnej (to samo
  ustalenie co P1-01 w audycie 2026-08-31 — nadal otwarte).

### 6.4 [P1] FDM: aliasing i domyślna rozdzielczość

- `plane_sample` bierze jedną komórkę na piksel.
- Przy domyślnym 128×128 i siatce np. 512×128 traci się 3/4 kolumn bez uśredniania.
- Fork domyślnie pokazuje siatkę natywną, a redukuje uśrednianiem.

### 6.5 [P1] Zakresy niedostępne z UI

- Multilayer (`layer`) nie jest wysyłany przez frontend.
- FDM airbox i `mesh_part` są blokowane na froncie mimo carrierów w backendzie.

### 6.6 [P2] Spójność i dług

- `render.png` ignoruje paletę i zakres (`planar_fields.rs:966-991`).
- `vector_budget` jest tylko walidowany i nie wchodzi w tożsamość próbki.
- Stary stos `samples/slice` i `projection/*` (`field_slice.rs`, `fem_slice.rs`,
  `fields.rs` `build_slice_matrix`) jest zarejestrowany (`router_v2/mod.rs:744-786`), ale
  nikt go nie używa. To on daje wrażenie „zupełnie innej implementacji FDM i FEM”.
- FEM: brak indeksu przestrzennego w `fem.rs` (liniowy `interpolate_at`), a Pyramid5/Hex8
  są odrzucane (pełna siatka SP4 nie przejdzie).

### 6.7 Dokumentacja nieaktualna

- `docs/status/2d-slice-capabilities.md`:
  - „Depth projection yes” — tylko dla monitora autorskiego, nie dla `Default`;
  - „FDM surface: not applicable in fixture” — w kodzie zawsze 422;
  - dowody runtime z lipca są historyczne.
- `docs/specs/frontend-v2/15-viewport-2d-module.md`:
  - twierdzi, że field-map czyta zasoby slice/projection — czyta tylko `planar-*`;
  - twierdzi, że PNG zawiera styl — jest zawsze viridis.
- Plan 2026-08-17: zła referencja (§3).

## 7. Macierz reprodukcji do wykonania

Dla każdej komórki zapisać: raster/404/stale. Przewidywanie:

- `m` działa zawsze;
- ilość wybrana **tylko w 2D** nie odświeża się nigdy (§6.1);
- ilość aktywna także w 3D działa w `awaiting_command`; w trakcie runu na liniach bez
  schedulera obserwacji tylko dla siatek ≤ budżetu `max_points` (§6.2).

| Lane | Siatka | Ilość 2D | Ilość 3D | Przewidywanie: w trakcie runu | Przewidywanie: `awaiting_command` |
|---|---|---|---|---|---|
| FDM CPU | 64×64×1 | `H_demag` | `m` | stale/404 | stale/404 |
| FDM CPU | 512×256×4 | `H_demag` | `m` | stale/404 | stale/404 |
| FDM CPU | 64×64×1 | `H_demag` | `H_demag` | działa | działa |
| FDM CPU | 512×256×4 | `H_demag` | `H_demag` | stale (§6.2, H) | działa |
| FDM CUDA | 512×256×4 | `Edens_total` | `m` | stale/404 | stale/404 |
| FDM CUDA | 512×256×4 | `Edens_total` | `Edens_total` | działa (scheduler) | działa |
| FEM CPU | Tet4 | `H_demag` | `m` | stale/404 | stale/404 |
| FEM CPU | Tet4 | `Edens_demag` | `Edens_demag` | ? (projekcja nodalna) | ? |
| FDM multilayer | 2 warstwy | `m` | `m` | ? (brak scope `layer`) | ? |

## 8. Decyzja do podjęcia przez właściciela projektu

Plan 2026-08-17 ustalił: **wszystkie kontrolki wyłącznie w Inspectorze**, powierzchnia 2D
bez selektorów. Fork ma plane picker, `Single/Average` i suwak warstwy **nad
powierzchnią**. Jeżeli celem jest UX „jak w forku MuMax3”, trzeba świadomie zmienić tę
decyzję (np. cienki pasek sekcji nad Canvasem zsynchronizowany z tym samym
`visualization/state.planar`).

## 9. Lista prac (kolejność wg wpływu/kosztu)

| # | Zadanie | Zakres | Weryfikacja |
|---|---|---|---|
| 1 | Dodać `planar.quantity_id` do `observation_quantities_for_visualization_state`. Serwer nie zna aktywnej zakładki (to stan layoutu frontendu), więc bramką może być tylko `planar.visible`; to materializuje ilość także wtedy, gdy 2D nie jest na ekranie. Alternatywa: frontend zgłasza aktywność `field-map` w stanie wizualizacji. | `display.rs` + test | zmiana samej ilości 2D podbija rewizję demand (§6.1); macierz §7 wiersze 1, 2, 5, 7 |
| 2 | Ustalić ścieżkę live dla FDM CPU i FEM (czy honorują `observation_quantities` w trakcie runu); dodać, jeśli brak | runner | macierz §7, kolumna „w trakcie runu” |
| 3 | Uruchomić macierz §7 na Docker DEV i zapisać receipt | runtime/browser | raport w `docs/audits` |
| 4 | FDM: tryb warstwy — `slice_index` w `default_slice` (lub odczyt snapu w `meta`), suwak warstwy z nm i numerem, tooltip z warstwą | IR stanu + Inspector + `source.rs` | test kontraktu + smoke |
| 5 | FDM: rozdzielczość „native grid” jako domyślna + area-average w `plane_sample` przy rastrze < siatki; presety-dzielniki | `fdm.rs`, Inspector | manufactured field, brak aliasingu |
| 6 | Skrót „Average (full thickness)” = slab o grubości całej domeny | Inspector/`default_slice` | porównanie z `Average` forka |
| 7 | Komunikat auto-downscale i `invalid_count` w `meta` | API + legenda | test modelu |
| 8 | Odblokować `layer` (multilayer) i FDM airbox na froncie | `planarCapabilities.ts`, `planarViewScopeForSelection` | smoke multilayer |
| 9 | Decyzja §8; ewentualny pasek sekcji nad Canvasem | field-map | browser smoke |
| 10 | `render.png` z paletą/zakresem; `vector_budget` w tożsamości lub serwerowa decymacja | API | test PNG |
| 11 | Usunąć nieużywany stos `samples/slice`/`projection` lub oznaczyć jako deprecated | API + OpenAPI | api hygiene |
| 12 | Wydajność: push klatki lub złączenie meta+scalar+mask, indeks przestrzenny FEM, ewentualnie sampler GPU dla FDM CUDA | API/runner | pomiar latencji przełączenia |
| 13 | Zaktualizować plan 2026-08-17 (referencja = fork), status 2D i spec 15 | docs | — |

## 10. Stan realizacji (2026-10-27, branch `codex/viewport-2d-mumax-parity-20261027`)

Decyzje użytkownika: pasek sekcji nad Canvasem — **tak**; uśrednianie powierzchniowe
FDM `plane_sample` — **tak**.

| # | Zadanie | Stan | Zmiana |
|---|---|---|---|
| 1 | Ilość 2D w zapotrzebowaniu runtime | zrobione | `display.rs`: `planar_requests_spatial_observation` (bramka `planar.visible` i raster/kontury/wektory); hipoteza o braku podbicia rewizji obalona — `apply_display_patch_to_state` zawsze podbija rewizję |
| 2 | Ścieżka live FDM CPU / FEM | zrobione dla runtime interaktywnego CPU | `interactive_runtime.rs`: ilości z `observation_quantities` trafiają do `cached_preview_fields`, dla siatki FDM w pełnej rozdzielczości (`full_resolution_preview_request`); FDM CUDA miał już własny scheduler |
| 3 | Macierz §7 na Docker DEV | patrz §11 | — |
| 4 | Warstwa FDM | zrobione bez zmiany kontraktu | `planarSectionModel.ts`: indeks ↔ frakcja zgodne ze snapem backendu; suwak warstwy z nm i numerem w Inspectorze i pasku |
| 5 | Siatka natywna + area-average | zrobione | `fdm.rs` `fdm_cell_area_plane` (nota 0970, PM-N06), presety „Native grid / 1/k” w Inspectorze, `PLANAR_SAMPLER_VERSION = planar_sampling_v3` |
| 6 | Średnia po pełnej grubości | zrobione | slab o grubości `2 × extent` (pokrywa domenę z każdego przyciągniętego środka) |
| 7 | Komunikat auto-downscale, `invalid_count` | nie dotyczy / pominięte | serwer nie zmniejsza rastra (limit 1 048 576 pkt zwraca błąd), więc komunikat nie ma źródła; `invalid_count` pozostaje do zrobienia |
| 8 | `layer` i FDM Airbox | zrobione | `PlanarViewScopeState::Layer`, mapowanie selekcji `fdm-domain`/`layer`, FDM blokuje już tylko `mesh_part`, FEM blokuje `layer` |
| 9 | Pasek sekcji nad Canvasem | zrobione | `PlanarSectionStrip.tsx`, widoczny także w stanach ładowania/błędu |
| 10 | `render.png` z paletą i zakresem | częściowo | paleta i zakres ze stanu sesji, osobny ETag; backend zna tylko viridis/gray/coolwarm |
| 11 | Usunięcie starego stosu `samples/slice` | nie zrobione | wymaga osobnej decyzji (publiczne trasy API v2) |
| 12 | Push klatek, indeks przestrzenny FEM, sampler GPU | nie zrobione | osobny projekt wydajnościowy |
| 13 | Dokumentacja | zrobione | status 2D, spec 15, plan 2026-08-17, nota 0970 |
