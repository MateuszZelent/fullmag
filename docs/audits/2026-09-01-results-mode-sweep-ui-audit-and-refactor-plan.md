# Audyt i plan refaktoryzacji UI wyników modalnych, sweepów oraz LLG/FFT

**Data audytu:** 2026-09-01  
**Repozytorium:** `MateuszZelent/fullmag`  
**Audytowany punkt odniesienia:** `master` @ `d6da81073d877aeff8b2aebe249012b3ca942d60`  
**Status:** audyt źródłowy i plan wykonawczy; bez promocji capability i bez deklaracji kwalifikacji runtime  
**Zakres:** Control Room, API v2, artefakty eigensolvera i driven response, zwykła dynamika LLG, FFT/DSF, wizualizacja pól 2D/3D oraz sweepy jedno- i wielowymiarowe

> Ten dokument nie opisuje kosmetycznej zmiany jednego dropdownu. Obecny problem
> wynika z rozdzielenia danych sweepu, widma, selekcji, wykresu i pola modowego
> na kilka niespójnych kontraktów. Naprawa musi zachować istniejące bramki
> naukowe i provenance, ale wprowadzić wspólny model `dataset -> slice/sample ->
> spectral item -> field` dla wszystkich rodzin solverów.

## 1. Werdykt wykonawczy

Obecny Control Room ma wartościowy, zaawansowany fundament dla pojedynczego
wyniku częstotliwościowego:

- można zidentyfikować pojedynczy eigenmode i pojedynczy punkt driven response;
- istnieją kontrolki części rzeczywistej, urojonej, modułu, fazy i animacji;
- warstwa pola 3D zachowuje `run`, `stage`, revision, topologię, reprezentację
  zespoloną i kontekst `k`;
- klasyfikacja rozróżnia układ skończony, punkt Gamma, ustalone `k`, ścieżkę `k`
  i siatkę `k`;
- zasoby HTTP są traktowane jako źródło prawdy, a nie lokalny stan komponentu.

Nie ma jednak kompletnej architektury wyników dla sweepów. UI jest obecnie
zorganizowane pionowo według konkretnych artefaktów i solverów, a nie według
wspólnego modelu danych. Skutki są następujące:

1. **Runner publikuje bogaty `eigen/field_sweep.v1`, lecz typ OpenAPI/API obcina
   większość jego semantyki.** Writer ma oś skanu, wartości pola, przeliczenie
   `mu0 H`, provenance stanu równowagi, branch IDs, listę modów, częstotliwości,
   residuale i referencje pól. Typ API wystawia jako pola jawne głównie
   `sample_id`, `sample_index`, `bias_field_a_per_m` i status. Pozostałe dane są
   co najwyżej ukryte w `flatten extra`, którego frontend zgodnie z zasadami API
   hygiene nie powinien zgadywać.
2. **`Field Sweep` i `Spectrum/Samples` są dwoma niezależnymi gałęziami UI.**
   `Field Sweep` nie zasila listy próbek i modów. Lista próbek pochodzi z widma,
   a adapter zastępuje fizyczną współrzędną etykietą w rodzaju
   `Sample bias-field-sample-0004`.
3. **Nie istnieje ogólny kontrakt osi sweepu.** Pole bias jest przypadkiem
   specjalnym. Sweep `A_ex`, `M_s`, `alpha`, grubości, średnicy otworu, prądu,
   parametrów anteny, temperatury, deformacji geometrii albo wielu parametrów
   równocześnie nie może być obsłużony bez kolejnych specjalnych artefaktów i
   kolejnych warunków w UI.
4. **Results Navigator jest praktycznie wyłącznie nawigatorem domeny
   częstotliwościowej bieżącego runu/stage.** Zwykłe LLG, FFT Gamma, piki FFT i
   dynamic structure factor nie są częścią tego samego drzewa ani tej samej
   selekcji.
5. **Pik FFT nie jest eigenmodem.** Obecny kod nie ma stabilnego obiektu
   selekcji dla piku ani przestrzennego pola odpowiedzi. Nie wolno rozwiązać
   tego przez automatyczne nazwanie każdego piku „Mode N”. Relacja pik–eigenmode
   może istnieć tylko jako osobny, wersjonowany wynik dopasowania z miarą
   pewności i provenance.
6. **Paginacja drzewa jest prezentacyjna, nie zasobowa.** Wszystkie dzieci są
   wcześniej materializowane w pamięci, a dopiero potem ukrywane na kolejnych
   stronach. Dla dużych sweepów i wielu modów nie jest to architektura
   produkcyjna.

**Rekomendacja:** nie przepisywać całej wizualizacji. Należy zachować istniejący
renderer, kontrolki fazy, klasyfikację `k`, resource cache i rygorystyczne bramki
pola. Trzeba natomiast:

- najpierw naprawić typed handoff istniejącego bias-field sweepu;
- następnie dodać wspólny, backend-neutralny indeks datasetów wynikowych;
- ujednolicić selekcję Results, Analysis, Inspector i viewport;
- dopiero na tej podstawie podłączyć driven response oraz nowe artefakty
  time-domain spectral analysis.

## 2. Zakres i źródła audytu

### 2.1. Warstwy objęte analizą

| Warstwa | Główne pliki / symbole |
|---|---|
| Artefakt modalnego sweepu | `crates/fullmag-runner/src/eigen/artifacts/field_sweep.rs` |
| Kontrakt referencyjny artefaktów | `docs/specs/frequency-domain-artifacts-v2.md` |
| API częstotliwościowe | `crates/fullmag-api/src/router_v2/handlers/analysis/frequency_domain.rs` |
| Zasoby Control Room | `apps/control-room/src/kernel/resources/studyRuntimeResources.ts`, `spinWaveResources.ts` |
| Results Navigator | `apps/control-room/src/modules/results-navigator/*` |
| Analysis | `apps/control-room/src/modules/analysis-plots/*`, `shared/domain/analysis/frequencyDomainChartModels.ts` |
| Globalna selekcja | `apps/control-room/src/kernel/selection/selectionTypes.ts` |
| Pole modalne / response | `AnalysisFieldOverlayController.ts`, `ModeFieldOverlayIntent.ts`, `analysisFieldOverlayCommandContributions.ts` |
| Inspector wizualizacji | `ModeVisualizationInspectorPanel.tsx`, panele `frequency-domain/*` |
| LLG/FFT Gamma | `crates/fullmag-runner/src/spin_wave_response.rs`, `SpinWaveGammaView.tsx` |
| Finite-k/DSF | `crates/fullmag-runner/src/spin_wave_sampling.rs`, `DynamicStructureFactorView.tsx` |
| Reguły frontend-v2 | `docs/specs/frontend-v2/01-module-kernel-architecture.md`, `03-api-integration-layer.md`, `04-state-management.md`, `16-charts-analysis-module.md` |

### 2.2. Powiązane dokumenty

Ten plan rozszerza, a nie zastępuje:

- `docs/specs/frequency-domain-artifacts-v2.md`;
- `docs/plans/active/fd_sovler_masterplan/27_fem_k0_eigensolve_production_completion_and_control_room.md`;
- `docs/audits/2026-08-31-time-domain-spectral-analysis-audit.md`;
- `docs/superpowers/plans/2026-08-31-time-domain-spectral-analysis-contracts-and-storage.md`;
- `docs/specs/frontend-v2/16-charts-analysis-module.md`.

Plan time-domain z 2026-08-31 celowo nie obejmuje UI. Niniejszy dokument
ustanawia docelowego konsumenta UI dla planowanych artefaktów `spectra`, `peaks`
i `response_fields`, bez zmiany fizyki FFT ani backendów LLG.

### 2.3. Ograniczenie dowodowe

Audyt jest analizą źródeł na wskazanym commicie. Nie wykonano w ramach tej
zmiany:

- nowego 15-punktowego solve;
- uruchomienia Control Room z prawdziwym artefaktem otworu;
- testu przeglądarkowego renderowania pola;
- pomiaru pamięci i czasu renderowania dużego sweepu;
- kwalifikacji CPU/GPU/FEM/FDM.

Każdy taki dowód jest osobną bramką końcowych faz planu.

## 3. Macierz aktualnych przepływów użytkownika

