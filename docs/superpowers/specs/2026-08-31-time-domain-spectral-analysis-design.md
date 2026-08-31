# Analiza spektralna dynamiki czasowej — projekt produkcyjny

**Status:** zatwierdzony projekt architektoniczny

**Data:** 2026-08-31

**Zakres:** Fullmag Python DSL, `ProblemIR`, planner, runner, FDM/FEM CPU/GPU, artefakty, MMPP, OpenAPI v2 i Control Room
**Charakter dokumentu:** wewnętrzna specyfikacja projektowa; nie stanowi deklaracji istniejącej kwalifikacji runtime

## 1. Cel

Fullmag ma automatyzować kompletną analizę spektralną w domenie czasu:

1. przygotowanie stanu równowagi;
2. wzbudzenie układu polem mikrofalowym;
3. rozwiązanie dynamiki LLG;
4. zapis magnetyzacji jako funkcji czasu i położenia;
5. niezależne, powtarzalne przetwarzanie FFT;
6. zapis widma, pików, podatności, pól odpowiedzi i dyspersji;
7. przeglądanie, porównywanie, animowanie i eksport wyników w Control Room.

Projekt obejmuje cztery lane'y wykonawcze:

- FDM CPU;
- FDM GPU;
- FEM CPU;
- FEM GPU.

Każdy lane jest implementowany i kwalifikowany niezależnie. Wymuszenie GPU nie może zakończyć się cichym wykonaniem na CPU.

## 2. Zatwierdzone decyzje

### 2.1 Osobna rodzina produktu

Nowa rodzina ma kanoniczną nazwę:

```text
time_domain_spectral_analysis
```

Nie jest aliasem eigensolve ani produktu `driven_response`.

Rozróżniamy:

| Produkt | Znaczenie |
|---|---|
| `modal_eigen` | mody własne z linearyzowanego operatora |
| `driven_response` | odpowiedź na harmoniczne wymuszenie rozwiązana bezpośrednio w domenie częstotliwości; symbole implementacyjne mogą zachować nazwę `DrivenFrequencyResponse*` |
| `time_domain_spectral_analysis` | widmo i zespolone pola odpowiedzi wyznaczone z zapisanej dynamiki |

Wynik FFT może zawierać nakładające się mody, odpowiedź wymuszoną, transjenty, przeciek widmowy i wpływ okna. UI nie może automatycznie nazywać każdego piku eigenmodem.

### 2.2 Wariant hybrydowy MMPP

Fullmag jest właścicielem:

- modelu fizycznego;
- osi i próbkowania;
- kanonicznych artefaktów;
- podstawowego silnika FFT;
- zasobów API;
- provenance i kwalifikacji.

MMPP jest:

- opcjonalnym czytnikiem kanonicznych artefaktów;
- opcjonalnym, izolowanym workerem rozszerzonego postprocessingu;
- niezależnym oracle zgodności dla wybranych analiz.

Brak MMPP nie może blokować wykonania symulacji, bazowego FFT, odczytu wyników ani eksportu.

### 2.3 Postprocessing oddzielony od solvera

Solver LLG zapisuje kwalifikowany artefakt czasowo-przestrzenny. FFT jest osobnym etapem konsumującym ten artefakt.

Zmiana:

- okna czasowego;
- detrend;
- zakresu częstotliwości;
- komponentu;
- zakresu przestrzennego;
- detektora pików;
- silnika `native`/`mmpp`;

nie uruchamia ponownie LLG.

## 3. Stan wyjściowy repozytorium

### 3.1 Istniejące elementy nadające się do zachowania

Python i IR:

- `packages/fullmag-py/src/fullmag/model/study.py::GammaResponseAnalysis`;
- `packages/fullmag-py/src/fullmag/world.py::StudyStagesBuilder.fft_response`;
- `crates/fullmag-ir/src/study.rs::RegionalFieldDriveIR`;
- `crates/fullmag-ir/src/study.rs::SamplingIR`;
- `crates/fullmag-ir/src/study.rs::TableAutosaveIR`;
- `crates/fullmag-ir/src/study.rs::StageAutosaveIR`.

Planner i runtime:

- `crates/fullmag-plan/src/sampling.rs::resolve_auto_sampling_for_stage`;
- `crates/fullmag-runner/src/time_events.rs::build_resolved_stage_event_schedule`;
- `crates/fullmag-runner/src/time_events.rs::cap_timestep_to_next_event`;
- `crates/fullmag-runner/src/spin_wave_response.rs::append_requested_spin_wave_artifacts`;
- `crates/fullmag-runner/src/spin_wave_sampling.rs::requested_finite_k_artifacts`;
- `crates/fullmag-runner/src/autosave_zarr.rs`;
- `crates/fullmag-runner/src/autosave_hdf5.rs`.

API i UI:

- `crates/fullmag-api/src/router_v2/handlers/analysis/spin_wave_response.rs`;
- `crates/fullmag-api/src/router_v2/handlers/analysis/frequency_domain.rs`;
- `crates/fullmag-api/src/router_v2/handlers/data/fields.rs`;
- `apps/control-room/src/kernel/api/ControlRoomApi.ts`;
- `apps/control-room/src/kernel/resources/studyRuntimeResources.ts`;
- `apps/control-room/src/modules/analysis-plots`;
- `apps/control-room/src/modules/inspector/panels/stages/FftResponseStageInspector.tsx`;
- `apps/control-room/src/modules/inspector/panels/ModeVisualizationInspectorPanel.tsx`;
- `apps/control-room/src/kernel/visualization/AnalysisFieldOverlayController.ts`.

