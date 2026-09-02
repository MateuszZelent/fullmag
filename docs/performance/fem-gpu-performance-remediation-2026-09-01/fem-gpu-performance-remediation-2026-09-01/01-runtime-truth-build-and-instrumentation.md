# 01. Prawda o wykonaniu, buildzie i telemetrii

**Ustalenia:** RT-01, BL-01 oraz wspólna warstwa pomiarowa dla wszystkich
pozostałych punktów.

## 1. Problem

Aktualny kod ma:

- `GpuRkPlan`, który opisuje planowane miejsce wykonania,
- `FULLMAG_FEM_GPU_EXECUTION_RECEIPT_ABI_V1`, który potwierdza wykonane
  operatory po zaakceptowanej próbie,
- `fullmag_fem_transfer_audit`, który liczy transfery i wybrane synchronizacje,
- fazowe eventy CUDA dla exchange, demag i RHS.

Istnieją ponadto `fullmag_fem_step_stats`, wersjonowana telemetria endpoint
cache oraz transactional execution receipt. RT-01 nie oznacza więc braku
fail-closed dowodu wykonania: `gpu_rk_plan_is_strict_device_resident` oraz
`validate_strict_fem_gpu_execution_receipt` już odrzucają host, hybrid,
unknown, brak wymaganej maski i bulk compute transfer. W tym worktree dodano
osobny, transakcyjny snapshot **rzeczywiście wykonanej pracy**; pozostała luka
dotyczy pełnego pokrycia bezpośrednich synchronizacji i publicznego provenance.

Snapshot odpowiada już na pytania:

- ile pełnych RHS wykonano,
- ile solve’ów Poissona wykonano,
- ile razy liczono normę RHS,
- ile razy liczono energię demag w etapie,
- ile exchange kernel launches wykonano,
- ile normalizacji odczytało hosta,
- ile host fences przypadło na zaakceptowany krok,
- czy endpoint cache został użyty,
- ile D2D bytes wykonano,
- ile czasu fazowego zapisano dla exchange, demag i RHS.

Faktyczny tryb operatora pozostaje w resolved planner/provenance, a nie w
wersji ABI v1 snapshotu. Nie należy dopisywać go do istniejącego layoutu bez
nowej wersji ABI.

Bez tych liczników można skrócić pojedynczy kernel i jednocześnie pogorszyć
time-to-solution przez większą liczbę RHS, odrzuceń albo iteracji.

## 2. Właściciel stanu

Nie dodawać pól bezpośrednio do `Context`.

Wprowadzono:

```text
backends/fem/gpu/cuda/runtime/performance_counters.hpp
backends/fem/gpu/cuda/runtime/performance_counters.cpp
```

oraz dodano `GpuPerformanceCounterState` do `GpuStateRuntimeState` w
`gpu/cuda/runtime/gpu_state_runtime.hpp`:

```cpp
struct GpuPerformanceCounterState {
    bool available = false;
    bool attempt_active = false;
    GpuPerformanceCounterDelta active{};
    GpuPerformanceCounterDelta physical_lifetime{};
    GpuPerformanceCounterDelta accepted_lifetime{};
    fullmag_fem_gpu_performance_snapshot_v1 completed{};
};

struct GpuStateRuntimeState {
    ...
    GpuPerformanceCounterState performance_counters{};
};
```

`performance_counters.*` jest jedynym właścicielem:

- resetu liczników kroku,
- commit/rollback liczników prób,
- eksportu C ABI i walidacji layoutu,
- mapowania metadanych snapshotu.

Poszczególne moduły wywołują wąskie funkcje właściciela stanu:

```cpp
gpu_performance_begin_attempt(state, step, execution_id, operator_id);
gpu_performance_note(state, delta);
gpu_performance_commit_attempt(state);
gpu_performance_reject_attempt(state);
gpu_performance_fail_attempt(state);
```

Nie mogą samodzielnie publikować ABI ani modyfikować liczników innych modułów.

## 3. Wersjonowany snapshot C ABI

### Pliki

- `native/include/fullmag_fem.h`
- `backends/fem/src/api.cpp`
- `backends/fem/gpu/cuda/runtime/performance_counters.hpp/.cpp`
- `crates/fullmag-fem-sys/src/lib.rs` lub kanoniczna procedura regeneracji bindów
- `crates/fullmag-runner/src/fem/execution_receipt.rs`
- test layoutu ABI w `backends/fem/tests/`

### Struktura obowiązująca w ABI v1

