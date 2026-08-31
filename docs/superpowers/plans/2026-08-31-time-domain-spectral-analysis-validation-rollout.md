# Time-Domain Spectral Analysis Validation Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Zbudować odtwarzalny rollout analizy spektralnej dynamiki czasowej z modelem status/capability/evidence, oraklami analitycznymi i manufactured, zbieżnością czasu/siatki, parity FDM/FEM CPU/GPU, parity MMPP, parity Zarr/HDF5, failure injection, limitami zasobów, browser/WebGL oraz zarządzanymi receipts.

**Architecture:** Fizyka czasowego LLG, źródła RegionalFieldDrive i SolvedAntennaDrive, sampling, modal_eigen i driven_response pozostają osobnymi kontraktami. Immutable scope identity wiąże ProblemIR, execution, mesh, runtime, artifact, API i browser evidence. CPU reference jest oracle, GPU ma jawną ścieżkę parity, a Control Room konsumuje te same artefakty przez OpenAPI v2 i resource hooks.

**Tech Stack:** Python DSL/unittest, Rust fullmag-ir/fullmag-plan/fullmag-runner/fullmag-api, native FEM/MFEM przez container-backed just, FDM CPU/CUDA, JSON/CSV, Zarr/HDF5, OpenAPI v2, Next.js 16, React, ECharts, Three.js/R3F, Playwright i CI contract/documentation gates.

## Global Constraints

- Raporty, plany, audyty i statusy są po polsku; symbole, nazwy zmiennych i kod pozostają po angielsku.
- Hierarchia prawdy to docs/physics, następnie docs/specs i docs/adr, potem Python DSL, ProblemIR, planner, runtime i UI.
- Native FEM/MFEM/CUDA/hypre/libCEED buduje i uruchamia wyłącznie właściwy container-backed recipe just.
- Żądanie GPU nie może być cicho zredukowane do CPU; fallback jest unavailable/degraded i nie promuje artefaktu.
- modal_eigen, driven_response, Gamma i finite-k mają oddzielne statusy, produkty, artefakty i acceptance scope.
- RegionalFieldDrive i SolvedAntennaDrive są odrębnymi source families; preview H_ant nie dowodzi użycia w RHS LLG.
- `auto|native|mmpp` jest rozwiązywane przed wykonaniem i zapisuje requested/resolved/reason/capability snapshot. Jawne `native` lub `mmpp` fail-closed; awaria resolved engine nie uruchamia fallbacku ani nie dzieli produktów między producentów.
- Każdy RK substage ocenia waveform w t_n + c_i dt; event boundaries i atomic attempt/rollback/commit są obowiązkowe.
- FFT przyjmuje wyłącznie równomierny actual sample axis; nieregularny axis bez jawnego resamplingu kończy analizę błędem i pozostawia `validation_state=unvalidated`.
- JSON jest control plane, duże tablice są w Zarr data plane, a HDF5 ma identyczną logical resource identity.
- Frontend korzysta z generated OpenAPI, ControlRoomApi i resource hooks; brak direct fetch() w modułach.
- Klasy CSS w apps/control-room mają prefiks fm-, globals.css jest import-only, a viewport wymaga browser/WebGL proof.
- Każdy claim wskazuje source hash, recipe, device, precision, mesh/airbox identity, artifact root, validator output i scope_id.
- Ochronny preflight używa początkowych sufitów 1 000 000 próbek, 4 GiB data-plane i 900 s na managed variant; są to bezpieczniki przed niekontrolowaną alokacją, nie budżety kwalifikacji wydajności. Task 12 wyznacza i wersjonuje budżety produkcyjne na podstawie zmierzonego baseline; odmowa przekroczenia aktywnego sufitu następuje przed alokacją.
- Plan nie autoryzuje commit, push, merge ani usuwania; przyszły wykonawca potrzebuje osobnej zgody na te operacje.
- Brak dowodu to not_evaluated; source-level test, static JSON i UI checkbox nie są validation.

## 1. Zakres i mapa odpowiedzialności

Plan obejmuje wiele subsystemów, lecz każde zadanie ma osobny owning layer, failing test, dokładną komendę i niezależny wynik. Implementacja może być dzielona na osobne branche, ale nie może scalać statusów z różnych scope.

### 1.1. Słownik statusów

~~~text
implementation_state = absent | contract_only | source_visible | executable
validation_state = unvalidated | algebra_validated | physics_validated | production_qualified
product_status = unsupported | semantic_only | reference_executable |
                 partial_production_executable | production_executable
evidence_state = not_evaluated | observed | reproducible | immutable
validated_scope = null albo readiness_scope_binding.v1
execution_status = planned | queued | running | succeeded | failed | cancelled | unsupported
artifact_status = missing | incomplete | ready | invalid
~~~

Promotion wymaga implementation_state=executable, execution_status=succeeded, artifact_status=ready, validation_state=production_qualified, evidence_state=immutable, niepustego scope_id oraz pustego production_blockers. `succeeded` bez `ready` jest nielegalne; `failed`/`cancelled` dopuszcza wyłącznie `missing` lub `incomplete`, a `unsupported` wyłącznie `missing`.

### 1.2. Kanoniczne wejścia