### 3.2 Potwierdzone ograniczenia stanu wyjściowego

1. `fft_response` jest syntetyczną akcją opartą na runtime metadata, nie pełnym typowanym produktem analizy.
2. Analiza Γ czyta zaakceptowane kroki solvera, a nie kanoniczny zegar zapisu pola.
3. Adaptive LLG może dostarczyć nierównomierną oś czasu, którą bieżąca analiza odrzuca.
4. FEM finite-k jest sterowane metadata, ograniczone do osi x i `tet4`.
5. Nie ma backend-neutralnego artefaktu `m(t,r)`.
6. Nie ma ogólnego artefaktu zespolonego pola odpowiedzi dla wybranego piku.
7. FDM GPU odrzuca obecnie kanoniczny `RegionalFieldDrive` fail-closed.
8. Zarr i HDF5 nie posiadają wspólnego logicznego kontraktu time-domain spectroscopy.
9. Historyczne runy nie mają kompletnej run-scoped rodziny zasobów analizy.
10. Browser/WebGL proof dla pełnego przepływu pozostaje `NOT VERIFIED`.

## 4. Semantyka fizyczna

### 4.1 Sygnał wejściowy

Niech znormalizowana magnetyzacja wynosi:

\[
\mathbf m(\mathbf r,t)=\frac{\mathbf M(\mathbf r,t)}{M_s(\mathbf r)}.
\]

Dla analizy odpowiedzi odejmujemy jawnie zdefiniowane odniesienie:

\[
\delta\mathbf m(\mathbf r,t)
=\mathbf m(\mathbf r,t)-\mathbf m_{\mathrm{ref}}(\mathbf r,t).
\]

Dozwolone odniesienia:

- `initial_state` — stan w pierwszej certyfikowanej próbce;
- `equilibrium_artifact` — zapisany stan równowagi;
- `time_mean` — średnia z jawnie podanego okna;
- `paired_control_run` — osobny run bez wzbudzenia, o zgodnej tożsamości modelu i siatki.

Wybór odniesienia jest częścią klucza analizy i provenance.

### 4.2 Transformata czasowa

Kanoniczna konwencja:

\[
\tilde{\mathbf m}(\mathbf r,f_k)
=\Delta t\sum_{n=0}^{N-1}
w_n\,\delta\mathbf m(\mathbf r,t_n)
\exp(-i2\pi f_k t_n).
\]

Konwencja jest zapisywana jako:

```text
phase_convention = exp_minus_i_2pi_f_t
```

Każdy artefakt zapisuje:

- `detrend`;
- `window`;
- współczynnik coherent gain;
- equivalent noise bandwidth;
- `normalization`;
- `one_sided`;
- `nfft`;
- sposób obsługi składowych DC i Nyquista.

Nieznane okno jest błędem walidacji. Nie istnieje fallback do Hann.

### 4.3 Częstotliwość i rozdzielczość

Dla równomiernego próbkowania:

\[
f_s=\frac{1}{\Delta t},\qquad
f_{\mathrm{Nyquist}}=\frac{f_s}{2},\qquad
\Delta f=\frac{f_s}{N}=\frac{1}{T}.
\]

Planner raportuje wszystkie cztery wartości oraz margines względem deklarowanego cutoffu wzbudzenia.

Domyślny kontrakt automatyczny wymaga:

```text
f_Nyquist >= oversampling_factor * excitation_cutoff_hz
oversampling_factor = 1.3
```

Wartość `1.3` zachowuje bieżącą intencję `resolve_auto_sampling_for_stage`; użytkownik może zwiększyć, ale nie obniżyć poniżej `1.0` bez jawnego trybu eksperckiego. Taki wynik zachowuje `validation_state=unvalidated` i nie może być promowany do `production_qualified` bez osobnego scope.

### 4.4 Podatność

Dla zgodnych sygnałów źródła i odpowiedzi:

\[
\chi_{ij}(f)=\frac{\tilde m_i(f)}{\tilde H_j(f)}.
\]

Podział jest wykonywany tylko tam, gdzie amplituda źródła przekracza jawny próg. Punkty poniżej progu są maskowane, nie zastępowane zerem.

### 4.5 Pole odpowiedzi FFT

Wybrany pik `peak_id` wskazuje częstotliwość lub zakres binów. Pole odpowiedzi jest zespolone:

\[
\tilde{\mathbf m}_{p}(\mathbf r)\in\mathbb C^3.
\]

Widoki prezentacyjne:

- `real`;
- `imag`;
- `abs`;
- `phase`;
- `phase_rotated_real`.

Zmiana fazy jest operacją prezentacyjną i nie tworzy nowego artefaktu naukowego.

### 4.6 Dynamic structure factor

Dla jawnego operatora próbkowania przestrzennego `P`:

\[
S(k,f)=\left|\mathcal F_x\mathcal F_t
\left[P\delta\mathbf m\right]\right|^2.
\]

