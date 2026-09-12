# Results UI refactor masterplan — architektura nadrzędna

**Status:** plan do wdrożenia, nie implementacja  
**Dokument nadrzędny:** [`../2026-09-01-results-mode-sweep-ui-refactor-masterplan.md`](../2026-09-01-results-mode-sweep-ui-refactor-masterplan.md)  
**Audyt wejściowy:** [`../2026-09-01-results-mode-sweep-ui-audit-and-refactor-plan.md`](../2026-09-01-results-mode-sweep-ui-audit-and-refactor-plan.md)

## 1. Problem, który rozwiązujemy

Control Room ma obecnie kilka częściowo nakładających się systemów wyników:

- `ExplorerModule` buduje physics-first Results tree;
- osobny `results-navigator` buduje drugi frequency-domain tree;
- `analysis-plots` posiada własny wybór datasetu i routing artefaktów;
- Inspector mapuje bardzo dużą liczbę stringowych `selectionKinds`;
- viewport używa specjalnego `ModeFieldOverlayIntent` dla eigen i osobnej
  ścieżki response;
- FFT Gamma i DSF mają własne zasoby i wykresy bez wspólnej selekcji wynikowej;
- writer field sweep publikuje więcej informacji niż zachowuje typed API.

Każda z tych części jest lokalnie sensowna, ale całość nie tworzy jednego
kontraktu. Użytkownik może zobaczyć artefakt `Field Sweep`, lecz nie ma jednego,
pewnego przepływu:

```text
wartość pola -> sample -> właściwe mody -> właściwy wykres -> właściwe pole
```

Próba dodania kolejnych wyjątków dla `A_ex`, `M_s`, grubości, średnicy otworu,
prądu, geometrii i wielu osi utrwaliłaby ten problem.

## 2. Architektura docelowa

### 2.1. Warstwy

```text
solver-native artifacts
    ↓ walidacja, digest, status i adapter produktu
run-scoped Analysis Result Dataset API
    ↓ generated OpenAPI / ControlRoomApi / resource hooks
kernel AnalysisResultCursor + SelectionController
    ├── Results Navigator: wybór dataset/slice/item
    ├── Analysis Plots: projekcje tego samego slice
    ├── Inspector: szczegóły aktualnego fokusu
    └── Analysis Result Field Overlay
           ├── viewport-3d
           └── field-map
```

### 2.2. Zasada adaptera, nie uniwersalnego pliku

Nie powstaje jeden wielki JSON zastępujący wszystkie produkty. Każdy solver
zachowuje własny, naukowo właściwy artefakt:

- modal spectrum;
- field sweep;
- branches i dispersion;
- driven response sweep;
- temporal series;
- FFT spectra i spectral features;
- dynamic structure factor;
- response fields;
- fits i comparisons.

API wystawia wspólny indeks, który zawiera wyłącznie:

- tożsamość datasetu i źródeł;
- osie, jednostki i rolę osi;
- stabilne sample/item IDs;
- małe podsumowania;
- linki do projections, details, relations i fields;
- status kompletności i kwalifikacji.

Duże tablice nadal pozostają w wyspecjalizowanym data-plane.

## 3. Granice odpowiedzialności

### 3.1. Kernel

Kernel jest właścicielem:

- aktywnej karty lewego panelu;
- rejestru modułów i command registry;
- `SelectionController`;
- `AnalysisResultCursorController`;
- resource invalidation;
- aktywnego center-surface module;
- kontrolera pola wynikowego;
- małych zdarzeń synchronizacyjnych.

Kernel nie interpretuje fizyki modów, widm ani sweepów. Przenosi typed IDs i
wywołuje adaptery znajdujące się w shared domain/API layer.

### 3.2. Results Navigator

Results jest właścicielem:

- wyboru run/stage/dataset;
- drzewa rodzin produktów;
- widocznych kontrolek osi;
- sortowania, filtrów i kursora stron;
- wirtualizowanej listy sample/items;
- jawnych akcji `Open in Analysis`, `Plot field`, `Follow branch`, `Compare`,
  `Export`, `Reveal source`;
- aktualizacji `AnalysisResultCursor`.

Results nie przechowuje response bodies i nie renderuje ciężkich wykresów ani
pól.

### 3.3. Analysis

Analysis jest właścicielem:

- wyboru powierzchni i projekcji;
- mapowania osi do X/Y/series/facet/fixed;
- lokalnych jednostek wyświetlania;
- zakresu, legendy, widoczności serii i eksportu;
- ECharts lifecycle;
- mapowania klikniętego punktu do istniejącego `sampleId/itemId`.

Analysis nie posiada drugiego niezależnego wyboru datasetu. Odczytuje aktywny
`AnalysisResultCursor` i może go aktualizować wyłącznie przez tę samą komendę,
której używa Results.

### 3.4. Inspector

