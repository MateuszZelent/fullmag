# 01 — Architektura informacji i kompletne przepływy użytkownika

## 1. Cel rozdziału

Ten rozdział zamraża docelowy układ produktu. Nie opisuje pojedynczego komponentu
React, lecz sposób, w jaki użytkownik porusza się między modelem, wykonaniem,
wynikiem, analizą, Inspectorem i wizualizacją przestrzenną.

Podstawowy inwariant interfejsu:

```text
każdy widoczny wynik ma jednego właściciela danych,
jedną tożsamość datasetu,
jedną aktywną współrzędną/slice,
jedną referencję wybranego elementu
i dowolną liczbę zsynchronizowanych prezentacji.
```

Prezentacjami mogą być:

- drzewo i lista w lewym panelu;
- wykres lub mapa w Analysis;
- szczegóły w Inspectorze;
- pole w viewport-3d lub field-map;
- diagnostyka i provenance;
- eksport.

## 2. Główny shell aplikacji

### 2.1. Układ desktopowy

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ App menu                                                                     │
├──────────────────────────────────────────────────────────────────────────────┤
│ Ribbon: Home | View | Definitions | Geometry | Materials | Physics | Mesh   │
│         Study | Results | Automation                                         │
├──────────────────────┬──────────────────────────────────┬────────────────────┤
│ PANEL LEFT           │ VIEWPORT MAIN                    │ PANEL RIGHT        │
│                      │                                  │                    │
│ Model                │ 3D / Field Map / Live Charts /  │ Inspector          │
│ Results              │ Analysis                         │                    │
│ Resources            │                                  │                    │
│ Jobs                 │                                  │                    │
│ Diagnostics          │                                  │                    │
│                      │                                  │                    │
├──────────────────────┴──────────────────────────────────┴────────────────────┤
│ PANEL BOTTOM: Telemetry | Engine | Logs | Mesh | Quick Chart | Diagnostics   │
├──────────────────────────────────────────────────────────────────────────────┤
│ Status bar: session | run | lane | device | precision | revisions | health   │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 2.2. Odpowiedzialność shellu

Kernel odpowiada za:

- aktywną kartę lewego panelu;
- aktywną kartę center surface;
- widoczność i rozmiary paneli;
- fokus klawiatury;
- globalną selekcję;
- aktywny result cursor;
- command registry;
- resource invalidation;
- modułowe mount/unmount.

Moduły nie tworzą drugiego shellu, własnych globalnych tabów ani ukrytych kopii
center surfaces.

### 2.3. Niezależność ribbonu i lewego panelu

Obecny `activationTab` łączy wybór modułu lewego panelu z kartą ribbonu. To jest
zbyt słabe dla docelowego produktu. Ribbon `Results` może otworzyć kartę Results,
ale użytkownik musi móc później przejść na `Study` ribbon i pozostawić Results w
lewym panelu albo przejść na `Model`, nie zmieniając center surface.

Docelowo:

```typescript
export type PanelLeftTabId =
  | "model"
  | "results"
  | "resources"
  | "jobs"
  | "diagnostics";

export interface LayoutState {
  activeRibbonTab: RibbonTabId;
  activePanelLeftTab: PanelLeftTabId;
  activeViewportMainModuleId: ModuleId;
  activeBottomPanelTab: BottomPanelTabId;
  // ...
}
```

Zmiana ribbonu może wysłać rekomendację otwarcia karty panelu, ale nie jest jej
trwałym właścicielem.

## 3. Karty lewego panelu

## 3.1. Model

Karta Model przedstawia intencję fizyczną i strukturę problemu, nie wyniki
wykonania.

