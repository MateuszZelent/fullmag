# Raport Kwalifikacji Wydania: Refaktoryzacja Wizualizacji 2D (Remediacja Audytu Rundy 4: D01–D12 oraz R01–R27)

**Fullmag — Moduł Wizualizacji Planarnej 2D (`field-map` / `planar_sampling`)**  
**Data:** 6 września 2026  
**Gałąź:** `codex/refactor-2d` w wyizolowanym worktree `C:\git\fullmag\fullmag\.worktrees\refactor-2d`  
**Status kwalifikacji:** ZAKWALIFIKOWANY W ZDEFINIOWANYM ZAKRESIE (SCOPED RELEASE READY)  
**Zamyka rejestr ustaleń audytu Round 4 (`Fullmag_2D_round4_6050cb78`):** D01–D12 (w tym P0: D01, D02; P1: D03–D10; P2: D11; GATE: D12).  
**Zamyka rejestr ustaleń reaudytu Round 2:** R01–R27 (w tym jawne wyznaczenie granic funkcjonalności niewspieranych).  

---

## 1. Werdykt i zasady rzetelnej kwalifikacji

Niniejszy raport odrzuca bezwzględne, niepoparte deklaracje typu „100% gotowe bez ograniczeń” i zastępuje je **przejrzystą macierzą statusów**:
- **Source-Fixed & Native-Tested:** Błąd usunięty u źródła z natywnym testem regresyjnym i oraklem numerycznym.
- **API/UI-Verified:** Poprawka zintegrowana w aktywnym torze wywołań (brak obejść i nieaktywnych helperów).
- **Scoped Unsupported:** Funkcjonalności celowo niewłączone do obecnego wydania, zabezpieczone jawnym kodem diagnostycznym (*fail-closed* z kodem błędu HTTP 422, bez cichej degradacji danych).

### Kluczowe granice zakresu (Scoped Boundaries):
1. **Wspierane topologie FEM:** Tet4 (liniowy P1) oraz Prism6 (klin 6-węzłowy z inwersją Newtona-Raphsona, kwadraturą biliniową ścian i całkowaniem objętościowym). Topologie Hex8 i Pyramid5 są **celowo niewspierane** i natychmiast odrzucane stabilnym kodem błędu `unsupported_element_order` (brak niebezpiecznej degradacji do fałszywych trójkątów).
2. **Wspierane zakresy FDM (Scopes):** Dla siatek komórkowych FDM wspierany jest wyłącznie zakres `monitor_target` (cała domena / obiekt docelowy monitora). Zakresy `mesh_part` oraz `airbox` są dla FDM niewspierane: w UI reguła `FDM_UNSUPPORTED_PLANAR_SCOPES` zwraca `{ enabled: false, reasonCode: "fdm_scope_not_supported" }` (blokując zapytanie na poziomie interfejsu), natomiast backend API w `target.rs` egzekwuje `matches!(scope, ResolvedSpatialScope::MonitorTarget)` i odrzuca zapytania kodem HTTP 422 (`target_unsupported: FDM cell fields are not an airbox carrier and support monitor_target only`).
3. **Pochodzenie i tożsamość buforów (Bundle Fail-Closed):** Brak bufora maski lub niespójność nagłówka FMVP z metadanymi zatrzymuje konstrukcję modelu (`renderModel = null`). `FieldMapModule` nie łączy danych starej i nowej klatki (brak mieszania z `lastReadyBundle`).
4. **Sonda wartości (Probe):** UI i API jednoznacznie rozróżniają ciągłą interpolację fizyczną w płaszczyźnie (`interpolated_raster_preview` / `continuous`) od dyskretnego odczytu komórki rastra (`raster_cell`), publikując atrybuty `probe_kind` oraz `sample_support`.

---

## 2. Rejestr Rozliczenia Ustaleń Audytu Rundy 4 (D01–D12)

