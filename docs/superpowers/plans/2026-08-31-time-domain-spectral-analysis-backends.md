# Time-Domain Spectral Analysis Backends Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zbudować wspólny, wersjonowany i strumieniowy kontrakt analizy sygnałów czasowych oraz widm dla czterech jawnych linii FDM CPU, FDM GPU, FEM CPU i FEM GPU, z migracją analizy Gamma i finite-k, dokładnym zegarem fizycznym, regionalnym napędem oraz zależnościami AntennaFieldSolve/SolvedAntennaDrive.

**Architecture:** Solver pozostaje właścicielem fizyki i zapisuje niezmienny artefakt szeregu czasowego na kanonicznych chwilach fizycznych. Natywny SpectralEngine wykonuje blokową transformację, estymację odpowiedzi i artefaktów bez pełnej materializacji w RAM; backendy dostarczają ten sam neutralny interfejs próbkowania, ale osobne realizacje CPU/GPU. Capability, provenance i status artefaktu ujawniają wybraną linię wykonania oraz odrzucają nieobsługiwane żądania zamiast zmieniać je na inną linię.

**Tech Stack:** Rust w crates/fullmag-ir, crates/fullmag-plan i crates/fullmag-runner; RustFFT/RealFFT 6.4/3.5 dla baseline CPU; C++/MFEM/hypre/libCEED/CUDA w backends/fem; C++/CUDA w backends/fdm; Zarr i HDF5 jako formaty artefaktów; serde, SHA-256, UUID, rayon tylko dla jawnie kwalifikowanych równoległych odcinków; Python DSL i pytest do kontraktów wejściowych.

## Global Constraints

- Plan dotyczy wyłącznie nowej implementacji time_domain_spectral_analysis; istniejące produkty modal_eigen i driven_response pozostają odrębne. Symbole implementacyjne `DrivenFrequencyResponse*` nie zmieniają kanonicznej nazwy produktu.
- Żaden backend nie może użyć nazwy obiektu, typu sceny ani układu pliku do domyślnego wyboru fizyki.
- Obowiązuje dokładnie jedna semantyka δm, osi czasu, fazy, okna, detrendu, normalizacji i maskowania źródła dla wszystkich czterech linii.
- Częstotliwość i chwila próbki są wielkościami SI: czas w sekundach, częstotliwość w Hz, pole `H` w A/m, pole `B` w T, magnetyzacja `M` w A/m, a znormalizowane `m=M/M_s` jest bezwymiarowe.
- Oś wyjściowa musi być regularna i zawierać requested_time_s, actual_time_s oraz time_error_s; accepted_step_trace nie jest automatycznie exact_physical_time_series.
- Dla fixed-step próbka musi zostać osiągnięta dokładnie przez lądowanie zdarzenia albo żądanie kończy się błędem; tolerowany błąd jest jawny i wersjonowany.
- Adaptive solver może użyć wyłącznie kwalifikowanego dense output albo jawnego, reprodukowalnego artefaktu resamplingu; ciche interpolowanie liniowe jest zabronione.
- Pojedynczy przebieg zapisuje immutable input time series; ponowna analiza widmowa nie uruchamia solve i nie mutuje źródła.
- Zapis jest bounded: próbki i widma są dopisywane w chunkach o rozmiarze kilku MiB, z limitem pamięci i atomowym stanem ready.
- SpectralEngine nie alokuje tablicy całego przebiegu; każda faza posiada limit workspace oraz licznik bloków i transferów.
- Unknown window, niewłaściwa długość osi, niezgodna faza, niepełny chunk i brak metadanych kończą się błędem walidacji, bez domyślnego Hann/DC/zero.
- Susceptibility wymaga jawnego threshold źródła; słabe punkty są maskowane valid_source_mask, a nie zastępowane zerem.
- FDM CPU, FDM GPU, FEM CPU i FEM GPU mają osobne capability IDs, wykonanie i receipt; forced GPU kończy się unsupported, gdy GPU nie jest dostępne.
- Source execution lane, analysis engine i analysis execution lane są trzema różnymi osiami. `auto|native|mmpp` rozwiązuje się przed analizą; po rozwiązaniu nie ma fallbacku ani niejawnego podziału produktów.
- Nie wolno wprowadzić ukrytego CPU fallbacku, ukrytego host-device copy ani konwersji mixed FEM topology z pominięciem certyfikatu.
- Prawda o ciężkim payloadzie leży w Zarr/HDF5 data plane; control plane przekazuje tylko descriptor, revisions, status, provenance i manifest.
- HTTP v2 jest źródłem zasobów, a WebSocket służy wyłącznie invalidation/event; komponenty UI nie dodają bezpośrednich fetchy.
- AntennaFieldSolve i SolvedAntennaDrive są zależnościami jawnie typowanymi; regionalny drive nie może po cichu zastąpić rozwiązanej anteny ani odwrotnie.
- Mixed FEM zachowuje typed prism6, pyramid5 i tet4; operator P1 musi zgłosić brak obsługi typu, nie przekształcać go milcząco.
- Wszystkie twierdzenia produkcyjne FEM są weryfikowane przez zarządzane/container-backed recipes justfile; hostowy cargo/cmake może być tylko diagnostyką.
- Przed implementacją noty fizyczne i ADR-y są aktualizowane przez wymagane reguły projektu; w tym zadaniu zmieniany jest wyłącznie ten plik planu.
- Nie wykonywać commitów w ramach tego zadania; każdy etap kończy się zielonym checkpointem testowym i przeglądem diffu.

---

## Mapa plików i właścicieli