Źródłowe widmo anteny i odpowiedź magnetyzacji są oddzielnymi produktami. UI nie może etykietować source k-spectrum jako `S_m(k,f)`.

## 5. Kanoniczny graf wykonania

```text
EquilibriumStage
  -> optional AntennaFieldSolveStage
  -> TimeEvolutionStage
       -> TimeSeriesArtifact
  -> TimeDomainSpectralAnalysisStage
       -> SpectrumArtifact
       -> PeakCatalogArtifact
       -> ResponseFieldArtifact
       -> optional DynamicStructureFactorArtifact
  -> optional ExportStage
```

### 5.1 EquilibriumStage

Właściciel stanu początkowego. Manifest analizy zapisuje:

- `equilibrium_artifact_id`;
- hash magnetyzacji;
- mesh/topology identity;
- stopping criterion;
- backend/device/precision;
- wynik kwalifikacji relaksacji.

### 5.2 AntennaFieldSolveStage

Pełny wariant produkcyjny dla anten o zmiennej szerokości i złożonej geometrii:

1. przewodnik 3D;
2. rozwiązanie potencjału/prądu;
3. `J_charge` i `V_electric`;
4. Biot–Savart lub zatwierdzona równoważna realizacja;
5. `H_ant_basis` na domenie próbkowania;
6. artefakt `antenna_field_solution.v1`.

Historyczny model 2.5D nie może być promowany dla taperu lub przewężenia.

### 5.3 TimeEvolutionStage

Wykonuje LLG oraz ocenia waveform w każdym wymaganym podkroku integratora. Oddziela:

- `solver_step_clock`;
- `physical_output_clock`;
- `stage_local_time`;
- `absolute_time`.

### 5.4 TimeDomainSpectralAnalysisStage

Jest powtarzalnym, anulowalnym etapem bez mutacji źródłowego runu. Wynik może być odtworzony na podstawie:

- source artifact identity;
- analysis request;
- engine version;
- deterministic execution settings.

## 6. Publiczny Python DSL

### 6.1 Proponowane konstrukcje

```python
from fullmag import (
    TimeDomainSpectralAnalysis,
    TimeSeriesSampling,
    SpectralPeakDetection,
    SpectralProducts,
)
```

Przykład kanoniczny:

```python
world.stages.add_run(
    name="rf_dynamics",
    duration="20 ns",
    dynamics=LLG(integrator="rk45"),
    sampling=TimeSeriesSampling(
        interval="2 ps",
        quantities=["m", "H_drive"],
        clock="exact_physical_time",
        format="zarr",
    ),
)

world.stages.add_analysis(
    TimeDomainSpectralAnalysis(
        name="rf_spectrum",
        source_stage="rf_dynamics",
        response_quantity="m",
        source_quantity="H_drive",
        reference="equilibrium_artifact",
        components=["x", "y", "z"],
        detrend="constant",
        window="hann",
        products=SpectralProducts(
            global_spectrum=True,
            susceptibility=True,
            response_fields=True,
            dynamic_structure_factor=False,
        ),
        peaks=SpectralPeakDetection(
            method="prominence",
            minimum_prominence=0.02,
            minimum_separation_hz=50e6,
        ),
        engine="auto",
    )
)
```

Każdy publiczny parametr round-tripuje przez Python → `ProblemIR` → Python export.

### 6.2 Waveform

Docelowy wspólny kontrakt wzbudzenia obejmuje:

- constant;
- sinusoidal;
- pulse;
- sinc;
- Gaussian pulse;
- chirp;
- piecewise linear;
- tabulated artifact.

Migracja scala semantykę `TimeDependenceIR` i `TimeEnvelopeIR`, zachowując ograniczone czytniki kompatybilności. Tabulated waveform wymaga identity i resolvera artefaktu; brak resolvera kończy planowanie.

## 7. ProblemIR i planner

### 7.1 `TimeDomainSpectralAnalysisIR`

Proponowany typ logiczny:

```rust
pub struct TimeDomainSpectralAnalysisIR {
    pub analysis_id: String,
    pub source_stage_id: String,
    pub source_artifact_id: Option<String>,
    pub time_range_s: Option<[f64; 2]>,
    pub response_quantity_id: String,
    pub source_quantity_id: Option<String>,
    pub source_drive_ids: Vec<String>,
    pub spatial_selection: SpectralSpatialSelectionIR,
    pub components: Vec<VectorComponentIR>,
    pub reference: SpectralReferenceIR,
    pub transform: TemporalTransformIR,
    pub products: SpectralProductsIR,
    pub peak_detection: SpectralPeakDetectionIR,
    pub requested_analysis_engine: SpectralAnalysisEngineRequestIR,
}
```

Argument Python `engine` mapuje się na `requested_analysis_engine`. Jest to wykonawczy intent postprocessingu, nie definicja fizyczna ani wybór backendu dynamiki LLG.

### 7.2 Rozwiązanie silnika analizy

Kontrakt rozróżnia trzy niezależne osie provenance:

1. `source_execution` — requested/resolved backend, device i precision dynamiki LLG;
2. `analysis_engine` — requested `auto|native|mmpp` oraz resolved `native|mmpp`;
3. `analysis_execution` — requested/resolved device i transfer policy samego postprocessingu.