| Produkt | Dane źródłowe | Results | Analysis | Pole przestrzenne | Werdykt |
|---|---|---|---|---|---|
| Eigen, układ skończony, pojedyncza próbka | spectrum + per-mode metadata/field | częściowo | działa dla widma | istniejąca ścieżka jest mocna | zachować i uogólnić |
| Eigen, Gamma `k=0` | spectrum + manifest `k` | częściowo | klasyfikacja Gamma istnieje | obsługiwany kontekst `k` | brak wspólnej selekcji sweepu |
| Eigen, fixed non-zero `k` | spectrum/dispersion | częściowo | klasyfikacja fixed-k istnieje | overlay niesie `wavevectorKf` | brak jednolitego slice model |
| Eigen, `k_path` / `k_grid` | dispersion/branches | osobne węzły | wykres dyspersji | pole pojedynczego punktu możliwe | brak wspólnego wyboru osi i sample |
| Eigen, bias-field sweep | bogaty `field_sweep.v1` + spectrum | węzeł sweepu i niezależne Samples | brak pełnego wykresu pola–częstotliwość | referencje istnieją u producenta | **P0: typed handoff obcina dane** |
| Eigen, sweep materiału/geometrii/prądu | brak ogólnego indeksu | brak | brak | brak modelu topologii per sample | wymaga nowego kontraktu ogólnego |
| Driven response, pojedynczy frequency sweep | response sweep | punkty częstotliwości | wykres response | pojedynczy response field | zachować i włączyć do dataset model |
| Driven response + zewnętrzny sweep parametru | brak wspólnego modelu zagnieżdżonych osi | brak | brak | brak | wymaga osi `outer sweep + frequency` |
| LLG Gamma FFT | `spin_wave_response.gamma.v1` | brak | osobny widok | brak response field | pik jest tylko wierszem tabeli |
| LLG finite-k / DSF | `dynamic_structure_factor.1d.v1` | brak | heatmapa i lokalne cut controls | brak pola `(k,f)` | brak globalnej selekcji |
| Planowany LLG response field | artefakty z planu 2026-08-31 | brak konsumenta | brak | docelowo możliwe | podłączyć po wdrożeniu kontraktów |

## 4. Ustalenia krytyczne

### P0-1. Bogaty writer i zubożony typed API opisują ten sam artefakt inaczej

`FrequencyDomainFieldSweepArtifact` po stronie runnera zawiera:

- `scan_axis` z `kind`, `coordinate`, `unit` i konwersjami wyświetlania;
- per-sample `bias_field_a_per_m` i `bias_field_mu0_t`;
- SHA-256 równowagi, linearyzacji i sygnatury operatora;
- topologię próbki;
- `branch_ids`;
- pełne `modes[]`, w tym `mode_id`, `raw_mode_index`, `branch_id`, częstotliwość,
  residual, `mode_field_id`, resource key i source revision;
- complete/interrupted/status, requested/completed counts i cross-artifact refs.

Odpowiadający typ `FrequencyDomainFieldSweepSamplePayload` w API ma jawnie tylko
ID, indeks, wektor bias i status. Dane nie znikają koniecznie z surowego JSON,
ale znikają z bezpiecznego, generowanego kontraktu klienta. W rezultacie:

- Inspector słusznie oznacza widok jako `unsupported`;
- frontend nie może legalnie zbudować listy modów z field sweepu;
- nie może zweryfikować source revision pomiędzy sweepem, spectrum i branches;
- nie może odróżnić modu `spectrum-only` od modu z gotowym polem;
- nie może pokazać jednostek ani konwersji osi bez hardcode.

**Naprawa P0:** rozszerzyć typy API tak, aby zachowywały pełny kontrakt writera.
Nie wolno dodawać parsera `Record<string, unknown>` po stronie modułu UI ani
wydobywać wartości z `extra`.

### P0-2. `Field Sweep` nie jest źródłem próbek w Results

`ResultsNavigatorModule` ładuje field sweep, spectrum i branches niezależnie.
`resultsNavigatorModel.ts` tworzy węzeł `Field Sweep` jako pojedynczy artifact
node, ale `Samples` materializuje wyłącznie z `input.spectrum.samples`.
`navigatorSpectrumFromResource()` nadaje próbce etykietę
`Sample ${sampleId}` i nie zachowuje współrzędnych sweepu.

To wyjaśnia aktualne zachowanie: użytkownik może dotrzeć do technicznego sample
i jego modu, ale nie widzi, że sample odpowiada np. `mu0 H_x = 75 mT`.

**Naprawa P0:** po rozszerzeniu OpenAPI adapter field-sweep ma być źródłem
kanonicznej osi i współrzędnych. Spectrum pozostaje źródłem widma wtedy, gdy
sweep go referuje, ale join odbywa się wyłącznie po stabilnych ID i revision,
nie po pozycji w tablicy.

### P0-3. Brak ogólnego modelu osi i przekroju datasetu

Obecny model ma specjalne pojęcia `fieldSweep`, `response`, `dispersion` i
`spectrum`. Nie ma abstrakcji:

- lista osi;
- rola osi;
- typ wartości;
- kanoniczna jednostka;
- wybrane współrzędne;
- projekcja wyświetlania;
- wielowymiarowy slice;
- lista elementów spektralnych należących do wybranego slice.

Dodanie kolejnych pól typu `current_sweep`, `thickness_sweep`,
`geometry_sweep` powieli obecny problem.

**Naprawa P0/P1:** wprowadzić ogólny indeks datasetu jako control-plane adapter
nad fizycznymi artefaktami. Nie zastępować nim specjalistycznych artefaktów
naukowych.

### P0-4. Results, Analysis, Inspector i viewport nie wybierają tego samego obiektu

Selection ref domeny częstotliwościowej zawiera wiele wartości opcjonalnych,
ale nie posiada obowiązkowego `dataset_id`, `dataset_revision` i kanonicznego
zestawu współrzędnych sweepu. Mode selection, response selection i view selection
są budowane osobnymi helperami. Analysis dodatkowo wyznacza trasę wykresu na
podstawie subview/calculation mode.

Skutki:

- można wybrać węzeł sweepu bez wybrania jego próbki;
- wykres może reprezentować inny przekrój niż lista modów;
- zmiana próbki nie ma jednej reguły aktualizacji chart/inspector/viewport;
- odtworzenie deep-linku wymaga zgadywania z indeksów.

**Naprawa:** jedna globalna, semantyczna selekcja `analysis-result`, oparta na
stabilnych ID. Stare `frequency-domain` refs pozostają wyłącznie za ograniczonym
adapterem migracyjnym.

### P0-5. LLG/FFT nie jest częścią systemu wyników

`SpinWaveGammaView` oraz `DynamicStructureFactorView` są samodzielnymi
prezentacjami. Piki i komórki `(k,f)` nie ustawiają kernel selection, nie
otwierają wspólnego Inspectora i nie przekazują pola do viewportu.
`ResultsNavigatorModule` w ogóle nie ładuje tych zasobów.

**Naprawa:** po wdrożeniu planowanych canonical time-domain artifacts dodać
adaptery datasetów `time_domain_spectral`. Legacy Gamma/DSF mogą być czytane
przez bounded compatibility adapter, ale nie mogą wyznaczać docelowego schema.

### P0-6. Pik FFT nie może być automatycznie nazwany modem

`SpectrumPeak` ma indeks, częstotliwość i moc. To detekcja lokalnego maksimum
wybranego observable, nie rozwiązanie problemu własnego. Ten sam eigenmode może:

- nie pojawić się dla danej symetrii wzbudzenia;
- dać kilka struktur w nieliniowej dynamice;
- nakładać się z innym modem;
- przesunąć się wskutek amplitudy i nieliniowości;
- mieć różne udziały w różnych obserwablach.

Docelowy typ powinien nazywać taki obiekt `spectral_feature` albo `peak`. Relacja
`matched_eigen_mode` jest opcjonalnym derived artifact zawierającym metodę,
score, tolerancję, source revisions i status kwalifikacji.

## 5. Pozostałe problemy architektoniczne

### P1-1. Pobieranie pola nadal używa indeksów prezentacyjnych

Hooki `useFrequencyDomainEigenModeResource(sampleIndex, modeIndex)` i
`useFrequencyDomainEigenModeFieldMetaResource(sampleIndex, modeIndex)` odwołują
się do endpointów indeksowych, mimo że selection przechowuje stabilne
`sampleId` i `modeId`. Podobnie driven response pobiera field meta przez
`frequencyIndex`.

Indeks jest dopuszczalny jako zoptymalizowany locator tylko wtedy, gdy serwer
weryfikuje równocześnie stabilne ID i source revision. Nie może być globalną
tożsamością wyniku.