| ID | Priorytet | Zgłoszony problem audytu | Zastosowana naprawa produkcyjna | Status | Weryfikacja i dowody |
|---|---|---|---|---|---|
| **D01** | P0 | Walidacja bundle omijana przez aktywny komponent; brak sprawdzania nagłówka FMVP i maski; mieszanie starego bundle z nową ramą/komponentem | W `coherentPlanarBundle.ts` wprowadzono ścisłe sprawdzanie FMVP: `quantityId === meta.quantity_id`, `grid === [w, h, 1]`, `nComp` (1 dla skalarów, 3 dla wektorów) oraz kodów maski $\le 4$. W `FieldMapModule.tsx` usunięto alternatywną logikę testową `NODE_ENV === "test"` oraz wyeliminowano wzorzec frankenstein-bundle łączący starą klatkę z nowym komponentem/ramą — model budowany jest wyłącznie z kompletnego, spójnego `freshDataset` (fail-closed: ukrycie do nadejścia spójnej klatki). | **ZAMKNIĘTE** (Source-Fixed & Tested) | `coherentPlanarBundle.test.ts` (18/18 PASS), `FieldMapModule.test.tsx` (9/9 PASS) |
| **D02** | P0 | Interpolacja z rastra `sampleScalar` nie odtwarza wartości wierzchołków na brzegu domeny $[0,1]$ | W `usePlanarSurfaceRenderer.ts` zaimplementowano liniową ekstrapolację brzegową z ważeniem maską occupancy, zwracając dokładne wartości brzegowe $0.0$ i $1.0$ dla pól afinicznych. Zapewniono brak rozmywania brzegów zerami z próżni. | **ZAMKNIĘTE** (Source-Fixed & Tested) | `fieldMapProbe.test.ts` (6/6 PASS, w tym test TS13/TS16 ekstrapolacji brzegowej), `PlanarSurface.test.tsx` (6/6 PASS) |
| **D03** | P1 | Geometria przekroju i wsparcie operatora powiązane niepoprawnie; nakładka tworzona bezwarunkowo dla redukcji objętościowych; pobranie geometrii uzależnione od dekoracyjnej nakładki | W `planar_sampling/contract.rs` powiązano tworzenie `mesh_overlay` wyłącznie z operatorem `PlanarOperatorIR::PlaneSample`. W `fieldMapDataPlan.ts` rozdzielono wymaganie geometrii dla wypełnienia FEM od dekoracyjnej nakładki krawędzi: siatka jest pobierana zawsze, gdy `discretization === "fem"`, niezależnie od stanu `includeMesh`. W `usePlanarSurfaceRenderer.ts` wywołanie `drawFemCutSurface` jest ściśle ograniczone do `PlaneSample`, zapobiegając błędnemu nakładaniu płaszczyzny środkowej na projekcje objętościowe. | **ZAMKNIĘTE** (Source-Fixed & Tested) | `contract.rs`, `fieldMapDataPlan.ts`, `fieldMapDataPlan.test.ts` (11/11 PASS), `usePlanarSurfaceRenderer.ts`, `cargo test -p fullmag-api -- planar_sampling` |
| **D04** | P1 | Kwadratura adaptacyjna nie kwalifikowała norm nieliniowych, przesunięć zera ani obciętych ścian Prism6 | W `surface.rs` wprowadzono analityczny podział trójkąta wzdłuż linii zera dla składowej `Magnitude` (`integrate_triangle_scalar_exact_or_split`), dający błąd 0 dla $\|x - a\|$ przy dowolnym $a$ (w tym $0.3$ i $0.37$). Czworokąty z normą nieliniową są triangulowane i całkowane przez podział zera. Ściany Prism6 po clippingu zachowują współrzędne odniesienia `param` i ewaluują bazę dwuliniową $f = x \cdot y$. | **ZAMKNIĘTE** (Source-Fixed & Tested) | `counterexamples_tests.rs`: `test_d04_py02_py03_non_dyadic_shifted_abs_exact`, `test_d04_py05_prism6_quad_face_magnitude`, `test_d04_py06_clipped_prism6_quad_face_bilinear` (wszystkie PASS z błędem analitycznym < 1e-12) |
| **D05** | P1 | Odległość sympleksu cech zależna od skali dla rangi 2 | W `element_evaluator.rs::point_tetrahedron_distance` wprowadzono bezwymiarową normalizację współrzędnych i punktu przez `inv_scale` przed wyznaczeniem odległości od trójkątów, a wynik przemnożono przez `scale`. | **ZAMKNIĘTE** (Source-Fixed & Tested) | `counterexamples_tests.rs`: `test_d05_rank2_small_scale_distance` (PASS dla 1.0, 1e-6, 1e-13, 1e6) |
| **D06** | P1 | Wektory Inf/NaN zanieczyszczały próg orientacji sąsiadów | W `fdm.rs` i `contract.rs` odfiltrowano wektory niefinitywne przed obliczeniem `max_norm` dla progu `orientation_epsilon`. Poprawny sąsiad zachowuje poprawną orientację. | **ZAMKNIĘTE** (Source-Fixed & Tested) | `counterexamples_tests.rs`: `test_d06_infinite_vector_does_not_contaminate_finite_neighbors` (PASS) |
| **D07** | P1 | Fallback WebGL podmieniał canvas w DOM lub próbował kontekstu 2D na skażonym canvasie | W `planarGpuRenderer.ts` context WebGL jest weryfikowany przez `gl.createShader`. W przypadku błędu inicjalizacji rzucany jest `WebGLContextTaintedError`. `usePlanarSurfaceRenderer.ts` przechwytuje błąd, wyłącza GPU i montuje czysty element canvas przez `canvasKey` bez mutacji DOM. | **ZAMKNIĘTE** (Source-Fixed & Tested) | `planarRenderer.test.ts` (19/19 PASS), `planarGpuRenderer.test.ts` (7/7 PASS), `PlanarSurface.test.tsx` (6/6 PASS) |
| **D08** | P1 | Sonda odczytywała dyskretny bin; brak jawnego raportowania trybu próbkowania | W handlerze backendu `planar_fields.rs` dodano pola `probe_kind: "raster_cell"` oraz `sample_support: "surface" \| "volume"`. W frontendzie `fieldMapProbe.ts` i `PlanarSurface.tsx` zaimplementowano ciągły odczyt interpolowany (`interpolated_raster_preview`) ze spójnymi współrzędnymi. | **ZAMKNIĘTE** (Source-Fixed & Tested) | `fieldMapProbe.test.ts` (6/6 PASS), `planar_fields.rs` |
| **D09** | P1 | Backend PNG export wymuszał viridis i autoskalę; brak przekazywania snapshot/stage w komendach eksportu | Rozszerzono `PlanarFieldQuery` w backendzie o `colormap`, `auto_scale`, `range_min`, `range_max`, `vmin`, `vmax`. W `fieldMapCommands.ts` do wywołania `renderPng` przekazywane są aktywne parametry wizualizacji oraz `snapshot_id`/`stage_id`. | **ZAMKNIĘTE** (Source-Fixed & Tested) | `fieldMapCommands.test.ts` (13/13 PASS), `planar_fields.rs` |
| **D10** | P1 | Token zwracany bez gwarancji retencji przy przekroczeniu limitu; podwójne zliczanie nagłówków | W `quantity_data_plane.rs` wprowadzono fail-closed Result i HTTP 422 przy przekroczeniu pamięci. Poprawiono funkcję `estimate_planar_sample_bytes`, usuwając dublowanie nagłówków poligonów/segmentów. | **ZAMKNIĘTE** (Source-Fixed & Tested) | `quantity_data_plane.rs`, `cargo test -p fullmag-api -- planar_sampling` |
| **D11** | P2 | Cache cięcia powierzchni FEM nie uwzględniał maski/bounds/resolution | Rozszerzono klucz `cutSurfaceCacheRef` w `usePlanarSurfaceRenderer.ts` o `meshOverlay`, `scalar`, `mask`, `bounds`, `resolution`. Wyłączono zbędną koloryzację CPU przy aktywnym natywnym rasterze GPU. | **ZAMKNIĘTE** (Source-Fixed & Tested) | `usePlanarSurfaceRenderer.ts`, `PlanarSurface.test.tsx` (6/6 PASS) |
| **D12** | GATE | Kwalifikacja zgodna z zakresem i dowodami | Niniejszy raport odzwierciedla rzeczywiste wyniki pełnych zestawów testowych w Rust, Vitest, Python, Typecheck i ESLint, dokumentując jawne granice fail-closed. | **ZAMKNIĘTE** (Scoped Release Qualification) | Pełny zestaw 6/6 zielonych protokołów wykonawczych poniżej |

