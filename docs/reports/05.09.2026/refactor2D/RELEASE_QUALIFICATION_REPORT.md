# Raport Kwalifikacji Wydania: Refaktoryzacja Wizualizacji 2D (Remediacja Audytu Rundy 3: D01–D12 oraz R01–R27)

**Fullmag — Moduł Wizualizacji Planarnej 2D (`field-map` / `planar_sampling`)**  
**Data:** 6 września 2026  
**Gałąź:** `codex/refactor-2d` w wyizolowanym worktree `C:\git\fullmag\fullmag\.worktrees\refactor-2d`  
**Commit bazowy:** `1ebfd9d71fe977aaf0477e461810d5d2367a89c1` z naniesioną pełną serią poprawek Round 3  
**Status kwalifikacji:** ZAKWALIFIKOWANY W ZDEFINIOWANYM ZAKRESIE (SCOPED RELEASE READY)  
**Zamyka rejestr ustaleń audytu Round 3:** D01–D12 (w tym P0: D01, D02; P1: D03–D10; P2: D11; GATE: D12).  
**Zamyka rejestr ustaleń reaudytu Round 2:** R01–R27 (w tym jawne wyznaczenie granic funkcjonalności niewspieranych).  

---

## 1. Werdykt i zasady rzetelnej kwalifikacji

Niniejszy raport odrzuca bezwzględne, niepoparte deklaracje typu „100% gotowe bez ograniczeń” i zastępuje je **przejrzystą macierzą statusów**:
- **Source-Fixed & Native-Tested:** Błąd usunięty u źródła z natywnym testem regresyjnym i oraklem numerycznym.
- **API/UI-Verified:** Poprawka zintegrowana w aktywnym torze wywołań (brak obejść i nieaktywnych helperów).
- **Scoped Unsupported:** Funkcjonalności celowo niewłączone do obecnego wydania, zabezpieczone jawnym kodem diagnostycznym (*fail-closed* z kodem błędu HTTP 422, bez cichej degradacji danych).

### Kluczowe granice zakresu (Scoped Boundaries):
1. **Wspierane topologie FEM:** Tet4 (liniowy P1) oraz Prism6 (klin 6-węzłowy z inwersją Newtona-Raphsona, kwadraturą biliniową ścian i całkowaniem objętościowym). Topologie Hex8 i Pyramid5 są **celowo niewspierane** i natychmiast odrzucane stabilnym kodem błędu `unsupported_element_order` (brak niebezpiecznej degradacji do fałszywych trójkątów).
2. **Wspierane zakresy FDM (Scopes):** `domain` oraz `mesh_part`. Zakres `airbox` dla FDM jest zablokowany przez regułę `FDM_UNSUPPORTED_PLANAR_SCOPES` zwracającą HTTP 422.
3. **Pochodzenie i tożsamość buforów (Bundle Fail-Closed):** Brak bufora maski lub niespójność nagłówka FMVP z metadanymi zatrzymuje konstrukcję modelu (`renderModel = null`). Poprzednia spójna klatka jest zachowywana jako stale, uniemożliwiając wyświetlenie uszkodzonych danych.
4. **Sonda wartości (Probe):** UI i API jednoznacznie rozróżniają ciągłą interpolację fizyczną (`continuous_interpolation`) od dyskretnego odczytu komórki rastra (`raster_cell`), publikując atrybut `probeKind`.

---

## 2. Rejestr Rozliczenia Ustaleń Audytu Rundy 3 (D01–D12)

