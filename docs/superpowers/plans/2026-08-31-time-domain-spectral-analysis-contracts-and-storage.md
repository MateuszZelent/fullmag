# Time-domain spectral analysis: contracts and storage implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Wprowadzić kanoniczny, publikowalny i backend-neutralny workflow analizy spektralnej w domenie czasu: relaksacja lub stan równowagi, jawne wzbudzenie mikrofalowe, całkowanie LLG, próbkowanie \(m(t,r)\), transformacje FFT/DSF, detekcja pików, pola odpowiedzi oraz eksport reprodukowalnych artefaktów do Zarr v2, równoważnego HDF5, FMS i adaptera MMPP.

**Architecture:** Semantyka fizyczna pozostaje w docs/physics i wspólnym ProblemIR. Python DSL opisuje intencję, planner rozwiązuje zegar oraz legalność backendu, runner rejestruje próbki i wykonuje analizę w nowym crate backend-neutralnym, a FDM/FEM CPU/GPU dostarczają wyłącznie stan i obserwatory. Format artefaktów jest identyczny logicznie w Zarr v2 i HDF5. MMPP jest opcjonalnym, jawnie wybranym workerem bez cichego fallbacku.

**Tech Stack:** Rust workspace (fullmag-ir, fullmag-plan, fullmag-runner, fullmag-session, nowy fullmag-analysis, nowy fullmag-mmpp-adapter), Python DSL w packages/fullmag-py, NumPy/SciPy w workerze MMPP, Zarr v2, HDF5, FMS ZIP64, istniejące just recipes oraz managed FEM runtime.

## Global Constraints

- [ ] Nie zmieniać żadnego pliku poza wskazanym planem podczas wykonywania tego planu; każde zadanie implementacyjne musi mieć osobny, jawny zakres zmian.
- [ ] Nie używać niejawnego CPU/GPU fallbacku. Żądanie wymuszonego backendu lub urządzenia kończy się typowanym błędem, gdy capability nie jest spełnione.
- [ ] Rozdzielić cztery lane: FDM CPU reference, FDM GPU/CUDA, FEM CPU/MFEM, FEM GPU/MFEM/CUDA. Dowód z jednej lane nie certyfikuje innej.
- [ ] Fizyka i dokumentacja używają SI: \(m\) bezwymiarowe, \(M_s\) w A/m, \(H\) w A/m, \(B\) w T, czas w s, częstotliwość kątowa w rad/s, częstotliwość w Hz, długość w m, energia w J.
- [ ] Każda wielkość publiczna ma jednostkę, wymiar osi, semantykę próbkowania, zakres ważności i źródło provenance.
- [ ] Próbki czasu adaptacyjnego nie mogą być podawane bezpośrednio do FFT jako równomierne. Planner musi wybrać równomierny zegar fizyczny albo jawny resampler z raportowanym błędem.
- [ ] accepted_step jest obserwacją solvera, nie substytutem czasu fizycznego; FFT i DSF wymagają physical_time po walidacji równomierności.
- [ ] Zarr v2 i HDF5 muszą mieć ten sam model logiczny osi, dtype, jednostek, chunków, manifestu i hashy payloadów. Różnica jest wyłącznie w kontenerze.
- [ ] Artefakt niekompletny ma stan incomplete i nie jest prezentowany jako wynik kwalifikowany. Przerwanie procesu nie może udawać kompletnego szeregu.
- [ ] Eksport FMS jest jawnie wybranym profilem. Zapis surowych plików obok runu nie oznacza automatycznego włączenia ich do FMS.
- [ ] MMPP jest osobną realizacją analizy. `native` i `mmpp` są fail-closed, a `auto` jest deterministycznie rozwiązywane przez planner przed wykonaniem: baseline preferuje native, MMPP może zostać wybrane tylko dla kompletnego, niewspieranego natywnie zestawu produktów. Po rozwiązaniu brak procesu, błąd protokołu, timeout lub błąd operacji nie uruchamia zastępczej implementacji.
- [ ] Nazwy spin_wave_response.gamma.v1 i dynamic_structure_factor.1d.v1 pozostają odczytywalne przez migrator, ale nowe runy zapisują rodzinę logicznych schematów `fullmag.time_domain_spectral_analysis.v1`, `fullmag.analysis.time_domain_spectral.manifest.v1`, `fullmag.analysis.sampling.v1`, `fullmag.analysis.time_series.v1`, `fullmag.analysis.spectra.v1`, `fullmag.analysis.peaks.v1`, `fullmag.analysis.response_fields.v1` i `fullmag.analysis.dynamic_structure_factor.v1`. Zarr v2 oznacza wersję kontenera, nie wersję tych schematów.
- [ ] response_fields nie mogą być mylone z pełną falą magnetyzacji. Kontrakt musi wskazywać, czy pole jest Δm, ΔB, χ, czy inną zdefiniowaną wielkością.
- [ ] Analiza nie może dodawać fizyki do backends/fem/cpu/mfem/mfem_bridge.cpp ani tworzyć wspólnego mutable state w native Context.
- [ ] Dla FEM/MFEM/CUDA pierwszą drogą budowy i runtime qualification są repozytoryjne managed just recipes; hostowe cargo i cmake są tylko pomocnicze.
- [ ] Każda bramka ma test negatywny dla złych jednostek, niezgodnych osi, niejednorodnego czasu, pustych próbek, niepełnego artefaktu i wymuszonego niedostępnego urządzenia.
- [ ] Plan nie obejmuje implementacji UI. API ma udostępnić artefakty i manifesty, lecz wizualizacja zostaje osobnym zadaniem.
- [ ] Nie wykonywać commitów w żadnym zadaniu. Po każdym zadaniu raportować git diff --name-only i zachować niezwiązane zmiany.

---

## Stan obecny i dowody wejściowe

Obecny Python DSL ma LLG, envelope i study stages, lecz nie ma kanonicznego kontraktu przestrzennego szeregu czasowego. packages/fullmag-py/src/fullmag/model/dynamics.py definiuje LLG, AdaptiveTimestep, FieldRefreshPolicy oraz integratory heun, rk4, rk23, rk45, abm3, coupled_imex_ark2, auto. packages/fullmag-py/src/fullmag/model/energy.py definiuje TimeDependence dla stałej, sinusoidalnej, pulse, PWL i sinc pulse; chirp nie jest obecnym typem.

Wzbudzenia są już reprezentowane przez packages/fullmag-py/src/fullmag/model/antenna.py, w tym RegionalFieldDrive, DriveActivation, profile pola i czas początkowy. packages/fullmag-py/src/fullmag/model/study.py ma TimeEvolution, Relaxation, TableAutosave i GammaResponseAnalysis. packages/fullmag-py/src/fullmag/world.py ma StudyStagesBuilder, add_relax, add_run, add_field_drive, autosave, tableautosave i fft_response, ale nie ma typed TimeSeriesSampling ani analizy pól modalnych.

packages/fullmag-py/src/fullmag/analysis/spectrum.py ogranicza się do 1D fft_from_trace, psd_from_trace, peak_frequency i linewidth_lorentzian. To nie jest jeszcze kontrakt dla m(t,r), wielu składowych, próbkowania adaptacyjnego, DSF ani odpowiedzi przestrzennej.

crates/fullmag-ir/src/model.rs ma TimeDependenceIR; crates/fullmag-ir/src/study.rs ma RegionalFieldDriveIR, TimeEnvelopeIR, SamplingIR, OutputIR i StageAutosaveIR; crates/fullmag-ir/src/plan.rs ma TimeStageContextIR, FdmPlanIR i FemPlanIR. Nowe typy powinny dołączyć do tych kontraktów bez duplikacji semantyki.

crates/fullmag-plan/src/sampling.rs ma SamplingResolutionIR i guard Nyquista 1.3 dla sinc. Obecne skanowanie rozpoznaje canonical RegionalFieldDrive z envelope sinc, ale nie opisuje celu analizy, osi przestrzennych, resamplingu ani kosztu pamięci.

crates/fullmag-runner/src/autosave_storage.rs definiuje StageSampleCoordinate, StageManifest, AutosaveArtifactManifest, ContinuousIndexEntry oraz trait AutosaveTargetWriter z begin_stage, append_table_row, append_field_sample, finish_stage. crates/fullmag-runner/src/autosave_zarr.rs zapisuje Zarr v2 z <f8, chunkami [1,width], bez kompresora; crates/fullmag-runner/src/autosave_hdf5.rs buforuje macierze i zapisuje grupy stage/table/fields.

crates/fullmag-runner/src/spin_wave_response.rs ma SpinWaveResponseArtifact, build_gamma_response_with_detrend, build_gamma_transverse_response_with_detrend i append_requested_spin_wave_artifacts. Wymaga jednostajnego trace i wytwarza analysis/spin_wave_response.gamma.v1.json. crates/fullmag-runner/src/spin_wave_sampling.rs ma P1CrossSectionProbeOperator, build_p1_x_cross_section_operator, dynamic_structure_factor_1d_with_axes i requested_finite_k_artifacts; obecny artefakt dynamic_structure_factor.1d.v1.json jest FEM/P1/tet4/rectangular-grid specific.