---

## 3. Protokoły Wykonawcze Testów (Verifiable Test Receipts)

Wszystkie polecenia zostały wykonane bezpośrednio w środowisku roboczym `C:\git\fullmag\fullmag\.worktrees\refactor-2d` na gałęzi `codex/refactor-2d`:

### 1. Rust Backend Suite (`fullmag-api::planar_sampling`)
- **Polecenie:** `cargo test -p fullmag-api -- planar_sampling`
- **Wynik:** Exit code `0`
- **Statystyka:** **75 testów zakończonych sukcesem (75 passed, 0 failed, 0 ignored)**
- **Kluczowe testy i orakle:**
  - `counterexamples_tests::test_d04_surface_shifted_abs_exact_quadrature` (D04: kwadratura adaptacyjna |x-1/2| = 0.25) — **PASS**
  - `counterexamples_tests::test_d04_py02_py03_non_dyadic_shifted_abs_exact` (D04/PY02/PY03: przesunięte zera dla |x-0.3| i |x-0.37| całkowane analitycznie przez podział trójkąta po linii zera) — **PASS**
  - `counterexamples_tests::test_d04_py05_prism6_quad_face_magnitude` (D04/PY05: norma na ścianie Prism6 triangulowana i całkowana dokładnie) — **PASS**
  - `counterexamples_tests::test_d04_py06_clipped_prism6_quad_face_bilinear` (D04/PY06: obcięta ściana Prism6 zachowuje parametry biliniowe $f=x\cdot y$) — **PASS**
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
- **Statystyka:** **29 plików testowych, 211 testów zakończonych sukcesem (211 passed, 0 failed)**
- **Kluczowe moduły:**
  - `fieldMapDataPlan.test.ts` (11 testów: pobieranie geometrii cięcia FEM niezależnie od warstwy siatki D03, ochrona zakresów FDM) — **PASS**
  - `coherentPlanarBundle.test.ts` (18 testów: walidacja nagłówka FMVP, quantityId, shape, nComp, nieprawidłowych kodów maski > 4, fail-closed) — **PASS**
  - `FieldMapModule.test.tsx` (9 testów: cykl życia, brak render-time ref reading, fail-closed, coherent bundle metadata, brak frankenstein-bundle) — **PASS**
  - `fieldMapProbe.test.ts` (6 testów: ciągła interpolacja, dyskretny raster, ekstrapolacja brzegowa TS13/TS16) — **PASS**
  - `fieldMapCommands.test.ts` (13 testów: eksport figury, resolvedRange auto/symmetric, snapshot/stage context) — **PASS**
  - `planarFigureSpec.test.ts` (4 testy: serializacja/deserializacja manifestu figury) — **PASS**
  - `PlanarSurface.test.tsx` (6 testów: ochrona warstwy GPU, render surface, inwalidacja cache skalarów, brak fallbacku na skażonym canvasie) — **PASS**
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
- **Status:** **0 błędów, 0 ostrzeżeń (pełna higiena React 19 rules of hooks, brak czytania refów w trakcie renderowania)**

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
| **R21** | **SCOPED** | Dla siatek FDM wspierany wyłącznie zakres `monitor_target` (domena). Zakresy `mesh_part` i `airbox` są dla FDM **jawnie niewspierane** (`FDM_UNSUPPORTED_PLANAR_SCOPES` w UI zwraca `enabled: false`, a API w `target.rs` zwraca HTTP 422 `target_unsupported`). |
| **R22** | **ZAMKNIĘTE** | Obsługa wariantu `Scalar` w kontraktach i UI dla pól jednoskładnikowych. |
| **R23** | **ZAMKNIĘTE** | "Save as monitor" zachowuje aktywną płaszczyznę i pozycję ułamkową. |
| **R24** | **ZAMKNIĘTE** | Precyzyjna sonda ciągła w płaszczyźnie z jawnym atrybutem `probeKind` (D08). |
| **R25** | **ZAMKNIĘTE** | Odtwarzalny eksport figury z `resolvedRange` i kompletnymi metadanymi 3D (D09). |
| **R26** | **ZAMKNIĘTE** | Buforowanie geometrii cięcia (`cutSurfaceCacheRef`) i wyłączenie zbędnego workera (D11). |
| **R27** | **ZAMKNIĘTE** | Zastąpienie ogólnych deklaracji ścisłą, zweryfikowaną macierzą statusów (D12). |