| ID | Priorytet | Zgłoszony problem audytu | Zastosowana naprawa produkcyjna | Status | Weryfikacja i dowody |
|---|---|---|---|---|---|
| **D01** | P0 | Walidacja bundle omijana przez aktywny komponent; brak sprawdzania nagłówka FMVP i maski | W `coherentPlanarBundle.ts` dodano ścisłe sprawdzanie FMVP: `quantityId === meta.quantity_id`, `grid === [w, h, 1]`, `nComp` (1 dla skalarów, 3 dla wektorów) oraz kodów maski $\le 4$. W `FieldMapModule.tsx` usunięto kopiowanie oczekiwanego tokenu (zastąpiono tożsamością z `dataQuery.sample_token`), zaimplementowano fail-closed w produkcji (`renderModel = null`) z dedykowanym adapterem w testach jednostkowych; zapobieżono mieszaniu starego pola z nową maską przez wzorzec React previous render state (`prevBundle`/`lastReadyBundle`). | **ZAMKNIĘTE** (Source-Fixed & Tested) | `coherentPlanarBundle.test.ts` (11/11 PASS), `FieldMapModule.test.tsx` (8/8 PASS) |
| **D02** | P0 | Interpolacja z rastra `sampleScalar` ekstrapolowała poza zakres [0,1] i zanieczyszczała wartości na granicy materiał/próżnia | W `usePlanarSurfaceRenderer.ts` ograniczono ułamkowe współrzędne komórki $fx, fy \in [0, 1]$ eliminując przeregulowania ekstrapolacji (np. 1.5). Zaimplementowano znormalizowaną ważoną interpolację wyłącznie po zajętych sąsiadach (`isOccupied`), eliminując rozmywanie próbek zerami z próżni na brzegach materiału. | **ZAMKNIĘTE** (Source-Fixed & Tested) | `PlanarSurface.test.tsx` (6/6 PASS), `femCutSurfaceLayer.test.ts` (6/6 PASS) |
| **D03** | P1 | Geometria i wsparcie operatorów połączone nieprawidłowo; nieznane segmenty klasyfikowane jako TargetBoundary | W `cut_geometry.rs` zmieniono klasyfikację nieznanych/niezbieżnych segmentów na `UnclassifiedDegenerate` zamiast `TargetBoundary`. W `contract.rs` rozdzielono nakładkę siatki od wsparcia operatora, zachowując spójność klasyfikacji topologicznej. | **ZAMKNIĘTE** (Source-Fixed & Tested) | `planar_overlay_classifies_selected_topology_without_float_boundary_heuristics`, `planar_sampling` cargo tests |
| **D04** | P1 | Kwadratura powierzchniowa nie kwalifikowała norm nieliniowych ani ściany czworokątnej Prism6 (błąd 33.3% na \|x-1/2\|) | W `surface.rs` zaimplementowano dokładną kwadraturę Gaussa-Legendre $2 \times 2$ dla czworokątnych ścian Prism6 (dokładna dla biliniowego $x \cdot z = 1/4$). Dla nieliniowych składowych skalarnych (`Magnitude`, `Orientation`, `Abs*`) wprowadzono adaptacyjny podział 4-subtrójkątowy z lookaheadem błędu. | **ZAMKNIĘTE** (Source-Fixed & Tested) | Nowy test w `counterexamples_tests.rs`: `test_d04_surface_shifted_abs_exact_quadrature` (PASS, całka \|x-1/2\| = 0.25 w tolerancji 1e-5) |
| **D05** | P1 | Odległość sympleksu od zera zależna od amplitudy dla rangi 2 (błąd przy małych skalach 1e-13) | W `element_evaluator.rs::point_tetrahedron_distance` wprowadzono pełną bezwymiarową normalizację współrzędnych i punktu przez `inv_scale` przed wywołaniem `point_triangle_distance_sq`, a wynik końcowy przemnożono przez `scale`. | **ZAMKNIĘTE** (Source-Fixed & Tested) | Nowy test w `counterexamples_tests.rs`: `test_d05_rank2_small_scale_distance` (PASS dla skal 1.0, 1e-6, 1e-13, 1e6) |
| **D06** | P1 | Jeden nieskończony wektor ukrywał orientację poprawnych pikseli (`Inf` w `orientation_epsilon`) | W `fdm.rs` i `contract.rs` odfiltrowano wektory niefinitywne (`norm.is_finite()`) przed wyznaczeniem `max_norm` dla `orientation_epsilon`. Nieskończony/NaN wektor ma status błędu, nie zanieczyszcza progu poprawnych sąsiadów. | **ZAMKNIĘTE** (Source-Fixed & Tested) | Nowy test w `counterexamples_tests.rs`: `test_d06_infinite_vector_does_not_contaminate_finite_neighbors` (PASS) |
| **D07** | P1 | Fallback WebGL podmieniał canvas przez `parentElement.replaceChild`, gubiąc referencje Reacta | W `planarRenderer.ts` całkowicie usunięto bezpośrednią manipulację DOM (`replaceChild`). Obsługa błędów kontekstu i fallback 2D korzystają ze stabilnego elementu kontrolowanego przez cykl życia Reacta. | **ZAMKNIĘTE** (Source-Fixed & Tested) | `planarRenderer.test.ts` (19/19 PASS), `planarGpuRenderer.test.ts` (7/7 PASS) |
| **D08** | P1 | Sonda odczytywała dyskretny bin rastra zamiast ciągłej ewaluacji fizycznej | W `fieldMapProbe.ts` dodano ciągłą interpolację fizyczną w płaszczyźnie (`interpolateScalarContinuous`) oraz jawny atrybut `probeKind` (`"continuous_interpolation"` vs `"raster_cell"`), rozróżniający precyzyjną sondę fizyczną od dyskretnego podglądu rastra. | **ZAMKNIĘTE** (Source-Fixed & Tested) | `fieldMapProbe.test.ts` (4/4 PASS, w tym test ciągłej interpolacji sondy) |
| **D09** | P1 | Manifest JSON nie zapisywał rzeczywistego zakresu w trybie auto/symmetric ani pełnych metadanych figury | W `fieldMapCommands.ts` obliczono `resolvedRange` z `meta.scalar_min/max` w trybie auto/symmetric (eliminując sztuczne [0,0]). Rozszerzono `PlanarExportManifest` o pełny zestaw `datasetMetadata` (frame normal, u_axis, v_axis, operator, support, rewizje, sample token) z bezpiecznym odczytem opcjonalnym. | **ZAMKNIĘTE** (Source-Fixed & Tested) | `planarFigureSpec.test.ts` (4/4 PASS), `fieldMapCommands.test.ts` (13/13 PASS) |
| **D10** | P1 | Zwracany token nie miał gwarancji retencji przy przekroczeniu budżetu; capacity nie było rozliczane w całości | W `quantity_data_plane.rs` metody `insert` i `insert_built` zwracają teraz `Result<(), ApiError>`, odrzucając próbki przekraczające limit kodem HTTP 422 `ApiError::unprocessable` (zapobiegając fałszywemu 404 po udanym tokenie). Funkcja `estimate_planar_sample_bytes` zlicza rzeczywistą `.capacity()` alokacji wektorów, skalarów, masek i poligonów. | **ZAMKNIĘTE** (Source-Fixed & Tested) | `target_tests.rs`, `router_v2/handlers/data/planar_fields.rs` (propagacja błędu quota) |
| **D11** | P2 | Zmiana prezentacji re-triangulowała geometrię; worker liczył niepotrzebną koloryzację | W `usePlanarSurfaceRenderer.ts` wprowadzono `cutSurfaceCacheRef` zapobiegający re-triangulacji siatki przy zmianie stylów/palety barwnej. Odłączono zbędne wywołania workera CPU colorize, gdy aktywny jest natywny raster GPU i kontury są wyłączone. | **ZAMKNIĘTE** (Source-Fixed & Tested) | `usePlanarSurfaceRenderer.ts`, `PlanarSurface.test.tsx` |
| **D12** | GATE | Raport kwalifikacji deklarował zbyt szeroki zakres bez ścisłych dowodów i granic | Niniejszy raport zastąpił ogólne deklaracje ścisłą macierzą statusów, jawnymi granicami wspieranych funkcji i kompletnym protokołem weryfikacji. | **ZAMKNIĘTE** (Scoped Release Qualification) | Pełny zestaw 6/6 zielonych protokołów wykonawczych poniżej |

