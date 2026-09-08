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

Brakuje jednak jednego wersjonowanego snapshotu odpowiadającego na pytania:

- ile pełnych RHS wykonano,
- ile solve’ów Poissona wykonano,
- ile razy liczono normę RHS,
- ile razy liczono energię demag w etapie,
- ile exchange kernel launches wykonano,
- ile normalizacji odczytało hosta,
- ile host fences przypadło na zaakceptowany krok,
- czy endpoint cache został użyty,
- ile D2D bytes wykonano,
- jaki był faktyczny tryb operatora.

Bez tych liczników można skrócić pojedynczy kernel i jednocześnie pogorszyć
time-to-solution przez większą liczbę RHS, odrzuceń albo iteracji.

## 2. Właściciel stanu

Nie dodawać pól bezpośrednio do `Context`.

Utworzyć:

```text
backends/fem/gpu/cuda/runtime/performance_counters.hpp
backends/fem/gpu/cuda/runtime/performance_counters.cpp
```

i dodać do `GpuStateRuntimeState` w
`gpu/cuda/runtime/gpu_state_runtime.hpp`:

```cpp
struct FemGpuPerformanceRuntimeState {
    FemGpuPerformanceCounters lifetime{};
    FemGpuPerformanceCounters current_step{};
    FemGpuPerformanceCounters last_completed_step{};
    uint64_t schema_revision = 1;
};

struct GpuStateRuntimeState {
    ...
    FemGpuPerformanceRuntimeState performance{};
};
```

`performance_counters.*` jest jedynym właścicielem:

- resetu liczników kroku,
- commit/rollback liczników prób,
- eksportu C ABI,
- nazw enumeracji trybów wykonania.

Poszczególne moduły mogą wywoływać wąskie funkcje:

```cpp
gpu_perf_note_rhs_evaluation(ctx);
gpu_perf_note_exchange_apply(ctx, kernel_launches, nnz_visited);
gpu_perf_note_demag_solve(ctx, iterations);
gpu_perf_note_control_fence(ctx, bytes);
gpu_perf_note_endpoint_cache_hit(ctx);
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

### Struktura

Nie rozszerzać istniejącego niewersjonowanego `fullmag_fem_transfer_audit`.
Dodać nowy append-only snapshot:

```cpp
#define FULLMAG_FEM_GPU_PERFORMANCE_SNAPSHOT_ABI_VERSION 1u

typedef enum {
    FULLMAG_FEM_GPU_EXECUTION_CLASS_UNKNOWN = 0,
    FULLMAG_FEM_GPU_EXECUTION_CLASS_DEVICE_RESIDENT = 1,
    FULLMAG_FEM_GPU_EXECUTION_CLASS_HYBRID_CPU_POISSON = 2,
} fullmag_fem_gpu_execution_class_v1;

typedef enum {
    FULLMAG_FEM_GPU_EXCHANGE_OPERATOR_UNKNOWN = 0,
    FULLMAG_FEM_GPU_EXCHANGE_OPERATOR_CSR_COMPONENT_SPLIT = 1,
    FULLMAG_FEM_GPU_EXCHANGE_OPERATOR_CSR_FUSED_XYZ = 2,
    FULLMAG_FEM_GPU_EXCHANGE_OPERATOR_PERIODIC_REDUCED_CSR = 3,
    FULLMAG_FEM_GPU_EXCHANGE_OPERATOR_CUSPARSE_SPMM = 4,
    FULLMAG_FEM_GPU_EXCHANGE_OPERATOR_PARTIAL_ASSEMBLY = 5,
} fullmag_fem_gpu_exchange_operator_v1;