### P1-2. Lokalne stronicowanie nie ogranicza materializacji

`ResultsNavigatorTree` tnie `node.children` na strony po zbudowaniu wszystkich
węzłów. `buildFrequencyDomainTree` wcześniej mapuje wszystkie samples, modes,
branches i response points. Dla np. 10 000 próbek po 100 modów oznacza milion
obiektów React-domain przed pokazaniem pierwszej strony.

Docelowe API musi dostarczać cursor/page resources, a UI powinno używać
virtualized list. Repozytorium ma już `@tanstack/react-virtual`, więc nie ma
potrzeby tworzenia własnej wirtualizacji.

### P1-3. Results jest związany z bieżącym aktywnym run/stage

Tożsamość jest wyprowadzana z `currentRun` i aktywnego stage. Nie jest to pełny
browser wyników historycznych ani porównań. Pierwsza implementacja może nadal
używać current session, ale dataset identity nie może zawierać ukrytego
założenia, że wynik zawsze pochodzi z aktywnego stage.

### P1-4. Wartość wektorowa pola wymaga jawnej projekcji

Pole bias jest wektorem w A/m. Użytkownik zwykle chce zobaczyć np. `mu0 H_x` w
mT, wartość bezwzględną albo składową zgodną z osią skanu. Nie wolno redukować
wektora do jednego float bez zapisania projekcji.

Kontrakt osi powinien rozdzielać:

- kanoniczną wartość `[Hx, Hy, Hz]` w A/m;
- semantyczną projekcję `component_x`, `component_y`, `component_z`, `magnitude`
  albo `path_coordinate`;
- konwersję wyświetlania, np. `mu0_H` w T/mT;
- formatowanie i tolerancję prezentacji.

### P1-5. Sweep geometrii może zmieniać topologię

Dla sweepu średnicy otworu, grubości, szerokości albo liczby elementów próbki
mogą mieć różne meshe. Obecny overlay poprawnie odrzuca pole niezgodne z
aktualną topologią, ale UI nie ma modelu „mesh należący do wybranej próbki”.

Docelowo każda próbka musi mieć własne `mesh_id`, generation/revision i topology
fingerprint. Wizualizacja może:

1. załadować immutable mesh snapshot należący do próbki; albo
2. fail-closed pokazać „field unavailable in current geometry context”.

Nie wolno podpisać pola starej geometrii bieżącą siatką tylko dlatego, że liczba
węzłów jest równa.

### P1-6. Numer modu nie jest identyfikatorem gałęzi

`raw_mode_index` może zmienić znaczenie przy przejściu przez unikane
skrzyżowanie, degenerację, zmianę okna spektralnego lub brak modu. UI musi
rozróżniać:

- `mode_id`: stabilny identyfikator rekordu w jednej próbce;
- `raw_mode_index`: porządek prezentacyjny w tej próbce;
- `branch_id`: wynik osobnego trackingu pomiędzy próbkami;
- `tracking_score`, gaps i fallback reason.

Przy zmianie wartości sweepu zaznaczenie może być przeniesione automatycznie
wyłącznie po zweryfikowanym `branch_id`. Bez trackingu należy wyczyścić wybrany
mode, a nie wybrać ten sam numer z nowej próbki.

### P1-7. Szczegółowe węzły są deklarowane, lecz oznaczone `unsupported`

Mode nodes tworzą dzieci Metadata/Field/Residuals, a response points tworzą
Observables/Field, ale wszystkie te dzieci mają status `unsupported` z tekstem,
że transport ich nie udostępnia. Jednocześnie inne panele pobierają część tych
danych przez osobne hooki indeksowe. To sygnał duplikacji granic zasobów.

### P1-8. Rewizja zasobów time-domain jest za słaba

Legacy zasoby spin-wave wyznaczają revision w sposób niewystarczający do
rozróżnienia dwóch artefaktów tej samej wersji schema. Docelowy manifest musi
publikować content/source digest, a resource cache musi używać rzeczywistej
rewizji danych.

### P2-1. Etykiety response points nie pokazują częstotliwości

Adapter zachowuje `frequencyHz`, ale model drzewa etykietuje rekord jako
`Point <id>` lub `Frequency <index>`. Fizyczna wartość powinna być podstawową
etykietą, a ID pozostawać w szczegółach/provenance.

### P2-2. Kontrolki phase/render są związane binarnym rozgałęzieniem source

`ModeVisualizationInspectorPanel` wybiera komendę i hook przez warunek
`eigen-mode` kontra `frequency-response`. Dodanie `time-domain-response-field`
spowoduje kolejne warunki. Potrzebny jest registry/adapter źródła pola, nie
rosnący łańcuch `if`.

## 6. Zasady docelowej architektury

1. **Artefakty specjalistyczne pozostają źródłem prawdy.** Ogólny dataset index
   nie zastępuje `eigen/field_sweep`, `eigen/spectrum`, driven response ani
   time-domain spectral artifacts. Indeks łączy je typed referencjami.
2. **Stabilne ID są tożsamością; indeksy są locatorami prezentacyjnymi.**
3. **Współrzędna kanoniczna i format wyświetlania są rozdzielone.** Nigdy nie
   używać tekstu `75 mT` ani surowego float jako ID.
4. **Selection przechowuje małe identyfikatory, nie tablice danych.**
5. **HTTP resource jest autorytatywny; realtime tylko unieważnia resource key.**
6. **Duże tablice pozostają w Zarr/HDF5/binary/tiled data plane.** JSON jest
   control plane.
7. **Pole ładuje się dopiero po jawnej selekcji elementu z field ref.**
8. **Topologia, revision, representation i units pozostają fail-closed.**
9. **Pik FFT, response point i eigenmode są różnymi typami.**
10. **Results i Analysis nie współdzielą prywatnych store.** Synchronizują się
    przez kernel selection i wspólne resource contracts.
11. **Zmiana filtra, jednostki albo lokalnego sortowania nie wywołuje solve ani
    nie pobiera pola 3D.**
12. **Partial/incomplete/interrupted/corrupt nie są upraszczane do `ready`.**

## 7. Docelowy model domenowy

### 7.1. Indeks datasetu jako warstwa control plane

Proponowana nazwa robocza schema:

```text
fullmag.analysis.result_dataset_index.v1
```

Jest to indeks/adaptor, nie nowy format dużych danych.

```rust
pub struct AnalysisResultDatasetManifest {
    pub schema_version: String,
    pub dataset_id: String,
    pub dataset_revision: String,
    pub run_id: String,
    pub stage_id: String,
    pub product: AnalysisProduct,
    pub source_artifacts: Vec<VersionedArtifactRef>,
    pub status: AnalysisStatus,
    pub completeness: AnalysisCompleteness,
    pub axes: Vec<AnalysisAxisDescriptor>,
    pub default_projection: AnalysisProjectionDescriptor,
    pub sample_index_resource: String,
    pub item_index_resource: String,
    pub plot_projection_resources: Vec<AnalysisProjectionRef>,
    pub k_context: Option<KContext>,
    pub units_policy: UnitsPolicy,
    pub qualification: QualificationSummary,
}

pub enum AnalysisProduct {
    ModalEigen,
    DrivenResponse,
    TimeDomainSpectral,
    DynamicStructureFactor,
    ModalDrivenComparison,
}
```

### 7.2. Osie

```rust
pub struct AnalysisAxisDescriptor {
    pub axis_id: String,
    pub semantic: String,
    pub role: AnalysisAxisRole,
    pub value_kind: AnalysisAxisValueKind,
    pub canonical_unit: String,
    pub display_conversions: Vec<DisplayConversion>,
    pub ordered: bool,
    pub cardinality: Option<u64>,
    pub values_resource: Option<String>,
}

pub enum AnalysisAxisRole {
    OuterSweep,
    Spectral,
    Wavevector,
    Component,
    Spatial,
    Replicate,
}

pub enum AnalysisAxisValueKind {
    Scalar,
    Vector3,
    Categorical,
    EntityRef,
}
```

Przykłady:

