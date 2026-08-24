# FEM GPU P0 Executed Residency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zamknąć `FEM-GPU-ARCH-001`, `FEM-GPU-PERF-001` i `FEM-GPU-PERF-009` przez append-only receipt dowodzący faktycznego wykonania wszystkich wymaganych operatorów na GPU, odrzucenie hostowego hot loopu w strict oraz pozostawienie `hybrid_cpu_poisson` wyłącznie jako jawnego compatibility mode.

**Architecture:** Właścicielem mutable receipt jest nowy subsystem `FemGpuExecutionReceiptRuntimeState` osadzony w `GpuStateRuntimeState`, nie płaski `Context`. Planner tworzy wymagane i resolved masks, miejsca faktycznego wykonania są notowane przez właścicieli operatorów, a C ABI publikuje wersjonowany snapshot v1. Rust nie rekonstruuje receipt z planu: waliduje natywny snapshot i zachowuje requested/resolved/executed provenance.

**Tech Stack:** C++17/CUDA, MFEM/Hypre device backend, C ABI, Rust FFI/runner, CMake contract tests, container-backed `just` managed runtime.

## Global Constraints

- Produkcyjny kod FEM pozostaje w `backends/fem`; runner wyłącznie orkiestruje ABI i provenance.
- Strict GPU nie może wykonać hostowego operator apply, hostowego preconditionera ani `hybrid_cpu_poisson`.
- `hybrid_cpu_poisson` pozostaje jawnym compatibility/debug mode i nigdy nie otrzymuje klasy `device_resident`.
- ABI jest append-only: nowe enumy, struktura `fullmag_fem_gpu_execution_receipt_v1` i nowa funkcja query nie zmieniają layoutu istniejących struktur.
- Brak operatora, unknown mask, host execution, fallback lub naruszenie transfer audit kończy strict typed error; nie jest zamieniane w częściowy sukces.
- `production_executable` i `validated` nie są promowane bez świeżego source-bound managed GPU receipt.
- Pierwszą i autorytatywną ścieżką build/runtime FEM jest repozytoryjne `just`; host CMake/Cargo są wyłącznie diagnostyką.
- Żaden generated file, build output, cache, runtime artifact ani tymczasowy evidence nie może zostać zindeksowany przez Git; buildy i cache pozostają poza checkoutem pod `D:\fullmag-*`, a przed każdym commitem należy osobno sprawdzić `git diff --cached --name-only` i pełny status untracked.
- Nie dodawać nowych pól cross-cutting bezpośrednio do `Context`; receipt należy do `GpuStateRuntimeState`.
- Nie modyfikować `mfem_bridge.cpp` ani nie duplikować operatorów w Rust.

---

### Task 1: Natywny owner i algebra receipt

**Files:**
- Create: `backends/fem/gpu/cuda/runtime/execution_receipt.hpp`
- Create: `backends/fem/gpu/cuda/runtime/execution_receipt.cpp`
- Modify: `backends/fem/gpu/cuda/runtime/gpu_state_runtime.hpp`
- Modify: `backends/fem/gpu/cuda/runtime/gpu_state_runtime.cpp`
- Modify: `backends/fem/CMakeLists.txt`
- Create: `backends/fem/tests/gpu_execution_receipt_contract.cpp`

**Interfaces:**
- Consumes: `Context`, `GpuRkPlan`, `TransferAudit` i operator bit mask.
- Produces: wewnętrzne `FemGpuExecutionClass`, `FemGpuExecutionSnapshot`, `FemGpuExecutionReceiptRuntimeState`, `gpu_execution_receipt_resolve_plan`, `gpu_execution_receipt_begin_attempt`, `gpu_execution_receipt_note_device`, `gpu_execution_receipt_note_host`, `gpu_execution_receipt_note_fallback`, `gpu_execution_receipt_commit_attempt`, `gpu_execution_receipt_snapshot`.