Nie rozszerzać istniejącego niewersjonowanego `fullmag_fem_transfer_audit`.
Wprowadzony snapshot append-only ma następujący layout (bez pola operatora,
które pozostaje w planner/provenance):

```cpp
#define FULLMAG_FEM_GPU_PERFORMANCE_SNAPSHOT_V1_ABI_VERSION 1u

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;
    uint32_t available;
    uint32_t execution_class;
    uint32_t precision;
    uint32_t integrator;
    int32_t device_ordinal;
    uint64_t completed_step;
    uint64_t completed_execution_id;
    uint64_t completed_operator_id;
    uint64_t completed_attempt_count;
    uint64_t rejected_attempt_count;
    uint64_t failed_attempt_count;

    uint64_t physical_rhs_evaluations;
    uint64_t physical_exchange_applies;
    uint64_t physical_exchange_launches;
    uint64_t physical_exchange_nnz_visited;
    uint64_t physical_demag_solves;
    uint64_t physical_demag_iterations;
    uint64_t physical_demag_rhs_norm_evaluations;
    uint64_t physical_demag_stage_energy_evaluations;
    uint64_t physical_normalization_launches;
    uint64_t physical_normalization_readbacks;
    uint64_t physical_adaptive_readbacks;
    uint64_t physical_control_fences;
    uint64_t physical_endpoint_cache_hits;
    uint64_t physical_endpoint_cache_misses;
    uint64_t physical_endpoint_cache_invalidations;
    uint64_t physical_device_to_device_bytes;
    uint64_t physical_control_d2h_bytes;
    uint64_t physical_bulk_d2h_bytes;
    double physical_demag_rhs_norm_sum;
    double physical_demag_stage_energy_sum_joules;

    uint64_t accepted_rhs_evaluations;
    uint64_t accepted_exchange_applies;
    uint64_t accepted_exchange_launches;
    uint64_t accepted_exchange_nnz_visited;
    uint64_t accepted_demag_solves;
    uint64_t accepted_demag_iterations;
    uint64_t accepted_demag_rhs_norm_evaluations;
    uint64_t accepted_demag_stage_energy_evaluations;
    uint64_t accepted_normalization_launches;
    uint64_t accepted_normalization_readbacks;
    uint64_t accepted_adaptive_readbacks;
    uint64_t accepted_control_fences;
    uint64_t accepted_endpoint_cache_hits;
    uint64_t accepted_endpoint_cache_misses;
    uint64_t accepted_endpoint_cache_invalidations;
    uint64_t accepted_device_to_device_bytes;
    uint64_t accepted_control_d2h_bytes;
    uint64_t accepted_bulk_d2h_bytes;
    double accepted_demag_rhs_norm_sum;
    double accepted_demag_stage_energy_sum_joules;

    uint64_t physical_exchange_elapsed_ns;
    uint64_t physical_demag_assemble_elapsed_ns;
    uint64_t physical_demag_recover_elapsed_ns;
    uint64_t physical_demag_energy_elapsed_ns;
    uint64_t physical_rhs_elapsed_ns;
    uint64_t accepted_exchange_elapsed_ns;
    uint64_t accepted_demag_assemble_elapsed_ns;
    uint64_t accepted_demag_recover_elapsed_ns;
    uint64_t accepted_demag_energy_elapsed_ns;
    uint64_t accepted_rhs_elapsed_ns;
} fullmag_fem_gpu_performance_snapshot_v1;
```

Nie deklarować ponownie `fullmag_fem_gpu_execution_class_v1`: ten enum już
jest częścią `FULLMAG_FEM_GPU_EXECUTION_RECEIPT_ABI_V1` w
`native/include/fullmag_fem.h` i obejmuje również klasy host-solver oraz CPU.
Snapshot używa istniejących wartości klasy wykonania. CPU zwraca jawne
`FULLMAG_FEM_ERR_UNAVAILABLE`; nie publikuje zerowego snapshotu udającego GPU.

Funkcja:

```cpp
int fullmag_fem_backend_gpu_performance_snapshot_v1(
    fullmag_fem_backend *backend,
    fullmag_fem_gpu_performance_snapshot_v1 *out_snapshot);
```

Walidacja:

- `out_snapshot != nullptr`,
- `abi_version` i `struct_size` sprawdzane zgodnie z obowiązującym wzorcem ABI,
- CPU backend zwraca jawne `ERR_UNAVAILABLE`, a nie zerowy snapshot udający GPU,
- snapshot dotyczy ostatniego ukończonego kroku, nigdy częściowej próby.

## 4. Transakcyjność liczników

