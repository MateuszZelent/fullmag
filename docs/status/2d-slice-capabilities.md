# 2D Slice Capabilities

Ten status rozróżnia implementację, wykonanie zarządzane, dowód przeglądarkowy
i walidację naukową dla kanonicznej powierzchni `field-map`. Raporty z lipca
2026 są **historycznym punktem odniesienia**, a nie dowodem aktualnego `HEAD`.
Aktualny smoke wymaga zgodności telemetryki aktualnego żądania z wyrenderowanym
rastrem, zanim może zapisać `pass: true`.

| Feature | FDM CPU | FEM CPU | FEM GPU run | Evidence status |
|---|---|---|---|---|
| Session `Default` source: XY/XZ/YZ plane sample | implemented, source-tested | implemented, source-tested | implemented, source-tested; runtime pending | managed science/browser qualification not yet available on current HEAD |
| Session `Default` source: slab average | implemented, source-tested | implemented, source-tested | implemented, source-tested; runtime pending | managed science/browser qualification not yet available on current HEAD |
| Plane heatmap and probe | yes | yes | yes | historycznie validated; wymaga świeżego smoke HEAD |
| Slab average | yes | yes | yes | historycznie validated; wymaga świeżego smoke HEAD |
| Depth projection (tylko monitor autorski) | yes | yes | yes | historycznie validated; wymaga świeżego smoke HEAD |
| Surface projection | unsupported (422) | yes | yes | historycznie validated dla FEM; wymaga świeżego smoke HEAD |
| Magnetic vectors | yes | yes | yes | historycznie browser verified; wymaga świeżego smoke HEAD |
| Contours and masked holes | yes | yes | yes | focused model tested |
| Mesh overlay | structured outline | exact FEM section | exact FEM section | historycznie browser verified; wymaga świeżego smoke HEAD |
| PNG export | yes | yes | yes | contract tested |
| 3D frame preview | yes | yes | yes | historycznie browser verified; wymaga świeżego smoke HEAD |

## Parity z forkiem MuMax3 (2026-10-27)

Wzorzec: `external_solvers/3` @ `984c6e9d`. Szczegóły i luki:
`docs/audits/2026-10-27-viewport-2d-mumax3-fork-parity-audit.md`.

| Element | Stan | Dowód |
|---|---|---|
| Ilość wybrana w 2D w zapotrzebowaniu runtime (`observation_quantities`) | implemented | test API `observation_demand_includes_visible_planar_quantity_only` (napisany, nieuruchomiony: zakaz kompilacji testów) |
| Pełnorozdzielcze pola obserwowane w trakcie runu FDM CPU / FEM CPU | implemented | testy runnera (nie uruchomione lokalnie) |
| FDM `plane_sample` jako średnia powierzchniowa (`fdm_cell_area_plane`) | implemented | nota 0970 PM-N15, testy samplera (napisane, nieuruchomione) |
| Pasek sekcji nad powierzchnią: płaszczyzna, `Single layer / Average`, warstwa FDM | implemented, browser smoke | vitest `PlanarSectionStrip`, `planarSectionModel` (napisane, nieuruchomione); smoke 2026-10-27 niżej |
| Inspector: dyskretna warstwa FDM, średnia po pełnej grubości | implemented | vitest `PlanarVisualizationSection` (napisane, nieuruchomione) |
| Presety rozdzielczości siatki natywnej FDM | implemented | vitest `planarSectionModel` (napisane, nieuruchomione) |
| Zakres `layer` (multilayer FDM) i odblokowany FDM Airbox | implemented | vitest `fieldMapDataPlan`, `VisualizationViewContext` (napisane, nieuruchomione) |
| `render.png` z paletą i zakresem sesji | implemented (palety backendu: viridis, gray, coolwarm; inne → viridis) | — |
| Push klatek 2D przez WebSocket, sampler GPU | not implemented | — |

## Etap F1 planu `viewport-2d-mumax-parity-2026-10-27` (2026-10-27)