crates/fullmag-plan/src/fdm.rs materializuje regional drives dla FDM single-grid, a wymuszony CUDA z regional field drive kończy się fdm_cuda_regional_field_drive_unsupported. FDM multilayer odrzuca field_drives, bo jego plan nie zachowuje tych danych. crates/fullmag-plan/src/fem.rs zachowuje field_drives, field_drive_geometry_masks, antenna_zeeman_masks i time stage. crates/fullmag-runner/src/fdm/cpu/reference.rs ma resolved_regional_field_drives, materialize_reference_problem, record_due_outputs, record_final_outputs, regional_drive_energy oraz observe_state_with_antenna_field.

Native FEM interaction boundaries są w backends/fem/cpu/mfem/interactions/zeeman_regional_field.cpp, zeeman_regional_field.hpp, zeeman_time_dependence.cpp, zeeman_time_dependence.hpp oraz w GPU backends/fem/gpu/cuda/interactions/zeeman/regional_field_kernels.cu, regional_field_kernels.cuh. Analiza ma korzystać z obserwatora nad stage runnerem, nie ingerować w równania tych modułów.

crates/fullmag-session/src/fms.rs implementuje ZIP64 pack_fms, inspect_fms, unpack_fms; crates/fullmag-session/src/types.rs ma FmsSessionManifest, FmsRunManifest, FmsCheckpoint, ArtifactPolicy, FieldCapturePolicy i CompressionProfile. crates/fullmag-api/src/artifacts.rs przez collect_artifacts rozpoznaje .zarr, .h5, .json, .csv, .ovf i .autosave.json, z sanitizacją ścieżek.

W aktualnym repozytorium nie ma kodowej ścieżki MMPP; rg -i mmpp znajduje jedynie wzmianki dokumentacyjne i historyczny plan. Adapter oraz worker protocol są więc nowymi granicami, a nie refaktorem istniejącego API.

---

## Docelowy przepływ i granice

~~~text
Python DSL / UI intent
    -> ProblemIR: stage + drive + sampling + analysis request
    -> planner: capability, clock, memory, backend/device resolution
    -> runner: relax/equilibrium -> excitation -> LLG -> observer
    -> TimeSeriesSink: physical_time + m(t,r) + provenance
    -> fullmag-analysis: window/detrend -> FFT -> peaks/response/DSF
    -> artifact writers: Zarr v2 or equivalent HDF5
    -> FMS/export manifest and API artifact index
    -> optional MMPP worker through typed JSONL protocol
~~~

| Granica | Consumes | Produces | Właściciel |
|---|---|---|---|
| DSL → IR | TimeEvolution, drive, sampling, analysis options | TimeDomainSpectralAnalysisIR | fullmag-py, fullmag-ir |
| IR → planner | stage graph, backend intent, mesh/time limits | resolved clock, capabilities, resource estimate | fullmag-plan |
| planner → runner | ExecutionPlan, observer bindings, artifact policy | accepted stage runtime contract | fullmag-runner |
| backend → observer | accepted LLG states and physical times | MagnetizationSample | FDM/FEM lane |
| observer → analysis | ordered uniform samples with axes | spectra, peaks, fields | fullmag-analysis |
| analysis → storage | typed artifact batches and manifest | Zarr/HDF5 objects | runner writers |
| storage → FMS | relative artifact paths, hashes, provenance | FMS run entries | fullmag-session |
| analysis → MMPP | versioned JSONL request and payload references | versioned JSONL response | fullmag-mmpp-adapter |

### Kanoniczne typy domenowe

Proponowany crate crates/fullmag-analysis ma być backend-neutralny i nie importować MFEM, CUDA ani FDM Context. Jego publiczne typy mają obejmować:

~~~rust
pub enum SamplingClock {
    PhysicalTime,
    AcceptedStep,
}

pub struct TimeSeriesRequest {
    pub clock: SamplingClock,
    pub cadence_s: f64,
    pub spatial: SpatialSampling,
    pub components: Vec<MagnetizationComponent>,
    pub interpolation: InterpolationPolicy,
    pub storage: StoragePolicy,
}

pub struct TimeDomainSpectralAnalysis {
    pub analysis_id: String,
    pub source_stage_id: String,
    pub source_artifact_id: Option<String>,
    pub time_range_s: Option<[f64; 2]>,
    pub response_quantity_id: String,
    pub source_quantity_id: Option<String>,
    pub source_drive_ids: Vec<String>,
    pub spatial_selection: SpectralSpatialSelection,
    pub components: Vec<MagnetizationComponent>,
    pub reference: SpectralReference,
    pub transform: TemporalTransform,
    pub products: SpectralProducts,
    pub peak_detection: SpectralPeakDetection,
    pub requested_analysis_engine: SpectralAnalysisEngineRequest,
}
~~~

`TimeSeriesRequest` jest kontraktem etapu dynamiki i wytwarza immutable source artifact; analiza odwołuje się do niego przez `source_stage_id` oraz opcjonalny `source_artifact_id`, a nie osadza drugiej polityki próbkowania. SpectralProducts obejmuje TimeSeries, Spectra, Peaks, ResponseFields i DynamicStructureFactor. SpatialSampling rozróżnia GlobalAverage, ProbePoints, FdmCells, FemDofs, FemP1CrossSection; każdy wariant niesie własny układ współrzędnych i interpolację.

TransformSpec określa osiową konwencję FFT, one-sided/two-sided spectrum, normalizację amplitudy, window, detrend i tolerancję równomierności. WindowSpec dopuszcza Rectangular, Hann, Hamming, Blackman; DetrendSpec dopuszcza None, Mean, Linear. Wybór jest zapisany w manifeście, a nie odtwarzany z domyślnej wartości.

### Osie i równania

Dla znormalizowanego m(t,r) obserwator zapisuje komponenty mx, my, mz. Pole efektywne jest w A/m, a wzbudzenie zadane w B jest przeliczane przed wejściem do LLG przez Hrf=Brf/μ0. Kontrakt nie dopuszcza jednoczesnego pola w T opisanego jako H.

Dynamika LLG ma być interpretowana jako:
\[
\frac{\partial m}{\partial t} =
-\frac{\gamma\mu_0}{1+\alpha^2}
\left[m\times H_\mathrm{eff}
+\alpha\,m\times(m\times H_\mathrm{eff})\right].
\]
W planie zapisuje się użyte γ, α, μ0, jednostki i konwencję znaku.

Po relaksacji definiuje się Δm(t,r)=m(t,r)-m_eq(r). Jeśli użytkownik zażąda absolutnego sygnału, manifest przechowuje signal_reference=absolute; domyślną i kwalifikowaną wielkością modalną jest equilibrium_subtracted.

Dla równomiernego zegara t_n=nΔt transformata jest:
\[
\widetilde{s}(f_k)=\Delta t\sum_{n=0}^{N-1} w_n\,s(t_n)\,
e^{-2\pi i f_k t_n},
\qquad f_k=\frac{k}{N\Delta t}.
\]
Manifest zapisuje Δt, N, f_Nyquist, bin width, window coherent gain oraz detrend.

Dla przestrzennego DSF:
\[
S(k,\omega)=\frac{1}{N_tN_r}
\left|\sum_{n,j}w_n\,\Delta m(t_n,r_j)
e^{-i(\omega t_n-k r_j)}\right|^2.
\]
Dla nieregularnych punktów r_j planner wymaga jawnego operatora interpolacji lub odrzuca żądanie; nie wolno udawać jednostajnego k-grid.

response_fields definiuje się jako pole zespolone Δm(f,r) po transformacji w czasie, z osiami frequency_hz, spatial i component. Nie jest to χ, chyba że response_kind=complex_susceptibility i manifest zawiera źródłowe Hrf, jego fazę oraz normalizację.

---

## Kanoniczne artefakty i provenance

Każdy artefakt ma manifest z polami schema, artifact_kind, analysis_id, run_id, analysis_stage_id, source_stage_id, execution_status, artifact_status, validation_state, quantity, units, axes, dtype, shape, source_hash, payload_hash, requested/resolved source backend/device/precision, requested/resolved analysis engine, engine resolution reason/capability snapshot, requested/resolved analysis device/precision/transfer policy, mesh_fingerprint, sampling, transform i created_at. Pole kompatybilności `complete` jest pochodną `artifact_status=ready`, nie drugą authority.

Ścieżki logiczne w runie są stałe i wszystkie należą do jednego rootu `analysis/time_domain_spectral/{analysis_id}/`:

| Rodzaj | Ścieżka |
|---|---|
| manifest | analysis/time_domain_spectral/{analysis_id}/manifest.v1.json |
| sampling | analysis/time_domain_spectral/{analysis_id}/sampling.v1.json |
| szeregi czasowe | analysis/time_domain_spectral/{analysis_id}/time_series.zarr/ |
| widma | analysis/time_domain_spectral/{analysis_id}/spectra.zarr/ |
| piki | analysis/time_domain_spectral/{analysis_id}/peaks.v1.json |
| pola odpowiedzi | analysis/time_domain_spectral/{analysis_id}/response_fields.zarr/ |
| DSF | analysis/time_domain_spectral/{analysis_id}/dynamic_structure_factor.zarr/ |
| HDF5 compatibility | analysis/time_domain_spectral/{analysis_id}/time_domain_spectral.h5 |

time_series ma fizyczny czas, sygnał, współrzędne, maski i equilibrium reference. spectra ma częstotliwość, zespoloną amplitudę, power/PSD oraz normalizację. peaks ma częstotliwość, wysokość, szerokość, prominence, metodę i niepewność. response_fields ma zespolone wartości przestrzenne i źródłowy drive. DSF ma osie k, f, komponent i power.

Nie wolno używać pliku o nazwie spectrum.json bez identyfikatora schematu. Manifest, indeks ciągły i końcowa flaga kompletności muszą być zapisane przed zgłoszeniem artefaktu jako gotowego. Hash payloadu jest SHA-256 nad canonical bytes, z endianowością określoną w manifeście.

### Zarr v2

Docelowa struktura Zarr v2 dla szeregu czasowego:

~~~text
analysis/time_domain_spectral/{analysis_id}/time_series.zarr/
  .zgroup
  .zattrs
  manifest_ref
  time_s/.zarray
  time_s/0
  requested_time_s/.zarray
  time_error_s/.zarray
  magnetization/.zarray
  magnetization/0.0.0
  drive_field/.zarray
  sample_step_index/.zarray
  sample_quality_flags/.zarray
  coordinates/.zgroup
  coordinates/x_m/.zarray
  coordinates/x_m/0
~~~

`magnetization` i opcjonalne `drive_field` mają logiczne osie `[time, carrier, component]`, dtype jawnie wybrane jako `<f4` lub `<f8`, order C i bounded chunkowanie `[time_chunk, carrier_chunk, 3]`. `time_s`, `requested_time_s` i `time_error_s` mają shape `[time]` oraz dtype `<f8`. Komponenty, carrier descriptor i współrzędne są opisane w `.zattrs`, a nie kodowane w nazwie datasetu. Zespolone wyniki używają końcowej osi `complex=[real,imag]` o długości 2 zarówno w Zarr, jak i HDF5.

Każdy writer musi pisać `manifest.v1.json` atomowo przez plik tymczasowy w tym samym katalogu. Do chwili flush, zamknięcia payloadu, wyliczenia hashy i walidacji manifest ma `artifact_status=incomplete`; dopiero atomowa publikacja finalnego manifestu ustawia `artifact_status=ready` i emituje `artifact_ready`. Pole legacy `complete`, jeżeli jest eksportowane przez adapter kompatybilności, jest wyłącznie pochodną `artifact_status == ready`.

### Kontener zgodności HDF5

Równoważny plik HDF5 ma logiczne `storage_format=hdf5_compat_v1`; wersja biblioteki HDF5 i fizyczna superblock/file-format version są metadanymi implementacji, a nie nazwą kontraktu. Plik używa rootu `/analysis/time_domain_spectral/{analysis_id}/`, grup `time_series`, `spectra`, `response_fields` i `dynamic_structure_factor` oraz datasetu `manifest_json`. `time_series/magnetization` i `time_series/drive_field` mają layout `[time, carrier, component]`; wyniki zespolone mają końcową oś `[real,imag]`. Atrybuty schema, units, axes, dtype, order, chunk_shape i `artifact_status` są identyczne semantycznie z `.zattrs`; opcjonalne `complete` jest tylko pochodną dla kompatybilności.

Dla zespolonych wyników HDF5 używa końcowej osi długości 2 jako `<f8`; wybór jest globalnie ustalony przez logiczny schemat v1. Test równoważności porównuje wartości po dekodowaniu, nie surowe bajty kontenera.

---

## Kolejność wdrożenia

1. Najpierw publikacyjna fizyka i source map.
2. Następnie IR oraz Python round-trip.
3. Potem planner zegara, capability i resource estimate.
4. Następnie observer runnera i storage Zarr/HDF5.
5. Dopiero po stabilnym storage powstaje backend-neutral analysis crate.
6. Integracja FDM/FEM następuje przez observer bindings, osobno dla CPU/GPU.
7. FMS, API i MMPP są warstwami eksportu/adaptera po przejściu lokalnych kontraktów.
8. Końcowa kwalifikacja musi uruchomić wszystkie jawnie wspierane lane.

---

## Zadanie 1: nota publikacyjna i kontrakt fizyczny

**Pliki**

- Obecny wzorzec: docs/physics/ oraz noty wskazane przez physics-publication.
- Nowy plik: docs/physics/0997-time-domain-spectral-analysis.md.
- Nowa source map: docs/physics/0997-time-domain-spectral-analysis.source-map.json.
- Nowy ADR: docs/adr/0029-time-domain-spectral-analysis-artifact-and-engine.md.
- Nowy test kontraktu: scripts/test_time_domain_spectral_analysis_contract_docs.py.
- Istniejąca bramka zmian fizycznych: scripts/check_physics_docs_gate.py.

**Interfaces — Consumes / Produces**

- Consumes: LLG, RegionalFieldDrive, TimeDependenceIR, SamplingIR, obecne legacy gamma/DSF semantics.
- Produces: równania, tabela symboli SI, założenia, zakres ważności, FDM/FEM i CPU/GPU interpretation, Python/IR/planner/runtime/artifact impact, bibliography i source map.

- [ ] Napisać problem statement obejmujący relax/equilibrium, rf excitation, transient LLG, m(t,r), FFT, peaks, response fields i DSF.
- [ ] Zdefiniować sygnał absolutny i equilibrium-subtracted oraz obowiązkową provenance equilibrium stage.
- [ ] Zdefiniować envelope constant, sinusoidal, pulse, sinc i chirp; dla chirp podać f(t), phase i zakres sweep.
- [ ] Opisać fizyczne B kontra H, konwersję przez μ0, znak γ i convention precession.
- [ ] Ująć sampling theorem, adaptive-step resampling, Nyquist guard 1.3 oraz błąd interpolacji.
- [ ] Ująć jednowymiarową FFT, widmo one-sided/two-sided, coherent gain, PSD, peak/linewidth i ich jednostki.
- [ ] Ująć przestrzenny DSF, geometrię punktów, FEM P1 interpolation i ograniczenie FDM/FEM.
- [ ] Ująć `artifact_status=ready|incomplete` semantics, hash, endianowość oraz Zarr/HDF5 equivalence.
- [ ] Dodać tabelę obecny symbol → proponowany symbol → ścieżka implementacji.
- [ ] Napisać test publikacyjny sprawdzający nagłówki, tabelę parametrów, source map i brak niespójnych jednostek.
- [ ] Uruchomić `python -m pytest scripts/test_time_domain_spectral_analysis_contract_docs.py -q`.
- [ ] Oczekiwany wynik: test kontraktu noty i source map przechodzi, kod wyjścia 0.
- [ ] Uruchomić `python scripts/check_physics_docs_gate.py --base HEAD --head WORKTREE`.
- [ ] Oczekiwany wynik: `Physics documentation gate passed.` i kod wyjścia 0.

---

## Zadanie 2: ProblemIR dla analizy i zegara

**Pliki**

- crates/fullmag-ir/src/time_domain_spectral.rs — nowy moduł z TimeDomainSpectralAnalysisIR, TimeSeriesRequestIR, SamplingClockIR i SpectralAnalysisEngineRequestIR.
- crates/fullmag-ir/src/study.rs — integracja z StudyIR, SamplingIR, OutputIR, StageAutosaveIR.
- crates/fullmag-ir/src/model.rs — rozszerzenie TimeDependenceIR o typed chirp.
- crates/fullmag-ir/src/lib.rs — eksport modułu.
- crates/fullmag-ir/tests/time_domain_spectral_analysis_ir.rs — test round-trip i walidacji.

**Interfaces — Consumes / Produces**

- Consumes: Python-lowered stage graph, drive IDs, mesh/spatial selectors, existing SamplingIR.
- Produces: stabilny serializable IR, canonical JSON round-trip, typed validation errors and explicit backend intent.

Proponowane typy:

~~~rust
pub enum SamplingClockIR {
    PhysicalTime,
    AcceptedStep,
}