| Parametr | `semantic` | rodzaj | jednostka kanoniczna | projekcja UI |
|---|---|---|---|---|
| pole bias | `bias_field_a_per_m` | vector3 | A/m | `mu0 Hx`, `mu0 |H|`, mT |
| `A_ex` | `exchange_stiffness_j_per_m` | scalar | J/m | pJ/m |
| `M_s` | `saturation_magnetization_a_per_m` | scalar | A/m | kA/m |
| alpha | `gilbert_damping` | scalar | `1` | bez prefiksu SI |
| prąd | `current_a` lub `current_density_a_per_m2` | scalar | A albo A/m² | mA, MA/cm² |
| grubość | `geometry.thickness_m` | scalar | m | nm |
| średnica otworu | `geometry.hole_diameter_m` | scalar | m | nm |
| wariant materiału | `material_ref` | entity_ref | `1` | nazwa + immutable ID |
| wariant geometrii | `geometry_ref` | entity_ref | `1` | nazwa + immutable ID |
| `k` | `wavevector_rad_per_m` | vector3/path coordinate | rad/m | rad/um albo normalized |
| częstotliwość drive | `frequency_hz` | scalar/spectral | Hz | GHz |

### 7.3. Próbka / slice

„Próbka” oznacza jeden rozwiązany punkt zewnętrznych osi sweepu. Dla sweepu
jednowymiarowego ma jedną współrzędną. Dla sweepu `current x thickness` ma dwie.

```rust
pub struct AnalysisSampleIndexEntry {
    pub sample_id: String,
    pub sample_index: Option<u64>,
    pub coordinates: Vec<AnalysisCoordinate>,
    pub status: AnalysisStatus,
    pub item_count: u64,
    pub branch_count: Option<u64>,
    pub source_revision: String,
    pub equilibrium_ref: Option<VersionedArtifactRef>,
    pub linearization_ref: Option<VersionedArtifactRef>,
    pub mesh_identity: Option<MeshIdentity>,
    pub topology_fingerprint: Option<String>,
    pub items_resource: String,
}
```

API musi udostępniać próbki stronicowane i filtrowane po kanonicznych wartościach
lub stabilnych tokenach osi. Nie wolno wymagać pobrania pełnego iloczynu
kartezjańskiego.

### 7.4. Element spektralny

```rust
pub enum SpectralItemKind {
    EigenMode,
    DrivenFrequencyPoint,
    SpectralFeature,
    ResonanceFit,
    DispersionPoint,
    DynamicStructureFactorPoint,
}

pub struct AnalysisSpectralItemSummary {
    pub item_id: String,
    pub item_kind: SpectralItemKind,
    pub sample_id: String,
    pub display_index: Option<u64>,
    pub frequency_hz: Option<f64>,
    pub wavevector_rad_per_m: Option<[f64; 3]>,
    pub branch_id: Option<String>,
    pub status: AnalysisStatus,
    pub quality: AnalysisQualitySummary,
    pub field_ref: Option<AnalysisFieldRef>,
    pub detail_resource: String,
    pub source_revision: String,
    pub relations: Vec<AnalysisItemRelation>,
}
```

`field_ref = null` oznacza legalny wynik bez pola przestrzennego. UI pokazuje
wtedy „spectrum only” albo „response field not captured”; nie tworzy pola
zerowego.

### 7.5. Relacje

Relacje powinny być jawne i wersjonowane:

- `branch_membership`;
- `source_response_point`;
- `source_peak`;
- `matched_eigen_mode`;
- `derived_resonance_fit`;
- `same_physical_sample`;
- `comparison_counterpart`.

Przykładowe dopasowanie piku FFT:

```json
{
  "relation": "matched_eigen_mode",
  "target_dataset_id": "dataset:eigen:...",
  "target_sample_id": "sample:...",
  "target_item_id": "mode:...",
  "method": "frequency_and_spatial_overlap.v1",
  "score": 0.93,
  "frequency_delta_hz": 12000000.0,
  "source_revision": "sha256:...",
  "target_revision": "sha256:...",
  "qualification": "diagnostic"
}
```

Brak takiego artefaktu oznacza brak dopasowania, a nie błąd UI.

## 8. Docelowy kontrakt API i resource keys

Nazwy tras poniżej są propozycją do zamrożenia w ADR. Ważniejsza od konkretnego
URL jest semantyka zasobów.

```text
GET /v2/sessions/current/analysis/results/datasets
GET /v2/sessions/current/analysis/results/datasets/{dataset_id}
GET /v2/sessions/current/analysis/results/datasets/{dataset_id}/axes/{axis_id}/values
GET /v2/sessions/current/analysis/results/datasets/{dataset_id}/samples?cursor=...&filters=...
GET /v2/sessions/current/analysis/results/datasets/{dataset_id}/samples/{sample_id}
GET /v2/sessions/current/analysis/results/datasets/{dataset_id}/samples/{sample_id}/items?cursor=...&sort=...
GET /v2/sessions/current/analysis/results/datasets/{dataset_id}/projections/{projection_id}?slice=...
GET /v2/sessions/current/data/fields/{field_id}/meta
GET /v2/sessions/current/data/fields/{field_id}/vector?...existing bounded query...
```

Dla przyszłego browsera historycznych sesji ten sam model powinien działać pod
trasą z jawnym `session_id`/`run_id`; current session może być aliasem, nie częścią
tożsamości datasetu.

Proponowane resource keys:

```text
analysis:results:dataset-catalog
analysis:results:dataset:{datasetId}:manifest
analysis:results:dataset:{datasetId}:axis:{axisId}:values:{pageKey}
analysis:results:dataset:{datasetId}:samples:{filterHash}:{cursor}
analysis:results:dataset:{datasetId}:sample:{sampleId}:items:{queryHash}:{cursor}
analysis:results:dataset:{datasetId}:projection:{projectionId}:{sliceHash}
data:field:{fieldId}:meta:{revision}
data:field:{fieldId}:vector:{queryHash}:{revision}
```

### 8.1. Adapter zamiast migracji wszystkich producentów naraz

Pierwsza wersja `result_dataset_index` może być budowana przez API z istniejących
artefaktów:

- `eigen/field_sweep.v1` + `spectrum.v2/v3` + `branches.v2`;
- response sweep + FMR peaks/fits;
- dispersion + path metadata;
- później canonical time-domain spectral manifest.

Warunki:

- wszystkie relacje muszą być sprawdzane przez source revision;
- brakujące referencje dają `partial`, nie cichy join po indeksie;
- adapter nie modyfikuje danych fizycznych;
- wynik adaptera ma własny content digest;
- po ustabilizowaniu schema runner może zacząć zapisywać ten indeks jako
  artefakt, ale API nadal go waliduje.

## 9. Docelowa selekcja kernelowa

Proponowany nowy wariant:

```ts
interface AnalysisResultSelectionRef {
  type: "analysis-result";
  kind:
    | "dataset"
    | "slice"
    | "sample"
    | "spectral-item"
    | "branch"
    | "field"
    | "projection-point";

  datasetId: string;
  datasetRevision: string;
  runId: string;
  stageId: string;

  sampleId?: string;
  coordinates?: readonly AnalysisCoordinateRef[];

  itemKind?: SpectralItemKind;
  itemId?: string;
  branchId?: string;
  frequencyHz?: number;
  wavevectorKf?: readonly [number, number, number];

  fieldId?: string;
  fieldRevision?: string;
  resourceRef?: string;

  meshId?: string;
  topologyFingerprint?: string;
  equilibriumId?: string;
  normalization?: string;
}
```

W selection nie należy przechowywać:

- całej listy osi/próbek/modów;
- payloadu wykresu;
- tablic FFT;
- field vector;
- ECharts options;
- obiektów rendererowych.

### 9.1. Reguły zmiany próbki

Po zmianie współrzędnej sweepu:

1. ustawić nowy `sampleId` i coordinate tuple;
2. załadować stronę items dla tej próbki;
3. jeżeli poprzedni item miał certyfikowany `branchId`, spróbować znaleźć ten
   branch w nowej próbce;
4. jeśli gałęzi nie ma albo tracking jest niewiarygodny, wyczyścić item/field;
5. zaktualizować listę modów i wykres z tego samego slice;
6. nie pobierać field vector, dopóki item z `field_ref` nie zostanie wybrany;
7. po wyborze pola zweryfikować jego revision i topologię przed renderem.

### 9.2. Migracja starych refów

Stare `type: "frequency-domain"` może być odczytywane przez jeden adapter w
kernel selection boundary. Adapter:

- wyszukuje dataset po artifact revision;
- mapuje stable sample/mode/point ID;
- odrzuca ref, jeżeli ma tylko indeks bez zgodnej revision;
- nigdy nie zapisuje ponownie starego wariantu;
- ma określony test i warunek usunięcia po jednej wydanej wersji schema
  preferencji/selekcji.