```text
Model
└─ Session
   ├─ Definitions
   │  ├─ Parameters
   │  ├─ Functions
   │  ├─ Materials
   │  ├─ Coordinate systems
   │  └─ Named selections
   ├─ Universe
   │  ├─ Extent / periodicity
   │  ├─ Airbox
   │  │  ├─ Geometry
   │  │  ├─ Mesh parameters
   │  │  ├─ Quality gates
   │  │  ├─ Boundary conditions
   │  │  └─ Visualization
   │  └─ Boundary faces
   ├─ Objects
   │  ├─ Film
   │  │  ├─ Geometry
   │  │  ├─ Regions
   │  │  │  ├─ matrix
   │  │  │  │  ├─ Geometry / shape
   │  │  │  │  ├─ Material
   │  │  │  │  ├─ Magnetic parameters
   │  │  │  │  ├─ Initial texture
   │  │  │  │  ├─ Mesh
   │  │  │  │  └─ Visualization
   │  │  │  └─ antidot boundary region
   │  │  ├─ Material
   │  │  ├─ Magnetic parameters
   │  │  ├─ Initial texture
   │  │  ├─ Physics
   │  │  │  ├─ Exchange
   │  │  │  ├─ Demagnetization
   │  │  │  ├─ Anisotropy
   │  │  │  ├─ DMI
   │  │  │  ├─ Zeeman / drives
   │  │  │  └─ Couplings
   │  │  ├─ Mesh
   │  │  └─ Visualization
   │  └─ Antenna 1
   │     ├─ Geometry
   │     ├─ Current transport
   │     ├─ Field basis
   │     ├─ Excitation waveform
   │     └─ Visualization
   ├─ Couplings
   ├─ Physics graph
   ├─ Mesh
   │  ├─ Requested policy
   │  ├─ Shared domain
   │  ├─ Builds
   │  ├─ Regions / memberships
   │  ├─ Size fields
   │  ├─ Quality
   │  └─ Unassigned entities
   ├─ Study
   │  ├─ Execution policy
   │  ├─ Recovery / checkpoints
   │  └─ Stages
   │     ├─ Relaxation
   │     ├─ Bias-field sweep eigenmodes
   │     │  ├─ Setup
   │     │  ├─ Sweep definition
   │     │  ├─ Equilibrium policy
   │     │  ├─ Operator
   │     │  ├─ Boundary / k context
   │     │  ├─ Solver
   │     │  ├─ Outputs
   │     │  └─ Diagnostics
   │     ├─ Frequency response
   │     ├─ Time evolution
   │     └─ FFT / spectral analysis
   └─ Visualizations
      ├─ Planar monitors
      ├─ Cross sections
      ├─ Saved visualization presets
      └─ Active analysis field
```

### Reguły drzewa Model

1. Węzły opisują canonical model resources i authoring state.
2. `Active analysis field` jest jedynie referencją do aktualnej wizualizacji,
   nie kopią wyniku ani poddrzewem wszystkich modów.
3. Kliknięcie `Active analysis field` ustawia fokus Inspectora na konfigurację
   renderowania, ale nie zmienia dataset/slice w Results.
4. Węzeł stage może mieć akcję `Show results`, która przełącza kartę Results i
   wskazuje datasety wyprodukowane przez ten stage.
5. Węzeł obiektu może mieć akcję `Show result participation`, która otwiera
   odpowiednią projekcję lub filtr datasetu, o ile produkt publikuje
   component/object participation.

## 3.2. Results

Karta Results jest jedynym semantycznym nawigatorem wyników. Nie przedstawia
plików ani surowych endpointów.

### Drzewo wysokiego poziomu

```text
Results
├─ Run 2026-09-01 18:12 · antidot field sweep
│  ├─ Overview
│  ├─ Stage: Relaxation
│  │  ├─ Equilibrium state
│  │  ├─ Convergence
│  │  └─ Energies
│  ├─ Stage: K0 eigen field sweep
│  │  ├─ Modal eigen · field sweep                      [dataset]
│  │  ├─ Branch tracking                                [dataset]
│  │  ├─ Kittel comparison                              [dataset]
│  │  └─ Qualification / provenance                     [dataset]
│  ├─ Stage: Driven response
│  │  ├─ Harmonic response spectrum                     [dataset]
│  │  ├─ Field-frequency map                            [dataset]
│  │  ├─ Peaks and fits                                 [dataset]
│  │  └─ Response fields                                [dataset]
│  ├─ Stage: LLG dynamics
│  │  ├─ Time series                                    [dataset]
│  │  ├─ Temporal spectra                               [dataset]
│  │  ├─ Spectral features                              [dataset]
│  │  ├─ Dynamic structure factor S(k,f)                [dataset]
│  │  └─ Spatial response fields                        [dataset]
│  ├─ Comparisons
│  │  ├─ Modal vs driven
│  │  ├─ Mesh convergence
│  │  ├─ Device / precision parity
│  │  └─ Parameter-set comparison
│  └─ Exports
└─ Run 2026-08-31 22:45 · reference film
   └─ ...
```