| Obszar | Istniejący punkt wejścia | Planowany właściciel | Zakres |
|---|---|---|---|
| Python DSL | packages/fullmag-py/src/fullmag/model/study.py::GammaResponseAnalysis | packages/fullmag-py/src/fullmag/model/study.py::TimeDomainSpectralAnalysis | Zachować round-trip i odseparować starą nazwę akcji |
| DSL builder | packages/fullmag-py/src/fullmag/world.py::StudyStagesBuilder.fft_response | packages/fullmag-py/src/fullmag/world.py::StudyStagesBuilder.time_domain_spectral_analysis | Lowering do IR, bez eager auto-sampling |
| IR | crates/fullmag-ir/src/study.rs::RegionalFieldDriveIR, SamplingIR | crates/fullmag-ir/src/time_domain_spectral.rs | Typy request/reference/transform/products/capability |
| IR export | crates/fullmag-ir/src/lib.rs | crates/fullmag-ir/src/lib.rs | Reeksport wersjonowanych typów |
| Planner | crates/fullmag-plan/src/sampling.rs::resolve_auto_sampling_for_stage | crates/fullmag-plan/src/spectral_analysis.rs | Zegar fizyczny, zależności, capability i normalizacja |
| Event schedule | crates/fullmag-runner/src/time_events.rs::build_resolved_stage_event_schedule | crates/fullmag-runner/src/time_events.rs | Lądowanie exact-time oraz cap_timestep_to_next_event |
| Recorder | crates/fullmag-runner/src/autosave_storage.rs::AutosaveTargetWriter | crates/fullmag-runner/src/time_series_recorder.rs | Bounded append, quality flags i descriptor |
| Zarr | crates/fullmag-runner/src/autosave_zarr.rs | crates/fullmag-runner/src/time_series_recorder.rs oraz autosave_zarr.rs | time_series.zarr, spectra.zarr, response_fields.zarr |
| HDF5 | crates/fullmag-runner/src/autosave_hdf5.rs | crates/fullmag-runner/src/time_series_recorder.rs oraz autosave_hdf5.rs | Lustrzany zapis i odczyt |
| Pipeline | crates/fullmag-runner/src/artifact_pipeline.rs | crates/fullmag-runner/src/artifact_pipeline.rs | Atomowe manifesty, statusy i provenance |
| Engine | crates/fullmag-runner/src/spin_wave_response.rs::build_gamma_response | crates/fullmag-analysis/src/engine.rs | Backend-neutral native FFT, bloki, PSD, response, peaks; runner tylko orkiestruje |
| Gamma | crates/fullmag-runner/src/spin_wave_response.rs::SpinWaveResponseArtifact | crates/fullmag-runner/src/spin_wave_response.rs | Adapter do shared engine |
| finite-k | crates/fullmag-runner/src/spin_wave_sampling.rs::dynamic_structure_factor_1d | crates/fullmag-runner/src/spin_wave_sampling.rs | Adapter P1, typed topology, 1D S(k,f) |
| Regional FDM | crates/fullmag-plan/src/regional_field_drive.rs::resolve_fdm_regional_field_drives | backends/fdm oraz crates/fullmag-runner/src/fdm | CPU reference i jawny GPU hook |
| Regional FEM CPU | backends/fem/cpu/mfem/interactions/zeeman_regional_field.cpp | backends/fem/cpu/mfem/interactions/zeeman_* | P1/adaptive projection i time recorder |
| Regional FEM GPU | backends/fem/gpu/cuda/interactions/zeeman/regional_field_kernels.cu | backends/fem/gpu/cuda/interactions/zeeman | Device residency bez readback fallback |
| Antenna | crates/fullmag-runner/src/antenna_fields.rs | crates/fullmag-plan/src/antenna_field_basis.rs | AntennaFieldSolve/SolvedAntennaDrive graph |
| Capability | crates/fullmag-runner/src/capabilities.rs | crates/fullmag-plan/src/spectral_capabilities.rs | Per-lane capability i no-fallback resolution |
| Existing frequency domain | backends/fem/include/frequency_domain/frequency_domain_contract.hpp | Bez zmiany semantyki | Granica z modal_eigen/driven_response |
| Existing FFT | crates/fullmag-engine/src/fdm/cpu/fft.rs::FftWorkspace | Nowy engine korzystający z osobnego workspace | Nie mieszać demag FFT z response FFT |
| API boundary | crates/fullmag-api/src/router_v2/handlers/analysis/time_domain_spectral_analysis.rs | Handler resource-first należący do planu API/UI | Plan dostarcza descriptor/data-plane contract; legacy `spin_wave_response.rs` pozostaje read-only adapterem |
| UI boundary | apps/control-room/src/kernel/resources/studyRuntimeResources.ts | Późniejszy resource hook | Brak bezpośredniego fetch w tej implementacji |

## Kanoniczny kontrakt danych

Produkt ma identyfikator time_domain_spectral_analysis i własny schema_version. Nie zapisuje wyniku pod spectrum.v2 ani spectrum.v3 bez jawnego adaptera kompatybilności. Artefakt wejściowy i wyjściowy posiadają source_digest, run_id, analysis_id, source_stage_id, lane, dtype, endian, units, phase_convention oraz trzy rozłączne osie statusu.

TimeSeriesRecorder emituje logiczny descriptor:

    schema_version = "fullmag.analysis.time_series.v1"
    clock_kind = "exact_physical_time_series"
    time_s zawiera N+1 wartości od t_0 do t_N
    requested_time_s, actual_time_s i time_error_s mają długość N+1
    magnetization ma kształt [time, carrier, xyz]
    drive_field ma kształt [time, carrier, xyz]
    sample_step_index ma typ całkowity
    sample_quality_flags ma typ bitset

SpectralEngine emituje:

    schema_version = "fullmag.analysis.spectra.v1"
    frequency_hz ma kształt [frequency]
    response_complex ma kształt [frequency, observable, real_imag]
    source_complex ma kształt [frequency, observable, real_imag]
    susceptibility_complex ma kształt [frequency, observable, real_imag]
    power ma kształt [frequency, observable]
    valid_source_mask ma kształt [frequency, observable]
    phase_convention = "exp_minus_i_2pi_f_t"
    window, detrend, coherent_gain, enbw_hz, normalization, one_sided

Response field peak artifacts use:

    response_fields.zarr/peak_XXXX/vector_xyz_complex[carrier, 3, 2]

Zarr i HDF5 muszą odwzorowywać się 1:1:

    Zarr: analysis/time_domain_spectral/{analysis_id}/time_series.zarr/time_s
    HDF5: /analysis/time_domain_spectral/{analysis_id}/time_series/time_s
    Zarr: analysis/time_domain_spectral/{analysis_id}/spectra.zarr/response_complex
    HDF5: /analysis/time_domain_spectral/{analysis_id}/spectra/response_complex
    Zarr: analysis/time_domain_spectral/{analysis_id}/response_fields.zarr/peak_XXXX/vector_xyz_complex
    HDF5: /analysis/time_domain_spectral/{analysis_id}/response_fields/peak_XXXX/vector_xyz_complex

Oś czasu jest monotoniczna, regularna w granicy time_error_s, a nfft i df są zapisane. Dla f_s=1/dt, f_Nyquist=f_s/2 i df=1/(N*dt); automatyczne próbkowanie honoruje t_sampling=1/(2*1.3*f_cutoff_max) oraz odrzuca brakujący cutoff.

## Macierz linii wykonania

| Lane | Solver fizyczny | Recorder | SpectralEngine | Dozwolone transfery | Brak capability |
|---|---|---|---|---|---|
| fdm_cpu | CPU FDM reference double | host bounded chunks | RustFFT/RealFFT | host input/output | failed lub unsupported |
| fdm_gpu | CUDA FDM | device chunks, jawny staging | native GPU transform albo qualified host handoff | tylko zadeklarowany staging | unsupported, nigdy CPU fallback |
| fem_cpu | MFEM/hypre CPU | MFEM vector/probe do bounded chunks | native CPU baseline | host readback po chunku | failed lub unsupported |
| fem_gpu | MFEM/libCEED/CUDA | device-resident state/probe | GPU engine albo jawny qualified staging | receipt każdego transferu | unsupported, nigdy CPU fallback |

Każdy lane receipt zapisuje requested_lane, resolved_lane, runtime_id, precision, device, transfer_bytes, transfer_count, fallback_count oraz capability_digest. fallback_count dla tego produktu musi wynosić zero; obecność fallbacku kończy kwalifikację.

## Zadania wdrożeniowe

Zadania 1–6 zawierają prerequisite checkpoints dla kontraktów należących do planu contracts/storage. Backend workstream nie tworzy alternatywnych physics notes, ADR, IR, Python DSL, planner schema, recorder schema ani `fullmag-analysis`. Gdy prerequisite jest nieobecny lub czerwony, wykonawca zatrzymuje ten plan i wraca do wskazanego zadania właścicielskiego; nie naprawia go w konkurencyjnym module. Backend workstream zaczyna własne zmiany wyłącznie w jawnie oznaczonych runner bindings i backendach.

### Zadanie 1: Zweryfikować zamrożoną fizykę i granicę z istniejącym frequency-domain

**Files:**

- Read-only prerequisite owned by the contracts/storage workstream: docs/physics/0997-time-domain-spectral-analysis.md
- Read-only prerequisite owned by the contracts/storage workstream: docs/physics/0997-time-domain-spectral-analysis.source-map.json
- Read-only prerequisite owned by the contracts/storage workstream: docs/adr/0029-time-domain-spectral-analysis-artifact-and-engine.md
- Read-only boundary: backends/fem/include/frequency_domain/frequency_domain_contract.hpp::FrequencyDomainStatus
- Read-only boundary: backends/fem/include/frequency_domain/modal_eigen_request.hpp::kFrequencyDomainAbiVersion
- Read-only boundary: backends/fem/src/frequency_domain/driven_response_solver.cpp::DrivenFrequencyResponseExecutionLane

**Interfaces — Consumes:**