## 10. Docelowy UX Results

### 10.1. Results Navigator ma nawigować po datasetach, nie materializować cały cube

Docelowe drzewo wysokiego poziomu:

```text
Results
└── Run / Stage
    ├── Modal Eigen
    │   ├── Dataset: Bias field sweep
    │   ├── Dataset: k path
    │   └── Dataset: Material sweep
    ├── Driven Response
    │   └── Dataset: Bias field x drive frequency
    └── Time-domain Spectral
        ├── Dataset: Gamma FFT
        └── Dataset: S(k,f)
```

Po wybraniu datasetu Results pokazuje kompaktowy browser slice, zamiast rozwijać
miliony dzieci:

```text
Dataset: FEM K0 eigen · antidot · field sweep
Status: 15/15 complete       k: Gamma       field payloads: 240/240

Sweep coordinates
  X axis: mu0 Hx [mT]    [ 75.0 ▼ ]  [<] [>]
  Fixed: Hy = 0 mT, Hz = 0 mT

[Modes] [Branches] [Spectrum] [Provenance]

Mode/branch   f [GHz]   residual      field       status
B0 / M0       5.142     2.1e-10       ready       complete
B1 / M1       6.908     4.7e-10       ready       complete
—  / M2       7.034     8.4e-10       spectrum    partial
```

Wartość `75.0 mT` jest wyświetleniem. Selekcja nadal zawiera stabilne `sampleId`
i kanoniczny wektor A/m.

### 10.2. Kontrolki osi

- dla uporządkowanej osi o małej cardinality: select + poprzedni/następny +
  opcjonalny slider z tickami;
- dla dużej osi: searchable, virtualized combobox;
- dla kategorii/entity: etykieta oraz immutable ID w tooltip/provenance;
- dla vector3: wybór projekcji bez utraty wektora kanonicznego;
- dla dwóch osi: jedna może być osią wykresu, druga fixed selector;
- dla trzech i więcej osi: jawny zestaw fixed coordinates oraz wybór osi X/Y;
- brak wartości/partial sample pozostaje widoczny jako luka, a nie znika z osi.

### 10.3. Synchronizacja

Jedna akcja użytkownika ma dać deterministyczny efekt:

- wybór wartości sweepu aktualizuje mode list, spectrum i Inspector;
- wybór punktu na spectrum zaznacza ten sam item w liście;
- wybór mode w liście podświetla punkt wykresu;
- wybór item z field ref aktywuje wspólny viewport;
- zmiana fazy nie zmienia sample ani item;
- zmiana display unit nie zmienia selection ani nie pobiera danych;
- otwarcie Analysis zachowuje dokładnie ten sam dataset/slice/item.

### 10.4. Zachowanie dla 15-punktowego sweepu warstwy z otworem

Minimalny przepływ kwalifikacyjny:

1. Results pokazuje jeden dataset z 15 próbkami i fizyczną osią pola.
2. Użytkownik wybiera np. `mu0 Hx = 50 mT`.
3. Lista modów zawiera wyłącznie mody należące do tego sample.
4. Spectrum pokazuje te same częstotliwości i tę samą revision.
5. Kliknięcie modu pokazuje częstotliwość, branch, residual, kompletność i
   provenance równowagi.
6. Kliknięcie `Field` pobiera pole tego samego `sampleId/modeId`.
7. Zmiana na `75 mT` nie pozostawia starego pola w viewport. Pole jest
   unieważnione lub zastąpione dopiero po pomyślnej walidacji nowego payloadu.
8. Przy zgodnym branch tracking opcja „follow branch” wybiera ten sam branch;
   bez trackingu selection item jest czyszczone.

## 11. Docelowy UX Analysis

Analysis pozostaje osobnym center module i działa tylko na jawnie wybranym
dataset/slice, zgodnie z frontend-v2.

### 11.1. Modal eigen

Dostępne projekcje:

- spectrum dla jednej próbki: `mode/branch -> frequency`;
- field-frequency map: `sweep coordinate -> frequency`, seria per branch;
- dispersion: `k path coordinate -> frequency`, seria per branch;
- quality map: residual/participation/status;
- modal participation per object/component;
- porównanie dwóch jawnie wybranych datasetów.

### 11.2. Driven response

- outer sweep coordinates wybierają próbkę fizyczną;
- częstotliwość drive jest osią spectral;
- wykres pokazuje observable wraz z prawidłową jednostką;
- kliknięcie punktu wybiera `DrivenFrequencyPoint`;
- peak/fits pozostają derived items z referencją do source response revision;
- response field jest renderowane tylko, jeśli istnieje jawny field ref.

### 11.3. Multi-axis

Przykład `current x thickness x frequency`:

- `current` wybierane jako oś X albo fixed coordinate;
- `thickness` wybierane jako drugi selector albo oś serii;
- `frequency` pozostaje osią spectral dla driven response;
- UI pokazuje pełny opis slice nad wykresem;
- eksport zawiera wszystkie fixed coordinates i dataset revision.

### 11.4. LLG/FFT

- `spectral_feature` może zostać wybrany z wykresu lub tabeli;
- Inspector pokazuje window, detrend, sampling clock, Nyquist, source drive,
  uncertainty/linewidth i observable;
- jeżeli istnieje response field dla tego feature, może być wysłany do viewport;
- jeżeli nie istnieje, UI pokazuje „spatial response not captured”;
- opcjonalne dopasowanie do eigenmode jest osobną relacją, nie zmianą typu piku.

### 11.5. DSF

- kliknięcie komórki heatmapy wybiera `DynamicStructureFactorPoint` z `k`, `f`
  i wartością observable;
- cut po `k` i cut po `f` są projekcjami tego samego datasetu;
- wybór cut nie jest prywatnym stanem bez provenance;
- duże mapy są pobierane jako tile/decymowana projekcja, nie pełny JSON;
- pole przestrzenne `(k,f)` jest dostępne wyłącznie, gdy producent zapisał
  odpowiedni complex response field lub umożliwia jego deterministyczną
  rekonstrukcję z wersjonowanego źródła.

## 12. Własność stanu

| Stan | Właściciel | Trwałość | Zawartość |
|---|---|---|---|
| dataset manifests/pages/items/projections | kernel resource cache | revision-aware, bounded | odpowiedzi API i lease tablic |
| aktywny dataset/slice/sample/item | kernel selection | mały semantyczny ref | ID, coordinates, revisions, provenance refs |
| preferowane display units, sort, filtry, wybrane osie | właściwy module preference store | wersjonowana, bounded | wyłącznie ustawienia prezentacji |
| expansion i focus w Results | lokalny state Results | nietrwały | małe ID węzłów |
| aktywne pole i jego wygląd | `AnalysisFieldOverlayController` | runtime | field identity, query, faza, wygląd |
| tablice FFT/field vector/ECharts options | **nie store** | resource/renderer lease | zwalniane po unmount/invalidation |

Results i Analysis nie importują swoich store wzajemnie. Wspólny jest wyłącznie
neutralny model domenowy, kernel selection i resource facade.

## 13. Refaktoryzacja wizualizacji pola

### 13.1. Zachować obecne bramki

Obecna ścieżka eigen pola powinna pozostać wzorcem dla:

- run/stage identity;
- artifact/field revision;
- source resource ref;
- representation `complex-vector-xyz`;
- component basis/count;
- source mesh identity;
- topology fingerprint i node count;
- phasor convention;
- Floquet spatial convention;
- `kContextKind`, `wavevectorKf`, cell origin;
- no-fallback przy tangent-local payloadzie bez rekonstrukcji XYZ.

### 13.2. Uogólnić source adapter

Zamiast binarnego warunku eigen/response wprowadzić registry:

```ts
interface AnalysisFieldSourceAdapter {
  sourceKind: "eigen-mode" | "driven-response" | "time-domain-response";
  supports(item: AnalysisResultSelectionRef): boolean;
  metaResource(item: AnalysisResultSelectionRef): ResourceDescriptor;
  plotCommandId: string;
  phaseCommandId: string;
  validateMeta(meta: AnalysisFieldMeta, item: AnalysisResultSelectionRef): ValidationResult;
}
```

Inspector i command layer wybierają adapter po `item_kind/source_kind`, a nie po
rosnącej liczbie `if`.

### 13.3. Topologia per sample

Przed pobraniem vector payload:

1. porównać dataset/sample/field revisions;
2. porównać sample mesh identity z aktywnym visualization geometry context;
3. dla zgodnej topologii użyć istniejącej geometrii;
4. dla innej topologii załadować immutable result mesh, jeśli funkcja została
   wdrożona;
5. w przeciwnym razie fail-closed z konkretnym reason code;
6. po zmianie sample natychmiast odłączyć overlay starego sample.

## 14. Plan wdrożenia

> Każda faza ma osobny zakres plików i testy. Nie należy równolegle modyfikować
> selection, API schema i Results model w niezależnych PR bez zamrożonego
> kontraktu, ponieważ powstaną trzy konkurencyjne tożsamości.

### Faza 0 — zamrożenie architektury i fixtures

**Cel:** uzgodnić model zanim zacznie się kolejna seria wyjątków.

- [ ] Dodać ADR `analysis-result-dataset-and-slice-selection`.
- [ ] Zamrozić znaczenie `dataset`, `axis`, `sample`, `item`, `branch`, `field`.
- [ ] Zamrozić role osi i obsługiwane value kinds.
- [ ] Ustalić, że float/display label nigdy nie jest identity.
- [ ] Ustalić politykę geometrii/topologii per sample.
- [ ] Przygotować małe fixtures JSON dla:
  - pojedynczego eigen spectrum;
  - 15-punktowego K0 antidot bias-field sweep;
  - fixed non-zero `k`;
  - `k_path` z branch gaps;
  - driven frequency sweep;
  - 2D sweep `current x thickness`;
  - sweep geometrii z dwiema różnymi topologiami;
  - LLG Gamma spectrum/peaks z field i bez field;
  - DSF `(k,f)`;
  - partial/interrupted/corrupt/stale revisions.
- [ ] Dodać test kontraktowy, że fixture writera jest konsumowalny przez API bez
  utraty pól.

**DoD:** zatwierdzony ADR i testy fixture shape; brak zmian UI opartych na
niezamrożonym schema.

### Faza 1 — P0: pełny typed bias-field sweep end-to-end

**Backend / API:**

- [ ] Rozszerzyć `FrequencyDomainFieldSweepArtifactPayload` o:
  `source`, `source_revision`, `revision`, counts, `scan_axis`, `units`,
  topology, execution i cross-artifact refs.
- [ ] Dodać typed:
  `FrequencyDomainFieldSweepAxisPayload`,
  `FrequencyDomainFieldSweepDisplayConversionPayload`,
  `FrequencyDomainFieldSweepModePayload`,
  pełny per-sample payload i topology/provenance refs.
- [ ] Nie używać `extra` do pól wymaganych przez UI.
- [ ] Zweryfikować, że writer publikuje `mode_field_id/resource_key` tylko dla
  istniejącego i zweryfikowanego Cartesian complex field payload. Aktualna
  funkcja budująca sweep materializuje te referencje dla każdego modu; musi być
  jawnie związana z walidacją mode bundle albo oznaczać mode jako
  `spectrum-only`.
- [ ] Sprawdzać zgodność source spectrum i branches revisions przed nadaniem
  `complete`.
- [ ] Dodać pozytywne i negatywne testy API deserializacji pełnego artefaktu.
- [ ] Wygenerować OpenAPI i klienta przez repozytoryjny pipeline.

**Frontend:**

- [ ] Dodać `navigatorFieldSweepFromResource()` oparty wyłącznie na generated
  types.
- [ ] Zachować axis, conversions, sample coordinates, mode refs, branch IDs,
  status i provenance.
- [ ] Field sweep ma być źródłem sample labels i listy modów dla sweepu.
- [ ] Join z spectrum/branches wykonywać po stable IDs i source revision.
- [ ] Konflikt revision oznaczać `partial/stale`, nigdy łączyć po indeksie.
- [ ] Zastąpić `FrequencyDomainFieldSweepContractRows` realnymi polami.
- [ ] Pokazywać `requested/completed`, axis unit/conversion, sample status,
  branch tracking i field availability.
- [ ] Etykietować sample fizycznie, np. `mu0 Hx = 75 mT`, z ID w provenance.

**Główne pliki:**

- `crates/fullmag-api/src/router_v2/handlers/analysis/frequency_domain.rs`;
- rejestracja OpenAPI/router i testy API;
- generated OpenAPI/client/types;
- `apps/control-room/src/modules/results-navigator/resultsNavigatorTypes.ts`;
- `resultsNavigatorModel.ts`;
- `ResultsNavigatorModule.tsx`;
- `FrequencyDomainFieldSweepInspectors.tsx` i powiązane testy.

**DoD:** 15-punktowy fixture field sweep pokazuje 15 fizycznych wartości; każda
wartość ma właściwą listę modów i legalne field refs. Nie istnieje parser
`unknown extra` w UI.

### Faza 2 — ogólny result dataset index w API

- [ ] Dodać moduł API, np.
  `crates/fullmag-api/src/router_v2/handlers/analysis/results.rs`.
- [ ] Zdefiniować typed manifest/axes/coordinates/sample/item/relation.
- [ ] Zaimplementować adapter modal eigen dla:
  single sample, field sweep, fixed-k, k-path/k-grid.
- [ ] Zaimplementować adapter driven response z częstotliwością jako osią
  spectral i opcjonalnymi outer sweep axes.
- [ ] Dodać cursor pagination dla samples i items.
- [ ] Dodać projection resources dla spectrum, branch map i response sweep.
- [ ] Każdy indeks/adaptor podpisać własnym content digest.
- [ ] Status datasetu wyprowadzać fail-closed z source artifacts.
- [ ] Dodać route capability/unsupported reasons zamiast pustych tablic.
- [ ] Dodać limit page size i walidację filtrów osi.

**DoD:** klient może odkryć dataset i pobrać jedną stronę próbek oraz jedną
stronę items bez pobierania wszystkich artefaktów i bez znajomości typu solvera.

### Faza 3 — wspólny frontend domain model, zasoby i selection

- [ ] Utworzyć neutralną warstwę, np.
  `apps/control-room/src/shared/domain/analysis/results/*`.
- [ ] Dodać `analysisResultResources.ts` w kernel resources.
- [ ] Dodać typ `analysis-result` do `selectionTypes.ts`.
- [ ] Dodać pure builders/validators selection ref.
- [ ] Dodać jeden bounded compatibility adapter ze starego
  `frequency-domain` ref.
- [ ] Usunąć używanie index-only jako identity w nowych ścieżkach.
- [ ] Dodać equality/hash dla coordinate tuple i query keys bez zależności od
  display strings.
- [ ] Zachować stare endpointy i komponenty do czasu przejścia testów parity.

**DoD:** Results i Analysis potrafią ustawić/odczytać tę samą selection dla
modal eigen i driven response. Selection zawiera tylko małe ID i provenance.

### Faza 4 — Results Dataset/Slice Browser

- [ ] Ograniczyć drzewo do run/stage/product/dataset i małych grup.
- [ ] Dodać axis/slice controls w module Results.
- [ ] Dodać virtualized sample selector i virtualized item/mode table.
- [ ] Wykonywać server-side paging; nie budować dzieci niewidocznych stron.
- [ ] Dodać sort/filter po frequency, branch, residual, field availability i
  status, z jawnym rozdzieleniem filtrów lokalnych i serwerowych.
- [ ] Dodać „follow branch” tylko dla datasetu z tracking capability.
- [ ] Dodać keyboard navigation i czytelne aria labels z jednostkami.
- [ ] Kliknięcie item ustawia jedną kernel selection.
- [ ] Dodać akcje `Open in Analysis`, `Plot field`, `Inspect provenance` bez
  bezpośredniego importu store Analysis/Inspector.
- [ ] Zachować rozróżnienie loading/refreshing/partial/stale/error/unsupported.

**DoD:** Results obsługuje 15-punktowy sweep otworu oraz fixture 10 000 samples
bez materializacji wszystkich mode nodes.

### Faza 5 — Analysis oparte na dataset/slice

- [ ] Zastąpić artifact-specific routing w nowych ścieżkach projection registry.
- [ ] Spectrum jednej próbki, field-frequency map, dispersion i response sweep
  muszą korzystać z tej samej selection.