| Ścieżka | Stabilna kotwica | Właściciel |
|---|---|---|
| docs/physics/0960-canonical-llg-time-domain-solver-and-qualification-contract.md | LLG-TD-POLICY-V1, LLG-TD-ATTEMPT-V1, LLG-TD-ATOMIC-V1 | równanie Gilberta, fixed/adaptive i rollback |
| docs/physics/0920-regional-time-domain-field-drive.md | RegionalFieldDrive, H_drive, B_drive, E_drive, eden_drive | źródło regionalne, projekcja i stage clock |
| docs/physics/0910-table-autosave-observables.md | tableautosave, autosave, FFT output | output cadence i obserwable |
| docs/physics/0950-quasistatic-microwave-antenna-field-basis-and-k-selective-excitation.md | AntennaFieldSolve, SolvedAntennaDrive, H_ant_basis | proponowany Tier 1 antenna |
| docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md | L, B_alpha, A_omega=+i omega B_alpha-L, lambda=i omega, b | dynamic pencil i jednostki |
| docs/specs/frequency-domain-artifacts-v2.md | frequency_domain/manifest.v1.json, eigen/spectrum.v2.json, vector_xyz_complex | artifacts i Zarr |
| docs/specs/resource-first-control-room-api-v2.md | ControlRoomApi, data/fields, analysis resources | ownership, revision, ETag i 404 |
| docs/specs/capability-matrix-v0.json | implementation_state, validation_state, validated_scope | machine authority |
| docs/architecture/backend-golden-masterplan.md | sections 7.1–7.4, 11, 15 | backend ownership i evidence ladder |
| docs/adr/0019-regional-field-drive-and-stage-time-semantics.md | decisions 1–11 | accepted regional-drive boundary |
| docs/audits/2026-07-16-llg-time-domain-solver-audit.md | LLG-TD-API-001..LLG-TD-OBS-010 | known solver/time/demag findings |
| docs/audits/2026-08-29-fem-k0-eigensolve-plan-realization-audit-and-remaining-implementation-plan.md | R0–R9, Q1–Q3 | current NO-GO baseline |

### 1.3. Pliki dotykane w przyszłej implementacji

| Warstwa | Pliki | Odpowiedzialność |
|---|---|---|
| evidence | crates/fullmag-runner/src/analysis_evidence.rs, crates/fullmag-runner/tests/analysis_evidence.rs | envelope, scope hash, blockers |
| oracles | scripts/validate_time_domain_oracles.py, scripts/test_validate_time_domain_oracles.py | analytic, manufactured, FFT |
| convergence | scripts/validate_time_domain_convergence.py, scripts/test_validate_time_domain_convergence.py | dt/mesh/order/energy |
| parity | scripts/validate_time_domain_backend_parity.py, scripts/test_validate_time_domain_backend_parity.py | FDM/FEM CPU/GPU |
| MMPP | scripts/validate_mmpp_spectral_parity.py, scripts/test_validate_mmpp_spectral_parity.py | independent spectral consumer |
| storage | scripts/validate_time_domain_storage_parity.py, scripts/test_validate_time_domain_storage_parity.py | Zarr/HDF5 |
| failure/security | scripts/validate_time_domain_failure_injection.py, scripts/test_validate_time_domain_failure_injection.py | fail-closed and limits |
| managed | justfile, scripts/verify_time_domain_spectral_analysis_receipt.py | receipts and composition |
| API | crates/fullmag-api/src/router_v2/handlers/analysis/time_domain_spectral_analysis.rs, crates/fullmag-api/src/router_v2/tests.rs | read-only deliverable właściciela API/UI; ten plan kwalifikuje resources i diagnostics |
| frontend | apps/control-room/src/modules/analysis-plots/timeDomainAnalysisModel.ts, TimeDomainAnalysisView.tsx | chart, inspector and overlay |
| browser | apps/control-room/scripts/smoke-time-domain-analysis.mjs | API/chart/WebGL proof |
| registry | docs/validation/time-domain-spectral-analysis-v1-scope.yaml | immutable scopes |

---

## 2. Evidence i capability

### Task 1: AnalysisEvidenceV1

**Files:**

- Create: crates/fullmag-runner/src/analysis_evidence.rs
- Test: crates/fullmag-runner/tests/analysis_evidence.rs
- Modify: crates/fullmag-runner/src/lib.rs
- Create: docs/validation/time-domain-spectral-analysis-v1-scope.yaml
- Modify: docs/specs/capability-matrix-v0.json

**Interfaces:**
- Consumes: source snapshot, ProblemIR digest, execution plan, mesh/airbox identity, recipe and validator outputs.
- Produces: AnalysisEvidenceV1 with evidence_schema, scope_id, study_product, source_snapshot_sha256, recipe_id, requested_execution, resolved_execution, device, precision, artifact_root, validator_results, production_blockers i evidence_state.
- [ ] Step 1: Napisz failing Rust test tworzący dwa records z innym mesh_identity i wymagający różnych scope_id oraz evidence_state=not_evaluated.
- [ ] Step 2: Uruchom:

~~~text
cargo test -p fullmag-runner --test analysis_evidence evidence_scope_id_changes_when_mesh_or_recipe_changes
~~~

Expected: FAIL, ponieważ typ i digest nie istnieją.
- [ ] Step 3: Zaimplementuj sorted-key canonical JSON, digest exact UTF-8 pól study_product/source hash/recipe/mesh/device/precision/scope oraz rejection pustej identity.
- [ ] Step 4: Dodaj registry scopes gamma_macrospin, gamma_periodic_antidot, finite_k_waveguide, modal_k0 i driven_response_k0. Nowy rekord ma runtime_revalidated_in_this_update=false.
- [ ] Step 5: Uruchom:

~~~text
cargo test -p fullmag-runner --test analysis_evidence
python3 -m json.tool docs/specs/capability-matrix-v0.json
~~~

Expected: Rust PASS, JSON exit 0, niezależne implementation/validation axes zachowane.
### Task 2: Promotion predicate

**Files:**

- Modify after Task 1 Create: crates/fullmag-runner/src/analysis_evidence.rs
- Test: crates/fullmag-runner/tests/analysis_evidence.rs

**Interfaces:**
- Consumes: AnalysisEvidenceV1.
- Produces: promotable(scope: &AnalysisEvidenceV1) -> Result<(), Vec<ProductionBlocker>> z kodami EVIDENCE-001..EVIDENCE-008.
- [ ] Step 1: Dodaj failing tests dla missing source hash, CPU/GPU mismatch, validation_fallback_used=true, nonuniform sampling, stale revision, missing browser receipt, missing managed receipt i scope mismatch.
- [ ] Step 2: Uruchom:

~~~text
cargo test -p fullmag-runner --test analysis_evidence evidence_ -- --nocapture
~~~