`SpectralAnalysisEngineRequestIR` ma dokładnie warianty `Auto`, `Native` i `Mmpp`. Planner rozwiązuje je przed rozpoczęciem analizy:

- `native` wymaga kompletnego natywnego capability setu i kończy planowanie błędem, gdy go brakuje;
- `mmpp` wymaga dostępnego workera, zgodnego protokołu i kompletnego capability setu; brak workera jest błędem `worker_unavailable`;
- `auto` wybiera `native` dla całego baseline i każdego zestawu produktów w pełni obsługiwanego natywnie; może wybrać `mmpp` wyłącznie dla zestawu niewspieranego natywnie, gdy MMPP deklaruje cały wymagany capability set;
- jedna analiza ma jednego resolved producenta; `auto` nie dzieli niejawnie produktów między native i MMPP;
- po rozwiązaniu nie istnieje runtime fallback. Awaria resolved engine kończy konkretną próbę błędem; ponowienie tworzy nową analysis execution identity.

Manifest i receipt zapisują `requested_analysis_engine`, `resolved_analysis_engine`, `engine_resolution_reason`, `engine_capability_snapshot_id` oraz wersję producenta. Dzięki temu brak MMPP nie zmienia wyniku baseline, a jawne `engine="mmpp"` nigdy nie zostaje po cichu wykonane przez native.

### 7.3 Walidacja

Walidator odrzuca:

- nieistniejący stage źródłowy;
- brak pola `m`;
- niezgodne mesh/topology identity;
- mniej niż cztery próbki;
- niejednostajną oś bez jawnego derived resampling artifact;
- częstotliwość docelową ponad Nyquist;
- susceptibility bez źródłowego pola;
- finite-k bez operatora próbkowania;
- FEM reshape do regularnej siatki bez operatora;
- nieznane okno lub normalizację;
- żądanie GPU dla niewspieranego lane'u;
- jawne `native` lub `mmpp` bez kompletnego capability setu;
- `auto`, gdy żaden pojedynczy engine nie obsługuje całego żądanego zestawu produktów.

### 7.4 Planowanie zasobów

Planner estymuje:

```text
sample_count
carrier_count
component_count
raw_bytes
compressed_bytes_estimate
peak_field_bytes_estimate
scratch_bytes_estimate
host_transfer_bytes_estimate
```

Przekroczenie budżetu nie obniża jakości automatycznie. Planer zwraca błąd z alternatywami:

- ograniczenie zakresu przestrzennego;
- rzadszy sampling zachowujący Nyquist;
- krótszy czas kosztem jawnie pokazanej gorszej `df`;
- probe operator zamiast pełnego pola;
- większy budżet zasobów.

## 8. Próbkowanie czasowe

### 8.1 Dwie klasy danych

1. `accepted_step_trace` — diagnostyka integratora;
2. `exact_physical_time_series` — wejście certyfikowanej analizy.

Te klasy nie są wymienne.

### 8.2 Uzyskanie próbki

Dozwolone metody:

- dokładne lądowanie kroku na zdarzeniu zapisu;
- kwalifikowane dense output integratora;
- jawny post-hoc resampling tworzący derived artifact.

Każda próbka zapisuje:

- `requested_time_s`;
- `actual_time_s`;
- `time_error_s`;
- `accepted_step_index`;
- `solver_dt_s`;
- `sampling_method`;
- `quality_flags`.

### 8.3 Brak cichego resamplingu

Post-hoc resampling zapisuje:

- metodę;
- parametry;
- błąd walidacyjny na funkcjach syntetycznych;
- zakres wejściowy i wyjściowy;
- source artifact hash;
- `validation_state` oraz opcjonalny zatwierdzony scope; brak scope pozostawia `unvalidated`.

## 9. Artefakty

### 9.1 Hierarchia wersji

Wersja kontraktu logicznego nie jest wersją kontenera ani API. Obowiązuje następujący crosswalk:

| Warstwa | Kanoniczna identity v1 | Reguła |
|---|---|---|
| Python/ProblemIR | `fullmag.time_domain_spectral_analysis.v1` | publiczny intent i round-trip |
| manifest bundle | `fullmag.analysis.time_domain_spectral.manifest.v1` / `manifest.v1.json` | jedna authority dla całej analizy |
| sampling | `fullmag.analysis.sampling.v1` / `sampling.v1.json` | rzeczywista oś czasu i jakość próbek |
| szeregi czasowe | `fullmag.analysis.time_series.v1` | tablice `time_s`, `magnetization`, opcjonalnie `drive_field` |
| widma | `fullmag.analysis.spectra.v1` | oś częstotliwości, amplituda, moc, źródło i susceptibility |
| piki | `fullmag.analysis.peaks.v1` | lista pików, nie lista eigenmodów |
| pola odpowiedzi | `fullmag.analysis.response_fields.v1` | zespolone `delta_m(f,r)` lub jawnie nazwane inne quantity |
| DSF | `fullmag.analysis.dynamic_structure_factor.v1` | jawne osie `k` i `f` oraz operator przestrzenny |
| HTTP representation | `time_domain_spectral_manifest.v1` i odpowiadające resource schemas | transportowane przez OpenAPI v2 |
| worker MMPP | `fullmag.mmpp.worker.v1` | protokół procesu, wersjonowany niezależnie od algorytmu |
| kontener Zarr | `zarr_format=2` | wyłącznie fizyczny format storage |
| kontener HDF5 | `storage_format=hdf5_compat_v1` | równoważne logiczne osie, wartości i identity |