Adaptive RK może odrzucać próby. Należy rozdzielić:

- **physical work counters** — liczą również odrzucone próby;
- **accepted result counters** — odnoszą się do zaakceptowanego kroku;
- **lifetime counters** — monotoniczne od utworzenia backendu.

Model wdrożony:

```cpp
struct FemGpuPerformanceAttemptDelta {
    uint64_t rhs_evaluations = 0;
    uint64_t demag_solves = 0;
    ...
};

begin_attempt(step):
    ensure pending_accepted_step belongs to step;
    current_attempt = {};

reject_attempt():
    physical_lifetime += current_attempt;
    pending_accepted_step += current_attempt;
    current_step.rejected_attempts++;
    current_attempt = {};

accept_attempt():
    physical_lifetime += current_attempt;
    pending_accepted_step += current_attempt;
    accepted_lifetime += pending_accepted_step;
    current_attempt = {};
    pending_accepted_step = {};

commit_step():
    last_completed_step = current_step;
```

Liczników pracy nie wolno cofać po reject. `pending_accepted_step` sprawia, że
po późniejszym accept licznik wyniku zaakceptowanego wskazuje koszt całego
kroku wraz z odrzuconymi próbami; po failure pending jest porzucany, ale praca
fizyczna pozostaje w lifetime.

## 5. Zachowanie istniejącego strict receipt i rozszerzenie artefaktu

Właściciel planowania nadal ustala required/resolved masks, a receipt
potwierdza wykonanie. Runner powinien po pierwszym zaakceptowanym kroku
opublikować:

```text
requested_device=gpu
requested_execution=strict
resolved_execution_class=device_resident
exchange_operator=csr_fused_xyz
mass_projection=lumped_device
demag_operator=device_hypre_poisson
hypre_memory=device
hypre_execution=device
preconditioner=amg_device
executed_host_mask=0x0
executed_unknown_mask=0x0
executed_device_mask=...
hot_loop_compute_h2d_bytes=0
hot_loop_compute_d2h_bytes=0
```

### Miejsca zmiany

- `backends/fem/gpu/cuda/integrators/rk/rk_plan.cpp` — wyłącznie resolved plan.
- `backends/fem/gpu/cuda/runtime/execution_receipt.cpp` — wykonane operatory.
- `backends/fem/gpu/cuda/runtime/performance_counters.cpp` — snapshot pracy.
- `crates/fullmag-runner/src/fem/execution_receipt.rs` — walidacja i artefakt.
- istniejący moduł provenance/manifest runnera — serializacja bez duplikowania
  logiki planera.

### Istniejący fail-closed invariant

Dla `requested_execution=strict` zakończyć przebieg błędem, gdy:

```text
execution_class != device_resident
executed_host_operator_mask != 0
executed_unknown_operator_mask != 0
executed_device_operator_mask != required_operator_mask
hot_loop_compute_h2d_bytes != 0
hot_loop_compute_d2h_bytes != 0
```

Warunki te są już egzekwowane przez plan/receipt/runner. Nowa praca ma je
zachować, dodać snapshot liczników i objąć audytem bezpośrednie readbacki oraz
synchronizacje, których obecny `fullmag_fem_transfer_audit` nie widzi. Control
scalar D2H pozostaje osobną dozwoloną kategorią, ale jego liczba i
synchronizacje muszą być jawne.

## 6. Walidacja architektury CUDA

CMake ustawia domyślną listę architektur CUDA, gdy CUDA jest dostępna, a
`crates/fullmag-fem-sys/build.rs` warunkowo przekazuje niepusty override
`FULLMAG_CUDA_ARCHITECTURES`. To nie dowodzi zawartości finalnego `.so`.
`scripts/inspect_cuda_architectures.py` i jego testy już obsługują
`--cuda-required` oraz `--require-native-cubin`. Ponadto
`scripts/export_fem_gpu_runtime.sh` już waliduje finalny bundle przez
`validate_managed_fem_runtime_bundle.py`, domyślnie wymaga compute capability
`8.9` oraz cubinów `fullmag_fem=sm_89` i `hypre=sm_89`. Brakującym elementem
jest uogólnione mapowanie wykrytego `major.minor` na `sm_xy` zamiast stałego
`sm_89` oraz immutable receipt łączący wynik gate'u z digestem dokładnego
bundle i benchmarkiem.

### Zmiany

- zachować istniejące testy `scripts/test_inspect_cuda_architectures.py`,
- zachować istniejącą walidację finalnego bundle w exporterze,
- wyprowadzać wymagany cubin z wykrytego compute capability; nie wymagać
  `sm_89` dla H100 ani innego nie-Ada GPU,