Inspector jest właścicielem prezentacji szczegółów fokusu:

- dataset;
- slice/sample;
- item;
- branch;
- field;
- relation;
- source artifact;
- job/diagnostic związany z wynikiem.

Inspector nie staje się właścicielem pola, datasetu ani selekcji. Kontrolki
wykonują commands.

### 3.5. Viewport i Field Map

Renderer jest właścicielem wyłącznie zasobów wykonawczych:

- field buffer lease;
- GPU buffers/textures;
- materiały i geometrię renderową;
- phase animation;
- dirty reasons;
- teardown.

Weryfikacja identity/topology odbywa się przed adopcją bufora. Renderer nie
naprawia braków danych i nie tworzy zer zastępczych.

## 4. Dwa rodzaje stanu: kontekst i fokus

### 4.1. Analysis Result Cursor

`AnalysisResultCursor` odpowiada na pytanie:

> Na jakim wyniku, zestawie współrzędnych i elemencie aktualnie pracuje
> przestrzeń Analysis/Results?

Cursor zawiera małe immutable IDs oraz revisions. Pozostaje aktywny, gdy
użytkownik na chwilę zaznaczy obiekt modelu, otworzy resource lub diagnostic.
Dzięki temu wykres i pole nie przeskakują przypadkowo.

### 4.2. Selection

`SelectionController` odpowiada na pytanie:

> Co jest obecnie fokusem Inspectora i interakcji?

Gdy selection ma typ `analysis-result`, musi wskazywać tę samą referencję co
cursor. Aktualizacja odbywa się atomowo przez command/controller, nie przez dwa
niezależne `setState`.

### 4.3. Inwariant synchronizacji

```text
selection.type != analysis-result
    => cursor może pozostać bez zmian

selection.type == analysis-result
    => selection.resultRef == cursor.resultRef

cursor zmienia dataset/sample/item
    => niezgodny field overlay staje się natychmiast nierenderowalny
```

## 5. Nazewnictwo domenowe

| Termin | Znaczenie |
|---|---|
| `dataset` | jeden wersjonowany produkt analizy, np. field sweep modalny |
| `axis` | jawna współrzędna datasetu z rolą, typem i jednostką |
| `sample` | punkt w przestrzeni outer/wavevector/replicate coordinates |
| `slice` | wybór ustalonych współrzędnych używany przez UI |
| `item` | element spektralny lub analityczny należący do sample/slice |
| `projection` | mały opis sposobu prezentacji danych, np. spectrum lub heatmap |
| `field` | przestrzenny payload związany z item/sample |
| `relation` | wersjonowane powiązanie między elementami/datasetami |
| `branch` | śledzona rodzina modów po jawnej ścieżce współrzędnych |
| `spectral feature` | pik/cecha FFT; nie eigenmode |
| `result mesh` | immutable topologia użyta przez konkretny sample |

## 6. Typy produktów

Minimalny katalog `product_kind`:

```text
modal_eigen
modal_dispersion
driven_response
driven_response_map
time_domain_series
time_domain_spectrum
spectral_features
dynamic_structure_factor
hysteresis
resonance_fit
modal_driven_comparison
convergence
```

Minimalny katalog `item_kind`:

```text
eigen_mode
branch
branch_point
response_point
spectral_feature
dsf_point
resonance_fit
time_trace
hysteresis_point
comparison_pair
```

Nazwy są semantyczne. Nie używamy jednego `mode` dla wszystkich wyników.

## 7. Role osi

| Rola | Przykłady | Zachowanie UI |
|---|---|---|
| `outer_sweep` | pole, `A_ex`, `M_s`, prąd, grubość, średnica otworu | selektor slice; opcjonalnie X/series/facet |
| `spectral` | częstotliwość eigen/drive/FFT | X/Y mapy lub item coordinate |
| `wavevector` | `k_x`, `k_y`, path coordinate | dyspersja, k-grid, cuts |
| `component` | `x/y/z`, observable | seria lub filtr |
| `spatial` | pozycja, plane, probe | field-map/profile |
| `replicate` | seed, realization | filtr/statystyka |

Wektorowe pole bias jest jedną osią `vector3`, lecz może publikować legalne
projekcje display: magnitude, `Hx`, `Hy`, `Hz` oraz komponent wzdłuż wskazanego
kierunku. UI nie wylicza ich na podstawie samej etykiety.

## 8. Statusy i zaufanie

Cztery osie stanu nie mogą zostać zredukowane do jednego `ready`:

| Oś | Wartości przykładowe |
|---|---|
| resource lifecycle | `idle`, `loading`, `ready`, `stale`, `error` |
| execution | `planned`, `queued`, `running`, `completed`, `failed`, `cancelled` |
| artifact completeness | `complete`, `partial`, `interrupted`, `corrupt`, `missing`, `unsupported` |
| qualification | `source_visible`, `unvalidated`, `algebra_validated`, `physics_validated`, `production_qualified` |