Zmiana wersji jednej warstwy nie podnosi automatycznie pozostałych. Legacy `spin_wave_response.gamma.v1`, `dynamic_structure_factor.1d.v1`, `spectrum.v2/v3` i `mode_fields.zarr` są osobnymi nazwami kompatybilności, nie wersjami nowej rodziny.

### 9.2 Układ katalogu

```text
analysis/time_domain_spectral/{analysis_id}/
  manifest.v1.json
  sampling.v1.json
  time_series.zarr/
  spectra.zarr/
  peaks.v1.json
  response_fields.zarr/
  dynamic_structure_factor.zarr/
  diagnostics.v1.json
  exports/
```

`analysis_id` jest bezpiecznym segmentem identity zwalidowanym przed utworzeniem ścieżki. Jeden run może zawierać wiele niezależnych analiz; każda ma własny immutable source reference i manifest.

### 9.3 `manifest.v1.json`

Obowiązkowe bloki:

- schema i physics contract version;
- source/session/run/stage identity;
- requested/resolved backend, device i precision;
- requested/resolved spectral engine;
- equilibrium, mesh, topology i material identity;
- drive i antenna identity;
- sampling identity;
- transform identity;
- produkty i ich resource keys;
- status wykonania;
- validation state i validated scope;
- checksumy;
- capability snapshot;
- failure/partial diagnostics.

### 9.4 `time_series.zarr`

Logiczne tablice:

```text
time_s                     [time]                 float64, s
requested_time_s           [time]                 float64, s
time_error_s               [time]                 float64, s
magnetization              [time, carrier, 3]     float32|float64, 1
drive_field                [time, carrier, 3]     float32|float64, A/m
sample_step_index          [time]                 uint64
sample_quality_flags       [time]                 uint32
```

`carrier` wskazuje jawny descriptor:

- FDM cell order;
- FEM node order;
- boundary carrier;
- probe/grid carrier.

### 9.5 `spectra.zarr`

```text
frequency_hz               [frequency]             float64
response_complex           [frequency, observable, 2]
power                      [frequency, observable]
source_complex             [frequency, source, 2]
susceptibility_complex     [frequency, response, source, 2]
valid_source_mask          [frequency, source]
```

Oś `complex=[real,imag]` jest jawna.

### 9.6 `response_fields.zarr`

```text
peak_XXXX/vector_xyz_complex    [carrier, 3, 2]
```

Metadane piku zapisują:

- biny źródłowe;
- centralną częstotliwość;
- estymatę częstotliwości sub-bin;
- amplitudę i fazę;
- definicję normalizacji;
- source spectrum confidence;
- carrier/topology identity.

### 9.7 Chunking i integralność

Pierwsza fizyczna realizacja używa Zarr v2, ponieważ jest już obecna w Fullmag. Logiczny kontrakt nie zależy od wersji kontenera.

Wymagania:

- chunki ograniczone do kilku MiB;
- chunking wzdłuż czasu i carrier, nie jeden chunk całego pola;
- jawny compressor i parametry;
- dtype i endian w metadanych;
- hash metadanych i payloadu;
- bounded partial read;
- atomiczne opublikowanie statusu `ready` dopiero po walidacji.

### 9.8 HDF5

HDF5 odzwierciedla ten sam logiczny model:

```text
/analysis/time_domain_spectral/{analysis_id}/time_series/time_s
/analysis/time_domain_spectral/{analysis_id}/time_series/magnetization
/analysis/time_domain_spectral/{analysis_id}/spectra/frequency_hz
/analysis/time_domain_spectral/{analysis_id}/spectra/response_complex
/analysis/time_domain_spectral/{analysis_id}/response_fields/peak_XXXX/vector_xyz_complex
```

Zarr i HDF5 muszą dawać równoważne wartości, jednostki, osie i checksum logicznego payloadu. Nie posiadają odrębnych definicji naukowych.

## 10. Natywny silnik spektralny

### 10.1 Interfejs

```rust
pub trait SpectralEngine {
    fn inspect(&self, source: &TimeSeriesDescriptor) -> Result<SpectralInspection>;
    fn execute(
        &self,
        source: &TimeSeriesReader,
        request: &ResolvedSpectralAnalysis,
        sink: &mut SpectralArtifactWriter,
        cancellation: &CancellationToken,
    ) -> Result<SpectralExecutionReceipt>;
}
```

### 10.2 Zakres baseline

Natywny baseline obsługuje:

- walidację osi;
- detrend constant/linear;
- rectangular/Hann/Hamming/Blackman;
- RFFT;
- PSD, amplitude i complex spectrum;
- susceptibility;
- peak detection z prominence i separation;
- zespolone pola dla wybranych binów;
- globalne i region-weighted observables;
- 1D `S(k,f)` przez jawny operator próbkowania.

### 10.3 Strumieniowanie

Silnik nie materializuje całego `[time, carrier, 3]` bez jawnego budżetu. Przetwarzanie używa bloków carrier oraz bounded scratch buffers.

## 11. Integracja MMPP

### 11.1 Adapter odczytu

Adapter mapuje:

- Fullmag Hz → MMPP frequency representation;
- carrier descriptor → dataset wrapper;
- `[carrier,3,2]` → jawny widok zespolony;
- jednostki SI;
- slice, mask i downsampling;
- topology/probe identity.

FEM nie może być reshape'owane do `(z,y,x,3)` bez zatwierdzonego operatora projekcji.

### 11.2 Worker

Worker działa w osobnym procesie i posiada protokół:

```text
handshake
protocol_version
input_manifest_hash
analysis_request_hash
resource_limits
progress
cancellation
output_manifest_hash
exit_status
```

Awaria workera nie uszkadza źródłowego runu. Wynik częściowy nie otrzymuje statusu `ready`.

Worker wykonuje wyłącznie analizę, dla której planner zapisał `resolved_analysis_engine=mmpp`. Błąd uruchomienia, protokołu, timeout albo błąd obliczeń nie uruchamia natywnego silnika zastępczo. Analogicznie `resolved_analysis_engine=native` nie przełącza się na MMPP. Nowa próba z innym engine jest nowym requestem z nową identity i osobnym receipt.

### 11.3 Provenance MMPP

Artefakt zapisuje:

- `producer = mmpp`;
- wersję MMPP;
- commit/package identity;
- Python i dependency lock identity;
- requested/resolved engine;
- parametry operacji;
- wejściowe i wyjściowe checksumy;
- ograniczenia RAM/CPU;
- wynik parity check, jeśli wykonany.

## 12. Realizacje backendowe

### 12.1 FDM CPU

FDM CPU jest referencyjnym oracle dla:

- waveform;
- field drive;
- exact-time sampling;
- układu cell-carrier;
- małych testów FFT.

### 12.2 FDM GPU

Zakres obejmuje implementację `RegionalFieldDrive` w CUDA, zanim lane może zostać promowany dla time-domain spectroscopy.

Wymagania:

- forced GPU;
- brak CPU hot-loop fallback;
- jawny transfer próbek;
- bounded staging buffers;
- device/residency receipt;
- double precision parity przed single precision.

### 12.3 FEM CPU

FEM CPU zachowuje natywny node-carrier. Pełne pole FFT jest temporalną transformacją wartości węzłowych. Finite-k wymaga P1/probe operatora z fizycznymi współrzędnymi.

### 12.4 FEM GPU

FEM GPU używa tych samych backend-neutralnych definicji fizycznych, ale osobnej realizacji MFEM/hypre/libCEED/CUDA. Finalne dowody pochodzą z container-backed `just` recipes.

### 12.5 Mixed FEM

Zapis pola zachowuje typed topology:

- `tet4`;
- `prism6`;
- `pyramid5`.

Operator finite-k deklaruje obsługiwane typy. Brak obsługi kończy się `unsupported`; nie wolno ukrywać konwersji prism/pyramid do tet.

## 13. API v2

### 13.1 Rodzina zasobów

Kanoniczne zasoby są run-scoped:

```text
/v2/sessions/current/analysis/time-domain-spectral/{run_id}/{analysis_id}/manifest
/v2/sessions/current/analysis/time-domain-spectral/{run_id}/{analysis_id}/sampling
/v2/sessions/current/analysis/time-domain-spectral/{run_id}/{analysis_id}/time-series/{series_id}
/v2/sessions/current/analysis/time-domain-spectral/{run_id}/{analysis_id}/spectra/{spectrum_id}
/v2/sessions/current/analysis/time-domain-spectral/{run_id}/{analysis_id}/peaks
/v2/sessions/current/analysis/time-domain-spectral/{run_id}/{analysis_id}/response-fields/{field_id}
/v2/sessions/current/analysis/time-domain-spectral/{run_id}/{analysis_id}/dynamic-structure-factor
/v2/sessions/current/analysis/time-domain-spectral/{run_id}/{analysis_id}/progress
/v2/sessions/current/analysis/time-domain-spectral/{run_id}/{analysis_id}/diagnostics
/v2/sessions/current/analysis/time-domain-spectral/{run_id}/{analysis_id}/exports
```

`run_id` jest częścią ścieżki, dlatego zakończony run jest odczytywany bez aliasu `latest`. Istniejąca rodzina `/v2/sessions/current/analysis/spin-wave-response/{run_id}/*` pozostaje wyłącznie read-only compatibility adapterem dla legacy artefaktów; nowe runy i nowy UI jej nie zapisują ani nie traktują jako authority.

### 13.2 Data plane

Ciężkie payloady przechodzą przez wersjonowane binary resources lub artifact references. JSON nie zawiera wielkich tablic.

### 13.3 Status crosswalk

Statusy są ortogonalne i nie mogą być scalone w jeden enum:

| Oś | Wartości | Reguła |
|---|---|---|
| `execution_status` | `planned`, `queued`, `running`, `succeeded`, `failed`, `cancelled`, `unsupported` | stan próby obliczeniowej |
| `artifact_status` | `missing`, `incomplete`, `ready`, `invalid` | stan opublikowanego data-plane |
| `validation_state` | `unvalidated`, `algebra_validated`, `physics_validated`, `production_qualified` | poziom dowodu naukowego |
| `product_status` | `unsupported`, `semantic_only`, `reference_executable`, `partial_production_executable`, `production_executable` | gotowość capability scope |
| frontend resource lifecycle | `idle`, `loading`, `stale`, `error` | lokalny stan klienta, nie pole udanego payloadu |