- [ ] **Step 1: Napisać test RED algebry required/resolved/executed.**

```cpp
FemGpuExecutionReceiptRuntimeState state{};
gpu_execution_receipt_resolve_plan(
    state,
    FULLMAG_FEM_GPU_OPERATOR_EXCHANGE |
        FULLMAG_FEM_GPU_OPERATOR_LLG_RHS |
        FULLMAG_FEM_GPU_OPERATOR_RK_STEPPER,
    FemGpuExecutionClass::DeviceResident,
    0,
    FULLMAG_FEM_PRECISION_DOUBLE,
    FULLMAG_FEM_INTEGRATOR_HEUN);
gpu_execution_receipt_begin_attempt(state);
gpu_execution_receipt_note_device(state, state.required_operator_mask);
gpu_execution_receipt_commit_attempt(state);
const auto receipt = gpu_execution_receipt_snapshot(state, {});
check(receipt.execution_class == FemGpuExecutionClass::DeviceResident);
check(receipt.executed_device_operator_mask == receipt.required_operator_mask);
check(receipt.executed_unknown_operator_mask == 0);
check(receipt.fallback_count == 0);
```

- [ ] **Step 2: Uruchomić test przez istniejącą bramkę container-first.**

Run: `just verify-fem-time-domain-native-contract`

Expected: FAIL, ponieważ typy i funkcje receipt jeszcze nie istnieją.

- [ ] **Step 3: Zaimplementować owner bez pól w `Context`.**

```cpp
enum class FemGpuExecutionClass : uint32_t {
    Unknown = 0,
    DeviceResident = 1,
    GpuOperatorHostSolver = 2,
    HybridCpuPoisson = 3,
    Cpu = 4,
};

struct FemGpuExecutionReceiptRuntimeState {
    mutable std::mutex mutex{};
    bool accounting_valid = true;
    FemGpuExecutionClass execution_class = FemGpuExecutionClass::Unknown;
    int32_t device_ordinal = -1;
    uint32_t precision = FULLMAG_FEM_PRECISION_DOUBLE;
    uint32_t integrator = FULLMAG_FEM_INTEGRATOR_HEUN;
    uint64_t required_operator_mask = 0;
    uint64_t resolved_device_operator_mask = 0;
    uint64_t resolved_host_operator_mask = 0;
    uint64_t resolved_unknown_operator_mask = 0;
    uint64_t executed_device_operator_mask = 0;
    uint64_t executed_host_operator_mask = 0;
    uint64_t fallback_count = 0;
    uint64_t accepted_step_count = 0;
    uint64_t rejected_attempt_count = 0;
    uint64_t failed_attempt_count = 0;
};
```

`GpuStateRuntimeState` otrzymuje jedno pole `execution_receipt{}`. `begin_attempt` zeruje wyłącznie attempt-executed masks; `commit_attempt` publikuje je jako ostatni zaakceptowany executed snapshot; reject/failure zwiększa wyłącznie telemetrykę prób i nie publikuje częściowych masek.

- [ ] **Step 4: Dodać negatywne testy host, unknown i fallback.**

```cpp
gpu_execution_receipt_note_host(state, FEM_GPU_OPERATOR_PRECONDITIONER);
check(gpu_execution_receipt_snapshot(state, {}).execution_class ==
      FemGpuExecutionClass::GpuOperatorHostSolver);
gpu_execution_receipt_note_fallback(state);
check(gpu_execution_receipt_snapshot(state, {}).fallback_count == 1);
```

- [ ] **Step 5: Uruchomić kontrakt ponownie.**

Run: `just verify-fem-time-domain-native-contract`

Expected: PASS dla nowego targetu oraz istniejących kontraktów time-domain.

- [ ] **Step 6: Przygotować commit task-scoped.**

