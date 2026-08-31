# Audyt analizy spektralnej dynamiki czasowej i integracji MMPP

**Data audytu:** 2026-08-31

**Repozytorium:** `C:\git\fullmag\fullmag`

**Branch:** `master`

**HEAD:** `e4f653cfaa4505b8659b1ad173b7aec2b67aaad5`

**Tryb:** read-only względem kodu produkcyjnego; audyt nie uruchamiał kosztownych recept runtime
**Werdykt:** `NO-GO` dla twierdzenia, że kompletny workflow time-domain spectroscopy jest obecnie produkcyjny

## 1. Pytanie audytowe

Czy bieżący Fullmag zapewnia produkcyjny, zautomatyzowany przepływ:

```text
antena mikrofalowa
-> dynamika LLG
-> zapis m(t,r)
-> FFT
-> widmo/piki/pola odpowiedzi/S(k,f)
-> API
-> Control Room
-> eksport Zarr/HDF5/FMS
```

Odpowiedź brzmi: **nie**. Repozytorium zawiera ważne, częściowo działające fragmenty, ale nie zawiera jednego backend-neutralnego kontraktu, kompletnej macierzy lane'ów ani dowodu end-to-end na tej samej tożsamości runu i artefaktu.

## 2. Metoda i poziomy dowodu

Audyt rozdziela:

| Poziom | Znaczenie |
|---|---|
| `SOURCE_VISIBLE` | symbol lub ścieżka istnieje w kodzie |
| `CONTRACT_TESTED` | test kontraktu istnieje i był uruchomiony w bieżącym audycie |
| `EXECUTABLE` | rzeczywisty backend wykonał workflow |
| `PHYSICS_VALIDATED` | wynik przeszedł oracle/convergence/parity |
| `PRODUCTION_QUALIFIED` | source identity, managed runtime, receipts, artefakty, API i UI są spójne |
| `NOT VERIFIED` | audyt nie posiada wystarczającego bieżącego dowodu |

Samo istnienie kodu nie jest dowodem wykonania. Sam artefakt nie dowodzi poprawnej projekcji sesji i UI. Testy jednostkowe nie są browser/WebGL proof.

## 3. Higiena checkoutu

### 3.1 Stan

Checkout był silnie zabrudzony niezależnymi zmianami, m.in. w:

- workflow CI;
- FrozenSpins;
- FDM/FEM plannerze i runnerze;
- Control Room viewport;
- publicznej dokumentacji;
- skryptach kwalifikacyjnych;
- zewnętrznych solverach.

`git diff --cached --name-only` był pusty podczas wejścia w etap dokumentacyjny. Audyt nie resetował, nie stashował i nie formatował cudzych zmian.

### 3.2 Konsekwencja

Nowe dokumenty tego zadania używają nowych ścieżek. Żaden istniejący zmodyfikowany plik nie został przejęty ani nadpisany.

## 4. Dokumenty normatywne

### 4.1 Czasowy LLG

`docs/physics/0960-canonical-llg-time-domain-solver-and-qualification-contract.md`

Istotne kontrakty:

- explicit fixed-step i adaptive lanes;
- event landing;
- atomic attempt/rollback;
- telemetry;
- osobna kwalifikacja urządzeń i precyzji.

Ocena:

- semantyka jest obszerna;
- bieżące checkboxy nie dowodzą pełnego Python/IR/planner/API/UI scope;
- świeża kwalifikacja wszystkich lane'ów dla nowego workflow: `NOT VERIFIED`.

### 4.2 Regionalny napęd czasowy

`docs/physics/0920-regional-time-domain-field-drive.md`

Kanoniczne quantity:

- `H_drive`;
- `B_drive`;
- `E_drive`;
- `eden_drive`.

Dokument definiuje Γ i finite-k jako odrębne ścieżki walidacji. Nie daje samodzielnie dowodu bieżącego wykonania.

### 4.3 Antena mikrofalowa

`docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md`

Proponuje:

- `AntennaFieldSolve`;
- `SolvedAntennaDrive`;
- `H_ant_basis`;
- `J_charge`;
- `V_electric`.

Pełna ścieżka Tier 1 pozostaje niewdrożona/niezakwalifikowana. Dla taperu i przewężenia wymagane jest rozwiązanie 3D; translacyjnie niezmienny model 2.5D nie spełnia produkcyjnego kontraktu.

