# Plan wdrożenia produkcyjnego FEM eigensolve K0 full-GPU

> **Dla wykonawców:** plan należy realizować zadanie po zadaniu przy użyciu
> `subagent-driven-development`. Każde zadanie wymaga osobnego review kontraktu,
> implementacji i testów przed integracją. Native FEM/MFEM/CUDA/HYPRE/PETSc/
> SLEPc buduje i uruchamia wyłącznie właściciel integracji przez repozytoryjne,
> kontenerowe recepty `just`.

**Cel:** domknąć istniejącą ścieżkę FEM K0 Poisson-airbox PETSc/SLEPc CUDA tak,
aby rzeczywiście liczyła spectrum i zespolone mode fields na GPU, zachowywała
ten sam mesh i equilibrium po relaksacji, była fizycznie zgodna z CPU/Kittlem
oraz udostępniała wynik i dowód rezydencji w Control Room.

**Projekt nadrzędny:**
`docs/superpowers/specs/2026-08-11-fem-k0-eigensolve-full-gpu-design.md`.

**Relacja do masterplanu:** ten dokument wykonuje wąski slice C3, N3, A1S,
A1E, A2, U2, Q2, Q3 i G2-governance z
`docs/plans/active/fd_sovler_masterplan/27_fem_k0_eigensolve_production_completion_and_control_room.md`.

**Architektura:** istniejący adapter
`solve_poisson_airbox_modal_eigen_gpu_petsc_slepc` pozostaje jedynym
produkcyjnym solverem GPU. PETSc/SLEPc zarządza selected-spectrum Krylov-Schur
i shift-invert, `MatShell` realizuje matrix-free Schur, HYPRE CUDA realizuje
Poisson/preconditioning, a runner publikuje wyłącznie natywnie poświadczone
executed-path provenance. Nie powstaje drugi solver ani drugi format wyników.

**Stos:** C++17/CUDA, MFEM, HYPRE, PETSc, SLEPc, C ABI, Rust runner/API,
Python validators, Next.js/React/TypeScript Control Room, Zarr/binary data plane.

---

## 0. Reguły wykonania

### 0.1. Katalog i ochrona zmian

Prace prowadzić w:

```text
/home/kkingstoun/git/fullmag/fullmag/.worktrees/eigensolve-k0-demag-recovery
```

Worktree jest współdzielony i szeroko dirty. Przed każdą zmianą i każdym
commitem:

```bash
git status --short
git diff --name-only
git diff --cached --name-only
```

Nie używać `git add -A`, `git reset --hard`, `git checkout --`, ręcznego
kasowania runtime locków ani katalogów build. Stage'ować tylko jawnie wymienione
pliki danego zadania. Przed commitem uruchomić `git diff --cached --name-only`
w osobnym poleceniu i przerwać, jeżeli zawiera plik spoza własności zadania.

### 0.2. Jeden integrator, maksymalnie sześć lane'ów

Integrator posiada wyłącznie:

- `native/include/fullmag_fem.h`;
- `crates/fullmag-fem-sys/src/lib.rs`;
- `backends/fem/CMakeLists.txt`;
- `justfile`;
- generated OpenAPI;
- managed runtime rebuild/export;
- final capability promotion.

Pozostali wykonawcy pracują w izolowanych worktree utworzonych z tego samego
zatwierdzonego integration-base commit. Zalecany podział po ukończeniu zadań
T0–T2B:

| Lane | Zadania | Wyłączna własność |
|---|---:|---|
| Native GPU | 3–6 | HYPRE policy, `modal_petsc_slepc.cpp`, GPU tests |
| Runner/artifacts | 7–8 | `fullmag-runner`, artifact verifier/writer |
| Validation | 9–10 | Kittel/parity/antidot scripts i fixtures |
| API | 11 | Rust API schemas/handlers/tests |
| Control Room | 12 | typed resource hooks, Results/Inspector/viewport tests |
| Evidence/integration | 13–15 | `justfile`, managed runtime, evidence, promotion |

Agent nie edytuje pliku należącego do innego lane. Potrzebę zmiany kontraktu
zgłasza integratorowi w formie małego patcha lub dokładnej listy pól, zamiast
samodzielnie zmieniać ABI/generated files.

### 0.3. Bramki znaczeniowe

W raportach zawsze rozróżniać:

- `implemented`: source i testy istnieją;
- `executable`: dokładny managed runtime wykonał scope;
- `physics_validated`: przechodzą fizyczne oracles;
- `production_qualified`: K0-G0–K0-G9 i UI/release evidence przechodzą na realnym
  urządzeniu.

W całym planie `K0-G0`…`K0-G9` oznacza bramki naukowo-runtime'owe tego
slice'u. `G2-governance` oznacza osobny, końcowy etap promocji masterplanu i nie
jest bramką `K0-G2`.

Brak GPU, niezmierzona telemetria lub stale runtime oznacza `blocked`, nie
`passed` ani `skipped-as-success`.

### 0.4. Globalna definicja RED/GREEN

- **RED:** test odtwarza konkretną lukę i failuje z oczekiwanym assertion/reason
  tokenem. Nie wolno pisać implementation przed zobaczeniem tego failure.
- **GREEN:** minimalna zmiana sprawia, że nowy test i bezpośrednio sąsiednie
  regresje przechodzą.
- **REFACTOR:** dopiero po GREEN; bez zmiany publicznych semantyk i z ponownym
  uruchomieniem tych samych testów.

---

## 1. Graf zależności i Definition of Ready

```text
T0 baseline/inventory
  -> T0A synchronize current master
  -> T1 exact scope/docs
  -> T1A remove Kittel oracle from production solve
  -> T2 versioned v19 ABI + handoff + attestation
       -> T2B freeze validation-registration schemas
       -> T3 shared HYPRE device policy
  T2B -> T9 independent validators
  T3 -> T4 device object graph
  T4 -> T5 measured transfers/identity
  T5 -> T6 session lifecycle + scalable matrix-free
  T5 -> T11 typed API schema
  T2 + T5 -> T7 runner truth/fail-closed
  T7 -> T8 immutable artifacts
  T9 -> T10 antidot E2E validator
  T7 + T8 + T11 -> T12 Results/Inspector/viewport
  T6 + T8 + T9 + T10 -> T13 managed recipes/evidence
  T11 + T12 + T13 -> T14 integrated K0-G0–K0-G9 candidate qualification
  T14 -> T15 G2-governance promotion + external attestation
```

**Definition of Ready dla prac równoległych:** istnieje czysty, znany commit
integracyjny zawierający zatwierdzone T0, T0A, T1, T1A i T2 oraz aktualny
`master`; ABI layout test przechodzi; T2B validation-registration schemas oraz
T2 native attestation ABI są zamrożone; każdy lane ma wyłączną listę plików i
testów. Runner/API nie rozpoczynają T7/T11 przed zamrożeniem JSON mappingu T5.

---

## Zadanie T0: zabezpieczyć i zakwalifikować stan wejściowy

**Cel:** uniknąć utraty istniejącego postępu oraz dublowania implementacji.

**Pliki:** bez zmian źródłowych. Integrator może dopisać wyłącznie aktualny
status do `.superpowers/sdd/progress.md`, jeżeli plik nie jest jednocześnie
edytowany przez innego wykonawcę.

### Kroki

1. Zapisz aktualne identity:

   ```bash
   git rev-parse HEAD
   git branch --show-current
   git status --short
   git diff --name-status
   git diff --cached --name-status
   git worktree list --porcelain
   ```

2. Sklasyfikuj każdy dirty plik jako: `k0-core`, `artifacts-api-ui`,
   `runtime-storage`, `documentation` albo `unrelated`. Nie stage'uj kategorii
   `unrelated`.
3. Potwierdź, że produkcyjny adapter jest istniejącą funkcją:

   ```bash
   rg -n "solve_poisson_airbox_modal_eigen_gpu_petsc_slepc|create_gpu_solver_state|apply_schur" \
     backends/fem/gpu/frequency_domain/modal_petsc_slepc.cpp
   ```

4. Potwierdź, że `modal_krylov.cu` pozostaje validation-only i że żaden plan
   nie tworzy drugiego eigensolvera.
5. Uruchom lekkie, nie-native baseline tests:

   ```bash
   PYTHONPATH=packages/fullmag-py/src python3 -m pytest -q \
     packages/fullmag-py/tests/test_periodic_antidot_eigenmodes_example.py \
     scripts/test_fem_frequency_domain_native_recipe.py \
     scripts/test_validate_fem_periodic_antidot_relax_eigenmodes_runtime.py
   ```

6. Nie uruchamiaj przebudowy ani solve do czasu ustalenia właściciela istniejącego
   export lock i zgodności runtime source digest.

### Akceptacja T0

- wszystkie istniejące zmiany mają właściciela i kategorię;
- integration-base commit jest znany pełnym SHA;
- nie istnieje druga równoległa implementacja solvera;
- integrator potrafi wskazać, które testy były green/failing przed nowymi
  zmianami;
- żadna cudza zmiana nie została zestage'owana ani usunięta.

Nie tworzyć commita, jeżeli T0 nie zmienia pliku.

---

## Zadanie T0A: zabezpieczyć recovery i zintegrować aktualny `master`

**Zależność:** T0.
**Lane:** wyłącznie integrator, przy współpracy właścicieli dirty plików.
**Blokuje:** każde T1–T15.

### Stan wykryty podczas red-team review

W audytowanym snapshotcie `git merge-base --is-ancestor master HEAD` zwracał
kod 1, a branch i master miały dwustronną dywergencję. Te liczby mogą się
zmienić; gate opiera się na świeżym poleceniu, nie na zapamiętanych SHA.

### Kroki zabezpieczenia

1. Audytuj każdy worktree:

   ```bash
   git worktree list --porcelain
   git status --short
   git diff --name-status
   git diff --cached --name-status
   ```

2. Dla każdego dirty pliku ustal aktywnego właściciela. Właściciel uruchamia
   swoje targeted tests, tworzy path-scoped commit na swojej gałęzi i pushuje
   go. Nie wolno chować wspólnych zmian jednym anonimowym stash ani commitować
   cudzych plików.
3. Integrator importuje zaakceptowane recovery commity do jednej gałęzi i
   ponownie sprawdza, że worktree jest czysty. Untracked build/runtime data nie
   może znajdować się w source worktree; nie usuwaj go bez osobnej zgody.
4. Zapisz pełny pre-merge commit SHA i pushuj recovery branch jako punkt
   odzyskiwania.

### Integracja mastera

```bash
git fetch origin master
git merge --no-edit origin/master
```

Przy konflikcie zatrzymaj merge na każdym pliku i przydziel go jego właścicielowi
subsystemu. Rozwiązanie konfliktu musi zachować nowe poprawki mastera i
zaakceptowany recovery contract; nie wybieraj hurtowo `ours` albo `theirs`.

### Weryfikacja po merge

```bash
git merge-base --is-ancestor origin/master HEAD
git status --short
PYTHONPATH=packages/fullmag-py/src python3 -m pytest -q \
  packages/fullmag-py/tests/test_api.py \
  packages/fullmag-py/tests/test_periodic_antidot_eigenmodes_example.py \
  scripts/test_fem_frequency_domain_native_recipe.py \
  scripts/test_validate_fem_periodic_antidot_relax_eigenmodes_runtime.py
python3 scripts/check_repo_consistency.py
```

**Oczekiwany wynik:** ancestor check ma kod 0, worktree jest czysty, a baseline
regresje przechodzą. Dopiero wtedy pushuj zsynchronizowaną gałąź i ogłoś nowy
integration-base SHA.

### Akceptacja T0A

- [ ] każdy istniejący postęp ma commit i remote backup;
- [ ] żaden cudzy dirty plik nie zniknął;
- [ ] `origin/master` jest przodkiem `HEAD`;
- [ ] konflikty mają subsystem-owner review;
- [ ] baseline po merge jest zapisany;
- [ ] T1+ startuje wyłącznie z nowego czystego SHA.

---

## Zadanie T1: zamrozić dokładny scope, dokumentację fizyczną i capability

**Zależność:** T0A.
**Lane:** integrator/documentation.
**Cel:** wszystkie niższe warstwy implementują tę samą, wąską legalność.

**Modyfikuj:**

- `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`
- `docs/physics/0830-fem-poisson-airbox-modal-eigen.source-map.json`
- `docs/plans/active/fd_sovler_masterplan/27_fem_k0_eigensolve_production_completion_and_control_room.md`
- `docs/plans/active/fd_sovler_masterplan/18_poisson_airbox_eigensolve_cpu_gpu_implementation.md`
- `docs/plans/active/fd_sovler_masterplan/25_frequency_domain_readiness_scope_catalog.json`
- `docs/plans/active/fd_sovler_masterplan/25_frequency_domain_readiness_matrix.json`
- `docs/specs/capability-matrix-v0.json`
- `docs/specs/capability-matrix-v0.md`
- `scripts/test_frequency_domain_math_contract_docs.py`

### RED

1. Dodaj test dokumentacyjny wymagający dla FEM GPU K0 dokładnie:
   `double`, K0, periodic x/y + open z, shared-domain P1 tet4|prism6,
   `full_2x2`, exchange+Zeeman+demag, homogeneous scalar `A_ex`, `alpha=0`,
   bez DMI/anizotropii i bez fallbacku.
2. Test ma również wymagać, aby capability pozostało
   `implementation_state=source_visible`, `validation_state=unvalidated` do T15.
3. Uruchom:

   ```bash
   python3 -m pytest -q scripts/test_frequency_domain_math_contract_docs.py
   ```

   **Oczekiwany RED:** brak co najmniej jednego exact-scope assertion albo
   niespójna terminologia dokumentów.

### GREEN

1. Uzupełnij notę fizyczną o:
   - aktualny vs docelowy status GPU;
   - równania i SI bez zmiany istniejącej fizyki;
   - osobne CPU/GPU realizations;
   - exact legality table;
   - measured residency jako warunek, nie claim;
   - K0-G0–K0-G9 i progi z zatwierdzonej specyfikacji.
2. Zaktualizuj source-map symbolami:
   - `solve_poisson_airbox_modal_eigen_gpu_petsc_slepc`;
   - `create_gpu_solver_state`;
   - `apply_schur`;
   - `native_solver_diagnostics_json`;
   - `write_eigen_v2_bundle`;
   - API diagnostics/mode-field handlers;
   - Results Inspector i mode-field overlay controller.
   Test source-map musi dla każdego wpisu rozwiązać istniejącą ścieżkę oraz
   odnaleźć wskazany symbol; sam poprawny JSON nie wystarcza.
3. W masterplanie połącz N3/A1S/A1E/A2/U2/Q2/Q3/G2-governance z nową
   specyfikacją i
   usuń każdy zapis sugerujący, że deklarowane zero transferów jest dowodem.
4. Nie promuj capability. Dodaj do scope catalog dwa future bindings, nadal
   `unvalidated`, o stabilnych identyfikatorach:
   - `modal_cpu_k0_periodic_airbox_real_shared_domain.production`;
   - `modal_gpu_k0_periodic_airbox_scalable.production`.
   Oba rozwijają pełny exact scope z sekcji 3 specyfikacji; różnią się wyłącznie
   device/solver lane. Readiness cells nadal mają current status
   `source_visible` do T15.

### Weryfikacja

```bash
python3 -m pytest -q \
  scripts/test_frequency_domain_math_contract_docs.py \
  scripts/test_validate_mixed_p1_capability_contract.py
python3 -m json.tool \
  docs/physics/0830-fem-poisson-airbox-modal-eigen.source-map.json >/dev/null
python3 scripts/check_fd_solver_masterplan_contract.py
python3 scripts/check_physics_docs_gate.py --base HEAD --head WORKTREE
```

**Oczekiwany GREEN:** wszystkie polecenia kończą się kodem 0; capability nadal
nie zawiera produkcyjnego claimu GPU.

### Commit