- Canonical equations and units from docs/physics/0920-regional-time-domain-field-drive.md.
- Antenna field basis rules from docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md.
- Existing modal_eigen and driven_response ABI/versioning; `DrivenFrequencyResponseExecutionLane` remains an implementation symbol.

**Interfaces — Produces:**

- Publication-style statement of δm, transform phase, source threshold, window/detrend, S(k,f), limits and four-lane interpretations.
- ADR stating that time series is immutable input, FFT is repeatable analysis, and existing spectrum.v2/v3 or mode_fields.zarr are not silently reinterpreted.
- Source-index mapping from each equation to exact Rust/C++ symbols used by later tasks.

**TDD / implementation:**

- [ ] Verify that the contracts/storage workstream has created and passed the publication gate for physics note 0997 and ADR 0029 before touching backend code; do not create competing note, ADR or source map files in this workstream.
- [ ] Review the frozen decisions for exact physical time, bounded chunks, atomic ready state, explicit source masks, no fallback, one analysis producer and separate AntennaFieldSolve/SolvedAntennaDrive.
- [ ] Record the compatibility rule: old spectrum.v2/v3 and mode_fields.zarr are read-only legacy inputs until an adapter verifies phase, axis, source and provenance.
- [ ] Run python -m pytest packages/fullmag-py/tests/test_regional_field_drive.py packages/fullmag-py/tests/test_gaussian_plane_wave_antenna.py; expected RED before the feature because no TimeDomainSpectralAnalysis IR exists.
- [ ] Run cargo test -p fullmag-ir; expected RED with a missing module/export assertion for the new contract.
- [ ] Re-run both commands after the contract files are implemented; GREEN requires the note/ADR validator and serialized IR fixtures to pass.

### Zadanie 2: Bramka wersjonowanego IR i planner request

**Files:**

- Read-only prerequisite owned by contracts/storage: crates/fullmag-ir/src/time_domain_spectral.rs
- Read-only prerequisite owned by contracts/storage: crates/fullmag-ir/src/lib.rs and crates/fullmag-ir/src/study.rs integration
- Read-only prerequisite owned by contracts/storage: crates/fullmag-plan/src/spectral_analysis.rs and crates/fullmag-plan/src/lib.rs
- Read-only acceptance tests: crates/fullmag-ir/tests/time_domain_spectral_contract.rs
- Read-only acceptance tests: crates/fullmag-plan/tests/time_domain_spectral_planner.rs

**Interfaces — Consumes:**

- RegionalFieldDriveIR::{target, amplitude_b_t, direction, spatial_profile, waveform, time_origin, activation}.
- SamplingIR and SamplingResolutionIR from crates/fullmag-plan/src/sampling.rs.
- Existing stage/run IDs and backend/capability vocabulary.

**Interfaces — Produces:**

- TimeDomainSpectralAnalysisIR with source stage/artifact, response/source quantities, source drive IDs, spatial selection, reference, temporal transform, products, peak rules and requested_analysis_engine.
- SpectralAnalysisEngineRequestIR with Auto, Native and Mmpp; separate SpectralComputePolicyIR with requested processing device, exact_time_policy, memory_budget_bytes and transfer_policy.
- ResolvedSpectralAnalysis with source digest, requested/resolved analysis engine, engine resolution reason, capability snapshot, resolved compute lane, dt, nfft, frequency axis, source mask threshold and provenance.

**TDD / implementation:**

- [ ] Potwierdź w completion ledger, że contracts/storage Tasks 2–4 dostarczyły IR/planner fixtures dla missing source, unknown window, nonpositive dt, irregular time, absent cutoff, engine resolution i forced GPU.
- [ ] Uruchom cargo test -p fullmag-ir --test time_domain_spectral_contract oraz cargo test -p fullmag-plan --test time_domain_spectral_planner.
- [ ] Expected: oba testy GREEN, deterministic JSON i komplet rejection cases. Wynik RED blokuje backend plan i wraca do ownera contracts/storage; nie twórz drugiego typu ani planner path.
- [ ] Przejrzyj snapshot pod kątem source_digest, requested/resolved analysis engine, source execution i compute lane jako oddzielnych pól.

### Zadanie 3: Bramka Python DSL i stage graph migration boundary

**Files:**

- Read-only prerequisite owned by contracts/storage: packages/fullmag-py/src/fullmag/model/study.py::GammaResponseAnalysis
- Read-only prerequisite owned by contracts/storage: packages/fullmag-py/src/fullmag/world.py::StudyStagesBuilder.fft_response
- Read-only prerequisite owned by contracts/storage: packages/fullmag-py/src/fullmag/model/time_domain_spectral.py::TimeDomainSpectralAnalysis
- Read-only acceptance tests: packages/fullmag-py/tests/test_time_domain_spectral_analysis.py
- Read-only acceptance tests: packages/fullmag-py/tests/test_study_export_roundtrip.py

**Interfaces — Consumes:**

- Existing GammaResponseAnalysis constructor and to_ir path at packages/fullmag-py/src/fullmag/model/study.py.
- Existing fft_response action at packages/fullmag-py/src/fullmag/world.py.
- New TimeDomainSpectralAnalysisIR and auto sampling policy from Zadanie 2.

**Interfaces — Produces:**

- Canonical Python authoring for reference selection, spatial operator, window, detrend, nfft, products, source threshold and lane.
- Stage graph EquilibriumStage -> optional AntennaFieldSolveStage -> TimeEvolutionStage -> TimeSeriesArtifact -> TimeDomainSpectralAnalysisStage.
- Explicit migration adapter from legacy GammaResponseAnalysis, preserving old serialized input while producing the new typed product.

**TDD / implementation:**

- [ ] Potwierdź completion ledger dla contracts/storage Task 3 i obecność typed source artifact w nowym stage graph.
- [ ] Uruchom python -m pytest packages/fullmag-py/tests/test_time_domain_spectral_analysis.py packages/fullmag-py/tests/test_study_export_roundtrip.py -q.
- [ ] Expected: GREEN, round-trip zachowuje window, phase, reference, source threshold, analysis engine i compute policy; brak eager sampling rewrite i source-family substitution.
- [ ] Wynik RED blokuje backend plan i wraca do ownera Python/IR; backend workstream nie zmienia publicznego API.

### Zadanie 4: Bramka TimeSeriesRecorder, reader i bounded artifact writer

**Files:**

- Read-only prerequisite owned by contracts/storage: crates/fullmag-runner/src/time_series_recorder.rs and crates/fullmag-runner/src/lib.rs
- Read-only prerequisite owned by contracts/storage: crates/fullmag-runner/src/autosave_storage.rs, autosave_zarr.rs, autosave_hdf5.rs and artifact_pipeline.rs
- Read-only acceptance tests: crates/fullmag-runner/src/time_series_recorder.rs::tests
- Read-only acceptance tests: crates/fullmag-runner/tests/time_series_artifact_contract.rs

**Interfaces — Consumes:**

- AutosaveTargetWriter::{begin_stage, append_table_row, append_field_sample, finish_stage}.
- StageSampleCoordinate::{PhysicalTime, AcceptedStep}.
- Magnetization/drive vectors supplied by backend-neutral sample callback.
- ResolvedSamplingResolution and source/provenance digest.

**Interfaces — Produces:**

- TimeSeriesRecorder::{begin, append, flush_chunk, finish, abort} with bounded memory and monotonic sample index.
- TimeSeriesReader descriptor that streams time-major chunks and exposes no mutable solver state.
- Zarr group `analysis/time_domain_spectral/{analysis_id}/time_series.zarr` and matching HDF5 datasets under `/analysis/time_domain_spectral/{analysis_id}/time_series`.
- sample_quality_flags distinguishing landed_event, dense_output, derived_resample, accepted_step_trace, invalid and transfer_audited.

**TDD / implementation:**

