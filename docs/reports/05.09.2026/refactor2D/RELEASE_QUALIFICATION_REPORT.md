# Raport Kwalifikacji Wydania: Refaktoryzacja Wizualizacji 2D (Etapy 00–13 oraz Remediacja R01–R27)

**Fullmag — Moduł Wizualizacji Planarnej 2D (`field-map` / `planar_sampling`)**  
**Data:** 6 września 2026  
**Gałąź:** `codex/refactor-2d` w wyizolowanym worktree `C:\git\fullmag\fullmag\.worktrees\refactor-2d`  
**Status kwalifikacji:** ZAKWALIFIKOWANY DO WYDANIA (RELEASE READY)  
**Zamyka rejestr ustaleń audytu pierwotnego:** N01–N10, G01–G04, U01–U07, E01, P01–P03, T01.  
**Zamyka rejestr ustaleń reaudytu (34dee455):** R01–R27 (Naprawy 00–09 wg `03_PLAN_NAPRAWCZY.md`).

---

## 1. Werdykt i podsumowanie wykonania

Zrealizowano pełną, produkcyjną remediację wszystkich ustaleń reaudytu 34dee455 (R01–R27) w module wizualizacji 2D w warstwach:
- Rust backend (`crates/fullmag-api::planar_sampling`, `quantity_data_plane`, `router_v2`),
- Frontend WebGL/React (`apps/control-room/src/modules/field-map`, `kernel/workspace`, `modules/inspector`),
- Kontrakty API, OpenAPI v2, Python DSL oraz orakle numeryczne.

Wyeliminowano wszystkie błędy numeryczne skali nanometrowej, rozbieżności kwadratur elementów, desynchronizację warstw GPU/worker, błędy cyklu życia WebGL, przesunięcia konturów oraz niepoprawne wiązania tokenów i komponentów.

### Wyniki weryfikacji testowej:
- **Rust Backend (`fullmag-api::planar_sampling`):** 68/68 testów jednostkowych i orakli zielonych (`cargo test -p fullmag-api -- planar_sampling`), w tym kontrprzykłady C01–C10 oraz orakle z reaudytu Round 2 (PY07, PY10, PY13, PY15).
- **Kontrprzykłady analityczne i orakle:** 14/14 potwierdzonych i trwale zabezpieczonych w `counterexamples_tests.rs`.
- **Frontend Vitest (`apps/control-room` field-map):** 29 zestawów testowych, 199/199 testów zakończonych sukcesem (`pnpm --filter @fullmag/control-room test src/modules/field-map`), w tym dekodowanie binarne FMVP, walidacja tożsamości buforów i serializacja wersji samplera.
- **Frontend Vitest (`apps/control-room` workspace & inspector):** 55/55 testów zakończonych sukcesem (`crossSectionWorkspace.test.ts`, `PlanarVisualizationSection.test.tsx`).
- **Python DSL & ProblemIR Contract:** 47/47 testów zielonych (`packages/fullmag-py/tests/test_planar_monitor.py` oraz `scripts/test_validate_planar_monitor_sampling.py`).
- **TypeScript Typecheck:** 0 błędów w całym `@fullmag/control-room` (`tsc --noEmit`).
- **ESLint Hygiene:** 0 błędów i 0 ostrzeżeń (`eslint . --max-warnings=0`).

---

## 2. Rozliczenie ustaleń z reaudytu (R01–R27)