```bash
git add docs/physics/0830-fem-poisson-airbox-modal-eigen.md \
  docs/physics/0830-fem-poisson-airbox-modal-eigen.source-map.json \
  docs/plans/active/fd_sovler_masterplan/27_fem_k0_eigensolve_production_completion_and_control_room.md \
  docs/plans/active/fd_sovler_masterplan/18_poisson_airbox_eigensolve_cpu_gpu_implementation.md \
  docs/plans/active/fd_sovler_masterplan/25_frequency_domain_readiness_scope_catalog.json \
  docs/plans/active/fd_sovler_masterplan/25_frequency_domain_readiness_matrix.json \
  docs/specs/capability-matrix-v0.json \
  docs/specs/capability-matrix-v0.md \
  scripts/test_frequency_domain_math_contract_docs.py
git diff --cached --name-only
git commit -m "docs: freeze FEM K0 full-GPU qualification scope"
```

---

## Zadanie T1A: usunąć analityczny oracle Kittela z produkcyjnego solve

**Zależność:** T1.
**Lane:** integrator + właściciel CPU/GPU modal contract.
**Cel:** solver nie zna oczekiwanej odpowiedzi; Kittel pozostaje niezależnym
postsolve verifierem.

**Modyfikuj:**

- `native/include/fullmag_fem.h`
- `backends/fem/include/frequency_domain/modal_eigen_request.hpp`
- `backends/fem/src/frequency_domain/modal_eigen_solver.cpp`
- `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp`
- `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp`
- `backends/fem/gpu/frequency_domain/modal_petsc_slepc.cpp`
- `crates/fullmag-runner/src/fem_eigen.rs`
- `backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp`
- `backends/fem/tests/frequency_domain/poisson_airbox_schur_matshell_test.cpp`
- `backends/fem/tests/frequency_domain/gpu_k0_modal_petsc_slepc_test.cpp`
- `scripts/test_verify_fem_frequency_domain_eigen_artifacts.py`

### RED

1. Zbuduj dwie byte-identical production requests różniące się wyłącznie
   legacy `poisson_airbox_expected_reference_frequency_hz`: zero oraz dowolna
   finite positive wartość. Druga ma zostać odrzucona przed assembly tokenem
   `k0_poisson_airbox_analytical_reference_forbidden_in_production`.
2. Zbuduj dwa postsolve validation envelopes z różnymi Kittel references, ale
   tym samym frozen raw solve. Oczekuj identycznych:
   - operator/block digests;
   - target/window i shift schedule;
   - raw eigenvalues/eigenvectors/mode IDs;
   - native status i convergence reasons;
   - `eps_q`, `eps_phi`, `eps_gauge`, `eps_full`.
3. Test mutuje/usuwa `k0_kittel_validation` w runner metadata i dowodzi, że
   native request bytes należące do production physics nie zmieniają się.
4. CPU i GPU diagnostics nie mogą zawierać solver-side
   `reference_frequency_certified`, relative Kittel error ani wyboru nearest
   expected mode.
5. `build_pa_e4b_k0_kittel_poisson_airbox_payload` musi być odrzucony, jeśli
   `validation_only_adapter != true`.

Uruchom RED najpierw przez:

```bash
just verify-fem-frequency-domain-native-contract
cargo test -p fullmag-runner --quiet fem_eigen
python3 -m pytest -q scripts/test_verify_fem_frequency_domain_eigen_artifacts.py
```

### GREEN

1. Zachowaj zamrożony legacy slot C ABI dla binary layout, ale production
   producer zawsze wpisuje `0.0`, a native production boundary wymaga `0.0` i
   nigdy nie używa pola.
2. Usuń expected/reference frequency z wewnętrznego production problem state,
   target construction, preconditioner, acceptance i diagnostics CPU/GPU.
3. Target i okno pochodzą wyłącznie z authored `EigenTargetIR`.
4. Solver success zależy wyłącznie od legalności, convergence, window
   completeness, finite/branch classification i oryginalnych residuals.
5. Syntetyczny PA-E4b builder pozostaje jawnie `validation_only`, ma osobny
   adapter label i nie może ustawić production/scalable claimu.
6. Kittel reference trafia dopiero do standalone verifiera T9 po zamrożeniu raw
   artifacts.

### Weryfikacja

```bash
just verify-fem-frequency-domain-native-contract
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-dense-oracle
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-cpu-slepc
cargo test -p fullmag-runner --quiet fem_eigen
python3 -m pytest -q scripts/test_verify_fem_frequency_domain_eigen_artifacts.py
```

**Akceptacja T1A:** zmiana analitycznego oracle nie może zmienić żadnego bajtu
production solve input ani raw solver output; nonzero legacy reference jest
fail-closed; synthetic oracle nie ma production implication.

### Commit

```bash
git commit -m "fix(fem): isolate Kittel reference from production eigensolve"
```

---

## Zadanie T2: dodać bezpieczne ABI v19 attestation i ścisły handoff

**Zależność:** T1A.
**Lane:** wyłącznie integrator.
**Cel:** native result przenosi zmierzoną prawdę wykonania; runner nie musi jej
zgadywać.

**Modyfikuj:**

- `native/include/fullmag_fem.h`
- `crates/fullmag-fem-sys/src/lib.rs`
- `backends/fem/src/api.cpp`
- `backends/fem/include/frequency_domain/modal_eigen_result.hpp`
- `backends/fem/src/frequency_domain/modal_eigen_solver.cpp`
- `backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp`
- `crates/fullmag-runner/src/native_fem/frequency_domain.rs`
- `crates/fullmag-runner/src/native_fem/eigen.rs`
- odpowiednie testy ABI w `crates/fullmag-fem-sys/src/lib.rs`

### Docelowe interfejsy

Pozostaw bitowo bez zmian istniejący value-return symbol
`fullmag_fem_modal_eigen_solve` i `FullmagFemFrequencyDomainResult` v18. Dodaj
nowy caller-sized interfejs:

```c
#define FULLMAG_FEM_MODAL_GPU_ATTESTATION_V1 1u
#define FULLMAG_FEM_FREQUENCY_DOMAIN_RESULT_V19 19u

typedef enum {
    FULLMAG_FEM_MODAL_GPU_MEASUREMENT_UNSPECIFIED = 0,
    FULLMAG_FEM_MODAL_GPU_MEASUREMENT_MEASURED = 1,
    FULLMAG_FEM_MODAL_GPU_MEASUREMENT_UNAVAILABLE = 2,
    FULLMAG_FEM_MODAL_GPU_MEASUREMENT_FAILED = 3
} FullmagFemModalGpuMeasurementState;

typedef enum {
    FULLMAG_FEM_MODAL_GPU_FALLBACK_UNSPECIFIED = 0,
    FULLMAG_FEM_MODAL_GPU_FALLBACK_NONE = 1,
    FULLMAG_FEM_MODAL_GPU_FALLBACK_ATTEMPTED = 2
} FullmagFemModalGpuFallbackState;

typedef enum {
    FULLMAG_FEM_MODAL_OPERATOR_UNSPECIFIED = 0,
    FULLMAG_FEM_MODAL_OPERATOR_MATRIX_FREE_SCHUR_CUDA = 1,
    FULLMAG_FEM_MODAL_OPERATOR_MATERIALIZED_VALIDATION_CUDA = 2
} FullmagFemModalOperatorKind;

typedef enum {
    FULLMAG_FEM_MODAL_HYPRE_MEMORY_UNSPECIFIED = 0,
    FULLMAG_FEM_MODAL_HYPRE_MEMORY_HOST = 1,
    FULLMAG_FEM_MODAL_HYPRE_MEMORY_DEVICE = 2,
    FULLMAG_FEM_MODAL_HYPRE_MEMORY_UNIFIED = 3
} FullmagFemModalHypreMemoryLocation;

typedef enum {
    FULLMAG_FEM_MODAL_HYPRE_EXEC_UNSPECIFIED = 0,
    FULLMAG_FEM_MODAL_HYPRE_EXEC_HOST = 1,
    FULLMAG_FEM_MODAL_HYPRE_EXEC_DEVICE = 2
} FullmagFemModalHypreExecutionPolicy;

#define FULLMAG_FEM_MODAL_GPU_COVERAGE_SETUP UINT64_C(1)
#define FULLMAG_FEM_MODAL_GPU_COVERAGE_FULLMAG_HOT_LOOP UINT64_C(2)
#define FULLMAG_FEM_MODAL_GPU_COVERAGE_OBJECT_GRAPH UINT64_C(4)
#define FULLMAG_FEM_MODAL_GPU_COVERAGE_SCALAR_TELEMETRY UINT64_C(8)
#define FULLMAG_FEM_MODAL_GPU_COVERAGE_EXPORT UINT64_C(16)

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint32_t measurement_state;
    uint32_t fallback_state;
    uint64_t measurement_coverage_flags;
    uint32_t device_residency_verified;
    uint32_t production_shared_domain;
    uint32_t validation_only;
    uint32_t operator_kind;
    uint32_t hypre_memory_location;
    uint32_t hypre_execution_policy;
    uint32_t compute_capability_major;
    uint32_t compute_capability_minor;
    uint32_t cuda_driver_version;
    uint32_t cuda_runtime_version;

    char *device_name;
    char *mfem_version;
    char *hypre_version;
    char *petsc_version;
    char *slepc_version;
    char *petsc_vec_type;
    char *petsc_matrix_type;
    char *matshell_vec_type;
    char *slepc_bv_type;
    char *eps_type;
    char *st_type;
    char *ksp_type;
    char *poisson_pc_type;
    char *shift_pc_type;
    char *last_invalidation_reason;

    uint8_t device_uuid[16];
    uint8_t object_graph_sha256[32];
    uint8_t native_trace_sha256[32];
    uint8_t source_snapshot_sha256[32];
    uint8_t runtime_manifest_sha256[32];
    uint8_t mesh_identity_sha256[32];
    uint8_t equilibrium_sha256[32];
    uint8_t certificate_sha256[32];
    uint8_t linearization_sha256[32];
    uint8_t material_sha256[32];
    uint8_t physics_sha256[32];
    uint8_t boundary_sha256[32];
    uint8_t gauge_sha256[32];
    uint8_t operator_terms_sha256[32];
    uint8_t solver_policy_sha256[32];
    uint8_t operator_key_sha256[32];
    uint8_t target_key_sha256[32];
    uint8_t session_context_sha256[32];

    uint64_t setup_h2d_count;
    uint64_t setup_h2d_bytes;
    uint64_t hot_loop_computational_h2d_count;
    uint64_t hot_loop_computational_h2d_bytes;
    uint64_t hot_loop_computational_d2h_count;
    uint64_t hot_loop_computational_d2h_bytes;
    uint64_t hot_loop_scalar_telemetry_d2h_count;
    uint64_t hot_loop_scalar_telemetry_d2h_bytes;
    uint64_t hot_loop_full_vector_crossings;
    uint64_t hot_loop_computational_host_syncs;
    uint64_t hot_loop_scalar_telemetry_syncs;
    uint64_t hot_loop_allocations;
    uint64_t export_d2h_count;
    uint64_t export_d2h_bytes;
    uint64_t device_memory_baseline_bytes;
    uint64_t device_memory_peak_bytes;
    uint64_t device_memory_final_bytes;
    uint64_t operator_dimension;
    uint64_t operator_apply_count;
    uint64_t poisson_solve_count;
    uint64_t poisson_iteration_count;
    uint64_t eps_iteration_count;
    uint64_t eps_restart_count;
    int64_t eps_converged_reason;
    uint64_t operator_state_generation;
    uint64_t target_state_generation;
    uint64_t operator_reuse_count;
    uint64_t target_rebuild_count;
    uint64_t invalidation_flags;
} FullmagFemModalGpuAttestationV1;

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    FullmagFemFrequencyDomainResult scientific_result_v18;
    FullmagFemModalGpuAttestationV1 *gpu_attestation;
} FullmagFemFrequencyDomainResultV19;

int fullmag_fem_modal_eigen_solve_v19(
    const FullmagFemModalEigenRequest *request,
    FullmagFemFrequencyDomainResultV19 *out_result);

void fullmag_fem_frequency_domain_result_v19_destroy(
    FullmagFemFrequencyDomainResultV19 *result);
```

Caller zeruje cały envelope, następnie ustawia `abi_version=19` i
`struct_size=sizeof(FullmagFemFrequencyDomainResultV19)`; callee sprawdza oba
pola przed jakimkolwiek zapisem. `scientific_result_v18` ma dokładnie istniejący
v18 layout i ownership. Wskaźnik attestation jest null dla CPU. Wszystkie
`char *` i sidecar są read-only dla callera, alokowane przez bibliotekę i
zwalniane wyłącznie przez destroy v19; caller nie zwalnia pól osobno. Tablice
SHA mają dokładnie surowe 32 bajty, UUID dokładnie 16 bajtów; all-zero oznacza
brak danych i jest niedozwolone dla odpowiedniego pola przy `MEASURED`.
Producent ustawia sidecar `abi_version=FULLMAG_FEM_MODAL_GPU_ATTESTATION_V1` i
`struct_size=sizeof(FullmagFemModalGpuAttestationV1)` przed publikacją pointera.
Native boundary i Rust parser sprawdzają nie-null pointer, exact znaną wersję
oraz `struct_size >= sizeof(FullmagFemModalGpuAttestationV1)` przed odczytem
pierwszego stringa, digestu lub licznika; nieznany albo krótszy sidecar failuje
bez dereferencji taila. Większy sidecar V1 może rozszerzać tail, którego parser
V1 nie odczytuje.
Destroy wywołuje istniejący destroy dla embedded v18 result, zwalnia każdy
nie-null string i sidecar, następnie zeruje envelope z zachowaniem headera;
zero/partial/full state oraz podwójne wywołanie są idempotentne.

Dodaj dokładnie:

```c
#define FULLMAG_FEM_FREQUENCY_DOMAIN_MODAL_ABI_LAYOUT_V4 4u
typedef struct {
    fullmag_fem_frequency_domain_modal_abi_layout_v3 v3;
    uint64_t modal_frequency_domain_result_v19_size;
    uint64_t modal_frequency_domain_result_v19_align;
    uint64_t modal_frequency_domain_result_v19_field_count;
    uint64_t modal_frequency_domain_result_v19_field_offsets[4];
    uint64_t modal_gpu_attestation_v1_size;
    uint64_t modal_gpu_attestation_v1_align;
    uint64_t modal_gpu_attestation_v1_field_count;
    uint64_t modal_gpu_attestation_v1_field_offsets[128];
} fullmag_fem_frequency_domain_modal_abi_layout_v4;

int fullmag_fem_get_frequency_domain_modal_abi_layout_v4(
    fullmag_fem_frequency_domain_modal_abi_layout_v4 *out_layout);
```

Manifest publikuje wszystkie `sizeof`, `alignof` i `offsetof`; C++
`static_assert` oraz Rust layout test porównują każde pole, nie tylko prefix.
Strict production GPU wymaga symbolu v19;
legacy v18 pozostaje dla binary-compatible CPU i validation-only call sites i
nie może poświadczyć full-GPU.

Handoff request pozostaje oparty o istniejący `FullmagFemModalSharedDomainPayload`
v18 i musi wymagać przed solve: mesh generation identity, canonical preimage
SHA-256, certificate binding v6, equilibrium content SHA-256, linearization,
material/physics/boundary/gauge oraz bias sample signature.

### RED

