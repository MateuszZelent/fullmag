# Dowody zamknięcia P0 FEM GPU

Data audytu: 2026-08-24
Audytowany HEAD: `d1c6193603e53acb11070cfd24e5ca1d3c099747`
Stan końcowy: **PARTIALLY CONFIRMED** dla wszystkich trzech findings; żaden finding nie jest zamknięty.

## Zasada oceny

Ten dokument ocenia osobno każde z pięciu wspólnych kryteriów Definition of Done dla
`FEM-GPU-ARCH-001`, `FEM-GPU-PERF-001` i `FEM-GPU-PERF-009`.

- `CLOSED` oznacza kompletny, source-bound i właściwy dla kryterium dowód.
- `PARTIALLY CONFIRMED` oznacza, że kontrakt źródłowy lub test fail-closed istnieje,
  ale brakuje dowodu zarządzanego runtime albo pełnego związania ścieżki.
- `NOT VERIFIED` oznacza, że wymaganego dowodu sprzętowego, naukowego lub
  wydajnościowego nie uzyskano.

Test źródłowy, kompilacja i syntetyczny receipt nie dowodzą wykonania na GPU,
zgodności fizycznej, budżetu hot-loop ani kwalifikacji produkcyjnej. Status capability
pozostaje `implemented/unvalidated`.

## Pełne identyfikatory commitów Tasks 1–5

| Commit | Zakres dowodu |
|---|---|
| `13a8d87b4f5d2c434a2fc448338d1199d0a9cee2` | właściciel natywnego execution receipt i jego kontrakt lifecycle |
| `77041dc34cb906a9154560c29d322fd74aff3033` | publiczne ABI v1 receipt i mapowanie FFI |
| `747cb395d4b4d17f5371f5174ac6d472735e5f2b` | pełne mapowanie pól ABI i fail-closed handshake |
| `650d432232784e64e1c6a828de8500e3c6b03ddb` | executed-operator accounting, strict residency, jawny hybrid i transfer audit próby |
| `13f5dad673f103aba06d188b593de6192ca88606` | projekcja Rust, walidacja przed publikacją i trwałe provenance artefaktów |
| `9eaebbed10179dcb6443ff8287a048ec4eb4ea63` | source-bound kwalifikator, comparator, dokumentacja i capability bez promocji |
| `d1c6193603e53acb11070cfd24e5ca1d3c099747` | repozytoryjny Python przed natywną częścią receptury kwalifikacyjnej |

## Dowody i blokery wspólne

Szybkie bramki wykonane z czystego HEAD:

- `C:\Python314\python.exe scripts/test_compare_fem_llg_time_domain_qualification.py -v`:
  `Ran 8 tests`, `OK`.
- `C:\Python314\python.exe .agents/skills/scientific-documentation-contract/scripts/validate_scientific_docs.py docs/physics/0900-native-fem-operator-contracts-and-validation.source-map.json --repo-root .`:
  exit `0`.
- `C:\Python314\python.exe -m unittest discover -s .agents/skills/scientific-documentation-contract/scripts -p test_validate_scientific_docs.py -v`:
  `Ran 11 tests`, `OK`.
- `python -m json.tool` dla `docs/specs/capability-matrix-v0.json` i sidecara strony
  `0900`: exit `0`.
- `just --show verify-fem-time-domain-native-contract`: exit `0`; potwierdza
  kolejność `ensure-python`, dwóch checkerów Python i kontenerowego CMake/CUDA.
- `git diff --check` przed edycją: exit `0`.

Lokalny `scripts/check_llg_time_domain_contract_docs.py` nie wykonał semantycznego
loweringu przez `C:\Python314\python.exe`, ponieważ interpreter nie ma `numpy`.
Repozytoryjny `repo_python` wskazuje na Python 3.8 w WSL i również nie ma `numpy`.
Jest to blocker lokalnego bootstrapu checkera; nie jest to dowód błędu solvera ani PASS.

Ciężkich receptur nie powtórzono, ponieważ Task 5 utrwalił ich dokładne, nadal
nieusunięte blokery, a od tego czasu nie zmieniono obrazu, eksportera ani runtime:

1. `just verify-fem-time-domain-native-contract`: build obrazu kończy się przed
   kompilacją; upstream `nvidia/cuda:12.4.1-devel-ubuntu22.04`, digest
   `sha256:da6791294b0b04d7e65d87b7451d6f2390b4d36225ab0701ee7dfec5769829f5`,
   ma uszkodzone metadata `dpkg`: plik
   `/var/lib/dpkg/info/cuda-libraries-12-4.list` zawiera bajty `0x00`, komunikat
   `files list file for package 'cuda-libraries-12-4' is missing final newline`,
   `apt` kończy się kodem `100`.
2. `just ensure-managed-fem-runtime`: Windows managed export kończy się kodem
   `127` w `scripts/export_fem_gpu_runtime.sh: line 78` z
   `setsid: command not found`.
3. `just verify-fem-llg-time-domain-qualification-gpu`: próba Task 5 została
   przerwana twardym timeoutem `60 s`; nie powstał receipt ani artefakt sprzętowy,
   a niekompletny `source-snapshot.v1.json` usunięto.
4. `just verify-fem-gpu-performance-regression`: kończy się kodem `127` przez
   poprzedzający `ensure-managed-fem-runtime` i brak `setsid`.

Brakujące docelowe artefakty to co najmniej:

- `.fullmag/reports/fem-llg-time-domain-qualification/gpu-fp64/qualification.json`;
- `.fullmag/reports/fem-llg-time-domain-qualification/parity-fp64.json`;
- `.fullmag/reports/fem_gpu_performance_regression.csv`;
- `.fullmag/reports/fem_gpu_performance_regression_summary.json`.

## FEM-GPU-ARCH-001

Stan findingu: **PARTIALLY CONFIRMED**.

| # | Kryterium Definition of Done | Status | Dokładny dowód | Brakujący dowód |
|---:|---|---|---|---|
| 1 | Naprawiona ścieżka jest jedyną produkcyjną realizacją albo stara jest jawnie legacy. | PARTIALLY CONFIRMED | Commit `650d432232784e64e1c6a828de8500e3c6b03ddb`; `backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp` + `context_step_explicit_rk_mfem` kieruje GPU do `gpu_rk_device_resident_step`; `backends/fem/gpu/cuda/integrators/rk/rk_plan.cpp` + `gpu_rk_plan_device_resident` klasyfikuje `hybrid_cpu_poisson`; `crates/fullmag-runner/src/dispatch.rs` + `native_fem_execution_mode` publikuje `hybrid_legacy_sparse`. | Brak source-bound managed trace potwierdzającego jedyną wykonaną ścieżkę. Ponadto `gpu_rk_prepare_step_preflight` wywołuje `gpu_rk_plan_is_strict_device_resident` tylko dla planu już sklasyfikowanego jako `DeviceResident`; strict authoring wiąże receipt dopiero w `crates/fullmag-runner/src/fem/relax/finalize.rs` + `run_after_strict_receipt_gate`, więc hybrid może zostać odrzucony dopiero przed publikacją terminalną, nie przed krokiem. |
| 2 | Reproducer nie może przejść przez fallback. | PARTIALLY CONFIRMED | Commity `650d432232784e64e1c6a828de8500e3c6b03ddb`, `13f5dad673f103aba06d188b593de6192ca88606` i `9eaebbed10179dcb6443ff8287a048ec4eb4ea63`; `backends/fem/tests/gpu_execution_receipt_contract.cpp` + `fallback_only_and_unknown_only_fail_closed`; `crates/fullmag-runner/src/fem/execution_receipt.rs` + `rejects_each_strict_violation_with_stable_code`; `scripts/test_compare_fem_llg_time_domain_qualification.py` + `test_cli_rejects_missing_hybrid_incomplete_or_malformed_receipt`; świeży test comparatora 8/8 PASS. | Brak wykonanego na GPU reproducer’a z niezerowym fallbackiem i brak source-bound receipt z rzeczywistego procesu potwierdzającego, że ścieżka sprzętowa nie mogła przejść. |
| 3 | Wynik fizyczny i numeryczny przechodzi niezależny oracle. | NOT VERIFIED | Commit `9eaebbed10179dcb6443ff8287a048ec4eb4ea63`; `backends/fem/tests/llg_time_domain_qualification.cpp` + `qualify_macrospin`, `qualify_exchange_eigenmode` i `qualify_relax_to_run`; `scripts/compare_fem_llg_time_domain_qualification.py` + `main`; docelowa komenda `just verify-fem-llg-time-domain-qualification-production`. | Nie istnieje świeży managed GPU `qualification.json` ani `parity-fp64.json`; źródło oracle i test comparatora nie dowodzą wyniku sprzętowego. |
| 4 | Telemetryka hot-loop spełnia budżet. | NOT VERIFIED | Commit `650d432232784e64e1c6a828de8500e3c6b03ddb`; `backends/fem/gpu/cuda/runtime/execution_receipt.cpp` + `gpu_execution_receipt_update_attempt_transfer` i `gpu_execution_receipt_commit_attempt`; `backends/fem/cpu/mfem/runtime/backend_step.cpp` + `run_backend_step_attempt`; docelowa komenda `just verify-fem-gpu-performance-regression`. | Brak sprzętowego receipt z zerowym compute H2D/D2H/host-sync, brak CSV/summary performance i brak pomiaru GPU idle/time-to-accuracy. Test licznika nie dowodzi budżetu hot-loop. |
| 5 | Capability jest promowana wyłącznie dla dokładnie przetestowanych kombinacji backend/precision/integrator/interakcje. | PARTIALLY CONFIRMED | Commity `9eaebbed10179dcb6443ff8287a048ec4eb4ea63` i `d1c6193603e53acb11070cfd24e5ca1d3c099747`; `docs/specs/capability-matrix-v0.json` + `features[id=llg_timestep_qualification_registry].qualification_binding` ma `fem_gpu_status=implemented/unvalidated`, pusty `validated_workloads` i fail-closed binding; `docs/specs/capability-matrix-v0.md` + wiersz `LLG timestep qualification registry`. | Brak jednego świeżego, hash-bound artefaktu dla dokładnego tuple. Kwalifikacja naukowa dotyczy RK45 macrospin/exchange, natomiast `justfile` + `verify-fem-gpu-performance-regression` wykonuje minimizer `--relax-algorithms nonlinear_cg`; przekazane równocześnie `--integrators heun` nie dowodzi wykonania ani budżetu hot-loop Heun/RK w tym workflow. Te gates nie tworzą wspólnego dowodu jednej promowanej kombinacji. |