### Dlaczego próbki i mody nie są dziećmi drzewa

Próbki mogą liczyć tysiące, a każdy sample może mieć setki elementów. Drzewo
zawiera tylko semantic datasets. Po wybraniu datasetu dolna część karty Results
pokazuje `Dataset/Slice Browser`.

### Układ karty Results

```text
┌──────────────────────────────────────────────┐
│ Result context                               │
│ Run [antidot-field-sweep ▼]  Stage [K0 ▼]   │
│ Search...                     Refresh        │
├──────────────────────────────────────────────┤
│ DATASET TREE                                 │
│ ▾ Stage: K0 eigen field sweep                │
│   ● Modal eigen · field sweep                │
│   ○ Branch tracking                          │
│   ○ Kittel comparison                        │
├──────────────────────────────────────────────┤
│ DATASET STATUS                               │
│ complete 15/15 · unvalidated · FEM CPU       │
├──────────────────────────────────────────────┤
│ SLICE / AXES                                 │
│ μ0 Hx [mT] [ 75.0 ▼ ] [◀] [▶]              │
│ k: Γ · geometry: antidot-r80nm                │
│ Preserve: [branch ▼]                         │
├──────────────────────────────────────────────┤
│ ITEMS                                        │
│ Filter [field ready]  Sort [frequency ▲]     │
│ ┌ B0  M0  5.142 GHz  r=2.1e-10  field ● ┐   │
│ ├ B1  M1  6.908 GHz  r=4.7e-10  field ● ┤   │
│ ├ —   M2  7.034 GHz  r=8.4e-10  spectrum ┤   │
│ └ ... virtualized / paged ...             ┘   │
├──────────────────────────────────────────────┤
│ Open Analysis | Plot field | Compare | ⋯    │
└──────────────────────────────────────────────┘
```

### Zachowanie przy małej szerokości

Dla panelu poniżej ustalonego breakpointu:

- dataset tree i browser są zakładkami `Datasets` / `Slice` / `Items`;
- status pozostaje widoczny w nagłówku;
- akcje drugorzędne trafiają do menu;
- etykiety osi nie są skracane bez tooltipu z nazwą, symbolem i jednostką;
- lista itemów zachowuje częstotliwość, status field i selection indicator.

### Reguły wyboru datasetu

1. Wybranie datasetu ustawia `datasetId` i `datasetRevision` w result cursor.
2. Cursor otrzymuje domyślne coordinates z manifestu albo ostatni legalny wybór
   użytkownika zapisany jako preference.
3. Pierwszy item nie jest automatycznie wybierany, jeśli zmiana datasetu mogłaby
   uruchomić pobranie pola. Auto-focus jest dozwolony wyłącznie dla lekkiego,
   jednoelementowego summary.
4. Zmiana revision zachowuje współrzędne po axis value token, o ile występują w
   nowej rewizji; item jest zachowany tylko przy identycznym stable item ID.
5. Usunięta współrzędna lub item powoduje jawny stan `selection no longer
   available`, nie ciche przejście do sąsiedniej pozycji.

## 3.3. Resources

Karta Resources prezentuje zasoby techniczne, a nie alternatywną semantykę
wyników.

```text
Resources
├─ Session
│  ├─ Status
│  ├─ Capabilities
│  └─ Revisions
├─ Model
│  ├─ Scene document
│  ├─ Definitions
│  └─ Physics graph
├─ Meshing
│  ├─ Topology
│  ├─ Coordinates
│  ├─ Memberships
│  └─ Build reports
├─ Runtime data
│  ├─ Field catalog
│  ├─ Scalar tables
│  ├─ Autosave stores
│  └─ Checkpoints
├─ Analysis
│  ├─ Result dataset catalog
│  ├─ Native artifacts
│  │  ├─ eigen/spectrum.v2
│  │  ├─ eigen/field_sweep.v1
│  │  ├─ eigen/branches.v2
│  │  ├─ response/magnetic_response_sweep.v2
│  │  ├─ time-domain spectra
│  │  └─ DSF
│  ├─ Field payload stores
│  └─ Relation / fit artifacts
└─ Persistence
   ├─ FMS manifest
   └─ Export bundles
```