Expected: wszystkie nowe przypadki FAIL przed predicate.
- [ ] Step 3: Implementuj kolejność blockers: identity, execution, physics, sampling, artifact, storage, API, browser. Każdy blocker ma path, observed, required i evidence_class.
- [ ] Step 4: Brak receipt ustawia not_evaluated, nigdy validated; partial_production_executable nie przechodzi promotion.
- [ ] Step 5: Powtórz testy.

Expected: poprawny envelope PASS, a każdy negatywny przypadek ma deterministyczny NO-GO.
---

## 3. Orakle analityczne i FFT

### Task 3: Larmor, exchange i manufactured forcing

**Files:**

- Create: scripts/validate_time_domain_oracles.py
- Test: scripts/test_validate_time_domain_oracles.py
- Create: tests/fixtures/time_domain_oracles/macrospin_larmor.json
- Create: tests/fixtures/time_domain_oracles/exchange_dispersion.json
- Create: tests/fixtures/time_domain_oracles/manufactured_transverse_drive.json

**Interfaces:**
- Consumes: trace, SI material constants, m_exact(t), H_drive(t), alpha, gamma0 i fixture declaration.
- Produces: OracleResultV1 oraz ManufacturedOracleReportV1 z status, metrics, tolerance i failures.
- [ ] Step 1: Napisz failing tests dla f=gamma0*abs(H0)/(2*pi) i f(k)=gamma0*(abs(H0)+2*A*abs(k)^2/(mu0*Ms))/(2*pi).
- [ ] Step 2: Uruchom:

~~~text
python3 -m unittest scripts.test_validate_time_domain_oracles -v
~~~

Expected: FAIL przed funkcjami i fixture.
- [ ] Step 3: Zaimplementuj validate_macrospin_larmor(), validate_exchange_dispersion() oraz manufactured trajectory L2 z jawnymi units i odrzuceniem nonfinite.
- [ ] Step 4: Dla m_exact(t)=(sin(theta)cos(omega t), sin(theta)sin(omega t), cos(theta)) sprawdzaj RHS residual, norm defect przed projection i dE/dt<=0 dla damped autonomous run.
- [ ] Step 5: Dodaj negative tests dla phase/sign inversion, skipped RK substage, 1% frequency error, energy increase >1e-12 i reciprocal +k/-k drift.

Expected: valid fixture PASS; każdy injected defect exit 1 z nazwanym metric.
### Task 4: SamplingReceiptV1

**Files:**

- Modify after Task 3 Create: scripts/validate_time_domain_oracles.py
- Modify after Task 3 Create: scripts/test_validate_time_domain_oracles.py
- Modify: docs/physics/0920-regional-time-domain-field-drive.md

**Interfaces:**
- Consumes: actual sample times, waveform metadata, zero-amplitude trace i requested analysis window.
- Produces: SamplingReceiptV1 z N, dt, T, df, Nyquist, cutoff, uniform i fft_status.
- [ ] Step 1: Dodaj failing tests dla uniform axis, missing sample, duplicate time, cutoff > Nyquist i source/response confusion.
- [ ] Step 2: Uruchom:

~~~text
python3 -m unittest scripts.test_validate_time_domain_oracles Sampling* -v
~~~

Expected: FAIL przed receipt.
- [ ] Step 3: Zaimplementuj derive_sampling_receipt() z max delta-dt <=1e-12*max(dt,1). Violation daje execution_status=failed, artifact_status=incomplete lub missing, validation_state=unvalidated i exit 1.
- [ ] Step 4: Zaimplementuj zero-baseline source subtraction i Hann normalization; actual artifact axis ma pierwszeństwo przed planem.
- [ ] Step 5: Powtórz cały plik unittest.

Expected: tylko równy axis tworzy valid FFT; irregular axis nie tworzy wykresu ani sukcesu.
---

## 4. Zbieżność czasu i siatki

### Task 5: ConvergenceReportV1

**Files:**

- Create: scripts/validate_time_domain_convergence.py
- Test: scripts/test_validate_time_domain_convergence.py
- Create: tests/fixtures/time_domain_convergence/fixture_manifest.json

**Interfaces:**
- Consumes: co najmniej trzy dt levels i dwa mesh levels z identycznym physics/source identity.
- Produces: ConvergenceReportV1 z dt/mesh sequences, observed order, peak/PSD/energy metrics i status.
- [ ] Step 1: Napisz failing tests dla braku dt/2, różnych source hash, nonmonotone dt i jednego mesh level.
- [ ] Step 2: Uruchom:

~~~text
python3 -m unittest scripts.test_validate_time_domain_convergence -v
~~~

Expected: FAIL przed parserem.
- [ ] Step 3: Wymuś dt_0 > dt_1 > dt_2, ratio 2±1e-12, wspólny duration/source/phase convention i jawny mesh refinement identity.
- [ ] Step 4: Oblicz p=log2(error_dt/error_dt2); wymagaj p>=1.5 dla RK2 i p>=3.0 dla RK4/RK45 manufactured.
- [ ] Step 5: Dla Gamma wymagaj peak change <=0.5%, normalized PSD L2 <=5% i monotonic energy decrease w damped baseline.

Expected: valid fixture PASS, a malformed level daje jeden stabilny CONV code.
### Task 6: Gamma production fixture

**Files:**

- Create: examples/fem_periodic_antidot_time_domain_gamma.py
- Create: scripts/validate_fem_periodic_antidot_gamma_spectrum.py
- Test: scripts/test_validate_fem_periodic_antidot_gamma_spectrum.py
- Modify: justfile

**Interfaces:**
- Consumes: RegionalFieldDrive sinc, relaxed m0, exact cadence oraz baseline/half-dt/refined/double-amplitude/zero-amplitude runs.
- Produces: analysis/spin_wave_response.gamma.v1.json, convergence.v1.json i receipt.v1.json.
- [ ] Step 1: Napisz failing test wymagający pięciu wariantów i zero-amplitude subtraction.
- [ ] Step 2: Uruchom:

~~~text
python3 -m unittest scripts.test_validate_fem_periodic_antidot_gamma_spectrum -v
~~~