Dowody: produkcyjny typecheck i ESLint `apps/control-room` w kontenerze
frontendu grupy `fullmag-worktree-viewport-2d-production-20261027-…` (exit 0);
backend skompilowany w kontenerze `backend` tej grupy; codegen OpenAPI z
receiptem; smoke przeglądarkowy (Playwright 1.62.1, Chromium 1234 headless,
fixture `examples/viewport_2d_mumax_parity_fdm_smoke.py`, FDM CPU double,
128×128×2): otwarcie 2D klawiszem `2` → gotowa klatka w 0,3 s, krok warstwy
`[`/`]` w ~20 ms bez placeholdera, składowa `z`, 98 glifów ze strzałkami,
powrót do 3D z `isContextLost=false` i niezerowym buforem, 0 błędów konsoli i
strony. Smoke jest sesyjny (nie jest receptą repozytorium) i nie jest
kwalifikacją produkcyjną. Testy jednostkowe są napisane, ale nieuruchomione
(zakaz kompilacji testów).

| Element | FDM CPU | FEM | Dowód |
|---|---|---|---|
| Pasek kontrolek nad mapą (wielkość, składowa, sekcja, strzałki, siatka) | browser smoke | source | smoke 2026-10-27 |
| Koło barw mumax3 (`hsl_direction`) w 2D, 3D i `render.png` | browser smoke | source | smoke; zrzut z ciemnymi strzałkami |
| Strzałki na siatce ekranowej z grotami, min. długość, ⊙/⊗ | browser smoke | source | smoke (98 glifów) |
| Retencja klatki przy kroku warstwy, odczyt `showing … · loading …` | browser smoke | source | smoke (`placeholderSeen=false`) |
| Proporcje fizyczne u:v (kontener rozmiaru) | browser smoke | source | zrzut: dysk okrągły |
| `meta.section` (żądane/rozwiązane, indeks warstwy) i Inspector | implemented | implemented | testy Rust napisane; codegen OK |
| Skróty `[ ] { } V X Y Z M A G`, `fit`, `reset-view`, `export-data` | browser smoke (`[ ] z a v`) | source | smoke |
| Inspector `Live` tylko po dowodzie klatki | implemented | implemented | typecheck |

## Etapy F2–F4 (2026-10-28)

Zmiany skompilowane w kontenerze `backend` grupy DEV; codegen OpenAPI z
receiptem; typecheck i ESLint frontendu zielone. Testy jednostkowe Rust i
vitest napisane, nieuruchomione (zakaz kompilacji testów).