### Cross-link Resources -> Results

Każdy analysis artifact, który należy do datasetu, ma akcję `Reveal owning
result`. Akcja używa opublikowanej relacji resource -> dataset, a nie wyszukuje
po nazwie pliku. Brak owner relation jest pokazany jako contract gap.

## 3.4. Jobs

Karta Jobs przedstawia wykonanie i publication pipeline.

```text
Jobs
├─ Run antidot-field-sweep                           completed
│  ├─ Stage relaxation                              completed
│  │  ├─ plan                                      completed
│  │  ├─ mesh/readiness                            completed
│  │  ├─ solve                                     completed
│  │  └─ publish equilibrium                       completed
│  ├─ Stage K0 eigen field sweep                    completed
│  │  ├─ plan 15 samples                           completed
│  │  ├─ sample 0 ... sample 14                    completed
│  │  ├─ branch tracking                           completed
│  │  ├─ artifact validation                       completed
│  │  ├─ result index publication                  completed
│  │  └─ browser qualification                     not started
│  └─ Commands
└─ Postprocessing jobs
   ├─ FFT analysis
   ├─ resonance fit
   └─ comparison
```

Każdy zakończony stage/job ma:

- `Show produced results`;
- `Show diagnostics`;
- `Show source stage`;
- `Open logs`;
- `Export receipt`.

`completed` wykonania nie oznacza `complete` artefaktu ani
`production_qualified` produktu. Wszystkie osie stanu pozostają widoczne.

## 3.5. Diagnostics

```text
Diagnostics
├─ Problems
├─ Platform health
├─ Capabilities
│  ├─ backend / device
│  ├─ modal solver
│  ├─ driven response
│  ├─ time-domain spectral
│  └─ visualization
├─ Solver
│  ├─ convergence
│  ├─ residuals
│  ├─ linear algebra
│  └─ execution / residency
├─ Mesh
├─ Result contracts
│  ├─ dataset catalog
│  ├─ source revision joins
│  ├─ sample/item identities
│  ├─ field/topology bindings
│  └─ compatibility readers
├─ Frequency domain
├─ Time-domain spectral
├─ Performance
│  ├─ resource requests
│  ├─ Results virtualization
│  ├─ chart instances
│  ├─ WebGL resources
│  ├─ field leases
│  └─ idle frames
└─ Resource cache
```

Diagnostic nie może naprawiać błędu przez fallback. Pokazuje:

- reason code;
- owner resource;
- expected i actual revision;
- affected selection/dataset;
- rekomendowaną akcję użytkownika;
- link `Reveal resource` lub `Reveal result`.

## 4. Center surfaces

## 4.1. Viewport 3D

Viewport 3D prezentuje:

- model geometry / solver topology;
- statyczne i dynamiczne fields;
- selected result field;
- vectors, scalar shader, clipping i animation;
- selection picking.

Nie pokazuje całej tabeli modów ani nie jest właścicielem dataset/slice.

## 4.2. Field Map

Field Map używa tej samej `fieldRef`, lecz własnego projection request:

- plane/slab/surface;
- scalar component/magnitude/phase;
- vectors/contours;
- probes i cuts;
- mesh overlay.

Zmiana z 3D na Field Map nie tworzy drugiej selekcji. Oba widoki konsumują
`AnalysisResultFieldOverlayIntent`, ale mają oddzielne leases renderowe.

## 4.3. Analysis

Docelowe powierzchnie Analysis:

```text
Dynamics
  Time Traces | Temporal Spectrum | Spectral Features | S(k,f) | Spatial Response

Resonance & FMR
  Eigenmodes | Driven Response | Field-Sweep Map | Modal–Driven

Dispersion
  Modal f_n(k) | Branches | Driven A(k,f) | Cuts

Hysteresis
  Loop | Branches | Metrics

Comparison
  Datasets | Difference | Convergence
```