Expected: FAIL bez parsera i fixtures.
- [ ] Step 3: Zbuduj flat module-level study z kolejnością add_minimize, add_field_drive, tableautosave, autosave, fft_response, add_run.
- [ ] Step 4: Dodaj verify-fem-periodic-antidot-gamma-pulse-runtime przez managed FEM; po każdym runie sprawdź manifest, actual axis, source/response i immutable root.
- [ ] Step 5: Uruchom recipe oraz validator.

Expected: PASS tylko dla peak <=0.5%, PSD L2 <=5%, uniform samples i poprawnego zero baseline.
---

## 5. FDM/FEM CPU/GPU parity

### Task 7: BackendParityReportV1

**Files:**

- Create: scripts/validate_time_domain_backend_parity.py
- Test: scripts/test_validate_time_domain_backend_parity.py
- Create: scripts/validate_fdm_fem_cpu_parity.py
- Test: scripts/test_validate_fdm_fem_cpu_parity.py
- Modify: docs/specs/capability-matrix-v0.json

**Interfaces:**
- Consumes: immutable FDM/FEM artifacts z identycznym physics/source scope, cadence, precision i declared discretization.
- Produces: BackendParityReportV1 dla trajectory, H_drive, energy, peak, PSD oraz lane.
- [ ] Step 1: Napisz failing tests dla source/mesh/precision/time-axis mismatch i braku FDM cell-average/FEM P1 projection metadata.
- [ ] Step 2: Uruchom:

~~~text
python3 -m unittest scripts.test_validate_time_domain_backend_parity scripts.test_validate_fdm_fem_cpu_parity -v
~~~

Expected: FAIL przed parserem.
- [ ] Step 3: Ustal FP64 thresholds: manufactured trajectory relative L2 <=1e-8, H_drive max relative <=1e-10, energy <=1e-8, Gamma peak <=0.5%, normalized PSD L2 <=5%.
- [ ] Step 4: Odrzuć validation_fallback_used=true oraz gpu_device_krylov, jeśli Krylov/dot/norm/axpy są host-resident.
- [ ] Step 5: Dodaj negative fixtures i wymagaj metric, tolerance oraz artifact path w każdym błędzie.

Expected: valid pair PASS, sześć niezgodności NO-GO.
### Task 8: CPU oracle and GPU residency

**Files:**

- Modify: crates/fullmag-runner/src/native_fem.rs
- Modify: backends/fem/gpu/cuda/integrators/rk/rk_adaptive_runtime.cu
- Create: scripts/validate_fem_time_domain_gpu_parity.py
- Test: scripts/test_validate_fem_time_domain_gpu_parity.py
- Modify: justfile

**Interfaces:**
- Consumes: CPU oracle receipt, GPU receipt, CUDA device identity, profiler telemetry i parity report.
- Produces: gpu_time_domain_parity.v1.json z requested/resolved lane, residency, fallback flag i metrics.
- [ ] Step 1: Napisz failing tests dla CPU resolved under GPU request, missing CUDA receipt, host payload labelled device-resident oraz out-of-tolerance parity.
- [ ] Step 2: Uruchom:

~~~text
python3 -m unittest scripts.test_validate_fem_time_domain_gpu_parity -v
~~~

Expected: FAIL z nazwanym residency blockerem.
- [ ] Step 3: Zmień tylko propagację requested/resolved i istniejący GPU attempt receipt; wspólna fizyka pozostaje w owning backend, bez physics w mfem_bridge.cpp.
- [ ] Step 4: Dodaj recipes verify-fem-time-domain-spectral-analysis-cpu-oracle i verify-fem-time-domain-spectral-analysis-gpu-parity. GPU recipe wywołuje verify-fem-time-domain-native-contract i verify-fem-regional-field-drive-contract.
- [ ] Step 5: Uruchom oba recipes na canonical fixture.

Expected: GPU promotion tylko z resolved_execution_lane=production_gpu, fallback=false, finite fields/residuals, profiler i parity PASS.
---

## 6. MMPP parity i storage

### Task 9: MMPP spectral adapter

**Files:**

- Create: scripts/validate_mmpp_spectral_parity.py
- Test: scripts/test_validate_mmpp_spectral_parity.py
- Create: tests/fixtures/mmpp_spectral_parity/mmpp_export.v1.json
- Create: tests/fixtures/mmpp_spectral_parity/fullmag_export.v1.json
- Modify: justfile
- Modify after master-plan Task 1 Create: docs/validation/time-domain-spectral-analysis-v1-scope.yaml

**Interfaces:**
- Consumes: MMPP fields frequency_hz, k_rad_per_m, spectrum_amplitude, legacy mode_id, phase_convention, units oraz Fullmag spectrum/finite-k artifact. Adapter mapuje legacy mode_id wyłącznie na peak_id/adapter metadata i nie nadaje mu semantyki eigenmode.
- Produces: MMPPParityReportV1 z axis error, peak error, branch overlap i normalization status.
- [ ] Step 1: Napisz failing tests dla missing units, phase sign mismatch, unsorted k, innego detrend/window, delta_m versus delta_M, explicit mmpp bez workera, explicit native bez capability, deterministycznego auto resolution i awarii po resolution bez fallbacku.
- [ ] Step 2: Uruchom:

~~~text
python3 -m unittest scripts.test_validate_mmpp_spectral_parity -v
~~~

Expected: FAIL przed adapterem.
- [ ] Step 3: Konwertuj tylko jawnie zadane SI units; Gamma peak <=0.5%, finite-k peak w jednym declared bin, spectrum L2 <=5%.
- [ ] Step 4: Porównuj source_spectrum i response_spectrum osobno; MMPP jest niezależnym producentem postprocessingu, nie backendem dynamiki Fullmag. Receipt zachowuje source execution, analysis engine i analysis execution jako trzy różne osie.
- [ ] Step 5: Dodaj verify-time-domain-mmpp-parity z exporter version, input SHA i report SHA.