### 4.4 Próbkowanie i autosave

`docs/physics/0910-table-autosave-observables.md` oraz dokumenty 0920 wymagają jawnych osi, jednostek i rozróżnienia czasu fizycznego od numeru kroku.

### 4.5 Frequency-domain jako wzorzec, nie semantyczny właściciel

- `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`;
- `docs/physics/0700-frequency-domain-linearized-llg.md`;
- `docs/specs/frequency-domain-artifacts-v2.md`.

Z tych dokumentów należy odzyskać:

- rozdział control-plane/data-plane;
- zespolone pola `[carrier,3,2]`;
- requested/resolved execution;
- stabilne resource keys;
- diagnostykę i provenance.

Nie należy odzyskiwać założenia, że pik FFT jest eigenmodem.

## 5. Python DSL — stan obecny

### 5.1 Potwierdzone symbole

`packages/fullmag-py/src/fullmag/model/study.py`:

- `Relaxation`;
- `RelaxStop`;
- `TimeEvolution`;
- `TableAutosave`;
- `GammaResponseAnalysis`.

`packages/fullmag-py/src/fullmag/model/dynamics.py`:

- `LLG`;
- `AdaptiveTimestep`;
- `FieldRefreshPolicy`.

`packages/fullmag-py/src/fullmag/world.py::StudyStagesBuilder`:

- `add_relax()`;
- `add_run()`;
- `add_field_drive()`;
- `tableautosave()`;
- `autosave()`;
- `fft_response()`.

### 5.2 Ocena `fft_response()`

`StudyStagesBuilder.fft_response()`:

- materializuje `spin_wave_response` w `runtime_metadata`;
- tworzy syntetyczną akcję `fft_response`;
- nie definiuje typowanego, samodzielnego artefaktu źródłowego;
- nie modeluje przestrzennego pola odpowiedzi;
- nie jest pełnym round-tripowalnym publicznym produktem.

Status: `SOURCE_VISIBLE`, nie `PRODUCTION_QUALIFIED`.

### 5.3 Pythonowe helpery FFT

`packages/fullmag-py/src/fullmag/analysis/spectrum.py`:

- `fft_from_trace()`;
- `psd_from_trace()`;
- `peak_frequency()`;
- `linewidth_lorentzian()`.

Ograniczenia:

- operują na śladzie w pamięci;
- nie są readerem/writerem artefaktów;
- nie rozwiązują `m(t,r)`;
- fallback nieznanego okna do Hann jest niewłaściwy dla fail-closed nauki.

## 6. Waveform i czas

### 6.1 Dwa częściowo dublujące się kontrakty

`crates/fullmag-ir/src/model.rs::TimeDependenceIR` obsługuje:

- constant;
- sinusoidal;
- pulse;
- piecewise linear;
- sinc pulse.

`crates/fullmag-ir/src/study.rs::TimeEnvelopeIR` obejmuje inny zestaw, w tym tabulated.

`crates/fullmag-runner/src/time_envelope.rs::evaluate_time_envelope()` odrzuca tabulated bez resolvera artefaktu.

Luka:

- brak jednego publicznego kontraktu waveform;
- brak kanonicznego chirpa;
- auto sampling nie obejmuje wszystkich źródeł;
- migracja compatibility nie ma jednego właściciela.

### 6.2 Zegary stage'u

`crates/fullmag-ir/src/plan.rs::TimeStageContextIR` zawiera:

- `active_stage_id`;
- `start_time_s`.

Brakuje w nim kompletnego opisu:

- końca stage'u;
- output grid;
- sampling method;
- accepted-step kontra exact-time;
- resampling provenance.

## 7. Planner i integratory

### 7.1 Obsługiwane integratory

Python deklaruje m.in.:

- Heun;
- RK4;
- RK23;
- RK45;
- ABM3;
- coupled IMEX ARK2;
- auto.

`crates/fullmag-plan/src/validate.rs::planned_study_controls()` rozwiązuje część reguł. ABM3 z regional drive jest odrzucany ze względu na brak kwalifikowanego restartu historii.

### 7.2 Sampling planner

`crates/fullmag-plan/src/sampling.rs::resolve_auto_sampling_for_stage()` używa zależności odpowiadającej:

```text
dt = 1 / (2 * 1.3 * cutoff_hz)
```