pub struct TimeSeriesRequestIR {
    pub clock: SamplingClockIR,
    pub cadence_s: f64,
    pub spatial: SpatialSamplingIR,
    pub components: Vec<MagnetizationComponentIR>,
    pub interpolation: InterpolationPolicyIR,
    pub storage: StoragePolicyIR,
}

pub enum SpectralOutputKindIR {
    TimeSeries,
    Spectra,
    Peaks,
    ResponseFields,
    DynamicStructureFactor,
}

pub struct TimeDomainSpectralAnalysisIR {
    pub analysis_id: String,
    pub source_stage_id: String,
    pub source_artifact_id: Option<String>,
    pub time_range_s: Option<[f64; 2]>,
    pub response_quantity_id: String,
    pub source_quantity_id: Option<String>,
    pub source_drive_ids: Vec<String>,
    pub spatial_selection: SpectralSpatialSelectionIR,
    pub components: Vec<MagnetizationComponentIR>,
    pub reference: SpectralReferenceIR,
    pub transform: TemporalTransformIR,
    pub products: SpectralProductsIR,
    pub peak_detection: SpectralPeakDetectionIR,
    pub requested_analysis_engine: SpectralAnalysisEngineRequestIR,
}
~~~

- [ ] Dodać serde names i schema version fullmag.time_domain_spectral_analysis.v1.
- [ ] Walidować dodatnie cadence_s, dodatni duration_s source stage, niepusty component set i unikalny analysis_id. Duration pochodzi wyłącznie z TimeEvolution stage i nie jest duplikowane w sampling IR.
- [ ] Odrzucić AcceptedStep dla transformacji wymagającej częstotliwości, chyba że istnieje jawny resample_to_physical_time.
- [ ] Powiązać source_drive_ids z istniejącymi drive IDs; nie akceptować nazwy obiektu jako identyfikatora fizyki.
- [ ] Przetestować JSON round-trip, nieznany output kind, zero duration, ujemny cadence, duplicate IDs i niezgodne units.
- [ ] Uruchomić cargo test -p fullmag-ir --test time_domain_spectral_analysis_ir.
- [ ] Oczekiwany wynik: wszystkie testy passed, w tym snapshot JSON z version v1.
- [ ] Uruchomić cargo test -p fullmag-ir.
- [ ] Oczekiwany wynik: istniejące testy IR pozostają zielone bez zmiany starych JSON contracts.

---

## Zadanie 3: Python DSL, chirp i canonical export

**Pliki**

- packages/fullmag-py/src/fullmag/model/time_domain_spectral.py — nowy TimeSeriesSampling i TimeDomainSpectralAnalysis.
- packages/fullmag-py/src/fullmag/model/energy.py — nowy Chirp oraz TimeDependence union.
- packages/fullmag-py/src/fullmag/model/study.py — publiczne pole analysis na TimeEvolution/Study.
- packages/fullmag-py/src/fullmag/world.py — StudyStagesBuilder.add_spectral_analysis.
- packages/fullmag-py/src/fullmag/__init__.py i eksporty modelu.
- packages/fullmag-py/tests/test_time_domain_spectral_analysis.py.
- packages/fullmag-py/tests/test_canonical_script_export.py.

**Interfaces — Consumes / Produces**

- Consumes: user-authored Python stage, istniejący RegionalFieldDrive, TimeDependence, TableAutosave.
- Produces: typed Python object, validation errors, deterministic to_ir(), canonical script export preserving sampling and transform options.

Proponowane publiczne API:

~~~python
@dataclass(frozen=True)
class TimeSeriesSampling:
    interval: float | str
    quantities: tuple = ("m",)
    clock: Literal["exact_physical_time", "accepted_step"] = "exact_physical_time"
    spatial: SpatialSampling = GlobalAverage()
    components: tuple = ("x", "y", "z")
    format: Literal["zarr", "hdf5"] = "zarr"
    resample_to_physical_time: bool = False

@dataclass(frozen=True)
class Chirp:
    start_frequency_hz: float
    stop_frequency_hz: float
    duration_s: float
    amplitude: float
    phase_rad: float = 0.0

@dataclass(frozen=True)
class TimeDomainSpectralAnalysis:
    name: str
    source_stage: str
    source_artifact: str | None = None
    response_quantity: str = "m"
    source_quantity: str | None = "H_drive"
    source_drives: tuple = ()
    reference: str = "equilibrium_artifact"
    components: tuple = ("x", "y", "z")
    products: SpectralProducts = SpectralProducts()
    peak_detection: SpectralPeakDetection = SpectralPeakDetection()
    window: str = "hann"
    detrend: str = "constant"
    engine: Literal["auto", "native", "mmpp"] = "auto"
~~~

`TimeSeriesSampling` pozostaje polem source run stage. `TimeDomainSpectralAnalysis` wskazuje gotowy source stage/artifact i nie deklaruje ponownie cadence ani duration.

- [ ] Rozszerzyć TimeDependence o chirp bez zmiany znaczenia istniejących envelope.
- [ ] Walidować amplitudę i częstotliwości w SI, stop_frequency_hz >= 0, dodatni duration oraz jedną bazę czasu.
- [ ] Dodać StudyStagesBuilder.add_spectral_analysis(stage_id, analysis) z błędem dla nieznanego stage.
- [ ] Zapisać transform options w to_ir() bez domyślnego dopisywania niewidocznych outputów.
- [ ] Zapewnić deterministic export kolejności pól, ID i tuple values.
- [ ] Testy obejmą DSL → IR → DSL semantic equality, chirp values, default explicitness, invalid units i duplicate analysis IDs.
- [ ] Uruchomić python -m pytest packages/fullmag-py/tests/test_time_domain_spectral_analysis.py -q.
- [ ] Oczekiwany wynik: test suite kończy się kodem 0, wszystkie przypadki API przechodzą.
- [ ] Uruchomić python -m pytest packages/fullmag-py/tests/test_canonical_script_export.py -q.
- [ ] Oczekiwany wynik: eksport zawiera TimeSeriesSampling, TimeDomainSpectralAnalysis i nie zawiera ukrytych fallbacków.

---

## Zadanie 4: planner sampling, capabilities i resource estimate

**Pliki**

- crates/fullmag-plan/src/sampling.rs — resolve_time_series_sampling, uniform-clock validator, resampling estimate.
- crates/fullmag-plan/src/validate.rs — validate_time_domain_analysis.
- crates/fullmag-plan/src/spectral_capabilities.rs — nowy właściciel capability names dla analizy.
- crates/fullmag-plan/src/lib.rs — eksport spectral_capabilities.
- crates/fullmag-plan/src/fdm.rs i crates/fullmag-plan/src/fem.rs — backend-specific legality.
- crates/fullmag-plan/tests/time_domain_sampling_plan.rs.
- crates/fullmag-plan/tests/time_domain_capabilities.rs.

**Interfaces — Consumes / Produces**

- Consumes: TimeDomainSpectralAnalysisIR, mesh counts, integrator, adaptive timestep policy, backend/device intent, stage duration.
- Produces: ResolvedSamplingPlan, ObserverBinding, CapabilityDecision, peak memory estimate, explicit failure reason.

Proponowany kontrakt:

~~~rust
pub struct ResolvedSamplingPlan {
    pub clock: SamplingClockIR,
    pub cadence_s: f64,
    pub sample_count: usize,
    pub nyquist_hz: f64,
    pub frequency_bin_hz: f64,
    pub resampling: Option<ResamplingPlan>,
    pub memory_bytes: u64,
}

pub struct CapabilityDecision {
    pub backend: String,
    pub device: String,
    pub supported: bool,
    pub required_capabilities: Vec<String>,
    pub missing_capabilities: Vec<String>,
}

pub struct ResolvedSpectralAnalysisEngine {
    pub requested: SpectralAnalysisEngineRequestIR,
    pub resolved: SpectralAnalysisEngineIR,
    pub resolution_reason: String,
    pub capability_snapshot_id: String,
}
~~~

- [ ] Obliczyć sample_count z duration/cadence z tolerancją końcową opisaną w manifeście.
- [ ] Zachować obecny sinc Nyquist guard 1.3, ale zwrócić jego wartość jako provenance.
- [ ] Dla adaptive integrator wymagać physical-time observer albo jawnego resamplera; accepted-step FFT zwrócić jako sampling_clock_invalid.
- [ ] Sprawdzić memory estimate przed uruchomieniem, osobno FDM cells, FEM DOFs i probe points.
- [ ] Odrzucić FDM multilayer drive+analysis, jeśli plan nie zachowuje drive data; błąd ma wskazywać crates/fullmag-plan/src/fdm.rs.
- [ ] Zachować istniejące fdm_cuda_regional_field_drive_unsupported; rozszerzyć decyzję o analysis capability, nie maskować błędu CPU.
- [ ] Zdefiniować capability strings: time_series.global_average, time_series.fdm_cells, time_series.fem_dofs, spectral.fft_uniform_time, spectral.dsf_1d, spectral.response_fields.
- [ ] Rozwiązać `auto|native|mmpp` przed wykonaniem i zapisać requested, resolved, resolution_reason oraz capability_snapshot_id. Jedna analiza ma jednego producenta; brak implicit product splitting i brak fallbacku po rozwiązaniu.
- [ ] Testy pokryją oversampling, duration mismatch, adaptive RK, memory overflow, unsupported lane, forced GPU i exact capability report.
- [ ] Uruchomić cargo test -p fullmag-plan --test time_domain_sampling_plan --test time_domain_capabilities.
- [ ] Oczekiwany wynik: decyzje legalności są deterministyczne i nie zawierają resolved CPU fallback przy requested GPU.
- [ ] Uruchomić cargo test -p fullmag-plan.
- [ ] Oczekiwany wynik: istniejące planner tests przechodzą bez zmiany starych capability names.