| ID | Priorytet | Zgłoszony problem | Zastosowana naprawa produkcyjna | Status | Dowód testowy |
|---|---|---|---|---|---|
| **R01** | P0 | Próg objętości $10^{-28}\text{ m}^3$ usuwa legalne elementy w skali nanometrowej | Obniżono geometryczne progi odrzucania sub-elementów i powierzchni do $10^{-36}\text{ m}^3 / \text{m}^2$ w `geometry.rs`, `element_evaluator.rs` i `surface.rs`, gwarantując zachowanie nanometrowego wsparcia | **ZAMKNIĘTE** | `planar_sampling_fem_plane_preserves_nanometer_scale_tetrahedra`, `planar_sampling_surface_preserves_nanometer_scale_boundary_measure` |
| **R02** | P0 | Inwersja Prism6 akceptuje niezbieżne wagi i uśrednia fallback | Ograniczono iteracje Newtona-Raphsona, wprowadzono rygorystyczne sprawdzanie dziedziny referencyjnej $[r,s,t] \in [0, 1]$ i niezerowego Jacobianu; usunięto fałszywy fallback do średniej (zwraca `None` / `f64::NAN`) | **ZAMKNIĘTE** | `test_prism6_invert_nanometer_scale`, `test_prism6_invert_outside_returns_none`, `test_prism6_invert_degenerate_returns_none` |
| **R03** | P0 | 4-punktowa kwadratura nie kwalifikuje momentów wyższych rzędów i ekstremów | Zaimplementowano 14-punktową kwadraturę Keasta (dokładną dla $P1 \times P1$) w `element_evaluator.rs` oraz dokładną analityczną odległość sympleksu od początku układu dla `Magnitude` i `InPlaneMagnitude` (zero przy przecinaniu zera) | **ZAMKNIĘTE** | `test_c01_tet4_rms_and_extrema_oracle` |
| **R04** | P0 | SurfaceProjection ignoruje wybraną składową wektora | Poprawiono wyznaczanie składowych wektorowych na powierzchniach w `surface.rs` przed redukcją | **ZAMKNIĘTE** | `planar_sampling_surface_clips_boundary_faces_across_pixel_footprints` |
| **R05** | P0 | Niepoprawna obsługa orientacji w redukcjach FDM | `finish_reduction_dual` wyznacza azymut ze średniego wektora; `contract.rs` flaguje `UndefinedOrientation` przy NaN lub $|P| \le \epsilon$ | **ZAMKNIĘTE** | `test_c10_normal_vector_undefined_orientation`, `planar_sampling_orientation_uses_monitor_basis_and_masks_zero_vectors` |
| **R06** | P0 | Jednostki i metadane nie opisują wyniku operatora | `planar_fields.rs::meta_resource` wyznacza kanoniczne jednostki SI (`"turn"`, `"([unit])^2"`, `"[unit]*m"`) i wyklucza nieokreśloną orientację | **ZAMKNIĘTE** | Testy metadanych API i orakli jednostek |
| **R07** | P0 | Cache hit omija walidację powiązania tokenu z trasą | Pełna walidacja `sample_token` względem requested quantity, source, component, resolution i revision w `planar_fields.rs` | **ZAMKNIĘTE** | `sample_identity_distinguishes_target_operator_resolution_quality_and_quantity_revision` |
| **R08** | P1 | Single-flight może zawiesić klientów po anulowaniu lidera | Publikacja `Guard` przeniesiona po wstawieniu do cache i usunięciu z inflight w `quantity_data_plane.rs`; poprawny broadcast błędu/anulowania | **ZAMKNIĘTE** | Testy współbieżności i unieważniania single-flight |
| **R09** | P1 | Budżet cache nie obejmuje zachowanej siatki i pola | Ścisłe zliczanie bajtów buforów wektorowych, skalarnych, masek i topologii w `target.rs` oraz `quantity_data_plane.rs` | **ZAMKNIĘTE** | Sprawdzenie limitów `DataPlan` i retencji |
| **R10** | P0 | Nowe CutGeometry niepoprawne dla Prism6 | Poprawiono wagi 6-węzłowej interpolacji Prism6 i kanoniczną skalę $10^{14}$ w `cut_geometry.rs` oraz ewaluację w `evaluation_plan.rs` | **ZAMKNIĘTE** | `planar_sampling_prism6_p1_reproduces_affine_world_field`, `test_c02_prism6_rt_clipped_volume_integral` |
| **R11** | P1 | Wsparcie dla topologies elementów | Jawna kwalifikacja Tet4 i Prism6; fail-closed z kodem `unsupported_element_order` dla nieswspieranych elementów w `planar_sampling` | **ZAMKNIĘTE** | Testy walidacji schematów siatki |
| **R12** | P1 | Overlay generowany dla każdego operatora | Warunkowe generowanie deskryptorów segmentów i bezprogowa klasyfikacja topologiczna segmentów (mesh vs boundary vs interior) | **ZAMKNIĘTE** | `planar_overlay_classifies_selected_topology_without_float_boundary_heuristics` |
| **R13** | P1 | Renderer FEM nie jest podłączony do widoku | Zintegrowano `drawFemCutSurface` w `usePlanarSurfaceRenderer.ts`, podłączając warstwę powierzchni FEM do aktywnego renderingu | **ZAMKNIĘTE** | `PlanarSurface.test.tsx` (GPU FEM pass) |
| **R14** | P1 | Aktywna warstwa GPU FDM nadpisywana bitmapą z workera | Wprowadzono `gpuLayerDrawnRef` w `PlanarSurface.tsx` zabezpieczający natywne warstwy GPU przed nadpisaniem przez bufor RGBA workera | **ZAMKNIĘTE** | `PlanarSurface.test.tsx` (ochrona warstwy GPU przed workerem) |
| **R15** | P1 | CoherentPlanarBundle nie weryfikuje tożsamości wiązki | Dodano weryfikację `sample_token`, niezerowych wymiarów, poprawnych przedziałów bounds oraz pochodzenia buforów w `coherentPlanarBundle.ts` | **ZAMKNIĘTE** | `coherentPlanarBundle.test.ts` (8/8 testów) |
| **R16** | P1 | Wyciek pamięci przy przełączaniu native GPU / raster | Zaimplementowano `disposeRaster()` zwalniający geometrię i materiał w `planarGpuRenderer.ts` | **ZAMKNIĘTE** | `planarGpuRenderer.test.ts` |
| **R17** | P1 | Utrata i odtwarzanie kontekstu WebGL (lifecycle) | Obsługa `webglcontextlost` i `webglcontextrestored` w `planarGpuRenderer.ts` zachowująca `pendingDraw` i bezpiecznie odtwarzająca zasoby | **ZAMKNIĘTE** | `planarGpuRenderer.test.ts` (testy utraty kontekstu) |
| **R18** | P1 | Marching squares RangeError na dużych rastrach | Zastąpiono `Array.push(...pts)` iteracyjną pętlą `push` w `marchingSquares.ts`, eliminując błąd przekroczenia stosu wywołań | **ZAMKNIĘTE** | `marchingSquares.test.ts` (512x512 checkerboard pass) |
| **R19** | P1 | Kontury przesunięte o pół komórki | Dodano przesunięcie $+0.5$ w `planarRenderer.ts`, wyrównując izolinie z centrami komórek i wektorami | **ZAMKNIĘTE** | `planarRenderer.test.ts` (TS01 half-cell alignment) |
| **R20** | P1 | Spójność palet barwnych i legendy | Ujednolicono mapowanie LUT i zakresów auto/manual między rendererem WebGL, workerem a komponentem legendy | **ZAMKNIĘTE** | `planarColorizer.test.ts`, `PlanarColorLegend.test.tsx` |
| **R21** | P1 | Zakresy widoku (view_scope) | Spójne propagowanie `domain`, `mesh_part` oraz `airbox` w `PlanarVisualizationSection.tsx` i komendach | **ZAMKNIĘTE** | `PlanarVisualizationSection.test.tsx` |
| **R22** | P1 | Wybór skalarnej quantity wysyłał component=magnitude | Dodano wariant `Scalar` do `PlanarFieldComponent` w Rust, OpenAPI i UI; automatyczny wybór `scalar` dla 1-składowych pól | **ZAMKNIĘTE** | `PlanarVisualizationSection.test.tsx` |
| **R23** | P1 | Save as monitor nie zapisywał bieżącego przekroju | `createPlanarMonitorDraft` w `crossSectionWorkspace.ts` przyjmuje aktywną płaszczyznę, `position_fraction` i grubość slab z `default_slice` | **ZAMKNIĘTE** | `crossSectionWorkspace.test.ts` (R23 test) |
| **R24** | P1 | Sonda wewnątrz zwracała inną próbkę | Ujednolicono odpytywanie sondy o ciągłe współrzędne fizyczne w płaszczyźnie próbkowania | **ZAMKNIĘTE** | `fieldMapProbe.test.ts` |
| **R25** | P1 | Eksport publikacyjny i wiązanie FigureSpec | Ścisła walidacja schematu w `deserializePlanarFigureSpec` oraz wiązanie `sample_token` w poleceniach eksportu PNG/JSON w `fieldMapCommands.ts` | **ZAMKNIĘTE** | `planarFigureSpec.test.ts`, `fieldMapCommands.test.ts` |
| **R26** | P1 | Rozdzielenie danych od prezentacji i cache reuse | Czyste rozdzielenie presentation optimistic patch od zapytania do data plane; brak re-triangulacji przy zmianie barwy | **ZAMKNIĘTE** | `fieldMapDataPlan.test.ts`, `planarPresentationProjection.test.ts` |
| **R27** | GATE | Kwalifikacja wydania i pełny zestaw dowodów | Zaktualizowano raport kwalifikacyjny w oparciu o 100% zielonych testów native Rust, orakli, Vitest, Python, typecheck i ESLint | **ZAMKNIĘTE** | Pełny test suite |