Szczegóły znajdują się w rozdziale 05.

## 5. Panel right — Inspector

Inspector zawsze opisuje aktualny fokus. Dla result cursor możliwe są fokusa:

```text
Result dataset
Result slice/sample
Result item
Result branch
Result field
Result relation
Result source artifact
```

Nagłówek Inspectora dla każdego wyniku pokazuje breadcrumb:

```text
Run / Stage / Dataset / μ0Hx=75mT / Mode B1
```

Każdy segment jest akcją nawigacyjną, nie ręcznie składanym URL.

## 6. Panel bottom

- `Quick Chart` jest lekkim, jawnie przypiętym wykresem i nie przejmuje
  `AnalysisResultCursor`.
- `Telemetry` śledzi aktywne wykonanie, nie immutable result history.
- `Engine` i `Logs` pokazują dane wykonawcze.
- `Mesh` pokazuje build/quality.
- `Diagnostics` może śledzić aktywny dataset/field binding.

Akcja `Pin to Quick Chart` tworzy bounded descriptor zawierający dataset,
projection, coordinates, selected series i revision. Nie zapisuje punktów.

## 7. Przepływy użytkownika

## 7.1. 15-punktowy FEM K0 field sweep warstwy z otworem

### Wejście

1. Użytkownik wybiera ribbon `Results`.
2. Kernel otwiera kartę Results w lewym panelu, ale nie wymusza center surface.
3. Result context wskazuje aktualny run.
4. Użytkownik wybiera dataset `Modal eigen · field sweep`.

### Wybór pola

5. Manifest publikuje oś `bias_field` i conversion `mu0_H`.
6. UI domyślnie prezentuje komponent zgodny z kierunkiem sweepu, np.
   `μ0 Hx [mT]`, bez zmiany wartości SI w query.
7. Wybranie `75 mT` ustawia `sampleId`, coordinate token i sample revision.
8. Resource hook pobiera jedną stronę itemów tego sample.

### Wybór modu

9. Lista pokazuje stable mode ID, branch, frequency, residual, field status i
   completeness.
10. Kliknięcie modu atomowo ustawia result cursor oraz selection.
11. Inspector pobiera mode summary i field metadata.
12. Analysis aktualizuje spectrum tej samej próbki.
13. Dopiero akcja `Plot field` pobiera ciężki payload i aktywuje viewport.

### Zmiana próbki

14. Użytkownik przechodzi do `100 mT`.
15. Przed requestem nowego field aktualny overlay otrzymuje status
    `incompatible-with-cursor` i nie jest renderowany.
16. Przy `Preserve branch=B1` Results szuka itemu o tym samym stable `branchId`.
17. Jeśli branch ma gap, UI nie wybiera `raw_mode_index=1`; pokazuje `Branch B1
    absent at this coordinate`.
18. Bez preserve policy item selection jest czyszczony.

### Wyjście

19. `Open in Analysis` przełącza center surface na Analysis i otwiera
    `Resonance & FMR / Eigenmodes` bez tworzenia nowego dataset selection.
20. Kliknięcie punktu na wykresie wraca do dokładnie tego samego sample/mode w
    Results.

## 7.2. Pojedynczy finite-open eigensolve

- Dataset ma zero osi `wavevector`; context label brzmi `Finite system · k n/a`.
- Jeden sample może być domyślny i ukryty jako techniczna warstwa, ale stable
  `sampleId` nadal uczestniczy w identity.
- UI nie pokazuje `k=0`.
- Lista modów oraz pola działają jak w sweepie.

## 7.3. Fixed-k i k-path

### Fixed-k

- `k` jest outer coordinate sample.
- Nagłówek pokazuje dokładny vector `[kx, ky, kz] rad/m` i frame/convention.
- Pole zachowuje `wavevectorKf`, cell origin i Floquet convention.

### K-path