1. C++ tests:
   - stary v18 caller i stara biblioteka zachowują dokładny size/layout i
     wykonują legacy CPU fixture;
   - strict production GPU przez v18 jest odrzucony tokenem
     `k0_poisson_airbox_gpu_attestation_abi_required`;
   - result v19 z za małym `struct_size` jest odrzucony przed zapisem;
   - sidecar z `abi_version != FULLMAG_FEM_MODAL_GPU_ATTESTATION_V1` jest
     odrzucony przed odczytem taila tokenem
     `k0_poisson_airbox_gpu_attestation_abi_mismatch`;
   - sidecar V1 z `struct_size < sizeof(FullmagFemModalGpuAttestationV1)` jest
     odrzucony przed odczytem taila tym samym tokenem;
   - unknown measurement enum jest odrzucony;
   - sidecar `MEASURED` bez UUID/digestów jest odrzucony;
   - production sidecar z `operator_kind != MATRIX_FREE_SCHUR_CUDA`, zerowym
     `operator_dimension`, zerowymi generation counters albo brakującym
     operator/target/session key jest odrzucony;
   - null sidecar przy resolved GPU blokuje completion;
   - partial allocation + podwójny destroy nie crashuje.
2. Rust layout tests porównują C++ `sizeof/alignof/offsetof` z Rust dla każdego
   pola envelope i sidecara, w tym wszystkich pointerów, digestów i liczników.
3. Handoff negative tests zmieniają osobno mesh, equilibrium, boundary/gauge i
   bias signature i oczekują `k0_poisson_airbox_signature_mismatch`.
4. Uruchom najpierw:

   ```bash
   just verify-fem-frequency-domain-native-contract
   ```

   **Oczekiwany RED:** nowe symbole/offsety lub wymagane rejection nie istnieją.

### GREEN

1. Dodaj enum, sidecar, osobny result v19, nowy out-param symbol i layout query;
   nie zmieniaj size/offset ani sygnatury v18.
2. Dodaj Rust FFI v19 z identycznymi typami i zachowaj równolegle binding v18.
   Dynamic loader wymaga v19 dla strict GPU i failuje przed solve, gdy symbolu
   brak.
3. Zaimplementuj ownership/destroy v19 w native solver boundary; legacy destroy
   pozostaje bez zmian.
4. Dodaj parser `NativeModalGpuAttestation` po stronie runnera. Przed każdym
   odczytem taila parser waliduje pointer/header/version/full V1 prefix, nie
   zamienia null/unknown/short na wartości domyślne i zachowuje operator kind,
   dimension, generation/reuse/invalidation oraz trzy key digests. Przy błędzie
   parser zwraca stabilny rejection, ale nadal oddaje cały envelope do biblioteki
   przez destroy v19.
5. Rozszerz handoff validation przed wejściem do adaptera GPU.
6. Nie ustawiaj jeszcze `MEASURED` w produkcyjnym solve; do T5 poprawnym
   wynikiem jest `UNAVAILABLE`, który utrzymuje fail-closed.
7. Dodaj cross-version test: v18 header+caller linkuje z nową biblioteką, nowy
   caller rozpoznaje starą bibliotekę i odrzuca strict GPU z exact tokenem.

### Weryfikacja

```bash
just verify-fem-frequency-domain-native-contract
cargo test -p fullmag-fem-sys --quiet
cargo test -p fullmag-runner --quiet native_fem
```

**Oczekiwany GREEN:** ABI i destroy testy przechodzą; GPU result bez attestation
nie może zostać oznaczony complete.

### Commit

Stage'uj wyłącznie wymienione pliki, sprawdź staged list osobno i utwórz:

```bash
git commit -m "feat(fem): add modal GPU execution attestation ABI"
```

---

## Zadanie T2B: zamrozić schemat derived validation registration

**Zależność:** T2.
**Lane:** wyłącznie integrator/schema owner.
**Cel:** T8, T9 i T10 mogą implementować się równolegle bez współdzielenia
parsera ani wymyślania różnych scope bindings.

**Utwórz:**

- `docs/specs/frequency-domain-validation-registration-v1.md`
- `docs/specs/frequency-domain-validation-registration-v1.schema.json`
- `docs/specs/frequency-domain-validation-coverage-v1.schema.json`
- `scripts/test_frequency_domain_validation_registration_schema.py`

### RED

1. Test wymaga exact schema version, `registration_id`, producer identity,
   `derived_validation_bundle_id`, posortowanych immutable `source_runs`,
   `subject_scope_bindings` i artifacts z `direct|coverage` binding.
2. Fixture odrzuca anonimowy scope hash bez kanonicznego `scope_id`, pojedynczy
   subject dla raportu CPU/GPU, niezależne listy run/scope, zamienione CPU/GPU
   binding, unknown scope, absolute/parent path, duplikat, symlink/hardlink, zły
   hash/size oraz coverage bez kompletnego sidecara.
3. Allowed scope IDs pierwszej wersji to dokładnie:
   - `modal_cpu_k0_periodic_airbox_real_shared_domain.production`;
   - `modal_gpu_k0_periodic_airbox_scalable.production`.
4. Uruchom test przed utworzeniem schemas; oczekiwany RED to brak plików/schema.

### GREEN

1. JSON Schema zamraża `additionalProperties=false`, wymagane pola, regex
   `^sha256:[0-9a-f]{64}$`, dodatni `size_bytes`, względne POSIX paths oraz
   unikalne arrays.
2. `subject_scope_bindings` jest niepustą, posortowaną listą
   `{scope_id, scope_sha256}`. `scope_sha256` jest digestem kanonicznego recordu
   z readiness scope catalog, nie zamiennikiem semantic ID.
3. `source_runs` jest niepustą, posortowaną po `run_id` listą obiektów
   `{run_id, bundle_uri, bundle_sha256, scope_id, scope_sha256, execution}`.
   `bundle_uri` jest znormalizowaną POSIX ścieżką zaczynającą się od `runs/`,
   rozwiązywaną względem stałego report root
   `.fullmag/reports/fem-eigen-k0/`; nie jest ścieżką względem derived bundle.
   `bundle_sha256` jest SHA-256 finalnego source bundle manifestu, który wiąże
   wszystkie source artifacts. Hash odpowiada source manifestowi, scope ID/digest odpowiada jednemu
   `subject_scope_bindings`, a `execution` jest zgodne z source manifestem.
   `run_id` i URI są unikalne; zamiana CPU/GPU lub niepowiązany run failują.
4. Artifact binding zawiera niepuste `scope_ids`, będące podzbiorem subject
   bindings. `direct` nie ma coverage rule. `coverage` wskazuje zahashowany
   `frequency_domain_validation_coverage.v1`, którego
   `required_scope_ids == observed_scope_ids` oraz
   `required_run_ids == observed_run_ids` po posortowaniu. Zbiory run IDs muszą
   być dokładnie podzbiorem związanych `source_runs` i istnieć w ich immutable
   source manifests.
5. Derived bundle manifest wskazuje te same source bundle URI/SHA-256 i nigdy nie
   pozwala validatorowi modyfikować source run bundle.
6. Test implementuje także semantyczne warunki, których sam JSON Schema nie
   wyraża: sortowanie, referential integrity, no-links i zgodność scope catalog.

### Weryfikacja

```bash
python3 -m json.tool \
  docs/specs/frequency-domain-validation-registration-v1.schema.json >/dev/null
python3 -m json.tool \
  docs/specs/frequency-domain-validation-coverage-v1.schema.json >/dev/null
python3 -m pytest -q \
  scripts/test_frequency_domain_validation_registration_schema.py
```

**Akceptacja T2B:** T8/T9/T10 konsumują te same immutable schemas; zmiana
schematu po rozdzieleniu lane'ów wymaga jawnego version bump i integrator review.

### Commit

```bash
git commit -m "docs: freeze frequency-domain validation registration v1"
```

---

## Zadanie T3: współdzielona, poświadczana polityka HYPRE CUDA

**Zależność:** T2.
**Lane:** Native GPU.
**Cel:** dokładnie modalny `PCHYPRE` działa z memory/execution policy device.

**Utwórz:**

- `backends/fem/gpu/cuda/runtime/hypre_device_policy.hpp`
- `backends/fem/gpu/cuda/runtime/hypre_device_policy.cpp`
- `backends/fem/tests/frequency_domain/gpu_hypre_device_policy_test.cpp`

**Modyfikuj:**

- `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp`
- `backends/fem/gpu/frequency_domain/modal_petsc_slepc.cpp`
- `backends/fem/CMakeLists.txt` wyłącznie przez integratora po przekazaniu patcha

### Docelowy kontrakt

```cpp
struct HypreDevicePolicySnapshot {
    bool configured;
    bool memory_location_device;
    bool execution_policy_device;
    bool vendor_sptrans_enabled;
    bool vendor_spmv_enabled;
    bool vendor_spgemm_enabled;
    int first_error_code;
    std::string failure_reason;
};

HypreDevicePolicySnapshot configure_hypre_cuda_device_policy() noexcept;
```

Funkcja jest idempotentna i thread-safe. Nie połyka błędów przez samo
`HYPRE_ClearAllErrors`; zachowuje pierwszy code/reason. Time-domain i modalny
solver używają tego samego ownera.

### RED

1. Test źródłowy/runtime wymaga, aby modalny adapter wywołał wspólną funkcję
   przed `PCSetType(PCHYPRE)` i przed `KSPSetUp`.
2. Negative injection ustawia failure któregoś HYPRE setter i oczekuje
   `k0_poisson_airbox_gpu_hypre_device_policy_unavailable`.
3. Snapshot z host memory albo host execution nie może przejść validation.
4. Uruchom:

   ```bash
   just verify-fem-frequency-domain-gpu-petsc-slepc-runtime
   ```

   **Oczekiwany RED:** modalny adapter nie posiada takiego attestation.

### GREEN

1. Przenieś politykę z anonimowej funkcji time-domain do wspólnego ownera.
2. Zachowaj time-domain zachowanie i testy.
3. Wywołaj owner w istniejącym `configure_schur_context` przed tworzeniem
   modalnego PC.
4. Wpisz snapshot do `FullmagFemModalGpuAttestationV1`; nie wpisuj stringu
   `device` bez rzeczywistego success snapshot.
5. W przypadku failure zakończ przed `EPSSolve` bez fallbacku.

### Weryfikacja

```bash
just verify-fem-time-domain-native-contract
just verify-fem-frequency-domain-native-contract
just verify-fem-frequency-domain-gpu-petsc-slepc-runtime
```

**Akceptacja T3:** oba konsumery używają jednego ownera; modalny result ma
policy snapshot; negative test failuje przed solve.

### Commit

```bash
git commit -m "feat(fem): attest HYPRE CUDA policy for modal solves"
```

---

## Zadanie T4: zweryfikować pełny PETSc/SLEPc object graph na urządzeniu

**Zależność:** T3.
**Lane:** Native GPU.
**Cel:** nie dopuścić ukrytego host-backed workspace mimo CUDA input/output.

**Modyfikuj:**

- `backends/fem/gpu/frequency_domain/modal_petsc_slepc.cpp`
- `backends/fem/tests/frequency_domain/gpu_petsc_slepc_runtime_test.cpp`
- `backends/fem/tests/frequency_domain/gpu_k0_modal_petsc_slepc_test.cpp`

### Docelowy helper

Dodaj w adapterze prywatny:

```text
verify_modal_device_object_graph(context, solver_state) ->
  success | k0_poisson_airbox_gpu_object_graph_not_device_resident
```

Helper sprawdza po `EPSSetUp`, ale przed `EPSSolve`, wyłącznie przez stabilne
publiczne API PETSc/SLEPc:

- każdy block `Mat` przez `MatGetType`;
- `MatShell` przez `MatShellGetContext` i `MatGetVecType`;
- mass, Fullmag-owned target/shift workspace i vectors z `MatCreateVecs`;
- Fullmag-owned RHS/solution/template vectors przekazywane do Poisson i shifted
  `KSP` oraz preconditioner matrix;
- `EPSGetBV`, wszystkie aktywne `BVGetColumn`, restore każdej kolumny;
- template Ritz/residual/reconstruction Vec;
- PC type `PCHYPRE` w production matrix-free lane;
- HYPRE snapshot z T3;
- brak `VECSEQ`, `VECSTANDARD`, `MATSEQAIJ` i `PCILU` w production lane.

Nie enumeruj prywatnych wektorów roboczych KSP przez niestabilne struktury
wewnętrzne. Ich alokacje, transfery i synchronizacje są kwalifikowane przez
NVTX + Nsight/CUPTI w T5. Dla konkretnego łańcucha preconditionera zapisz
publicznie dostępny `KSPGetPC`/`PCGetType`, PCHYPRE subtype/options, operator i
policy snapshot; globalny setter HYPRE sam nie jest dowodem rezydencji.

Każdy typ trafia do canonical object-graph JSON, sortowanego stabilnie przed
SHA-256. Nie przechowuj raw pointer addresses w digescie.

### RED

1. Rozszerz runtime fixture z prostego 3x3 do realnego
   `MatShell + STSINVERT + KSP + PCHYPRE + BV`.
2. Wstrzyknij kolejno CPU Vec dla:
   - shell output;
   - Fullmag-owned Poisson solution/template vector;
   - jednej kolumny BV;
   - preconditioner matrix.
3. Każda mutacja ma dać ten sam reason family z polem `failed_object`.
4. Materialized oracle musi nadal przejść jako
   `validation_only=true`, `scalable_selected_spectrum=false`.

### GREEN

1. Zaimplementuj traversal i stabilny object graph.
2. Wywołaj go po pełnym setup każdego target-dependent solver state i przy
   każdym reuse po zmianie subwindowu.
3. Ustaw `device_residency_verified` tylko na podstawie całego graphu i T3.
4. Nie ustawiaj jeszcze globalnego production complete bez T5 telemetry.

### Weryfikacja

```bash
just verify-fem-frequency-domain-gpu-petsc-slepc-runtime
just verify-fem-frequency-domain-eigen-k0-gpu-petsc-slepc
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action
```

**Akceptacja T4:** test rzeczywiście przechodzi przez modalny object graph;
każdy host-backed obiekt failuje przed eigensolve; validation oracle nie jest
promowany.

### Commit

```bash
git commit -m "test(fem): enforce device-resident modal PETSc object graph"
```

---

## Zadanie T5: zmierzyć transfery, synchronizacje, pamięć i identity GPU

**Zależność:** T4.
**Lane:** wyłącznie Native GPU; T13 jest jedynym właścicielem parsera/trace
scripts, a T8 jedynym właścicielem core artifact verifiera.
**Cel:** zastąpić deklarowane zera pomiarem i niezależnym trace.

**Utwórz:**

- `backends/fem/gpu/cuda/frequency_domain/modal_transfer_audit.hpp`
- `backends/fem/gpu/cuda/frequency_domain/modal_transfer_audit.cu`
- `backends/fem/tests/frequency_domain/modal_transfer_audit_test.cpp`

**Modyfikuj:**

- `backends/fem/gpu/frequency_domain/modal_petsc_slepc.cpp`
- `backends/fem/CMakeLists.txt` przez integratora
- `backends/fem/tests/frequency_domain/gpu_k0_modal_petsc_slepc_test.cpp`

ABI v19 jest zamrożone w T2. Jeżeli implementacja T5 odkryje brak pola, T5
zatrzymuje się i wraca przez integrator review/versioned ABI correction; Native
GPU lane nie edytuje samodzielnie `native/include/fullmag_fem.h` ani Rust FFI.

### Kontrakt pomiaru

1. Native audit liczy wszystkie transfery i alokacje należące do Fullmag w
   fazach `setup`, `hot_loop`, `export`.
2. `cudaMemGetInfo` zapisuje wyłącznie nieingerujące snapshoty na granicach
   `before setup`, `after setup`, `between subwindows`, `before export`,
   `after destroy`. Fullmag-owned allocator prowadzi własny high-water counter.
   Nie wywołuj `cudaMemGetInfo` przed/po każdym `MatMult` ani Poisson solve,
   ponieważ zaburzałoby to hot loop i nadal nie mierzyłoby wiarygodnie
   wewnętrznych alokacji PETSc/HYPRE. Biblioteczny peak i allocation timeline
   pochodzą z external Nsight/CUPTI trace.