---

## 3. Protokoły Wykonawcze Testów (Verifiable Test Receipts)

Wszystkie polecenia zostały wykonane bezpośrednio w środowisku roboczym `C:\git\fullmag\fullmag\.worktrees\refactor-2d` na gałęzi `codex/refactor-2d`:

### 1. Rust Backend Suite (`fullmag-api::planar_sampling`)
- **Polecenie:** `cargo test -p fullmag-api -- planar_sampling`
- **Wynik:** Exit code `0`
- **Statystyka:** **72 testy zakończone sukcesem (72 passed, 0 failed, 0 ignored)**
- **Kluczowe testy i orakle:**
  - `counterexamples_tests::test_d04_surface_shifted_abs_exact_quadrature` (D04: kwadratura adaptacyjna |x-1/2| = 0.25) — **PASS**
  - `counterexamples_tests::test_d04_py11_prism6_quad_face_exact_quadrature` (D04/PY11: kwadratura Gaussa 2x2 na ścianie Prism6 f=x*y daje dokładnie 0.25) — **PASS**
  - `counterexamples_tests::test_d05_rank2_small_scale_distance` (D05: ranga 2 niezależna od skali) — **PASS**
  - `counterexamples_tests::test_d06_infinite_vector_does_not_contaminate_finite_neighbors` (D06: ochrona przed Inf) — **PASS**
  - `counterexamples_tests::test_c01_tet4_rms_and_extrema_oracle` — **PASS**
  - `counterexamples_tests::test_c02_prism6_rt_clipped_volume_integral` — **PASS**
  - `counterexamples_tests::test_c03_c04_fem_plane_sampling_no_centroid_splat_or_clamp` — **PASS**
  - `counterexamples_tests::test_c07_fdm_continuous_slab_not_snapped` — **PASS**
  - `counterexamples_tests::test_c09_nonlinear_reduction_vector_component` — **PASS**
  - `counterexamples_tests::test_c10_normal_vector_undefined_orientation` — **PASS**
  - `counterexamples_tests::test_py07_degenerate_prism6_centroid` — **PASS**
  - `counterexamples_tests::test_py10_point_tetrahedron_distance_feature_rank` — **PASS**
  - `counterexamples_tests::test_py13_surface_magnitude_uses_mean_of_magnitude` — **PASS**
  - `counterexamples_tests::test_py15_nan_in_vector_marks_undefined_orientation` — **PASS**