- [ ] Potwierdź completion ledger dla contracts/storage Tasks 5–7, w tym empty/duplicate/nonfinite/incomplete/recovery/schema mismatch fixtures.
- [ ] Uruchom cargo test -p fullmag-runner time_series_recorder oraz cargo test -p fullmag-runner time_series_artifact_contract.
- [ ] Expected: GREEN, bounded allocation, recovery, hash verification, identyczne Zarr/HDF5 coordinate semantics i legalny crosswalk execution/artifact/validation status.
- [ ] Wynik RED blokuje backend bindings; nie twórz drugiego writera ani formatu lane-specific.

### Zadanie 5: Exact-time sampling planner and event landing

**Files:**

- Read-only prerequisite owned by contracts/storage: crates/fullmag-plan/src/sampling.rs::resolve_auto_sampling_for_stage
- Modify: crates/fullmag-runner/src/time_events.rs::build_resolved_stage_event_schedule
- Modify: crates/fullmag-runner/src/time_events.rs::cap_timestep_to_next_event
- Modify: crates/fullmag-runner/src/autosave_storage.rs::StageSampleCoordinate
- Tests: crates/fullmag-plan/tests/sampling_resolution_contract.rs
- Tests: crates/fullmag-runner/src/time_events.rs::tests

**Interfaces — Consumes:**

- SamplingResolutionIR::{sample_period_s, maximum_cutoff_hz, nyquist_guard_factor, target_stage_id}.
- Waveform events from waveform_event_offsets and resolved_stage_drive_discontinuities.
- Solver accepted-step time and output schedule.

**Interfaces — Produces:**

- Ordered exact sample events q_n = t_start + n*sample_period_s with explicit terminal policy.
- SampleQuality and actual_time_s records for event landing, qualified dense output and derived resampling.
- Failure codes sampling.cutoff_missing, sampling.irregular_axis, sampling.exact_time_unreachable and sampling.tolerance_exceeded.

**TDD / implementation:**

- [ ] Add a failing test for auto: cutoff 5 GHz must resolve to 13 GHz sampling frequency and a deterministic period; absent Sinc cutoff must fail.
- [ ] Add a failing test that a fixed-step integrator lands on every requested output event; a skipped event must return exact_time_unreachable.
- [ ] Run cargo test -p fullmag-plan sampling_resolution_contract; expected RED because existing resolver only resolves autosave output clocks.
- [ ] Extend resolve_auto_sampling_for_stage to produce a spectral clock without changing requested Python/UI values; preserve SAMPLING_RESOLUTION_SCHEMA_VERSION.
- [ ] Extend build_resolved_stage_event_schedule so spectral events and drive discontinuities share one sorted event set; keep cap_timestep_to_next_event as the sole cap.
- [ ] Add adaptive path: dense output must carry a qualified provider ID; otherwise write a derived resample artifact and mark the method explicitly.
- [ ] Run cargo test -p fullmag-plan sampling_resolution_contract and cargo test -p fullmag-runner time_events; GREEN requires exact times, sorted events, no duplicate samples and expected rejection codes.

### Zadanie 6: Podłączyć zamrożony Native SpectralEngine baseline FFT

**Files:**

- Read-only prerequisite owned by contracts/storage: crates/fullmag-analysis/src/engine.rs and crates/fullmag-analysis/src/lib.rs
- Read-only acceptance test: crates/fullmag-analysis/tests/spectral_engine_contract.rs
- Create backend-owned binding: crates/fullmag-runner/src/spectral_analysis_adapter.rs
- Create backend-owned test: crates/fullmag-runner/tests/spectral_analysis_adapter_contract.rs
- Modify: crates/fullmag-runner/src/spin_wave_response.rs::build_gamma_response
- Read-only convention check only: crates/fullmag-engine/src/fdm/cpu/fft.rs::FftWorkspace
- Forbidden dependency: crates/fullmag-engine/src/fdm/cpu/fft_backend.rs::FdmFftBackend remains a demag backend and is not imported by fullmag-analysis

**Interfaces — Consumes:**

- TimeSeriesReader chunks and ResolvedSpectralAnalysis.
- δm reference policy, temporal window, detrend and one-sided transform policy.
- Optional regional weights, P1 spatial operator and drive_field source signal.

**Interfaces — Produces:**

- SpectralEngine::inspect with axis, memory, window and source diagnostics.
- SpectralEngine::execute writing `fullmag.analysis.spectra.v1`, `fullmag.analysis.peaks.v1`, `fullmag.analysis.response_fields.v1` and `fullmag.analysis.dynamic_structure_factor.v1`.
- Complex convention exp_minus_i_2pi_f_t, PSD/amplitude/complex response, coherent gain and ENBW.
- Bounded execution receipt with blocks_processed, bytes_read, bytes_written and peak_workspace_bytes.

**TDD / implementation:**

- [ ] Uruchom cargo test -p fullmag-analysis --test spectral_engine_contract; expected GREEN z sine/window/source-threshold/bounded-memory fixtures. RED blokuje binding i wraca do contracts/storage.
- [ ] Napisz failing runner adapter test dla immutable source descriptor, resolved engine, cancellation, sink identity i braku solver mutation.
- [ ] Uruchom cargo test -p fullmag-runner --test spectral_analysis_adapter_contract; expected RED przed adapterem.
- [ ] Zaimplementuj cienki adapter do publicznego traitu fullmag-analysis; nie duplikuj FFT, peak detection ani DSF w runnerze.
- [ ] Uruchom oba testy; expected GREEN wymaga deterministic artifact hashes, zachowania source identity i zerowej zależności fullmag-analysis od runner/backendów.

### Zadanie 7: Migracja Gamma do immutable time series

**Files:**

- Modify: crates/fullmag-runner/src/spin_wave_response.rs::SpinWaveResponseArtifact
- Modify: crates/fullmag-runner/src/spin_wave_response.rs::build_gamma_response
- Modify: crates/fullmag-runner/src/spin_wave_response.rs::build_gamma_response_with_detrend
- Modify: packages/fullmag-py/src/fullmag/model/study.py::GammaResponseAnalysis
- Modify: packages/fullmag-py/src/fullmag/world.py::StudyStagesBuilder.fft_response
- Tests: crates/fullmag-runner/src/spin_wave_response.rs::tests
- Tests: packages/fullmag-py/tests/test_gamma_response_migration.py

**Interfaces — Consumes:**

- TimeSeriesArtifact descriptor rather than accepted-step vectors.
- Reference artifact or reference policy producing δm with matching carrier and source digest.
- SpectralEngine response and peak outputs.

**Interfaces — Produces:**

- GammaResponseArtifact v1 adapter with legacy-readable fields plus source_ref, axis metadata, phase/window/normalization and validity mask.
- GammaResponseAnalysis migration that invokes the typed stage product and never fabricates a spectrum from runtime metadata.
- Provenance relation from the response to the exact time-series artifact and resolved lane.

**TDD / implementation:**

- [ ] Add a regression test proving accepted solver steps with irregular dt are rejected by the Gamma adapter unless a qualified exact-time artifact exists.
- [ ] Add a paired-control test for δm and a zero-drive test producing zero response within numerical tolerance.
- [ ] Run cargo test -p fullmag-runner spin_wave_response; expected RED because existing build_gamma_response accepts in-memory arrays without a TimeSeriesDescriptor.
- [ ] Implement the adapter using SpectralEngine; retain legacy field names only as a compatibility serialization layer and mark legacy provenance.
- [ ] Add stale-source and mismatched-reference rejection tests using source_digest and run_id.
- [ ] Run cargo test -p fullmag-runner spin_wave_response and python -m pytest packages/fullmag-py/tests/test_gamma_response_migration.py; GREEN requires no synthetic action and exact source linkage.

### Zadanie 8: Migracja finite-k do typed P1 spatial operator

**Files:**