Expected: valid pair PASS; zmiana phase/axis/window/normalization exit 1; explicit MMPP bez workera oraz awaria resolved MMPP kończą się typowanym błędem bez native output.
### Task 10: Zarr/HDF5 logical parity

**Files:**

- Create: scripts/validate_time_domain_storage_parity.py
- Test: scripts/test_validate_time_domain_storage_parity.py
- Modify: docs/specs/frequency-domain-artifacts-v2.md
- Modify after Task 1 Create: crates/fullmag-runner/src/analysis_evidence.rs

**Interfaces:**
- Consumes: Zarr group or HDF5 file and logical manifest.
- Produces: StorageParityReportV1 oraz storage_receipt.v1.json.
- [ ] Step 1: Napisz failing tests dla missing time/samples, transposed [component,node,complex], float32 bez qualified precision, chunk mutation, vector.bin jako authority i HDF5 external link.
- [ ] Step 2: Uruchom:

~~~text
python3 -m unittest scripts.test_validate_time_domain_storage_parity -v
~~~

Expected: FAIL przed readerami.
- [ ] Step 3: Zdefiniuj root `/analysis/time_domain_spectral/{analysis_id}` oraz logical paths `time_series/time_s`, `time_series/magnetization`, opcjonalne `time_series/drive_field`, `spectra/frequency_hz`, `spectra/source_complex`, `spectra/response_complex`, `response_fields/{peak_id}/vector_xyz_complex` i `dynamic_structure_factor/power`.
- [ ] Step 4: Porównuj per-array shapes: magnetization/drive `[time,carrier,component]`, spectra complex `[frequency,observable,complex]`, response field `[carrier,component,complex]` i DSF zgodnie z zadeklarowanymi osiami. Porównuj dtype, labels, units, canonical little-endian element bytes i SHA-256 niezależnie od chunking.
- [ ] Step 5: HDF5 działa wyłącznie jako storage_format=hdf5_compat_v1 i publikuje ten sam resource key.

Expected: equivalent stores PASS, każda zmiana daje STORAGE code i exit 1.
---

## 7. Failure injection, security i budżety

### Task 11: Fail-closed injection

**Files:**

- Create: scripts/validate_time_domain_failure_injection.py
- Test: scripts/test_validate_time_domain_failure_injection.py
- Modify: crates/fullmag-runner/src/native_fem.rs
- Modify: crates/fullmag-api/src/router_v2/tests.rs

**Interfaces:**
- Consumes: test-only FULLMAG_TEST_FAILURE_INJECTION values demag_nonconvergence, missing_field, nonuniform_sampling, gpu_cpu_resolution, corrupt_manifest, device_context_loss.
- Produces: failure receipt z injection, stage, blocker i no promoted artifact; API codes SEC-001..SEC-006.
- [ ] Step 1: Napisz failing tests, że każda injection kończy się nonzero, no production_qualified i no success curve.
- [ ] Step 2: Uruchom:

~~~text
python3 -m unittest scripts.test_validate_time_domain_failure_injection -v
~~~

Expected: FAIL bez dispatcher.
- [ ] Step 3: Włącz dispatcher tylko za test-only guard; spoza sześciu nazw i zmienna w production mode są odrzucane.
- [ ] Step 4: Sprawdź atomicity: demag/field failure nie commitują dalszego sample, corrupt manifest nie jest serwowany, context loss daje unavailable bez CPU fallback.
- [ ] Step 5: Dodaj path attacks: .., absolute escape, symlink escape, malformed JSON, manifest >16 MiB i HDF5 external link.

Expected: wszystkie injection/security cases fail closed; normal run bez zmiennej pozostaje niezmieniony.
### Task 12: Planner resource budget

**Files:**

- Modify: packages/fullmag-py/src/fullmag/model/dynamics.py
- Modify: crates/fullmag-plan/src/fem.rs
- Modify: crates/fullmag-plan/src/fdm.rs
- Test: packages/fullmag-py/tests/test_time_domain_budget_contract.py
- Test: crates/fullmag-plan/tests/time_domain_budget.rs

**Interfaces:**
- Consumes: duration, cadence, fields, components, dtype i ResourceBudgetV1.
- Produces: estimated_samples, estimated_bytes, max_runtime_s i stable rejection reason.
- [ ] Step 1: Napisz failing tests dla 1 000 000, 1 000 001, 4 GiB, zero cadence i negative cadence.
- [ ] Step 2: Uruchom:

~~~text
PYTHONPATH=packages/fullmag-py/src python3 -m unittest packages/fullmag-py/tests/test_time_domain_budget_contract.py -v
cargo test -p fullmag-plan --test time_domain_budget
~~~

Expected: FAIL przed IR/planner budget.
- [ ] Step 3: Dodaj defaults max_samples=1000000, max_data_plane_bytes=4294967296, max_runtime_s=900 i zachowaj requested auto z resolved estimate.
- [ ] Step 4: Odrzuć przed native execution i przed storage allocation; estimate uwzględnia każdy array.
- [ ] Step 5: Powtórz oba testy.

Expected: exact boundary PASS, overrun exit 1 i identyczny Python/Rust vocabulary.
---

## 8. Managed receipts

### Task 13: Receipt validator i recipe composition

**Files:**

- Create: scripts/verify_time_domain_spectral_analysis_receipt.py
- Test: scripts/test_verify_time_domain_spectral_analysis_receipt.py
- Modify: justfile
- Modify after master-plan Task 1 Create: docs/validation/time-domain-spectral-analysis-v1-scope.yaml

**Interfaces:**
- Consumes: recipe output, manifest, validator reports, source hash list i runtime metadata.
- Produces: managed_time_domain_spectral_analysis_receipt.v1.json.
- [ ] Step 1: Napisz failing tests dla missing command, wrong source hash, wrong recipe_id, missing device, fallback i incomplete artifact tree.
- [ ] Step 2: Uruchom:

~~~text
python3 -m unittest scripts.test_verify_time_domain_spectral_analysis_receipt -v
~~~

Expected: FAIL przed receipt parserem.