- [ ] Kliknięcie wykresu ustawia dokładnie ten sam `sampleId/itemId`, co tabela.
- [ ] Dodać axis role selector i fixed-coordinate summary.
- [ ] Dodać wielowymiarowe serie bez zgadywania jednostek.
- [ ] Dodać branch gaps i statusy partial jako jawne przerwy, nie interpolację.
- [ ] Zachować ECharts lifecycle, reduced motion i DOM summary.
- [ ] Eksport zawiera dataset revision, coordinate tuple, units i source refs.

**Główne pliki:**

- `modules/analysis-plots/useAnalysisPlotsController.ts`;
- `modules/analysis-plots/hooks/useAnalysisFrequencyData.ts`;
- `modules/analysis-plots/AnalysisPlotsView.tsx`;
- nowe shared projection/chart models;
- istniejące `frequencyDomainChartModels.ts` jako compatibility adapter do czasu
  migracji.

**DoD:** wybór sample w Results aktualizuje Analysis bez dodatkowego prywatnego
selection state; kliknięcie punktu wraca do tej samej pozycji w Results.

### Faza 6 — wspólna wizualizacja pól

- [ ] Rozszerzyć `AnalysisFieldOverlaySource` o
  `time-domain-response` bez osłabiania walidacji.
- [ ] Zastąpić binary source branching przez registry adapterów.
- [ ] Przepisać `ModeFieldOverlayIntent` na ogólny
  `AnalysisResultFieldOverlayIntent` albo dodać równoległy typ i migrację.
- [ ] Wymagać dataset/sample/item/field revision.
- [ ] Dodać topologię próbki i geometry-context gate.
- [ ] Przy zmianie sample natychmiast wyczyścić niezgodny overlay.
- [ ] Zachować real/imag/abs/phase/phase-rotated/animation oraz component controls.
- [ ] Pole `spectrum-only` nie może aktywować komendy renderującej.
- [ ] Dodać negatywne testy stale field, wrong topology, wrong component basis,
  missing revision i cross-sample mismatch.

**DoD:** ten sam panel renderowania obsługuje eigen, driven i — po dostępności
artefaktu — time-domain response field, zachowując wszystkie obecne bramki.

### Faza 7 — LLG/FFT i DSF

Ta faza zależy od wdrożenia kontraktów z planu
`2026-08-31-time-domain-spectral-analysis-contracts-and-storage.md`.

- [ ] Dodać dataset adapter dla canonical time-domain manifest.
- [ ] Dodać stabilne IDs peak/spectral feature i content revisions.
- [ ] Dodać response field refs tylko, gdy produkt został rzeczywiście zapisany.
- [ ] Dodać Analysis projection dla spectrum, peaks i susceptibility.
- [ ] Dodać DSF tile/projection resources.
- [ ] Kliknięcie piku/komórki ustawia kernel selection.
- [ ] Inspector pokazuje sampling clock, uniformity proof, window, detrend,
  normalization, Nyquist, source drive i status kompletności.
- [ ] Legacy `spin_wave_response.gamma.v1` i
  `dynamic_structure_factor.1d.v1` czytać przez bounded adapter z jawnym
  `legacy/partial`, nie promować do pełnego canonical datasetu.
- [ ] Dodać opcjonalny `matched_eigen_mode` derived artifact, lecz nie wymagać go
  do podstawowej wizualizacji FFT.

**DoD:** Results pokazuje `Spectral features`, a nie fałszywe `Eigenmodes`;
wybrany peak i DSF point są synchronizowane z Analysis/Inspector, a pole jest
aktywne wyłącznie przy prawdziwym field ref.

### Faza 8 — sweepy materiałowe, prądowe i geometryczne

- [ ] Rozszerzyć producentów/planner o typed axis metadata dla parametrów
  innych niż bias field.
- [ ] Wymagać immutable parameter path/semantic ID i canonical unit.
- [ ] Dodać entity refs dla materiału/geometrii zamiast serializacji całych
  obiektów w osi.
- [ ] Obsłużyć dwa i więcej outer sweep axes.
- [ ] Dodać topology-per-sample dla geometrii.
- [ ] Dodać result mesh resource albo jawny unsupported reason dla renderowania
  pola z innej topologii.
- [ ] Dodać branch tracking contract per sweep path; dla siatki 2D nie zakładać
  jednej globalnej gałęzi bez zdefiniowanej ścieżki trackingu.
- [ ] Dodać comparison projection dla dwóch datasetów o kompatybilnych osiach i
  jednostkach.

**DoD:** ten sam UI obsługuje co najmniej pole, scalar material parameter, current
or current density, geometry scalar i 2D sweep bez zmian specjalnych w Results.

### Faza 9 — wydajność, przeglądarka i kwalifikacja

- [ ] Dodać fixture 10k samples x 100 items i microbenchmark budowy visible rows.
- [ ] Maksymalnie dwie sąsiednie strony danych mają być utrzymywane bez jawnego
  pinowania.
- [ ] Field payload nie jest pobierany podczas samej zmiany axis/display unit.
- [ ] Cached sample switch nie powoduje requestu do solvera ani topology upload.
- [ ] Dodać script `smoke:results-mode-sweep` albo równoważny repozytoryjny
  browser proof.
- [ ] Browser proof obejmuje Mocha/Latte, keyboard, 200% zoom, reduced motion,
  cleanup ECharts/WebGL i brak stale overlay.
- [ ] Wykonać prawdziwy 15-punktowy FEM K0 antidot sweep i zapisać immutable
  artifacts + screenshot/proof manifest.
- [ ] Osobno kwalifikować modal CPU, modal GPU, driven i time-domain lanes.

**DoD:** pełny browser proof na prawdziwych artefaktach, brak wycieku pamięci,
brak starego pola po zmianie sample i zgodność selection w czterech
powierzchniach UI.

### Faza 10 — usunięcie ścieżek specjalnych

- [ ] Po jednej wydanej wersji z nowymi writerami usunąć zapis starych selection
  refs.
- [ ] Po przejściu parity usunąć field-specific sample labels i nieużywane
  artifact-specific branches w modelu Results.
- [ ] Zachować readers legacy wyłącznie przez nazwany, testowany compatibility
  boundary.
- [ ] Usunąć compatibility reader dopiero po spełnieniu udokumentowanej bramki,
  nie według arbitralnej daty.

## 15. Strategia testów

### 15.1. Backend i API

Minimalny zestaw:

```bash
cargo test -p fullmag-runner field_sweep
cargo test -p fullmag-api frequency_domain
cargo test -p fullmag-api result_dataset
```

Testy muszą sprawdzać:

- pełny round-trip writer -> JSON -> API typed payload -> generated TS;
- zgodność digestów i cross-artifact refs;
- konflikt source revisions;
- brak field payload przy `spectrum-only`;
- partial/interrupted/corrupt;
- stable IDs niezależne od indeksów;
- vector3 coordinates i display conversions;
- pagination/filter validation;
- geometry sample z różnymi topology fingerprints.

### 15.2. Control Room

Repozytoryjne komendy:

```bash
pnpm --dir apps/control-room run generate:api
pnpm --dir apps/control-room run test
pnpm --dir apps/control-room run typecheck
pnpm --dir apps/control-room run lint
pnpm --dir apps/control-room run check:architecture-hygiene
pnpm --dir apps/control-room run check:api-hygiene
```

Focused tests:

- adapter field sweep zachowuje axis/sample/modes/fields/revisions;
- Results sample selector ustawia poprawny slice;
- item list aktualizuje się po sample change;
- branch follow i branch gap;
- chart selection <-> Results selection round-trip;
- response outer sweep + frequency point;
- FFT peak ma `SpectralFeature`, nie `EigenMode`;
- stale field jest usuwane przed nowym fetch;
- wrong topology fail-closed;
- display unit change wykonuje zero requestów;
- virtualized list nie materializuje całego datasetu;
- unmount zwalnia observers, ECharts i field leases.

### 15.3. Przeglądarka

Scenariusz rzeczywisty dla warstwy z otworem:

1. uruchomić dokładny runtime zgodny ze snapshotem źródeł;
2. wykonać 15-punktowy field sweep;
3. uruchomić Control Room w trybie interactive;
4. otworzyć Results i wybrać dataset;
5. przejść przez pierwszy, środkowy i ostatni field sample;
6. dla każdej próbki porównać listę modów z artefaktem;
7. wybrać co najmniej dwa mody i sprawdzić real/imag/abs/phase/animate;
8. zmienić sample podczas animacji i sprawdzić brak starego payloadu;
9. otworzyć Analysis i sprawdzić zgodność podświetlenia;
10. wrócić do 3D i zweryfikować zdrowy WebGL drawing buffer;
11. zapisać proof manifest związany z commit/runtime/artifact digests.