- Dataset ma oś `k_path_s` oraz vector coordinate dla każdego sample.
- Analysis domyślnie pokazuje `f_n(k)`.
- Results pozwala wybrać sample po label/path coordinate i następnie mode.
- `Follow branch` zachowuje branch ID po ścieżce, uwzględniając gaps i tracking
  confidence.
- Kliknięcie branch w Analysis ustawia branch focus; kliknięcie branch point
  ustawia sample oraz mode item.

## 7.4. Driven response z outer sweepem

Przykład: pole bias × częstotliwość drive.

```text
outer axis: μ0 Hx
spectral axis: drive frequency
item kind: response_point
observable: absorbed power / susceptibility / amplitude
field: optional complex response field
```

- Results wybiera wartość pola jako slice.
- Analysis pokazuje response spectrum po częstotliwości.
- Kliknięcie punktu ustawia `response_point`, nie `eigen_mode`.
- `Plot field` jest dostępne tylko przy opublikowanym response field.
- Widok `Field-Sweep Map` może ustawić pole jako X i częstotliwość jako Y.
- `Modal–Driven` korzysta z typed relation/comparison, nie dopasowuje punktów po
  kolejności.

## 7.5. LLG, temporal FFT i spectral features

1. Użytkownik wybiera dataset temporal series lub temporal spectrum.
2. Slice może określać region, probe, component i parametry outer sweepu.
3. Analysis pokazuje time trace albo FFT.
4. Kliknięcie piku ustawia item kind `spectral_feature`.
5. Inspector pokazuje source series, clock, `dt`, uniformity proof, window,
   detrend, normalization, frequency resolution i uncertainty.
6. `Plot spatial response` jest aktywne tylko przy rzeczywistym response field
   związanym z feature/bin.
7. Opcjonalna relacja `matched_eigen_mode` jest oddzielną sekcją z score i
   metodą. Brak relacji nie zmienia piku w eigenmode.

## 7.6. Dynamic structure factor

- Analysis pokazuje heatmap `S(k,f)`.
- Kliknięcie komórki ustawia `dsf_point` z stable sample/item tokenem, nie samą
  parą floatów.
- Results pokazuje współrzędne `k` i `f`, component oraz source observable.
- Inspector pokazuje spatial/temporal windows, excluded absorber ranges,
  sampling grid i provenance.
- Cuts po `k` lub `f` są projections tego samego datasetu.
- Pole przestrzenne jest opcjonalne i wymaga osobnego field ref.

## 7.7. Geometry sweep

Przykład: średnica otworu.

- Oś publikuje semantic parameter ID `geometry:antidot:diameter`, wartość SI i
  display unit `nm`.
- Każdy sample publikuje `geometrySnapshotId`, `meshId` i topology fingerprint.
- Zmiana sample ładuje właściwy immutable result mesh przed polem.
- Gdy result mesh endpoint nie istnieje, `Plot field` ma status `unsupported:
  result_mesh_unavailable`; UI nie używa bieżącego model mesh.
- Comparison dwóch geometrii może pokazać spectra bez wspólnej siatki, ale
  spatial difference wymaga jawnego transfer operatora i jego provenance.

## 7.8. Wielowymiarowy sweep

Przykład: `A_ex × μ0H × current density`.

- Każda oś ma rolę i stable ID.
- Results pokazuje wszystkie outer axes jako slice controls.
- Użytkownik może przypisać jedną oś do X/series/facet w Analysis.
- Pozostałe osie są fixed coordinates.
- Query używa tokenów wartości osi, nie kolejności dropdownów.
- Branch tracking jest zdefiniowany po konkretnej path axis i fixed slice.
  Nie istnieje automatyczna globalna branch na siatce 3D parametrów.

## 8. Cross-navigation

| Źródło | Akcja | Cel | Efekt na cursor | Efekt na selection |
|---|---|---|---|---|
| Model stage | Show results | Results dataset tree | ustawia run/stage, bez itemu | dataset focus |
| Jobs stage | Show produced results | Results | ustawia dataset domyślny | dataset focus |
| Resources artifact | Reveal owning result | Results | ustawia dataset | source/dataset focus |
| Results dataset | Open in Analysis | Analysis | zachowuje dataset/slice | dataset lub item |
| Results item | Plot field | viewport | zachowuje item | field focus po sukcesie |
| Analysis point | Reveal in Results | Results item list | ustawia sample/item | item focus |
| Inspector source | Reveal artifact | Resources | cursor bez zmian | resource focus |
| Inspector relation | Open related item | Results/Analysis | ustawia target dataset/item | target item focus |
| Viewport picked result layer | Inspect field | Inspector | cursor bez zmian | field focus |
| Diagnostics issue | Reveal affected result | Results | ustawia wskazany dataset/item | diagnostic/result focus |