```text
git add backends/fem/gpu/cuda/runtime/execution_receipt.hpp backends/fem/gpu/cuda/runtime/execution_receipt.cpp backends/fem/gpu/cuda/runtime/gpu_state_runtime.hpp backends/fem/gpu/cuda/runtime/gpu_state_runtime.cpp backends/fem/tests/gpu_execution_receipt_contract.cpp backends/fem/CMakeLists.txt
git commit -m "feat(fem-gpu): add execution receipt owner"
```

### Task 2: Append-only C ABI i Rust FFI

**Files:**
- Modify: `native/include/fullmag_fem.h`
- Modify: `backends/fem/src/api.cpp`
- Modify: `crates/fullmag-fem-sys/src/lib.rs`
- Modify: `crates/fullmag-fem-sys/build.rs`
- Modify: `backends/fem/tests/gpu_execution_receipt_contract.cpp`

**Interfaces:**
- Consumes: wewnętrzny `gpu_execution_receipt_snapshot(Context const&)`; `api.cpp` mapuje internal enum/snapshot do publicznego ABI v1.
- Produces: `FULLMAG_FEM_GPU_EXECUTION_RECEIPT_ABI_V1`, `fullmag_fem_gpu_execution_receipt_v1`, `fullmag_fem_backend_gpu_execution_receipt_v1`.

- [ ] **Step 1: Dodać RED layout/handshake po obu stronach ABI.**

```cpp
fullmag_fem_gpu_execution_receipt_v1 receipt{};
receipt.abi_version = FULLMAG_FEM_GPU_EXECUTION_RECEIPT_ABI_V1;
receipt.struct_size = sizeof(receipt);
check(fullmag_fem_backend_gpu_execution_receipt_v1(nullptr, &receipt) ==
      FULLMAG_FEM_ERR_INVALID);
static_assert(offsetof(fullmag_fem_gpu_execution_receipt_v1,
                       required_operator_mask) % 8 == 0);
```

Rust test ma sprawdzać ten sam `size_of`, `align_of` i wszystkie offsety przez `offset_of!`.

- [ ] **Step 2: Uruchomić ABI RED.**

Run: `just verify-fem-time-domain-native-contract`

Expected: FAIL na brakujących symbolach/typach v1.

- [ ] **Step 3: Dodać append-only enumy i strukturę.**

```c
#define FULLMAG_FEM_GPU_EXECUTION_RECEIPT_ABI_V1 1u

typedef enum {
    FULLMAG_FEM_GPU_EXECUTION_UNKNOWN = 0,
    FULLMAG_FEM_GPU_EXECUTION_DEVICE_RESIDENT = 1,
    FULLMAG_FEM_GPU_EXECUTION_GPU_OPERATOR_HOST_SOLVER = 2,
    FULLMAG_FEM_GPU_EXECUTION_HYBRID_CPU_POISSON = 3,
    FULLMAG_FEM_GPU_EXECUTION_CPU = 4,
} fullmag_fem_gpu_execution_class_v1;

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint32_t execution_class;
    uint32_t precision;
    uint32_t integrator;
    int32_t device_ordinal;
    uint64_t required_operator_mask;
    uint64_t resolved_device_operator_mask;
    uint64_t resolved_host_operator_mask;
    uint64_t resolved_unknown_operator_mask;
    uint64_t executed_device_operator_mask;
    uint64_t executed_host_operator_mask;
    uint64_t executed_unknown_operator_mask;
    uint64_t fallback_count;
    uint64_t accepted_step_count;
    uint64_t rejected_attempt_count;
    uint64_t failed_attempt_count;
    uint64_t hot_loop_compute_h2d_bytes;
    uint64_t hot_loop_compute_d2h_bytes;
    uint64_t hot_loop_compute_host_sync_count;
} fullmag_fem_gpu_execution_receipt_v1;
```