- [ ] Step 3: Wymuś command, UTC start/end, exit code, container identity, source_snapshot_sha256, recipe_id, device, precision, runtime lane, artifact root i validator results.
- [ ] Step 4: Dodaj recipes verify-fem-time-domain-spectral-analysis-contract, verify-fem-time-domain-spectral-analysis-cpu-oracle, verify-fem-time-domain-spectral-analysis-gpu-parity, verify-time-domain-mmpp-parity, verify-time-domain-storage-parity i verify-fem-time-domain-spectral-analysis-failure-injection.
- [ ] Step 5: Uruchom:

~~~text
just verify-fem-time-domain-spectral-analysis-contract
~~~

Expected: PASS receipt albo kompletny nonzero receipt; prerequisite nie może być pominięty.

### Task 14: Production composition

**Files:**

- Modify: justfile
- Modify after master-plan Task 1 Create: docs/validation/time-domain-spectral-analysis-v1-scope.yaml
- Test: scripts/test_verify_time_domain_spectral_analysis_receipt.py

**Interfaces:**
- Consumes: contract, CPU, GPU, MMPP, storage i browser receipts.
- Produces: immutable candidate receipt z ordered evidence references i promotion decision.
- [ ] Step 1: Napisz failing test, gdy receipt jest absent, stale albo ma inny source hash.
- [ ] Step 2: Uruchom composition test.

Expected: FAIL z pierwszym missing receipt.

- [ ] Step 3: Dodaj verify-fem-time-domain-spectral-analysis-production wywołujące verify-fem-time-domain-native-contract, verify-fem-regional-field-drive-contract, verify-fem-regional-field-drive-rk-time-convergence, verify-fem-regional-field-drive-cpu-gpu-parity-runtime i scoped validators.
- [ ] Step 4: Timeout ustawia not_evaluated; każdy output binduje jeden source hash i jeden fixture manifest.
- [ ] Step 5: Uruchom recipe wyłącznie na explicite wybranym, czystym candidate.

Expected: promotion=pass tylko dla status=immutable i pustych blockers; w innym przypadku promotion=no-go i exit 1.

---

## 9. OpenAPI v2

### Task 15: Niezależna kwalifikacja time-domain analysis resources

**Files:**

- Read-only deliverable owned by API/UI plan: crates/fullmag-api/src/router_v2/handlers/analysis/time_domain_spectral_analysis.rs
- Read-only focused router tests owned by API/UI plan: crates/fullmag-api/src/router_v2/tests.rs
- Read-only schema owned by API/UI plan: crates/fullmag-api/src/schemas/time_domain_spectral_analysis.rs
- Create: scripts/validate_time_domain_spectral_api_contract.py
- Create: scripts/test_validate_time_domain_spectral_api_contract.py
- Read-only contract: docs/specs/resource-first-control-room-api-v2.md

**Interfaces:**
- Consumes: immutable manifest i receipt.
- Produces:
~~~text
GET /v2/sessions/current/analysis/time-domain-spectral/{run_id}/{analysis_id}/manifest
GET /v2/sessions/current/analysis/time-domain-spectral/{run_id}/{analysis_id}/sampling
GET /v2/sessions/current/analysis/time-domain-spectral/{run_id}/{analysis_id}/time-series/{series_id}
GET /v2/sessions/current/analysis/time-domain-spectral/{run_id}/{analysis_id}/spectra/{spectrum_id}
GET /v2/sessions/current/analysis/time-domain-spectral/{run_id}/{analysis_id}/peaks
GET /v2/sessions/current/analysis/time-domain-spectral/{run_id}/{analysis_id}/response-fields/{field_id}
GET /v2/sessions/current/analysis/time-domain-spectral/{run_id}/{analysis_id}/dynamic-structure-factor
GET /v2/sessions/current/analysis/time-domain-spectral/{run_id}/{analysis_id}/diagnostics
~~~

`/v2/sessions/current/analysis/spin-wave-response/{run_id}/*` pozostaje wyłącznie read-only compatibility aliasem legacy. Test musi dowieść, że nowe runy publikują authority tylko pod `time-domain-spectral`, a historyczne `run_id` nie jest zastępowane przez `latest`.

- [ ] Step 1: Sprawdź, że deliverable API/UI istnieje i zawiera testy valid resource, optional artifact 404, stale revision 409, malformed manifest 422 i zakaz heavy payload inline. Brak pliku lub testu jest blokadą zależności, a nie pozwoleniem na implementowanie handlera w tym workstreamie.
- [ ] Step 2: Uruchom skupione testy właściciela API:

~~~text
cargo test -p fullmag-api time_domain_spectral -- --nocapture
~~~

Expected: PASS; FAIL wraca do właściciela API/UI i blokuje dalszą kwalifikację.

- [ ] Step 3: Napisz niezależny validator, który na zapisanych odpowiedziach sprawdza thin JSON z resource ID, run_id, analysis_id, source_stage_id, revision, source snapshot, sampling metadata, units, artifact links i trzema osiami statusu; tablice w JSON są błędem.
- [ ] Step 4: Dodaj przypadki Gamma/finite-k discriminator, single-owner mapping, websocket lifecycle/invalidation z analysis_id i source_stage_id oraz zakaz arrays.
- [ ] Step 5: Uruchom `python -m unittest scripts.test_validate_time_domain_spectral_api_contract -v`, następnie powtórz `cargo test -p fullmag-api time_domain_spectral -- --nocapture` i istniejący test generowania OpenAPI.

Expected: oba zestawy PASS dla zasobów; 404/409/422 są diagnostyczne i nie tworzą pustej krzywej sukcesu. Ten Task nie modyfikuje `crates/fullmag-api/**` ani dokumentu API.

---

## 10. Control Room i browser/WebGL

### Task 16: Typed analysis model and Inspector

**Files:**