- Modify: crates/fullmag-runner/src/spin_wave_sampling.rs::P1CrossSectionProbeOperator
- Modify: crates/fullmag-runner/src/spin_wave_sampling.rs::sample_p1_vector_field
- Modify: crates/fullmag-runner/src/spin_wave_sampling.rs::dynamic_structure_factor_1d
- Modify: crates/fullmag-runner/src/spin_wave_sampling.rs::requested_finite_k_artifacts
- Create: crates/fullmag-runner/src/spectral_spatial_operator.rs
- Tests: crates/fullmag-runner/src/spin_wave_sampling.rs::tests
- Tests: crates/fullmag-runner/tests/finite_k_time_series_contract.rs

**Interfaces — Consumes:**

- Typed carrier topology and physical coordinates from FEM mesh artifact.
- P1CrossSectionProbeOperator weights, ownership and invalid-plane mask.
- Immutable time-series chunks and SpectralEngine 1D transform.

**Interfaces — Produces:**

- SpectralSpatialSelectionIR and P1ProbeOperator supporting typed tet4, prism6 and pyramid5 where certified.
- DynamicStructureFactorArtifact v1 with k_axis_m_inv, frequency_hz, spatial_operator_digest, phase convention and invalid-probe mask.
- Explicit rejection for unsupported topology, nonpositive dx/dt, irregular grids without a derived resample and missing physical coordinates.

**TDD / implementation:**

- [ ] Preserve tests p1_probe_reproduces_a_linear_vector_field, cross_section_operator_exactly_averages_a_linear_p1_field, cross_section_operator_marks_empty_planes_invalid and coincident_internal_face_has_one_half_open_owner.
- [ ] Add a mixed-topology test with prism6/pyramid5/tet4 and an assertion that no element is silently converted to tet4.
- [ ] Run cargo test -p fullmag-runner spin_wave_sampling; expected RED with the existing mixed-cell support unavailable error for the new mixed fixture.
- [ ] Move temporal FFT work to SpectralEngine and retain P1 probe application as a separate spatial operator; do not reshape FEM values to a regular array.
- [ ] Implement certified topology dispatch and include topology counts plus operator digest in the artifact.
- [ ] Run cargo test -p fullmag-runner spin_wave_sampling and cargo test -p fullmag-runner --test finite_k_time_series_contract; GREEN requires known positive frequency/wavevector and explicit mixed-topology receipt.

### Zadanie 9: RegionalFieldDrive CPU FDM and shared instantaneous-field semantics

**Files:**

- Modify: crates/fullmag-plan/src/regional_field_drive.rs::resolve_fdm_regional_field_drives
- Modify: crates/fullmag-runner/src/regional_field_drive_artifacts.rs
- Modify: crates/fullmag-runner/src/fdm/cpu/reference/fft_backend.rs::CpuFftBackend
- Create: backends/fdm/include/time_series_sampling_v1.hpp
- Create: backends/fdm/api/cpu_time_series_sampling_v1.cpp
- Tests: packages/fullmag-py/tests/test_regional_field_drive.py
- Tests: backends/fdm/tests/time_series_sampling_contract.cpp

**Interfaces — Consumes:**

- ResolvedRegionalFieldDriveBasisIR with exact profile and adaptive cell averages.
- FieldTimeOriginIR, DriveActivationIR, waveform and stage clock.
- FDM CPU magnetization cells and H_drive at each accepted/substage evaluation.

**Interfaces — Produces:**

- FDM CPU sample callback carrying cell-average magnetization, drive field, physical time and revision.
- One instantaneous drive field/revision used by H_eff, energy, recorder and output; no centroid approximation.
- CPU receipt with lane=fdm_cpu, precision=double and fallback_count=0.

**TDD / implementation:**

- [ ] Add a Python test for StageLocal versus Absolute time origin, stage activation and exact pulse edge event.
- [ ] Add C++ tests for sinc/geometry mask cell-average parity and monotonic regional_drive_revision.
- [ ] Run python -m pytest packages/fullmag-py/tests/test_regional_field_drive.py; expected RED for missing time-series binding and exact stage clock.
- [ ] Run the FDM contract test; expected RED because cpu_time_series_sampling_v1.cpp does not yet expose the callback.
- [ ] Implement only the CPU hook and call the common recorder at exact output events; keep FdmFftBackend demag responsibilities unchanged.
- [ ] Run cargo test -p fullmag-plan regional_field_drive and the FDM C++ contract; GREEN requires field/energy/recorder values from the same revision and no fallback.

### Zadanie 10: RegionalFieldDrive CPU FEM with exact RK substage time

**Files:**

- Modify: backends/fem/cpu/mfem/interactions/zeeman.hpp::ZeemanRuntimeState
- Modify: backends/fem/cpu/mfem/interactions/zeeman_regional_field.cpp::copy_regional_field_drive_plan
- Modify: backends/fem/cpu/mfem/interactions/zeeman_time_dependence.cpp::evaluate_time_dependence
- Modify: backends/fem/cpu/mfem/interactions/zeeman_field.cpp
- Modify: backends/fem/cpu/mfem/interactions/zeeman_energy.cpp
- Modify: backends/fem/cpu/mfem/integrators/rk_stage_rhs.cpp
- Tests: backends/fem/tests/zeeman_contract.cpp
- Tests: backends/fem/tests/time_series_sampling_contract.cpp

**Interfaces — Consumes:**

- ZeemanRuntimeState::{regional_drives, h_drive_xyz, stage_start_time_s, last_evaluation_time_s, regional_drive_revision}.
- evaluate_time_dependence validation for constant, sinusoidal, pulse, PWL and sinc.
- MFEM P1 regional projection and exact event schedule.

**Interfaces — Produces:**

- FEM CPU sample callback after qualified exact-time state is available.
- RK substage waveform evaluation at the physical substage time, not at the output time copied backward.
- FEM CPU receipt with MFEM/hypre runtime identity, topology counts, transfer audit and fallback_count=0.

**TDD / implementation:**

- [ ] Extend zeeman_contract.cpp with a pulse edge test at an RK substage and assert the same field revision reaches RHS, energy and recorder.
- [ ] Add a test that PWL times are strictly increasing and malformed ABI data remains a validation error.
- [ ] Run just ensure-managed-fem-runtime; expected RED before implementation if the new test target and callback are absent.
- [ ] Run just verify-fem-regional-field-drive-contract; expected RED with a missing exact-time sample or revision mismatch.
- [ ] Implement the recorder hook in the Zeeman interaction boundary; do not add unrelated fields to Context and do not move physics into mfem_bridge.cpp.
- [ ] Run just verify-fem-regional-field-drive-contract and just verify-fem-regional-field-drive-rk-time-convergence; GREEN requires managed MFEM execution, pulse convergence and exact time error bounds.

### Zadanie 11: RegionalFieldDrive GPU FDM and device residency

**Files:**

- Create: backends/fdm/include/gpu_time_series_sampling_v1.hpp
- Create: backends/fdm/gpu/cuda/time_series_sampling.cu
- Modify: backends/fdm/include/execution_receipt.hpp
- Modify: crates/fullmag-runner/src/capabilities.rs
- Modify: crates/fullmag-runner/src/fdm/mod.rs
- Tests: backends/fdm/tests/device_residency_receipt_contract.cpp
- Tests: backends/fdm/tests/gpu_time_series_sampling_contract.cpp

**Interfaces — Consumes:**

- Same ResolvedRegionalFieldDriveBasisIR and sample schema as FDM CPU.
- CUDA magnetization/drive buffers and stream/event synchronization.
- Execution receipt fields device/operator mask, fallback_count and transfer counts.

**Interfaces — Produces:**

- CUDA callback that samples bounded device chunks without copying the full trajectory to host.
- Explicit device_residency_state, chunk bytes and transfer audit in the receipt.
- Capability IDs fdm.gpu.regional_field_drive and fdm.gpu.time_series_sampling.

**TDD / implementation:**