Ograniczenie: ścieżka koncentruje się na aktywnym `RegionalFieldDriveIR` z sinc. Nie pokrywa spójnie:

- legacy antenna source;
- Oersted/current waveform;
- tabulated envelope;
- chirp;
- wszystkich wariantów outputu pola.

## 8. FDM CPU

### 8.1 Potwierdzona implementacja regional drive

`crates/fullmag-plan/src/fdm.rs::resolve_fdm_regional_field_drives()` materializuje napędy.

`crates/fullmag-runner/src/fdm/cpu/reference.rs` zawiera:

- `resolved_regional_field_drives()`;
- `materialize_reference_problem()`;
- `regional_drive_energy()`;
- `record_due_outputs()`;
- `record_final_outputs()`.

Współdzielony problem FDM implementuje ocenę pola w
`crates/fullmag-engine/src/fdm/shared/problem.rs::regional_drive_field_at_time()`.

Test `regional_drive_produces_distinct_field_and_energy_outputs()` sprawdza rozdział pola i energii.

### 8.2 Status

FDM CPU jest najlepszym kandydatem na mały oracle kontraktowy. Audyt nie wykonał świeżego pełnego workflow relaxation → RF → full field series → FFT → API/UI.

Status end-to-end: `NOT VERIFIED`.

## 9. FDM GPU

### 9.1 Potwierdzony blocker

Planner posiada fail-closed diagnostic:

```text
fdm_cuda_regional_field_drive_unsupported
```

Znaczenie: wymuszony CUDA nie obsługuje obecnie kanonicznego regionalnego napędu czasowego.

### 9.2 Dodatkowa luka multilayer

`FdmMultilayerPlanIR` nie zachowuje obecnie `field_drives` w publicznej ścieżce planu.

### 9.3 Artefakty

`crates/fullmag-runner/src/fdm/gpu/cuda/execute.rs` i `artifacts.rs` mają infrastrukturę snapshotów/statystyk, ale nie są podłączone do backend-neutralnej spatial FFT.

Status time-domain spectroscopy: `UNSUPPORTED` dla kanonicznego regional drive.

## 10. FEM CPU/GPU

### 10.1 Plan

`crates/fullmag-plan/src/fem.rs` zachowuje:

- `field_drives`;
- `field_drive_geometry_masks`;
- `antenna_zeeman_masks`;
- `time_stage`.

### 10.2 Runtime adapters

- `crates/fullmag-runner/src/native_fem/stage_coupled.rs`;
- `crates/fullmag-runner/src/native_fem/stage_oersted.rs`;
- `crates/fullmag-runner/src/native_fem/stage_transport.rs`.

Używają time envelope i oddzielnych adapterów stage'u.

### 10.3 Status

Istnienie ścieżek nie dowodzi pełnej parity CPU/GPU dla:

- waveformów;
- regional drive;
- field snapshots;
- adaptive exact-time sampling;
- finite-k;
- Zarr/HDF5 identity.

Native source/runtime identity: `NOT VERIFIED` w tym audycie.

## 11. Bieżąca odpowiedź Γ

### 11.1 Implementacja

`crates/fullmag-runner/src/spin_wave_response.rs`:

- `SpinWaveResponseArtifact`;
- `build_gamma_response_with_detrend()`;
- `build_gamma_transverse_response_with_detrend()`;
- `append_requested_spin_wave_artifacts()`.

Generowany artefakt:

```text
analysis/spin_wave_response.gamma.v1.json
```

### 11.2 Zachowanie

- odczytuje `mx`, `my`, `mz` z `ExecutedRun.result.steps`;
- odejmuje początkowy stan;
- wymaga co najmniej czterech próbek;
- wymaga równomiernego czasu;
- stosuje Hann;
- liczy jednostronne PSD i susceptibility.

### 11.3 Krytyczny drift

UI wiąże sampling z `TableAutosave`, ale analiza czyta zaakceptowane kroki solvera. Adaptive integrator może więc dostarczyć nierównomierny czas, mimo że użytkownik skonfigurował równy output cadence.

To jest błąd granicy danych, nie wyłącznie błąd panelu.

### 11.4 Ograniczenia

- globalny target;
- uniform spatial profile;
- tylko k=0;
- źródło rekonstruowane z waveformu zamiast powiązane z kanonicznym source field-series;
- JSON niesie duże tablice;
- brak przestrzennego response field.