- Create: apps/control-room/src/modules/analysis-plots/timeDomainAnalysisModel.ts
- Create: apps/control-room/src/modules/analysis-plots/TimeDomainAnalysisView.tsx
- Modify: apps/control-room/src/modules/analysis-plots/AnalysisPlotsView.tsx
- Modify: apps/control-room/src/modules/inspector/panels/stages/RunStageInspector.tsx
- Modify: apps/control-room/src/kernel/selection/selectionTypes.ts
- Test: apps/control-room/src/modules/analysis-plots/timeDomainAnalysisModel.test.ts
- Test: apps/control-room/src/modules/analysis-plots/TimeDomainAnalysisView.test.tsx

**Interfaces:**
- Consumes: generated API response, resource-hook state i canonical field IDs.
- Produces: TimeDomainTraceModel, TimeDomainSpectrumModel, FiniteKSpectrumModel, AnalysisStatusModel i selection {runId, analysisId, sampleIndex, peakId?}.
- [ ] Step 1: Napisz failing Vitest dla units, source/response distinction, execution/artifact/validation status crosswalk, peak selection i stable resource identity.
- [ ] Step 2: Uruchom:

~~~text
pnpm --dir apps/control-room exec vitest run src/modules/analysis-plots/timeDomainAnalysisModel.test.ts src/modules/analysis-plots/TimeDomainAnalysisView.test.tsx
~~~

Expected: FAIL przed adapterami i panelami.

- [ ] Step 3: Zaimplementuj typed adapters zachowujące N/dt/T/df/Nyquist/cutoff, serie time/source/response/PSD/finite-k i jednostki delta_m, delta_M, chi, m/A, W/m^3.
- [ ] Step 4: Każdy node ma własny Inspector; pending jest field/transaction scoped, root/scroll/focus są stabilne, brak opacity animation i lokalnej mutacji solvera.
- [ ] Step 5: Uruchom:

~~~text
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
~~~

Expected: typecheck, lint i focused tests PASS bez direct fetch() w zmienionych modułach.

### Task 17: Browser/WebGL receipt

**Files:**

- Create: apps/control-room/scripts/smoke-time-domain-analysis.mjs
- Test: apps/control-room/scripts/smoke-time-domain-analysis.test.mjs
- Modify: apps/control-room/package.json

**Interfaces:**
- Consumes: managed artifact/API fixture i browser URL.
- Produces: browser_time_domain_analysis_receipt.v1.json ze screenshot, revisions, contextLost i drawing-buffer dimensions.
- [ ] Step 1: Napisz failing Playwright assertions dla chart axes, source/response labels, unavailable block, canvas visibility, gl.isContextLost()=false i nonzero width/height.
- [ ] Step 2: Uruchom browser test against fixture server.

Expected: FAIL przed route, test IDs i WebGL projection.

- [ ] Step 3: Zaimplementuj flow receipt → Gamma → peak → source/response toggle → field overlay → screenshot → browser receipt.
- [ ] Step 4: Dodaj fixture-only context-loss injection; oczekiwany wynik to unavailable/degraded bez CPU fallback i bez success screenshot.
- [ ] Step 5: Uruchom smoke na realnym managed artefakcie i porównaj artifact identity API/Inspector/chart/overlay.

Expected: PASS tylko z nonzero drawing buffer i zachowanym WebGL context.

---

## 11. CI i macierz dowodów

### Task 18: Contract/documentation guard

**Files:**

- Create: scripts/validate_time_domain_plan_contract.py
- Test: scripts/test_validate_time_domain_plan_contract.py
- Modify: .github/workflows/contract-guard.yml
- Modify: .github/workflows/documentation.yml

**Interfaces:**
- Consumes: plan, physics/spec/ADR docs, capability JSON, OpenAPI, justfile i source references.
- Produces: report missing cross-links, stale status, fallback claims, recipe gaps, MMPP/storage/browser gaps.
- [ ] Step 1: Napisz failing tests dla production claim bez receipt, modal_eigen/driven_response conflation, starego 0600 ownership i braku storage parity.
- [ ] Step 2: Uruchom:

~~~text
python3 -m unittest scripts.test_validate_time_domain_plan_contract -v
~~~

Expected: FAIL przed rule setem.

- [ ] Step 3: Wymuś obecność LLG-TD-POLICY-V1, RegionalFieldDrive, frequency_domain/manifest.v1.json, scope_id, source hash, managed recipes, MMPP, storage i browser proof.
- [ ] Step 4: CI uruchamia lightweight docs/Python/OpenAPI checks; heavy managed recipes publikują receipts jako artifacts.
- [ ] Step 5: Powtórz unittest i YAML parser.

Expected: PASS dla spójnego planu, FAIL dla każdej injected stale/unsupported claim.

### Task 19: Verification matrix

**Files:**

- Modify after master-plan Task 1 Create: docs/validation/time-domain-spectral-analysis-v1-scope.yaml
- Modify after Task 18 Create: scripts/validate_time_domain_plan_contract.py

**Interfaces:**
- Consumes: all focused outputs.
- Produces: row per source, IR/planner, native, runtime, physics, artifact, API, browser, security i promotion gate.
- [ ] Step 1: Napisz failing test wymagający command, expected, observed, evidence path i status dla każdej klasy dowodu.
- [ ] Step 2: Uruchom:

~~~text
python3 -m unittest scripts.test_validate_time_domain_oracles -v
python3 -m unittest scripts.test_validate_time_domain_convergence -v
python3 -m unittest scripts.test_validate_time_domain_backend_parity -v
python3 -m unittest scripts.test_validate_mmpp_spectral_parity -v
python3 -m unittest scripts.test_validate_time_domain_storage_parity -v
python3 -m unittest scripts.test_validate_time_domain_failure_injection -v
cargo test -p fullmag-runner --test analysis_evidence
cargo test -p fullmag-plan --test time_domain_budget
cargo test -p fullmag-api router_v2::tests::time_domain
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
~~~

Expected: FAIL, jeżeli brakuje którejkolwiek klasy.

- [ ] Step 3: Oznacz nieuruchomione command jako not_evaluated; brak command nie staje się PASS.
- [ ] Step 4: Uruchom matrix validator po lightweight tests.

Expected: PASS dopiero po wszystkich lightweight results i nazwanych managed receipts dla heavy tests.