---

## Zadanie 5: runner observer i TimeSeriesSink

**Pliki**

- crates/fullmag-runner/src/time_series.rs — MagnetizationSample, TimeSeriesSink, ordering/clock validation.
- crates/fullmag-runner/src/analysis_pipeline.rs — stage lifecycle i finalization.
- crates/fullmag-runner/src/autosave_storage.rs — adapter istniejącego AutosaveTargetWriter.
- crates/fullmag-runner/src/lib.rs — eksport.
- crates/fullmag-runner/tests/time_series_sink.rs.

**Interfaces — Consumes / Produces**

- Consumes: accepted LLG state, physical time, equilibrium state, spatial coordinates, stage/run provenance.
- Produces: ordered time_s, magnetization[time,carrier,component], optional drive_field o tym samym układzie, equilibrium-subtracted signal, continuous index i execution/artifact status manifest.

Proponowany trait:

~~~rust
pub trait TimeSeriesSink {
    fn begin(&mut self, manifest: &TimeSeriesManifest) -> Result<(), AnalysisError>;
    fn append(&mut self, sample: &MagnetizationSample) -> Result<(), AnalysisError>;
    fn append_equilibrium(&mut self, equilibrium: &EquilibriumState) -> Result<(), AnalysisError>;
    fn finish(&mut self, outcome: ArtifactCompletion) -> Result<TimeSeriesArtifact, AnalysisError>;
}

pub enum ArtifactCompletion {
    Ready,
    Incomplete { reason_code: String },
}
~~~

- [ ] Wymagać monotonicznego physical_time; duplikat i cofnięcie czasu mają różne typowane błędy.
- [ ] Sprawdzać shape komponentów i przestrzeni przy pierwszym sample, a potem przy każdym append.
- [ ] Rozdzielić equilibrium od transient source; nie odejmować go bez flagi w request.
- [ ] Powiązać sample z stage_id, stage_index, accepted_step, physical_time i payload hash.
- [ ] Zaimplementować adapter do AutosaveTargetWriter, ale nie zmieniać semantyki istniejących table/field autosaves.
- [ ] Przerwanie po begin ma finalizować manifest jako incomplete i zachować liczbę zapisanych samples.
- [ ] Testy obejmą empty stream, first sample shape, time monotonicity, NaN/Inf, equilibrium mismatch, interruption i exact continuous index.
- [ ] Uruchomić cargo test -p fullmag-runner --test time_series_sink.
- [ ] Oczekiwany wynik: wszystkie testy lifecycle i failure semantics przechodzą.

---

## Zadanie 6: Zarr v2 writer i atomic completion

**Pliki**

- crates/fullmag-runner/src/analysis_zarr.rs — ZarrTimeSeriesWriter, ZarrSpectralWriter.
- crates/fullmag-runner/src/autosave_zarr.rs — współdzielone metadata/chunk helpers.
- crates/fullmag-runner/src/analysis_manifest.rs — manifest v1.
- crates/fullmag-runner/tests/analysis_zarr_v2.rs.
- scripts/validate_time_domain_artifacts.py.

**Interfaces — Consumes / Produces**

- Consumes: TimeSeriesSink batches, SpectralArtifact, manifest/provenance.
- Produces: Zarr v2 directory with exact paths, little-endian float64, canonical JSON metadata i authoritative `artifact_status` (legacy `complete` tylko jako pole pochodne).

- [ ] Ustalić dokładne schema strings: `fullmag.analysis.time_domain_spectral.manifest.v1`, `fullmag.analysis.sampling.v1`, `fullmag.analysis.time_series.v1`, `fullmag.analysis.spectra.v1`, `fullmag.analysis.peaks.v1`, `fullmag.analysis.response_fields.v1` i `fullmag.analysis.dynamic_structure_factor.v1`; zapisać niezależnie `storage_container=zarr` i `zarr_format=2`.
- [ ] Pisać .zgroup z zarr_format=2 i .zattrs z osiami, jednostkami, source hash i transform.
- [ ] Zaimplementować chunk writer, który nie ładuje całego runu do pamięci.
- [ ] Utrzymać compressor null, order C, dimension separator kropkowy, <f8; odstępstwo wymaga osobnego schema.
- [ ] Wprowadzić checksum po każdym chunku i końcowy payload_hash.
- [ ] Atomowo aktualizować continuous index oraz manifest przez temp file i rename.
- [ ] Odrzucić odczyt artefaktu bez .zarray, bez manifestu lub z `artifact_status != ready`; legacy `complete=false` mapować na `artifact_status=incomplete` tylko w importerze zgodności.
- [ ] Testy użyją małego sygnału analitycznego, sprawdzą każdy plik, shape, dtype, chunk shape, axes i dekodowanie.
- [ ] Uruchomić cargo test -p fullmag-runner --test analysis_zarr_v2.
- [ ] Oczekiwany wynik: reader test odtwarza wartości bitowo po dekodowaniu little-endian i potwierdza Zarr format 2.
- [ ] Uruchomić python scripts/validate_time_domain_artifacts.py --format zarr --path crates/fullmag-runner/tests/fixtures/time_domain_spectral/analytic_sine/time_series.zarr.
- [ ] Oczekiwany wynik: validator zwraca valid schema fullmag.analysis.*.v1, `zarr_format=2` i kod 0 dla kompletnego fixture.

---

## Zadanie 7: HDF5 writer równoważny logicznie

**Pliki**

- crates/fullmag-runner/src/analysis_hdf5.rs — Hdf5TimeSeriesWriter, Hdf5SpectralWriter.
- crates/fullmag-runner/src/autosave_hdf5.rs — wspólne group/dataset helpers.
- crates/fullmag-runner/tests/analysis_hdf5_equivalence.rs.
- scripts/validate_time_domain_artifacts.py — HDF5 path.
- scripts/compare_time_domain_artifacts.py — Zarr/HDF5 logical comparator.

**Interfaces — Consumes / Produces**

- Consumes: ten sam TimeSeriesArtifact i manifest, który otrzymuje Zarr writer.
- Produces: /analysis/{artifact-kind}/{analysis-id}/ HDF5 z tymi samymi axes, units, shapes, dtype i hashes logicznych.

- [ ] Utworzyć root `/analysis/time_domain_spectral/{analysis_id}` oraz grupy `time_series`, `spectra`, `response_fields`, `dynamic_structure_factor` i dataset `manifest_json`.
- [ ] Zapisać manifest_json jako UTF-8 oraz atrybuty scalar wymagane przez reader.
- [ ] Użyć little-endian float64 i chunków [1,component,spatial]; nie używać HDF5 compression bez jawnego schema.
- [ ] Użyć osobnych real i imag dla spectra/response_fields/DSF.
- [ ] Zachować `artifact_status=incomplete` do czasu flush, close, manifest hash i końcowej walidacji; `ready` publikuje się atomowo jako ostatni krok.
- [ ] Test porówna dekodowane arrays, axes, units, manifest i payload hashes względem tego samego Zarr fixture.
- [ ] Test negatywny odrzuci HDF5 z innym dtype, kolejnością osi, jednostką albo sample count.
- [ ] Uruchomić cargo test -p fullmag-runner --test analysis_hdf5_equivalence.
- [ ] Oczekiwany wynik: comparator zgłasza logical equivalence passed dla pary Zarr/HDF5 i dokładnie wskazuje pierwszą różnicę dla fixture uszkodzonego.

---

## Zadanie 8: backend-neutral FFT, peaks i resampling crate

**Pliki**

- crates/fullmag-analysis/Cargo.toml — nowy crate bez zależności MFEM/CUDA.
- crates/fullmag-analysis/src/lib.rs.
- crates/fullmag-analysis/src/engine.rs — publiczny SpectralEngine trait i bounded execution orchestration.
- crates/fullmag-analysis/src/resample.rs.
- crates/fullmag-analysis/src/fft.rs.
- crates/fullmag-analysis/src/peaks.rs.
- crates/fullmag-analysis/src/response_fields.rs.
- crates/fullmag-analysis/src/dsf.rs.
- crates/fullmag-analysis/tests/analytic_signals.rs.
- workspace Cargo.toml — jawny member.