3. NVTX ranges obejmują:
   - `fem.eigen.k0.setup`;
   - `fem.eigen.k0.hot_loop`;
   - `fem.eigen.k0.schur_apply`;
   - `fem.eigen.k0.poisson`;
   - `fem.eigen.k0.orthogonalization`;
   - `fem.eigen.k0.export`.
4. T5 emituje stabilne NVTX ranges i native counters. Dopiero T13-owned
   `scripts/capture_fem_eigen_k0_gpu_residency.py` używa `nsys profile`,
   eksportuje SQLite/CSV, klasyfikuje CUDA memcpy/memset/sync według tych ranges
   i zapisuje immutable external trace summary SHA-256.
5. Native `measurement_coverage` obejmuje jawne transfery Fullmag, object-graph
   checks i wszystkie małe eksporty skalarne. Qualification run rozszerza ten
   dowód o transfery wewnętrzne PETSc/SLEPc/HYPRE widoczne w Nsight.
6. Qualification run wymaga `measurement_state=MEASURED` oraz zgodności native
   i external counts. Zwykły późniejszy solve używa native attestation i wiąże
   się z immutable qualification-registry record kluczowanym tym samym
   runtime/source/device-policy/device scope. Brak `nsys`/trace jest blockerem
   kwalifikacji runtime, nie zerem.

### RED

1. Native audit contract test odrzuca fixture zawierający:
   - zero count przy `measurement_state=UNAVAILABLE`;
   - brak bytes;
   - computational hot-loop D2H o rozmiarze jednego pełnego Vec;
   - computational host sync w hot loop;
   - scalar telemetry event większy niż 256 bajtów albo count skalujący się z
     wymiarem operatora zamiast z callback count;
   - brak native trace digest albo niespójny native counter record;
   - brak UUID lub runtime manifest digest.
2. T13 unit tests parsera Nsight mają później obejmować H2D/D2H, async copy,
   sync i puste trace; T5 zamraża ich NVTX/counter input contract.
3. Native result z `measurement_state != MEASURED` nie może ustawić
   `device_residency_verified=1` ani complete strict-GPU result. T8 doda osobny
   test odrzucający stary JSON diagnostics.

### GREEN

1. Usuń stałe pola `per_iteration_* = 0` jako źródło prawdy.
2. Podłącz audit do setup, monitorowanej pętli i final export.
3. Pobierz rzeczywisty UUID przez CUDA Runtime/Driver API, a name/CC/driver/
   runtime z dokładnie wybranego device.
4. Zapisz wersje MFEM/HYPRE/PETSc/SLEPc z aktywnego runtime.
5. Native result zapisuje source snapshot/runtime digest i native trace digest.
   T13 wiąże external trace później w artifact-level qualification record; nie
   próbuj wpisywać postprocess trace SHA do resultu, który powstaje przed
   zakończeniem `nsys`.
6. Native success wymaga measured zero dla Fullmag-owned hot-loop
   computational-state bytes, computational syncs i full-vector crossings.
   Dopuszcza bounded scalar telemetry (`<=256` bajtów na event, count
   ograniczony callbackami) oraz final export zaakceptowanych mode fields. T8
   później odwzorowuje te pola do core artifact verifiera bez syntetycznych zer.

### Weryfikacja

Bez GPU:

```bash
just verify-fem-frequency-domain-native-contract
```

Na zatwierdzonym GPU, dopiero po T13 preflight:

```bash
just verify-fem-frequency-domain-eigen-k0-gpu-residency-trace
```

**Akceptacja T5:** `UNAVAILABLE + 0` nie przechodzi; native counters i NVTX
fazy są zaimplementowane; exact runtime/device/source hashes są obecne. External
trace qualification pozostaje jawnie do T13.

### Commit

```bash
git commit -m "feat(fem): measure modal GPU residency and transfers"
```

---

## Zadanie T6: domknąć session-scoped lifecycle i skalowalny matrix-free solve

**Zależność:** T5.
**Lane:** Native GPU.
**Cel:** persistent oznacza reuse w obrębie dokładnego solve/window, bez
procesowego singletona i bez produkcyjnego materialized operatora.

**Modyfikuj:**

- `backends/fem/gpu/frequency_domain/modal_petsc_slepc.cpp`
- `backends/fem/include/frequency_domain/modal_eigen_request.hpp`
- `backends/fem/include/frequency_domain/modal_eigen_result.hpp`
- `backends/fem/src/frequency_domain/modal_eigen_solver.cpp`
- `backends/fem/tests/frequency_domain/gpu_k0_modal_petsc_slepc_test.cpp`
- `backends/fem/tests/frequency_domain/window_partition_test.cpp`

### Docelowy model

Zastąp procesowe `cached_gpu_context()` przez RAII `GpuModalSessionContext`
utworzony dla jednego native modal request. Kontekst ma dwa poziomy i dwa
kanoniczne klucze liczone z length-prefixed binary preimage:

- `OperatorKey` zawiera: device UUID, precision/scalar representation, mesh
  generation/revision/topology fingerprint, certificate/map-binding digest,
  equilibrium i linearization digests, material digest, physics digest,
  operator-terms digest, boundary digest, gauge digest, bias-sample signature,
  FE family/order, demag/Poisson policy oraz matrix-free operator policy;
- `TargetKey` zawiera `OperatorKey` SHA-256 oraz target kind/frequency/window,
  subwindow bounds/index, requested mode count, spectral transform, shift,
  tolerance/max-iterations, EPS/KSP/PC solver policy i artifact completeness
  policy.

`OperatorState` przechowuje bloki, mapy, Poisson state i reusable workspaces
związane z dokładnym `OperatorKey`. `TargetState` przechowuje EPS/ST/shifted
KSP/PC/BV związane z dokładnym `TargetKey`. Attestation publikuje oba key
digests, session-context digest, operator kind/dimension, generation counters,
reuse/rebuild counts, invalidation flags i ostatni stabilny reason.

Mapa invalidation jest zamrożona:

| Zmiana/zdarzenie | OperatorState | TargetState | Reason |
|---|---|---|---|
| tylko target/window/subwindow/mode-count/EPS policy | zachowaj | zniszcz i odbuduj | `target_key_changed` |
| UUID, precision, mesh/certificate, equilibrium/linearization, material/physics/operator terms, BC/gauge, bias lub Poisson/operator policy | zniszcz | zniszcz | `operator_key_changed` |
| cancel przed setup | brak publikacji state | brak publikacji state | `cancelled_before_setup` |
| cancel/error w hot loop | zachowaj tylko do kontrolowanego unwind | zniszcz | `target_cancelled` lub exact failure |
| device loss | zniszcz | zniszcz | `device_lost` |
| identyczny kolejny subwindow request | zachowaj i zwiększ reuse | zachowaj tylko przy identycznym TargetKey | `exact_key_reuse` |

Każda invalidation zwiększa odpowiedni generation counter przed stworzeniem
nowego state. Nie wolno opierać reuse na adresie wskaźnika ani niepełnym digest.
Globalny mutex może pozostać wyłącznie jako udokumentowana ochrona
nie-thread-safe inicjalizacji PETSc/SLEPc, nie jako właściciel state.

Production routing:

```text
production_shared_domain && !validation_only
  => eigensolver_operator_kind=matrix_free_schur_cuda
  => poisson_pc_type=hypre
  => materialized shifted operator forbidden
```

`create_materialized_shifted_operator_cuda` i `PCILU` pozostają dostępne tylko
dla bounded validation fixture.

### RED

1. Test reuse z dwoma subwindows sprawdza:
   - ten sam OperatorState generation;
   - nowy TargetState generation;
   - brak ponownego setup upload bloków;
   - kompletność obu subwindows.
2. Test tabelaryczny mutuje osobno każde pole `OperatorKey` i `TargetKey`.
   Operator mutation zwiększa obie generations; target-only mutation wyłącznie
   TargetState generation. Każdy przypadek sprawdza dokładny reason.
3. Cancel przed setup, podczas pierwszego subwindowu i między subwindows nie
   może pozostawić stale cache.
4. Production test o rzeczywistym, odczytanym z native artifact
   `operator_dimension > 1024` ma failować, jeżeli wybiera materialization lub
   ILU. Wymiar wynika z realnego meshu, nie z labela ani oczekiwanej stałej.
5. Powtórzenia 10x sprawdzają stabilny final-minus-baseline memory envelope.

### GREEN

1. Wprowadź RAII i usuń `atexit` ownership production context.
2. Zachowaj cleanup PETSc objects w odwrotnej kolejności zależności.
3. Przenieś progress/cancel monitor do TargetState.
4. Egzekwuj matrix-free production routing przed setup.
5. Certyfikuj każdy subwindow; jeden failed/empty poza dozwoloną polityką daje
   `complete=false`.
6. Publikuj generation/reuse/invalidation w attestation.

### Weryfikacja

```bash
just verify-fem-frequency-domain-eigen-k0-gpu-petsc-slepc
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action
just verify-fem-frequency-domain-native-contract
```

Na realnym GPU dodatkowo trzy różne, rosnące przypadki matrix-free `small`,
`medium`, `large` przez recipe z T13; wszystkie raportują rzeczywisty wymiar z
native artifact, a co najmniej `large` ma `operator_dimension > 1024`.

**Akceptacja T6:** production nigdy nie wybiera materialized/ILU; reuse i
invalidation są deterministyczne; cancel nie wycieka; okno jest fail-closed.

### Commit

```bash
git commit -m "refactor(fem): scope modal GPU state to one solve session"
```

---

## Zadanie T7: usunąć runnerowe domyślne claimy i egzekwować fail-closed

**Zależność:** T2 i zatwierdzony schema z T5.
**Lane:** Runner/artifacts.
**Cel:** Rust nie może promować GPU na podstawie nazwy adaptera.

**Modyfikuj:**

- `crates/fullmag-runner/src/fem_eigen.rs`
- `crates/fullmag-runner/src/native_fem/frequency_domain.rs`
- `crates/fullmag-runner/src/eigen/diagnostics.rs`
- `crates/fullmag-runner/src/eigen/artifacts.rs`
- testy w `crates/fullmag-runner/src/fem_eigen.rs`
- `crates/fullmag-runner/src/types.rs` tylko dla typowanego internal modelu

### RED

Dodaj tests dla `native_solver_diagnostics_json` i
`insert_native_poisson_airbox_execution_provenance`:

1. Adapter string GPU + brak attestation nie tworzy `executable`, production
   claim ani `gpu_device_resident`.
2. Attestation `UNAVAILABLE` z zerami jest błędem stage.
3. `MEASURED` z hot-loop computational-state bytes/syncs >0 jest błędem stage;
   bounded scalar telemetry pozostaje legalna i jest raportowana osobno.
4. `MEASURED` z mismatch device/runtime/source digest jest błędem stage.
5. Pełne poprawne attestation jest serializowane bez zmiany wartości.
6. CPU result nie wymaga GPU sidecara i zachowuje host provenance.
7. Native `resolved_fallback_state != NONE` przy strict GPU jest błędem nawet,
   gdy solver zwróci status ok.

### GREEN

1. Usuń unconditional insertions:
   - `implementation_state="executable"`;
   - `production_periodic_airbox_claim=true`;
   - domyślne `device_residency="gpu_device_resident"`;
   - syntetyczne hot-loop zeros.
2. Zbuduj typowany `ValidatedNativeModalExecution` wyłącznie z result ABI.
3. Wymagaj exact source/runtime/device binding oraz `MEASURED` dla strict GPU
   completion. Production-qualified runtime claim wymaga dodatkowo immutable
   qualification record kluczowanego runtime manifest digest i exact device
   scope; native result nie może sam utworzyć tego rekordu.
4. Zachowaj requested i resolved execution osobno.
5. Mapuj exact native reason token bez utraty do stage error i artifacts.
6. Heartbeat publikuje prawdziwe subwindow/EPS/converged/residual, nie step count
   relaksacji.

### Weryfikacja

```bash
cargo test -p fullmag-runner --quiet fem_eigen
cargo test -p fullmag-runner --quiet native_fem
PYTHONPATH=packages/fullmag-py/src python3 -m pytest -q \
  scripts/test_validate_fem_periodic_antidot_relax_eigenmodes_runtime.py
```

**Akceptacja T7:** nie da się uzyskać zielonego production/residency claimu
samym solver adapter stringiem albo zadeklarowanymi zerami.

### Commit

```bash
git commit -m "fix(runner): require native proof for modal GPU claims"
```

---

## Zadanie T8: typowane, immutable i atomowo publikowane artefakty

**Zależność:** T7 i zamrożony T2B schema contract.
**Lane:** Runner/artifacts.
**Cel:** failed solve nie niszczy ostatniego poprawnego bundle, a każdy success
jest przyczynowo zamknięty.

**Modyfikuj:**

- `crates/fullmag-runner/src/eigen/artifacts.rs`
- `crates/fullmag-runner/src/fem_eigen.rs`
- `docs/specs/frequency-domain-artifacts-v2.md`
- `scripts/write_fem_frequency_domain_validation_bundle.py`
- `scripts/verify_fem_frequency_domain_eigen_artifacts.py`
- `scripts/test_write_fem_frequency_domain_validation_bundle.py`
- `scripts/test_verify_fem_frequency_domain_eigen_artifacts.py`
- `scripts/lib/managed_fem_report_storage.sh`

### RED

1. Fixture z przerwanym solve nie może podmienić final symlink/root.
2. Qualification fixture z brakującym external-trace sidecarem, albo zwykły
   run bez ważnego qualification-record reference, jest odrzucony. Każdy run z
   brakującym mode-field chunk, mesh identity albo SHA-256 także jest odrzucony.
3. Fixture z GPU diagnostics w nieustrukturyzowanym extras bez attestation ID
   jest odrzucony.
4. Dwa kolejne poprawne runy mają osobne run IDs i zachowują poprzedni bundle.
5. Symulowany verifier failure pozostawia staging pod `failed/`, nie final.
6. Registration fixture z absolutną ścieżką, `..`, symlinkiem, hardlinkiem,
   duplikatem, złym rozmiarem/SHA-256 albo brakującym coverage-rule sidecarem
   failuje przed publikacją.
7. `direct` z innym scope ID oraz `coverage` z niepełnym zbiorem source run
   scopes są odrzucane osobnymi reason tokens.
8. Stary diagnostics z `per_iteration_transfer_telemetry_measured=false`,
   brakującym v19 attestation, syntetycznym zerem, niezgodnym native/external
   digestem, złym operator kind/dimension albo brakującym lifecycle key/generation
   jest odrzucony i nie tworzy qualification record.

### GREEN

1. Pisz do unikalnego staging:

   ```text
   .fullmag/reports/fem-eigen-k0/runs/<run_id>.staging/
   .fullmag/reports/fem-eigen-k0/validations/<validation_run_id>.staging/
   ```

   Pierwszy root należy wyłącznie do solve. Drugi należy do postsolve
   validatora i tworzy osobny derived validation bundle. Validator otwiera
   source run bundles read-only, zapisuje ich URI/SHA-256/run IDs w derived
   manifest i nigdy nie dopisuje pliku do już opublikowanego source bundle.
2. Zapisz manifest last, po fsync/close wszystkich danych. Publikacja source run
   i derived validation bundle są dwiema niezależnymi atomowymi operacjami.
3. Validator liczy SHA-256 i sprawdza:
   source/runtime/device, spectrum/modes/Zarr, mesh identity, attestation oraz
   qualification record. Dla qualification runu sprawdza także native/external
   trace; zwykły run wskazuje immutable qualification record kluczowany runtime
   manifestem i device scope.
   Mapping z v19 zachowuje bez zmian operator kind/dimension, key digests,
   generation/reuse/invalidation, measured counters i native trace; runner nie
   syntetyzuje żadnego z tych pól.