`execution_status=succeeded` wymaga `artifact_status=ready`, ale nie implikuje `production_qualified`. `failed` lub `cancelled` może pozostawić tylko `missing` albo `incomplete`; `unsupported` zawsze ma `missing`. Termin `partial` nie jest statusem sukcesu: jest reprezentowany przez `artifact_status=incomplete` wraz z właściwym execution status. Brak zasobu zwraca 404 i nie jest automatycznie `unsupported`.

### 13.4 Realtime

Realtime publikuje:

- resource key;
- revision;
- invalidation reason;
- bounded progress hint.

Nie przenosi kanonicznych widm ani pól.

## 14. Control Room

### 14.1 Authoring

Komenda `Add Time-Domain Spectroscopy Pipeline` tworzy typowany zestaw stage'y, który round-tripuje do Python DSL.

Inspector pokazuje:

- excitation cutoff;
- sampling interval;
- sample rate;
- Nyquist;
- duration;
- frequency resolution;
- sample count;
- prognozowany rozmiar;
- backend/device/precision capability;
- walidację źródła i produktów.

### 14.2 Execution tree

Jeden `study.run` pokazuje osobne węzły:

- equilibrium;
- antenna field solve;
- dynamics;
- sampling finalization;
- spectral analysis;
- export.

Każdy węzeł ma requested/resolved execution, progress, stop reason i artifact references.

### 14.3 Results Explorer

```text
Time-Domain Spectroscopy
  Overview
  Dynamics
  Spectrum
  Susceptibility
  Peaks
  FFT Response Fields
  Dynamic Structure Factor
  Diagnostics
  Exports
```

Historyczny run ładuje własne run-scoped zasoby; nie może wyświetlać pustej projekcji bieżącej sesji.

### 14.4 Analysis surface

`analysis-plots` renderuje:

- `m(t)` i source trace;
- amplitude/power/phase;
- susceptibility;
- peak labels;
- `S(k,f)`;
- cuts po f i k;
- porównanie runów.

Każdy wykres ma jednostki, DOM summary, kontrolę klawiaturą i bounded point table.

### 14.5 Pole 3D

Wybór piku prowadzi:

```text
peak selection
-> response-field metadata resource
-> binary vector resource
-> AnalysisFieldOverlayController
-> viewport-3d
```

Jedyny canvas WebGL należy do `viewport-3d`. Animacja fazy jest demand-driven i zatrzymuje się po wyłączeniu.

### 14.6 Stan i lifecycle

- serwerowe dane należą do resource hooks/cache;
- Zustand przechowuje tylko identyfikatory i preferencje;
- duże typed arrays nie trafiają do React state;
- nie ma pollingu;
- nieaktywny ciężki center surface jest odmontowany;
- ECharts i WebGL resources są zwalniane na unmount;
- background refresh zachowuje last-good view.

## 15. Eksport

Dozwolone produkty:

- pełny FMS bundle;
- Zarr;
- równoważny HDF5;
- CSV dla bounded traces/spectrum/peaks;
- PNG/SVG dla wykresów;
- wybrane zespolone pole;
- manifest-only provenance report.

Każdy eksport posiada:

- schema version;
- source identity;
- analysis request;
- requested/resolved execution;
- jednostki;
- checksumy;
- listę pominiętych danych;
- status kwalifikacji.

## 16. Obsługa błędów

### 16.1 Fail-closed

Następujące sytuacje są błędami:

- brak wymaganej ilości;
- uszkodzony chunk;
- niezgodny topology hash;
- sprzeczna phase convention;
- nieznana jednostka;
- nierównomierna oś oznaczona jako exact;
- nieobsługiwany backend/device;
- worker protocol mismatch;
- przekroczenie budżetu bez zgody;
- częściowy artefakt przedstawiany jako pełny.

### 16.2 Odzyskiwanie

Postprocessing można wznowić od ostatniego atomowo zatwierdzonego produktu. Źródłowy time-series pozostaje immutable. Ponowienie nie usuwa poprzedniej udanej analizy; tworzy nową identity.

### 16.3 Degraded i brak kwalifikacji

`degraded` opisuje ograniczoną prezentację lub brak produktu opcjonalnego i należy do diagnostyki/UI. Wynik policzony poza zatwierdzonym zakresem zachowuje `validation_state=unvalidated` albo niższy od `production_qualified`. Te osie nie są synonimami i nie tworzą dodatkowego execution status.

## 17. Wydajność i limity

Wymagania projektowe:

- bounded chunk reads i writes;
- brak pełnego bufora HDF5 w pamięci;
- anulowanie między chunkami;
- backpressure writerów;
- jawne limity RAM/dysku;
- zero idle polling;
- zero idle chart redraw;
- zero idle WebGL frames;
- bounded worker/process count;
- cache key oparty na immutable identity;
- brak automatycznej redukcji jakości.

Konkretne budżety liczbowe zostaną ustalone na podstawie baseline pomiarowego i zapisane w qualification scope. Brak pomiaru jest `NOT MEASURED`, nie zerem.

## 18. Bezpieczeństwo i integralność