- zapisać w `manifest.json`:
  - lista cubin `sm_*`,
  - obecne PTX `compute_*`,
  - CUDA toolkit,
  - target GPU compute capability,
  - wynik `native cubin present`.

### Gate

Dla RTX 4080:

```text
target_compute_capability=8.9
required_native_cubin=sm_89
```

Dla H100:

```text
target_compute_capability=9.0
required_native_cubin=sm_90
```

PTX-only nie jest równoważne z natywnym cubinem w benchmarku kwalifikacyjnym.

Przykładowa diagnostyka wewnątrz managed container:

```bash
cuobjdump --list-elf libfullmag_fem.so
cuobjdump --dump-resource-usage libfullmag_fem.so
```

Nie wpisywać bezpośrednich hostowych ścieżek buildów do dokumentacji jako
autorytatywne. Skrypt ma dostać ścieżkę z manifestu managed runtime.

## 7. TDD

### RED 1 — layout i snapshot

Dodany kontrakt `backends/fem/tests/gpu_performance_snapshot_contract.cpp`
sprawdza:

- layout/version/size,
- null checks,
- CPU unavailable,
- snapshot nie publikuje aktywnej próby,
- reject zwiększa physical work,
- commit atomowo publikuje last completed step.

### REGRESSION 2 — strict execution

Zachować i w razie potrzeby rozszerzyć istniejące kontrakty
`gpu_strict_execution_contract.cpp`, `gpu_execution_receipt_contract.cpp` oraz
Rust `validate_strict_fem_gpu_execution_receipt`:

- explicit hybrid jest odrzucony,
- host mask jest odrzucona,
- unknown mask jest odrzucona,
- control scalar nie jest błędnie zaliczany do bulk D2H.

### REGRESSION 3 — final architecture

Istniejące testy inspektora i walidatora bundle pokrywają poniższe przypadki;
RED ma dotyczyć mapowania compute capability na wymagania wszystkich bibliotek
i związania wyniku z immutable benchmark receipt:

- fixture tylko `sm_52` musi failować dla `--require-native-cubin sm_89`,
- fixture `sm_89` przechodzi,
- brak danych nie daje fałszywego PASS.

### GREEN

Implementować dopiero po czerwonych testach. W profiler-off:

- nie tworzyć dodatkowych eventów,
- nie wykonywać zegarów hostowych,
- liczniki całkowite mogą być inkrementowane prostymi operacjami CPU;
  nie dodawać atomików device tylko dla telemetrii.

## 8. Benchmark baseline

Dodać managed cel, np. `verify-fem-gpu-performance-baseline`, który używa
`ensure-managed-fem-runtime`, kanonicznego SP4 i walidatora JSON.

Każdy rekord JSON:

```json
{
  "commit": "4c7897f218eb0c32612db1f43a844502a316b4f6",
  "gpu": {"name": "...", "compute_capability": "...", "driver": "..."},
  "mesh": {"digest": "...", "nodes": "MEASURED", "cells": "MEASURED", "facets": "MEASURED"},
  "solver": {"integrator": "rk23", "rtol": 1e-12},
  "performance": {"snapshot": "fullmag_fem_gpu_performance_snapshot_v1"},
  "wall": {
    "warmup_steps": 8,
    "measured_steps": 64,
    "median_step_ms": "MEASURED",
    "p95_step_ms": "MEASURED"
  }
}
```

Powyższy JSON jest schematem, nie wynikiem. Liczby siatki i czasy muszą pochodzić
z receipt dokładnego przebiegu; placeholder nie może zostać zaakceptowany jako
baseline. Nie porównywać przebiegów z różnymi mesh digestami.

Repo ma już `verify-fem-gpu-performance-regression` i
`capture-fem-gpu-pre-remediation-performance-baseline`, lecz ich fixture to
`box500` z Heun/NCG. Nie są dowodem dla SP4 mixed-P1 RK23. Nowy cel ma użyć
`fem-sp4-run` lub `fem-managed-headless`; `fem-gpu-headless` pozostaje
diagnostyczny.

## 9. Definition of Done

- nowy snapshot ma stabilne v1 ABI;
- każdy licznik ma jednego właściciela i test;
- strict receipt rozróżnia bulk i control transfers;
- profiler-off nie tworzy eventów ani alokacji;
- final runtime manifest potwierdza cubin;
- baseline SP4 został zapisany przed pierwszą optymalizacją;
- managed build i testy przechodzą.