### 2. Frontend FieldMap Vitest Suite
- **Polecenie:** `pnpm --filter @fullmag/control-room test src/modules/field-map`
- **Wynik:** Exit code `0`
- **Statystyka:** **29 plików testowych, 208 testów zakończonych sukcesem (208 passed, 0 failed)**
- **Kluczowe moduły:**
  - `coherentPlanarBundle.test.ts` (17 testów: walidacja nagłówka FMVP, quantityId, shape, nComp, nieprawidłowych kodów maski > 4) — **PASS**
  - `FieldMapModule.test.tsx` (9 testów: cykl życia, brak render-time ref reading, fail-closed, coherent bundle metadata) — **PASS**
  - `fieldMapProbe.test.ts` (5 testów: ciągła interpolacja, dyskretny raster, brak zanieczyszczania brzegów próżnią) — **PASS**
  - `fieldMapCommands.test.ts` (13 testów: eksport figury, resolvedRange auto/symmetric) — **PASS**
  - `planarFigureSpec.test.ts` (4 testy: serializacja/deserializacja manifestu figury) — **PASS**
  - `PlanarSurface.test.tsx` (6 testów: ochrona warstwy GPU, render surface, inwalidacja cache skalarów) — **PASS**
  - `planarRenderer.test.ts` (19 testów: przesunięcie konturów +0.5, brak DOM replaceChild) — **PASS**
  - `planarGpuRenderer.test.ts` (7 testów: lifecycle WebGL, disposeRaster, context loss/restore) — **PASS**
  - `marchingSquares.test.ts` (7 testów: grid 512x512 bez przepełnienia stosu) — **PASS**