## 12. Bieżące FEM finite-k

### 12.1 Implementacja

`crates/fullmag-runner/src/spin_wave_sampling.rs`:

- `P1CrossSectionProbeOperator`;
- `build_p1_x_cross_section_operator()`;
- `dynamic_structure_factor_1d_with_axes()`;
- `requested_finite_k_artifacts()`.

Artefakty:

```text
analysis/fem_p1_cross_section_probe.v1.json
analysis/dynamic_structure_factor.1d.v1.json
```

### 12.2 Zachowanie

1. czyta FEM `fields/m.zarr`;
2. buduje przekroje P1;
3. próbuje na równomiernych pozycjach x;
4. wykonuje FFT po czasie i przestrzeni;
5. analizuje także `H_drive`;
6. zapisuje power i complex spectrum.

### 12.3 Ograniczenia

- FEM-only;
- x-only;
- co najmniej 4×4 próbki;
- równomierne `dt` i `dx`;
- `tet4`;
- mixed topology odrzucone;
- uruchamiane przez runtime metadata;
- brak publicznego `AnalysisIR`;
- brak analogicznej ścieżki FDM;
- brak pełnego per-frequency spatial response field.

## 13. Storage Fullmag

### 13.1 Zarr autosave

`crates/fullmag-runner/src/autosave_zarr.rs` używa Zarr v2 i spłaszczonych tablic stage'owych.

Potwierdzone cechy:

- pola są reprezentowane jako sample/value;
- chunk zwykle rozdziela sample;
- oś czasu nie jest pełnym, samodzielnym kontraktem analizy;
- format nie jest bezpośrednio kanonicznym `m[time,carrier,component]`.

### 13.2 HDF5 autosave

`crates/fullmag-runner/src/autosave_hdf5.rs` buforuje dane stage'u przed zapisem macierzy.

Ryzyko: pełne `m(t,r)` może przekroczyć RAM. Produkcyjny kontrakt wymaga streaming/chunked writer.

### 13.3 Native FEM field store

FEM finite-k czyta osobny custom Zarr z `samples.csv`. To kolejna ścieżka, którą należy zunifikować na poziomie logicznego descriptoru, nie koniecznie jednego writer implementation.

## 14. Frequency-domain artifacts jako wzorzec

### 14.1 Istniejący układ

`docs/specs/frequency-domain-artifacts-v2.md` definiuje m.in.:

```text
frequency_domain/manifest.v1.json
eigen/spectrum.v2.json
eigen/branches.v2.json
eigen/dispersion.csv
eigen/mode_fields.zarr
response/field_payloads.zarr
```

### 14.2 Zespolone pola

Bieżący logical layout:

```text
[node, 3, 2]
component_order = x,y,z
complex_order = real,imag
```

To właściwy wzorzec dla `response_fields.zarr`, o ile time-domain zachowa własny `study_product` i provenance.

### 14.3 Potwierdzona sprzeczność fazy w istniejącym fixture

Audyt fixture frequency-domain wykazał niespójność:

- manifest: `exp_minus_i_omega_t`;
- spectrum/diagnostics: `exp_i_omega_t`.

Wniosek: nowy validator musi porównywać phase convention w całym bundle i fail-closed.

### 14.4 Chunking

Małe mode fields są zapisywane jako jeden pełny chunk bez kompresji. Ten model nie skaluje się automatycznie do dużego time-series.

## 15. API

### 15.1 Istniejące spin-wave endpoints

`crates/fullmag-api/src/router_v2/handlers/analysis/spin_wave_response.rs` publikuje zasoby Γ i DSF.

### 15.2 Istniejący frequency-domain resource family

`crates/fullmag-api/src/router_v2/handlers/analysis/frequency_domain.rs` zawiera:

- manifest;
- spectrum;
- branches;
- dispersion;
- diagnostics;
- mode field metadata;
- response sweep/progress/cancel/points/field metadata.

`crates/fullmag-api/src/router_v2/handlers/data/fields.rs` publikuje ciężkie zespolone pola w data-plane.

### 15.3 Potwierdzone luki

1. Brak ogólnej run-scoped rodziny time-domain spectral analysis.
2. Brak historycznych result resources o pełnej tożsamości.
3. Brak dedykowanej analysis invalidation family.
4. Część optional artifacts zwraca `200 + missing`, mimo że dokumentacja oczekuje 404.
5. Współistnieją aliasy `/analysis/eigenmodes`, `/analysis/eigen` i `/analysis/frequency-domain`.
6. Eksport spectrum/mode bundle jest generyczny, bez dedykowanego pełnego manifestu.