## FEM-GPU-PERF-001

Stan findingu: **PARTIALLY CONFIRMED**.

| # | Kryterium Definition of Done | Status | Dokładny dowód | Brakujący dowód |
|---:|---|---|---|---|
| 1 | Naprawiona ścieżka jest jedyną produkcyjną realizacją albo stara jest jawnie legacy. | PARTIALLY CONFIRMED | Commit `650d432232784e64e1c6a828de8500e3c6b03ddb`; `backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp` + `context_step_explicit_rk_mfem` nie wykonuje hostowego integratora po rozpoznaniu żądania GPU; `backends/fem/gpu/cuda/integrators/rk/rk_step.cu` + `gpu_rk_device_resident_step` jest właścicielem GPU RK; `crates/fullmag-runner/src/dispatch.rs` + `validate_all_in_gpu_fem_runtime_contract` odrzuca niespełniony kontrakt `ALL_IN_GPU`. | Brak managed call trace i executed receipt. `validate_all_in_gpu_fem_runtime_contract` jest wymagane przez osobny runtime switch, a nie bezwarunkowo przez publiczne `ExecutionMode::Strict`; odrzucenie nie jest dowiedzione przed każdym strict krokiem. |
| 2 | Reproducer nie może przejść przez fallback. | PARTIALLY CONFIRMED | Commit `650d432232784e64e1c6a828de8500e3c6b03ddb`; `backends/fem/tests/gpu_strict_execution_contract.cpp` + `planner_proves_strict_device_hypre_and_rejects_hybrid_host_unknown` oraz `strict_transfer_audit_rejects_compute_traffic_only`; `backends/fem/tests/gpu_execution_receipt_contract.cpp` + `incomplete_or_ambiguous_commit_fails_closed`; docelowa komenda `just verify-fem-time-domain-native-contract`. | Kontenerowy test natywny nie został świeżo skompilowany ani wykonany z powodu blockera obrazu; brak reproducer’a na rzeczywistym GPU i receipt bez fallbacku. |
| 3 | Wynik fizyczny i numeryczny przechodzi niezależny oracle. | NOT VERIFIED | Commit `9eaebbed10179dcb6443ff8287a048ec4eb4ea63`; `backends/fem/tests/llg_time_domain_qualification.cpp` + `exact_macrospin`, `qualify_macrospin` i `qualify_exchange_eigenmode`; docelowa komenda `just verify-fem-llg-time-domain-qualification-production`. | Brak GPU `qualification.json` i parity artifact dla wykonanej device-resident ścieżki. Testy źródłowe nie dowodzą fizyki GPU. |
| 4 | Telemetryka hot-loop spełnia budżet. | NOT VERIFIED | Commit `650d432232784e64e1c6a828de8500e3c6b03ddb`; `backends/fem/gpu/cuda/runtime/execution_receipt.cpp` + `attempt_is_valid` wymaga zerowych strict compute H2D/D2H/host-sync; `backends/fem/tests/gpu_strict_execution_contract.cpp` + `strict_transfer_audit_rejects_compute_traffic_only`; `justfile` + `verify-fem-gpu-performance-regression`. | Brak wykonanego hardware telemetry, CSV/summary, trace GPU idle i pomiaru braku hostowego Krylov/integratora w hot-loop. Perf recipe nie ukończyła `ensure-managed-fem-runtime`. |
| 5 | Capability jest promowana wyłącznie dla dokładnie przetestowanych kombinacji backend/precision/integrator/interakcje. | PARTIALLY CONFIRMED | Commit `9eaebbed10179dcb6443ff8287a048ec4eb4ea63`; `docs/specs/capability-matrix-v0.json` + `features[id=llg_timestep_qualification_registry]` pozostaje `implemented/unvalidated`; `scripts/compare_fem_llg_time_domain_qualification.py` + `validate_gpu_execution_receipt` wymaga `double`, `rk45`, strict i kompletnego operator mask. | Brak hash-bound hardware artifact dla tej dokładnej kombinacji. `justfile` + `verify-fem-gpu-performance-regression` wykonuje nonlinear-CG minimizer; opcja `--integrators heun` nie dowodzi pokrycia hot-loop Heun/RK, więc gate nie domyka tuple kwalifikacyjnego LLG. |