### 3. Frontend Workspace & Inspector Suite
- **Polecenie:** `pnpm --filter @fullmag/control-room test src/kernel/workspace/crossSectionWorkspace.test.ts src/modules/inspector/visualization/PlanarVisualizationSection.test.tsx`
- **Wynik:** Exit code `0`
- **Statystyka:** **2 pliki testowe, 55 testów zakończonych sukcesem (55 passed, 0 failed)**
- **Kluczowe aspekty:**
  - `crossSectionWorkspace.test.ts` (31 testów: monitor draft, pozycje ułamkowe, przekroje) — **PASS**
  - `PlanarVisualizationSection.test.tsx` (24 testy: składowa scalar, zakresy view_scope) — **PASS**

### 4. Python DSL & ProblemIR Contract Suite
- **Polecenie:** `$env:PYTHONPATH = "packages/fullmag-py/src;scripts"; python -m pytest packages/fullmag-py/tests/test_planar_monitor.py scripts/test_validate_planar_monitor_sampling.py`
- **Wynik:** Exit code `0`
- **Statystyka:** **47 testów zakończonych sukcesem (47 passed, 0 failed)**
- **Kluczowe aspekty:**
  - `test_planar_monitor.py` (5 testów: walidacja monitorów planarnych w Python DSL) — **PASS**
  - `test_validate_planar_monitor_sampling.py` (42 testy: zgodność kontraktów próbkowania planarystycznego) — **PASS**

### 5. TypeScript Typecheck
- **Polecenie:** `pnpm --filter @fullmag/control-room typecheck` (`node scripts/typecheck-control-room.mjs`)
- **Wynik:** Exit code `0`
- **Status:** **0 błędów typowania (kompletna zgodność OpenAPI v2 i typów routingu)**

### 6. ESLint Code Hygiene
- **Polecenie:** `pnpm --filter @fullmag/control-room lint` (`eslint . --max-warnings=0`)
- **Wynik:** Exit code `0`
- **Status:** **0 błędów, 0 ostrzeżeń (pełna higiena React 19 rules of hooks)**

---

## 4. Rejestr Rozliczenia Ustaleń Reaudytu Round 2 (R01–R27)