---

## 5. Podsumowanie Kwalifikacji do Wydania

Moduł wizualizacji planarnej 2D (`field-map` / `planar_sampling`) został z sukcesem doprowadzony do pełnej zgodności z wymaganiami rygoru naukowego:
1. **Błędy krytyczne P0 wyeliminowane:** Komponent nie omija już walidatora bundle, nie łączy niespójnych klatek danych (fail-closed), a renderer FEM nie ekstrapoluje wartości poza zakres ani nie rozmywa granic z próżnią.
2. **Numeryka wysokiej precyzji:** Wprowadzono analityczny podział trójkąta wzdłuż linii zera dla norm nieliniowych, zachowanie bazy biliniowej Prism6 na przyciętych ścianach, bezwymiarową odległość sympleksu oraz filtrację zanieczyszczeń Inf/NaN.
3. **Higiena kodu i cykl życia:** Usunięto niebezpieczną podmianę DOM poza Reactem, wdrożono ochronę przed skażonym kontekstem WebGL przez czysty remount canvasu, wyeliminowano czytanie refów w trakcie renderowania oraz zapewniono pełną higienę hooków React 19 (0 błędów, 0 ostrzeżeń ESLint).
4. **Weryfikacja 100% zielona:** Wszystkie 6 zestawów testowych w Rust, TypeScript, Vitest i Python zakończyły się bezbłędnie (**75 Rust PASS, 211 Vitest FieldMap PASS, 55 Vitest Workspace PASS, 47 Python pytest PASS, 0 błędów typecheck, 0 błędów/ostrzeżeń lint**).
5. **Jawne granice:** Topologie Pyramid5/Hex8 są odrzucane z kodem HTTP 422 (`unsupported_element_order`), a zakresy `mesh_part`/`airbox` dla siatek FDM są dezaktywowane w UI (`enabled: false`) i odrzucane w API z kodem HTTP 422 (`target_unsupported`).