Operator bits: `EXCHANGE`, `DEMAG_RHS`, `DEMAG_SOLVE`, `DEMAG_RECOVERY`, `LOCAL_FIELDS`, `DIRECT_TORQUES`, `LLG_RHS`, `RK_STEPPER`, `REDUCTIONS`, `PRECONDITIONER`. Nie oznaczać operatora required, jeśli fizyka planu go nie aktywuje; LLG/RK/redukcje są wymagane dla każdego time-domain GPU step.

- [ ] **Step 4: Zaimplementować handshake fail-closed.**

`fullmag_fem_backend_gpu_execution_receipt_v1` odrzuca null handle/output, złą wersję oraz zły `struct_size` przed zapisem. Snapshot jest zerowany przed wypełnieniem i kopiuje aktualny transfer audit.

- [ ] **Step 5: Odwzorować identyczny layout w Rust i wygenerować assertions.**

Nie używać bindgenowego domysłu ani rekonstrukcji planu. `build.rs` ma generować test layoutu z jednego manifestu pól albo jawnych stałych C/Rust, zgodnie z istniejącym wzorcem ABI crate.

- [ ] **Step 6: Uruchomić bramki.**

Run: `just verify-fem-time-domain-native-contract`

Run: `cargo check -p fullmag-fem-sys -p fullmag-runner --features fullmag-runner/fem-gpu --tests`

Expected: oba PASS; Cargo jest wyłącznie smoke FFI, nie dowodem runtime FEM.

- [ ] **Step 7: Przygotować commit task-scoped.**

```text
git add native/include/fullmag_fem.h backends/fem/src/api.cpp crates/fullmag-fem-sys/src/lib.rs crates/fullmag-fem-sys/build.rs backends/fem/tests/gpu_execution_receipt_contract.cpp
git commit -m "feat(fem-gpu): expose execution receipt ABI"
```

### Task 3: Strict preflight, execution notes i jawny hybrid

