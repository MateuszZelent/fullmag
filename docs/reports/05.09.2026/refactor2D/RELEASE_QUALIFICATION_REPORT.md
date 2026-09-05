# Raport Kwalifikacji Wydania: Refaktoryzacja Wizualizacji 2D (Etapy 00–13)

**Fullmag — Moduł Wizualizacji Planarnej 2D (`field-map` / `planar_sampling`)**  
**Data:** 5 września 2026  
**Gałąź:** `codex/refactor-2d` w wyizolowanym worktree `C:\git\fullmag\fullmag\.worktrees\refactor-2d`  
**Status kwalifikacji:** ZAKWALIFIKOWANY DO WYDANIA (RELEASE READY)  
**Zamyka rejestr ustaleń audytu:** N01–N10, G01–G04, U01–U07, E01, P01–P03, T01.

---

## 1. Werdykt i podsumowanie wykonania

Zrealizowano pełną, sekwencyjną refaktoryzację modułu wizualizacji 2D ściśle według specyfikacji z etapów `ETAP_00` do `ETAP_13`.
Wyeliminowano wszystkie błędy numeryczne, niejednoznaczności ramy fizycznej, artefakty renderowania, rozbieżności jednostek oraz wycieki pamięci/re-renderów.

### Wyniki weryfikacji testowej:
- **Rust Backend (`fullmag-api::planar_sampling`):** 61/61 testów jednostkowych i orakli zielonych (`cargo test -p fullmag-api -- planar_sampling`).
- **Kontrprzykłady analityczne C01–C10:** 10/10 potwierdzonych, a ich mechanizmy trwale zabezpieczone testami regresyjnymi w `counterexamples_tests.rs`.
- **Frontend Vitest (`apps/control-room` field-map):** 29 zestawów testowych, 185/185 testów zakończonych sukcesem.
- **Frontend Vitest (`apps/control-room` inspector):** 6 zestawów testowych, 62/62 testów zakończonych sukcesem.
- **Python DSL & ProblemIR Contract:** 5/5 testów `test_planar_monitor.py` oraz 42/42 testów walidatora próbkowania `test_validate_planar_monitor_sampling.py` zakończonych sukcesem.
- **TypeScript Typecheck:** 0 błędów w całym `@fullmag/control-room` (`tsc --noEmit`).
- **ESLint Hygiene:** 0 błędów i 0 ostrzeżeń (`eslint . --max-warnings=0`).

---

## 2. Rozliczenie ustaleń z audytu

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

## 3. Podział odpowiedzialności i architektura

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
               |  - Numerical Evaluation (P0 / P1)         |
               |  - Moments & Measure-weighted Reductions |
               |  - Coherent ETag & Binary Formats         |
               +-------------------------------------------+
                                     |
                      Resource-First HTTP API (v2)
                                     v
               +-------------------------------------------+
               |    apps/control-room Kernel Data Plane    |
               |  - Single-Flight Request Deduplication   |
               |  - CoherentPlanarBundle Validation        |
               +-------------------------------------------+
                                     |
                                     v
               +-------------------------------------------+
               |     apps/control-room FieldMapModule      |
               |  - PlanarViewTransform                    |
               |  - PlanarGpuRenderer (Three.js WebGL)     |
               |    * FdmCellLayer (P0 Nearest + Mask)     |
               |    * FemCutSurfaceLayer (P1 Smooth Cut)   |
               |  - Overlay Layers (Mesh, Vectors, Contours)|
               |  - PlanarFigureSpec & Export Manifest     |
               +-------------------------------------------+