| Element | FDM CPU | FEM CPU/GPU | Dowód |
|---|---|---|---|
| Cache operatora płaszczyzny FEM (wagi kształtu per piksel, gather przy nowej rewizji) | n/d | compiled | `planar_sampling/operator.rs`; test `planar_fem_plane_operator_cache_matches_direct_sampling_and_builds_once` (nieuruchomiony) |
| Single-flight próbek, `spawn_blocking`, fence epoki sesji przed wpisem do cache | runtime (smoke FDM 2026-10-27 po zmianie) | compiled | smoke FDM run8 PASS |
| Sonda: ewaluacja punktowa, statusy `occupied/outside/empty` bez clampu | runtime | compiled | `curl …/probe`: `outside`, `occupied` (wektor, `cell_id`), `empty` na sesji FDM |
| Ekstrema meta tylko z pikseli zajętych | runtime | compiled | — |
| Hex8 (trilinearny) i Pyramid5 (wymierny) z odwrotnością Newtona | n/d | compiled | testy PM-N18 napisane; **PM-N19: formuła identyczna z `mfem::LinearPyramidFiniteElement::CalcShape`** (`fem/fe/fe_fixed_order.cpp`, toolchain FullmagK0Native; różni się tylko tolerancja apeksu: 1e-6 w MFEM, 1e-12 tutaj) |
| Slab/depth z kwadraturą elementową dla Prism6/Hex8/Pyramid5 (N-09) | n/d | compiled | test PM-N20 (`q = x·y·z` na sześcianie → 1/8) napisany |
| Tolerancje względne w nakładce i współrzędnych barycentrycznych FEM | n/d | compiled | — |
| Przystanki warstw FEM z certyfikatu swept (`fem_node_planes`, `layer_stops_m`) i suwak/`[ ]` na płaszczyznach węzłów | n/d | compiled + frontend | test Rust `default_section_snaps_fem_requests_to_certificate_node_planes`, vitest „FEM node-plane stops” (nieuruchomione) |
| Krok nawigacji ciągłej sekcji FEM h⊥ = mediana rozciągłości przeciętych elementów (`navigation_step_kind=median_element_height`, `cut_element_count`), odczyt „N elements cut” | n/d | runtime FEM CPU + browser smoke (2026-10-28) | grupa DEV `viewport-2d-fem-layers-20261028`, fixture `examples/viewport_quantity_coloring_fem_cpu_smoke.py` (Tet4, film 20 nm): h⊥ = 20 nm, `cut_element_count` 252/225/224 dla z = 0/−8/9,6 nm, poza filmem `extent_fraction`; odczyt „252 elements cut”, `[` przesuwa o 20 nm; nota 0970 `eq-planar-navigation-step`, PM-N23 (unqualified); testy Rust i vitest napisane, nieuruchomione |
| Capability zakresu Airbox w Inspectorze dopiero po meta backendu; błąd meta podaje dokładny kod (P1-04) | source | source | vitest `fieldMapCapabilities` (napisany, nieuruchomiony) |
| Zakres `region` (`scope_kind=region`, `scope_id` = obiekt, `scope_region_id`), selekcja regionu → `view_scope.region`, sonda w zakresie regionu | runtime FDM CPU (2026-10-28) | compiled | grupa `viewport-2d-region-scope-20261028`: mapa `m_x` w zakresie `film:r2` ma tylko −1 (280 komórek), cel monitora ma [−1, 0]; sonda: `occupied` w regionie, `empty` poza nim; brak regionu → 422 `empty_target`, brak `scope_region_id` → 400, `scope_region_id` przy innym zakresie → 400. Testy Rust/vitest napisane, nieuruchomione |
| Warstwy nazwane z obiektów (slab o grubości obiektu, środek bez snapu FDM/węzłów) | runtime FDM CPU + przeglądarka | source | wybór „film” → `film · z ∈ [−4.00 nm, 4.00 nm] · slab`; stan `slab_average 8 nm`, rozwiązane z = 0 (wcześniej snap do −2 nm); nota 0970, PM-N24 (unqualified) |
| **Znany błąd (poza 2D):** kształt regionu przesunięty `translate` jest realizowany w środku obiektu (FDM: `film:r2` przesunięty o +32 nm zajmuje środek; FEM: konforemne meshowanie zgłasza nakładanie rozsuniętych regionów) | — | — | IR regionu ma poprawne `center`; do zgłoszenia osobno. Kryterium „dwa regiony o różnych polach” sprawdzone testem jednostkowym; fixture `examples/viewport_2d_region_scope_smoke.py` w wersji wyśrodkowanej nieaktywowany (`live_retirement_busy`) |
| Budżety D2D-12 po poprawce (2026-10-28, ta sama sesja FDM GPU 128×128×2, headless SwiftShader, build dev) | krok warstwy ciepły P50 0,35 s / P95 0,45 s (było 0,94 / 1,02 s); przełączenie składowej P50 0,42 s (było 1,05 s), nadal 3 żądania; sterta +9,4 MiB / 40 cykli 2D↔3D z wymuszonym GC (~0,24 MiB/cykl, było 0,86) | — | przyczyny: 600 ms debounce kolejki patchy dla kontrolek tożsamości próbki (teraz `flushNow`), współdzielona geometria `Sprite` three.js trzymająca listener każdego renderera oraz refy domknięć R3F (zwalniane przy odmontowaniu); pozostaje: kliencka derywacja składowej (0 żądań), burza koloryzacji, warstwa w URL meta / prefetch |
| Profil liniowy (F6 B1): `GET …/planar-{default|monitors/:id}/profile`, punkty równomierne + przecięcia ze ścianami elementów FEM, Shift+przeciągnięcie, wykres i eksport | runtime FEM (sesja `cofeb_ring_strayfield_demo`) + przeglądarka | compiled | 890 punktów (378 `element_face`), 0 błędów strony, `Esc` czyści; nota 0970 PM-N25 (unqualified); testy Rust i vitest napisane, nieuruchomione |
| Smoke repozytorium `apps/control-room/scripts/smoke-viewport-2d.mjs` (tryb `default`) | slice domyślny xy/xz/yz, slab, monitor autorski PASS; **pamięć FAIL** | — | skrypt naprawiony: zakładki „2D View”/„3D Viewport”, snap FDM `eq-planar-default-layer`, oczekiwanie na klatkę żądanej sekcji (retencja); wyciek ~0,86 MiB/cykl 2D↔3D przy wymuszonym GC |
| Zakres `region`, PM-N24 | runtime FDM CPU | — | `film:r1` m_x = +1 (320 komórek), `film:r2` m_x = −1 (280), cel 600 |
| Środowisko: run w worktree | — | — | `FULLMAG_SCRIPT_OUTPUT_DIRECTORY=examples` wymaga zapisu grupy do `examples`; w nowym worktree katalog ma 755 i run kończy się „project storage preparation failed … Permission denied” przed solverem (`chmod g+w examples` w worktree) |
| FDM GPU (F5) | runtime + przeglądarka (2026-10-28) | — | fixture vortex 128×128×2 z `gpu`: run `completed`, `requested_device=gpu`, `resolved_device=gpu` (`explicit_device_request`), meta 2D `field_device=gpu`; 0 błędów strony |
| Budżety D2D-12 (pomiar sesyjny, headless Chromium + SwiftShader, FDM GPU 128×128×2) | krok warstwy zimny P50 3,3 s (n=2), ciepły P50 0,94 s / P95 1,02 s; przełączenie składowej P50 1,05 s i **3 żądania planarne na przełączenie**; pan/zoom 0 żądań; sterta +0,86 MiB/cykl 2D↔3D | — | **FAIL** względem 30/80 ms, „0 żądań, < 16 ms” i „< 30 MB / 100 przełączeń”; czasy zawyżone przez SwiftShader, liczby żądań i wzrost sterty nie zależą od rasteryzacji |
| Nawigator migawek (F6 B4): ‹ › / odtwarzanie / Live dla migawek `m` etapu histerezy | source + typecheck (2026-10-28) | — | **runtime BLOCKED**: master odrzuca aktywację etapu histerezy (`study pipeline primitive stage 'hysteresis' is not yet executable by the runtime`); vitest napisany, nieuruchomiony lokalnie |
| Gizmo płaszczyzny monitora w 3D (F6 B5): przesunięcie wzdłuż normalnej, pierścienie obrotu, Shift+[ / ], pick-from-face | przeglądarka (2026-10-28) | — | przeciągnięcie uchwytu: `Origin Z` 5 → 32,88 nm; Shift+]: obrót o 5° wokół u; pierścień: n = (0, −0,582, 0,813); pick-from-face: początek na ścianie (z = 10 nm), n = (0, 0, 1); 0 błędów; `docs/diagnostics/viewport-2d-level-b-b4-b6-2026-10-28/` |
| BVH dla lokalizacji punktów i operatora płaszczyzny FEM (F6 B6) | runtime FEM CPU (2026-10-28) | compiled | profil 2121 punktów w 42 ms; 61 punktów profilu bitowo równych sondzie (PM-N28); operator płaszczyzny A/B: 12/12 przekrojów identycznych; 164k Tet4: 168/168 pikseli równych sondzie, czas 419 vs 380 ms bez przyspieszenia; 2,26M Tet4: 168/168 równych sondzie, 0 zgubionych, 11,6 s/płaszczyznę z indeksem, bez porównania (PM-N17); testy Rust napisane, nieuruchomione; gather GPU BLOCKED |
| Multislice (F6 B2): 2–4 panele źródła Default z `position_fraction`, wspólna paleta i zakres | runtime FDM CPU + przeglądarka (2026-10-28) | — | PM-N27: panele XY (z = −2/−2/+2 nm) i XZ (y = −130/−2/+126 nm) równe pojedynczemu przekrojowi (współrzędna i raster bitowo), tokeny różne, monitor z `position_fraction` → 400; przeglądarka: przycisk Slices, 2/3/4 panele, proporcje u:v zachowane, 0 błędów; dowody `docs/diagnostics/viewport-2d-multislice-2026-10-28/`; vitest i testy Rust nieuruchomione lokalnie |
| Streamlines w płaszczyźnie (F6 B3): warstwa `streamlines`, RK4 na dwuliniowym polu kierunku, rozsiew Jobard–Lefer, worker | runtime FDM CPU + przeglądarka (2026-10-28) | — | wir 128×128×2 (stan początkowy), `vector_budget` 256: 7 linii, `truncated=false`, linie styczne do strzałek, 0 błędów strony; zrzuty i porównanie z mumax3 w `docs/diagnostics/viewport-2d-mumax3-parity-2026-10-28/`; sprawdzenie algorytmu poza przeglądarką: wir 18 okręgów, rozrzut promienia 0,001 px, 17 ms dla 128²; nota 0970 PM-N26 (unqualified); vitest napisane, nieuruchomione lokalnie |
| Kliencka derywacja składowych x/y/z/|v| i koniec burzy koloryzacji (D2D-12) | runtime FDM CPU + przeglądarka (2026-10-28) | — | przełączenie składowej: **0 żądań planarnych** (było 3) i 1 wiadomość do workera (było 3–13), 120–560 ms pod SwiftShader w buildzie dev; wartości równe backendowi (x, y: ±0,9999489887009642; |v| w granicy 1 ulp); tryb kliencki tylko dla `plane_sample` trójskładnikowej, nietensorowej wielkości ze źródła Default; tożsamość narysowanej klatki zawiera składową, więc `ready` nie zgłasza starego rastra; nota 0970 § Vector reduction and components |
| Smoke przeglądarkowy FEM CPU | — | **session smoke PASS** (2026-10-28) | osobna grupa DEV `viewport-2d-fem-smoke-20261028` (checkout `ce1d587ff`; od gałęzi różni się tylko importami testów runnera, więc runtime jest ten sam), fixture `examples/viewport_2d_fem_mixed_smoke.py` (Prism6 ×3 warstwy + powłoka Pyramid5 + powietrze Tet4, CPU double; ścieżka mieszana przyjmuje 1–3 warstwy, więc fixture ma 3). Playwright 1.62.1 + Chromium 1234 headless: 2D otwiera się, 4 przystanki `fem_node_planes` [−4,5; −1,5; 1,5; 4,5] nm, krok `]` bez placeholdera, składowa `z`, 25 strzałek, WebGL zdrowy po powrocie do 3D, 0 błędów konsoli. Smoke wykrył dwa błędy frontendu (wieczne „loading” dla żądania między płaszczyznami; krok `]` z pozycji między płaszczyznami pomijał płaszczyznę), naprawione i sprawdzone ponownie: 0 → 1,5 → 4,5 → 1,5 → −1,5 → −4,5 nm. Pierwsze wejście na nową płaszczyznę (budowa operatora) do ~3,8 s pod SwiftShader; budżety D2D-12 niezmierzone. Grupa zadania nadal zablokowana: aktywacja `7a668d411d4a4ec9ae7e1aa8854149c1` `outcome-unknown-resources-retained` (HTTP 409) oraz odmowa podłączenia runtime po restarcie bez launchera |
| Smoke przeglądarkowy FEM GPU, FDM GPU | — | NOT VERIFIED | brak przebiegu na torze GPU |