**Files:**
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk.hpp`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_plan.cpp`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_step_preflight.cu`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_step.cu`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_rhs_runtime.cu`
- Modify: `backends/fem/gpu/cuda/integrators/rk/rk_demag_dispatch.cu`
- Modify: `backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp`
- Modify: `backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp`
- Modify: `backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp`
- Modify: `backends/fem/tests/gpu_rk_plan.cpp`
- Modify: `backends/fem/tests/transfer_audit.cpp`
- Create: `backends/fem/tests/gpu_strict_execution_contract.cpp`

**Interfaces:**
- Consumes: plan operator masks i funkcje note/begin/commit/reject z Task 1.
- Produces: strict preflight przed pierwszym stage oraz faktyczne executed notes z właścicieli operatorów.

- [ ] **Step 1: Napisać RED dla strict i hybrid.**

Test ma pokrywać macierz:

```text
strict + device_hypre_poisson + pełne device prerequisites -> plan enabled
strict + hybrid_cpu_poisson -> typed reject przed begin_attempt
strict + host preconditioner/apply -> typed reject
explicit compatibility + hybrid_cpu_poisson -> execution_class=hybrid_cpu_poisson
forced GPU + brak required device operator -> resolved_unknown, brak kroku
```

- [ ] **Step 2: Uruchomić RED przez `just`.**

Run: `just verify-fem-time-domain-native-contract`

Expected: FAIL, ponieważ plan nie publikuje per-operator masks i wykonanie nie notuje operatorów.

- [ ] **Step 3: Rozszerzyć `GpuRkPlan` o masks/class.**

```cpp
struct GpuRkPlan {
    // istniejące pola bez zmiany znaczenia
    uint32_t execution_class = FULLMAG_FEM_GPU_EXECUTION_UNKNOWN;
    uint64_t required_operator_mask = 0;
    uint64_t resolved_device_operator_mask = 0;
    uint64_t resolved_host_operator_mask = 0;
    uint64_t resolved_unknown_operator_mask = 0;
};
```

`gpu_rk_plan_device_resident` buduje masks wyłącznie z aktywnego planu. Hybrid ustawia host bits dla `DEMAG_SOLVE|PRECONDITIONER` oraz klasę hybrid; ścieżka strict nie może zwrócić `enabled=true`, jeśli którykolwiek required bit nie jest device.

- [ ] **Step 4: Notować wykonanie w rzeczywistych właścicielach.**

`rk_rhs_runtime.cu` notuje `LOCAL_FIELDS|DIRECT_TORQUES|LLG_RHS` po poprawnym enqueue; exchange owner notuje `EXCHANGE`; `stage_compute.cpp` notuje `DEMAG_RHS|DEMAG_RECOVERY`; device Hypre owner notuje `DEMAG_SOLVE|PRECONDITIONER`; RK owner notuje `RK_STEPPER`; reduction owner notuje `REDUCTIONS`. Hybrid dispatch notuje host demag/preconditioner i nie może zostać sklasyfikowany jako strict.

- [ ] **Step 5: Spiąć attempt lifecycle.**

`rk_step.cu` rozpoczyna attempt dopiero po poprawnym preflight. Sukces po final stats publikuje committed masks; każdy reject/error/cancel wywołuje reject/fail bez publikacji częściowego executed snapshotu. `rk_explicit_step.cpp` w forced GPU porównuje committed receipt z required masks i zwraca typed error zamiast CPU fallbacku.

- [ ] **Step 6: Powiązać transfer audit.**

Strict commit wymaga zerowych `hot_loop_compute_h2d_bytes`, `hot_loop_compute_d2h_bytes` i `hot_loop_compute_host_sync_count`. Dozwolone scalar controls pozostają w osobnych counterach i nie maskują full-vector violation.

- [ ] **Step 7: Uruchomić kontrakty i managed strict/hybrid smoke.**

Run: `just verify-fem-time-domain-native-contract`

Run: `just verify-fem-llg-time-domain-qualification-gpu`

Expected: source/native contracts PASS; managed GPU PASS tylko przy source-bound runtime i urządzeniu. Brak runtime/GPU pozostaje jawnym `NOT VERIFIED`, nie jest zastępowany host smoke.

- [ ] **Step 8: Przygotować commit task-scoped.**

```text
git add backends/fem/gpu/cuda/integrators/rk backends/fem/gpu/cuda/demag_poisson backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp backends/fem/tests/gpu_rk_plan.cpp backends/fem/tests/transfer_audit.cpp backends/fem/tests/gpu_strict_execution_contract.cpp
git commit -m "fix(fem-gpu): enforce strict device execution"
```

### Task 4: Rust validation i requested/resolved/executed provenance

**Files:**
- Modify: `crates/fullmag-runner/src/native_fem.rs`
- Modify: `crates/fullmag-runner/src/native_fem/runtime_info.rs`
- Modify: `crates/fullmag-runner/src/fem/runtime_contract.rs`
- Modify: `crates/fullmag-runner/src/dispatch.rs`
- Modify: `crates/fullmag-runner/src/types.rs`
- Modify: `crates/fullmag-runner/src/artifacts.rs`
- Modify: `crates/fullmag-runner/src/native_fem/tests/plan_contracts.rs`
- Modify: `crates/fullmag-runner/src/native_fem/tests/runtime_smoke.rs`

**Interfaces:**
- Consumes: `fullmag_fem_gpu_execution_receipt_v1` z natywnego ABI.
- Produces: `FemGpuExecutionReceipt` i walidację `validate_strict_fem_gpu_execution_receipt` bez rekonstrukcji executed state z `NativeFemGpuRkPlanInfo`.

- [ ] **Step 1: Napisać testy RED serializacji i strict rejection.**

```rust
let receipt = FemGpuExecutionReceipt {
    requested: "strict_device".into(),
    resolved: "device_resident".into(),
    executed: "cuda_fem".into(),
    required_operator_mask: 0x3ff,
    executed_device_operator_mask: 0x3ff,
    executed_host_operator_mask: 0,
    executed_unknown_operator_mask: 0,
    fallback_count: 0,
    ..fixture()
};
assert!(validate_strict_fem_gpu_execution_receipt(&receipt).is_ok());
```

Negatywne fixtures osobno zmieniają host bit, unknown bit, brak required bit, fallback count, execution class i transfer counter; każde musi zwrócić stabilny typed diagnostic token.

- [ ] **Step 2: Uruchomić RED.**

Run: `cargo test -p fullmag-runner --features fem-gpu fem_gpu_execution_receipt --no-fail-fast`

Expected: FAIL na brakującym typie/query.

- [ ] **Step 3: Dodać bezpieczny wrapper query.**

Wrapper inicjalizuje `abi_version` i `struct_size`, wywołuje natywne ABI i odrzuca nieznane enumy/bity. Nie przepisuje `executed` z requested/resolved planu.

- [ ] **Step 4: Dodać publiczny typ provenance.**

`FemGpuExecutionReceipt` przechowuje requested/resolved/executed class, device ordinal, precision, integrator, wszystkie masks, fallback/attempt counts i strict transfer counters. `ExecutionProvenance` otrzymuje `fem_gpu_execution_receipt: Option<_>`; artefakt zapisuje pole bez zmiany semantyki istniejących pól FEM.

- [ ] **Step 5: Walidować boundary publikacji.**

Forced strict GPU publikuje wynik dopiero po `validate_strict_fem_gpu_execution_receipt`. Explicit hybrid zachowuje class `hybrid_cpu_poisson`, host masks i dokładne transfer counters, bez flagi degraded=false ani statusu device-resident.

- [ ] **Step 6: Uruchomić Rust gates.**

Run: `cargo test -p fullmag-runner --features fem-gpu fem_gpu_execution_receipt --no-fail-fast`

Run: `cargo check -p fullmag-fem-sys -p fullmag-runner --features fullmag-runner/fem-gpu --tests`

Expected: PASS; ostrzeżenia istniejące przed taskiem nie są naprawiane drive-by.

- [ ] **Step 7: Przygotować commit task-scoped.**

```text
git add crates/fullmag-runner/src/native_fem.rs crates/fullmag-runner/src/native_fem/runtime_info.rs crates/fullmag-runner/src/fem/runtime_contract.rs crates/fullmag-runner/src/dispatch.rs crates/fullmag-runner/src/types.rs crates/fullmag-runner/src/artifacts.rs crates/fullmag-runner/src/native_fem/tests
git commit -m "fix(fem-gpu): verify executed residency receipts"
```

### Task 5: Capability status, dokumentacja i source-bound kwalifikacja

**Files:**
- Modify: `docs/architecture/backend-golden-masterplan.md`
- Modify: `docs/physics/0900-native-fem-operator-contracts-and-validation.md`
- Modify: `docs/specs/capability-matrix-v0.md`
- Modify: `docs/specs/capability-matrix-v0.json`
- Modify: `backends/fem/tests/interaction_docs_contract.cpp`
- Modify: `backends/fem/tests/llg_time_domain_qualification.cpp`
- Modify: `scripts/compare_fem_llg_time_domain_qualification.py`
- Modify: `justfile` tylko jeśli istniejąca recepta nie zapisuje nowego receipt.

**Interfaces:**
- Consumes: natywny i Rust receipt z Tasks 1–4.
- Produces: source-bound evidence dla strict/hybrid oraz jawny brak promocji, gdy managed GPU gate jest niedostępny.

- [ ] **Step 1: Napisać RED qualification assertions.**

`llg_time_domain_qualification.cpp` wymaga ABI v1, `device_resident`, complete executed-device masks, zero fallback i zero strict compute transfers. Comparator odrzuca brak receipt, mismatch source hash, hybrid oznaczony strict oraz brakujące operator IDs.

- [ ] **Step 2: Uruchomić autorytatywny build/runtime route.**

Run: `just ensure-managed-fem-runtime`

Run: `just verify-fem-time-domain-native-contract`

Run: `just verify-fem-llg-time-domain-qualification-gpu`

Run: `just verify-fem-gpu-performance-regression`

Expected: wszystkie dostępne gates PASS. Jeśli Docker/GPU/storage blokuje wykonanie, zapisać dokładny blocker i pozostawić status `implemented/unvalidated`; nie używać hostowego substytutu.

- [ ] **Step 3: Zaktualizować kontrakty dokumentacyjne.**

Dokumentacja opisuje dokładne operator bits, granicę plan/executed receipt, strict rejection i hybrid classification. Capability matrix nie zmienia `production_executable`/`validated` bez świeżego managed artifact.

- [ ] **Step 4: Uruchomić source/docs gates.**

Run: `just verify-fem-time-domain-native-contract`

Run: właściwy validator dokumentacji wskazany przez `scientific-documentation-contract`.

Run: `git diff --check`

Expected: PASS.

- [ ] **Step 5: Wykonać review tasku.**

Reviewer sprawdza szczególnie: append-only ABI, brak plan-as-execution, atomic attempt publication, brak silent hybrid, pełne masks, transfer counters i brak nieudokumentowanej promocji capability.

- [ ] **Step 6: Przygotować commit task-scoped.**

```text
git add docs/architecture/backend-golden-masterplan.md docs/physics/0900-native-fem-operator-contracts-and-validation.md docs/specs/capability-matrix-v0.md docs/specs/capability-matrix-v0.json backends/fem/tests/interaction_docs_contract.cpp backends/fem/tests/llg_time_domain_qualification.cpp scripts/compare_fem_llg_time_domain_qualification.py justfile
git commit -m "docs(fem-gpu): bind strict qualification to receipts"
```

### Task 6: P0 completion audit

**Files:**
- Modify: `docs/reviews/2026-08-20-public-interactions/gpt_pro/audit_1/MAPPING_TO_AUDIT.md`
- Create: `docs/reviews/2026-08-20-public-interactions/gpt_pro/audit_1/fem-gpu/P0-CLOSURE-EVIDENCE.md`

**Interfaces:**
- Consumes: task commits, test output i managed receipts z Tasks 1–5.
- Produces: requirement-by-requirement evidence dla `FEM-GPU-ARCH-001`, `FEM-GPU-PERF-001`, `FEM-GPU-PERF-009`.

- [ ] **Step 1: Zmapować każde kryterium findingów na dowód.**

Każdy wiersz ma status `CLOSED`, `PARTIALLY CONFIRMED` albo `NOT VERIFIED`, dokładny symbol/test/command/artifact i brakujące evidence. Source test nie może dowodzić hardware execution.

- [ ] **Step 2: Powtórzyć dostępne bramki z czystego HEAD.**

Run: `just verify-fem-time-domain-native-contract`

Run: `just verify-fem-llg-time-domain-qualification-gpu`

Run: `just verify-fem-gpu-performance-regression`

Run: `git diff --check`

Expected: dostępne gates PASS; niedostępne hardware gates są opisane jako `NOT VERIFIED`.

- [ ] **Step 3: Przeprowadzić finalny code review P0.**

Review musi zakończyć się 0 Critical i 0 Important przed integracją. Minor są naprawiane albo jawnie odraczane tylko poza kryteriami P0.

- [ ] **Step 4: Przygotować commit dowodów.**

```text
git add docs/reviews/2026-08-20-public-interactions/gpt_pro/audit_1/MAPPING_TO_AUDIT.md docs/reviews/2026-08-20-public-interactions/gpt_pro/audit_1/fem-gpu/P0-CLOSURE-EVIDENCE.md
git commit -m "docs(audit): record fem gpu p0 evidence"
```