## 16. Control Room

### 16.1 Potwierdzone elementy do ponownego użycia

API facade:

- `apps/control-room/src/kernel/api/ControlRoomApi.ts`;
- `apps/control-room/src/kernel/api/apiPaths.ts`;
- generated OpenAPI types.

Resources:

- `apps/control-room/src/kernel/resources/studyRuntimeResources.ts`;
- `ResourceRuntimeStore`;
- `useResource`.

Analysis:

- `apps/control-room/src/modules/analysis-plots/AnalysisPlotsView.tsx`;
- `apps/control-room/src/modules/analysis-plots/useAnalysisPlotsController.ts`;
- `apps/control-room/src/modules/analysis-plots/hooks/useAnalysisFrequencyData.ts`.

Inspector/overlay:

- `FftResponseStageInspector.tsx`;
- `SpinWaveGammaView.tsx`;
- `EigenModeInspectorPanel.tsx`;
- `FmrModalSpectrumInspectorPanel.tsx`;
- `FmrResponseSweepInspectorPanel.tsx`;
- `ModeVisualizationInspectorPanel.tsx`;
- `AnalysisFieldOverlayController`.

### 16.2 Stan UI Γ

Panel obsługuje:

- enable;
- component `my`/`mz`;
- detrend;
- Hann;
- susceptibility floor;
- wizualizację time trace i spectrum.

Nie obsługuje:

- pełnej spatial FFT;
- wyboru piku → field resource;
- general products;
- historycznego runu;
- typed MMPP engine;
- eksportu bundle.

### 16.3 Results Explorer

Istnieją fizycznie nazwane grupy Results, ale historyczny run może otrzymać pustą projekcję, ponieważ run-scoped resources nie są publikowane.

### 16.4 Response map

UI jawnie oznacza response-map jako niedostępny z powodu braku typed resource. To właściwy fail-closed stan, lecz potwierdza brak produktu.

### 16.5 Browser/WebGL

Brak bieżącego pełnego dowodu:

- real run;
- real time-series;
- real spectrum;
- selected peak;
- real response field;
- widoczny canvas;
- `gl.isContextLost() == false`;
- niezerowy drawing buffer;
- export.

Status: `NOT VERIFIED`.

## 17. MMPP — bieżący stan

### 17.1 Źródło

Audytowano read-only checkout:

```text
/home/kkingstoun/git/containers_admin2/postprocessing/mmpp
commit b13f3177ea7718420eb7fbc9d74a110eae60c0b8
version 0.6.0
license MIT
Python >= 3.9
```

Publiczne repozytorium: `https://github.com/MateuszZelent/mmpp`.

### 17.2 Zależności

Core obejmuje m.in.:

- NumPy;
- pandas;
- matplotlib;
- Zarr;
- h5py;
- PyYAML;
- rich/tqdm.

Opcjonalne FFT obejmuje SciPy/pyFFTW. Istnieją ryzyka ABI NumPy/h5py/numcodecs, Zarr 2/3 i środowiska wheel/BLAS.

### 17.3 Potwierdzone API

- `MMPP`;
- `ZarrJobResult`;
- `DatasetAwareWrapper`;
- `FFT`;
- `FFTCompute`;
- `SpectrumResult`;
- `FFTModeInterfaceNew`;
- `FMRModeAnalyzer`;
- dispersion models;
- HDF5 adapters.

Przykładowe wejścia użytkownika:

```python
res.fft.spectrum()
res.fft.modes.compute_modes()
res.fft.modes.interactive_spectrum()
res.m.fft.dispersion.plot.interactive()
```

### 17.4 Niezgodny layout

MMPP zapisuje własne przestrzenie:

```text
fft/{dataset_id}/spectrum
fft/{dataset_id}/frequencies
modes/{dataset_id}/freqs
modes/{dataset_id}/arr
```

`{dataset_id}` jest formalnym segmentem layoutu MMPP, nie ścieżką docelowego artefaktu Fullmag.

Nie jest to Fullmag `manifest.v1` ani `response_fields.zarr`.

### 17.5 Niezgodności naukowe i strukturalne