```

---

## 4. Instrukcja dla użytkownika

1. **Wybór widoku i źródła:**
   - **Default:** Szybki podgląd przekroju wzdłuż osi głównych ($XY$, $XZ$, $YZ$). Płynne przesuwanie suwaka pozycji zachowuje dokładną fizyczną współrzędną ciągłą w metrach.
   - **Przycisk "Center of domain":** Błyskawicznie ustawia płaszczyznę przekroju dokładnie w środku geometrycznym domeny.
   - **Przycisk "Save as monitor":** Zapisuje bieżący stan przekroju jako trwały obiekt obserwacyjny `PlanarMonitor` w drzewie projektu.
2. **Operatory pomiarowe:**
   - `Plane sample`: Czysty przekrój dwuwymiarowy płaszczyzną o zerowej grubości.
   - `Slab average`: Uśrednienie pola po warstwie o zadanej grubości $t$ z wagowaniem miarą fizyczną komórek.
   - `Depth projection`: Rzutowanie wzdłuż osi normalnej (całka po grubości, wartość maksymalna, średnia po objętości magnetycznej).
3. **Wizualizacja wektorów:**
   - Strzałki wektorowe w płaszczyźnie są wyposażone w czytelne groty ekranowe.
   - W przypadku składowej prostopadłej do płaszczyzny ($n$), glify oznaczane są intuicyjnymi symbolami fizycznymi $\odot$ (skierowany w stronę obserwatora) oraz $\otimes$ (skierowany w głąb ekranu).
4. **Warstwy i paleta:**
   - Niezależne przełączanie widoczności: pole skalarne, krawędzie siatki, obrysy materiałowe, izolinie, wektory, punkty próbkowania oraz sondy.
   - Zmiana palety barwnej lub zakresu wartości odbywa się natychmiastowo na GPU bez konieczności ponownego pobierania danych.
5. **Eksport publikacyjny:**
   - Eksport do pliku JSON zawiera pełny manifest `PlanarFigureSpec`, dokładne metadane fizyczne, parametry kamery i identyfikator próbki `sample_token`, zapewniając 100% odtwarzalność naukową.

---

## 5. Instrukcja dla programisty

1. **Zasada spójności wiązki (`CoherentPlanarBundle`):**
   - Nigdy nie należy renderować rastra skalarnego bez zwalidowania zgodności identyfikatora `sample_token` oraz wymiarów z maską obecności materiału `maskBuffer`.
   - Flaga `isScientificReady` gwarantuje, że metadane, skalar, maska oraz krawędzie pochodzą z tej samej rewizji pola i siatki.
2. **Separacja GPU Rendering vs GPU Solver:**
   - Renderowanie WebGL w przeglądarce (`planarGpuRenderer.ts`) jest odrębną warstwą od solwera GPU i próbkowania backendowego.
   - Pola `field_backend`, `field_device` oraz `sampling_execution` w `PlanarFieldMetaResource` precyzyjnie opisują pochodzenie każdego etapu (provenance).
3. **Optymalizacje wydajnościowe:**
   - Wykorzystywany jest mechanizm single-flight deduplicating requestor w data plane.
   - Podział krawędzi siatki (`meshSegments`, `boundarySegments`, `interiorSegments`) jest keszowany na poziomie komponentu i unieważniany wyłącznie przy zmianie geometrii siatki.

---

## 6. Release Gate Checklist

- [x] **Kompilacja backendowa:** Czysty build Rust we wszystkich docelowych profilach.
- [x] **Testy jednostkowe Rust:** 61/61 testów `planar_sampling` PASS.
- [x] **Orakle i kontrprzykłady:** 10/10 testów kontrprzykładów analitycznych C01–C10 PASS.
- [x] **Typecheck TypeScript:** 0 błędów w `@fullmag/control-room`.
- [x] **Linter frontendowy:** 0 błędów i 0 ostrzeżeń ESLint.
- [x] **Testy jednostkowe frontend:** 185/185 testów modułu `field-map` oraz 62/62 testów `inspector/visualization` PASS.
- [x] **Testy kontraktu Pythona:** 5/5 testów `test_planar_monitor.py` oraz 42/42 testów walidatora PASS.
- [x] **Brak ścieżek legacy:** Całkowity brak odwołań do przestarzałych mechanizmów typu `_to_delete_legacy_web`.
- [x] **Zgodność z audytem COMSOL-grade:** Rozwiązanie wszystkich zidentyfikowanych ograniczeń i ustaleń P01–P03, N01–N10, G01–G04, U01–U07, E01, T01.