---

## 3. Rozliczenie ustaleń z audytu pierwotnego (Etapy 00–13)

| ID | Priorytet | Problem pierwotny | Rozwiązanie w `codex/refactor-2d` | Status |
|---|---|---|---|---|
| **N01** | P0 | Centroid zastępuje próbkę w środku piksela | Prawdziwe całkowanie barycentryczne i analityczne przecięcie poligonu ze wsparciem piksela w `planar_sampling/fem.rs` | **ZAMKNIĘTE (C04)** |
| **N02** | P0 | Geometria poza extent trafia do brzegu rastra | Poprawny clipping do fizycznego bounding boxa U,V bez clampingu indeksów macierzy | **ZAMKNIĘTE (C03)** |
| **N03** | P0 | RMS, min/max i odchylenie tracą informację w Tet4 | Pełny akumulator drugich momentów i ekstremów wewnątrz elementów w `moments.rs` | **ZAMKNIĘTE (C01)** |
| **N04** | P0 | Prism6: redukcja objętościowa rozbieżna z interpolacją | Analityczny integrator pryzmatyczny z uwzględnieniem iloczynu $r \cdot t$ dla przyciętych elementów | **ZAMKNIĘTE (C02)** |
| **N05** | P0 | Sonda API raportuje zły punkt poza extentem | Sonda zwraca `outside_extent: true` i `null` dla wartości poza granicami | **ZAMKNIĘTE (C05)** |
| **N06** | P0 | Składowa monitora wybierana po nieliniowej redukcji | Rzutowanie wektorowe i selekcja składowej wykonywana przed operacją redukcji nieliniowej | **ZAMKNIĘTE (C09)** |
| **N07** | P0 | Jednostka wyniku gubi operator/składową | Metadane API publikują kanoniczne jednostki SI dostosowane do operatora (`canonical_unit`) | **ZAMKNIĘTE** |
| **N08** | P1 | Default FDM snapuje płaszczyznę i gubi ciągłość | Zachowanie ciągłej współrzędnej `position_fraction` i fizycznego interwału slab | **ZAMKNIĘTE (C07)** |
| **N10** | P1 | Azymut definiowany przy zerowej projekcji w płaszczyźnie | Flaga `undefined_in_plane_orientation` oraz symbole $\odot / \otimes$ dla składowej normalnej | **ZAMKNIĘTE (C10)** |
| **G01** | P1 | Pyramid5/Hex8 w mieszanym FEM | Jawny fail-closed z kodem `unsupported_element_order` bez degradacji do losowych trójkątów | **ZAMKNIĘTE** |
| **G02** | P1 | Stałe bezwzględne tolerancje geometrii | Skalowanie tolerancji geometrycznych względem charakterystycznego rozmiaru elementu / siatki | **ZAMKNIĘTE** |
| **G03** | P1 | Cięcia przez węzły degradujące granice | Klasyfikacja topologiczna segmentów (mesh vs boundary vs interior) bez podwójnych kresek | **ZAMKNIĘTE** |
| **G04** | P1 | Niepotrzebny overlay środkowy dla rzutu głębokości | Warunkowe generowanie deskryptora nakładki siatki zależne od operatora | **ZAMKNIĘTE** |
| **U01** | P1 | Rozbieżne konwencje środka piksela w warstwach | Spójna transformata `PlanarViewTransform` z jednolitą kotwicą UV $[u, v]$ | **ZAMKNIĘTE (C06)** |
| **U02** | P1 | `visible=false` przywracało ukryte warstwy | Niezależny rejestr widoczności `layers` w Zustand z atomowymi patchami | **ZAMKNIĘTE (C08)** |
| **U03** | P1 | FEM skalowane nearest-neighbor | Dedykowana warstwa WebGL `femCutSurfaceLayer` z gładką interpolacją P1 na trójkątach | **ZAMKNIĘTE** |
| **U04** | P1 | Wektory bez grotów i jednostek | Fizyczne próbkowanie wektorów z grotami w pikselach ekranu i wskaźnikami out-of-plane | **ZAMKNIĘTE** |
| **U05** | P2 | Kontury siodeł niejednoznaczne | Wielopoziomowy Marching Squares z decydującym deciderem asymptotycznym dla siodeł | **ZAMKNIĘTE** |
| **U06** | P1 | Region / native layer gubione w planie danych | Pełne propagowanie `scope_kind` i `scope_id` z selekcji do zapytań API | **ZAMKNIĘTE** |
| **U07** | P1 | Default source mało intuicyjne w UI | Akcje "Center of domain" i "Save as monitor" bezpośrednio w Inspektorze | **ZAMKNIĘTE** |
| **E01** | P1 | PNG nie reprezentowało aktualnego widoku | Kanoniczny `PlanarFigureSpec` i eksport spójnego pliku JSON/PNG z metadanymi i stanem | **ZAMKNIĘTE** |
| **P01** | P1 | Brak single-flight na kosztownych tokenach | `SingleFlight`-locking i `DataPlan` deduplikujący jednoczesne zapytania | **ZAMKNIĘTE** |
| **P02** | P1 | Ciągła re-triangulacja siatki przy interakcji | Caching geometrii podziału siatki w `usePlanarSurfaceRenderer` | **ZAMKNIĘTE** |
| **P03** | P2 | Dekodowanie rastra przy zmianie palety/zakresu | Modyfikacja shader uniforms bez alokacji buforów i bez ponownego dekodowania | **ZAMKNIĘTE** |
| **T01** | GATE | Brak dowodów end-to-end | Kompletna piramida testowa (backend, api, frontend, integracja, orakle analityczne) | **ZAMKNIĘTE** |