Inspector i status badges pokazują osobno przynajmniej completeness i
qualification. Background refresh zachowuje ostatni poprawny widok jako stale,
nie zastępuje go pustym loaderem.

## 9. Docelowy katalog kodu

```text
crates/fullmag-api/src/router_v2/handlers/analysis/results/
  mod.rs
  catalog.rs
  manifest.rs
  samples.rs
  items.rs
  projections.rs
  relations.rs
  adapters/
    modal_eigen.rs
    field_sweep.rs
    dispersion.rs
    driven_response.rs
    time_domain.rs

apps/control-room/src/kernel/resources/
  analysisResultResources.ts

apps/control-room/src/kernel/workspace/
  AnalysisResultCursorController.ts
  analysisResultCursorTypes.ts
  useAnalysisResultCursor.ts

apps/control-room/src/shared/domain/analysis/results/
  types.ts
  identity.ts
  selection.ts
  axisFormatting.ts
  status.ts
  projectionModels.ts
  compatibility.ts

apps/control-room/src/modules/results-navigator/
  ResultsNavigatorModule.tsx
  manifest.ts
  controller/
    useResultsNavigatorController.ts
  components/
    ResultContextBar.tsx
    ResultDatasetTree.tsx
    ResultSliceControls.tsx
    ResultItemList.tsx
    ResultItemRow.tsx
    ResultActionBar.tsx
    ResultStatusSummary.tsx
  store.ts

apps/control-room/src/modules/analysis-plots/
  hooks/useAnalysisResultProjection.ts
  resultProjectionSeriesAdapter.ts
  components/AnalysisAxisRoleControls.tsx

apps/control-room/src/modules/inspector/panels/analysis-results/
  ResultDatasetInspectorPanel.tsx
  ResultSliceInspectorPanel.tsx
  ResultItemInspectorRouter.tsx
  EigenModeResultInspectorPanel.tsx
  DrivenPointResultInspectorPanel.tsx
  SpectralFeatureResultInspectorPanel.tsx
  DsfPointResultInspectorPanel.tsx
  ResultFieldInspectorPanel.tsx
  ResultRelationInspectorPanel.tsx

apps/control-room/src/kernel/visualization/
  AnalysisResultFieldOverlayController.ts
  AnalysisResultFieldOverlayIntent.ts
  analysisResultFieldCommands.ts
```

Nazwy końcowe muszą zostać zamrożone w ADR przed zmianą publicznych typów, ale
podział odpowiedzialności jest normatywny.

## 10. Kolejność wdrażania

```text
P0 contract freeze
  -> P1 typed bias-field sweep parity
  -> P2 result dataset API
  -> P3 cursor + selection
  -> P4 panel-left host + duplicate Results removal
  -> P5 dataset/slice/item browser
  -> P6 Analysis projections
  -> P7 Inspector routing
  -> P8 generic field overlay
  -> P9 LLG/FFT/DSF adapters
  -> P10 generic/multi-axis/geometry sweeps
  -> P11 browser and performance qualification
  -> P12 compatibility cleanup
```

Żaden etap nie może używać kolejnego etapu jako wymówki do pozostawienia
niespójnego pionowego przepływu. Po P1 istniejący 15-punktowy field sweep ma być
używalny. P2-P8 uogólniają rozwiązanie bez regresji P1.

## 11. Zależności od innych planów

Masterplan konsumuje, ale nie duplikuje:

- frequency-domain artifact contract;
- K0 eigensolve production plan;
- time-domain spectral contracts/storage plan;
- time-domain spectral API/UI plan;
- frontend-v2 module, API, state, viewport, charts i cutover specs.

W przypadku konfliktu pierwszeństwo mają:

1. aktualny publiczny physics/IR contract;
2. accepted ADR;
3. frontend-v2 architecture specs;
4. niniejszy masterplan;
5. historyczne plany i compatibility code.

## 12. Zakazy

Nie wolno wdrożyć:

- dropdownu wartości pola niezwiązanego z `sampleId` i revision;
- joinu field sweep/spectrum po indeksie tablicy;
- float coordinate jako jedynej tożsamości;
- utrzymywania `raw_mode_index` jako branch po zmianie sample;
- parsowania `payload.extra` w React;
- listy wszystkich modów jako dzieci drzewa;
- preloadu wszystkich field payloads;
- przechowywania tablic FFT/pól/topologii w store;
- podpisania starego pola aktualnym mesh revision;
- traktowania FFT peak jako eigenmode;
- direct `fetch()` w module;
- ukrywania `partial/interrupted/corrupt` pod `ready`;
- równoległego wyboru datasetu w Results i Analysis;
- utrzymywania niewidocznego WebGL/ECharts po zmianie center tab.