## 16. Kryteria akceptacji produktu

### AC-1 — bias-field sweep

Dla każdej z 15 wartości pola UI pokazuje fizyczną wartość z jednostką, listę
modów należącą do właściwego sample, status i source revision.

### AC-2 — wspólna selekcja

Results, Analysis, Inspector i viewport wskazują dokładnie ten sam
`datasetId/sampleId/itemId`; test negatywny wykrywa dowolny cross-sample field.

### AC-3 — jednostki

Wartość kanoniczna pozostaje SI, a konwersja do mT/GHz/nm/pJ/m nie zmienia ID ani
nie powoduje nowego requestu danych.

### AC-4 — k0 i non-k0

Ten sam model obsługuje finite-open, Gamma, fixed-k, k-path i k-grid bez
nazywania układu skończonego `k=0` oraz bez utraty Floquet provenance.

### AC-5 — driven response

Wybrany outer sweep sample determinuje response spectrum. Kliknięty frequency
point ma prawidłowy observable, unit, source revision i opcjonalny response
field.

### AC-6 — LLG/FFT

Peak jest oznaczony jako spectral feature. Pole i matched eigenmode są widoczne
tylko przy jawnych, zweryfikowanych relacjach.

### AC-7 — geometria

Pole z sample o innej topologii nie jest renderowane na aktualnym meshu bez
załadowania właściwego immutable result mesh.

### AC-8 — wydajność

UI nie materializuje całego datasetu, nie pobiera wszystkich pól i nie zapisuje
heavy arrays w store. Page/slice change ma bounded request count.

### AC-9 — stany błędów

Partial, interrupted, stale, corrupt, unsupported i missing mają osobne stany i
konkretne reason codes. Żaden z nich nie jest prezentowany jako complete.

### AC-10 — architektura frontend-v2

Moduły używają generated client/resource hooks, nie składają URL ani nie
wykonują direct fetch. Results i Analysis nie importują swoich prywatnych store.

## 17. Ryzyka i decyzje projektowe

| Ryzyko | Skutek | Mitigacja |
|---|---|---|
| Join po indeksie zamiast ID/revision | mode z innej próbki | zakaz join po pozycji; typed stable refs |
| Float jako identity | niestabilne deep links i błędne filtry | token/ID + kanoniczna wartość osobno |
| Automatyczny follow `raw_mode_index` | skok na inną gałąź | tylko certyfikowany `branch_id` |
| Geometry sweep na aktualnym meshu | fizycznie błędny render | topology gate + result mesh lub fail-closed |
| Ogólny schema zastępuje fizykę | utrata specyficznych danych | index/adaptor nad artifact-native schemas |
| Parsowanie `extra` w UI | schema drift i brak type safety | rozszerzyć OpenAPI, zero ad-hoc parsing |
| Duży JSON FFT/DSF | pamięć i blokada main thread | Zarr/binary/tile + control-plane metadata |
| Duplikacja selection w Results/Analysis | rozjazd wykresu i pola | jedna kernel selection |
| Nazwanie piku modem | błędna interpretacja naukowa | osobny item kind i typed relation |
| Invalidation tylko po schema version | stare dane w cache | content/source digest jako revision |
| Milion dzieci drzewa | freeze UI | server paging + virtualization |
| Automatyczny load field przy hover | ruch sieciowy/GPU | field dopiero po explicit selection |

### Decyzja rekomendowana: gdzie tworzyć ogólny indeks

Najbezpieczniejsza kolejność:

1. API buduje walidowany indeks z istniejących artefaktów;
2. frontend konsumuje tylko indeks i specjalistyczne detail/data resources;
3. po stabilizacji runner zapisuje indeks opcjonalnie jako immutable artefakt;
4. API nadal go waliduje i wystawia resource envelope.

Pozwala to naprawić UI bez jednoczesnego przepisywania każdego solvera, a
jednocześnie nie tworzy frontendowego parsera plików.

## 18. Antywzorce, których nie wolno wdrażać

- dropdown z ręcznie wpisanym `H [mT]` bez dataset/sample identity;
- etykieta `Sample 4` jako jedyny opis fizyczny;
- parsowanie `payload.extra` w komponencie React;
- łączenie field sweep i spectrum po indeksie tablicy;
- automatyczne zachowanie `Mode 2` po zmianie pola bez branch tracking;
- zapis pełnych list modów/FFT/field vectors w Zustand/localStorage;
- budowanie miliona hidden tree nodes i nazywanie tego paginacją;
- pobranie pola każdego modu z góry;
- podpisanie starego field payload aktualną topologią;
- traktowanie każdego FFT peak jako eigenmode;
- bezpośredni `fetch()` albo składanie endpointu w module Results/Analysis;
- osłabienie istniejących revision/topology/component gates dla wygody UI;
- jedna flaga `available` zamiast complete/partial/interrupted/corrupt;
- równoległe, niezależne selection stores dla Results i Analysis.

## 19. Proponowany podział zmian na PR

### PR 1 — typed field sweep parity

- pełny OpenAPI payload;
- generated types/client;
- field sweep adapter;
- fizyczne sample labels;
- dynamiczna lista modów dla istniejącego bias-field sweepu;
- Inspector z realnymi danymi;
- fixture 15-point antidot.

To jest najkrótsza ścieżka do naprawienia bieżącego przypadku bez tworzenia
martwego UI.

### PR 2 — result dataset index i selection

- ADR;
- API dataset catalog/manifest/pages;
- wspólne frontend domain types/resources;
- `analysis-result` selection;
- bounded legacy adapter.

### PR 3 — Results/Analysis synchronization i paging

- dataset/slice browser;
- virtualized sample/item list;
- projection-based charts;
- bidirectional selection sync.

### PR 4 — field source registry i topology-per-sample

- uogólniony overlay intent;
- eigen/driven parity;
- result mesh/fail-closed geometry workflow;
- stale overlay browser tests.

### PR 5 — time-domain FFT/DSF UI

- po canonical artifacts z planu 2026-08-31;
- peaks/features/DSF selection;
- optional response fields;
- optional eigen matching relations.

### PR 6 — generic multi-axis sweeps i kwalifikacja

- materiał, prąd, geometria, 2D+;
- performance fixtures;
- rzeczywisty browser proof CPU/GPU według osobnych scope.

## 20. Priorytet implementacyjny

1. **Natychmiast:** P0 typed parity dla `eigen/field_sweep.v1` i działający
   15-punktowy UI przepływ `pole -> sample -> modes -> field`.
2. **Następnie:** dataset index + wspólna selection, zanim dodamy kolejny typ
   sweepu.
3. **Potem:** Results/Analysis paging i synchronizacja.
4. **Dalej:** driven response i uogólnienie pola.
5. **Po kontraktach time-domain:** FFT/DSF oraz response fields.
6. **Na końcu:** pełne multi-axis sweeps, geometry result meshes i kwalifikacja
   wydajnościowa/przeglądarkowa.

## 21. Definicja ukończenia całego refaktoru

Refaktor jest ukończony dopiero wtedy, gdy użytkownik może dla eigen, driven i
LLG/FFT:

- odkryć dataset bez znajomości nazwy pliku artefaktu;
- zobaczyć wszystkie osie z kanonicznymi jednostkami;
- wybrać jedną lub wiele wartości parametrów;
- otrzymać dynamicznie właściwą listę mode/response/feature items;
- zobaczyć spectrum/mapę dla tego samego slice;
- wybrać item z tabeli lub wykresu;
- zobaczyć spójny Inspector i provenance;
- wyrenderować właściwe pole, jeżeli zostało opublikowane;
- otrzymać jednoznaczny komunikat, jeżeli pole nie istnieje albo topologia jest
  niezgodna;
- przełączyć sample bez pozostawienia starego pola;
- pracować na dużym sweepie bez pełnej materializacji i bez pobierania wszystkich
  payloadów;
- odróżnić eigenmode, driven point, spectral feature, fit i DSF point;
- odtworzyć ten sam wybór z immutable IDs i revisions.

Dopiero rzeczywisty browser proof na 15-punktowym sweepie warstwy z otworem oraz
osobne testy k0, non-k0, driven i time-domain zamykają ten plan. Sama obecność
komponentów, zielony typecheck albo screenshot statycznego fixture nie stanowią
kwalifikacji fizycznej ani produkcyjnej.