**Interfaces — Consumes / Produces**

- Consumes: validated uniform TimeSeriesInput, optional equilibrium, source drive metadata and spatial coordinates.
- Produces: typed SpectraArtifact, PeaksArtifact, ResponseFieldsArtifact, DynamicStructureFactorArtifact.

- [ ] Zaimplementować mean/linear detrend przed windowing zgodnie z DetrendSpec.
- [ ] Zaimplementować FFT normalization z jawnie zapisanym coherent gain oraz one-sided DC/Nyquist rules.
- [ ] Zaimplementować resampling adaptive samples na target physical grid z raportem max/RMS interpolation error.
- [ ] Odrzucić input z mniej niż dwóch samples, non-finite values, duplicate times i non-monotonic times.
- [ ] Użyć stabilnej detekcji peaks z prominence, width i confidence metadata; nie utożsamiać najwyższego binu z jedynym modem.
- [ ] Wytwarzać response fields per component/spatial point bez redukcji globalnej.
- [ ] Wytwarzać DSF tylko dla regularnego przestrzennego gridu albo dla typed interpolation operatora.
- [ ] Zachować source_quantity, signal_reference, window, detrend, cadence_s w każdym wyniku.
- [ ] Test analityczny sinusoidy sprawdzi peak frequency w jednym binie z tolerancją zależną od Δf.
- [ ] Test impulsu sprawdzi flat phase/amplitude normalization, a test dwóch sinusoid sprawdzi dwa peaks.
- [ ] Test resamplera sprawdzi bounded error dla chirp i odmowę przekroczenia tolerancji.
- [ ] Uruchomić cargo test -p fullmag-analysis.
- [ ] Oczekiwany wynik: wszystkie testy sygnałów analitycznych i failure contracts przechodzą, bez zależności backendowych.

---

## Zadanie 9: integracja response_fields i DSF z legacy outputs

**Pliki**

- crates/fullmag-runner/src/spin_wave_response.rs — migrator spin_wave_response.gamma.v1 i nowy builder kanonicznych produktów v1.
- crates/fullmag-runner/src/spin_wave_sampling.rs — migrator dynamic_structure_factor.1d.v1 i wspólny DSF builder.
- crates/fullmag-runner/src/analysis_pipeline.rs.
- crates/fullmag-runner/tests/legacy_analysis_migration.rs.
- docs/physics/0997-time-domain-spectral-analysis.md — tabela migracji.

**Interfaces — Consumes / Produces**

- Consumes: legacy scalar gamma traces, FEM P1 cross-section probes, TimeSeriesArtifact.
- Produces: canonical `fullmag.analysis.spectra.v1`, `fullmag.analysis.peaks.v1`, `fullmag.analysis.response_fields.v1`, `fullmag.analysis.dynamic_structure_factor.v1` plus read-only legacy import.

- [ ] Zmapować global gamma trace na spatial=GlobalAverage i zapisać ograniczenie utraty informacji.
- [ ] Zmapować P1CrossSectionProbeOperator na spatial=FemP1CrossSection, zachowując tet4 restriction w provenance.
- [ ] Ujednolicić frequency_hz, k_inverse_m, components i complex data layout.
- [ ] Nie przepisywać legacy artifact bytes; migrator ma wytworzyć nowy artifact z source_schema i hash.
- [ ] Odrzucić legacy artifact z niejednostajnym czasem zamiast automatycznie zmieniać axis.
- [ ] Test porówna wartości legacy/canonical w dopuszczalnej tolerancji i sprawdzi migration_source.
- [ ] Test sprawdzi, że brak spatial coordinates nie jest przedstawiony jako response field.
- [ ] Uruchomić cargo test -p fullmag-runner --test legacy_analysis_migration.
- [ ] Oczekiwany wynik: legacy fixture jest czytelny, canonical v1 ma pełne provenance, a odrzucenie złego czasu jest typowane.

---

## Zadanie 10: FMS manifest, pack/inspect/unpack i eksport

**Pliki**

- crates/fullmag-session/src/types.rs — FmsRunManifest, FmsAnalysisManifest, AnalysisExportPolicy.
- crates/fullmag-session/src/fms.rs — pack/inspect/unpack analysis refs.
- crates/fullmag-session/src/lib.rs.
- crates/fullmag-session/tests/fms_analysis_roundtrip.rs.
- crates/fullmag-api/src/artifacts.rs — collect/sanitize analysis paths.

**Interfaces — Consumes / Produces**

- Consumes: ready or incomplete analysis manifests, relative artifact dirs, hashes, run provenance and export profile.
- Produces: FMS entries under runs/{run_id}/artifacts/analysis/{artifact-kind}/{analysis-id}/, manifest refs and verified restore classification.

Proponowane typy:

~~~rust
pub struct AnalysisExportPolicy {
    pub include_time_series: bool,
    pub include_spectra: bool,
    pub include_peaks: bool,
    pub include_response_fields: bool,
    pub include_dynamic_structure_factor: bool,
}

pub struct FmsAnalysisManifest {
    pub schema: String,
    pub artifact_kind: String,
    pub analysis_id: String,
    pub relative_path: String,
    pub payload_hash: String,
    pub artifact_status: String,
}
~~~

- [ ] Dodać analysis_refs: Vec<String> do FmsRunManifest, zachowując serde compatibility dla starych FMS.
- [ ] Przypisać artefakt do runs/{run_id}/artifacts, a nie do root objects bez ref.
- [ ] Pack respektuje AnalysisExportPolicy; brak włączenia jest jawny w inspect output.
- [ ] Inspect pokazuje schema, kind, analysis ID, trzy osie statusu, hash, source execution, analysis engine, analysis execution i restore class.
- [ ] Unpack odrzuca path traversal, absolute path, hash mismatch i incomplete artifact przy ExactResume.
- [ ] ConfigOnly może odtworzyć konfigurację bez payloadu, ale musi zaznaczyć brak danych analizy.
- [ ] Test round-trip pack → inspect → unpack porówna logical hashes Zarr/HDF5 i listę refs.
- [ ] Test stary manifest bez analysis_refs sprawdzi domyślną pustą listę bez zmiany restore class.
- [ ] Uruchomić cargo test -p fullmag-session --test fms_analysis_roundtrip.
- [ ] Oczekiwany wynik: FMS round-trip jest deterministyczny, a błędny hash kończy się artifact_hash_mismatch.

---

## Zadanie 11: MMPP adapter i worker protocol

**Pliki**

- crates/fullmag-mmpp-adapter/Cargo.toml — nowy crate.
- crates/fullmag-mmpp-adapter/src/protocol.rs.
- crates/fullmag-mmpp-adapter/src/worker.rs.
- crates/fullmag-mmpp-adapter/src/lib.rs.
- scripts/mmpp_worker.py — worker JSONL.
- scripts/tests/test_mmpp_worker_protocol.py.
- crates/fullmag-mmpp-adapter/tests/protocol_contract.rs.

**Interfaces — Consumes / Produces**

- Consumes: canonical artifact ref, operation, analysis options, worker command path and timeout.
- Produces: versioned result ref or typed error; worker nie zapisuje poza wskazanym output root.

Protokół ma używać dokładnie fullmag.mmpp.worker.v1. Request JSONL:

~~~json
{"schema":"fullmag.mmpp.worker.v1","request_id":"req-0001","operation":"spectrum","input":{"artifact_path":"analysis/time_domain_spectral/a1/time_series.zarr","format":"zarr","source_hash":"sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"},"options":{"window":"hann","detrend":"constant","outputs":["spectra","peaks"]},"output_root":"analysis/time_domain_spectral/a1/mmpp-work"}
~~~

Dozwolone operations: validate, spectrum, peaks, response_fields, dynamic_structure_factor. Odpowiedź sukcesu zawiera schema, request_id, status=ok, artifacts, metrics, worker_version; błąd zawiera status=error, error_code, message, retryable, stderr_ref.