- część legacy modes używa GHz, Fullmag API używa Hz;
- MMPP często zakłada regularny grid 4D/5D;
- FEM Fullmag ma globalny node order i typed topology;
- legacy brak `dt` może używać fallbacku `1e-12 s`;
- część power summary bazuje historycznie na `abs(FFT)`, nie jednoznacznie `abs(FFT)^2`;
- MMPP cache nie zna Fullmag run/stage/resource identity;
- brak Fullmag capability/provenance/resource-key modelu.

### 17.6 Wniosek integracyjny

In-process MMPP nie powinno być krytyczną ścieżką runtime. Zatwierdzony wariant:

- Fullmag native baseline;
- wersjonowany adapter MMPP;
- opcjonalny isolated worker;
- parity fixtures;
- brak zależności dla podstawowego działania.

Wymagany kontrakt rozwiązywania engine jest fail-closed: `native` i `mmpp` są żądaniami jawnymi, natomiast `auto` jest deterministycznie rozwiązywane przez planner przed startem. Baseline wybiera native; MMPP może zostać wybrane tylko dla kompletnego zestawu produktów, którego native nie obsługuje. Po zapisaniu resolved engine awaria nie uruchamia drugiego producenta. Source backend/device, analysis engine i compute device postprocessingu muszą pozostać trzema osobnymi osiami provenance.

## 18. Macierz bieżącej gotowości

| Element | FDM CPU | FDM GPU | FEM CPU | FEM GPU |
|---|---|---|---|---|
| LLG | source/executable paths | native CUDA paths | native FEM paths | native GPU paths |
| Regional drive | implementacja reference | planner `unsupported` | plan/runtime paths | parity `NOT VERIFIED` |
| Exact-time field series | `NOT VERIFIED` end-to-end | `NOT VERIFIED` | custom path dla finite-k | `NOT VERIFIED` |
| Γ FFT | istniejący runner | blokowane przez drive | możliwe | `NOT VERIFIED` |
| Spatial FFT | brak kanonicznej ścieżki | brak | wąskie x/t tet4 | brak potwierdzenia |
| Response fields | brak | brak | brak ogólnego produktu | brak |
| Zarr/HDF5 parity | brak kontraktu | brak | brak kontraktu | brak |
| Browser proof | `NOT VERIFIED` | `NOT VERIFIED` | `NOT VERIFIED` | `NOT VERIFIED` |

Tabela nie jest capability registry. Jest wynikiem tego audytu i nie może automatycznie promować lane'u.

## 19. Najważniejsze przyczyny, nie symptomy

### P0-1: Brak kanonicznego source artifact

Bez jednoznacznego `m(t,r)` każdy backend i analizator interpretuje sampling i layout osobno.

### P0-2: Brak typed analysis product

Runtime metadata nie zapewnia round-trip, capability validation, historycznych zasobów ani deterministycznego cache key.

### P0-3: Zegar solvera miesza się z zegarem obserwacji

Accepted steps nie są automatycznie równomiernymi próbkami FFT.

### P0-4: Brak stabilnego pola odpowiedzi

Nie istnieje spójne przejście peak → complex spatial field → binary API → 3D.

### P0-5: Lane'y są asymetryczne

FDM GPU nie posiada regional drive, FEM finite-k jest wąski, mixed topology nie jest obsłużone.

### P0-6: Brak historycznej identity w API

UI nie może wiarygodnie analizować poprzedniego runu.

### P0-7: MMPP i Fullmag nie współdzielą schematu

Wspólne użycie Zarr nie oznacza interoperacyjności.

## 20. Ryzyka produkcyjne

| Ryzyko | Skutek | Wymagana kontrola |
|---|---|---|
| aliasing | fałszywe piki | planner Nyquist gate |
| leakage | przesunięte amplitudy | jawne window/coherent gain/ENBW |
| adaptive nonuniform time | błędna FFT | exact-time artifact lub jawny resampling |
| FE implicit reshape | błędne pole | carrier descriptor i projection operator |
| phase convention drift | odwrócona faza/znak | bundle-wide validator |
| whole-array RAM | OOM | bounded chunk streaming |
| GPU hidden fallback | fałszywa kwalifikacja | requested/resolved receipt i forced device |
| partial-as-ready | fałszywy wynik | atomic publish i status enum |
| stale run projection | niewłaściwe UI | run-scoped resources |
| MMPP ABI failure | awaria procesu | isolated worker i handshake |
| Zarr/HDF5 divergence | różne wyniki | logical parity tests |
| UI lifecycle leak | WebGL/context loss | active-only surface i browser stress |