- [ ] Add a failing strict-GPU test that disables CUDA and asserts unsupported rather than execution on CpuFftBackend.
- [ ] Add a residency test asserting no full-series cudaMemcpy and zero fallback_count; each permitted staging copy has a reason code.
- [ ] Run cargo test -p fullmag-runner fdm_gpu_capabilities; expected RED because current FDM GPU regional drive is fail-closed and has no spectral sampler.
- [ ] Implement CUDA sampling and capability resolution separately from the CPU reference; preserve double precision until parity is qualified.
- [ ] Add cancellation and out-of-memory paths that finish as failed/cancelled with a finalized receipt, not as CPU retry; any partial data remains `artifact_status=incomplete`.
- [ ] Run the targeted FDM GPU contract and the managed CUDA recipe selected by justfile; GREEN requires strict lane identity, bounded device memory and no hidden host fallback.

### Zadanie 12: RegionalFieldDrive GPU FEM with MFEM/libCEED/CUDA residency

**Files:**

- Modify: backends/fem/gpu/cuda/interactions/zeeman/regional_field_kernels.cu
- Modify: backends/fem/gpu/cuda/interactions/zeeman/zeeman_kernels.cu
- Modify: backends/fem/gpu/cuda/interactions/zeeman/time_dependence_device.cuh
- Create: backends/fem/gpu/cuda/time_series_sampling/spectral_sampler.cu
- Modify: backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu only for receipt pattern, not time-domain equations
- Tests: backends/fem/tests/gpu_execution_receipt_contract.cpp
- Tests: backends/fem/tests/gpu_pageable_scalar_readback_contract.cpp
- Tests: backends/fem/tests/time_series_sampling_gpu_contract.cpp

**Interfaces — Consumes:**

- FEM GPU Zeeman regional basis, device waveform data and exact stage events.
- Existing FrequencyDomainGpuOperatorContext residency/receipt pattern as a structural reference only.
- GPU state ownership and transfer-audit helpers.

**Interfaces — Produces:**

- FEM GPU time-series sampler with device-resident magnetization, typed probe and bounded chunk output.
- Capability fem.gpu.regional_field_drive and fem.gpu.time_series_sampling.
- Receipt proving device, precision, topology, transfer bytes/count and fallback_count=0.

**TDD / implementation:**

- [ ] Add a test that pageable scalar readback is rejected when the request requires device residency.
- [ ] Add a test that missing libCEED/hypre/CUDA capability returns unsupported with no CPU execution.
- [ ] Run just ensure-managed-fem-runtime; expected RED if the new GPU sampler target is absent.
- [ ] Run just verify-fem-regional-field-drive-cpu-gpu-parity-runtime; expected RED until the GPU lane produces matching exact-time samples.
- [ ] Implement the CUDA sampler and stream synchronization at the backend boundary; keep equations shared through the neutral contract and do not duplicate sign/units in runner.
- [ ] Run just verify-fem-regional-field-drive-cpu-gpu-parity-runtime and the managed GPU contract recipe; GREEN requires double CPU/GPU parity, bounded residency and no fallback.

### Zadanie 13: AntennaFieldSolve, SolvedAntennaDrive i zależności źródła

**Files:**

- Modify: crates/fullmag-ir/src/study.rs
- Create: crates/fullmag-plan/src/antenna_field_basis.rs
- Modify: crates/fullmag-plan/src/antenna_zeeman.rs::resolve_prescribed_zeeman_masks
- Modify: crates/fullmag-runner/src/antenna_fields.rs
- Modify: crates/fullmag-runner/src/regional_field_drive_artifacts.rs
- Create: backends/fem/cpu/mfem/workflows/antenna_field_solve.cpp
- Create: backends/fem/include/antenna_field_basis_contract.hpp
- Tests: crates/fullmag-plan/tests/antenna_field_basis_dependency.rs
- Tests: backends/fem/tests/antenna_field_basis_contract.cpp

**Interfaces — Consumes:**

- Proposed AntennaFieldSolveIR fields antenna_ref, port_mode_ids, model, conductor_mesh, field_sampling, target_refs, solver_policy and outputs.
- Proposed SolvedAntennaDriveIR fields solution_ref, port_mode_id, peak_current_a, waveform, time_origin and active_stage_ids.
- Existing legacy Mqs2p5dAz and PrescribedZeemanMask source models.

**Interfaces — Produces:**

- Immutable solved-field artifact with field basis, mesh/target mapping, current normalization, source digest and solver provenance.
- Explicit dependency edge AntennaFieldSolveStage -> SolvedAntennaDrive -> TimeEvolutionStage -> TimeSeriesRecorder.
- Capability vocabulary for antenna.field_solve.quasistatic_conduction_biot_savart_3d and per-lane consumers fdm_cpu, fdm_gpu, fem_cpu, fem_gpu.

**TDD / implementation:**

- [ ] Add planner tests for missing solution_ref, stale solution digest, unknown port_mode_id, incompatible target mesh and wrong peak-current units.
- [ ] Add tests proving RegionalFieldDrive remains valid without AntennaFieldSolve and SolvedAntennaDrive cannot be substituted by a regional profile.
- [ ] Run cargo test -p fullmag-plan antenna_field_basis_dependency; expected RED because no typed dependency graph exists.
- [ ] Implement a contract-only FEM CPU solve boundary and artifact descriptor; retain mqs_2p5d_az as a legacy diagnostic, never as a tapered 3D production solve.
- [ ] Add source spectrum metadata and local-k eligibility without making finite-k depend on a hidden antenna solver.
- [ ] Run cargo test -p fullmag-plan antenna_field_basis_dependency and just verify-fem-regional-field-drive-contract; GREEN requires explicit source family, digest and lane capability.

### Zadanie 14: Mixed FEM topology and probe/operator certificate

**Files:**

- Modify: backends/fem/tests/fem_mixed_p1_contract.cpp
- Read-only recipe anchor: justfile::verify-fem-mixed-p1-local-interactions-native-contract
- Create: backends/fem/include/mixed_topology_probe_contract.hpp
- Create: backends/fem/cpu/mfem/interactions/mixed_topology_probe.cpp
- Modify: crates/fullmag-runner/src/spin_wave_sampling.rs::P1CrossSectionProbeOperator
- Modify: crates/fullmag-runner/src/artifact_pipeline.rs
- Tests: crates/fullmag-runner/tests/mixed_topology_finite_k_contract.rs

**Interfaces — Consumes:**

- MFEM element geometry with typed prism6, pyramid5 and tet4.
- Existing MixedLayerTopologyCertificate and mesh provenance conventions.
- Physical x/y/z coordinates and P1 basis values.

**Interfaces — Produces:**

- MixedTopologyProbeCertificate with schema, element counts, owner policy, coordinate digest and supported operator kinds.
- P1 sampling that integrates or evaluates each supported element type directly.
- Unsupported topology status that includes offending cell type and lane, with no conversion or centroid fallback.

**TDD / implementation:**

- [ ] Add a failing mixed mesh fixture containing all three supported cell types and a known linear vector field.
- [ ] Run just verify-fem-mixed-p1-capability-contract; expected RED while finite-k capability is restricted to tet4.
- [ ] Run just verify-fem-mixed-p1-native-contract; expected RED with missing mixed-topology probe symbol.
- [ ] Implement typed shape-function/probe dispatch and half-open face ownership; preserve existing coincident-face and empty-plane tests.
- [ ] Add response-field artifact metadata with topology certificate digest and probe invalid mask.
- [ ] Run just verify-fem-mixed-p1-capability-contract, just verify-fem-mixed-p1-native-contract and cargo test -p fullmag-runner mixed_topology_finite_k_contract; GREEN requires exact linear-field reproduction and no hidden conversion.

### Zadanie 15: Capability, provenance, no-fallback dispatch and API boundary

**Files:**