- [ ] Zaimplementować strict JSON schema validation po obu stronach.
- [ ] Ograniczyć worker do kanonicznych logicznych schematów v1 w kontenerze Zarr v2 lub HDF5; legacy wymaga jawnej migracji przed wywołaniem.
- [ ] Wymagać source hash equality przed obliczeniem; wynik zapisuje input/output hashes.
- [ ] Walidować operation-specific options: DSF wymaga spatial axis, response_fields wymaga response source.
- [ ] Zwracać worker_unavailable dla nieuruchamialnego procesu, worker_protocol_error dla złego JSONL i worker_timeout dla przekroczenia czasu.
- [ ] Nie uruchamiać Rust/Python alternatywy, gdy planner rozwiązał MMPP; adapter ma zakończyć request błędem. `auto` rozwiązuje się przed startem i nie jest podstawą do fallbacku po awarii.
- [ ] Test worker Python pokryje każdą operację, pustą linię, zły schema, zły hash, timeout i unknown operation.
- [ ] Test Rust adapter sprawdzi quote/argv safety, output-root confinement i typed error mapping.
- [ ] Uruchomić python scripts/tests/test_mmpp_worker_protocol.py.
- [ ] Oczekiwany wynik: wszystkie testy protokołu przechodzą; błąd worker availability ma stabilny error_code.
- [ ] Uruchomić cargo test -p fullmag-mmpp-adapter.
- [ ] Oczekiwany wynik: adapter nie wykonuje żadnego fallbacku i zachowuje request_id w każdej odpowiedzi.

---

## Zadanie 12: FDM i FEM observer bindings, osobne CPU/GPU lane

**Pliki**

- FDM CPU: crates/fullmag-runner/src/fdm/cpu/reference.rs — observer hook po observe_state_with_antenna_field, record_due_outputs, record_final_outputs.
- FDM planner: crates/fullmag-plan/src/fdm.rs — capability and field-drive retention.
- FEM CPU: crates/fullmag-runner/src/native_fem/stage_coupled.rs, stage_oersted.rs, stage_transport.rs.
- FEM native interactions: backends/fem/cpu/mfem/interactions/zeeman_regional_field.cpp, .hpp, zeeman_time_dependence.cpp, .hpp.
- FEM GPU: backends/fem/gpu/cuda/interactions/zeeman/regional_field_kernels.cu, .hpp.
- Lane tests: crates/fullmag-runner/tests/fdm_time_series_binding.rs, crates/fullmag-runner/tests/fem_time_series_binding.rs.

**Interfaces — Consumes / Produces**

- Consumes: backend-specific accepted state and physical time.
- Produces: wspólny MagnetizationSample; native lane retains own field/operator implementation.

- [ ] Dodać observer binding za granicą runner/backend, bez równania LLG w fullmag-analysis.
- [ ] FDM CPU ma służyć jako double reference i zapisywać cell-centred coordinates oraz active mask.
- [ ] FDM GPU ma implementować ten sam observer contract, ale nie kopiować CPU hot loop; forced CUDA unsupported pozostaje błędem.
- [ ] FEM CPU ma użyć typed DOF/P1 extraction; provenance określa FE space, element topology i interpolation.
- [ ] FEM GPU ma mieć osobny adapter i managed runtime; nie współdzielić mutable solver state z CPU.
- [ ] Zachować regional drive source IDs, activation window, envelope i H/B units.
- [ ] Test parity fixture obejmie relax → sinc/chirp drive → transient samples dla każdej lane dostępnej w planie.
- [ ] Test negatywny wymusi unsupported FDM CUDA regional drive i sprawdzi brak uruchomionego CPU runu.
- [ ] Dla FEM uruchomić just verify-fem-time-domain-native-contract.
- [ ] Oczekiwany wynik: managed native contract przechodzi, a output manifest zawiera lane/device identity.
- [ ] Dla FDM uruchomić just verify-fdm-time-domain-native-contract.
- [ ] Oczekiwany wynik: reference observer i failure contracts przechodzą bez silent fallback.

---

## Zadanie 13: Handoff kontraktu artifact index do API/UI

**Pliki i własność**

- Read-only boundary: crates/fullmag-api/src/artifacts.rs — istniejący collect/artifact kind/schema validation; implementację rozszerza plan API/UI.
- Read-only owner deliverable: crates/fullmag-api/src/router_v2/handlers/analysis/time_domain_spectral_analysis.rs — kanoniczny handler resource-first tworzony w planie API/UI.
- Read-only focused tests owned by API/UI: crates/fullmag-api/src/router_v2/tests.rs.
- Contract source: docs/specs/resource-first-control-room-api-v2.md; ten plan nie tworzy alternatywnego `src/analysis.rs` ani drugiego endpointu.

**Interfaces — Consumes / Produces**

- Consumes: FMS/run artifact index, analysis manifest, authoritative `artifact_status`, source/runtime provenance; legacy `complete` jest jedynie wejściem migratora.
- Produces: resource-first JSON metadata and safe artifact download/reference; ciężkie tablice pozostają w binary Zarr/HDF5.

- [ ] Rozszerzyć collect_artifacts o canonical analysis directories i schema allowlist.
- [ ] Odrzucić absolute paths, .., symlink escape, manifest mismatch i unknown artifact kind.
- [ ] Udostępnić analysis_id, artifact_kind, source_quantity, axes, units, source execution, analysis engine, analysis execution, execution/artifact/validation status i payload_hash.
- [ ] Przygotować descriptor contract dla handlera API: endpoint nie może materializować pełnego array w JSON; zwraca ref, dimensions i bounded preview policy.
- [ ] Przekazać revision-aware resource identity, stabilny artifact URL/ref, `analysis_id`, `source_stage_id` i authoritative `artifact_status` do planu API/UI.
- [ ] Właściciel API/UI dodaje test kompletności, niekompletności, path traversal, hash mismatch i bounded metadata response w istniejącym `router_v2/tests.rs`.
- [ ] Właściciel API/UI uruchamia `cargo test -p fullmag-api time_domain_spectral -- --nocapture`; ten plan nie odwołuje się do nieistniejącego osobnego integration target.
- [ ] Oczekiwany wynik handoffu: metadata schema jest stabilne, payload pozostaje binary, a brak kompletności jest widoczny dla klienta.
- [ ] Nie implementować komponentów Control Room ani nowych viewportów w tym planie.

---

## Zadanie 14: kwalifikacja, just recipes i scientific receipts

**Pliki**

- justfile — jawne recipe names i dependency order.
- scripts/verify_time_domain_spectral_analysis.py.
- scripts/verify_time_domain_backend_parity.py.
- scripts/verify_mmpp_worker_contract.py.
- scripts/validate_time_domain_artifacts.py.
- docs/physics/0997-time-domain-spectral-analysis.md — acceptance mapping.
- docs/specs/ — capability and artifact receipts.

**Interfaces — Consumes / Produces**

- Consumes: canonical DSL fixtures, managed FDM/FEM runtimes, Zarr/HDF5/FMS outputs.
- Produces: receipts with source identity, recipe, backend/device, precision, mesh fingerprint, sample count, hashes and pass/fail per gate.

- [ ] Dodać recipe verify-time-domain-spectral-analysis-contract dla IR/planner/analysis/storage tests.
- [ ] Dodać recipe verify-time-domain-backend-parity z osobnymi targetami FDM CPU, FDM GPU, FEM CPU i FEM GPU.
- [ ] Dodać recipe verify-mmpp-worker-contract.
- [ ] Każdy recipe zapisuje receipt poza checkoutem i nie zmienia lokalnych źródeł.
- [ ] Analytic gate: sinusoidy i chirp odzyskują częstotliwość w granicy bin/resampling error.
- [ ] Sampling gate: adaptive RK resampling raportuje max/RMS error i odrzuca przekroczenie limitu.
- [ ] Storage gate: Zarr/HDF5 comparator potwierdza logical equivalence i identyczny authoritative `artifact_status`; derived legacy `complete` musi odpowiadać `artifact_status == ready`.
- [ ] Physics gate: source/response axes, units, phase convention i equilibrium subtraction są zgodne.
- [ ] Backend gate: FDM CPU reference jest porównany z FEM CPU tylko dla wspólnego benchmarku; GPU parity jest osobnym wynikiem.
- [ ] Runtime gate: FEM CPU/GPU używa managed recipes verify-fem-llg-time-domain-qualification, verify-fem-llg-time-domain-qualification-gpu i production variant.
- [ ] Existing drive gates zachować: verify-fem-regional-field-drive-contract, verify-fem-regional-field-drive-rk-time-convergence, verify-fem-regional-field-drive-cpu-gpu-parity-runtime.
- [ ] Existing modal gates zachować: verify-fem-periodic-antidot-gamma-pulse-runtime, verify-fem-antidot-waveguide-finite-k-runtime.
- [ ] Uruchomić just verify-time-domain-spectral-analysis-contract.
- [ ] Oczekiwany wynik: wszystkie warstwy neutralne przechodzą i receipt zawiera exact schema versions.
- [ ] Uruchomić just verify-time-domain-backend-parity.
- [ ] Oczekiwany wynik: lane results są osobne; brak urządzenia lub capability jest jawnie not qualified, a nie sukcesem fallbacku.
- [ ] Uruchomić just verify-mmpp-worker-contract.
- [ ] Oczekiwany wynik: worker protocol tests i typed failure tests przechodzą.

---

## Zadanie 15: dokumentacja migracji, review i końcowa weryfikacja

**Pliki**