typedef struct {
    uint32_t abi_version;
    uint32_t struct_size;

    uint64_t completed_step;
    uint32_t execution_class;
    uint32_t exchange_operator;

    uint64_t rhs_evaluations;
    uint64_t exchange_applies;
    uint64_t exchange_kernel_launches;
    uint64_t exchange_nnz_visited;

    uint64_t demag_solves;
    uint64_t demag_iterations;
    uint64_t demag_rhs_norm_evaluations;
    uint64_t demag_stage_energy_evaluations;

    uint64_t normalization_launches;
    uint64_t normalization_control_readbacks;
    uint64_t adaptive_control_readbacks;
    uint64_t control_host_fences;

    uint64_t endpoint_cache_hits;
    uint64_t endpoint_cache_misses;
    uint64_t endpoint_cache_invalidations;

    uint64_t device_to_device_bytes;
    uint64_t control_device_to_host_bytes;
    uint64_t bulk_device_to_host_bytes;

    uint64_t exchange_device_time_ns;
    uint64_t demag_assemble_device_time_ns;
    uint64_t demag_hypre_device_time_ns;
    uint64_t demag_hypre_host_api_time_ns;
    uint64_t demag_recovery_device_time_ns;
    uint64_t demag_energy_device_time_ns;
    uint64_t heff_device_time_ns;
    uint64_t llg_device_time_ns;
    uint64_t adaptive_device_time_ns;
    uint64_t reductions_device_time_ns;
} fullmag_fem_gpu_performance_snapshot_v1;
```

Funkcja:

```cpp
int fullmag_fem_backend_gpu_performance_snapshot_v1(
    const fullmag_fem_backend *backend,
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

Proponowany model:

```cpp
struct FemGpuPerformanceAttemptDelta {
    uint64_t rhs_evaluations = 0;
    uint64_t demag_solves = 0;
    ...
};

begin_attempt():
    current_attempt = {};

reject_attempt():
    current_step.physical += current_attempt;
    current_step.rejected_attempts++;
    current_attempt = {};

accept_attempt():
    current_step.physical += current_attempt;
    current_step.accepted_attempt = current_attempt;
    current_attempt = {};

commit_step():
    last_completed_step = current_step;
    lifetime += current_step.physical;
```

Liczników pracy nie wolno cofać po reject; licznik wyniku zaakceptowanego musi
wskazywać koszt całego kroku wraz z odrzuconymi próbami.

## 5. Jednoznaczne logowanie resolved execution

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

### Fail-closed

Dla `requested_execution=strict` zakończyć przebieg błędem, gdy:

```text
execution_class != device_resident
executed_host_operator_mask != 0
executed_unknown_operator_mask != 0
executed_device_operator_mask != required_operator_mask
hot_loop_compute_h2d_bytes != 0
hot_loop_compute_d2h_bytes != 0
```

Control scalar D2H może być dozwolony jako osobna kategoria, ale jego liczba
i synchronizacje muszą być jawne.

## 6. Walidacja architektury CUDA

Źródło obecnie wymusza niepuste `CMAKE_CUDA_ARCHITECTURES`, a
`crates/fullmag-fem-sys/build.rs` przekazuje `FULLMAG_CUDA_ARCHITECTURES`.
To nie dowodzi zawartości finalnego `.so`.

### Zmiany

- rozszerzyć istniejący `scripts/test_inspect_cuda_architectures.py`,
- użyć lub rozbudować skrypt inspekcji finalnego runtime bundle,
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

Dodać `backends/fem/tests/gpu_performance_snapshot_contract.cpp`:

- layout/version/size,
- null checks,
- CPU unavailable,
- snapshot nie publikuje aktywnej próby,
- reject zwiększa physical work,
- commit atomowo publikuje last completed step.

### RED 2 — strict execution

Rozszerzyć `gpu_strict_execution_contract.cpp`:

- explicit hybrid jest odrzucony,
- host mask jest odrzucona,
- unknown mask jest odrzucona,
- control scalar nie jest błędnie zaliczany do bulk D2H.

### RED 3 — final architecture

Rozszerzyć test skryptu:

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
  "mesh": {"nodes": 142953, "cells": 810601, "facets": 77674},
  "solver": {"integrator": "rk23", "rtol": 1e-12},
  "performance": {"snapshot": "fullmag_fem_gpu_performance_snapshot_v1"},
  "wall": {
    "warmup_steps": 8,
    "measured_steps": 64,
    "median_step_ms": 0.0,
    "p95_step_ms": 0.0
  }
}
```

Nie porównywać przebiegów z różnymi mesh digestami.

## 9. Definition of Done

- nowy snapshot ma stabilne v1 ABI;
- każdy licznik ma jednego właściciela i test;
- strict receipt rozróżnia bulk i control transfers;
- profiler-off nie tworzy eventów ani alokacji;
- final runtime manifest potwierdza cubin;
- baseline SP4 został zapisany przed pierwszą optymalizacją;
- managed build i testy przechodzą.