## Status Language

Use these messages consistently:

- `Requires FEM explicit topology` for FEM-only mesh and airbox controls on unsupported domains.
- `No airbox mesh part in current domain` when FEM topology exists but has no airbox part.
- `Using local fallback` or `mesh: local fallback after backend error` when backend mesh overlay cannot be used.
- `Not implemented E2E yet` for contour, primitives, and airbox vectors;
  slab sampling is implemented in the shared sampler but still needs fresh
  managed/browser evidence on the current HEAD.
- `Default` is a session-resolved source, not an authored monitor; it is not
  added to `SceneDocument`, `ProblemIR`, canonical Python, or Explorer.
- `source-tested` means the contract, resolver, transport, or UI behavior was
  exercised locally. It is not a managed-runtime or production qualification.
- FDM GPU remains `not_qualified`: the required managed launcher and an
  executed device/carrier proof do not exist, so no green status is inherited
  from FDM CPU.

## Historyczne evidence zarządzane (2026-07-18)

- `fdm-cpu`: science and browser reports pass; requested/resolved `fdm/cpu`; 100 switches; 61,594,483-byte heap growth.
- `fem-cpu`: science and browser reports pass; requested/resolved `fem/cpu`; 100 switches; 7,936,018-byte heap growth.
- `fem-gpu`: science and browser reports pass; requested `cuda` (GPU alias), resolved `fem/gpu`; 100 switches; 7,457,770-byte heap growth.
- Cross-backend manufactured linear-field relative RMS is about `1.19e-3` for both FEM lanes.