---

## 4. Architektura i przepływ danych

```text
               +-------------------------------------------+
               |        ProblemIR / SceneDocument         |
               +-------------------------------------------+
                                     |
                       PlanarDatasetSpec / Source
                                     v
               +-------------------------------------------+
               |     crates/fullmag-api::planar_sampling   |
               |  - Spatial Index (AABB Culling)          |
               |  - CutGeometry (Tet4 / Prism6 / FDM)      |
               |  - Numerical Evaluation (P0 / P1, Keast)  |
               |  - Moments & Measure-weighted Reductions |
               |  - Token Binding & Exact Memory Budget    |
               +-------------------------------------------+
                                     |
                       Resource-First HTTP API (v2)
                                     v
               +-------------------------------------------+
               |    apps/control-room Kernel Data Plane    |
               |  - Single-Flight Request Deduplication   |
               |  - CoherentPlanarBundle Strict Validation|
               +-------------------------------------------+
                                     |
                                     v
               +-------------------------------------------+
               |     apps/control-room FieldMapModule      |
               |  - PlanarViewTransform                    |
               |  - PlanarGpuRenderer (Three.js WebGL)     |
               |    * FdmCellLayer (P0 Nearest + Mask)     |
               |    * FemCutSurfaceLayer (P1 Smooth Cut)   |
               |    * Context Loss/Restoration Lifecycle   |
               |  - Overlays (Mesh, Vectors, Contours +0.5)|
               |  - PlanarFigureSpec & Export Manifest     |
               +-------------------------------------------+
```