## 21. Istniejące recepty wymagające późniejszego użycia

Audyt nie uruchamiał poniższych recept; ich status w tym dokumencie to `NOT RUN`:

```text
just verify-fem-time-domain-native-contract
just verify-fem-llg-time-domain-qualification
just verify-fem-llg-time-domain-qualification-gpu
just verify-fem-llg-time-domain-qualification-production
just verify-fem-regional-field-drive-contract
just verify-fem-regional-field-drive-rk-time-convergence
just verify-fem-regional-field-drive-cpu-gpu-parity-runtime
just verify-fem-periodic-antidot-gamma-pulse-runtime
just verify-fem-antidot-waveguide-finite-k-runtime
just verify-fdm-time-domain-native-contract
just verify-fem-frequency-response-runtime
just verify-fem-frequency-domain-eigen-runtime
```

Każda recepta wymaga sprawdzenia zakresu przed użyciem jako dowód nowego produktu. Nazwa z `time-domain` nie gwarantuje pokrycia artefaktów, MMPP, API ani UI.

## 22. Minimalne oracles do zamknięcia luk

1. pojedyncza sinusoida o dokładnym binie;
2. sinusoida między binami dla leakage/window;
3. dwie bliskie częstotliwości;
4. tłumiona precesja z analityczną częstotliwością;
5. Kittel Γ;
6. traveling wave z zadanym `k`;
7. zero drive;
8. source below susceptibility floor;
9. nonuniform accepted steps z exact output grid;
10. corrupted chunk;
11. topology hash mismatch;
12. phase convention mismatch;
13. FDM/FEM shared physical case;
14. CPU/GPU double parity;
15. native/MMPP parity;
16. Zarr/HDF5 logical parity;
17. historical run UI;
18. live peak → response field → WebGL.

## 23. Bramki rekomendowane przez audyt

### G0 — dokumenty i identity

- jedna hierarchia źródeł;
- source hash;
- scope ID;
- capability registry bez sprzecznych checkboxów.

### G1 — physics/IR

- równania i SI;
- phase convention;
- Python round-trip;
- typed analysis IR;
- fail-closed validation.

### G2 — sampling artifact

- solver/output clocks;
- exact-time samples;
- chunked writer;
- checksums;
- no silent resampling.

### G3 — native CPU oracle

- synthetic FFT;
- FDM CPU;
- FEM CPU;
- convergence;
- immutable artifacts.

### G4 — GPU

- regional drive;
- forced device;
- double parity;
- residency receipt;
- no hot-loop fallback.

### G5 — MMPP/storage

- adapter contract;
- worker handshake;
- parity;
- Zarr/HDF5 equivalence;
- bounded memory.

### G6 — API

- run-scoped resources;
- binary data-plane;
- revisions/ETags;
- consistent 404;
- progress/cancel/export.

### G7 — UI

- authoring pipeline;
- derived sampling metrics;
- spectrum/peaks/fields/DSF;
- historical runs;
- accessibility;
- browser/WebGL.

### G8 — production candidate

- ten sam commit/source identity;
- managed/container runtime receipt;
- artifact validator;
- API projection;
- UI projection;
- immutable evidence bundle.

## 24. Werdykt końcowy

Repozytorium posiada wystarczająco dużo elementów, aby budować rozwiązanie przez rozszerzenie istniejącej architektury, a nie przez osobny prototyp. Nie wolno jednak uznać bieżącego Γ FFT ani FEM finite-k za pełny produkt time-domain spectroscopy.

Rekomendowany kierunek:

1. zdefiniować canonical time-series i typed analysis IR;
2. zbudować natywny CPU baseline;
3. podłączyć existing Γ/finite-k jako compatibility adapters;
4. zapewnić run-scoped resource family i reuse istniejącego Analysis/3D overlay;
5. dołączyć MMPP przez adapter/worker;
6. kwalifikować lane'y i UI oddzielnymi dowodami;
7. promować wyłącznie spójny immutable candidate.

Do czasu przejścia wszystkich wymaganych bramek status pełnego workflow pozostaje:

```text
NOT PRODUCTION QUALIFIED
```