Raporty i screenshoty są pod `.fullmag/reports/viewport-2d-planar-monitor-smoke/`,
ale nie kwalifikują aktualnego `HEAD`. Planar sampling jest obecnie jawnym CPU
postprocessorem nawet, gdy symulacja rozwiązuje się na FEM GPU; raport ma to
rejestrować zamiast sugerować sampler rezydujący na urządzeniu.

## Baseline authored-monitor smoke contract (2026-08-12)

- Smoke `viewport-2d-browser-smoke-v2` publikuje monitor ID, operator kind,
  quantity/component, `meta.etag` jako tymczasową sample identity,
  field revision, status, checksum/range rastra oraz liczby glyph/contour/mesh.
- `pass: true` jest dozwolone wyłącznie, gdy każdy obserwowany raster jest
  `ready` i jego identity oraz field revision zgadzają się z odpowiedzią
  `meta` zużytą przez przeglądarkę.
- Fixture do kolejnego świeżego uruchomienia: compact FEM
  `examples/viewport_2d_planar_monitor_fem_compact_smoke.py` i multi-object
  FDM `examples/viewport_2d_planar_monitor_fdm_multi_object_smoke.py`.
- To nie jest managed-runtime qualification; wymagane jest osobne uruchomienie
  repozytoryjnej receptury `just` po jej przełączeniu na te fixture.