4. Dodaj genericzny `validation_artifacts` registry w manifest stagingu. Pole
   manifestu ma dokładnie postać listy
   `{registration_path, registration_sha256}`, posortowanej po
   `registration_path`. Registration document leży pod
   `validation/registrations/<registration_id>.v1.json` i implementuje
   następujący kontrakt:

   ```json
   {
     "schema_version": "frequency_domain_validation_registration.v1",
     "registration_id": "cpu-gpu-parity-v2",
     "derived_validation_bundle_id": "validation-cpu-gpu-parity-000",
     "producer": {
       "id": "verify_fem_eigen_k0_periodic_airbox_cpu_gpu_parity",
       "version": "2.0.0",
       "source_sha256": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
     },
     "subject_scope_bindings": [
       {
         "scope_id": "modal_cpu_k0_periodic_airbox_real_shared_domain.production",
         "scope_sha256": "sha256:1111111111111111111111111111111111111111111111111111111111111111"
       },
       {
         "scope_id": "modal_gpu_k0_periodic_airbox_scalable.production",
         "scope_sha256": "sha256:4444444444444444444444444444444444444444444444444444444444444444"
       }
     ],
     "source_runs": [
       {
         "run_id": "cpu-field-000",
         "bundle_uri": "runs/cpu-field-000",
         "bundle_sha256": "sha256:5555555555555555555555555555555555555555555555555555555555555555",
         "scope_id": "modal_cpu_k0_periodic_airbox_real_shared_domain.production",
         "scope_sha256": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
         "execution": "cpu"
       },
       {
         "run_id": "gpu-field-000",
         "bundle_uri": "runs/gpu-field-000",
         "bundle_sha256": "sha256:6666666666666666666666666666666666666666666666666666666666666666",
         "scope_id": "modal_gpu_k0_periodic_airbox_scalable.production",
         "scope_sha256": "sha256:4444444444444444444444444444444444444444444444444444444444444444",
         "execution": "gpu"
       }
     ],
     "artifacts": [
       {
         "relative_path": "validation/k0_poisson_airbox/parity/coverage.v1.json",
         "artifact_schema_version": "frequency_domain_validation_coverage.v1",
         "sha256": "sha256:3333333333333333333333333333333333333333333333333333333333333333",
         "size_bytes": 1024,
         "binding": {
           "kind": "direct",
           "scope_ids": [
             "modal_cpu_k0_periodic_airbox_real_shared_domain.production",
             "modal_gpu_k0_periodic_airbox_scalable.production"
           ]
         }
       },
       {
         "relative_path": "validation/k0_poisson_airbox/parity/summary.v2.json",
         "artifact_schema_version": "fem_k0_cpu_gpu_parity.v2",
         "sha256": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
         "size_bytes": 4096,
         "binding": {
           "kind": "coverage",
           "scope_ids": [
             "modal_cpu_k0_periodic_airbox_real_shared_domain.production",
             "modal_gpu_k0_periodic_airbox_scalable.production"
           ],
           "coverage_rule": {
             "relative_path": "validation/k0_poisson_airbox/parity/coverage.v1.json",
             "schema_version": "frequency_domain_validation_coverage.v1",
             "sha256": "sha256:3333333333333333333333333333333333333333333333333333333333333333"
           }
         }
       }
     ]
   }
   ```

   `artifacts[].relative_path` i `coverage_rule.relative_path` są względne
   względem derived bundle root. `source_runs[].bundle_uri` jest względne
   względem stałego source report root `.fullmag/reports/fem-eigen-k0/` i musi
   zaczynać się od `runs/`. Wszystkie ścieżki normalizują się bez zmiany i
   wskazują zwykłe pliki należące do tego samego filesystemu; absolute, `..`,
   symlinki i hardlinki są zakazane. `subject_scope_bindings`,
   `source_runs`, `binding.scope_ids` i `artifacts` są niepuste, unikalne i
   posortowane. Każdy source run wiąże swój immutable bundle URI/SHA-256 z
   dokładnym semantic `scope_id`, scope digestem i execution; wartości muszą
   odpowiadać source manifestowi. Każde `scope_id` musi istnieć w T2B
   schema/catalog, a `scope_sha256` musi odpowiadać kanonicznym bajtom tego
   recordu. Dla `direct`
   wszystkie `binding.scope_ids` muszą należeć do subject bindings, a
   `coverage_rule` nie występuje. Dla `coverage`
   sidecar `frequency_domain_validation_coverage.v1` jest obowiązkowy, również
   znajduje się na liście artifacts i zawiera posortowane `required_scope_ids`
   oraz identyczne `observed_scope_ids`, a także posortowane
   `required_run_ids` i identyczne `observed_run_ids`; każdy ID musi wynikać ze
   związanych `source_runs` oraz ich source manifestów. Nieznana wersja schematu
   failuje. Każdy niezależny validator
   przekazuje ten dokument; core artifact writer weryfikuje bytes/bindings, ale
   nie importuje algorytmu Kittela ani parity.
5. Publikuj atomowym rename odpowiednio do `runs/<run_id>/` albo
   `validations/<validation_run_id>/`. Oddzielne wskaźniki `latest-run` i
   `latest-validation` wolno aktualizować dopiero po sukcesie właściwego
   validatora; derived publication nigdy nie zmienia source run.
6. Nigdy nie używaj `rm -rf` dla report root. Cleanup starych bundle jest
   osobnym, jawnym narzędziem poza solve.
7. Zapisz failed/interrupted staging z reason i partial certified modes.

### Weryfikacja

```bash
python3 -m pytest -q \
  scripts/test_write_fem_frequency_domain_validation_bundle.py \
  scripts/test_verify_fem_frequency_domain_eigen_artifacts.py
cargo test -p fullmag-runner --quiet
```

**Akceptacja T8:** publication jest atomowa i niekasująca; bundle bez dowodu
lub pola modu nie przechodzi.

### Commit

```bash
git commit -m "feat(fem): publish immutable modal evidence bundles"
```

---

## Zadanie T9: niezależny Kittel shape-first i CPU/GPU parity klastrów

**Zależność:** T2B; może biec równolegle z T3–T8.
**Lane:** Validation.
**Cel:** porównywać fizykę bez circular oracle i bez porównywania arbitralnej
kolejności zdegenerowanych eigenvectors.

**Modyfikuj:**

- `examples/fem_eigen_k0_kittel_periodic_airbox.py`
- `examples/fem_eigen_k0_kittel_periodic_airbox_gpu.py`
- `packages/fullmag-py/tests/test_api.py`
- `scripts/test_frequency_domain_runtime_targets.py`
- `scripts/verify_fem_eigen_k0_periodic_airbox_cpu_gpu_parity.py`
- `scripts/test_verify_fem_eigen_k0_periodic_airbox_cpu_gpu_parity.py`
- `scripts/verify_fem_eigen_k0_periodic_airbox_convergence.py`
- `scripts/test_verify_fem_eigen_k0_periodic_airbox_convergence.py`

**Utwórz:**

- `examples/assets/fem_frequency_domain/kittel_periodic_airbox_k0_v2.fixture.json`
- `scripts/verify_fem_k0_kittel_postsolve_v2.py`
- `scripts/test_verify_fem_k0_kittel_postsolve_v2.py`

### RED — Kittel

1. Fixture ma dwie bliskie gałęzie: jedna bliższa formule, druga ma właściwy
   uniform mode shape. Validator musi wybrać shape, nie mniejszy błąd Kittela.
2. Usuń reference z inputu pierwszej fazy selector i zapewnij testem, że zmiana
   `M_eff_reference` nie zmienia selected mode IDs.
3. Wymagaj:
   - uniform overlap `>=0.95`;
   - continuity/subspace overlap `>=0.85`;
   - full residual, tangent leakage i seam mismatch `<=1e-8`;
   - co najmniej 15 dodatnich pól w production sweep;
   - niezależnych trzech poziomów mesh i trzech poziomów padding.
4. Dopiero po zamrożeniu gałęzi załaduj reference i egzekwuj progi ze
   specyfikacji.
5. Test przykładu wymaga publicznego `BiasFieldSweep`, pojedynczego Gamma i
   braku `K0KittelFieldSweepValidation` w solver input.
6. Test wymaga complete frequency window i co najmniej kilku kandydatów; fixture
   z `N_MODES=1` ma failować jako niewystarczający do shape-first selection.
7. Production qualification fixture zawierający wyłącznie legacy
   `k0_kittel_validation`/`summary.v1` albo wynik starego
   `validate_k0_kittel_field_sweep` ma failować. Legacy verifier może pozostać
   tylko dla historycznych/validation-only bundle i nie może wystawić
   registration akceptowanej przez staged release.

### RED — parity

1. Fixture permutuje kolejność modów w klastrze; parity musi przejść.
2. Fixture obraca bazę w dwuwymiarowym zdegenerowanym subspace; parity musi
   przejść po alignment.
3. Fixture zmienia subspace, frequency cluster albo complex field ponad próg;
   odpowiednio failuje.
4. Egzekwuj:
   - frequency cluster relative delta `<=1e-8`;
   - invariant-subspace sine `<=1e-8`;
   - complex reconstructed field relative delta `<=1e-7`;
   - `eps_full<=1e-8` oddzielnie dla CPU i GPU;
   - accepted/rejected outcome mismatch count równy zero.

### GREEN

1. Podziel validator na jawne fazy:

   ```text
   load raw solved artifacts
   -> validate numerical eligibility
   -> shape-first cluster selection
   -> freeze selected IDs/subspaces
   -> load analytical reference
   -> Kittel compare and M_eff fit
   ```

2. Użyj mass inner product i phase/subspace alignment; nie porównuj vectorów
   element po elemencie przed alignment.
3. Raportuj multiplicity, cluster rank, principal angles i field delta.
4. Wymagaj distinct raw-run signatures dla każdego mesh/padding/field sample.
5. Egzekwuj maximum finest-two airbox-truncation delta `<=5e-3`. Jeżeli trzy
   ostatnie poziomy mesh albo padding nie są monotoniczne, wymagaj jawnego
   asymptotic fit z residualem mniejszym niż jedna czwarta odpowiedniego
   budżetu; nie wolno wybierać tylko najlepszego poziomu.
6. W obu przykładach zachowaj ten sam istniejący sweep 15 pól liniowo od
   `mu0*H=5 mT` do `100 mT`, ale przekaż go jako
   `fm.BiasFieldSweep(samples_a_per_m=bias_fields_a_per_m, equilibrium_policy="continuation",
   continuation_seed="previous_accepted_equilibrium")`. Ustaw dokładnie
   `k_vector=(0.0, 0.0, 0.0)` i usuń KPath używany jako nośnik pola.
7. Zastąp `N_MODES=1` przez `N_MODES=12`, użyj
   `target="frequency_window"`, `frequency_min=1.0e6`,
   `frequency_max=25.0e9` i eksportuj zespolone pola wszystkich zaakceptowanych
   mode IDs potrzebnych do shape/subspace parity. Failed subwindow lub
   niecertyfikowana kompletność blokuje fixture.
8. Przenieś analytical oracle do
   `kittel_periodic_airbox_k0_v2.fixture.json`. Fixture zawiera schema/fixture/
   oracle/reference IDs, source URI i SHA-256, `M_eff_reference_A_per_m`, jego
   uncertainty, dokładne 15 pól A/m, production tolerances oraz scope binding.
   Runner nie czyta tego pliku; ładuje go dopiero postsolve validator.
   Użyj `M_eff_reference_A_per_m=800000.0` jako nominalnej wartości wynikającej
   z exact benchmark input `Ms=800000 A/m`, nie jako zmierzonej stałej
   materiałowej. Zapisz `reference_value_kind="exact_benchmark_input"` i
   `standard_uncertainty_A_per_m=0.0`; zero oznacza brak niepewności authored
   inputu, nie niepewność eksperymentalną. Fixture ma dwa odrębne źródła:
   `equation_reference_id="Kittel1948"` z DOI
   `10.1103/PhysRev.73.155` dla wzoru oraz
   `material_parameter_reference_id="NIST_SP4"` z URI
   `https://www.ctcms.nist.gov/~rdm/std4/spec4.html` dla nominalnego `Ms`.
   Każdy wpis ma bibliographic ID, URI, retrieval timestamp i SHA-256
   zamrożonego lokalnego source snapshotu. Derivation ID opisuje idealny
   in-plane thin-film limit `M_eff_reference=Ms_reference`; applicable scope
   wymaga dokładnie tego materiału i geometrii/założeń zapisanych w fixture.
   Pobranie i zamrożenie źródeł wykonuje jawna jednorazowa procedura fixture
   preparation; solver i qualification run nie korzystają z sieci.
9. Zmień convergence validator na v2 artifacts i oddzielne trzy poziomy już
   używane przez recipe: mesh `(24/12, 20/10, 16/8) nm` przy airbox factor 9
   oraz padding factors `(5, 7, 9)` na stałym fine mesh `16/8 nm`.
10. Standalone `verify_fem_k0_kittel_postsolve_v2.py` zapisuje wyłącznie:
    `selection.v2.json`, `points.v2.csv` z sidecar manifestem, `fit.v2.json`,
    `summary.v2.json`, osobne mesh/padding convergence CSV z sidecarami oraz
    `coverage.v1.json` i
    `validation/registrations/kittel-postsolve-v2.v1.json` zgodne dokładnie z
    genericznym `validation_artifacts` contract T8. Nie importuje go runner i
    nie modyfikuje core artifact verifier.
11. Core artifact verifier sprawdza jedynie mechaniczny registration contract.
    Production qualification wymaga dokładnie registration ID
    `kittel-postsolve-v2`, schema v2 artifacts i shape-first selection record;
    obecność legacy Kittel extras nie zaspokaja tego wymagania.
12. Parity validator publikuje osobny derived bundle
    `validations/<parity_validation_run_id>/` z
    `validation/registrations/cpu-gpu-parity-v2.v1.json` i coverage sidecarem.
    Kittel/convergence validator analogicznie publikuje
    `validations/<kittel_validation_run_id>/` z
    `validation/registrations/kittel-postsolve-v2.v1.json`. Oba wskazują
    posortowane `source_runs` z immutable bundle URI/manifest SHA-256, run ID,
    kanonicznym CPU/GPU scope ID/digestem i execution z T2B; każdy binding musi
    odpowiadać source manifestowi i nigdy nie mutuje `runs/<run_id>/`.

### Weryfikacja

```bash
python3 -m pytest -q \
  scripts/test_verify_fem_k0_kittel_postsolve_v2.py \
  scripts/test_verify_fem_eigen_k0_periodic_airbox_cpu_gpu_parity.py \
  scripts/test_verify_fem_eigen_k0_periodic_airbox_convergence.py
PYTHONPATH=packages/fullmag-py/src python3 -m pytest -q \
  packages/fullmag-py/tests/test_api.py
python3 -m pytest -q scripts/test_frequency_domain_runtime_targets.py
```

**Akceptacja T9:** Kittel reference nie wpływa na branch selection; degeneracy
jest porównywana subspace-aware; wszystkie progi są jawne w raporcie.

### Commit

```bash
git commit -m "test(fem): validate K0 modes by shape and invariant subspace"
```

---

## Zadanie T10: domknąć walidator pełnego `relax -> eigensolve` antydot

**Zależność:** T9 i kontrakt T7/T8.
**Lane:** Validation.
**Cel:** przykład użytkowy dowodzi jednego meshu, zaakceptowanego equilibrium,
spektrum i wizualizowalnych modów.

**Modyfikuj:**

- `examples/fem_periodic_antidot_relax_eigenmodes.py`
- `packages/fullmag-py/tests/test_periodic_antidot_eigenmodes_example.py`
- `scripts/validate_fem_periodic_antidot_relax_eigenmodes_runtime.py`
- `scripts/test_validate_fem_periodic_antidot_relax_eigenmodes_runtime.py`
- `scripts/test_fem_frequency_domain_native_recipe.py`

### RED

Dodaj fixtures odrzucające osobno:

- drugie wywołanie mesh generatora;
- zmianę mesh generation/revision/topology fingerprint;
- zmianę node count/indexing/part registry;
- equilibrium niezaakceptowane lub content SHA mismatch;
- resampling/interpolation marker;
- pusty spectrum albo mniej modów niż żądano bez window certificate;
- brak complex `delta_m` field chunks albo brak natywnego `eps_phi` w
  diagnostics; `phi` nie jest publicznym Zarr/UI field w tym scope;
- mode field z innym `source_mesh_identity`;
- strict GPU z fallbackiem, niezmierzoną residency albo stale runtime;
- brak final attestation i artifact manifest;
- brak `periodic-antidot-e2e-v1` registration/coverage albo próba dopisania
  validation output do immutable source run bundle.

### GREEN

1. Skrypt pozostaje płaski, module-level `study`; nie dodawaj frameworka helperów.
2. Geometry/mesh powstaje raz. Relax i eigensolve używają tego samego frozen
   mesh asset/generation.
3. Eigensolve pobiera accepted equilibrium z poprzedniego stage przez canonical
   handoff; nie ładuje ponownie geometrii.
4. Validator wiąże:

   ```text
   script intent
   -> ProblemIR plan
   -> mesh certificate
   -> accepted equilibrium
   -> native request/result
   -> spectrum/mode fields
   -> source mesh identity
   -> GPU attestation
   ```

5. W trybie CPU pomija tylko GPU attestation, nie mesh/physics/residual gates.
6. W trybie GPU wymaga measured proof i no fallback.
7. Każde wykonanie walidatora publikuje osobny derived bundle
   `validations/<antidot_validation_run_id>/` z coverage sidecarem oraz
   `validation/registrations/periodic-antidot-e2e-v1.v1.json`. Registration
   wskazuje posortowane `source_runs` dla immutable relax/eigensolve bundle:
   URI, manifest SHA-256, run ID, kanoniczny CPU/GPU scope ID/digest i execution
   z T2B; każdy wpis odpowiada source manifestowi, a source bundles pozostają
   tylko do odczytu.

### Weryfikacja

```bash
PYTHONPATH=packages/fullmag-py/src python3 -m pytest -q \
  packages/fullmag-py/tests/test_periodic_antidot_eigenmodes_example.py \
  scripts/test_validate_fem_periodic_antidot_relax_eigenmodes_runtime.py \
  scripts/test_fem_frequency_domain_native_recipe.py
```

**Akceptacja T10:** validator wykrywa każdy remesh/handoff drift i każdy brak
pola modu; CPU i GPU mają ten sam scientific contract.

### Commit

```bash
git commit -m "test(fem): certify periodic antidot relax-to-modes handoff"
```

---

## Zadanie T11: zastąpić API extras typowanym execution attestation

**Zależność:** T5 oraz zamrożony T2/T5 JSON schema.
**Lane:** API; generated files scala integrator.
**Cel:** UI nie parsuje luźnych kluczy i nie zgaduje statusu GPU.

**Modyfikuj:**

- `crates/fullmag-api/src/router_v2/handlers/analysis/frequency_domain.rs`
- `crates/fullmag-api/src/router_v2/mod.rs`
- `crates/fullmag-api/src/router_v2/tests.rs`
- `crates/fullmag-api/src/schemas/runtime.rs` jeśli progress jest współdzielony
- `crates/fullmag-api/src/types.rs` dla process-scoped qualification root i
  wspólnego publicznego typu
- `docs/specs/resource-first-control-room-api-v2.md`
- `apps/control-room/src/kernel/api/generated/openapi-v2.json` przez integratora
- `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts` przez integratora
- `apps/control-room/src/kernel/api/generated/openapi-v2-client.ts` przez integratora
- `apps/control-room/src/kernel/api/apiPaths.ts`

### Docelowe payloady

```text
FrequencyDomainExecutionAttestationPayload
  schemaVersion, measurementState, outcome
  requestedExecution, resolvedExecution, fallback
  device, objectGraph, hyprePolicy, transfers, memory
  sourceSnapshotSha256, runtimeManifestSha256
  nativeTraceSha256, qualificationEvidenceSha256

FrequencyDomainGpuDeviceIdentityPayload
  uuid, name, computeCapability, driverVersion, runtimeVersion

FrequencyDomainGpuObjectGraphPayload
  vecType, matrixType, matShellVecType, bvType, epsType, stType, kspType
  poissonPcType, shiftPcType, operatorKind, operatorDimension
  productionSharedDomain, validationOnly
  operatorKeySha256, targetKeySha256, sessionContextSha256
  operatorStateGeneration, targetStateGeneration
  operatorReuseCount, targetRebuildCount, invalidationFlags
  lastInvalidationReason

FrequencyDomainGpuTransferAuditPayload
  setup, hotLoop, export
  setup/export: h2dCount, h2dBytes, d2hCount, d2hBytes
  hotLoop: computationalH2dCount/Bytes, computationalD2hCount/Bytes
  scalarTelemetryD2hCount/Bytes, scalarTelemetrySyncs
  fullVectorCrossings, computationalHostSyncs, allocations

FrequencyDomainSolverProgressPayload
  phase, subwindowIndex, subwindowCount, epsIteration
  convergedPairCount, requestedModeCount, bestResidual, stopReason

FrequencyDomainQualificationAttestationPayload
  schemaVersion, status, qualificationId, validatedScopeBindings
  qualifiedRuntimeCommitOid, runtimeSourceSnapshotSha256, runtimeManifestSha256
  governancePromotionCommitOid, scientificManifestRelativePath
  scientificManifestSha256
  allowlistDiffSha256, verifierRecords, attestationSha256
  rejectionReasons

FrequencyDomainQualificationScopeBindingPayload
  scopeId, scopeSha256, execution

FrequencyDomainQualificationVerifierRecordPayload
  name, recordSha256, outcome
```

Wszystkie liczniki są integer >=0. `measurementState=measured` wymaga pełnego
payloadu; `unavailable/failed` wymaga reason i nie może mieć outcome `qualified`.
Scientific manifest referuje hash-bound verifier records, w tym external trace
SHA. Są to osobne immutable rekordy release, nie pola native ABI.

Dodaj zasób
`GET /v2/sessions/current/analysis/frequency-domain/eigen/qualification.v1`,
czytający wyłącznie
`.fullmag/qualification/fem-k0/releases/<qualification_id>/promotion_attestation.v1.json`,
gdzie `qualification_id` pochodzi z exact capability binding, a nie z parametru
HTTP. Brak pliku, nieznany schema version, mismatch R1/G2-governance/scope/
manifest/allowlist/verifier outcome albo zły digest attestation daje status
`unvalidated`, nigdy syntetyczne `qualified=true`. W pierwszej wersji kontrakt
jest hash-bound, ale nie udaje podpisu kryptograficznego; ewentualny trust-store
i podpis wymagają osobnego ADR.

`AppState` otrzymuje read-only `frequency_domain_qualification_root`. W zwykłym
runtime jest to
`<repo_root>/.fullmag/qualification/fem-k0/releases`. Wyłącznie process startup
może nadpisać go przez
`FULLMAG_FREQUENCY_DOMAIN_QUALIFICATION_ROOT` dla prepublication smoke T15.
Handler kanonikalizuje root raz przy starcie i dołącza jedynie zweryfikowany
`qualification_id` z capability binding; HTTP nie przyjmuje ścieżki ani rootu.
Smoke wskazuje `.../prepared`, produkcja `.../releases`, dzięki czemu dokładnie
te same typed handler/UI bytes są testowane przed atomic rename.
`scientific_manifest.relative_path` musi być dokładnie normalną relatywną POSIX
ścieżką bez `..`, symlinków i separatorów platformowych. Handler rozwiązuje ją
wyłącznie względem
`<frequency_domain_qualification_root>/<qualification_id>/`, wymaga zwykłego
pliku wewnątrz tego katalogu i ponownie liczy jego SHA-256. Attestation nie
zawiera ścieżki `prepared/` ani `releases/`, dlatego ten sam rekord działa przed
i po atomowym rename bez specjalnego mapowania przyszłej ścieżki.

### RED

1. OpenAPI tests wymagają konkretnych `$ref`, required fields i enums.
2. Handler odrzuca measured payload bez UUID, digestu lub phase counters.
   Dla production GPU odrzuca też brak/zero operator dimension, inny operator
   kind, validation-only flag, brak key digests lub generation/invalidation
   telemetry.
3. Handler zachowuje CPU diagnostics bez GPU payload.
4. Mode field meta nadal wskazuje binary data plane i source mesh identity.
5. Nie wolno dodać GPU attestation do cienkiego session status.
6. Qualification endpoint odrzuca osobno brak/mismatch runtime commit,
   governance commit, scientific manifest, scope, allowlist digest, verifier
   record i attestation digest.
7. Test AppState root odrzuca niekanoniczny/traversal override i brakujący
   override root; brak domyślnego `releases/` przed pierwszą kwalifikacją jest
   dozwolony i endpoint zwraca `unvalidated`. Fixture prepared root działa
   wyłącznie przez process config, nigdy query.

### GREEN

1. Dodaj typowane Rust structs z `Serialize`, `Deserialize`, `ToSchema`.
2. Zamień `FrequencyDomainArtifactExtras` tylko w diagnostics/execution
   powierzchni wymaganej przez ten scope; nie refaktoruj wszystkich innych
   artifact families.
3. Zaktualizuj handler i OpenAPI.
4. Wygeneruj frontend types repozytoryjnym istniejącym workflow; nie edytuj
   wygenerowanych typów ręcznie.

### Weryfikacja

```bash
cargo test -p fullmag-api --quiet router_v2
pnpm --dir apps/control-room typecheck
```

Wygeneruj i sprawdź klienta repozytoryjnym workflow:

```bash
pnpm --dir apps/control-room generate:api
before="$(sha256sum \
  apps/control-room/src/kernel/api/generated/openapi-v2.json \
  apps/control-room/src/kernel/api/generated/openapi-v2-types.ts \
  apps/control-room/src/kernel/api/generated/openapi-v2-client.ts)"
pnpm --dir apps/control-room generate:api
after="$(sha256sum \
  apps/control-room/src/kernel/api/generated/openapi-v2.json \
  apps/control-room/src/kernel/api/generated/openapi-v2-types.ts \
  apps/control-room/src/kernel/api/generated/openapi-v2-client.ts)"
test "$before" = "$after"
```

Hash każdego pliku po pierwszym i drugim generowaniu musi być identyczny.

**Akceptacja T11:** attestation i progress są typowane end-to-end; ciężkie pola
nie trafiają do JSON status; generated types są zgodne z OpenAPI.

### Commit

```bash
git commit -m "feat(api): type modal GPU execution attestation"
```

---

## Zadanie T12: Results, residency Inspector i wizualizacja modów

**Zależność:** T7, T8, T11 oraz istniejący mode-field overlay contract.
**Lane:** Control Room.
**Cel:** użytkownik widzi spectrum, wybiera mode, widzi jego pole i potrafi
odróżnić measured full-GPU od unqualified source claim.

**Modyfikuj:**

- `apps/control-room/src/kernel/resources/studyRuntimeResources.ts`
- `apps/control-room/src/kernel/resources/studyRuntimeResources.test.ts`
- `apps/control-room/src/kernel/resources/modeFieldOverlayResources.ts`
- `apps/control-room/src/kernel/resources/modeFieldOverlayResources.test.ts`
- nowy `apps/control-room/src/kernel/resources/frequencyDomainQualificationResources.ts`
- nowy `apps/control-room/src/kernel/resources/frequencyDomainQualificationResources.test.ts`
- `apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyDomainResultInspectors.tsx`
- `apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyDomainModalInspectors.tsx`
- dedykowany nowy plik
  `apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyDomainExecutionAttestation.tsx`
- nowy test
  `apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyDomainExecutionAttestation.test.tsx`
- `apps/control-room/src/modules/inspector/panels/FrequencyDomainInspectorPanel.test.tsx`
- `apps/control-room/src/modules/inspector/panels/FrequencyDomainTables.test.tsx`
- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`
- istniejące mode overlay/controller tests tylko gdy wymagane przez bug

### RED — Results i Inspector

1. Spectrum renderuje Hz/GHz, mode ID, cluster, multiplicity i residual.
2. Selection wywołuje istniejące `analysis.eigen.plot-mode-3d` i wiąże request z
   revision/topology fingerprint.
3. `Execution & residency` pokazuje:
   requested/resolved device, UUID/name/CC, library versions, PETSc/SLEPc/HYPRE
   types/policy, setup/hot-loop/export transfer bytes, peak memory, fallback,
   source/runtime/trace digest skróty i outcome.
4. `measurementState=unavailable` pokazuje jawny warning i nigdy badge
   `Full GPU verified`.
5. CPU result pokazuje `Host execution`, nie brak danych jako błąd.
6. Stage progress pokazuje subwindow, EPS iteration, converged pairs, residual
   i cancel state.
7. Badge `Production qualified` wymaga typowanego qualification resource i
   zgodności R1/G2-governance/scientific manifest/scope/allowlist/verifier
   records. Capability matrix bez tego zasobu nie wystarcza.

### RED — mode fields i viewport

1. Dla CPU i GPU osobno widoki `real`, `imag`, `magnitude`, `phase` oraz
   `phase_rotated_real` korzystają z jednego complex field contract.
2. Phasor animation zmienia fazę, nie pobiera ponownie topologii co frame.
3. Stale revision/topology response jest odrzucony i nie nadpisuje last-valid
   field.
4. Mode field o innym `source_mesh_identity` nie renderuje się.
5. Hidden/inactive overlay nie utrzymuje listenera ani aktywnego render loop.
6. Zmiana widoku/fazy zmienia field buffer, ale nie topology object identity ani
   topology upload count.
7. Pięćdziesiąt cykli mode/view on-off nie zwiększa liczby listenerów,
   rendererów ani aktywnych animation loops po cleanup.

### GREEN

1. Użyj wyłącznie centralnego typed client/resource hooks; żadnego `fetch()` w
   komponencie.
2. `frequencyDomainQualificationResources.ts` używa generated path/type,
   resource key zawierającego session/revision/scope i zachowuje ostatni ważny
   payload podczas refresh; `unvalidated` jest poprawnym danym, nie błędem
   transportu.
3. Zachowaj ostatni poprawny spectrum/mode field podczas background refresh.
4. Dodaj dedykowany Inspector, nie generyczny raw JSON dump.
5. Nie twórz drugiego viewportu. Rozszerz istniejący analysis overlay intent.
6. Używaj istniejących `--fm-*` tokens, `fm-` CSS classes i shared primitives.
7. Ogranicz animation invalidation do aktywnego phase animation.

### Weryfikacja jednostkowa

```bash
env TMPDIR=/tmp pnpm --dir apps/control-room test -- \
  src/modules/inspector/panels/FrequencyDomainInspectorPanel.test.tsx \
  src/modules/inspector/panels/frequency-domain/FrequencyDomainExecutionAttestation.test.tsx \
  src/modules/inspector/panels/FrequencyDomainTables.test.tsx \
  src/kernel/resources/frequencyDomainQualificationResources.test.ts \
  src/kernel/resources/modeFieldOverlayResources.test.ts \
  src/kernel/visualization/ModeFieldOverlayIntentController.test.ts \
  src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts
pnpm --dir apps/control-room typecheck
```

Przed uznaniem UI za zakończone uruchom `react-doctor` zgodnie z repo skill i
usuń tylko regresje wynikające z tego zadania.

### Browser smoke

Na zintegrowanym runtime:

1. Otwórz Results -> Eigenmodes -> Spectrum.
2. Wybierz co najmniej trzy mody z różnych klastrów.
3. Dla każdego i dla CPU/GPU sprawdź `real`, `imag`, `magnitude`, `phase`,
   `phase_rotated_real` i phasor animation.
4. Sprawdź `gl.isContextLost() === false`, niezerowy drawing buffer i widoczny
   canvas.
5. Sprawdź topology fingerprint i mode field revision w diagnostics.
6. Sprawdź brak błędów console/network, brak request interception/fixture
   substitution oraz rzeczywistą zmianę binary field buffer przy stałej
   topology identity.
7. Zapisz screenshot spectrum, Inspector attestation i każdego wybranego modu.

**Akceptacja T12:** spectrum i mody działają przez real API/data plane; GPU
badge jest prawdomówny; WebGL i identity są potwierdzone interaktywnie.

### Commit

```bash
git commit -m "feat(control-room): inspect and render FEM K0 GPU modes"
```

---

## Zadanie T13: managed GPU preflight, matrix-free tiers i komplet evidence

**Zależność:** T6, T8, T9, T10.
**Lane:** Evidence/integration.
**Cel:** wszystkie native dowody pochodzą z container-backed `just`, exact
source snapshot i realnego GPU.

**Utwórz:**

- `scripts/capture_fem_eigen_k0_gpu_residency.py`
- `scripts/test_capture_fem_eigen_k0_gpu_residency.py`
- `scripts/verify_fem_k0_governance_promotion.py`
- `scripts/test_verify_fem_k0_governance_promotion.py`

**Modyfikuj:**

- `justfile`
- `docker/fem-gpu/Dockerfile` tylko jeżeli zatwierdzony tool rzeczywiście
  nie istnieje w obrazie
- `compose.yaml` tylko jeżeli preflight wykaże błąd deklaracji GPU
- `scripts/capture_fem_eigen_k0_periodic_airbox_performance.py`
- testy recipe w `scripts/test_fem_frequency_domain_native_recipe.py`
- `scripts/export_fem_gpu_runtime.sh` i storage helpers wyłącznie przez
  właściciela runtime, bez obchodzenia locka

### Nowe recepty

Dodaj dokładnie:

```text
verify-fem-frequency-domain-gpu-device-preflight
verify-fem-frequency-domain-eigen-k0-gpu-residency-trace
verify-fem-frequency-domain-eigen-k0-gpu-matrix-free-tier tier
verify-fem-frequency-domain-eigen-k0-gpu-memcheck
verify-fem-frequency-domain-eigen-k0-gpu-racecheck
verify-fem-frequency-domain-eigen-k0-gpu-synccheck
stage-fem-frequency-domain-eigen-k0-qualification qualification_id
verify-fem-frequency-domain-eigen-k0-staged-release qualification_id
verify-fem-frequency-domain-eigen-k0-candidate-binding qualification_id
prepare-fem-frequency-domain-eigen-k0-production-release qualification_id runtime_commit governance_commit
publish-fem-frequency-domain-eigen-k0-production-release qualification_id runtime_commit governance_commit
verify-fem-frequency-domain-eigen-k0-promotion-api-ui qualification_id
```

### Trwałe katalogi i kontrakt promocji

Recepty używają wyłącznie następujących korzeni na jednym trwałym filesystemie:

```text
.fullmag/qualification/fem-k0/staging/<qualification_id>/
  cpu/ gpu/ browser/ sanitizer/ trace/ records/
.fullmag/qualification/fem-k0/candidates/<qualification_id>/
  scientific_manifest.v1.json
.fullmag/qualification/fem-k0/post-assembly/<qualification_id>/
  candidate_binding.v1.json
.fullmag/qualification/fem-k0/governance/<qualification_id>/
  allowlist_diff.v1.json
.fullmag/qualification/fem-k0/prepublication/<qualification_id>/
  api_ui_smoke.v1.json
.fullmag/qualification/fem-k0/prepared/<qualification_id>/
  scientific_manifest.v1.json
  governance/allowlist_diff.v1.json
  verification/candidate_binding.v1.json
  promotion_attestation.v1.json
  promotion_attestation.v1.sha256
.fullmag/qualification/fem-k0/releases/<qualification_id>/
  scientific_manifest.v1.json
  governance/allowlist_diff.v1.json
  verification/candidate_binding.v1.json
  promotion_attestation.v1.json
  promotion_attestation.v1.sha256
```

`stage-*` przyjmuje istniejące immutable producer outputs, kopiuje zwykłe pliki
bez symlinków i hardlinków, po każdym kopiowaniu ponownie sprawdza size/SHA-256
i zapisuje staging index last. `verify-*staged-release` konsumuje staging,
tworzy tymczasowy candidate na tym samym filesystemie, weryfikuje cały causal
DAG i atomowo publikuje `candidates/<qualification_id>`; nie uruchamia solve,
browser capture ani sanitizerów. `publish-*production-release` działa dopiero
po `G2-governance`, ale jest rozdzielony na prepare/smoke/publish:

1. `verify-*candidate-binding` po assembly hashuje candidate i wszystkie
   capture records, zapisując osobny `candidate_binding.v1.json` poza candidate;
2. `prepare-*production-release` kopiuje zweryfikowany candidate, candidate
   binding i governance verifier record do `prepared/<qualification_id>`,
   weryfikuje allowlist diff i obie tożsamości, zapisuje attestation oraz jej
   zewnętrzny SHA-256 sidecar last i wykonuje fsync;
3. `verify-*promotion-api-ui` uruchamia rzeczywisty API/UI z process-only
   qualification root wskazującym prepared directory, sprawdza typowany resource
   i badge, a pass record wiąże pełny prepared-tree digest i attestation digest;
4. `publish-*production-release` nie kopiuje i nie modyfikuje bajtów. Wymaga
   ważnego prepublication smoke record dla identycznego prepared-tree digest i
   dopiero wtedy atomowo rename'uje prepared directory do
   `releases/<qualification_id>`.

Przy błędzie można usunąć wyłącznie własny nieopublikowany prepared/temp;
staging, candidate i istniejący release pozostają nietknięte. Canonical release
nie staje się widoczny przed przejściem realnego API/UI smoke.

`promotion_attestation.v1.json` ma dokładnie następujący kształt logiczny:

```json
{
  "schema_version": "fem_k0_promotion_attestation.v1",
  "status": "production_qualified",
  "qualification_id": "fem-k0-6dc0f60b654d-20260811T120000Z",
  "qualified_runtime_commit_oid": "6dc0f60b654dce0ae97aba68639c7e23499a696e",
  "runtime_source_snapshot_sha256": "sha256:4444444444444444444444444444444444444444444444444444444444444444",
  "runtime_manifest_sha256": "sha256:5555555555555555555555555555555555555555555555555555555555555555",
  "governance_promotion_commit_oid": "7777777777777777777777777777777777777777",
  "scientific_manifest": {
    "relative_path": "scientific_manifest.v1.json",
    "sha256": "sha256:6666666666666666666666666666666666666666666666666666666666666666"
  },
  "validated_scope_bindings": [
    {
      "scope_id": "modal_cpu_k0_periodic_airbox_real_shared_domain.production",
      "scope_sha256": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      "execution": "cpu"
    },
    {
      "scope_id": "modal_gpu_k0_periodic_airbox_scalable.production",
      "scope_sha256": "sha256:4444444444444444444444444444444444444444444444444444444444444444",
      "execution": "gpu"
    }
  ],
  "allowlist_diff_sha256": "sha256:8888888888888888888888888888888888888888888888888888888888888888",
  "verifier_records": [
    {
      "name": "fem-k0-definition-of-done",
      "record_sha256": "sha256:9999999999999999999999999999999999999999999999999999999999999999",
      "outcome": "pass"
    }
  ],
  "publisher_version": "fem-k0-release-publisher.v1",
  "prepared_at_utc": "2026-08-11T12:00:00Z"
}
```

Wartości przykładowe pokazują format, nie expected runtime identity. Produkcja
wymaga pełnych OID, prefiksowanych 64-hex SHA-256, unikalnych/posortowanych
scope bindings i verifier records oraz `outcome="pass"` dla każdego wymaganego
rekordu. SHA samej attestation znajduje się wyłącznie w sidecarze, aby uniknąć
self-hash cycle. `scientific_manifest.relative_path` jest rozwiązywane względem
`<configured_root>/<qualification_id>/` i musi pozostać wewnątrz tego katalogu;
handler ponownie liczy SHA-256 przed zwróceniem qualified. Capability binding z
`G2-governance` przechowuje `qualification_id`, R1 OID i scientific manifest
SHA-256; API rozwiązuje z nich deterministyczną ścieżkę release i failuje do
`unvalidated` przy każdej niezgodności. Prepublication API/UI smoke record jest zewnętrzną bramką atomic
rename i wiąże hash gotowej attestation/prepared tree; nie jest dopisywany do
testowanej attestation, dzięki czemu nie tworzy kolejnego self-reference.

### RED

Recipe contract tests wymagają:

- host `nvidia-smi` i container probe raportują ten sam UUID/name/CC;
- `PetscDeviceInitialize(PETSC_DEVICE_CUDA)` przechodzi w managed image;
- source provenance verifier działa przed solve;
- brak GPU kończy kodem nonzero i reason, nie skip-pass;
- matrix-free tiers `small`, `medium`, `large` przekazują do artefaktu
  rzeczywisty dimension, nie label; wymiary są różne i rosną, a `large` ma
  rzeczywisty `operator_dimension > 1024`;
- sanitizer recipes są osobne i zapisują osobne sidecary;
- production recipes używają unique staging, bez `rm -rf` report root;
- runtime export nie usuwa istniejącego locka;
- staging root ma dokładnie
  `.fullmag/qualification/fem-k0/staging/<qualification_id>/` i sześć katalogów
  `cpu`, `gpu`, `browser`, `sanitizer`, `trace`, `records`;
- staged-release nie uruchamia solvera, przeglądarki ani producenta ponownie;
- staging/candidate/release nie zawierają symlinków ani plików z `st_nlink > 1`;
- staged-release odrzuca legacy `summary.v1`, pozycyjne CPU/GPU mode matching,
  `measurement_state != measured`, brak external trace, brak
  `kittel-postsolve-v2` registration lub brak cluster/subspace/complex-field
  parity v2;
- staged-release wymaga trzech osobnych derived validation bundles i
  registration IDs: `kittel-postsolve-v2`, `cpu-gpu-parity-v2` oraz
  `periodic-antidot-e2e-v1`; każdy wpis `source_runs` musi jednoznacznie wiązać
  source bundle URI/manifest SHA/run ID z canonical scope ID/digestem i
  execution oraz rozwiązać się bez mutacji source bundle;
- CPU i GPU convergence recipe przekazują jawnie wszystkie progi K0-G7:
  Kittel max `2e-2`, median `1e-2`, mesh `1e-2`, airbox `5e-3`, fitted
  `M_eff` error `5e-3`, fitted uncertainty `2.5e-3`, condition `1e6` i Poisson
  residual `1e-8`; żaden production gate nie korzysta z defaults CLI;
- każdy input ma sidecar z path, hash, size, command, exit code, source/runtime
  identity, scope ID i producer timestamp;
- candidate capture nie zawiera candidate-manifest hash; osobny post-assembly
  record wiąże candidate SHA dopiero po jego atomowej publikacji;
- prepare tworzy complete prepared tree i attestation bez canonical visibility;
  kontrolny failure API/UI smoke nie tworzy `releases/<qualification_id>`;
- publish wymaga pass smoke record wiążącego identyczny prepared-tree digest i
  wykonuje wyłącznie atomowy rename, bez przepisywania attestation lub manifestu.

### GREEN

1. Preflight jest read-only i nie przebudowuje runtime.
2. Integrator, po potwierdzeniu braku aktywnego export ownera, używa istniejącej
   procedury runtime; nie kasuje locka ręcznie.
3. Tiers wymuszają production matrix-free adapter i zapisują dimension z native
   result.
4. Nsight trace używa zakresów T5 i kończy failure przy hot-loop full-vector
   copies, computational syncs albo telemetry event przekraczającym 256 bajtów.
5. Compute Sanitizer uruchamia osobno:
   - `--tool memcheck`;
   - `--tool racecheck`;
   - `--tool synccheck`.
6. Każdy sidecar zawiera command, tool version, exit code, log SHA-256, device,
   runtime i source digest.
7. Performance capture porównuje tę samą fizykę, mesh, tolerancje, requested
   modes i artifact policy CPU/GPU. Raportuje speedup bez wymyślonego progu.
8. `stage-*` kopiuje wyłącznie już zweryfikowane immutable zwykłe pliki do
   durable qualification stagingu; symlinki i hardlinki są odrzucane.
   `verify-*staged-release` przelicza wszystkie hashe i causal DAG.
   `verify-*candidate-binding` tworzy zewnętrzny post-assembly record.
   `prepare-*` montuje gotowe immutable bytes; prepublication smoke testuje
   dokładnie ten tree; `publish-*` wyłącznie atomowo go rename'uje. Żaden z tych
   kroków nie wywołuje solve ani ponownego scientific browser capture.
9. Zaktualizuj CPU/GPU Kittel convergence invocations tak, aby przekazywały
   wszystkie wartości z K0-G7 jako jawne argumenty. Staged release konsumuje
   wyłącznie T9 `kittel-postsolve-v2` i cluster/subspace/complex-field parity
   records; nie wywołuje legacy selektora ani pozycyjnego parity verifiera.

### Weryfikacja bez GPU

```bash
python3 -m pytest -q scripts/test_fem_frequency_domain_native_recipe.py
python3 -m pytest -q scripts/test_verify_fem_k0_governance_promotion.py
just --list | rg "eigen-k0-gpu-(residency|matrix-free|memcheck|racecheck|synccheck)"
just --list | rg "eigen-k0-(qualification|staged-release|candidate-binding|production-release|promotion-api-ui)"
```

### Weryfikacja na realnym GPU

Właściciel integracji uruchamia kolejno:

```bash
just verify-fem-frequency-domain-gpu-device-preflight
just rebuild-fem-runtime
just ensure-managed-fem-runtime
just verify-managed-fem-runtime-source-provenance
just inspect-managed-fem-frequency-domain-deps
just verify-fem-frequency-domain-gpu-petsc-slepc-runtime
just verify-fem-frequency-domain-eigen-k0-gpu-petsc-slepc
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-gpu-shift-invert-action
just verify-fem-frequency-domain-eigen-k0-gpu-matrix-free-tier small
just verify-fem-frequency-domain-eigen-k0-gpu-matrix-free-tier medium
just verify-fem-frequency-domain-eigen-k0-gpu-matrix-free-tier large
just verify-fem-frequency-domain-eigen-k0-gpu-residency-trace
just verify-fem-frequency-domain-eigen-k0-gpu-memcheck
just verify-fem-frequency-domain-eigen-k0-gpu-racecheck
just verify-fem-frequency-domain-eigen-k0-gpu-synccheck
```

Jeżeli recipe `inspect-managed-fem-frequency-domain-deps` nie istnieje w
zintegrowanym branchu, integrator ma najpierw sprawdzić `just --list` i użyć
istniejącego odpowiednika z masterplanu; nie wolno zastępować go host buildem.

**Akceptacja T13:** exact source/runtime/device proof jest spójny; wszystkie
tiers używają matrix-free i co najmniej jeden ma wymiar >1024; trzy sanitizer
sidecary istnieją; durable staging/release nie kasuje raportów ani nie rerunuje
producentów.

### Commit

```bash
git commit -m "build(fem): add managed K0 GPU residency qualification"
```

---

## Zadanie T14: zintegrowana kwalifikacja candidate K0-G0–K0-G9

**Zależność:** T0–T13, w tym T0A i T1A, zintegrowane na jednym commicie.
**Lane:** integrator; read-only observerzy mogą analizować artefakty.
**Cel:** wykonać realne obliczenia, nie tylko kontrakty.

### Przed startem

1. R1 wymaga całkowicie czystego worktree; jakakolwiek tracked lub untracked
   zmiana blokuje start. Nie stosuj wyjątków dla zmian „nieistotnych dla
   digestu”.
2. Pobierz bieżący `origin/master`, potwierdź ancestry i zamroź pełny R1 OID
   oraz jednoznaczny qualification ID:

   ```bash
   test -z "$(git status --porcelain)"
   git fetch origin master
   git merge-base --is-ancestor origin/master HEAD
   r1="$(git rev-parse HEAD)"
   qualification_id="fem-k0-${r1:0:12}-$(date -u +%Y%m%dT%H%M%SZ)"
   printf 'R1=%s\nQUALIFICATION_ID=%s\n' "$r1" "$qualification_id"
   ```

   Te dwie wartości są zapisywane przez `stage-*` w staging index i przez
   `verify-*staged-release` w scientific candidate manifest. Każda późniejsza
   komenda T14/T15 odczytuje je z tego manifestu i porównuje z wartościami
   przekazanymi w CLI; mismatch failuje przed publikacją.
3. Potwierdź host-wide GPU/device i export lock ownership.
4. Nie uruchamiaj dwóch rebuild/exportów jednocześnie.
5. Jakakolwiek późniejsza zmiana runtime, validatora, API, UI lub release
   tooling unieważnia R1 i wymaga nowego pełnego T14. Po R1 dozwolony jest
   dopiero governance-only commit G2-governance w T15.

### Sekwencja CPU oracle

```bash
just verify-managed-fem-runtime-source-provenance
just verify-fem-frequency-domain-native-contract
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-dense-oracle
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-cpu-slepc
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-schur-matshell
just verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-convergence-cpu
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-production-cpu
just verify-fem-periodic-antidot-relax-eigenmodes-runtime cpu
```

CPU musi przejść przed CPU/GPU parity. Długi runtime bez zmieniającego się
progress nie jest automatycznie failure, ale brak prawdziwych EPS counters jest
regresją T7 i ma zostać naprawiony przed GPU qualification.
Recepta convergence jest wersją poprawioną w T13: przekazuje jawne production
thresholds i emituje `kittel-postsolve-v2`; nie wolno w tym miejscu użyć jej
legacy implementacji ani domyślnych progów CLI.

### Sekwencja GPU physics i E2E

```bash
just verify-fem-frequency-domain-eigen-k0-kittel-periodic-airbox-convergence-gpu
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-production-gpu
just verify-fem-periodic-antidot-relax-eigenmodes-runtime gpu
```

Następnie uruchom validator T9/T10 na finalnych bundle i potwierdź wszystkie
progi K0-G6/K0-G7.
Parity record musi pochodzić z nowego cluster/subspace/complex-field verifiera;
pozycyjne legacy porównanie modów nie jest dowodem i staged release je odrzuca.

### Sekwencja staging candidate i UI

```bash
pnpm --dir apps/control-room typecheck
```

Uruchom pełne targeted frontend tests z T12 i browser smoke. Capture zawiera:

- spectrum;
- co najmniej trzy mode fields;
- execution/residency Inspector;
- WebGL health;
- resource revisions i topology fingerprint;
- `qualification_id`, R1 OID, runtime/source digests i source run IDs. Capture
  nie zawiera własnego SHA ani candidate-manifest SHA, ponieważ zamknięty record
  hashuje dopiero zewnętrzny sidecar/staging index, a candidate jeszcze nie
  istnieje.

Po zebraniu CPU/GPU/browser/sanitizer/trace evidence:

```bash
just stage-fem-frequency-domain-eigen-k0-qualification "$qualification_id"
just verify-fem-frequency-domain-eigen-k0-staged-release "$qualification_id"
just verify-fem-frequency-domain-eigen-k0-candidate-binding "$qualification_id"
```

Trzecia recepta działa dopiero po atomowym candidate assembly i zapisuje poza
candidate `post-assembly/<qualification_id>/candidate_binding.v1.json`, wiążąc
candidate SHA-256 z hashami zamkniętych capture records odczytanymi z ich
zewnętrznych sidecarów/staging index. Scientific candidate pozostaje immutable
i nie próbuje zawierać własnego hash.

Te recepty nie mogą wywołać legacy
`verify-fem-frequency-domain-eigen-k0-poisson-airbox-production-release`, bo
obecny target kasuje report roots i rerunuje producentów. T14 kończy się
immutable scientific candidate manifestem; final external publish następuje
dopiero po governance commit G2-governance w T15.

### Macierz akceptacji

| Gate | Obowiązkowy dowód | Failure blokuje |
|---|---|---|
| K0-G0 | host/container GPU + source/runtime identity | wszystkie GPU claimy |
| K0-G1 | negatywne fail-closed tests | executable |
| K0-G2 | modalny object graph runtime | executable |
| K0-G3 | measured native + Nsight zero hot-loop migration | full-GPU claim |
| K0-G4 | CPU complete window/full residuals | parity |
| K0-G5 | GPU physical solves | physics_validated |
| K0-G6 | cluster/subspace/complex-field parity | physics_validated |
| K0-G7 | Kittel + antidot | production scope |
| K0-G8 | reuse/cancel/leak/sanitizers/perf report | production scope |
| K0-G9-candidate | Results/modes/WebGL/immutable candidate | G2-governance |

### Raport

Utwórz finalny raport pod istniejącym masterplan evidence root, zawierający:

- integration commit i dirty policy;
- runtime manifest/source digest;
- GPU identity;
- każde polecenie, exit code i artifact path;
- progi expected/observed/outcome;
- native/external trace hashes;
- CPU/GPU timing i pamięć;
- screenshots/browser diagnostics;
- jawne blockers i exact validated scope.

**Akceptacja T14:** K0-G0–K0-G8 i K0-G9-candidate mają fresh, hash-bound pass
na czystym R1. Jeden blocker utrzymuje capability bez promocji. Finalna
promotion attestation domykająca K0-G9 powstaje w T15.

Nie tworzyć commita z samymi generowanymi runtime artifacts, jeżeli repo policy
przechowuje je poza Git.

---

## Zadanie T15: G2-governance, external promotion attestation i merge readiness

**Zależność:** pełne T14 pass.
**Lane:** governance/release integrator; po R1 nie wolno zmieniać solvera,
validatorów, API, UI ani recipe.
**Cel:** promować wyłącznie dowiedziony zakres, utworzyć dwutożsamościową
attestation bez ponownego solve i przygotować bezpieczny merge.

**Modyfikuj:**

- `docs/specs/capability-matrix-v0.json`
- `docs/specs/capability-matrix-v0.md`
- `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`
- `docs/physics/0830-fem-poisson-airbox-modal-eigen.source-map.json`
- `docs/plans/active/fd_sovler_masterplan/25_frequency_domain_readiness_scope_catalog.json`
- `docs/plans/active/fd_sovler_masterplan/25_frequency_domain_readiness_matrix.json`
- `docs/plans/active/fd_sovler_masterplan/27_fem_k0_eigensolve_production_completion_and_control_room.md`
- `docs/plans/active/fd_sovler_masterplan/fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V5.md`
  wyłącznie jako deterministyczny output repo generatora, jeżeli generator
  zmienia go dla tych samych status records
- żadnych source changes na tym etapie

### RED

Test capability wymaga exact evidence IDs/digests i nie pozwala promować:

- single precision;
- nonzero K;
- DMI/anizotropii;
- innego FE order/element family;
- heterogenicznego exchange;
- innego demag modelu;
- urządzenia/runtime poza wykonanym validated scope.

Test allowlist dodatkowo failuje, jeżeli diff R1..G2-governance zawiera kod,
schema, recipe, test fixture, generated API client, package lock albo runtime
manifest. Negative API fixtures wymagają `unvalidated` przy brakującym release,
złym R1/G2-governance OID, złym scientific manifest hash, niepełnym scope
binding, failed
verifier record lub złym sidecar hash.

### GREEN

1. Odczytaj `qualification_id`, R1 OID i scientific manifest SHA-256 z
   immutable candidate T14. Porównaj R1 z bieżącym ancestry; candidate nie może
   zostać przepisany ani ponownie wygenerowany w T15.
2. Ustaw `implementation_state=executable` i
   `validation_state=production_qualified` wyłącznie dla dwóch exact scope IDs
   z T1. Każdy binding przechowuje `qualification_id`, pełny R1 OID, runtime
   source snapshot digest oraz scientific manifest relative path/SHA-256.
   Relative path jest rozwiązywane pod configured qualification root i nie
   koduje `prepared` ani `releases`. Szersze zakresy pozostają `unvalidated`.
3. Dodaj limitation rows dla każdego wyłączonego wariantu. Zaktualizuj notę
   fizyczną oraz readiness/masterplan status. Historyczne blockery oznacz jako
   resolved z datą i evidence, bez ich usuwania.
4. Uruchom deterministyczne generatory dokumentacji. Przerwij, jeżeli generator
   zmienia plik poza allowlistą albo wynik drugiego uruchomienia różni się od
   pierwszego.
5. Stage'uj wyłącznie allowlistowane pliki dokumentacji, sprawdź staged list w
   osobnym poleceniu, uruchom pre-commit gate i utwórz jeden governance-only
   commit:

   ```bash
   git add \
     docs/specs/capability-matrix-v0.json \
     docs/specs/capability-matrix-v0.md \
     docs/physics/0830-fem-poisson-airbox-modal-eigen.md \
     docs/physics/0830-fem-poisson-airbox-modal-eigen.source-map.json \
     docs/plans/active/fd_sovler_masterplan/25_frequency_domain_readiness_scope_catalog.json \
     docs/plans/active/fd_sovler_masterplan/25_frequency_domain_readiness_matrix.json \
     docs/plans/active/fd_sovler_masterplan/27_fem_k0_eigensolve_production_completion_and_control_room.md
   git diff --cached --name-only
   python3 scripts/verify_fem_k0_governance_promotion.py \
     --runtime-commit "$r1" \
     --qualification-id "$qualification_id" \
     --staged
   git commit -m "docs: qualify FEM K0 eigensolve on GPU"
   ```

   Tryb `--staged` sprawdza allowlist i candidate binding, ale nie zapisuje
   finalnego rekordu, ponieważ G2-governance OID jeszcze nie istnieje.

   Jeżeli generator zmienił
   `fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V5.md`, integrator dodaje ten jeden
   plik jawnie dopiero po potwierdzeniu, że należy do allowlisty. Nie wolno użyć
   `git add -A`.
6. Na czystym G2-governance odczytaj tożsamości z candidate, sprawdź ancestry i
   wykonaj kolejno prepare, real typed API/UI smoke na prepared root, a dopiero
   potem atomic publish:

   ```bash
   test -z "$(git status --porcelain)"
   g2="$(git rev-parse HEAD)"
   git merge-base --is-ancestor "$r1" "$g2"
   python3 scripts/verify_fem_k0_governance_promotion.py \
     --runtime-commit "$r1" \
     --governance-commit "$g2" \
     --qualification-id "$qualification_id" \
     --write-record
   just prepare-fem-frequency-domain-eigen-k0-production-release \
     "$qualification_id" "$r1" "$g2"
   just verify-fem-frequency-domain-eigen-k0-promotion-api-ui \
     "$qualification_id"
   just publish-fem-frequency-domain-eigen-k0-production-release \
     "$qualification_id" "$r1" "$g2"
   ```

   Prepare ani publisher nie przebudowują runtime i nie wykonują solve. Smoke
   uruchamia API z process-only rootem wskazującym prepared tree i wymaga
   typowanego qualification resource `status=production_qualified`, zgodności
   obu OID/scope/digestów oraz widocznego badge w Results. Brak lub mismatch
   attestation musi dawać kontrolny `unvalidated`. Smoke failure pozostawia
   canonical `releases/<qualification_id>` nieistniejący; publish nie uruchamia
   smoke ponownie i wykonuje tylko sprawdzony atomic rename.

### Final verification

```bash
python3 -m pytest -q \
  scripts/test_frequency_domain_math_contract_docs.py \
  scripts/test_validate_mixed_p1_capability_contract.py