- wszystkie artifact paths są rozwiązywane pod zatwierdzonym rootem sesji;
- brak zaufania do ścieżek z manifestu;
- checksum przed publikacją `ready`;
- MMPP worker otrzymuje tylko zatwierdzone wejścia i katalog wyjściowy;
- protokół nie wykonuje kodu z manifestu;
- eksport waliduje symlinki i traversal;
- cancellation i timeout nie pozostawiają artefaktu `ready`;
- logi nie zawierają sekretów ani pełnych payloadów.

## 19. Kwalifikacja naukowa

### 19.1 Oracles

- pojedyncza sinusoida o znanej częstotliwości i fazie;
- dwie bliskie częstotliwości;
- sygnał z DC i trendem;
- tłumiona precesja/Kittel;
- znany traveling wave o określonym k;
- source/response z analityczną podatnością;
- zero excitation;
- paired control subtraction.

### 19.2 Convergence

- `dt` convergence;
- observation-window convergence;
- mesh convergence;
- probe-resolution convergence;
- window/leakage sensitivity;
- CPU/GPU double parity;
- FDM/FEM agreement w wspólnym zakresie fizycznym.

### 19.3 MMPP parity

Na tym samym artefakcie porównujemy:

- frequency axis;
- complex amplitude;
- power;
- peak IDs/frequencies;
- phase;
- response fields;
- `S(k,f)`.

Różnice są oceniane względem jawnych tolerancji i convention mapping.

## 20. Kwalifikacja produktu

Oddzielne dowody:

1. source/contract tests;
2. Python/IR/planner round-trip;
3. backend runtime;
4. artifact validation;
5. API resources;
6. frontend unit/integration;
7. live browser;
8. WebGL;
9. export/import;
10. production managed runtime receipt.

Testy DOM nie są dowodem WebGL. Obecność artefaktu nie dowodzi spójnej projekcji sesji i UI.

## 21. Rollout

### Faza A — kontrakty i CPU oracle

- nota fizyczna;
- Python/IR/planner;
- time-series artifact;
- natywny CPU FFT;
- FDM CPU oracle;
- adapter odczytu MMPP.

### Faza B — FEM CPU i resource-first API

- FEM node-carrier;
- P1/probe finite-k;
- run-scoped resources;
- Analysis/Explorer/Inspector;
- eksport.

### Faza C — GPU

- FDM GPU regional drive;
- bounded GPU sampling;
- FEM GPU parity;
- strict forced-GPU receipts;
- double precision qualification;
- single precision dopiero po osobnej bramce.

### Faza D — solved antenna i rozszerzenia MMPP

- produkcyjny `AntennaFieldSolve`;
- `SolvedAntennaDrive`;
- worker protocol;
- rozszerzona dyspersja/transmission;
- HDF5 parity.

### Faza E — produkcyjna kwalifikacja

- immutable candidate;
- pełna macierz lane'ów;
- browser/WebGL proof;
- performance budgets;
- docs/source maps;
- release gate.

## 22. Non-goals

Pierwsza implementacja nie:

- utożsamia pików FFT z eigenmodami;
- zastępuje eigensolve;
- wykonuje niejawnego FE→grid reshape;
- wymaga MMPP do podstawowego działania;
- promuje 2.5D antenna model dla taperu;
- obniża jakości wizualizacji dla wydajności;
- wprowadza nowej aplikacji obok Control Room;
- przenosi ciężkich danych przez WebSocket;
- utrzymuje wielu właścicieli tego samego zasobu.

## 23. Kryteria akceptacji projektu

Projekt jest zrealizowany dopiero, gdy:

- istnieje kanoniczny Python round-trip;
- `TimeDomainSpectralAnalysisIR` jest typowany i walidowany;
- planner rozróżnia solver clock i output clock;
- źródłowy time-series jest immutable i chunked;
- native FFT i MMPP adapter konsumują ten sam kontrakt;
- Zarr/HDF5 są logicznie równoważne;
- response fields mają stabilną identity i data-plane;
- wszystkie lane'y publikują prawdziwy capability status;
- forced GPU nie fallbackuje;
- API obsługuje historyczne runy;
- UI automatyzuje cały pipeline i zachowuje naukowe nazewnictwo;
- eksport zachowuje provenance;
- oracles, convergence, parity, failure injection i browser/WebGL gates przechodzą dla deklarowanego scope;
- nie pozostają sprzeczne statusy dokumentacji, capability, manifestu, sesji i UI.

## 24. Dekompozycja planów wykonawczych

Realizacja jest podzielona na niezależne, reviewable plany:

1. `docs/superpowers/plans/2026-08-31-time-domain-spectral-analysis-contracts-and-storage.md`;
2. `docs/superpowers/plans/2026-08-31-time-domain-spectral-analysis-backends.md`;
3. `docs/superpowers/plans/2026-08-31-time-domain-spectral-analysis-api-ui.md`;
4. `docs/superpowers/plans/2026-08-31-time-domain-spectral-analysis-validation-rollout.md`;
5. `docs/superpowers/plans/2026-08-31-time-domain-spectral-analysis-master-plan.md`.

Masterplan definiuje kolejność integracji i bramki między planami. Żaden plan lane'u GPU nie może promować produktu przed ukończeniem kontraktu CPU oracle i artifact validatora.