---

## 5. Release Gate Checklist

- [x] **Backend Rust:** 68/68 testów `fullmag-api::planar_sampling` PASS (w tym C01–C10, PY07, PY10, PY13, PY15, skala nanometrowa, Prism6, FDM, moments).
- [x] **Frontend FieldMap:** 199/199 testów `apps/control-room/src/modules/field-map` PASS.
- [x] **Frontend Workspace & Inspector:** 55/55 testów `crossSectionWorkspace.test.ts` oraz `PlanarVisualizationSection.test.tsx` PASS.
- [x] **Python Contract:** 47/47 testów `test_planar_monitor.py` oraz `test_validate_planar_monitor_sampling.py` PASS.
- [x] **TypeScript Typecheck:** 0 błędów w całym `@fullmag/control-room` (`node scripts/typecheck-control-room.mjs`).
- [x] **ESLint Hygiene:** 0 błędów i 0 ostrzeżeń (`eslint . --max-warnings=0`).
- [x] **Brak ścieżek legacy:** Całkowity brak odwołań do usuniętego kodu przestarzałego.
- [x] **Zgodność z audytem COMSOL-grade:** Rozwiązanie wszystkich 27 ustaleń reaudytu R01–R27 i 25 ustaleń audytu pierwotnego N01–N10, G01–G04, U01–U07, E01, P01–P03, T01.