## FEM-GPU-PERF-009

Stan findingu: **PARTIALLY CONFIRMED**.

| # | Kryterium Definition of Done | Status | Dokładny dowód | Brakujący dowód |
|---:|---|---|---|---|
| 1 | Naprawiona ścieżka jest jedyną produkcyjną realizacją albo stara jest jawnie legacy. | PARTIALLY CONFIRMED | Commit `650d432232784e64e1c6a828de8500e3c6b03ddb`; `backends/fem/gpu/cuda/integrators/rk/rk_plan.cpp` + `gpu_rk_plan_device_resident` nazywa `hybrid_cpu_poisson`, `hypre_execution_policy=host` i `demag_residency=host_device_roundtrip`; `crates/fullmag-runner/src/dispatch.rs` + `native_fem_execution_mode` nazywa ją `hybrid_legacy_sparse`; `gpu_rk_plan_is_strict_device_resident` odrzuca hybrid. | Brak managed receipt dowodzącego, że produkcyjny strict wykonał wyłącznie `device_hypre_poisson`. Native preflight nie wiąże bezwarunkowo publicznego strict z `gpu_rk_plan_is_strict_device_resident` przed krokiem. |
| 2 | Reproducer nie może przejść przez fallback. | PARTIALLY CONFIRMED | Commity `650d432232784e64e1c6a828de8500e3c6b03ddb` i `9eaebbed10179dcb6443ff8287a048ec4eb4ea63`; `backends/fem/tests/gpu_strict_execution_contract.cpp` + `planner_proves_strict_device_hypre_and_rejects_hybrid_host_unknown`; `scripts/test_compare_fem_llg_time_domain_qualification.py` + `test_cli_rejects_missing_hybrid_incomplete_or_malformed_receipt`; świeży comparator 8/8 PASS. | Brak sprzętowego reproducer’a, receipt i artefaktu potwierdzającego brak przejścia przez hostowy Poisson. Finalny strict gate odrzuca publikację, ale nie dowodzi odrzucenia przed wykonaniem kroku. |
| 3 | Wynik fizyczny i numeryczny przechodzi niezależny oracle. | NOT VERIFIED | Commit `9eaebbed10179dcb6443ff8287a048ec4eb4ea63`; `backends/fem/tests/llg_time_domain_qualification.cpp` + `qualify_relax_to_run`, `qualify_macrospin` i `qualify_exchange_eigenmode`; `scripts/compare_fem_llg_time_domain_qualification.py` + `validate_parity_energy_contract`. | Brak source-bound managed GPU artifact z device Poisson i brak CPU/GPU parity artifact; źródło qualification nie dowodzi demag na GPU. |
| 4 | Telemetryka hot-loop spełnia budżet. | NOT VERIFIED | Commit `650d432232784e64e1c6a828de8500e3c6b03ddb`; `backends/fem/gpu/cuda/integrators/rk/rk_demag_dispatch.cu` + `gpu_rk_compute_hybrid_cpu_demag_for_device_stage` jawnie wykonuje round-trip tylko dla hybrid; `backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp` + `compute_device_demag_for_device_stage_impl` emituje przez `gpu_execution_receipt_note_device` bity `FEM_GPU_OPERATOR_DEMAG_RHS | FEM_GPU_OPERATOR_DEMAG_RECOVERY` po zakolejkowaniu recovery i redukcji energii oraz po zarejestrowaniu końcowych CUDA events; dowodzi to kolejności enqueue/event-record w strumieniu, nie zakończenia pracy GPU; `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp` + `validate_demag_poisson_hypre_device_solve` emituje bity `FEM_GPU_OPERATOR_DEMAG_SOLVE | FEM_GPU_OPERATOR_PRECONDITIONER` po walidacji wyniku solve; `justfile` + `verify-fem-gpu-performance-regression`. | Brak wykonanego receipt z zerowym D2H/H2D/sync dla strict device Poisson, brak hardware timeline i performance artifacts. Obecność wywołań device nie dowodzi braku round-trip. |
| 5 | Capability jest promowana wyłącznie dla dokładnie przetestowanych kombinacji backend/precision/integrator/interakcje. | PARTIALLY CONFIRMED | Commit `9eaebbed10179dcb6443ff8287a048ec4eb4ea63`; `docs/specs/capability-matrix-v0.json` + `features[id=llg_timestep_qualification_registry].qualification_binding.hybrid_cpu_poisson_satisfies_strict=false`; `docs/specs/capability-matrix-v0.md` + wiersze `Demag` i `LLG timestep qualification registry`; status pozostaje `implemented/unvalidated`. | Brak jednego managed artifact dla exact strict FEM GPU, FP64, integratora i zestawu exchange/demag/interakcji. Istniejące receptury naukowa i performance mają różne tuple. |

## Wynik finalnego review P0

Nie można potwierdzić wymaganego wyniku `0 Critical / 0 Important`.

- **Important — strict/hybrid boundary:** publiczny strict receipt jest walidowany przed
  terminalną publikacją, ale nie jest bezwarunkowo związany z natywnym preflight przed
  pierwszym krokiem. Wymagany jest test i kontrakt, że strict authoring odrzuca
  `hybrid_cpu_poisson` przed wykonaniem.
- **Important — niespójny tuple dowodowy:** scientific qualification używa RK45 i
  zestawu macrospin/exchange/relax-to-run, natomiast performance regression wykonuje
  nonlinear-CG minimizer dla exchange/demag. Obecność `--integrators heun` w tej komendzie
  nie dowodzi wykonania ani budżetu hot-loop Heun/RK. Brakuje jednego exact source-bound
  zestawu artefaktów, który dla tej samej kombinacji jednocześnie dowodzi oracle,
  executed residency i hot-loop.

Blockery obrazu CUDA, Windows export i timeout kwalifikacji są blockerami środowiska.
Dwie pozycje Important są brakami produktu/evidence contract, nie blockerami środowiska.
Capability nie została promowana.