- Modify: crates/fullmag-runner/src/capabilities.rs
- Create: crates/fullmag-plan/src/spectral_capabilities.rs
- Modify: crates/fullmag-runner/src/dispatch.rs only for typed routing and rejection
- Modify: crates/fullmag-runner/src/artifact_pipeline.rs
- Read-only boundary: crates/fullmag-api/src/router_v2/handlers/analysis/spin_wave_response.rs
- Read-only boundary: crates/fullmag-api/src/router_v2/handlers/analysis/frequency_domain.rs
- Read-only boundary: apps/control-room/src/kernel/resources/studyRuntimeResources.ts
- Tests: crates/fullmag-runner/tests/spectral_lane_resolution_contract.rs

**Interfaces — Consumes:**

- requested analysis engine from SpectralAnalysisEngineRequestIR oraz requested compute lane/strict_gpu from SpectralComputePolicyIR; source dynamics lane comes from the immutable source artifact receipt.
- Runtime capability registry, device identity and managed runtime manifest.
- Resource-first API conventions and status values planned for v2.

**Interfaces — Produces:**

- Per-lane capability matrix for regional drive, exact sampling, spectral FFT, response fields, finite-k and antenna basis.
- Resolved execution receipt with requested intent, resolved reality, source/runtime digests and fallback_count.
- Typed dispatch that calls backend hooks only after capability resolution; unsupported is terminal and serializable.

**TDD / implementation:**

- [ ] Add table-driven tests for all four lanes, forced GPU, missing CUDA, missing MFEM, mixed topology and absent antenna basis.
- [ ] Add a test that a requested fdm_gpu cannot resolve to fdm_cpu and that a requested fem_gpu cannot resolve to fem_cpu.
- [ ] Run cargo test -p fullmag-runner --test spectral_lane_resolution_contract; expected RED because current dispatch has no product capability IDs.
- [ ] Add only routing/provenance changes to dispatch; keep numerical implementation in backends/fdm, backends/fem and spectral_engine.rs.
- [ ] Add orthogonal enums exactly as in the design crosswalk: execution_status planned/queued/running/succeeded/failed/cancelled/unsupported; artifact_status missing/incomplete/ready/invalid; validation_state unvalidated/algebra_validated/physics_validated/production_qualified. Enforce monotonic transitions and require succeeded => ready.
- [ ] Run the lane-resolution test and resource descriptor serialization test; GREEN requires exact requested/resolved fields and zero fallback count.

### Zadanie 16: Persistence, streaming, cancellation and memory qualification

**Files:**

- Modify after contracts/storage plan: crates/fullmag-runner/src/time_series_recorder.rs
- Modify: crates/fullmag-runner/src/autosave_zarr.rs
- Modify: crates/fullmag-runner/src/autosave_hdf5.rs
- Modify: crates/fullmag-runner/src/artifact_pipeline.rs
- Create: scripts/validate_time_domain_spectral_artifacts.py
- Tests: crates/fullmag-runner/tests/spectral_bounded_streaming_contract.rs
- Tests: scripts/tests/test_validate_time_domain_spectral_artifacts.py

**Interfaces — Consumes:**

- TimeSeriesRecorder chunks, SpectralEngine receipt and cancellation token.
- Zarr compressor/chunk/dtype/endian settings and HDF5 dataset layout.
- Incomplete-stage recovery and continuous index from autosave_storage.rs.

**Interfaces — Produces:**

- Bounded stream-to-artifact pipeline with configurable but validated memory_budget_bytes.
- Identical Zarr/HDF5 logical schema, shape, units, checksums and completion manifest.
- Validator reporting schema, axis, phase, source mask, topology, provenance, receipt and status errors.

**TDD / implementation:**

- [ ] Add a large synthetic stream test whose input exceeds the memory budget; assert peak_workspace_bytes stays below budget and no full source Vec is created.
- [ ] Add interruption tests between chunks and during final manifest hash; resume must retain valid chunks and mark incomplete state.
- [ ] Run cargo test -p fullmag-runner --test spectral_bounded_streaming_contract; expected RED due to full in-memory Vecs in current Gamma/finite-k paths.
- [ ] Implement chunked reader/writer, backpressure and cancellation checkpoints at chunk and artifact boundaries.
- [ ] Implement the validator with explicit failure messages for unknown window, malformed axis, missing source digest, mixed topology without certificate and fallback_count greater than zero.
- [ ] Run python scripts/validate_time_domain_spectral_artifacts.py --help; expected RED until the validator exists, then run it against generated Zarr/HDF5 fixtures and require GREEN.

### Zadanie 17: Managed FEM contract, runtime and convergence gates

**Files:**

- Modify: justfile
- Tests: backends/fem/tests/time_series_sampling_contract.cpp
- Tests: backends/fem/tests/time_domain_spectral_qualification.cpp
- Tests: backends/fem/tests/time_domain_spectral_gpu_qualification.cpp
- Read-only build route: justfile::ensure-managed-fem-runtime
- Read-only build policy: scripts/lib/managed_fem_build_policy.sh

**Interfaces — Consumes:**

- Container-backed MFEM/hypre/libCEED/CUDA runtime and source identity manifest.
- CPU/GPU regional drive, exact-time recorder, mixed topology and SpectralEngine artifacts.
- Existing justfile gates for regional field drive, LLG time domain, finite-k and frequency-domain contracts.

**Interfaces — Produces:**

- Dedicated recipes verify-fem-time-domain-spectral-contract, verify-fem-time-domain-spectral-cpu-gpu-parity and verify-fem-time-domain-spectral-production.
- Receipts tying source SHA, managed image, compiler/runtime, precision, device and artifact hashes.
- Qualification report with analytic signal, pulse event, Kittel/known mode, zero drive, paired control, dt/window/mesh/probe convergence.

**TDD / implementation:**

- [ ] Add contract test sources and make each recipe begin with just ensure-managed-fem-runtime; do not use host cargo/cmake as final proof.
- [ ] Run just verify-fem-time-domain-native-contract; expected RED until the shared recorder contract is wired to native FEM.
- [ ] Run just verify-fem-llg-time-domain-qualification; expected RED for missing exact-time spectral artifact and no-fallback receipt.
- [ ] Run just verify-fem-llg-time-domain-qualification-gpu; expected RED or unsupported with an explicit capability if the managed GPU lane is unavailable; it must never report CPU success.
- [ ] Implement recipes using the repository's container-backed build/run convention and task-specific external report roots; preserve dirty checkout artifacts.
- [ ] Run just verify-fem-time-domain-spectral-contract, just verify-fem-time-domain-spectral-cpu-gpu-parity and just verify-fem-time-domain-spectral-production; GREEN requires managed runtime receipts and all numerical gates.

### Zadanie 18: Existing regression gates and final cross-lane qualification

**Files:**

- Modify: docs/superpowers/specs/2026-08-31-time-domain-spectral-analysis-design.md only when implementation evidence requires a resolved contract correction
- Read-only canonical note: docs/physics/0997-time-domain-spectral-analysis.md; measured receipts are handed to the validation/rollout owner, and any publication update is performed serially by the contracts/storage documentation owner
- Tests: crates/fullmag-runner/tests/time_domain_spectral_end_to_end.rs
- Tests: packages/fullmag-py/tests/test_time_domain_spectral_analysis.py
- Read-only artifacts: spectrum.v2, spectrum.v3 and mode_fields.zarr compatibility fixtures

**Interfaces — Consumes:**

- Four lane receipts and equivalent time-series/spectra artifacts.
- Existing gates verify-fem-periodic-antidot-gamma-pulse-runtime, verify-fem-antidot-waveguide-finite-k-runtime and frequency-domain recipes.
- MMPP only as optional parity reader/worker/oracle; no runtime import is required for native qualification.

**Interfaces — Produces:**