python3 scripts/check_fd_solver_masterplan_contract.py
python3 scripts/check_repo_consistency.py
python3 scripts/verify_fem_k0_governance_promotion.py \
  --runtime-commit "$r1" \
  --governance-commit "$g2" \
  --qualification-id "$qualification_id" \
  --verify-record
git diff --check
git status --short
git diff --cached --name-only
```

Następnie użyj `requesting-code-review`, a po usunięciu wszystkich P0/P1
`verification-before-completion` i `finishing-a-development-branch`.

**Akceptacja T15:** capability, docs, API, runtime evidence i UI opisują ten sam
exact scope; promotion attestation wiąże R1 i G2-governance bez ponownego solve;
typed API/UI smoke przechodzi przed canonical visibility; branch ma review i
fresh verification; merge nie obejmuje cudzych niezwiązanych zmian. Nie
merge'ować ani nie pokazywać zielonego statusu, jeśli prepare, prepublication
smoke lub atomic publish failuje.

---

## 2. Checklist końcowy dla wykonawcy

### Solver i rezydencja

- [ ] Jeden produkcyjny adapter PETSc/SLEPc; brak drugiego solvera.
- [ ] Production operator jest matrix-free; materialized/ILU tylko validation.
- [ ] HYPRE memory i execution policy są device i poświadczone.
- [ ] Wszystkie Fullmag-owned i publicznie introspekcyjne obiekty
  PETSc/SLEPc/HYPRE są device-backed; prywatne bufory bibliotek potwierdza
  external trace.
- [ ] Transfery są zmierzone per setup/hot-loop/export.
- [ ] Native i external trace zgadzają się.
- [ ] Hot-loop full-vector H2D/D2H i obliczeniowe host sync wynoszą zero.
- [ ] Session lifecycle, reuse, invalidation, cancel i destroy przechodzą.

### Fizyka i stage handoff

- [ ] Exact scope odpowiada nocie fizycznej i capability.
- [ ] Relax i eigensolve używają jednego mesh generation/topology.
- [ ] Accepted equilibrium i wszystkie digesty są zgodne.
- [ ] Kittel branch selection jest shape-first i independent postsolve.
- [ ] CPU/GPU parity jest cluster/subspace/complex-field aware.
- [ ] Kittel, mesh, padding, M_eff i Poisson progi przechodzą.
- [ ] Antydot generuje spectrum i kompletne mode fields bez remeshu.

### Produkt i release

- [ ] Runner nie tworzy domyślnych production/residency claimów.
- [ ] Artefakty są typowane, immutable i atomowo publikowane.
- [ ] OpenAPI zawiera typed attestation i progress.
- [ ] Results pokazuje spectrum i mody.
- [ ] Inspector pokazuje prawdziwe GPU provenance/residency.
- [ ] Mode fields renderują `real`, `imag`, `magnitude`, `phase`,
  `phase_rotated_real` i animację fazora.
- [ ] Browser smoke potwierdza canvas, WebGL i topology identity.
- [ ] K0-G0–K0-G9 pochodzą z exact managed runtime i realnego GPU.
- [ ] Capability jest promowane wyłącznie dla exact validated scope.
- [ ] External promotion attestation wiąże R1, G2-governance, scientific
  manifest, allowlist digest i wszystkie verifier records.

---

## 3. Punkty kontrolne i bezpieczne zatrzymanie

Po każdym z poniższych punktów integrator publikuje krótki raport
implemented/executable/validated/qualified i nie przechodzi dalej przy
nierozwiązanym P0:

1. po T2B — ABI, handoff i validation-registration schemas frozen;
2. po T6 — native GPU source complete, bez claimu runtime;
3. po T10 — validators i antidot contract complete;
4. po T12 — API/UI source complete;
5. po T13 — managed recipes gotowe;
6. po T14 — real-device evidence;
7. po T15 — G2-governance, external attestation, typed API/UI smoke i merge
   readiness.

Jeżeli ten sam błąd build/runtime wystąpi dwa razy, zatrzymać próby, zebrać
pełny log, zbadać 3–5 rozwiązań w źródłach pierwotnych i dopiero wtedy wybrać
naprawę. Nie obchodzić managed runtime hostowym buildem.