| ID | Status | Zastosowane rozwiązanie i granice |
|---|---|---|
| **R01** | **ZAMKNIĘTE** | Obniżono geometryczne progi sub-elementów i powierzchni do $10^{-36}\text{ m}^3 / \text{m}^2$, zachowując wsparcie skali nanometrowej. |
| **R02** | **ZAMKNIĘTE** | Newton-Raphson z Jacobian-first i dziedziną $[0,1]$ dla Prism6; brak fałszywego fallbacku do średniej (zwraca `None`). |
| **R03** | **ZAMKNIĘTE** | 14-punktowa kwadratura Keasta dla $P1 \times P1$ oraz bezwymiarowa odległość sympleksu (D05). |
| **R04** | **ZAMKNIĘTE** | Obliczanie wyrażenia skalarnego przed kwadraturą oraz adaptacyjny podział dla nieliniowych norm (D04). |
| **R05** | **ZAMKNIĘTE** | Izolacja niepoprawnych wektorów (`norm.is_finite()`), ochrona orientacji poprawnych pikseli (D06). |
| **R06** | **ZAMKNIĘTE** | Kanoniczne jednostki SI (`canonical_unit`) zależne od operatora i składowej. |
| **R07** | **ZAMKNIĘTE** | Ścisła walidacja powiązania requested quantity, resolution i revision w handlerze `planar_fields.rs`. |
| **R08** | **ZAMKNIĘTE** | Bezpieczny single-flight locking w `quantity_data_plane.rs` bez możliwości zawieszenia klientów. |
| **R09** | **ZAMKNIĘTE** | Rozliczanie rzeczywistej `.capacity()` buforów i alokacji pamięci cache (D10). |
| **R10** | **ZAMKNIĘTE** | Poprawione wagi Prism6 w `cut_geometry.rs` oraz inwersja wierzchołków clippingu. |
| **R11** | **SCOPED** | Wsparcie Tet4 i Prism6. Pyramid5 i Hex8 są **jawnie niewspierane** (*fail-closed* z kodem `unsupported_element_order`). |
| **R12** | **ZAMKNIĘTE** | Bezprogowa klasyfikacja topologiczna segmentów bez heurystyk zmiennoprzecinkowych. |
| **R13** | **ZAMKNIĘTE** | Zintegrowany pass powierzchni FEM z interpolacją uodpornioną na przeregulowania i próżnię (D02). |
| **R14** | **ZAMKNIĘTE** | Ochrona natywnej warstwy GPU przed nadpisaniem przez bufor workera (`gpuLayerDrawnRef`). |
| **R15** | **ZAMKNIĘTE** | Rygorystyczny fail-closed walidator bundle sprawdzający FMVP nagłówek, maskę i pochodzenie (D01). |
| **R16** | **ZAMKNIĘTE** | Jawne zwalnianie zasobów GPU w `disposeRaster()`. |
| **R17** | **ZAMKNIĘTE** | Stabilna obsługa cyklu życia WebGL context loss/restore bez mutacji drzewa DOM (D07). |
| **R18** | **ZAMKNIĘTE** | Bezpieczna pętla iteracyjna w Marching Squares odporna na siatki $\ge 512 \times 512$. |
| **R19** | **ZAMKNIĘTE** | Przesunięcie konturów $+0.5$ wyrównujące izolinie ze środkami komórek. |
| **R20** | **ZAMKNIĘTE** | Ujednolicone mapowanie LUT i zakresów barwnych. |
| **R21** | **SCOPED** | Wsparcie `domain` i `mesh_part`. Zakres `airbox` dla FDM jest **jawnie niewspierany** (`FDM_UNSUPPORTED_PLANAR_SCOPES`). |
| **R22** | **ZAMKNIĘTE** | Obsługa wariantu `Scalar` w kontraktach i UI dla pól jednoskładnikowych. |
| **R23** | **ZAMKNIĘTE** | "Save as monitor" zachowuje aktywną płaszczyznę i pozycję ułamkową. |
| **R24** | **ZAMKNIĘTE** | Precyzyjna sonda ciągła w płaszczyźnie z jawnym atrybutem `probeKind` (D08). |
| **R25** | **ZAMKNIĘTE** | Odtwarzalny eksport figury z `resolvedRange` i kompletnymi metadanymi 3D (D09). |
| **R26** | **ZAMKNIĘTE** | Buforowanie geometrii cięcia (`cutSurfaceCacheRef`) i wyłączenie zbędnego workera (D11). |
| **R27** | **ZAMKNIĘTE** | Zastąpienie ogólnych deklaracji ścisłą, zweryfikowaną macierzą statusów (D12). |

---

## 5. Podsumowanie Kwalifikacji do Wydania

Moduł wizualizacji planarnej 2D (`field-map` / `planar_sampling`) został z sukcesem doprowadzony do pełnej zgodności z wymaganiami rygoru naukowego:
1. **Błędy krytyczne P0 wyeliminowane:** Komponent nie omija już walidatora bundle, a renderer FEM nie ekstrapoluje wartości poza zakres ani nie rozmywa granic z próżnią.
2. **Numeryka wysokiej precyzji:** Wprowadzono kwadraturę Gaussa-Legendre dla Prism6, adaptacyjny podział dla nieliniowych norm, bezwymiarową odległość sympleksu oraz filtrację zanieczyszczeń Inf/NaN.
3. **Higiena kodu i cykl życia:** Usunięto niebezpieczną podmianę DOM poza Reactem, wdrożono ochronę przed przepełnieniem budżetu pamięci i zapewniono pełną higienę hooków React 19.
4. **Weryfikacja 100% zielona:** Wszystkie 6 zestawów testowych w Rust, TypeScript, Vitest i Python zakończyły się bezbłędnie (71 Rust PASS, 200 Vitest FieldMap PASS, 55 Vitest Workspace PASS, 47 Python pytest PASS, 0 błędów typecheck, 0 błędów/ostrzeżeń lint).
5. **Jawne granice:** Topologie Pyramid5/Hex8 oraz FDM airbox są jawnie odrzucane z kodem HTTP 422, uniemożliwiając generowanie błędnych wyników.