- End-to-end report mapping every requested product to source artifact, lane, schema, receipt, numerical tolerance and status.
- Compatibility verdict for legacy spectrum.v2/v3 and mode_fields.zarr: accepted with explicit validation_state, rejected with reason, or left unvalidated; never silent reinterpretation.
- Final MMPP comparison using an explicit protocol and independent provenance, if the optional worker is available.

**TDD / implementation:**

- [ ] Add one deterministic analytic sine run and one physical Kittel/known-mode run per supported lane; compare peak frequency, phase and amplitude.
- [ ] Add traveling-wave finite-k run with a mixed FEM mesh and assert k/f peak, probe digest and topology certificate.
- [ ] Add zero-drive, paired-control, dt convergence, window convergence, mesh convergence and probe convergence cases.
- [ ] Run cargo test -p fullmag-runner --test time_domain_spectral_end_to_end; expected RED until all graph stages produce ready artifacts.
- [ ] Run Python round-trip and artifact validator tests; then run existing regional-drive, gamma-pulse and finite-k managed recipes to prove no regression.
- [ ] Mark a lane qualified only if all receipt/provenance, parity, convergence, bounded-memory, exact-time and no-fallback gates are GREEN; otherwise preserve the exact execution/artifact states and keep validation_state below production_qualified.

## Kontrakt implementacyjny SpectralEngine

Interfejs ma być backend-neutralny i stream-aware:

    pub trait SpectralEngine {
        fn inspect(
            &self,
            source: &TimeSeriesDescriptor,
        ) -> Result<SpectralInspection, SpectralError>;

        fn execute(
            &self,
            source: &mut dyn TimeSeriesReader,
            request: &ResolvedSpectralAnalysis,
            sink: &mut dyn SpectralArtifactWriter,
            cancellation: &CancellationToken,
        ) -> Result<SpectralExecutionReceipt, SpectralError>;
    }

TimeSeriesReader udostępnia `read_next_chunk`, `rewind_observable` i `source_descriptor`; implementacja nie może ujawnić mutowalnego bufora solvera. SpectralArtifactWriter udostępnia `begin_spectrum`, `append_frequency_block`, `append_peak_field`, `finish`; każdy zapis ma walidować kolejność i hash.

Kolejność wykonania jest stała:

1. Walidacja descriptorów, osi, units, topology certificate i provenance.
2. Odczyt referencji oraz blokowe utworzenie δm.
3. Detrend i okno z zapisanym coherent gain/ENBW.
4. RFFT/FFT w blokach, akumulacja response/source/power.
5. Source threshold i valid_source_mask przed dzieleniem susceptibility.
6. Peak detection z lokalizacją binu, interpolacją i confidence metadata.
7. Opcjonalny response field oraz operator przestrzenny S(k,f).
8. Flush, hash, manifest i atomowe przejście do ready.

Nie używać `crates/fullmag-engine/src/fdm/cpu/fft_backend.rs::GatherScatterFallback` dla tego produktu. Jest to backend demagnetyzacji, a jego fallback nie jest dowodem kwalifikowanego spectral lane.

## Zasady integracji regionalnego napędu

Wszystkie backendy używają tej samej kolejności:

    resolved drive -> spatial profile/basis -> exact physical time -> H_drive revision
    -> H_eff/RHS -> Zeeman energy -> TimeSeriesRecorder -> artifact provenance

FDM oblicza cell-average z resolved profile. FEM oblicza typed P1/adaptive projection na elementach. Współczynnik, znak, waveform, time_origin i activation są transportowane jako jeden plan; `zeeman_time_dependence.cpp::evaluate_time_dependence` oraz GPU `time_dependence_device.cuh` muszą dawać te same wartości w tych samych chwilach.

`regional_drive_revision` jest monotonically increasing i wiąże pole z energią oraz próbką. Każde odczytanie pochodzące z innej rewizji jest niespójnością artefaktu i kończy etap jako failed. Zmiana rewizji nie może zostać ukryta przez cache ani przez ponowną inicjalizację Context.

## Zasady GPU i pamięci

GPU lane otrzymuje własny capability i resolver. Forced GPU ma trzy wyniki: ready, failed z diagnostyką runtime albo unsupported z reason code; czwarty wynik CPU success jest zabroniony.

Stan magnetyzacji, drive basis i probe operator pozostają na urządzeniu w czasie ewolucji. Recorder czyta wyłącznie bounded chunk po zdarzeniu albo korzysta z device spectral kernel; każdy staging copy ma rozmiar, kierunek, synchronizację i powód w receipt. Wartość `transfer_count=0` oznacza brak kopii, nie brak pomiaru.

Budżet obejmuje FFT workspace, staging, response field i kompresję. OOM kończy się failed/cancelled i pozostawia diagnostyczny manifest; nie wolno redukować precision, wyłączać produktów ani przełączać na CPU bez nowego jawnego requestu.

## Gate'y akceptacji

| Gate | Dowód | Warunek akceptacji |
|---|---|---|
| Schema | Zarr/HDF5 validator | Jednoznaczne v1 schema, identyczne osie, shapes, units, hashes i provenance |
| Exact time | time_error_s oraz quality flags | Wszystkie próbki w tolerancji; accepted-step trace nie przechodzi jako exact |
| FFT | sine/phase/window fixtures | Poprawny bin, znak fazy, amplitude, DC/Nyquist, coherent gain i ENBW |
| Gamma | paired control/zero drive | δm i susceptibility mask są reprodukowalne ze source artifact |
| finite-k | traveling wave/P1 | Poprawny k/f oraz typed operator digest bez reshape i bez hidden conversion |
| Regional drive | pulse/RK/event tests | Ten sam field revision w RHS, energy i recorder |
| FDM CPU | native reference receipt | double, bounded chunks, fallback_count=0 |
| FDM GPU | CUDA residency receipt | requested=fdm_gpu, resolved=fdm_gpu, brak CPU fallback |
| FEM CPU | managed just runtime | MFEM/hypre, mixed topology certificate, CPU parity |
| FEM GPU | managed CUDA runtime | libCEED/hypre/CUDA receipt, bounded device staging, brak fallback |
| Antenna | dependency tests | Solve/drive digest i port mode są jawne; brak source-family substitution |
| Performance | peak_workspace/transfer receipt | Budżet RAM/GPU dotrzymany na przebiegu większym niż pamięć |
| Persistence | interruption/resume | Chunks, manifest i status są atomowe oraz odtwarzalne |
| Compatibility | legacy adapter report | spectrum.v2/v3 i mode_fields.zarr mają jawny verdict, bez reinterpretacji |
| Optional MMPP | protocol/parity report | MMPP nie jest wymaganiem runtime i nie zmienia native result |

## Kolejność wykonania i checkpointy

1. Zadania 1–3: zamrożenie fizyki, IR, DSL i grafu zależności; checkpoint to zielone testy serde/pytest i zatwierdzony source map.
2. Zadania 4–6: recorder, exact-time clock, Zarr/HDF5 i CPU SpectralEngine; checkpoint to zielony bounded analytic sine.
3. Zadania 7–8: Gamma i finite-k; checkpoint to paired-control oraz mixed-topology operator tests.
4. Zadania 9–12: regional drive i cztery realizacje backendowe; checkpoint to per-lane receipts oraz managed FEM gates.
5. Zadania 13–15: antena, capabilities, provenance i no-fallback dispatch; checkpoint to rejection matrix.
6. Zadania 16–18: streaming, persistence, compatibility i final qualification; checkpoint to kompletny report, bez commitów w tym zadaniu.

Każdy checkbox zmienia tylko wskazane pliki, poprzedza implementację testem RED i kończy się dokładną komendą GREEN. Nie wolno oznaczyć gate'u jako spełnionego na podstawie samego istnienia artefaktu, metadanych API lub renderu UI; wymagane są także receipt runtime, walidacja naukowa i dowód linii wykonania.