Cross-navigation wykonują commands. Moduły nie importują swoich store ani
komponentów wzajemnie.

## 9. Breadcrumbs i deep links

Kanoniczny breadcrumb:

```text
Run / Stage / Dataset / coordinate summary / item
```

Deep link może kodować:

```text
runId
datasetId
datasetRevision
sampleId
itemId
projectionId
```

Nie koduje pełnych tablic coordinates ani field payloadu. Po otwarciu linku API
weryfikuje revision. Jeśli revision jest historyczna i dostępna, UI otwiera
immutable snapshot; jeśli nie, pokazuje jawny konflikt zamiast podmieniać na
latest.

## 10. Klawiatura i dostępność

### Karta Results

- `Ctrl+1..5` lub konfigurowalne shortcuts przełączają karty lewego panelu.
- Strzałki w drzewie rozwijają stage/dataset groups.
- `Tab` przechodzi tree -> axes -> filters -> item list -> actions.
- Strzałki w item list zmieniają focus bez pobrania field.
- `Enter` wybiera item.
- `Space` wykonuje skonfigurowaną primary action, domyślnie `Open in Analysis`,
  nie `Plot field`.
- `Alt+Left/Right` może przechodzić poprzedni/następny axis value, gdy fokus
  znajduje się w slice controls.
- Każdy row ma dostępne statusy w tekście, nie tylko kolorze.

### Wymogi etykiet

Etykieta próbki musi zawierać fizyczny kontekst:

```text
mu0 Hx = 75 mT, Gamma, sample 7, complete
```

`Sample 7` nie jest wystarczającą etykietą. Stable ID może być dostępne w
Inspectorze i tooltipie.

### Zoom i responsive

Przy 200% zoom:

- żadna primary action nie znika bez dostępu z menu;
- controls zawijają się pionowo;
- tabela zmienia się w listę z czytelnymi key/value;
- tooltip nie jest jedynym źródłem informacji;
- focus ring pozostaje widoczny.

## 11. Puste, częściowe i błędne stany

| Stan | UI |
|---|---|
| no run | instrukcja uruchomienia lub wyboru historycznego runu |
| no datasets | stage istnieje, ale nie opublikował wyników; reason code |
| loading first page | skeleton tylko w miejscu listy |
| refreshing | poprzednia strona pozostaje widoczna z badge `refreshing` |
| partial sample | itemy dostępne, brakujące pola oznaczone per-row |
| interrupted dataset | widoczne completed samples i stop reason |
| corrupt | dane nie są rysowane; link do contract diagnostics |
| stale revision | retained view + jawny mismatch i akcja reload/reopen snapshot |
| unsupported projection | dataset pozostaje używalny w innych projekcjach |
| field unavailable | item pozostaje wybieralny jako spectrum-only |
| result mesh unavailable | spectrum działa, spatial visualization zablokowana |

## 12. Kryteria akceptacji architektury informacji

- istnieje dokładnie jeden semantyczny Results owner;
- każda karta lewego panelu ma jednoznaczny zakres;
- pełny field sweep nie wymaga rozwinięcia 15×N węzłów drzewa;
- każda akcja cross-navigation ma typed command i test;
- żaden przepływ nie opiera identity na etykiecie lub float coordinate;
- Analysis, Inspector i viewport zachowują wspólny dataset/sample/item;
- finite-open, Gamma i nonzero-k są rozróżnione w całym UI;
- LLG peak jest spectral feature;
- geometry sweep nie renderuje na obcej topologii;
- UI działa klawiaturą i przy 200% zoom;
- stany partial/interrupted/corrupt/stale/unsupported są widoczne i odrębne.