---

## 12. Fazy i zależności

### P0 — Freeze scope/evidence

Depends on: none. Wykonaj Tasks 1–2. Zamroź source hierarchy, registry, source/mesh/recipe identity i bieżący NO-GO z audytu 2026-08-29.

Review gate: brak pustej identity, duplicate owner i production claim bez immutable receipt.

### P1 — Physics/analytic truth

Depends on: P0. Wykonaj Tasks 3–4. Zamroź Gilbert signs, SI, phase convention, manufactured m_exact, source subtraction i SamplingReceiptV1.

Review gate: oracle wykrywa sign/unit/phase/energy/irregular-axis defect.

### P2 — Convergence/CPU oracle

Depends on: P1. Wykonaj Tasks 5–7. Zbuduj dt/mesh convergence i CPU/FDM/FEM double scope.

Review gate: Gamma peak <=0.5%, PSD L2 <=5%, order thresholds, zero-baseline subtraction i brak synthetic substitution.

### P3 — GPU parity

Depends on: P2. Wykonaj Task 8.

Review gate: resolved lane production_gpu, fallback false, named residency, profiler, finite fields/residuals i parity receipt.

### P4 — MMPP/storage

Depends on: P2. Wykonaj Tasks 9–10.

Review gate: MMPP i Zarr/HDF5 identycznie interpretują axis, units, normalization i resource identity.

### P5 — Failure/security/budget

Depends on: P0 i P2. Wykonaj Tasks 11–12.

Review gate: sześć injections, path attacks i budget overrun fail closed przed publication/allocation.

### P6 — Managed/API

Depends on: P2–P5. Wykonaj Tasks 13–15.

Review gate: jeden source hash/artifact identity od managed runtime do HTTP; 404/409/422 są testowane.

### P7 — UI/browser/CI

Depends on: P6. Wykonaj Tasks 16–19.

Review gate: browser czyta ten sam immutable candidate, WebGL context jest zachowany, CI blokuje niespójne statusy.

Dependency DAG:

~~~text
physics notes
  -> evidence/status schema
  -> Python/ProblemIR/planner
  -> analytic oracles
  -> CPU runtime
  -> GPU parity
  -> MMPP/storage
  -> OpenAPI/resources
  -> Control Room/browser
  -> immutable production candidate
~~~

---

## 13. Production promotion i NO-GO

### 13.1. Mandatory production tuple

~~~text
study_product
analysis_family
source_snapshot_sha256
problem_ir_digest
execution_plan_digest
mesh_identity
airbox_identity
requested_execution
resolved_execution
device
precision
phase_convention
waveform_digest
sampling_receipt
solver_attempt_receipt
artifact_manifest_digest
storage_receipt
mmpp_parity_receipt
browser_receipt
validator_receipts
scope_id
~~~

### 13.2. Automatic NO-GO

- missing/conflicting requested/resolved execution albo GPU resolved to CPU;
- validation_fallback_used=true, synthetic oracle jako production albo capability unsupported/source_visible/partial;
- modal_eigen i driven_response złączone w jeden wynik;
- source spectrum bez zero-amplitude subtraction;
- nonuniform samples zaakceptowane przez FFT;
- budget exceeded, preflight missing, path escape albo external HDF5 link;
- brak manifest, progress, diagnostics, demag/gauge/residual/pair metadata albo authoritative data-plane;
- Zarr/HDF5 shape, units, logical path albo checksum mismatch;
- MMPP phase/axis/normalization/peak mismatch;
- browser receipt z innym source/artifact identity, contextLost=true albo zero drawing buffer;
- dirty candidate zmieniony po receipt generation.

### 13.3. Promotion output

Run:

~~~text
just verify-fem-time-domain-spectral-analysis-production
~~~

Expected PASS:

~~~text
PROMOTION=PASS
study_product=gamma_periodic_antidot
scope_id=sha256:64-lowercase-hex
validation_state=production_qualified
evidence_state=immutable
production_blockers=[]
~~~

Expected NO-GO:

~~~text
PROMOTION=NO-GO
first_blocker=EVIDENCE-003
path=resolved_execution.resolved_execution_lane
required=production_gpu
observed=production_cpu
~~~

NO-GO musi mieć exit code 1. Timeout, partial artifact i unavailable nie mogą drukować PASS.

---

## 14. TDD i handoff

1. Każde zadanie zaczyna się failing testem i dokładną komendą z oczekiwanym failure.
2. Implementuj minimalną zmianę w owning layer; nie dodawaj FEM physics do runnera ani chart semantics do handlera.
3. Po green focused test uruchom najbliższy cross-layer test; source-level green nie zmienia validation status.
4. Native FEM poprzedź inspekcją justfile i uruchom właściwy container-backed recipe.
5. UI/viewport wymaga typecheck, lint, tests oraz screenshot/WebGL receipt.
6. Przed przyszłym commitem sprawdź staged/unstaged/untracked; ten plan nie wykonuje commitów.
7. Status matrix aktualizuj tylko razem z immutable receipt i scope hash.

### Reviewer acceptance checklist

- [ ] Physics notes, ADR, specs, capability JSON i plan używają tych samych units/product names.
- [ ] Python → ProblemIR → planner → native request → manifest → API zachowuje requested intent.
- [ ] FDM, FEM CPU i FEM GPU mają osobne receipts i scopes.
- [ ] Analytic/manufactured, dt/mesh, parity, MMPP, storage i negative tests są uruchamialne.
- [ ] Failure injection dowodzi rollback, no publication i no fallback.
- [ ] Budget i path containment są sprawdzane przed alokacją.
- [ ] Browser proof używa tego samego immutable candidate co runtime.
- [ ] CI blokuje stale/unsupported production claim.
- [ ] Każdy test ma konkretne expected result, a każde status change ma evidence path.

Plan zapisano w docs/superpowers/plans/2026-08-31-time-domain-spectral-analysis-validation-rollout.md. Wykonanie wymaga osobnej autoryzacji oraz superpowers:subagent-driven-development albo superpowers:executing-plans.