- docs/physics/0997-time-domain-spectral-analysis.md.
- docs/specs/ — final IR/planner/artifact/MMPP contracts.
- docs/superpowers/plans/2026-08-31-time-domain-spectral-analysis-contracts-and-storage.md — ten plan.
- Wszystkie pliki implementacyjne wskazane w zadaniach 1–14.

**Interfaces — Consumes / Produces**

- Consumes: test receipts, source maps, generated schema snapshots, FMS samples and parity reports.
- Produces: wdrożeniowo zamknięty kontrakt, migration matrix, qualification matrix and reviewer-ready evidence.

- [ ] Uzupełnić migration matrix: fft_from_trace → fullmag-analysis::fft, spin_wave_response.gamma.v1 → `fullmag.analysis.response_fields.v1`/`fullmag.analysis.spectra.v1`, dynamic_structure_factor.1d.v1 → `fullmag.analysis.dynamic_structure_factor.v1`.
- [ ] Opisać, które legacy outputs są read-only, a które wymagają rerun z nowym observerem.
- [ ] Uzupełnić source map path+symbol dla każdego publicznego pola, writer, planner decision i receipt.
- [ ] Dodać dokumentacyjną tabelę FDM/FEM oraz CPU/GPU z kolumnami input, observer, spatial semantics, qualification command i known limit.
- [ ] Sprawdzić, że MMPP worker contract jest wersjonowany niezależnie od algorithm implementation version.
- [ ] Sprawdzić, że FMS ConfigOnly nie obiecuje danych, których policy nie spakowała.
- [ ] Wykonać review planu pod kątem braku ukrytych fallbacków, niejawnych jednostek, pomieszania lane i nieograniczonej pamięci.
- [ ] Ustawić zewnętrzny target Cargo na Windows i uruchomić testy neutralnych crate’ów:

~~~powershell
$spectralCargoTarget = Join-Path ([System.IO.Path]::GetTempPath()) "fullmag-tdsa-cargo-20260831"
$env:CARGO_TARGET_DIR = $spectralCargoTarget
cargo test -p fullmag-ir
cargo test -p fullmag-plan
cargo test -p fullmag-analysis
cargo test -p fullmag-runner --test time_series_sink --test analysis_zarr_v2 --test analysis_hdf5_equivalence
cargo test -p fullmag-session --test fms_analysis_roundtrip
cargo test -p fullmag-mmpp-adapter
~~~

- [ ] Oczekiwany wynik: każdy command kończy się kodem 0; Cargo nie tworzy target w checkoutcie.
- [ ] Uruchomić dokumentację i artefact validators:

~~~powershell
python -m pytest scripts/test_time_domain_spectral_analysis_contract_docs.py -q
python scripts/check_physics_docs_gate.py --base HEAD --head WORKTREE
python scripts/validate_time_domain_artifacts.py --format zarr --path crates/fullmag-runner/tests/fixtures/time_domain_spectral/analytic_sine/time_series.zarr
python scripts/validate_time_domain_artifacts.py --format hdf5 --path crates/fullmag-runner/tests/fixtures/time_domain_spectral/analytic_sine/time_domain_spectral.h5
python scripts/compare_time_domain_artifacts.py --zarr crates/fullmag-runner/tests/fixtures/time_domain_spectral/analytic_sine/time_series.zarr --hdf5 crates/fullmag-runner/tests/fixtures/time_domain_spectral/analytic_sine/time_domain_spectral.h5
~~~

- [ ] Oczekiwany wynik: każdy validator zwraca kod 0; comparator raportuje logical equivalence passed.
- [ ] Sprawdzić git status --short, git diff --check, git diff --stat i potwierdzić, że w zmianach znajduje się wyłącznie nowy plan przed rozpoczęciem implementacji.
- [ ] Nie wykonywać git commit, git push, git reset, git checkout ani usuwania istniejących artefaktów.

---

## Rekomendowane granice komponentów

fullmag-ir jest właścicielem semantycznych typów i serializacji. Nie powinien znać ścieżek Zarr, HDF5 ani procesu MMPP.

fullmag-plan jest właścicielem decyzji, czy dany stage, clock, mesh, backend i device mogą dostarczyć żądane próbki. Nie powinien wykonywać FFT ani otwierać writerów.

fullmag-runner jest właścicielem lifecycle: equilibrium reference, stage observer, accepted-step/physical-time mapping, continuous index i finalizacji. Nie powinien implementować osobnych równań dla FDM i FEM.

fullmag-analysis jest właścicielem transformacji i statystyki sygnału. Nie powinien wybierać backendu, zmieniać drive ani zakładać FEM tet4 poza typem spatial operatora.

backends/fdm i backends/fem są właścicielami obliczenia stanu oraz natywnego field/operator realization. Observer binding ma być cienkim adapterem.

fullmag-session jest właścicielem trwałego pakowania i restore classification. FMS nie może zmieniać wartości numerycznych artefaktu.

fullmag-api jest właścicielem bezpiecznego indeksu i manifest metadata. Binary payload pozostaje w storage.

fullmag-mmpp-adapter jest właścicielem procesu, protokołu, timeoutu, hash check i typed error mapping. Worker Python wykonuje wyłącznie jawnie podaną operację.

---

## Braki kontraktów, które muszą zostać zamknięte

- [ ] Brak publicznego typu chirp w packages/fullmag-py/src/fullmag/model/energy.py.
- [ ] Brak typu analizy przestrzennego szeregu w packages/fullmag-py/src/fullmag/analysis/spectrum.py i model/study.py.
- [ ] Brak IR dla analysis_id, outputs, spatial sampling, window, detrend i physical clock.
- [ ] Brak planner resource estimate dla samples × components × spatial.
- [ ] Brak typed resampling error i zakazu FFT na accepted-step data.
- [ ] Brak wspólnego TimeSeriesSink dla FDM i FEM.
- [ ] Obecny Zarr autosave opisuje stage table/fields, lecz nie canonical analysis hierarchy.
- [ ] Obecny HDF5 autosave nie gwarantuje jeszcze logical equivalence z nowym Zarr analysis schema.
- [ ] Legacy gamma i finite-k DSF mają różne schemas oraz spatial restrictions.
- [ ] FmsRunManifest nie ma analysis refs ani policy.
- [ ] collect_artifacts nie ma pełnej allowlisty canonical analysis kinds.
- [ ] Brak MMPP executable discovery, JSONL schema, timeout i no-fallback policy.
- [ ] Brak wspólnej qualification matrix dla czterech backend/device lanes.
- [ ] Brak publicznego API metadanych axes/units/source hash dla analysis artifacts.

---

## Bramki kwalifikacyjne i kryterium zatrzymania

Wdrożenie można uznać za kwalifikowane dopiero po spełnieniu wszystkich poniższych warunków:

- [ ] Physics note przechodzi publication validator i zawiera source map dla DSL, IR, planner, runner, storage, FMS i MMPP.
- [ ] DSL round-trip zachowuje stage IDs, drive IDs, chirp parameters, sampling clock, cadence, outputs, window i detrend.
- [ ] Planner odrzuca niejednostajny FFT input, przekroczoną pamięć, nielegalny mesh/operator i forced unavailable device.
- [ ] FDM CPU reference ma deterministyczny time series dla canonical fixture.
- [ ] FDM GPU ma osobną qualification receipt albo jawny unsupported capability; nigdy nie raportuje CPU result jako GPU.
- [ ] FEM CPU przechodzi managed native time-domain contract i daje typed spatial provenance.
- [ ] FEM GPU przechodzi managed GPU recipe z source/runtime identity, device i precision.
- [ ] Analityczne sinusoidy, dwa tony, impuls i chirp przechodzą FFT/peak/resampling gates.
- [ ] response_fields zachowuje komponent, częstotliwość, położenie i complex phase.
- [ ] DSF zachowuje k-axis, f-axis, spatial operator i normalization.
- [ ] Zarr v2 oraz HDF5 mają zgodne logical arrays, manifesty, units, axes, hashes i `artifact_status` semantics; pochodne `complete` jest identyczne po obu stronach.
- [ ] FMS pack/inspect/unpack zachowuje analysis refs, hashes i restore class.
- [ ] MMPP success, unavailable, malformed, timeout i source hash mismatch mają stabilne typed outcomes.
- [ ] API zwraca ograniczone metadata i bezpieczne refs, bez bezpośredniej serializacji nieograniczonych tablic.
- [ ] Receipt każdego runtime zawiera source identity, canonical recipe, mesh fingerprint, backend, device, precision, sample count i artifact hashes.
- [ ] git diff --check jest czysty, a zakres zmian jest zgodny z zatwierdzonym zadaniem.

Jeśli którakolwiek bramka nie przechodzi, wynik pozostaje not qualified z dokładnym kodem błędu i dowodem; nie wolno zastępować brakującego dowodu domyślnym backendem, skróconym szeregiem ani deklaracją zgodności bez receipt.