## Default planar source implementation (2026-08-16)

- `visualization/state.planar` now has typed `source` and `default_slice`
  state. A fresh session resolves `Default`, `xy`, and `position_fraction=0.5`;
  selecting 2D does not list monitors, create a draft, or mutate the model.
- The `planar-default` data family uses the same backend planar sampler as an
  authored monitor and publishes source-aware meta, identity, frame, operator,
  and canonical child links.
- The Inspector exposes `Default`/authored monitor selection, XY/XZ/YZ,
  position fraction, resolved coordinate, and plane/slab sampling controls.
- Local evidence currently includes the validator suite, focused frontend/API
  tests, typecheck, and API/architecture hygiene. The managed recipe and
  browser/science reports for the current HEAD remain pending because the
  managed native runtime storage is full; no lane is `production-qualified`.

## Release Policy

Powyższe authored-monitor lane'y są zaimplementowane, lecz ich browser/science
status z lipca pozostaje historyczny do czasu świeżego dowodu. Airbox-specific
field availability nadal wynika z kanonicznego quantity catalog, a nie z samej
widocznej geometrii airboxa. Scena bez monitorów otwiera teraz sesyjny `Default`
po przygotowaniu domeny; nie tworzy niezatwierdzonego draftu i nie wymaga Apply.
Utworzenie trwałego monitora pozostaje wyłącznie jawną akcją authoringową.
